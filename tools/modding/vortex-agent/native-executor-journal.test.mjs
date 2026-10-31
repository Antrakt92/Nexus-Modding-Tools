import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createNativeExecutorJournal} from './native-executor-journal.mjs';
import {createNativeIntentJournal} from './native-intent-journal.mjs';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.resolve(HERE, '../../../local-state/executor-journal-tests');
const moduleURL = new URL('./native-executor-journal.mjs', import.meta.url).href;
const hex = n => n.toString(16).padStart(32, '0');
const worker = 'worker_' + hex(1), packet = 'd'.repeat(64), h = 'a'.repeat(64);
const encode = value => Buffer.from(JSON.stringify(value));
function request(n = 1, nativeJob = n) {
  const plan = {schema: 'install-job-plan/1', family: 'tracked-new-disabled', contractId: job.CONTRACT_ID,
    context: {gameId: 'cyberpunk2077', profileId: 'fixture', gamePath: 'F:/Fixture/Game', stagingPath: 'F:/Fixture/Stage',
      downloadPath: 'D:/Fixture/Downloads', filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}},
    package: {downloadId: 'tracked', fileName: 'Own.zip', expectedModId: 'Own', expectedType: '', bytes: 200,
      sha256: h, md5: 'b'.repeat(32), expectedUncompressedBytes: 10, payload: {'r6/scripts/own.reds': h}},
    evidence: {buildSHA256: h, sourceSHA256: h, nativeAdmissionSHA256: h}, options: {enabled: false, deploy: false}};
  return {schema: 'native-dispatch-request/1', contractId: dispatch.CONTRACT_ID,
    operationId: 'op_' + hex(n), nativeJobId: 'exec_' + hex(nativeJob), planId: job.installPlanId(plan),
    managerScope: 'manager-fixture-1', rendererGeneration: 'renderer_' + hex(1), admissionSHA256: 'c'.repeat(64), plan};
}
const digest = r => dispatch.dispatchRequestDigest(encode(r));
function fixture() {
  fs.mkdirSync(scratch, {recursive: true});
  // Retain own regenerable fixtures; no recursive deletion or shared runtime roots.
  const workspace = fs.mkdtempSync(path.join(scratch, 'run-'));
  const root = path.join(workspace, 'executor');
  return {workspace, root, store: createNativeExecutorJournal({root})};
}
const read = (store, r = request(), p = packet) => store.read(r.operationId, digest(r), r.nativeJobId, p);
const bindingPath = (root, r = request()) => path.join(root, 'jobs', r.nativeJobId, 'binding.json');
const intentPath = (root, r = request()) => path.join(root, 'operations', r.operationId, 'intent.json');
function held(s) {
  assert.equal(s.dispatchState, 'unknown'); assert.equal(s.reconcileRequired, true);
  assert.equal(s.canReplay, false); assert.equal(s.effectsAllowed, false);
  assert.equal(s.powerLossPersistenceVerified, false);
}
function mutate(file, fn) {
  const value = JSON.parse(fs.readFileSync(file)); fn(value); fs.writeFileSync(file, JSON.stringify(value));
}

test('missing and invalid requests are inert unknowns, never an unused-operation permit', () => {
  const {root, store} = fixture(), r = request();
  const missing = read(store); held(missing); assert.equal(missing.state, 'not_observed');
  assert.equal(fs.existsSync(root), false);
  for (const args of [[encode({...r, extra: true}), worker, packet], [encode(r), 'worker_bad', packet],
    [encode(r), worker, 'bad'], [Buffer.from('{'), worker, packet]])
    assert.throws(() => store.begin(...args), /NATIVE_EXECUTOR_(INVALID_REQUEST|INVALID_WORKER_LIFETIME|INVALID_BINDING)/);
  assert.throws(() => store.read('../escape', digest(r), r.nativeJobId, packet), /INVALID_ID/);
  assert.throws(() => store.read(r.operationId, undefined, r.nativeJobId, packet), /INVALID_BINDING/);
  assert.equal(fs.existsSync(root), false);
});

test('immutable dual-index reservation survives a fresh bound reader and detaches input', () => {
  const {root, store} = fixture(), r = request(), bytes = encode(r);
  const result = store.begin(bytes, worker, packet); bytes.fill(0); r.plan.context.profileId = 'changed';
  held(result); assert.equal(result.state, 'reserved'); assert.equal(result.workerLifetime, worker);
  assert.equal(result.packetSHA256, packet); assert.equal(result.request.plan.context.profileId, 'fixture');
  assert(Object.isFrozen(result.request.plan)); assert.deepEqual(Object.keys(store).sort(), ['begin', 'read']);
  assert.deepEqual(read(createNativeExecutorJournal({root})), result);
  assert.deepEqual(fs.readdirSync(path.dirname(bindingPath(root))), ['binding.json']);
  assert.deepEqual(fs.readdirSync(path.dirname(intentPath(root))), ['intent.json']);
});

test('every externally supplied read binding must match without modifying either index', () => {
  const {root, store} = fixture(), r = request(); store.begin(encode(r), worker, packet);
  const before = [intentPath(root), bindingPath(root)].map(p => fs.readFileSync(p));
  for (const args of [[request(2).operationId, digest(r), r.nativeJobId, packet],
    [r.operationId, 'e'.repeat(64), r.nativeJobId, packet],
    [r.operationId, digest(r), request(2).nativeJobId, packet],
    [r.operationId, digest(r), r.nativeJobId, 'e'.repeat(64)]])
    assert.throws(() => createNativeExecutorJournal({root}).read(...args), /NATIVE_EXECUTOR_/);
  [intentPath(root), bindingPath(root)].forEach((p, n) => assert(fs.readFileSync(p).equals(before[n])));
});

test('duplicates and same operation with another job never publish a second reservation', () => {
  const {root, store} = fixture(), r = request(); store.begin(encode(r), worker, packet);
  const original = fs.readFileSync(intentPath(root));
  for (const other of [r, request(1, 2)]) {
    assert.throws(() => createNativeExecutorJournal({root}).begin(encode(other), worker, packet), /INTENT_EXISTS_HOLD/);
    assert(fs.readFileSync(intentPath(root)).equals(original));
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'jobs')), [r.nativeJobId]);
});

test('same job with another operation preserves the new operation intent and original job', () => {
  const {root, store} = fixture(), first = request(1, 7), second = request(2, 7);
  store.begin(encode(first), worker, packet); const original = fs.readFileSync(bindingPath(root, first));
  assert.throws(() => createNativeExecutorJournal({root}).begin(encode(second), worker, packet), /JOB_EXISTS_HOLD/);
  const intent = createNativeIntentJournal({root: path.join(root, 'operations')}).read(second.operationId, digest(second));
  held(intent); assert.equal(intent.state, 'intent_observed');
  assert(fs.readFileSync(bindingPath(root, first)).equals(original));
  assert.throws(() => read(createNativeExecutorJournal({root}), second), /BINDING_MISMATCH/);
  assert.throws(() => createNativeExecutorJournal({root}).begin(encode(second), worker, packet), /INTENT_EXISTS_HOLD/);
});

test('empty or pending job reservations hold; a completed operation alone stays intent_only', () => {
  for (const mode of ['empty', 'pending', 'extra']) {
    const {root, store} = fixture(), r = request(); store.begin(encode(r), worker, packet);
    const file = bindingPath(root);
    if (mode === 'extra') fs.writeFileSync(path.join(path.dirname(file), 'foreign'), 'preserve');
    else fs.renameSync(file, mode === 'pending' ? path.join(path.dirname(file), '.binding.json.pending-held')
      : path.join(root, 'retained-binding.json'));
    assert.throws(() => read(createNativeExecutorJournal({root})), /CORRUPT/);
    assert.throws(() => createNativeExecutorJournal({root}).begin(encode(r), worker, packet), /INTENT_EXISTS_HOLD/);
  }
  const {root} = fixture(), r = request();
  createNativeIntentJournal({root: path.join(root, 'operations')}).begin(encode(r));
  const status = read(createNativeExecutorJournal({root})); held(status); assert.equal(status.state, 'intent_only');
  assert.equal(fs.existsSync(path.join(root, 'jobs')), false);
});

test('pre-existing incomplete job directories consume no retry and keep the newly written intent', () => {
  for (const pending of [false, true]) {
    const {root, store} = fixture(), r = request();
    const dir = path.dirname(bindingPath(root)); fs.mkdirSync(dir, {recursive: true});
    if (pending) fs.writeFileSync(path.join(dir, '.binding.json.pending-original'), 'original partial bytes');
    const before = fs.readdirSync(dir);
    assert.throws(() => read(createNativeExecutorJournal({root})), /CORRUPT/);
    assert.throws(() => store.begin(encode(r), worker, packet), /JOB_EXISTS_HOLD/);
    assert.deepEqual(fs.readdirSync(dir), before);
    assert.equal(createNativeIntentJournal({root: path.join(root, 'operations')})
      .read(r.operationId, digest(r)).state, 'intent_observed');
  }
});

test('a surviving job reservation without its operation stays unknown and cannot authorize replay', () => {
  const {root, store} = fixture(), r = request(); store.begin(encode(r), worker, packet);
  fs.renameSync(path.join(root, 'operations'), path.join(root, 'operations-retained'));
  const status = read(createNativeExecutorJournal({root}));
  held(status); assert.equal(status.state, 'reservation_only'); assert.equal(status.intentObserved, false);
  assert.equal(status.jobReservationObserved, true); assert.equal(status.request, null);
  assert.equal(fs.existsSync(path.join(root, 'operations')), false);
  const binding = fs.readFileSync(bindingPath(root));
  assert.throws(() => createNativeExecutorJournal({root}).begin(encode(r), worker, packet), /JOB_EXISTS_HOLD/);
  assert(fs.readFileSync(bindingPath(root)).equals(binding));
});

test('every persisted binding field and unexpected field is validated by fresh reads', () => {
  const changes = [r => {r.schema = 'other';}, r => {r.operationId = request(2).operationId;},
    r => {r.nativeJobId = request(2).nativeJobId;}, r => {r.requestSHA256 = 'e'.repeat(64);},
    r => {r.packetSHA256 = 'e'.repeat(64);}, r => {r.workerLifetime = 'invalid';},
    r => {r.rootId = '0:0';}, r => {r.jobsRootId = '0:0';}, r => {r.directoryId = '0:0';},
    r => {r.extra = true;}];
  for (const change of changes) {
    const {root, store} = fixture(); store.begin(encode(request()), worker, packet);
    mutate(bindingPath(root), change);
    assert.throws(() => read(createNativeExecutorJournal({root})), /NATIVE_EXECUTOR_(CORRUPT|BINDING_MISMATCH)/);
  }
});

test('moving original job children into replacement ancestors cannot make them authoritative', () => {
  for (const replaceRoot of [true, false]) {
    const {root, store} = fixture(); store.begin(encode(request()), worker, packet);
    const target = replaceRoot ? root : path.join(root, 'jobs'), retained = target + '-retained';
    fs.renameSync(target, retained); fs.mkdirSync(target);
    fs.renameSync(path.join(retained, replaceRoot ? 'jobs' : request().nativeJobId),
      path.join(target, replaceRoot ? 'jobs' : request().nativeJobId));
    if (replaceRoot) fs.renameSync(path.join(retained, 'operations'), path.join(target, 'operations'));
    assert.throws(() => read(store), /PATH_CHANGED/);
    assert.throws(() => read(createNativeExecutorJournal({root})), /CORRUPT/);
    assert(fs.existsSync(bindingPath(root)));
  }
});

test('symlink ancestors refuse without writing into the foreign target', () => {
  const {workspace} = fixture(), foreign = path.join(workspace, 'foreign'), alias = path.join(workspace, 'alias');
  fs.mkdirSync(foreign); fs.symlinkSync(foreign, alias, 'junction');
  const store = createNativeExecutorJournal({root: path.join(alias, 'executor')});
  assert.throws(() => store.begin(encode(request()), worker, packet), /UNSAFE_PATH/);
  assert.deepEqual(fs.readdirSync(foreign), []);
});

test('job binding publication I/O failures retain the intent and refuse another begin', () => {
  for (const method of ['writeFileSync', 'fsyncSync', 'linkSync', 'unlinkSync']) {
    const {root, store} = fixture(), original = fs[method]; let injected = false;
    fs[method] = (...args) => {
      const target = String(args[0]);
      // fd-only calls are selected by counting: the operation record is flushed first.
      if (method === 'fsyncSync' || method === 'writeFileSync') {
        fs[method].calls++;
        if (fs[method].calls === 2) {injected = true; throw Error('own binding flush failure');}
      } else if (target.includes(path.join(root, 'jobs'))) {injected = true; throw Error('own binding publication failure');}
      return original(...args);
    };
    fs[method].calls = 0;
    try {assert.throws(() => store.begin(encode(request()), worker, packet), /NATIVE_EXECUTOR_/);}
    finally {fs[method] = original;}
    assert(injected, method); assert(fs.existsSync(intentPath(root)));
    assert(fs.existsSync(path.dirname(bindingPath(root))));
    assert.throws(() => createNativeExecutorJournal({root}).begin(encode(request()), worker, packet), /INTENT_EXISTS_HOLD/);
  }
});

test('a completed binding writer close followed by an error is held even when fresh readback succeeds', () => {
  const {root, store} = fixture(), original = fs.closeSync; let injected = false;
  fs.closeSync = fd => {
    let selected = false;
    if (!injected && fs.existsSync(bindingPath(root))) {
      const opened = fs.fstatSync(fd, {bigint: true}), published = fs.lstatSync(bindingPath(root), {bigint: true});
      selected = opened.dev === published.dev && opened.ino === published.ino;
    }
    if (selected) {injected = true; original(fd); throw Error('own post-close interruption');}
    return original(fd);
  };
  try {assert.throws(() => store.begin(encode(request()), worker, packet), /IO_FAILED/);}
  finally {fs.closeSync = original;}
  assert(injected);
  const observed = read(createNativeExecutorJournal({root})); held(observed); assert.equal(observed.state, 'reserved');
  assert.throws(() => createNativeExecutorJournal({root}).begin(encode(request()), worker, packet), /INTENT_EXISTS_HOLD/);
});

test('replacing jobs root at reservation creation refuses even if original child is moved back', () => {
  const {root, store} = fixture(), original = fs.mkdirSync; let swapped = false;
  fs.mkdirSync = (file, ...args) => {
    const result = original(file, ...args);
    if (!swapped && String(file) === path.dirname(bindingPath(root))) {
      swapped = true;
      fs.renameSync(path.join(root, 'jobs'), path.join(root, 'jobs-retained'));
      original(path.join(root, 'jobs'));
      fs.renameSync(path.join(root, 'jobs-retained', request().nativeJobId), path.dirname(bindingPath(root)));
    }
    return result;
  };
  try {assert.throws(() => store.begin(encode(request()), worker, packet), /PATH_CHANGED/);}
  finally {fs.mkdirSync = original;}
  assert(swapped); assert.deepEqual(fs.readdirSync(path.dirname(bindingPath(root))), []);
  assert(fs.existsSync(intentPath(root)));
});

test('two real processes preserve both operation intents but reserve a shared job only once', {timeout: 15000}, async () => {
  const {root} = fixture(), requests = [request(11, 99), request(12, 99)];
  const code = `import {createNativeExecutorJournal} from ${JSON.stringify(moduleURL)};
    process.stdout.write('ready\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    try {const status=createNativeExecutorJournal({root:process.argv[1]}).begin(Buffer.from(process.argv[2],'base64'),process.argv[3],process.argv[4]);
      process.stdout.write(JSON.stringify({ok:true,state:status.state})+'\\n');}
    catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.message})+'\\n');}`;
  const runners = requests.map(r => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code, root, encode(r).toString('base64'), worker, packet],
      {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    let output = '', errors = '', readyResolve;
    const ready = new Promise(resolve => {readyResolve = resolve;});
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {child.kill(); reject(Error('Own test child deadline'));}, 8000);
      child.on('error', error => {clearTimeout(timer); reject(error);});
      child.stdout.on('data', chunk => {output += chunk; if (output.includes('\n')) readyResolve();
        if (output.length > 8192) {child.kill(); reject(Error('Own test output limit'));}});
      child.stderr.on('data', chunk => {errors += chunk;
        if (errors.length > 8192) {child.kill(); reject(Error('Own test stderr limit'));}});
      child.on('close', exit => {clearTimeout(timer);
        try {assert.equal(exit, 0, errors); assert.equal(errors, ''); resolve(JSON.parse(output.trim().split('\n').at(-1)));}
        catch (error) {reject(error);}});
    });
    return {child, ready, done};
  });
  try {
    await Promise.race([Promise.all(runners.map(r => r.ready)), ...runners.map(r => r.done)]);
    runners.forEach(r => r.child.stdin.end('go'));
    const outcomes = await Promise.all(runners.map(r => r.done));
    assert.equal(outcomes.filter(r => r.ok).length, 1);
    assert.match(outcomes.find(r => !r.ok).code, /JOB_EXISTS_HOLD/);
    const binding = JSON.parse(fs.readFileSync(bindingPath(root, requests[0])));
    assert(requests.some(r => r.operationId === binding.operationId && digest(r) === binding.requestSHA256));
    for (const r of requests) assert.equal(createNativeIntentJournal({root: path.join(root, 'operations')})
      .read(r.operationId, digest(r)).state, 'intent_observed');
  } finally {runners.forEach(r => {if (r.child.exitCode === null) r.child.kill();});}
});

test('replacement of the jobs ancestor during the final record-name check is held', () => {
  const {root, workspace, store} = fixture();
  store.begin(encode(request()), worker, packet);
  const reader = createNativeExecutorJournal({root});
  const original = fs.opendirSync;
  const jobsRoot = path.join(root, 'jobs'), retained = path.join(workspace, 'retained-jobs');
  for (const candidate of [jobsRoot, retained])
    assert(path.resolve(candidate).startsWith(path.resolve(scratch)+path.sep));
  let scans = 0, swapped = false;
  fs.opendirSync = (file, ...args) => {
    if (String(file) === path.dirname(bindingPath(root)) && ++scans === 2) {
      fs.renameSync(jobsRoot, retained);
      fs.mkdirSync(jobsRoot);
      fs.renameSync(path.join(retained, request().nativeJobId), path.dirname(bindingPath(root)));
      swapped = true;
    }
    return original(file, ...args);
  };
  try {assert.throws(() => read(reader), /PATH_CHANGED|CORRUPT/);}
  finally {fs.opendirSync = original;}
  assert(swapped);
});
