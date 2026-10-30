import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { _keeperForTests, verifyKeeperPlan, createKeeper } from './keeper.mjs';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value) + '\n');
function ownZip() {
  const name = Buffer.from('r6/scripts/OwnKeeper/Example.reds'), content = Buffer.from('own synthetic payload');
  const local = Buffer.alloc(30), center = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  center.writeUInt32LE(0x02014b50); center.writeUInt16LE(20, 4); center.writeUInt16LE(20, 6);
  center.writeUInt32LE(crc32(content), 16); center.writeUInt32LE(content.length, 20); center.writeUInt32LE(content.length, 24); center.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(center.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + content.length, 16);
  return { bytes: Buffer.concat([local, name, content, center, name, end]), payload: { [name.toString()]: sha(content) } };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-keeper-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = path.join(root, 'inputs'), outputs = path.join(root, 'outputs'); fs.mkdirSync(inputs); fs.mkdirSync(outputs);
  const archive = ownZip(), files = [{ id: 'ownZip', kind: 'own-zip', content: archive.bytes, payload: archive.payload },
    { id: 'build', kind: 'build-receipt', content: encode({ ownFixtureOnly: true }) },
    { id: 'source', kind: 'own-source', content: Buffer.from('own source fixture') }];
  const artifacts = files.map(({ content, ...file }) => {
    const target = path.join(inputs, file.id); fs.writeFileSync(target, content);
    return { ...file, path: target, bytes: content.length, sha256: sha(content) };
  });
  const value = { schema: 'keeper-plan/1', artifacts, consumers: [{ id: 'one', evidenceArtifactId: 'build',
    inputs: ['source'], currentOutputs: ['ownZip'], rollback: ['ownZip'] }], unknownConsumers: [] };
  const manifestFile = path.join(inputs, 'plan.json');
  const options = () => { const raw = encode(value); fs.writeFileSync(manifestFile, raw); return { manifestFile, manifestSHA256: sha(raw) }; };
  const api = _keeperForTests(outputs); return { root, inputs, outputs, files, value, options, api, manifestFile };
}
function snapshot(root) {
  const result = {}; function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name), key = path.relative(root, file); result[key] = e.isDirectory() ? null : fs.readFileSync(file).toString('hex'); if (e.isDirectory()) walk(file);
  } } walk(root); return result;
}
test('verify is zero-write; declared role sharing is valid and never grants deletion/native acceptance', t => {
  const f = fixture(t), opts = f.options(), before = snapshot(f.root), value = f.api.verifyKeeperPlan(opts);
  assert.equal(value.artifactCount, 3); assert.equal(value.effectsPerformed, false); assert.equal(value.retirementRequiresOwnerReview, true);
  assert.deepEqual(value.retireActions, []); assert.equal(value.provenanceIndependentlyVerified, false); assert.equal(value.runtimeVerified, false);
  assert.deepEqual(snapshot(f.root), before); assert.equal(verifyKeeperPlan(opts).artifactCount, 3);
});
test('keeper retains exact bytes and isolated restore works after all original files are removed', t => {
  const f = fixture(t), opts = f.options(), keeper = path.join(f.outputs, 'keeper'); const created = f.api.createKeeper({ ...opts, output: keeper });
  assert.equal(created.effectsPerformed, true); assert.equal(created.proofSHA256.length, 64);
  assert.equal(f.api.verifyKeeper({ keeper, proofSHA256: created.proofSHA256 }).effectsPerformed, false);
  const rawManifest = fs.readFileSync(f.manifestFile); fs.rmSync(f.inputs, { recursive: true });
  const output = path.join(f.outputs, 'restore'), restored = f.api.restoreKeeper({ keeper, proofSHA256: created.proofSHA256, output });
  assert(fs.readFileSync(path.join(output, 'retained-manifest.json')).equals(rawManifest));
  for (const file of f.files) assert(fs.readFileSync(path.join(output, 'artifacts', `artifact-${file.id}.bin`)).equals(file.content));
  assert.equal(f.api.verifyKeeper({ keeper: output, proofSHA256: restored.proofSHA256 }).artifactCount, 3);
});
test('unknown consumers block retirement planning but copying remains inert and available', t => {
  const f = fixture(t); f.value.unknownConsumers = ['external-build'];
  const opts = f.options(), verified = f.api.verifyKeeperPlan(opts); assert.equal(verified.retirePlanBlocked, true);
  const created = f.api.createKeeper({ ...opts, output: path.join(f.outputs, 'held-retention') }); assert.equal(created.retirePlanBlocked, true); assert.deepEqual(created.retireActions, []);
});
test('manifest pins, duplicate JSON keys, closed refs, orphan artifacts and unsupported fields refuse', t => {
  const f = fixture(t), opts = f.options(); assert.throws(() => f.api.verifyKeeperPlan({ ...opts, manifestSHA256: '0'.repeat(64) }), /KEEPER_MANIFEST_CHANGED/);
  fs.writeFileSync(f.manifestFile, '{"schema":1,"schema":2}'); const bytes = fs.readFileSync(f.manifestFile);
  assert.throws(() => f.api.verifyKeeperPlan({ manifestFile: f.manifestFile, manifestSHA256: sha(bytes) }), /KEEPER_INVALID_JSON/);
  const original = structuredClone(f.value);
  const mutations = [v => { v.extra = true; }, v => { v.consumers[0].inputs = ['missing']; }, v => { v.consumers[0].inputs = ['source', 'source']; },
    v => { v.consumers[0].inputs = []; }, v => { v.artifacts.push({ ...v.artifacts[2], id: 'duplicate' }); }, v => { v.artifacts[0].kind = 'credentials'; }];
  for (const change of mutations) { f.value = structuredClone(original); change(f.value); const raw = encode(f.value); fs.writeFileSync(f.manifestFile, raw);
    assert.throws(() => f.api.verifyKeeperPlan({ manifestFile: f.manifestFile, manifestSHA256: sha(raw) }), /KEEPER_/); }
});
test('input corruption, missing files and physical aliases refuse before output creation', t => {
  for (const mode of ['changed', 'missing', 'hardlink', 'symlink']) {
    const f = fixture(t); const source = f.value.artifacts[2];
    if (mode === 'changed') fs.writeFileSync(source.path, 'changed');
    if (mode === 'content') fs.appendFileSync(path.join(keeper, 'artifacts', 'artifact-source.bin'), 'tampered');
    if (mode === 'missing') fs.unlinkSync(source.path);
    if (mode === 'hardlink') { fs.unlinkSync(source.path); fs.linkSync(f.value.artifacts[1].path, source.path); source.bytes = f.value.artifacts[1].bytes; source.sha256 = f.value.artifacts[1].sha256; }
    if (mode === 'symlink') { fs.unlinkSync(source.path); fs.symlinkSync(f.value.artifacts[1].path, source.path); }
    const opts = f.options(), output = path.join(f.outputs, 'copy'); assert.throws(() => f.api.createKeeper({ ...opts, output }), /KEEPER_/); assert.equal(fs.existsSync(output), false);
  }
});
test('ZIP CRC and exact payload are checked using maintained inspector', t => {
  const f = fixture(t); f.value.artifacts[0].payload = { 'r6/scripts/OwnKeeper/Example.reds': '0'.repeat(64) };
  assert.throws(() => f.api.verifyKeeperPlan(f.options()), /KEEPER_PAYLOAD_MISMATCH/);
  const zip = f.value.artifacts[0]; const corrupt = fs.readFileSync(zip.path); corrupt[65] ^= 1; fs.writeFileSync(zip.path, corrupt); zip.sha256 = sha(corrupt);
  assert.throws(() => f.api.verifyKeeperPlan(f.options()), /KEEPER_ARCHIVE_INVALID/);
});
test('copy-map tamper, missing/extra copied files and proof pin mismatch refuse restore', t => {
  for (const mode of ['map', 'missing', 'extra', 'proof', 'content']) {
    const f = fixture(t), keeper = path.join(f.outputs, 'keeper'), made = f.api.createKeeper({ ...f.options(), output: keeper });
    if (mode === 'map') fs.appendFileSync(path.join(keeper, 'copy-map.json'), ' ');
    if (mode === 'content') fs.appendFileSync(path.join(keeper, 'artifacts', 'artifact-source.bin'), 'tampered');
    if (mode === 'missing') fs.unlinkSync(path.join(keeper, 'artifacts', 'artifact-source.bin'));
    if (mode === 'extra') fs.writeFileSync(path.join(keeper, 'foreign'), 'foreign');
    const output = path.join(f.outputs, 'restore'); assert.throws(() => f.api.restoreKeeper({ keeper, output, proofSHA256: mode === 'proof' ? '0'.repeat(64) : made.proofSHA256 }), /KEEPER_/);
    assert.equal(fs.existsSync(output), false);
  }
});
test('output scope, existing directories, source overlap and reparse outputs are refused', t => {
  const f = fixture(t), opts = f.options();
  assert.throws(() => createKeeper({ ...opts, output: path.join(f.outputs, 'outside-production') }), /KEEPER_OUTPUT_SCOPE/);
  assert.throws(() => f.api.createKeeper({ ...opts, output: path.join(f.outputs, '..', 'escape') }), /KEEPER_OUTPUT_SCOPE|KEEPER_UNSAFE_PATH/);
  const existing = path.join(f.outputs, 'existing'); fs.mkdirSync(existing); assert.throws(() => f.api.createKeeper({ ...opts, output: existing }), /KEEPER_OUTPUT_EXISTS/);
  const broken = path.join(f.outputs, 'broken'); fs.symlinkSync(path.join(f.outputs, 'missing-target'), broken);
  assert.throws(() => f.api.createKeeper({ ...opts, output: broken }), /KEEPER_OUTPUT_EXISTS/);
  const alias = path.join(f.outputs, 'alias'); fs.symlinkSync(f.inputs, alias, 'junction'); assert.throws(() => f.api.createKeeper({ ...opts, output: path.join(alias, 'keeper') }), /KEEPER_UNSAFE_PATH/);
});
test('partial fsync failure preserves held output and refuses overwrite or rerun', t => {
  const f = fixture(t), opts = f.options(), output = path.join(f.outputs, 'partial'); const sync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Error('private disk failure'); };
  try { assert.throws(() => f.api.createKeeper({ ...opts, output }), /KEEPER_IO_FAILED/); } finally { fs.fsyncSync = sync; }
  assert.equal(fs.existsSync(output), false); assert(fs.readdirSync(f.outputs).some(name => name.startsWith('.keeper-reservation-')));
  const before = snapshot(f.root); assert.throws(() => f.api.createKeeper({ ...opts, output }), /KEEPER_ATTEMPT_ALREADY_RESERVED/); assert.deepEqual(snapshot(f.root), before);
});
test('mutating an admitted input during copy holds the partial keeper without a completed proof', t => {
  const f = fixture(t), opts = f.options(), output = path.join(f.outputs, 'changed'), write = fs.writeFileSync; let mutated = false;
  fs.writeFileSync = (...args) => { const value = write(...args); if (typeof args[0] === 'number' && !mutated) { mutated = true; write(f.value.artifacts[2].path, 'different'); } return value; };
  try { assert.throws(() => f.api.createKeeper({ ...opts, output }), /KEEPER_FILE_CHANGED|KEEPER_ARTIFACT_MISMATCH/); } finally { fs.writeFileSync = write; }
  assert.equal(fs.existsSync(output), false); const held = fs.readdirSync(f.outputs, { withFileTypes: true }).filter(e => e.isDirectory());
  assert.equal(held.length, 1); assert.equal(fs.existsSync(path.join(f.outputs, held[0].name, 'KEEPER-PROOF.json')), false);
});

test('case-folded artifact IDs fail before output creation; DOS names are safely prefixed', t => {
  const f = fixture(t); f.value.artifacts[2].id = 'BUILD'; f.value.consumers[0].inputs = ['BUILD'];
  const output = path.join(f.outputs, 'case-collision'); assert.throws(() => f.api.createKeeper({ ...f.options(), output }), /KEEPER_INVALID_ARTIFACT/);
  assert.equal(fs.existsSync(output), false);
  f.value.artifacts[2].id = 'CON'; f.value.consumers[0].inputs = ['CON'];
  const made = f.api.createKeeper({ ...f.options(), output });
  assert.equal(fs.existsSync(path.join(made.keeper, 'artifacts', 'artifact-CON.bin')), true);
});

test('replaced private directory is rejected and foreign contents are preserved', t => {
  const f = fixture(t), opts = f.options(), output = path.join(f.outputs, 'replace'), mkdir = fs.mkdirSync; let changed = false, foreign;
  fs.mkdirSync = (folder, ...args) => {
    const value = mkdir(folder, ...args);
    if (path.basename(folder) === 'artifacts' && !changed) {
      changed = true; const parent = path.dirname(folder); fs.renameSync(parent, parent + '-owned'); mkdir(parent); mkdir(folder);
      foreign = path.join(parent, 'foreign'); fs.writeFileSync(foreign, 'preserve me');
    }
    return value;
  };
  try { assert.throws(() => f.api.createKeeper({ ...opts, output }), /KEEPER_PATH_CHANGED/); } finally { fs.mkdirSync = mkdir; }
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'preserve me'); assert.equal(fs.existsSync(output), false);
  assert.throws(() => f.api.createKeeper({ ...opts, output }), /KEEPER_ATTEMPT_ALREADY_RESERVED/);
});
test('publication refuses a destination created concurrently and preserves complete held packet', t => {
  const f = fixture(t), opts = f.options(), output = path.join(f.outputs, 'raced'), rename = fs.renameSync;
  fs.renameSync = (source, target) => { fs.mkdirSync(target); if (process.platform !== 'win32') fs.writeFileSync(path.join(target, 'foreign'), 'preserve'); return rename(source, target); };
  try { assert.throws(() => f.api.createKeeper({ ...opts, output }), /KEEPER_IO_FAILED/); } finally { fs.renameSync = rename; }
  assert.equal(fs.statSync(output).isDirectory(), true);
  const held = fs.readdirSync(f.outputs, { withFileTypes: true }).find(e => e.isDirectory() && e.name.startsWith('.keeper-'));
  assert(held); assert.equal(fs.existsSync(path.join(f.outputs, held.name, 'KEEPER-PROOF.json')), true);
});

test('Windows alternate streams, device names and namespace aliases refuse before writes', t => {
  const f = fixture(t), original = f.value.artifacts[2].path;
  for (const candidate of [original + ':stream', path.join(f.inputs, 'NUL.bin'), path.join(f.inputs, 'trailing.'), '\\\\server\\share\\artifact']) {
    f.value.artifacts[2].path = candidate; const opts = f.options(), before = snapshot(f.root);
    assert.throws(() => f.api.verifyKeeperPlan(opts), /KEEPER_UNSAFE_PATH|KEEPER_ABSOLUTE_PATH_REQUIRED/);
    assert.deepEqual(snapshot(f.root), before);
  }
});
