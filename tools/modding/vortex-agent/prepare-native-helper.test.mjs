import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { prepareHelper, verifyHelper, createHelperContents, main } from './prepare-native-helper.mjs';
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
 function tree(root){const out={};function visit(rel){for(const e of fs.readdirSync(path.join(root,rel),{withFileTypes:true})){const r=path.join(rel,e.name),p=safe(root,r);if(e.isDirectory())visit(r);else{need(e.isFile(),'SPECIAL_STAGE_FILE');if(e.name!=='__folder_managed_by_vortex')out[r.replace(/\\\\/g,'/')]=physical(p);}}}visit('');return out;}
function verifyPayload(){cache.clear();const again=tree(root);need(canonical(again)===canonical(files),'OWN_PAYLOAD_CHANGED_DURING_SETTLE');record(pkg.key+'-payload-proof',{ownerId:pkg.expectedModId,downloadId:id,files:again,disabled:true});}
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

test('generated final payload proof fully rehashes payload without evicting unrelated guard generations', t => {
  const f = fixture(t); prepareHelper({ ...f, apply: true });
  const oldCode = fs.readFileSync(path.join(f.source, 'index.prepared.js'), 'utf8');
  const code = fs.readFileSync(path.join(f.output, 'index.prepared.js'), 'utf8');
  const treeBody = body => body.match(/ function tree\([^\r\n]+/)?.[0];
  assert.equal(treeBody(code).replace('tree(root,reader=physical)', 'tree(root)')
    .replace(']=reader(p);', ']=physical(p);'), treeBody(oldCode), 'tree path and file checks are preserved');
  const payloadRoot = path.join(f.root, 'payload'); fs.mkdirSync(payloadRoot);
  for (const name of ['first', 'second']) fs.writeFileSync(path.join(payloadRoot, name), 'payload');
  const protectedFiles = Array.from({ length: 128 }, (_, n) => {
    const file = path.join(f.root, `protected-${n}`); fs.writeFileSync(file, Buffer.alloc(4096, n)); return file;
  });
  const { createPhysicalReader } = require(path.join(f.output, 'physical-proof.cjs'));
  const run = (body, mutate) => {
    const cache = new Map(), hashes = [];
    const hash = p => { hashes.push(p); return sha(fs.readFileSync(p)); };
    const physical = createPhysicalReader({ fs, hash, cache }), records = [];
    const context = { fs, path, physical, cache, hash, root: payloadRoot,
      require: id => { assert.equal(id, './physical-proof.cjs'); return { createPhysicalReader }; },
      safe: (root, relative) => path.join(root, relative),
      need: (ok, message) => { if (!ok) throw Error(message); },
      canonical: value => JSON.stringify(value), pkg: { key: 'own', expectedModId: 'own-target' }, id: 'download',
      record: (name, value) => records.push({ name, value }),
    };
    const sandbox = vm.createContext(context);
    vm.runInContext(treeBody(body), sandbox);
    const pins = protectedFiles.map(p => physical(p));
    context.files = vm.runInContext('tree(root)', sandbox);
    if (mutate) mutate();
    const final = body.match(/function verifyPayload\(\)\{([^\r\n]+)\}/)?.[1]; assert(final);
    vm.runInContext(final, sandbox);
    const afterPayload = hashes.length;
    protectedFiles.forEach((p, n) => assert.equal(physical(p).sha256, pins[n].sha256));
    return { hashes: hashes.length, afterPayload, physical, records, protectedPins: pins };
  };
  const before = run(oldCode), after = run(code);
  assert.equal(before.hashes, 260); // 128 protected + 2 payload, then payload + all protected again.
  assert.equal(after.hashes, 132); // Original guard hashes plus independent two-file payload proof.
  assert.equal(after.afterPayload, after.hashes, 'later full guards still sample but do not rehash unchanged protected data');
  assert.equal(after.records[0].value.freshPayloadProof.hashes, 2);
  assert.equal(after.records[0].value.freshPayloadProof.bytesHashed, 14);
  assert.equal(after.physical.metrics().reads + after.records[0].value.freshPayloadProof.reads,
    before.physical.metrics().reads, 'the same guarded and payload paths still receive physical observations');
  fs.writeFileSync(protectedFiles[0], Buffer.alloc(4096, 255));
  fs.utimesSync(protectedFiles[0], new Date(), new Date(Date.now() + 5000));
  assert.notEqual(after.physical(protectedFiles[0]).sha256, after.protectedPins[0].sha256,
    'a changed protected generation is independently rehashed');
  const sourceGuard = code.match(/for\(const\[p,h\]of Object\.entries\(c\.sourcePins\)\)[^;]+;/)[0];
  assert.throws(() => vm.runInNewContext(sourceGuard, {
    c: { sourcePins: { [protectedFiles[0]]: after.protectedPins[0].sha256 } }, physical: after.physical,
    need: (ok, message) => { if (!ok) throw Error(message); },
  }), /SOURCE_CHANGED/, 'the next full guard rejects a changed protected/source generation');
  assert.throws(() => run(code, () => {
    fs.writeFileSync(path.join(payloadRoot, 'first'), 'changed');
    fs.utimesSync(path.join(payloadRoot, 'first'), new Date(), new Date(Date.now() + 5000));
  }), /OWN_PAYLOAD_CHANGED_DURING_SETTLE/);
});

test('unsupported tree or final payload checkpoint shapes fail before preparation writes', t => {
  for (const [from, to] of [['function tree(root)', 'function otherTree(root)'],
    ['cache.clear();const again=tree(root);', 'const again=tree(root);']]) {
    const f = fixture(t), file = path.join(f.source, 'index.prepared.js');
    const code = fs.readFileSync(file, 'utf8').replace(from, to);
    fs.writeFileSync(file, code); f.sourceSha256 = sha(code);
    assert.throws(() => prepareHelper({ ...f, apply: true }), /UNSUPPORTED_HELPER_TEMPLATE/);
    assert(!fs.existsSync(f.output));
  }
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

function familyContents(t, mode = 'worker', change = () => {}) {
  const source = process.env.VORTEX_OWN_HELPER_REFERENCE;
  const input = fs.readFileSync(path.join(source, 'index.prepared.js'));
  const config = JSON.parse(fs.readFileSync(path.join(source, 'reviewed.prepared.json')));
  const modules = new Map(Object.keys(config.modulePins).map(name => [name, fs.readFileSync(path.join(source, name))]));
  const args = { input, config, modules, output: path.join(os.tmpdir(), 'held-source-worker'), sourceSha256: sha(input), sourceProofMode: mode };
  change(args); return createHelperContents(args);
}
const familyOnly = {timeout:15000, skip: !process.env.VORTEX_OWN_HELPER_REFERENCE};
test('worker mode is explicit; unsupported templates and modes never create output', t => {
  const f = fixture(t);
  assert.throws(() => prepareHelper({...f, sourceProofMode:'worker', apply:true}), /UNSUPPORTED_SOURCE_GUARD_TEMPLATE/);
  assert.throws(() => prepareHelper({...f, sourceProofMode:'fallback', apply:true}), /INVALID_SOURCE_PROOF_MODE/);
  assert.throws(() => main(['--source-proof-mode','worker','--source-proof-mode','worker']), /INVALID_HELPER_PREPARATION_ARGUMENTS/);
  assert(!fs.existsSync(f.output));
});
test('explicit cached-sync and default generate identical complete legacy packets', familyOnly, t => {
  const implicit = familyContents(t, 'cached-sync', args=>{delete args.sourceProofMode;}), explicit = familyContents(t, 'cached-sync');
  assert.deepEqual([...implicit.keys()].sort(),[...explicit.keys()].sort());
  for(const [name,bytes] of implicit){const other=explicit.get(name);assert(bytes.equals(other),`${name}: ${bytes.length}/${sha(bytes)} differs from ${other.length}/${sha(other)}`);}
  const cfg=JSON.parse(explicit.get('reviewed.prepared.json'));
  assert(!Object.hasOwn(cfg,'sourceProofMode')); assert(!Object.hasOwn(cfg,'sourceProof'));
});
test('actual Family worker packet is held and all fixed trusted CJS dependencies are pinned', familyOnly, t => {
  const packet=familyContents(t), config=JSON.parse(packet.get('reviewed.prepared.json'));
  assert.equal(config.sourceProofMode,'worker'); assert.equal(config.sourceProof,null);
  assert.equal(config.activationApproved,false); assert.equal(config.activationHold,true);
  const kit=JSON.parse(packet.get('HELPER-KIT.json')); assert.equal(kit.sourceProofMode,'worker');
  for(const name of ['helper-source-proof.cjs','helper-source-scope.cjs','guard-poller.cjs','file-proof-client.cjs','file-proof-worker.cjs','file-proof-backend.cjs','file-proof-child-client.cjs','file-proof-child.cjs','physical-proof.cjs']) {
    assert.equal(config.modulePins[name],sha(packet.get(name)));assert.equal(kit.files[name],config.modulePins[name]);
  }
  new vm.Script(packet.get('index.prepared.js').toString());
  // New proof closure remains lazy until the one-shot admission boundary.
  const text=packet.get('index.prepared.js').toString();
  assert(text.indexOf('if([\'attempt\'')<text.indexOf('try{startSourceProof();'));
  assert(text.indexOf("need(hash(c.processGuard.path)===c.processGuard.sha256,'PROCESS_GUARD_CHANGED');",text.indexOf('function startSourceProof'))<text.indexOf("require('./helper-source-scope.cjs')"));

});
test('worker admission rejects whole-template drift beyond existing binder data substitutions', familyOnly, t => {
  for(const [old,next] of [["record('completed'","record('fake-completed'"],["function guard(scope=","function guardX(scope="],["'import-downloads'","'arbitrary-event'"]]) {
    assert.throws(()=>familyContents(t,'worker',args=>{args.input=Buffer.from(args.input.toString().replace(old,next));args.sourceSha256=sha(args.input);}),/UNSUPPORTED_SOURCE_GUARD_TEMPLATE/);
  }
  assert.throws(()=>familyContents(t,'worker',args=>{const code=Buffer.from(args.modules.get('engine.cjs').toString().replace("phase='install'","phase='import'"));args.modules.set('engine.cjs',code);args.config.modulePins['engine.cjs']=sha(code);}),/UNSUPPORTED_SOURCE_GUARD_TEMPLATE/);
});
function generatedHelpers(packet, additions='') {
  const text=packet.get('index.prepared.js').toString(), begin=text.indexOf(' const sourceCode='), end=text.indexOf(' async function getFileProof');
  assert(begin>0&&end>begin);return text.slice(begin,end)+additions;
}
test('actual generated async guard resamples native state after await and effect barriers are synchronous', familyOnly, async t => {
  const packet=familyContents(t), log=[], pkg={}, current={active:true,phase:'import',pkg,downloadId:null};let release;
  const context={need:(v,c)=>{if(!v)throw Error(c);},fatal:null,configFile:'cfg',configPin:'pin',hash:()=> 'pin',api:{getState:()=>({settings:{profiles:{lastActiveProfile:{g:'p'}}}})},selectors:{activeGameId:()=> 'g',activeProfileId:()=> 'p'},c:{health:{gameId:'g',profileId:'p'}},sourceProof:{prove:()=>new Promise(r=>{release=r;}),assertCurrent:()=>{log.push('source');}},liveBarrier:()=>{log.push('live');return 'native-after-await';},runner:{current:()=>current},acceptedSnapshot:[],finalizing:false};
  vm.createContext(context);vm.runInContext(generatedHelpers(packet,';this.testGuard=guard;this.testEffect=effectBarrier;'),context);
  const flight=context.testGuard(); assert.deepEqual(log,[]);release();assert.equal(await flight,'native-after-await');assert.deepEqual(log,['source','live','source']);
  log.length=0;context.testEffect('import',pkg,null);assert.deepEqual(log,['source','live','source']);
  context.finalizing=true;assert.throws(()=>context.testEffect('import',pkg,null),/SOURCE_EFFECTS_HELD/);
  context.finalizing=false;current.phase='install';assert.throws(()=>context.testEffect('import',pkg,null),/SOURCE_EFFECT_SCOPE_CHANGED/);
});
test('actual generated native emitter wrappers reject synchronous drift before emitting', familyOnly, async t => {
  const text=familyContents(t).get('index.prepared.js').toString();
  const importCode=text.slice(text.indexOf('importOnce:pkg=>')+11,text.indexOf(',\n  install:'));
  const installCode=text.slice(text.indexOf('install:(pkg,id)=>')+8,text.indexOf(',verifyInstalled}'));
  let emitted=0,barriers=0;const pkg={}, allowed=new Map(), c={health:{profileId:'p'}};
  const env={api:{events:{emit:()=>{emitted++;}}},allowed,c,exclusivity:{run:(id,profile,fn)=>fn()},effectBarrier:()=>{barriers++;throw Error('SOURCE_CHANGED');}};vm.createContext(env);
  const importOnce=vm.runInContext('('+importCode+')',env),install=vm.runInContext('('+installCode+')',env);
  await assert.rejects(importOnce(pkg),/SOURCE_CHANGED/);await assert.rejects(install(pkg,'id'),/SOURCE_CHANGED/);
  assert.equal(emitted,0);assert.equal(barriers,2);
});
test('generated final checkpoint joins drain, fresh proof and verified cleanup before terminal output', familyOnly, async t => {
  const text=familyContents(t).get('index.prepared.js').toString();
  const start=text.indexOf('finalizing=true;poll.stop();await poll.drain();'), end=text.indexOf('const normalizedProfiles=',start);
  assert(start>0&&end>start);const body=text.slice(start,end);let release;
  const log=[], env={finalizing:false,poll:{stop:()=>log.push('stop'),drain:()=>new Promise(r=>{release=r;})},need:(v,c)=>{if(!v)throw Error(c);},fatal:null,accepted:[],sourceProof:{prove:async o=>{assert.equal(o.fresh,true);log.push('fresh');},assertCurrent:()=>log.push('current'),close:async()=>{log.push('close');return{};},assertFinalSnapshot:()=>log.push('final-source')},liveBarrier:()=>{log.push('native');return{};}};
  vm.createContext(env);const run=vm.runInContext('(async()=>{'+body+'})',env);const pending=run();assert.deepEqual(log,['stop']);release();await pending;
  assert.deepEqual(log,['stop','fresh','current','close','final-source','native','final-source']);
  assert(text.indexOf("record('guard-timing-terminal'",start)<text.indexOf("record('completed'",start));
  assert(!text.slice(text.indexOf("record('completed'",start),text.indexOf('}catch(e){const primaryCode',start)).includes('await '));
  env.poll.drain=async()=>{throw Error('DRAIN_FAILED');};log.length=0;await assert.rejects(run(),/DRAIN_FAILED/);assert.deepEqual(log,['stop']);
  env.poll.drain=async()=>{};env.sourceProof.close=async()=>{throw Error('CLEANUP_FAILED');};log.length=0;await assert.rejects(run(),/CLEANUP_FAILED/);assert(!log.includes('native'));
});
test('generated failure cleanup joins both owners and keeps sanitized primary failure distinct', familyOnly, async t => {
  const packet=familyContents(t), log=[], env={poll:{stop:()=>log.push('stop'),drain:async()=>{throw Error('DRAIN_FAILED');},metrics:()=>({})},sourceProof:{close:async()=>{log.push('close');throw Error('private/path failed');}},pollMetrics:null};
  vm.createContext(env);vm.runInContext(generatedHelpers(packet,';this.cleanup=stopSourceProof;'),env);
  assert.deepEqual(Array.from(await env.cleanup()),['DRAIN_FAILED','SOURCE_GUARD_FAILED']);assert.deepEqual(log,['stop','close']);
  const text=packet.get('index.prepared.js').toString();assert(text.includes('code:primaryCode,cleanupCodes'));assert(!text.includes('code:e.message,noReplay:true,reconcileRequired:true'));
});

test('generated bootstrap refuses incomplete pins and dynamic mutable aliases before any proof import', familyOnly, t=>{
  const packet=familyContents(t), text=packet.get('index.prepared.js').toString(), cfg=JSON.parse(packet.get('reviewed.prepared.json'));
  const root=path.join(os.tmpdir(),'source-proof-control'), log=[];
  const env={need:(v,c)=>{if(!v)throw Error(c);},c:{sourceProofMode:'worker',sourceProof:{},modulePins:cfg.modulePins,helperSHA256:'pin',processGuard:{path:'guard',sha256:'pin'},control:root,packages:[{key:'Own-Package'}],sourcePins:{}},configFile:'cfg',configPin:'pin',__filename:'entry',__dirname:'plugin',hash:()=>{log.push('hash');return 'pin';},path,safe:(root,name)=>path.join(root,name),require:name=>{log.push('require');if(name.includes('scope'))return{validateSourceScope:options=>{assert(options.excludedPaths.includes(path.join(root,'root-ready.json')));return{};}};return{createSourceProof:()=>({})};}};
  // Fake bootstrap hashes are admitted using exact controlled test pins.
  env.c.modulePins=Object.fromEntries(Object.keys(cfg.modulePins).map(n=>[n,'a'.repeat(64)]));env.hash=p=>{log.push('hash');return p==='cfg'||p==='entry'||p==='guard'?'pin':'a'.repeat(64);};
  vm.createContext(env);vm.runInContext(generatedHelpers(packet,';this.startProof=startSourceProof;'),env);
  const required='file-proof-child.cjs',pin=env.c.modulePins[required];delete env.c.modulePins[required];assert.throws(()=>env.startProof(),/SOURCE_PROOF_MODULE_PINS_REQUIRED/);assert(!log.includes('require'));
  env.c.modulePins[required]=pin;
  for(const name of ['OWN-PACKAGE-import-1.JSON','EARLY-DEPLOY-HELD-1.JSON.PENDING']){log.length=0;env.c.sourcePins={[path.join(root,name)]:'a'.repeat(64)};assert.throws(()=>env.startProof(),/FILE_PROOF_SCOPE_MUTABLE_SOURCE/);assert(!log.includes('require'));}
  log.length=0;env.c.sourcePins={};env.startProof();assert.equal(log.indexOf('require'),Object.keys(env.c.modulePins).length+3);
});
test('worker verification refuses stripped mode, rebound held inputs and stale trusted owners', familyOnly,t=>{
  const packet=familyContents(t),root=fs.mkdtempSync(path.join(os.tmpdir(),'source-kit-check-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [name,bytes]of packet)fs.writeFileSync(path.join(root,name),bytes);
  assert.equal(verifyHelper(root).status,'code-contract-verified');
  const cfgFile=path.join(root,'reviewed.prepared.json'),cfg=JSON.parse(packet.get('reviewed.prepared.json'));
  fs.writeFileSync(cfgFile,JSON.stringify({...cfg,sourceProof:{}}));assert.throws(()=>verifyHelper(root),/HELD_SOURCE_PROOF_BINDINGS_REQUIRED/);
  fs.writeFileSync(cfgFile,JSON.stringify({...cfg,sourceProofMode:'cached-sync'}));assert.throws(()=>verifyHelper(root),/HELPER_SOURCE_PROOF_MODE_DIFFERS/);
  fs.writeFileSync(cfgFile,packet.get('reviewed.prepared.json'));
  const read=fs.readFileSync;try{fs.readFileSync=function(file,...args){const bytes=read.call(this,file,...args);return path.resolve(String(file))===path.resolve('tools/modding/vortex-agent/helper-source-scope.cjs')?Buffer.concat([bytes,Buffer.from('\n// owner drift')]):bytes;};assert.throws(()=>verifyHelper(root),/STALE_HELPER_KIT/);}finally{fs.readFileSync=read;}
});

test('worker live barrier preserves every original full guard check except the offloaded source loop', familyOnly,t=>{
  const sync=familyContents(t,'cached-sync').get('index.prepared.js').toString().replace(/\r\n/g,'\n'), worker=familyContents(t).get('index.prepared.js').toString();
  const begin=sync.indexOf(" function guard(scope="),end=sync.indexOf(' async function getFileProof');
  const original=sync.slice(begin,end).replace('function guard(','function liveBarrier(').replace("for(const[p,h]of Object.entries(c.sourcePins))need(physical(p).sha256===h,'SOURCE_CHANGED');",'');
  const live=worker.slice(worker.indexOf(' function liveBarrier(scope='),worker.indexOf(' const sourceCode='));
  assert.equal(live.trim(),original.trim());
});
test('actual generated held entry returns without importing a worker or installing native callbacks', familyOnly,t=>{
  const packet=familyContents(t),config=JSON.parse(packet.get('reviewed.prepared.json')),imports=[];
  const sandbox={__dirname:'held-plugin',module:{exports:{}},require:name=>{
    imports.push(name);
    if(name==='original-fs')return{existsSync:()=>true,readFileSync:()=>JSON.stringify(config)};
    if(name==='path')return path;if(name==='crypto')return crypto;
    if(name==='@nexusmods/vortex-api')return{selectors:{},util:{}};
    if(name==='./engine.cjs')return{createRunner:()=>{throw Error('UNEXPECTED_RUNNER');}};
    if(name==='./local-policy.cjs')return{need:(v,c)=>{if(!v)throw Error(c);}};
    if(name==='./tool-timestamps.cjs'||name==='./protected-settings.cjs')return{};
    throw Error('UNEXPECTED_IMPORT');
  }};
  vm.runInNewContext(packet.get('index.prepared.js').toString(),sandbox);
  assert.equal(sandbox.module.exports({api:{getState:()=>{throw Error('UNEXPECTED_NATIVE_READ');}},once:()=>{throw Error('UNEXPECTED_CALLBACK');}}),true);
  assert(!imports.some(name=>name.includes('source-proof')||name.includes('file-proof')||name.includes('guard-poller')));
});

test('worker plain preparer refuses trusted owner drift before creating its output',familyOnly,t=>{
  const source=process.env.VORTEX_OWN_HELPER_REFERENCE,root=fs.mkdtempSync(path.join(os.tmpdir(),'source-prewrite-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const output=path.join(root,'held'),args={source,output,sourceSha256:sha(fs.readFileSync(path.join(source,'index.prepared.js'))),sourceProofMode:'worker',apply:true};
  const owner=path.resolve('tools/modding/vortex-agent/helper-source-scope.cjs'),read=fs.readFileSync;
  try{fs.readFileSync=function(file,...rest){const bytes=read.call(this,file,...rest);return path.resolve(String(file))===owner?Buffer.concat([bytes,Buffer.from('\n// owner drift')]):bytes;};assert.throws(()=>prepareHelper(args),/STALE_HELPER_KIT/);}finally{fs.readFileSync=read;}
  assert(!fs.existsSync(output));assert.deepEqual(fs.readdirSync(root),[]);
});
test('worker plain preparer detects postwrite owner drift and preserves held output without retry',familyOnly,t=>{
  const source=process.env.VORTEX_OWN_HELPER_REFERENCE,root=fs.mkdtempSync(path.join(os.tmpdir(),'source-postwrite-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const output=path.join(root,'held'),args={source,output,sourceSha256:sha(fs.readFileSync(path.join(source,'index.prepared.js'))),sourceProofMode:'worker',apply:true};
  const owner=path.resolve('tools/modding/vortex-agent/helper-source-scope.cjs'),read=fs.readFileSync,write=fs.writeFileSync;let drift=false;
  try{
    fs.writeFileSync=function(file,...rest){const value=write.call(this,file,...rest);if(path.resolve(String(file))===path.join(output,'HELPER-KIT.json'))drift=true;return value;};
    fs.readFileSync=function(file,...rest){const bytes=read.call(this,file,...rest);return drift&&path.resolve(String(file))===owner?Buffer.concat([bytes,Buffer.from('\n// owner drift')]):bytes;};
    assert.throws(()=>prepareHelper(args),/STALE_HELPER_KIT/);
  }finally{fs.readFileSync=read;fs.writeFileSync=write;}
  assert(drift);assert(fs.existsSync(path.join(output,'HELPER-KIT.json')));assert(!fs.existsSync(path.join(output,'reviewed.json')));
  const before=fs.readdirSync(output).sort();assert.throws(()=>prepareHelper(args),/HELPER_OUTPUT_EXISTS/);assert.deepEqual(fs.readdirSync(output).sort(),before);
});
