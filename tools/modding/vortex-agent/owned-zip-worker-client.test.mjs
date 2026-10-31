// Explicit actual-worker acceptance on own archives/scratch, never Vortex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import job from './install-job-contract.cjs';
import dispatch from './native-dispatch-contract.cjs';
import {createOwnedZipWorker} from './owned-zip-worker-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASK = path.resolve(HERE, '../../../local-state/install-contract-20261031/owned-zip-worker');
const ENABLED = process.platform === 'win32' && process.arch === 'x64' && process.env.VORTEX_OWNED_ZIP_WORKER_TEST === '1';
const ownTest = (name, fn) => test(name, {skip: !ENABLED}, fn);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const nonce = () => crypto.randomBytes(16).toString('hex');
const FIXTURE = `
import sys,json,pathlib,hashlib,zipfile,struct
r=pathlib.Path(sys.argv[1]);r.mkdir(parents=True,exist_ok=False)
for n in ['archives','model-game','model-stage']: (r/n).mkdir()
pattern=b'worker own fixture bytes 0123456789'
data=(pattern*((int(sys.argv[2])+len(pattern)-1)//len(pattern)))[:int(sys.argv[2])]
count=int(sys.argv[4]);payload={}
p=r/'archives/own.zip'
with zipfile.ZipFile(p,'x',zipfile.ZIP_STORED,allowZip64=False) as z:
 for i in range(count):
  name='payload.bin' if count==1 else 'd'+str(i).zfill(4)+'a'*170+'/'+'b'*170+'/'+'c'*130+'.bin'
  content=data if count==1 else b'x';z.writestr(name,content);payload[name]=hashlib.sha256(content).hexdigest()
if sys.argv[3]=='1':
 b=bytearray(p.read_bytes());at=b.index(b'PK\\x01\\x02');v=struct.unpack_from('<I',b,14)[0]^1;struct.pack_into('<I',b,14,v);struct.pack_into('<I',b,at+16,v);p.write_bytes(b)
def identity(p):
 s=p.stat();return {'schema':'win-file-id128/1','volumeSerialNumber':str(s.st_dev),'fileId':str(s.st_ino)}
raw=p.read_bytes()
print(json.dumps({'archive':{'parent':str(p.parent),'parentIdentity':identity(p.parent),'leaf':p.name,'identity':identity(p),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()},'payload':payload,'total':len(data) if count==1 else count,'md5':hashlib.md5(raw).hexdigest()}))
`;

function fixture(bytes = 256*1024, corrupt = false, count = 1) {
  fs.mkdirSync(path.join(TASK, 'tests'), {recursive: true});
  const root = path.join(TASK, 'tests', 'run-'+nonce());
  const made = spawnSync('C:/Python314/python.exe', ['-I','-S','-B','-c', FIXTURE, root, String(bytes), corrupt ? '1' : '0', String(count)],
    {encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 2*1024*1024});
  assert.equal(made.status, 0, made.stderr);
  const value = JSON.parse(made.stdout);
  const roots = {gamePath: path.join(root, 'model-game'), stagingPath: path.join(root, 'model-stage'), downloadPath: path.join(root, 'archives')};
  const filesystemIds = Object.fromEntries(Object.entries(roots).map(([k,p]) => {const s = fs.statSync(p, {bigint: true}); return [k, `${s.dev}:${s.ino}`];}));
  const evidence = digest(Buffer.from('Standalone own scratch, no Vortex admission'));
  const plan = {schema: 'install-job-plan/1', family: 'tracked-new-disabled', contractId: job.CONTRACT_ID,
    context: {gameId: 'cyberpunk2077', profileId: 'worker-fixture', ...roots, filesystemIds},
    package: {downloadId: 'fixture-own', fileName: 'own.zip', expectedModId: 'own', expectedType: '',
      bytes: value.archive.bytes, sha256: value.archive.sha256, md5: value.md5,
      expectedUncompressedBytes: value.total, payload: value.payload},
    evidence: {buildSHA256: evidence, sourceSHA256: evidence, nativeAdmissionSHA256: evidence},
    options: {enabled: false, deploy: false}};
  const request = {schema: 'native-dispatch-request/1', contractId: dispatch.CONTRACT_ID,
    operationId: 'op_'+nonce(), nativeJobId: 'exec_'+nonce(), planId: job.installPlanId(plan),
    managerScope: 'manager-worker-fixture-1', rendererGeneration: 'renderer_'+nonce(), admissionSHA256: evidence, plan};
  process.env.NEXUS_WORKSPACE = path.join(TASK, 'coordinator-runtime');
  return {root, value, request, bytes: Buffer.from(JSON.stringify(request)), archive: Buffer.from(JSON.stringify(value.archive))};
}
function owner(t, input) {
  const worker = createOwnedZipWorker(input.bytes, input.archive);
  t.after(async () => {
    const state = worker.status();
    if (state.childClosed) return;
    if (!state.startSent) {await worker.retireInert(); return;}
    if (!['extracted','copied','cancelled'].includes(state.phase)) await worker.cancel();
    await worker.release();
  });
  return worker;
}

function cloneSources(input) {
  const clone = path.join(input.root, 'isolated');
  const modules = path.join(clone, 'tools/modding/vortex-agent');
  const foreign = path.join(input.root, 'foreign');
  fs.mkdirSync(modules, {recursive: true});
  fs.mkdirSync(foreign);
  const files = ['owned-zip-worker-client.mjs', 'owned-zip-worker.py', 'owned-file-transfer.py', 'owned-zip-extractor.py',
    'native-executor-journal.mjs', 'native-intent-journal.mjs', 'immutable-records.mjs', 'paths.cjs',
    'native-dispatch-contract.cjs', 'install-job-contract.cjs', 'strict-json.cjs'];
  for (const file of files) fs.copyFileSync(path.join(HERE, file), path.join(modules, file));
  return {clone, modules, foreign};
}

function held(status) {
  assert.equal(status.dispatchState, 'unknown');
  assert.equal(status.canReplay, false);
  assert.equal(status.reconcileRequired, true);
  assert.equal(status.effectsAllowed, false);
  assert.equal(status.powerLossPersistenceVerified, false);
}
async function captureChild(fn, prepare = () => {}) {
  const original = childProcess.spawn;
  let child;
  childProcess.spawn = (...args) => {child = original(...args); prepare(child); return child;};
  syncBuiltinESMExports();
  try {return await fn(() => child);}
  finally {childProcess.spawn = original; syncBuiltinESMExports();}
}

ownTest('worker constructor is inert; cancellation prevents later startup', async t => {
  const input = fixture(), worker = owner(t, input);
  assert.equal(worker.status().workerPid, null);
  await worker.cancel();
  await assert.rejects(worker.start(), /START_REFUSED/);
  assert.equal(worker.status().startAttempted, false);
});

ownTest('actual worker pumps without polling, retains original seals through handoff and releases explicitly', async t => {
  const input = fixture(), worker = owner(t, input);
  await worker.start();
  // No status-driven pump calls exist; let the separate worker finish locally.
  await new Promise(resolve => setTimeout(resolve, 150));
  await worker.waitFor('extracted', 15000);
  const state = worker.status();
  assert.equal(state.worker.zipStatus.verifiedFiles, 1);
  assert.equal(state.worker.zipStatus.writtenBytes, input.value.total);
  const source = path.join(state.worker.workRoot, 'Extract/payload.bin');
  assert.throws(() => fs.openSync(source, 'r+'));
  held(worker.inspectIntent());
  await worker.handoff();
  const final = path.join(state.worker.workRoot, 'Final/payload.bin');
  assert.equal(digest(fs.readFileSync(final)), input.value.payload['payload.bin']);
  assert.throws(() => fs.openSync(final, 'r+'));
  const copied = worker.status();
  assert.equal(copied.worker.copiedFiles, 1);
  assert.equal(copied.nativeInstallAccepted, false);
  assert.equal(copied.worker.nativeInstallAccepted, false);
  assert.throws(() => worker.handoff(), /HANDOFF_REFUSED/);
  await worker.release();
  await worker.release(); // Re-observation, never another close/control write.
  assert.equal(worker.status().childClosed, true);
  assert.equal(worker.status().childExitCode, 0);
  fs.closeSync(fs.openSync(source, 'r+'));
  fs.closeSync(fs.openSync(final, 'r+'));
  held(worker.inspectIntent());
});

ownTest('bad CRC holds partial output; explicit cancellation preserves the original error and permits release', async t => {
  const input = fixture(100000, true), worker = owner(t, input);
  await worker.start();
  await worker.waitFor('held', 15000);
  const failure = worker.status().worker.errorCode;
  assert.match(failure, /CONTENT_MISMATCH/);
  assert.throws(() => worker.handoff(), /HANDOFF_REFUSED/);
  await assert.rejects(worker.release(), /RELEASE_REFUSED/);
  await worker.cancel();
  assert.equal(worker.status().phase, 'cancelled');
  assert.equal(worker.status().worker.errorCode, failure);
  await worker.release();
  held(worker.inspectIntent());
});

ownTest('passive observation timeout cannot restart or retire an active worker', async t => {
  const input = fixture(), worker = owner(t, input);
  await worker.start();
  await worker.waitFor('extracted', 15000);
  const identity = [worker.status().workerPid, worker.status().workerLifetime];
  await assert.rejects(worker.waitFor('copied', 10), /OBSERVATION_TIMEOUT/);
  assert.deepEqual([worker.status().workerPid, worker.status().workerLifetime], identity);
  assert.equal(worker.status().childClosed, false);
  await assert.rejects(worker.start(), /START_REFUSED/);
  await assert.rejects(worker.retireInert(), /RETIRE_ACTIVE_REFUSED/);
  await worker.handoff();
  await worker.release();
});

ownTest('a second coordinator instance cannot replay a released operation', async t => {
  const input = fixture(), first = owner(t, input);
  await first.start();
  await first.waitFor('extracted', 15000);
  await first.release();
  const replay = owner(t, input);
  await assert.rejects(replay.start(), /NATIVE_EXECUTOR_/);
  assert.equal(replay.status().startSent, false);
  await replay.retireInert();
  held(first.inspectIntent());
});

ownTest('archive bindings are detached and shared buffers cannot enter worker startup', async t => {
  const input = fixture(), bytes = Buffer.from(input.archive), worker = owner(t, { ...input, archive: bytes });
  bytes.fill(0);
  assert.equal(worker.status().startAttempted, false);
  assert.throws(() => createOwnedZipWorker(input.bytes, new Uint8Array(new SharedArrayBuffer(1024))), /INVALID_ARCHIVE/);
  await worker.start();
  await worker.waitFor('extracted', 15000);
  await worker.release();
});

ownTest('cancellation is delivered while the large START frame is still buffered', async t => captureChild(async current => {
  const input = fixture(1, false, 512), worker = owner(t, input);
  const startup = worker.start();
  await worker.waitFor('ready', 15000);
  assert.equal(worker.status().startSent, true);
  const child = current();
  assert.ok(child.stdin.writableLength > 0, 'Fixture must observe START backpressure');
  let unsent, cancellation;
  try {cancellation = worker.cancel();}
  catch (error) {unsent = error;}
  child.stdin.uncork();
  if (unsent) {
    // Fixture-only rescue: deliver the exact original cancellation after proving
    // the SDK refused it before writing. No new job, paths or retry of effects.
    child.stdin.write(JSON.stringify({schema: 'owned-zip-worker-control/1',
      workerLifetime: worker.status().workerLifetime, binding: worker.status().binding, command: 'cancel'})+'\n');
  }
  if (cancellation) await cancellation;
  await startup;
  await worker.waitFor('cancelled', 15000);
  assert.equal(worker.status().worker.copiedFiles, 0);
  assert.equal(worker.status().worker.zipStatus?.createdFiles ?? 0, 0);
  await worker.release();
  assert.equal(unsent, undefined, 'Cancellation was refused under START backpressure');
}, child => child.stdin.cork()));

ownTest('controller EOF retains actual custody until deliberate retirement of this exact held test process', async t => captureChild(async current => {
  const input = fixture(), worker = owner(t, input);
  await worker.start();
  await worker.waitFor('extracted', 15000);
  const child = current(), before = worker.status();
  const target = path.join(before.worker.workRoot, 'Extract/payload.bin');
  assert.equal(child.pid, before.workerPid);
  assert.equal(child.exitCode, null);
  child.stdin.end();
  await worker.waitFor('held', 15000);
  const quarantined = worker.status();
  assert.equal(quarantined.worker.errorCode, 'CONTROLLER_EOF');
  assert.equal(quarantined.childClosed, false);
  assert.throws(() => fs.openSync(target, 'r+'));
  await assert.rejects(worker.retireInert(), /RETIRE_ACTIVE_REFUSED/);
  held(worker.inspectIntent());
  // Failure-test retirement, only after the SAME live worker reports held and
  // quiescent. This is not an SDK restart, recovery or filesystem cleanup route.
  assert.equal(child.exitCode, null);
  assert.equal(child.kill('SIGTERM'), true);
  await worker.waitFor('closed', 15000);
  assert.equal(worker.status().errorCode, 'CUSTODY_LOST');
  fs.closeSync(fs.openSync(target, 'r+'));
  held(worker.inspectIntent());
  fs.writeFileSync(path.join(input.root, 'EOF-EVIDENCE.json'), JSON.stringify({before, quarantined,
    after: worker.status(), intent: worker.inspectIntent()}, null, 2));
}));

ownTest('actual guardian death loses HANDLE custody but preserves no-replay reservations', async t => captureChild(async current => {
  const input = fixture(), worker = owner(t, input);
  await worker.start();
  await worker.waitFor('extracted', 15000);
  const child = current(), before = worker.status();
  const target = path.join(before.worker.workRoot, 'Extract/payload.bin');
  assert.equal(child.pid, before.workerPid);
  assert.equal(child.exitCode, null);
  assert.throws(() => fs.openSync(target, 'r+'));
  assert.equal(child.kill('SIGTERM'), true);
  await worker.waitFor('closed', 15000);
  assert.equal(worker.status().errorCode, 'CUSTODY_LOST');
  assert.throws(() => worker.handoff(), /HANDOFF_REFUSED/);
  fs.closeSync(fs.openSync(target, 'r+'));
  held(worker.inspectIntent());
  const replay = owner(t, input);
  await assert.rejects(replay.start(), /NATIVE_EXECUTOR_/);
  assert.equal(replay.status().startSent, false);
  await replay.retireInert();
  fs.writeFileSync(path.join(input.root, 'CRASH-EVIDENCE.json'), JSON.stringify({before,
    after: worker.status(), intent: worker.inspectIntent(), refusedReplay: replay.status()}, null, 2));
}));

ownTest('native-root and decoder-subset preflight refuse unsupported inputs before spawning', async () => captureChild(async current => {
  const input = fixture();
  for (const parent of ['F:/Data/../Else', 'F:/Data/', 'F:/CONIN$/Data', 'F:/NAME~1/Data',
    'F:/'+Array(33).fill('part').join('/')]) {
    const archive = {...input.value.archive, parent};
    assert.throws(() => createOwnedZipWorker(input.bytes, Buffer.from(JSON.stringify(archive))), /INVALID_ARCHIVE/);
  }
  for (const name of ['r6/own~1.reds', 'r6/own!.reds']) {
    const request = structuredClone(input.request);
    request.plan.package.payload = {[name]: Object.values(input.value.payload)[0]};
    request.planId = job.installPlanId(request.plan);
    assert.throws(() => createOwnedZipWorker(Buffer.from(JSON.stringify(request)), input.archive), /UNSUPPORTED_PAYLOAD/);
  }
  assert.equal(current(), undefined);
}));

ownTest('release cannot use historical extracted state while handoff is pending', async t => {
  const input = fixture(), worker = owner(t, input);
  await worker.start();
  await worker.waitFor('extracted', 15000);
  const copying = worker.handoff();
  await assert.rejects(worker.release(), /RELEASE_REFUSED/);
  assert.equal(worker.status().releaseAttempted, false);
  await copying;
  await worker.release();
});

ownTest('malformed and stale raw controls quarantine custody instead of releasing it', async t => captureChild(async current => {
  for (const mode of ['stale', 'oversized', 'duplicate', 'nonfinite', 'unsupported']) {
    const input = fixture(), worker = owner(t, input);
    await worker.start();
    await worker.waitFor('extracted', 15000);
    const child = current(), state = worker.status();
    const target = path.join(state.worker.workRoot, 'Extract/payload.bin');
    const lifetime = state.workerLifetime;
    const wrong = lifetime.slice(0, -1)+(lifetime.endsWith('0') ? '1' : '0');
    const control = JSON.stringify({schema: 'owned-zip-worker-control/1',
      workerLifetime: mode === 'stale' ? wrong : lifetime, binding: state.binding,
      command: mode === 'unsupported' ? 'dispatch' : 'release'});
    const wire = mode === 'oversized' ? 'x'.repeat(4097)+'\n'
      : mode === 'duplicate' ? control.slice(0, -1)+',"command":"cancel"}\n'
      : mode === 'nonfinite' ? control.slice(0, -1)+',"extra":NaN}\n' : control+'\n';
    child.stdin.write(wire);
    await worker.waitFor('held', 15000);
    const expected = {stale: 'CONTROL_BINDING_MISMATCH', oversized: 'FRAME_LIMIT', duplicate: 'DUPLICATE_JSON',
      nonfinite: 'JSON_NUMBER_REFUSED', unsupported: 'CONTROL_REFUSED'};
    assert.equal(worker.status().worker.errorCode, expected[mode]);
    assert.equal(worker.status().childClosed, false);
    assert.throws(() => fs.openSync(target, 'r+'));
    assert.throws(() => worker.handoff(), /HANDOFF_REFUSED/);
    held(worker.inspectIntent());
    // Same explicit failure-test retirement as the EOF test, after actual hold.
    assert.equal(child.exitCode, null);
    assert.equal(child.kill('SIGTERM'), true);
    await worker.waitFor('closed', 15000);
    assert.equal(worker.status().errorCode, 'CUSTODY_LOST');
  }
}));

ownTest('a junction in the fixed scratch-base ancestor cannot receive a new directory', async t => {
  const input = fixture();
  const {clone, modules, foreign} = cloneSources(input);
  fs.symlinkSync(foreign, path.join(clone, 'local-state'), 'junction');
  const cloned = await import(pathToFileURL(path.join(modules, 'owned-zip-worker-client.mjs')).href);
  const worker = cloned.createOwnedZipWorker(input.bytes, input.archive);
  t.after(async () => {if (!worker.status().childClosed) await worker.retireInert();});
  const before = fs.readdirSync(foreign);
  await assert.rejects(worker.start(), /UNSAFE_SOURCE|UNSAFE_PATH|PATH_CHANGED/);
  assert.equal(worker.status().startSent, false);
  await worker.retireInert();
  assert.deepEqual(fs.readdirSync(foreign), before);
});


ownTest('source growth between size admission and open cannot cause an unbounded read', async t => captureChild(async current => {
  const input = fixture();
  const {modules} = cloneSources(input);
  const target = path.join(modules, 'owned-file-transfer.py');
  const cloned = await import(pathToFileURL(path.join(modules, 'owned-zip-worker-client.mjs')).href);
  const worker = cloned.createOwnedZipWorker(input.bytes, input.archive);
  t.after(async () => {if (!worker.status().childClosed) await worker.retireInert();});
  const lstat = fs.lstatSync, readFile = fs.readFileSync;
  let observed = 0, bytesRead = 0;
  fs.lstatSync = (file, ...args) => {
    const value = lstat(file, ...args);
    if (path.resolve(String(file)) === target && ++observed === 2)
      fs.appendFileSync(target, Buffer.alloc(1024*1024, 32));
    return value;
  };
  fs.readFileSync = (file, ...args) => {
    const value = readFile(file, ...args);
    if (path.resolve(String(file)) === target) bytesRead += value.length;
    return value;
  };
  try {await assert.rejects(worker.start(), /SOURCE_CHANGED|SOURCE_LIMIT/);}
  finally {fs.lstatSync = lstat; fs.readFileSync = readFile;}
  assert.equal(current(), undefined);
  assert.equal(worker.status().startSent, false);
  assert.equal(bytesRead, 0, 'Reject growth from opened-file metadata before allocating/reading the source');
}));


ownTest('native scratch creation refuses a junction inserted after coordinator preflight', async t => {
  const input = fixture();
  const {clone, modules, foreign} = cloneSources(input);
  const stateRoot = path.join(clone, 'local-state');
  const workBase = path.join(stateRoot, 'owned-zip-worker-work');
  const retained = path.join(clone, 'retained-local-state');
  fs.mkdirSync(stateRoot);
  const cloned = await import(pathToFileURL(path.join(modules, 'owned-zip-worker-client.mjs')).href);
  const worker = cloned.createOwnedZipWorker(input.bytes, input.archive);
  t.after(async () => {
    if (worker.status().childClosed) return;
    if (!worker.status().startSent) {await worker.retireInert(); return;}
    await worker.cancel(); await worker.release();
  });
  const original = fs.lstatSync;
  let swapped = false;
  fs.lstatSync = (file, ...args) => {
    try {return original(file, ...args);}
    catch (error) {
      if (String(file) === workBase && error.code === 'ENOENT' && !swapped) {
        assert(path.resolve(stateRoot).startsWith(path.resolve(input.root)+path.sep));
        assert(path.resolve(retained).startsWith(path.resolve(input.root)+path.sep));
        fs.renameSync(stateRoot, retained);
        fs.symlinkSync(foreign, stateRoot, 'junction');
        swapped = true;
      }
      throw error;
    }
  };
  try {await worker.start();}
  finally {fs.lstatSync = original;}
  await worker.waitFor('held', 15000);
  assert(swapped);
  assert.equal(worker.status().startSent, true);
  assert.match(worker.status().worker.errorCode, /OWNED_TRANSFER_/);
  assert.deepEqual(fs.readdirSync(foreign), []);
  await worker.cancel(); await worker.release();
});


ownTest('source growth during streaming reads remains capped at admitted size plus one', async t => captureChild(async current => {
  const input = fixture();
  const {modules} = cloneSources(input);
  const target = path.join(modules, 'owned-file-transfer.py');
  const admitted = fs.statSync(target).size;
  const cloned = await import(pathToFileURL(path.join(modules, 'owned-zip-worker-client.mjs')).href);
  const worker = cloned.createOwnedZipWorker(input.bytes, input.archive);
  t.after(async () => {if (!worker.status().childClosed) await worker.retireInert();});
  const open = fs.openSync, read = fs.readSync;
  let targetFd, grown = false, bytesRead = 0, maxRequest = 0;
  fs.openSync = (file, ...args) => {
    const fd = open(file, ...args);
    if (path.resolve(String(file)) === target && args[0] === 'r') targetFd = fd;
    return fd;
  };
  fs.readSync = (fd, buffer, offset, length, position) => {
    if (fd === targetFd) {
      if (!grown) {fs.appendFileSync(target, Buffer.alloc(1024*1024, 32)); grown = true;}
      maxRequest = Math.max(maxRequest, length);
    }
    const count = read(fd, buffer, offset, length, position);
    if (fd === targetFd) bytesRead += count;
    return count;
  };
  try {await assert.rejects(worker.start(), /SOURCE_CHANGED/);}
  finally {fs.openSync = open; fs.readSync = read;}
  assert(grown);
  assert.equal(current(), undefined);
  assert.equal(bytesRead, admitted+1);
  assert(maxRequest <= 64*1024);
  assert.equal(worker.status().startSent, false);
}));
