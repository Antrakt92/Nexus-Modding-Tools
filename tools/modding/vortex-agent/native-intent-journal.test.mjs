import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createNativeIntentJournal} from './native-intent-journal.mjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';

const h = 'a'.repeat(64), encode = value => Buffer.from(JSON.stringify(value));
const moduleURL = new URL('./native-intent-journal.mjs', import.meta.url).href;
function request() {
  const plan = {schema: 'install-job-plan/1', family: 'tracked-new-disabled', contractId: job.CONTRACT_ID,
    context: {gameId: 'cyberpunk2077', profileId: 'fixture', gamePath: 'F:/Fixture/Game', stagingPath: 'F:/Fixture/Stage',
      downloadPath: 'D:/Fixture/Downloads', filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}},
    package: {downloadId: 'tracked', fileName: 'Own.zip', expectedModId: 'Own', expectedType: '', bytes: 200,
      sha256: h, md5: 'b'.repeat(32), expectedUncompressedBytes: 10, payload: {'r6/scripts/own.reds': h}},
    evidence: {buildSHA256: h, sourceSHA256: h, nativeAdmissionSHA256: h}, options: {enabled: false, deploy: false}};
  return {schema: 'native-dispatch-request/1', contractId: dispatch.CONTRACT_ID, operationId: 'op_' + '1'.repeat(32),
    nativeJobId: 'exec_' + '2'.repeat(32), planId: job.installPlanId(plan), managerScope: 'manager-fixture-1',
    rendererGeneration: 'renderer_' + '3'.repeat(32), admissionSHA256: 'c'.repeat(64), plan};
}
function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'native-intent-test-'));
  t.after(() => fs.rmSync(workspace, {recursive: true}));
  const root = path.join(workspace, 'private', 'native-intents');
  return {workspace, root, store: createNativeIntentJournal({root})};
}
const expectedHash = () => dispatch.dispatchRequestDigest(encode(request()));
const recordPath = (root, id = request().operationId) => path.join(root, id, 'intent.json');
const mutateRecord = (root, mutate) => {const p = recordPath(root), r = JSON.parse(fs.readFileSync(p)); mutate(r); fs.writeFileSync(p, JSON.stringify(r));};

test('missing intent is a read-only unknown, not proof of no dispatch', t => {
  const {store, root} = fixture(t), r = request();
  assert.equal(store.read(r.operationId, expectedHash()).state, 'not_observed'); assert(!fs.existsSync(root));
  for (const bad of ['', '../escape', 'op_' + 'A'.repeat(32)]) assert.throws(() => store.read(bad, expectedHash()), /INVALID_ID/);
  assert.throws(() => store.begin(encode({...r, extra: true})), /INVALID_REQUEST/);
  assert(!fs.existsSync(root));
  const status = store.read(r.operationId, expectedHash());
  assert.equal(status.dispatchState, 'unknown'); assert.equal(status.reconcileRequired, true);
  assert.equal(status.canReplay, false); assert.equal(status.effectsAllowed, false);
});
test('immutable exact request survives a fresh reader without becoming a dispatch permit', t => {
  const {store, root} = fixture(t), r = request(), bytes = encode(r), result = store.begin(bytes);
  bytes.fill(0); r.plan.context.profileId = 'changed';
  assert.equal(result.request.plan.context.profileId, 'fixture'); assert(Object.isFrozen(result.request.plan));
  assert.equal(result.state, 'intent_observed'); assert.equal(result.powerLossPersistenceVerified, false);
  assert.equal(result.effectsAllowed, false); assert.equal(result.canReplay, false);
  assert.deepEqual(Object.keys(store).sort(), ['begin', 'read']);
  const fresh = createNativeIntentJournal({root}).read(result.operationId, expectedHash());
  assert.deepEqual(fresh, result);
  assert.throws(() => createNativeIntentJournal({root}).begin(encode(request())), /EXISTS_HOLD/);
  assert.throws(() => store.begin(encode(request())), /HELD/);
  const changed = request(); changed.nativeJobId = 'exec_' + '4'.repeat(32);
  assert.throws(() => createNativeIntentJournal({root}).begin(encode(changed)), /EXISTS_HOLD/);
});
test('empty, pending, extra, malformed and contradictory records remain held', t => {
  for (const mode of ['empty', 'pending', 'extra', 'duplicate', 'digest', 'operation', 'job', 'root', 'directory', 'oversized']) {
    const {store, root} = fixture(t), r = request(); store.begin(encode(r));
    const dir = path.dirname(recordPath(root));
    if (mode === 'empty') fs.unlinkSync(recordPath(root));
    if (mode === 'pending') fs.renameSync(recordPath(root), path.join(dir, '.intent.json.pending-held'));
    if (mode === 'extra') fs.writeFileSync(path.join(dir, 'unexpected'), 'keep');
    if (mode === 'duplicate') fs.writeFileSync(recordPath(root), '{"schema":1,"schema":2}');
    if (mode === 'digest') mutateRecord(root, row => {row.requestSHA256 = '0'.repeat(64);});
    if (mode === 'operation') mutateRecord(root, row => {row.request.operationId = 'op_' + '5'.repeat(32);});
    if (mode === 'job') mutateRecord(root, row => {row.request.nativeJobId = 'exec_' + '5'.repeat(32);});
    if (mode === 'root') mutateRecord(root, row => {row.rootId = '0:0';});
    if (mode === 'directory') mutateRecord(root, row => {row.directoryId = '0:0';});
    if (mode === 'oversized') fs.writeFileSync(recordPath(root), Buffer.alloc(dispatch.LIMITS.bytes + 4097));
    assert.throws(() => createNativeIntentJournal({root}).read(r.operationId, expectedHash()), /NATIVE_INTENT_/);
    assert.throws(() => createNativeIntentJournal({root}).begin(encode(r)), /EXISTS_HOLD/);
  }
});
test('fresh reads require an external digest and reject a self-consistent replacement request', t => {
  const {store, root} = fixture(t), r = request(); store.begin(encode(r));
  assert.throws(() => store.read(r.operationId), /INVALID_BINDING/);
  assert.throws(() => store.read(r.operationId, '0'.repeat(64)), /BINDING_MISMATCH/);
  mutateRecord(root, row => {
    row.request.nativeJobId = 'exec_' + '8'.repeat(32);
    row.requestSHA256 = dispatch.dispatchRequestDigest(encode(row.request));
  });
  assert.throws(() => createNativeIntentJournal({root}).read(r.operationId, expectedHash()), /BINDING_MISMATCH/);
});
test('I/O failures preserve partial evidence and never return a successful publication', t => {
  for (const method of ['writeFileSync', 'fsyncSync', 'linkSync', 'unlinkSync', 'closeSync']) {
    const {store, root} = fixture(t), r = request(), original = fs[method];
    fs[method] = (...args) => {if (method === 'closeSync') original(...args); throw Error('injected failure');};
    try {assert.throws(() => store.begin(encode(r)), /NATIVE_INTENT_IO_FAILED/);}
    finally {fs[method] = original;}
    assert(fs.existsSync(path.join(root, r.operationId)));
    assert.throws(() => store.begin(encode(r)), /HELD/);
    assert.throws(() => createNativeIntentJournal({root}).begin(encode(r)), /EXISTS_HOLD/);
  }
});
test('symlink ancestors and root replacement cannot redirect an intent into foreign files', t => {
  const f = fixture(t), target = path.join(f.workspace, 'target'), alias = path.join(f.workspace, 'alias');
  fs.mkdirSync(target); fs.symlinkSync(target, alias, 'junction');
  assert.throws(() => createNativeIntentJournal({root: path.join(alias, 'intents')}).begin(encode(request())), /UNSAFE_PATH/);
  assert.deepEqual(fs.readdirSync(target), []);
  const original = fs.mkdirSync; let swapped = false;
  fs.mkdirSync = (file, ...args) => {
    const result = original(file, ...args);
    if (!swapped && String(file) === path.join(f.root, request().operationId)) {
      swapped = true; fs.renameSync(f.root, f.root + '-old'); original(f.root);
      original(path.join(f.root, request().operationId));
    }
    return result;
  };
  try {assert.throws(() => f.store.begin(encode(request())), /PATH_CHANGED/);}
  finally {fs.mkdirSync = original;}
  assert(swapped); assert.deepEqual(fs.readdirSync(path.join(f.root, request().operationId)), []);
});
test('reading cannot adopt a foreign root containing the original operation directory', t => {
  const {store, root} = fixture(t), r = request(); store.begin(encode(r));
  const dir = path.dirname(recordPath(root)), original = fs.lstatSync; let swapped = false;
  fs.lstatSync = (file, ...args) => {
    const result = original(file, ...args);
    if (!swapped && String(file) === dir) {
      swapped = true; fs.renameSync(root, root + '-old'); fs.mkdirSync(root);
      fs.renameSync(path.join(root + '-old', r.operationId), dir);
    }
    return result;
  };
  try {assert.throws(() => store.read(r.operationId, expectedHash()), /PATH_CHANGED/);}
  finally {fs.lstatSync = original;}
  assert(swapped); assert(fs.existsSync(recordPath(root)));
});

test('a root replaced during the final intent-name check cannot become an observed intent', t => {
  const {store, root} = fixture(t), r = request(); store.begin(encode(r));
  const dir = path.join(root, r.operationId), before = fs.readFileSync(recordPath(root));
  const original = fs.opendirSync; let checks = 0, swapped = false;
  fs.opendirSync = (file, ...args) => {
    if (String(file) === dir && ++checks === 2) {
      fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
      fs.renameSync(path.join(root + '-original', r.operationId), dir);
      swapped = true;
    }
    return original(file, ...args);
  };
  try {assert.throws(() => store.read(r.operationId, expectedHash()), /NATIVE_INTENT_PATH_CHANGED/);}
  finally {fs.opendirSync = original;}
  assert(swapped); assert.deepEqual(fs.readFileSync(recordPath(root)), before);
});
test('changed or removed records cannot become a successful same-process absence', t => {
  const {store, root} = fixture(t), r = request(); store.begin(encode(r));
  fs.renameSync(path.join(root, r.operationId), path.join(root, 'held-original'));
  assert.throws(() => store.read(r.operationId, expectedHash()), /PATH_CHANGED/);
  const fresh = createNativeIntentJournal({root}).read(r.operationId, expectedHash());
  assert.equal(fresh.state, 'not_observed'); assert.equal(fresh.dispatchState, 'unknown'); assert.equal(fresh.canReplay, false);
});

const child = `
import fs from 'node:fs';
import path from 'node:path';
import {createNativeIntentJournal} from ${JSON.stringify(moduleURL)};
const [root, stage, encoded] = process.argv.slice(1), bytes=Buffer.from(encoded,'base64');
const id=JSON.parse(bytes).operationId;
let writer;
const stop=()=>process.exit(21);
for(const method of ['mkdirSync','openSync','writeFileSync','fsyncSync','linkSync','unlinkSync','closeSync','readSync']) {
 const original=fs[method];
 fs[method]=(...args)=>{
  if(stage==='before-link' && method==='linkSync') stop();
  const result=original(...args);
  if(method==='openSync' && args[1]==='wx') writer=result;
  if(stage==='reserve' && method==='mkdirSync' && String(args[0])===path.join(root,id)) stop();
  if(stage==='open' && method==='openSync' && args[1]==='wx') stop();
  if(stage==='write' && method==='writeFileSync') stop();
  if(stage==='flush' && method==='fsyncSync') stop();
  if(stage==='link' && method==='linkSync') stop();
  if(stage==='unlink' && method==='unlinkSync') stop();
  if(stage==='close' && method==='closeSync' && args[0]===writer) stop();
  if(stage==='readback' && method==='readSync') stop();
  return result;
 };
}
try {const result=createNativeIntentJournal({root}).begin(bytes); if(stage==='returned') stop(); console.log(result.state);}
catch(error) {console.log(error.message);}
`;
test('fresh processes preserve holds at each process-exit window of intent publication', t => {
  for (const stage of ['reserve', 'open', 'write', 'flush', 'before-link', 'link', 'unlink', 'close', 'readback', 'returned']) {
    const {root} = fixture(t), r = request();
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', child, root, stage, encode(r).toString('base64')],
      {encoding: 'utf8', timeout: 15000});
    assert.equal(run.status, 21, run.stderr + stage);
    assert.throws(() => createNativeIntentJournal({root}).begin(encode(r)), /EXISTS_HOLD/);
    if (['unlink', 'close', 'readback', 'returned'].includes(stage)) {
      const observed = createNativeIntentJournal({root}).read(r.operationId, expectedHash());
      assert.equal(observed.state, 'intent_observed'); assert.equal(observed.dispatchState, 'unknown');
    } else assert.throws(() => createNativeIntentJournal({root}).read(r.operationId, expectedHash()), /CORRUPT/);
  }
});
test('two simultaneous processes reserve the same operation only once', async t => {
  const {root} = fixture(t), encoded = encode(request()).toString('base64');
  const run = () => new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', child, root, 'race', encoded], {timeout: 15000});
    let stdout = '', stderr = ''; process.stdout.on('data', value => {stdout += value;}); process.stderr.on('data', value => {stderr += value;});
    process.on('error', reject); process.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(Error(stderr)));
  });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.sort(), ['NATIVE_INTENT_EXISTS_HOLD', 'intent_observed']);
  assert.equal(createNativeIntentJournal({root}).read(request().operationId, expectedHash()).state, 'intent_observed');
});
test('near-limit plan plus wrapper is not constrained by the older one-MiB journal limit', t => {
  const {store, root} = fixture(t), r = request();
  function payload(extra) {
    return Object.fromEntries(Array.from({length: 4096}, (_, n) => ['r6/' + 'x'.repeat(120 + Math.floor(extra / 4096) + (n < extra % 4096 ? 1 : 0)) + n, h]));
  }
  let low = 0, high = 4096 * 100;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2); r.plan.package.payload = payload(mid);
    try {job.installPlanId(r.plan); low = mid;} catch {high = mid - 1;}
  }
  r.plan.package.payload = payload(low); r.planId = job.installPlanId(r.plan);
  const status = store.begin(encode(r));
  assert.equal(status.state, 'intent_observed'); assert(fs.statSync(recordPath(root)).size > 1024 * 1024);
});
test('default native intent directory is a sibling of flat receipts, never inside them', t => {
  const {workspace} = fixture(t), previous = process.env.NEXUS_WORKSPACE;
  process.env.NEXUS_WORKSPACE = workspace;
  try {
    createNativeIntentJournal().begin(encode(request()));
    assert(fs.existsSync(path.join(workspace, 'local-state/vortex-agent-build/native-install-intents', request().operationId, 'intent.json')));
    assert(!fs.existsSync(path.join(workspace, 'local-state/vortex-agent-build/receipts')));
  } finally {if (previous === undefined) delete process.env.NEXUS_WORKSPACE; else process.env.NEXUS_WORKSPACE = previous;}
});
