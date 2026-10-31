import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import vm from 'node:vm';
import {applyExact, hunks} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/node-7z-b75def8/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('error-close.json', base)));
const patch = readFileSync(new URL('error-close.patch', base), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePath = process.env.VORTEX_NODE_7Z_RUN;
const integration = (name, action) => test(name, {timeout: 5000,
  skip: sourcePath ? false : 'Set VORTEX_NODE_7Z_RUN to the exact independent util/run.js'}, action);
const tick = () => new Promise(resolve => setImmediate(resolve));
let cached;
function sources() {
  if (cached) return cached;
  const raw = readFileSync(sourcePath);
  assert.equal(hash(raw), manifest.inputSHA256);
  const original = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  const patched = applyExact(original, patch, manifest.upstreamPath);
  assert.equal(hash(patched), manifest.outputSHA256);
  return cached = {original, patched};
}
function load(source, spawnChild) {
  const module = {exports: {}};
  // Only lifecycle ordering is modeled with native Promise. No Bluebird package
  // is installed or claimed accepted by this source-backed fixture.
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {}, {timeout: 1000})(
    name => name === 'bluebird' ? Promise : name === 'child_process' ? {spawn: spawnChild}
      : name === 'os' ? {EOL: '\n'} : name === 'path' ? {} : name === './switches' ? (() => [])
        : assert.fail('Unexpected module'), module, module.exports);
  return module.exports;
}
function ownedChild(options = {}) {
  const child = new EventEmitter(), order = [], kills = [];
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  const on = child.on;
  child.on = function(name, action) {
    order.push(name);
    if (name === 'close' && Object.hasOwn(options, 'closeSetupError')) throw options.closeSetupError;
    return on.call(this, name, action);
  };
  child.kill = () => {
    kills.push(true);
    options.onKill?.(child);
    if (Object.hasOwn(options, 'killError')) throw options.killError;
    return options.killResult ?? true;
  };
  for (const stream of ['stdin', 'stdout', 'stderr']) {
    if (Object.hasOwn(options, stream + 'SetupError')) child[stream].on = () => {throw options[stream + 'SetupError'];};
  }
  return {child, order, kills};
}
function fixture(source, options = {}) {
  const owned = ownedChild(options), calls = [];
  const run = load(source, (...args) => {
    calls.push(args);
    if (Object.hasOwn(options, 'spawnError')) throw options.spawnError;
    return owned.child;
  });
  return {...owned, calls, run};
}
function observe(promise) {
  const status = {state: 'pending', settlements: 0};
  const done = promise.then(value => {Object.assign(status, {state: 'resolved', value}); status.settlements++;},
    error => {Object.assign(status, {state: 'rejected', error}); status.settlements++;});
  return {status, done};
}

test('exact node-7z patch retains source attribution and grants no native guarantees', () => {
  assert.equal(manifest.schema, 'native-source-patch/1');
  assert.equal(manifest.upstreamRepository, 'https://github.com/Nexus-Mods/node-7z');
  assert.equal(manifest.upstreamCommit, 'b75def8d0d7d81a03f4526c52b8ada9a34a06479');
  assert.equal(manifest.upstreamPath, 'util/run.js');
  assert.equal(manifest.originalSourceSHA256, '219ccdb78bc5bf6a5a82be4a2fb7772c87834b1532bc8fa431bcde289f3dd571');
  assert.equal(manifest.inputSHA256, manifest.originalSourceSHA256);
  assert.equal(manifest.upstreamLicense, 'ISC');
  assert.equal(manifest.upstreamLicenseSHA256, '25219a584599f047a3bf6e156ebb32162a37a0e76b057f5cf4b9286986403b63');
  assert.equal(manifest.licenseNormalization, 'Single terminal LF; legal text unchanged');
  assert.equal(hash(readFileSync(new URL(manifest.licenseFile, base))), manifest.licenseSHA256);
  assert.equal(manifest.patchSHA256, hash(patch)); assert.equal(manifest.preparedOnly, true);
  for (const key of ['installed', 'nativeAcceptanceVerified', 'nativeTerminalGuarantee', 'globalIdleGuarantee',
    'noReplacementGuarantee', 'importNoClobberGuarantee', 'ownerReservationGuarantee', 'installationPermit']) assert.equal(manifest[key], false);
  for (const hunk of hunks(patch, manifest.upstreamPath)) for (const line of hunk.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1), /[\t ]$/);
  assert(!patch.includes('\r'));
});

integration('baseline rejects progress failure early; patched source awaits exact child close', async () => {
  const error = Error('own fixture');
  for (const [name, source] of Object.entries(sources())) {
    const f = fixture(source), result = observe(f.run('fixed', [], [], () => {throw error;}));
    f.child.stdout.emit('data', Buffer.from('data')); await tick();
    assert.equal(result.status.state, name === 'original' ? 'rejected' : 'pending');
    assert.equal(f.kills.length, 1);
    f.child.emit('close', null); await result.done;
    assert.equal(result.status.state, 'rejected'); assert.equal(result.status.error, error);
  }
});

integration('stdout conversion and stderr conversion failures wait for close', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const error = Error(stream), f = fixture(sources().patched);
    const result = observe(f.run('fixed', [], []));
    f.child[stream].emit('data', {toString() {throw error;}}); await tick();
    assert.equal(result.status.state, 'pending'); assert.equal(f.kills.length, 1);
    f.child.emit('close', 2); await result.done; assert.equal(result.status.error, error);
  }
});

integration('all exact child stdio error events preserve first values and wait for close', async () => {
  for (const stream of ['stdin', 'stdout', 'stderr']) for (const first of [undefined, null, 'STREAM_FAILURE', Error(stream)]) {
    const f = fixture(sources().patched), result = observe(f.run('fixed', [], []));
    f.child[stream].emit('error', first);
    for (const later of ['stdin', 'stdout', 'stderr']) f.child[later].emit('error', Error('later'));
    await tick(); assert.equal(result.status.state, 'pending'); assert.equal(f.kills.length, 1);
    f.child.emit('close', null); await result.done;
    assert.equal(result.status.state, 'rejected'); assert.equal(result.status.error, first);
  }
});

integration('all stdio error observers exist before a data observer can trigger reentrant output', async () => {
  const first = Error('reentrant stderr during data registration'), f = fixture(sources().patched);
  const on = f.child.stdout.on;
  f.child.stdout.on = function(name, action) {
    if (name === 'data') f.child.stderr.emit('error', first);
    return on.call(this, name, action);
  };
  const result = observe(f.run('fixed', [], [])); await tick();
  assert.equal(result.status.state, 'pending'); assert.equal(f.kills.length, 1);
  f.child.emit('close', 1); await result.done; assert.equal(result.status.error, first);
});

integration('stdin EPIPE while the child is alive cannot start caller cleanup before close', async () => {
  const f = fixture(sources().patched), first = Object.assign(Error('own stdin fixture'), {code: 'EPIPE'});
  let cleanup = false;
  const result = observe(f.run('fixed', [], []).finally(() => {cleanup = true;}));
  f.child.stdin.emit('error', first); f.child.emit('exit', 1); await tick();
  assert.equal(result.status.state, 'pending'); assert.equal(cleanup, false);
  f.child.emit('close', 1); await result.done;
  assert.equal(result.status.error, first); assert.equal(cleanup, true);
});

integration('undefined, null and non-Error first failures survive later errors and kill throws', async () => {
  for (const first of [undefined, null, 'FIRST_FAILURE', Error('first')]) {
    const f = fixture(sources().patched, {killError: Error('kill failure')});
    const result = observe(f.run('fixed', [], [], () => {throw first;}));
    f.child.stdout.emit('data', Buffer.from('first'));
    f.child.emit('error', Error('later'));
    f.child.stderr.emit('data', {toString() {throw Error('late stderr');}});
    await tick(); assert.equal(result.status.state, 'pending'); assert.equal(f.kills.length, 1);
    f.child.emit('close', 1); await result.done;
    assert.equal(result.status.state, 'rejected'); assert.equal(result.status.error, first);
  }
});

integration('kill false and synchronous child error/close cannot mask failure or recurse', async () => {
  const first = Error('first');
  for (const options of [{killResult: false}, {onKill: child => child.emit('error', Error('kill emitted'))},
    {onKill: child => child.emit('close', null)}]) {
    const f = fixture(sources().patched, options), result = observe(f.run('fixed', [], [], () => {throw first;}));
    f.child.stdout.emit('data', Buffer.from('start')); await tick();
    assert.equal(f.kills.length, 1);
    if (result.status.state === 'pending') f.child.emit('close', null);
    await result.done; assert.equal(result.status.error, first); assert.equal(result.status.settlements, 1);
  }
});

integration('child error before output waits for close and exit alone is insufficient', async () => {
  const first = Error('spawn emitted error'), f = fixture(sources().patched);
  const result = observe(f.run('fixed', [], []));
  f.child.emit('error', first); f.child.emit('exit', 1); await tick();
  assert.equal(result.status.state, 'pending');
  f.child.emit('close', 1); await result.done; assert.equal(result.status.error, first);
});

integration('output after failure drains without callbacks; events after close are inert', async () => {
  let calls = 0;
  const first = Error('first'), f = fixture(sources().patched);
  const result = observe(f.run('fixed', [], [], () => {calls++; throw first;}));
  f.child.stdout.emit('data', Buffer.from('first'));
  f.child.stdout.emit('data', Buffer.from('late')); f.child.stderr.emit('data', Buffer.from('late'));
  f.child.emit('close', 7); await result.done;
  f.child.emit('error', Error('after close')); f.child.stdout.emit('data', Buffer.from('after close'));
  f.child.emit('close', 0); await tick();
  assert.equal(calls, 1); assert.equal(f.kills.length, 1); assert.equal(result.status.error, first);
  assert.equal(result.status.settlements, 1); assert.equal(f.order[0], 'close');
});

integration('post-spawn stdio-listener setup failure retains child until observed close', async () => {
  for (const stream of ['stdin', 'stdout', 'stderr']) {
    const first = Error(stream + ' registration'), f = fixture(sources().patched, {[stream + 'SetupError']: first});
    const result = observe(f.run('fixed', [], [])); await tick();
    assert.equal(f.calls.length, 1); assert.equal(f.kills.length, 1); assert.equal(result.status.state, 'pending');
    f.child.emit('close', 1); await result.done; assert.equal(result.status.error, first);
  }
});

integration('unobservable close registration failure stays held instead of claiming child termination', async () => {
  const f = fixture(sources().patched, {closeSetupError: Error('fixture registration')});
  const result = observe(f.run('fixed', [], [])); await tick();
  assert.equal(f.kills.length, 1); assert.equal(result.status.state, 'pending');
  f.child.emit('close', 1); await tick(); assert.equal(result.status.state, 'pending');
});

integration('synchronous spawn failure has no returned child to join and preserves its error', async () => {
  for (const error of [undefined, null, Error('spawn failed')]) {
    const f = fixture(sources().patched, {spawnError: error}), result = observe(f.run('fixed', [], []));
    await result.done; assert.equal(result.status.state, 'rejected'); assert.equal(result.status.error, error);
    assert.equal(f.kills.length, 0);
  }
});

integration('success, nonzero and null close codes preserve legacy error-array resolution', async () => {
  for (const code of [0, 2, null]) {
    const f = fixture(sources().patched), progress = [], result = observe(f.run('fixed', [], [], output => progress.push(output)));
    f.child.stdout.emit('data', Buffer.from('own progress'));
    f.child.stderr.emit('data', Buffer.from('own diagnostic'));
    f.child.emit('close', code); await result.done;
    assert.equal(result.status.state, 'resolved'); assert.equal(result.status.value.code, code);
    assert.deepEqual(Array.from(result.status.value.errors), ['own diagnostic']);
    assert.deepEqual(progress, ['own progress']); assert.equal(f.kills.length, 0);
    f.child.emit('error', Error('after success')); f.child.stdout.emit('data', Buffer.from('after close'));
    assert.equal(f.kills.length, 0); assert.equal(progress.length, 1);
  }
});

integration('legacy cancellation resolves on close, with no invented cancellation error', async () => {
  for (const source of [sources().original, sources().patched]) {
    const f = fixture(source), result = observe(f.run('fixed', [], [], (_out, _unused, _stdin, cancel) => cancel()));
    f.child.stdout.emit('data', Buffer.from('cancel')); await tick(); assert.equal(result.status.state, 'pending');
    f.child.emit('close', null); await result.done;
    assert.equal(result.status.state, 'resolved'); assert.equal(result.status.value.code, null); assert.equal(f.kills.length, 1);
  }
});

integration('synchronous progress-triggered cancel kill exception waits for close with one kill request', async () => {
  const first = Error('cancel kill'), f = fixture(sources().patched, {killError: first});
  const result = observe(f.run('fixed', [], [], (_out, _unused, _stdin, cancel) => cancel()));
  f.child.stdout.emit('data', Buffer.from('cancel')); await tick();
  assert.equal(result.status.state, 'pending'); assert.equal(f.kills.length, 1);
  f.child.emit('close', null); await result.done; assert.equal(result.status.error, first);
});

integration('asynchronous captured cancellation latches a kill exception and joins close', async () => {
  for (const first of [undefined, null, Error('asynchronous cancel kill')]) {
    let cancel;
    const f = fixture(sources().patched, {killError: first});
    const result = observe(f.run('fixed', [], [], (_out, _unused, _stdin, action) => {cancel = action;}));
    f.child.stdout.emit('data', Buffer.from('password prompt')); await tick();
    assert.equal(typeof cancel, 'function');
    // Password-handler rejection invokes cancel later, outside feedStdout's try.
    await Promise.resolve().then(() => cancel()); await tick();
    assert.equal(result.status.state, 'pending'); assert.equal(f.kills.length, 1);
    f.child.emit('close', null); await result.done;
    assert.equal(result.status.state, 'rejected'); assert.equal(result.status.error, first);
  }
});

integration('stdio errors after successful close are handled but cannot kill or alter outcome', async () => {
  const f = fixture(sources().patched), result = observe(f.run('fixed', [], []));
  f.child.emit('close', 0); await result.done;
  for (const stream of ['stdin', 'stdout', 'stderr']) f.child[stream].emit('error', Error('late stream'));
  await tick(); assert.equal(f.kills.length, 0); assert.equal(result.status.state, 'resolved');
  assert.equal(result.status.value.code, 0); assert.equal(result.status.settlements, 1);
});

integration('captured password-style cancellation after close cannot kill again or change outcome', async () => {
  let cancel;
  const f = fixture(sources().patched);
  const result = observe(f.run('fixed', [], [], (_out, _unused, _stdin, action) => {cancel = action;}));
  f.child.stdout.emit('data', Buffer.from('password callback captured'));
  f.child.emit('close', 0); await result.done;
  assert.equal(typeof cancel, 'function'); cancel(); await tick();
  assert.equal(f.kills.length, 0); assert.equal(result.status.state, 'resolved');
  assert.equal(result.status.value.code, 0); assert.equal(result.status.settlements, 1);
});

integration('separate child close observations cannot settle another invocation', async () => {
  const first = fixture(sources().patched), second = fixture(sources().patched);
  const a = observe(first.run('fixed', [], [])), b = observe(second.run('fixed', [], []));
  first.child.emit('error', Error('first')); second.child.emit('close', 0); await b.done;
  assert.equal(a.status.state, 'pending'); assert.equal(b.status.state, 'resolved');
  first.child.emit('close', 1); await a.done; assert.equal(a.status.state, 'rejected');
});

integration('real own Node child is joined after progress failure before caller cleanup', async t => {
  let child, closeObserved = false;
  const first = Error('own real child progress');
  const run = load(sources().patched, () => {
    child = spawn(process.execPath, ['-e', 'process.stdout.write("owned fixture\\n");setInterval(()=>{},1000)'],
      {env: {}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    child.once('close', () => {closeObserved = true;});
    return child;
  });
  t.after(() => {if (child && !closeObserved) child.kill();});
  await assert.rejects(run('fixed-own-child', [], [], () => {throw first;}), error => error === first);
  assert.equal(closeObserved, true); assert(child.exitCode !== null || child.signalCode !== null);
});
