'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const core = require('./file-proof-worker.cjs');
const {createSourceProof, _createSourceProofForTests: createTest} = require('./helper-source-proof.cjs');
const create = (config, factory) => createTest(config, options => ({assertOpen() {}, ...factory(options)}));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-source-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'source.bin'); fs.writeFileSync(file, 'own source');
  const s = fs.lstatSync(file, {bigint: true});
  return {root, file, config: {roots: [{id: 'source', path: root, nodeId: core.identity(fs.lstatSync(root, {bigint: true}))}],
    epoch: 1, hostGeneration: 'test-host', rows: [{rootId: 'source', relativePath: 'source.bin',
      expected: {nodeId: core.identity(s), bytes: String(s.size), links: Number(s.nlink),
        sha256: crypto.createHash('sha256').update('own source').digest('hex')}}]}};
}
const clean = {exited: true, forced: false, uncertain: false};
const turn = () => new Promise(resolve => setImmediate(resolve));
test('runner and poller share only one identical in-flight source proof', async t => {
  const f = fixture(t); let resolve, calls = 0;
  const proof = create(f.config, () => ({prove() {calls++; return new Promise(r => {resolve = r;});}, close: async () => clean}));
  assert.throws(() => proof.assertCurrent(), /NOT_SETTLED/);
  const a = proof.prove(), b = proof.prove(); assert.equal(a, b);
  await turn(); assert.equal(calls, 1); assert.throws(() => proof.assertCurrent(), /NOT_SETTLED/);
  resolve({ok: true}); await a; proof.assertCurrent(); await proof.close();
});
test('real client freshly proves sources and detects later metadata drift synchronously', async t => {
  const f = fixture(t), proof = createSourceProof(f.config);
  try {
    assert.equal((await proof.prove()).metrics.hashes, 1);
    assert.equal((await proof.prove()).metrics.cacheHits, 1);
    assert.equal((await proof.prove({fresh: true})).metrics.hashes, 1);
    proof.assertCurrent(); fs.utimesSync(f.file, new Date(), new Date(Date.now() + 5000));
    assert.throws(() => proof.assertCurrent(), /SOURCE_CHANGED/);
    await assert.rejects(proof.prove(), /SOURCE_CHANGED/);
  } finally {await proof.close();}
});
test('mutation during pending proof poisons every waiter and prevents another request', async t => {
  const f = fixture(t); let resolve, calls = 0;
  const proof = create(f.config, () => ({prove() {calls++; return new Promise(r => {resolve = r;});}, close: async () => clean}));
  const a = proof.prove(), b = proof.prove(); const rejected = Promise.all([assert.rejects(a, /SOURCE_CHANGED/), assert.rejects(b, /SOURCE_CHANGED/)]);
  await turn(); fs.utimesSync(f.file, new Date(), new Date(Date.now() + 5000)); resolve({ok: true}); await rejected;
  await assert.rejects(proof.prove(), /SOURCE_CHANGED/); assert.equal(calls, 1); await proof.close();
});
test('fresh proof cannot reuse an ordinary pending phase', async t => {
  const f = fixture(t); let resolve;
  const proof = create(f.config, () => ({prove: () => new Promise(r => {resolve = r;}), close: async () => clean}));
  const ordinary = proof.prove(); await turn();
  await assert.rejects(proof.prove({fresh: true}), /SOURCE_BUSY/);
  resolve({ok: true}); await ordinary;
  const fresh = proof.prove({fresh: true}); await turn(); resolve({ok: true}); await fresh;
  proof.assertCurrent(); await proof.close();
});
test('close joins cancellation and permanently refuses reuse', async t => {
  const f = fixture(t); let reject;
  const proof = create(f.config, () => ({prove: () => new Promise((_, r) => {reject = r;}), close: async () => {reject(Error('FILE_PROOF_ABORTED')); return clean;}}));
  const pending = proof.prove(), rejected = assert.rejects(pending, /FILE_PROOF_ABORTED/); await turn();
  const a = proof.close(), b = proof.close(); assert.equal(a, b); assert.equal((await a).exited, true); await rejected;
  await assert.rejects(proof.prove(), /SOURCE_CLOSED|ABORTED/);
});
test('uncertain, forced or unfinished resource cleanup cannot report completion', async t => {
  for (const outcome of [{...clean, uncertain: true}, {...clean, forced: true}, {...clean, exited: false},
    {...clean, parentPipesClosed: false}, {...clean, ipcDisconnected: false}]) {
    const f = fixture(t), proof = create(f.config, () => ({prove: async () => ({}), close: async () => outcome}));
    await assert.rejects(proof.close(), /CLEANUP_UNCERTAIN/); await assert.rejects(proof.prove(), /CLEANUP_UNCERTAIN/);
  }
});
test('close handles flight rejection before delayed cleanup completes', async t => {
  const f = fixture(t); let reject, finishCleanup;
  const proof = create(f.config, () => ({prove: () => new Promise((_, r) => {reject = r;}),
    close() {reject(Error('FILE_PROOF_ABORTED')); return new Promise(r => {finishCleanup = r;});}}));
  // The close operation owns joining this deliberately unobserved request.
  void proof.prove(); await turn(); const cleanup = proof.close();
  await turn(); await turn(); finishCleanup(clean); await cleanup;
});
test('replacing an admitted root is rejected before another worker request', async t => {
  const f = fixture(t); let calls = 0;
  const proof = create(f.config, () => ({prove: async () => {calls++; return {};}, close: async () => clean}));
  await proof.prove();
  const retained = f.root + '-retained'; fs.renameSync(f.root, retained); fs.mkdirSync(f.root);
  t.after(() => fs.rmSync(retained, {recursive: true, force: true}));
  fs.writeFileSync(path.join(f.root, 'source.bin'), 'own source');
  assert.throws(() => proof.assertCurrent(), /ANCESTOR_CHANGED|ROOT_CHANGED/);
  await assert.rejects(proof.prove(), /ANCESTOR_CHANGED|ROOT_CHANGED/); assert.equal(calls, 1); await proof.close();
});
test('idle transport failure invalidates a historically successful source proof', async t => {
  const f = fixture(t); let failed = false, calls = 0;
  const proof = create(f.config, () => ({prove: async () => {calls++; return {};}, close: async () => clean,
    assertOpen() {if (failed) throw Error('FILE_PROOF_WORKER_FAILED');}}));
  await proof.prove(); proof.assertCurrent(); failed = true;
  assert.throws(() => proof.assertCurrent(), /WORKER_FAILED/);
  failed = false; await assert.rejects(proof.prove(), /WORKER_FAILED/); assert.equal(calls, 1); await proof.close();
});
test('construction failure never exposes an operating-system path in diagnostics', t => {
  const f = fixture(t); fs.rmSync(f.file);
  assert.throws(() => createSourceProof(f.config), error => error.message === 'FILE_PROOF_SOURCE_FAILED');
});
test('an earlier source failure cannot hide uncertain cleanup diagnostics', async t => {
  const f = fixture(t), proof = create(f.config, () => ({prove: async () => ({}),
    close: async () => ({...clean, uncertain: true})}));
  await proof.prove(); fs.utimesSync(f.file, new Date(), new Date(Date.now() + 5000));
  assert.throws(() => proof.assertCurrent(), /SOURCE_CHANGED/);
  await assert.rejects(proof.close(), /SOURCE_CLEANUP_UNCERTAIN/);
});
test('fresh final snapshot survives verified close but never reopens an effect barrier', async t => {
  const f = fixture(t), proof = createSourceProof(f.config);
  await proof.prove({fresh: true}); await proof.close(); proof.assertFinalSnapshot();
  assert.throws(() => proof.assertCurrent(), /SOURCE_CLOSED/);
  await assert.rejects(proof.prove(), /SOURCE_CLOSED/);
  // An attempted use of the effect API latches a failure; it cannot revive the
  // final checkpoint or the closed transport.
  assert.throws(() => proof.assertFinalSnapshot(), /SOURCE_CLOSED/);
});
test('final snapshot detects file drift after cleanup without another hash or worker', async t => {
  const f = fixture(t), proof = createSourceProof(f.config);
  await proof.prove({fresh: true}); await proof.close(); proof.assertFinalSnapshot();
  fs.utimesSync(f.file, new Date(), new Date(Date.now() + 5000));
  assert.throws(() => proof.assertFinalSnapshot(), /SOURCE_CHANGED/);
});
test('ordinary proof, pending fresh proof or uncertain cleanup cannot mint a final snapshot', async t => {
  for (const mode of ['ordinary', 'pending', 'uncertain']) {
    const f = fixture(t); let reject;
    const proof = create(f.config, () => ({prove: () => mode === 'pending' ? new Promise((_, r) => {reject = r;}) : Promise.resolve({}),
      close: async () => {if (reject) reject(Error('FILE_PROOF_ABORTED')); return mode === 'uncertain' ? {...clean, uncertain: true} : clean;}}));
    const flight = proof.prove({fresh: mode !== 'ordinary'});
    const observed = mode === 'pending' ? assert.rejects(flight, /ABORTED/) : flight;
    await turn(); if (mode !== 'pending') await observed;
    if (mode === 'uncertain') await assert.rejects(proof.close(), /CLEANUP_UNCERTAIN/); else await proof.close();
    if (mode === 'pending') await observed;
    assert.throws(() => proof.assertFinalSnapshot(), /FINAL_REQUIRED|ABORTED|CLEANUP_UNCERTAIN/);
  }
});
