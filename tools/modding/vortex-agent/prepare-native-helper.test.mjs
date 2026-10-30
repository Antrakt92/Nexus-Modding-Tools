import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { prepareHelper, verifyHelper } from './prepare-native-helper.mjs';
const require = createRequire(import.meta.url);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-kit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), output = path.join(root, 'prepared'); fs.mkdirSync(source);
  // Synthetic representation of the supported task-template integration points.
  const index = `const sequence=0;
need(c.packages?.length===1&&c.packages[0].key==='own-fixture'&&c.packages[0].sha256==='${'b'.repeat(64)}'&&c.packages[0].bytes===100,'EXACT_ONE_DISABLED_FIXTURE');
 function physical(p){const prior=cache.get(p);return prior;}
function verify(){return {now:Date.now,pkg,expectedSize:size,pollMs:1000};}
function read(){return{record:s.persistent.mods[c.health.gameId][pkg.expectedModId],flags:{}};}
need(hash(c.appAsar)===c.appAsarSHA256&&c.appAsarSHA256==='${'a'.repeat(64)}','APP_ASAR_CHANGED');
for(const[p,h]of Object.entries(c.sourcePins))need(hash(p)===h,'SOURCE_CHANGED');
record('guard-timing-terminal',{guardTiming,serialPoller:pollMetrics});`;
  fs.writeFileSync(path.join(source, 'index.prepared.js'), index);
  const config = { activationApproved: false, activationHold: true, freshActualBaselineBound: false,
    noEffects: true, health: { gameId: 'cyberpunk2077' },
    packages: [{ key: 'own-fixture', sha256: 'b'.repeat(64), bytes: 100,
      expectedEnabled: false, oldEnabledModIds: [] }], modulePins: {} };
  for (const name of ['engine.cjs', 'settlement.cjs', 'local-import-readiness.cjs']) {
    const code = name === 'engine.cjs'
      ? `function check(o){need(o.packages.length===1&&o.packages[0].key==='own-fixture'&&o.packages[0].sha256==='${'b'.repeat(64)}','EXACT_ONE_FIXTURE');}module.exports={check};`
      : 'module.exports={};';
    fs.writeFileSync(path.join(source, name), code); config.modulePins[name] = sha(code);
  }
  const writeConfig = () => fs.writeFileSync(path.join(source, 'reviewed.prepared.json'), JSON.stringify(config));
  writeConfig();
  return { root, source, output, config, writeConfig, sourceSha256: sha(index) };
}
test('dry run writes nothing; apply creates an inert pinned module set and verifies it', t => {
  const f = fixture(t); assert.equal(prepareHelper(f).status, 'plan'); assert(!fs.existsSync(f.output));
  const plan = prepareHelper({ ...f, apply: true }); assert.equal(plan.activationGranted, false);
  assert.equal(verifyHelper(f.output).status, 'code-contract-verified');
  assert(!fs.existsSync(path.join(f.output, 'reviewed.json')));
  const config = JSON.parse(fs.readFileSync(path.join(f.output, 'reviewed.prepared.json')));
  assert.equal(config.health, null); assert.equal(config.pluginPath, null); assert.equal(config.activationHold, true);
  assert(config.modulePins['install-settlement.cjs']); assert(config.modulePins['physical-proof.cjs']);
});

test('stale engine package pins fail during preparation before any output is created', t => {
  for (const [before, after] of [["key==='own-fixture'", "key==='own-previous'"], ['b'.repeat(64), 'c'.repeat(64)]]) {
    const f = fixture(t);
    const engine = path.join(f.source, 'engine.cjs');
    const code = fs.readFileSync(engine, 'utf8').replace(before, after);
    fs.writeFileSync(engine, code); f.config.modulePins['engine.cjs'] = sha(code); f.writeConfig();
    assert.throws(() => prepareHelper({ ...f, apply: true }), /HELPER_PACKAGE_SCOPE_DIFFERS/);
    assert(!fs.existsSync(f.output));
  }
});

test('entrypoint package identity and the reviewed package must agree before preparation', t => {
  for (const field of ['key', 'sha256', 'bytes']) {
    const f = fixture(t);
    f.config.packages[0][field] = { key: 'own-next', sha256: 'c'.repeat(64), bytes: 101 }[field];
    f.writeConfig();
    assert.throws(() => prepareHelper({ ...f, apply: true }), /HELPER_PACKAGE_SCOPE_DIFFERS/);
    assert(!fs.existsSync(f.output));
  }
});

test('scope admission refuses array-like packages and escaped key literals', t => {
  const malformed = fixture(t);
  malformed.config.packages = { 0: malformed.config.packages[0], length: 1 };
  malformed.writeConfig();
  assert.throws(() => prepareHelper(malformed), /HELPER_PACKAGE_SCOPE_DIFFERS/);
  const escaped = fixture(t);
  for (const name of ['index.prepared.js', 'engine.cjs']) {
    const file = path.join(escaped.source, name);
    const code = fs.readFileSync(file, 'utf8').replaceAll('own-fixture', 'own-\\x66ixture');
    fs.writeFileSync(file, code);
    if (name === 'engine.cjs') escaped.config.modulePins[name] = sha(code);
    else escaped.sourceSha256 = sha(code);
  }
  escaped.config.packages[0].key = 'own-\\x66ixture'; escaped.writeConfig();
  assert.throws(() => prepareHelper(escaped), /UNSUPPORTED_HELPER_SCOPE_TEMPLATE/);
});

test('binding cannot silently retarget a prepared kit to a different package', t => {
  const f = fixture(t); prepareHelper({ ...f, apply: true });
  const file = path.join(f.output, 'reviewed.prepared.json');
  const config = JSON.parse(fs.readFileSync(file));
  config.packages[0].sha256 = 'c'.repeat(64); fs.writeFileSync(file, JSON.stringify(config));
  assert.throws(() => verifyHelper(f.output), /HELPER_PACKAGE_SCOPE_DIFFERS/);
});
test('prepared compatibility module executes the current observer, not the old quiet key', async t => {
  const f = fixture(t); prepareHelper({ ...f, apply: true });
  const { wait } = require(path.join(f.output, 'settlement.cjs')); let clock = 0, reads = 0;
  const result = await wait({ pkg: { expectedModId: 'own', expectedEnabled: false, oldEnabledModIds: [] },
    expectedDownloadId: 'download', expectedType: '', expectedSize: 9, record: () => {}, guard: () => {},
    read: () => ({ record: { id: 'own', archiveId: 'download', installationPath: 'own', type: '', state: 'installed',
      attributes: { modSize: 9, metadata: ++reads } }, flags: {} }), now: () => clock,
    sleep: async ms => { clock += ms; } });
  assert.equal(result.ready, true); assert.equal(clock, 3000);
});

test('prepared source guards reuse one generation hash and reject same-size source mutation', t => {
  const f = fixture(t); prepareHelper({ ...f, apply: true });
  const source = path.join(f.root, 'pinned-source'); fs.writeFileSync(source, 'original');
  const pin = sha(fs.readFileSync(source)); let hashes = 0;
  const hash = p => { hashes++; return sha(fs.readFileSync(p)); };
  const physical = require(path.join(f.output, 'physical-proof.cjs')).createPhysicalReader({ fs, hash });
  const code = fs.readFileSync(path.join(f.output, 'index.prepared.js'), 'utf8')
    .match(/for\(const\[p,h\]of Object\.entries\(c\.sourcePins\)\)[^;]+;/)[0];
  const context = { c: { sourcePins: { [source]: pin } }, hash, physical,
    need: (v, error) => { if (!v) throw Error(error); } };
  const before = fs.readFileSync(path.join(f.source, 'index.prepared.js'), 'utf8')
    .match(/for\(const\[p,h\]of Object\.entries\(c\.sourcePins\)\)[^;]+;/)[0];
  for (let n = 0; n < 10; n++) vm.runInNewContext(before, context);
  assert.equal(hashes, 10); hashes = 0;
  for (let n = 0; n < 10; n++) vm.runInNewContext(code, context);
  assert.equal(hashes, 1); assert.equal(physical.metrics().cacheHits, 9);
  fs.writeFileSync(source, 'modified'); fs.utimesSync(source, new Date(), new Date(Date.now() + 5000));
  assert.throws(() => vm.runInNewContext(code, context), /SOURCE_CHANGED/);
});
test('source/module drift or an unsupported template fail before creating output', t => {
  for (const mode of ['entry', 'module', 'shape']) {
    const f = fixture(t);
    if (mode === 'module') fs.appendFileSync(path.join(f.source, 'engine.cjs'), '// changed');
    else {
      fs.appendFileSync(path.join(f.source, 'index.prepared.js'), mode === 'shape' ? '\n function physical(p){const prior=cache.get(p);}' : '// changed');
      if (mode === 'shape') f.sourceSha256 = sha(fs.readFileSync(path.join(f.source, 'index.prepared.js')));
    }
    assert.throws(() => prepareHelper({ ...f, apply: true }), /PIN_MISMATCH|UNSUPPORTED_HELPER_TEMPLATE/);
    assert(!fs.existsSync(f.output));
  }
});
test('materialized/attempted helpers, active plugin paths and existing outputs are refused', t => {
  const f = fixture(t);
  for (const name of ['reviewed.json', 'attempt.json', 'failed.json', 'completed.json']) {
    fs.writeFileSync(path.join(f.source, name), '{}');
    assert.throws(() => prepareHelper(f), /MATERIALIZED_OR_ATTEMPTED/); fs.unlinkSync(path.join(f.source, name));
  }
  assert.throws(() => prepareHelper({ ...f, output: path.join(f.root, 'Vortex/plugins/helper') }), /ACTIVE_HELPER_PATH/);
  fs.mkdirSync(f.output); assert.throws(() => prepareHelper(f), /HELPER_OUTPUT_EXISTS/);
});
test('non-held and non-disabled packages and traversing module names fail closed', t => {
  for (const mode of ['approved', 'enabled', 'old', 'path', 'game']) {
    const f = fixture(t);
    if (mode === 'approved') f.config.activationApproved = true;
    if (mode === 'enabled') f.config.packages[0].expectedEnabled = true;
    if (mode === 'old') f.config.packages[0].oldEnabledModIds = ['old'];
    if (mode === 'path') f.config.modulePins['../outside.cjs'] = 'a'.repeat(64);
    if (mode === 'game') f.config.health.gameId = 'other';
    f.writeConfig(); assert.throws(() => prepareHelper(f), /TEMPLATE_REQUIRED|INVALID_HELPER_MODULE_PINS/);
  }
});
test('verification detects runtime drift and stale or incomplete binding pins', t => {
  for (const mode of ['runtime', 'manifest', 'binding']) {
    const f = fixture(t); prepareHelper({ ...f, apply: true });
    if (mode === 'runtime') fs.appendFileSync(path.join(f.output, 'settlement.cjs'), '// changed');
    if (mode === 'manifest') {
      const file = path.join(f.output, 'HELPER-KIT.json'), m = JSON.parse(fs.readFileSync(file));
      m.files['install-settlement.cjs'] = 'b'.repeat(64); fs.writeFileSync(file, JSON.stringify(m));
    }
    if (mode === 'binding') fs.writeFileSync(path.join(f.output, 'reviewed.json'), '{}');
    assert.throws(() => verifyHelper(f.output), /HELPER_KIT_DRIFT|STALE_HELPER_KIT|HELPER_BINDING_MODULE_PINS/);
  }
});
test('output ancestry junctions/symlinks are refused without writes', t => {
  const f = fixture(t), target = path.join(f.root, 'target'), alias = path.join(f.root, 'alias');
  fs.mkdirSync(target); fs.symlinkSync(target, alias, 'junction');
  assert.throws(() => prepareHelper({ ...f, output: path.join(alias, 'new') }), /HELPER_REPARSE_PATH/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('preparation cannot write inside source or its known managed roots', t => {
  const f = fixture(t);
  assert.throws(() => prepareHelper({ ...f, output: path.join(f.source, '..nested') }), /HELPER_OUTPUT_INSIDE_SOURCE/);
  for (const key of ['gamePath', 'stagingPath', 'downloadPath']) {
    const root = path.join(f.root, key); fs.mkdirSync(root); f.config.health[key] = root; f.writeConfig();
    assert.throws(() => prepareHelper({ ...f, output: path.join(root, 'helper') }), /MANAGED_OUTPUT_PATH_REFUSED/);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test('verification requires the entrypoint and held config even if manifest entries are omitted', t => {
  for (const mode of ['entry', 'config']) {
    const f = fixture(t); prepareHelper({ ...f, apply: true });
    if (mode === 'entry') {
      const file = path.join(f.output, 'HELPER-KIT.json'), m = JSON.parse(fs.readFileSync(file));
      delete m.files['index.prepared.js']; fs.writeFileSync(file, JSON.stringify(m));
      assert.throws(() => verifyHelper(f.output), /INVALID_HELPER_KIT/);
    } else {
      fs.unlinkSync(path.join(f.output, 'reviewed.prepared.json'));
      assert.throws(() => verifyHelper(f.output), /ENOENT/);
    }
  }
});

test('final materialization gate refuses old fixed copy lists and checks every dependency pin', t => {
  const f = fixture(t); prepareHelper({ ...f, apply: true });
  fs.writeFileSync(path.join(f.output, 'info.prepared.json'), '{}');
  const config = JSON.parse(fs.readFileSync(path.join(f.output, 'reviewed.prepared.json')));
  const entries = [['index.prepared.js', 'index.js'], ['info.prepared.json', 'info.json'],
    ['reviewed.json', 'reviewed.json'], ...Object.keys(config.modulePins).map(n => [n, n])];
  const ready = { runtimeModules: Object.keys(config.modulePins).length, filesToCopy: entries.map(([source, destination]) => ({
    source, destination, sha256: source === 'reviewed.json' ? null : sha(fs.readFileSync(path.join(f.output, source))),
  })) };
  const write = r => fs.writeFileSync(path.join(f.output, 'READY.prepared.json'), JSON.stringify(r));
  write(ready);
  assert.equal(verifyHelper(f.output, { materialization: true }).materializationMappingVerified, true);
  write({ ...ready, filesToCopy: ready.filesToCopy.filter(r => r.source !== 'install-settlement.cjs') });
  assert.throws(() => verifyHelper(f.output, { materialization: true }), /HELPER_COPY_MAP_INCOMPLETE/);
  assert.equal(verifyHelper(f.output).materializationMappingVerified, false);
  write({ ...ready, filesToCopy: ready.filesToCopy.map(r => r.source === 'install-settlement.cjs' ? { ...r, sha256: 'a'.repeat(64) } : r) });
  assert.throws(() => verifyHelper(f.output, { materialization: true }), /HELPER_COPY_MAP_PIN_DIFFERS/);
  write({ ...ready, filesToCopy: ready.filesToCopy.map((r, i) => i === 1 ? ready.filesToCopy[0] : r) });
  assert.throws(() => verifyHelper(f.output, { materialization: true }), /HELPER_COPY_MAP_DIFFERS/);
});
