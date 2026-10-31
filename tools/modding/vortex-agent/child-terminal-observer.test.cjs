'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn, ChildProcess} = require('node:child_process');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {observeChildTerminal, copyChildBinding} = require('./child-terminal-observer.cjs');
const NativePromise = Promise;
const tick = () => new NativePromise(resolve => setImmediate(resolve));
const binding = n => ({operationId: 'op_' + String(n).padStart(32, '0'), nativeJobId: 'exec_' + String(n).padStart(32, '0'),
  requestSHA256: 'a'.repeat(64), rendererGeneration: 'renderer_' + 'b'.repeat(32)});
function bounded(promise, ms = 2000) {
  let timer;
  return NativePromise.race([promise, new NativePromise((_, reject) => {
    timer = setTimeout(() => reject(Error('OWN_CHILD_DEADLINE')), ms);
  })]).finally(() => clearTimeout(timer));
}
function own(t, script, options = {}) {
  const child = spawn(options.command ?? process.execPath, options.command ? [] : ['-e', script],
    {env: {}, windowsHide: true, stdio: options.stdio ?? ['pipe', 'pipe', 'pipe']});
  let closed = false;
  const done = new NativePromise(resolve => child.once('close', (...values) => {closed = true; resolve(values);}));
  child.on('error', () => {}); // Test owner independently retains lifecycle cleanup responsibility.
  t.after(async () => {
    // Adversarial tests may emit fake exit/close events. Cleanup must use actual
    // ChildProcess/native-stream properties, never those event-derived flags.
    const active = child.exitCode === null && child.signalCode === null;
    const waiters = [];
    if (active) waiters.push(new NativePromise(resolve => child.once('close', resolve)));
    for (const stream of child.stdio) {
      if (stream && !stream.closed) waiters.push(new NativePromise(resolve => stream.once('close', resolve)));
    }
    if (active) child.kill();
    await bounded(NativePromise.all(waiters));
    assert(child.exitCode !== null || child.signalCode !== null);
    assert(child.stdio.every(stream => !stream || stream.closed));
  });
  // Owner cleanup is registered before admission, so a producer exception cannot
  // orphan the already spawned fixture. No await occurs before attachment.
  const observer = options.observe === false ? null : observeChildTerminal(child, binding(options.id ?? 1));
  return {child, observer, done, get closed() {return closed;}};
}
function drain(child) {child.stdout?.resume(); child.stderr?.resume(); child.stdin?.end();}

test('pure binding copy validates before any child or filesystem effect', () => {
  const input = binding(1), copy = copyChildBinding(input);
  assert(Object.isFrozen(copy)); input.requestSHA256 = 'c'.repeat(64);
  assert.equal(copy.requestSHA256, 'a'.repeat(64));
  assert.throws(() => copyChildBinding({...binding(1), extra: true}), /INVALID_BINDING/);
});

test('real clean child waits for its close and all three observed pipe closes', {timeout: 5000}, async t => {
  const f = own(t, 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))');
  const initial = f.observer.read();
  assert.equal(initial.childResourcesClosed, false); assert(Object.isFrozen(initial));
  assert(Object.isFrozen(initial.pipes.stdin)); assert(Object.isFrozen(initial.binding));
  const closeSnapshots = [];
  f.child.on('close', () => closeSnapshots.push(f.observer.read()));
  drain(f.child); await bounded(f.done); await tick();
  const final = f.observer.read();
  assert.equal(final.childResourcesClosed, true); assert.equal(final.outcome, 'exited');
  assert.equal(final.exitSucceeded, true); assert.equal(final.exitCode, 0);
  for (const value of closeSnapshots) {
    const all = Object.values(value.pipes).every(pipe => pipe.closeObserved);
    assert.equal(value.childResourcesClosed, value.closeObserved && value.exitObserved && all && !value.held);
  }
  assert.equal(initial.childResourcesClosed, false, 'old snapshots never mutate');
  assert.deepEqual(Object.keys(f.observer), ['read']);
  for (const key of ['nativeInstallAccepted', 'persistenceVerified', 'descendantsVerified']) assert.equal(final[key], false);
});

test('nonzero exit is resource closure, independently of successful exit', {timeout: 5000}, async t => {
  const f = own(t, 'process.exit(7)'); drain(f.child); await bounded(f.done); await tick();
  const state = f.observer.read();
  assert.equal(state.childResourcesClosed, true, JSON.stringify(state)); assert.equal(state.exitSucceeded, false);
  assert.equal(state.exitCode, 7); assert.equal(state.closeCode, 7);
});

test('actual SIGTERM request is not closure until native child and all pipes close', {timeout: 5000}, async t => {
  const f = own(t, 'process.stdin.resume()');
  await bounded(new NativePromise(resolve => f.child.once('spawn', resolve)));
  f.child.stdout.resume(); f.child.stderr.resume();
  const pipesClosed = f.child.stdio.map(stream => new NativePromise(resolve => stream.once('close', resolve)));
  assert.equal(f.child.kill('SIGTERM'), true);
  assert.equal(f.observer.read().childResourcesClosed, false);
  await bounded(NativePromise.all([f.done, ...pipesClosed]));
  const state = f.observer.read();
  assert.equal(state.childResourcesClosed, true, JSON.stringify(state)); assert.equal(state.exitSucceeded, false);
  assert.equal(state.exitCode, null); assert.equal(state.closeCode, null);
  assert.equal(state.exitSignal, 'SIGTERM'); assert.equal(state.closeSignal, 'SIGTERM');
});

test('actual spawn failure records error, close and pipes without inventing exit', {timeout: 5000}, async t => {
  const command = path.resolve(__dirname, '../../../local-state/install-contract-20261031',
    'missing-child-terminal-' + crypto.randomBytes(16).toString('hex') + '.exe');
  assert.equal(fs.existsSync(command), false);
  const f = own(t, '', {command});
  drain(f.child); await bounded(f.done); await tick();
  const state = f.observer.read();
  assert.equal(state.childErrorObserved, true); assert.equal(state.childErrorCode, 'ENOENT');
  assert.equal(state.spawnObserved, false); assert.equal(state.exitObserved, false);
  assert.equal(state.childResourcesClosed, true); assert.equal(state.outcome, 'spawnFailed');
  assert.equal(state.exitSucceeded, false);
});

test('delayed stdin and output draining cannot become an early terminal claim', {timeout: 5000}, async t => {
  const f = own(t, 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(Buffer.alloc(1048576),()=>process.exit(0)))');
  await bounded(new NativePromise(resolve => f.child.once('spawn', resolve)));
  assert.equal(f.observer.read().spawnObserved, true); assert.equal(f.observer.read().childResourcesClosed, false);
  f.child.stdin.end(); await tick(); assert.equal(f.observer.read().childResourcesClosed, false);
  f.child.stdout.resume(); f.child.stderr.resume(); await bounded(f.done); await tick();
  assert.equal(f.observer.read().childResourcesClosed, true);
});

test('late adoption after spawn is not reconstructed from a still-running PID', {timeout: 5000}, async t => {
  const f = own(t, 'process.stdin.resume()', {observe: false});
  await bounded(new NativePromise(resolve => f.child.once('spawn', resolve)));
  const observer = observeChildTerminal(f.child, binding(1));
  drain(f.child); await bounded(f.done); await tick();
  const state = observer.read();
  assert.equal(state.spawnObserved, false); assert.equal(state.held, true); assert.equal(state.childResourcesClosed, false);
});

test('already closed child remains permanently held', {timeout: 5000}, async t => {
  const f = own(t, 'process.exit(0)', {observe: false}); drain(f.child); await bounded(f.done); await tick();
  const state = observeChildTerminal(f.child, binding(1)).read();
  assert.equal(state.held, true); assert.equal(state.reasonCode, 'LATE_ADOPTION');
  assert.equal(state.childResourcesClosed, false);
});

test('binding is detached, closed and getter/proxy-free; duplicate children refuse', {timeout: 5000}, async t => {
  const f = own(t, 'process.stdin.resume()', {observe: false});
  let invoked = 0;
  for (const input of [null, [], {}, {...binding(1), extra: true}, {...binding(1), operationId: 'wrong'},
    new Proxy({}, {getPrototypeOf() {invoked++; throw Error('trap');}}),
    Object.defineProperty({...binding(1)}, 'nativeJobId', {get() {invoked++; throw Error('getter');}})]) {
    assert.throws(() => observeChildTerminal(f.child, input), /INVALID_BINDING/);
  }
  for (const key of Object.keys(binding(1))) for (const suffix of ['\n', '\r', '\r\n', '\x00']) {
    const input = binding(1); input[key] += suffix;
    assert.throws(() => observeChildTerminal(f.child, input), /INVALID_BINDING/);
  }
  assert.equal(invoked, 0);
  const input = binding(1), observer = observeChildTerminal(f.child, input);
  input.requestSHA256 = 'c'.repeat(64);
  assert.equal(observer.read().binding.requestSHA256, 'a'.repeat(64));
  assert.throws(() => observeChildTerminal(f.child, binding(1)), /ALREADY_OBSERVED/);
  assert.throws(() => observeChildTerminal(f.child, binding(2)), /BINDING_MISMATCH/);
  drain(f.child); await bounded(f.done);
});

test('plain event emitters, unspawned objects and non-piped/extra stdio are refused', {timeout: 5000}, async t => {
  assert.throws(() => observeChildTerminal({}, binding(1)), /INVALID_CHILD/);
  assert.throws(() => observeChildTerminal(new EventEmitter(), binding(1)), /INVALID_CHILD/);
  assert.throws(() => observeChildTerminal(new ChildProcess(), binding(1)), /INVALID_PIPES/);
  for (const stdio of ['ignore', ['pipe', 'pipe', 'pipe', 'pipe']]) {
    const f = own(t, 'process.exit(0)', {stdio, observe: false});
    assert.throws(() => observeChildTerminal(f.child, binding(1)), /INVALID_PIPES/);
    drain(f.child); await bounded(f.done);
  }
});

test('diagnostics are bounded and late pipe errors do not resurrect closed resources', {timeout: 5000}, async t => {
  const f = own(t, 'process.exit(0)'); drain(f.child); await bounded(f.done); await tick();
  let invoked = 0;
  f.child.stdin.emit('error', Object.defineProperty(Error('private'), 'code', {get() {invoked++; throw Error('secret');}}));
  f.child.stdout.emit('error', Object.assign(Error('private'), {code: 'EPIPE'}));
  f.child.stderr.emit('error', Object.assign(Error('private'), {code: 'X'.repeat(10000)}));
  const state = f.observer.read();
  assert.equal(invoked, 0); assert.equal(state.childResourcesClosed, true);
  assert.equal(state.pipes.stdin.errorCode, 'STREAM_ERROR'); assert.equal(state.pipes.stdout.errorCode, 'EPIPE');
  assert.equal(state.pipes.stderr.errorCode, 'STREAM_ERROR');
  assert(!JSON.stringify(state).includes('private')); assert(JSON.stringify(state).length < 2200);
});

test('in-process contradictory events hold rather than minting a terminal proof', {timeout: 5000}, async t => {
  // This is adversarial event-order testing, not a claim that public Node emit()
  // is an OS-authenticated channel against hostile code inside the same process.
  const f = own(t, 'process.stdin.resume()');
  await bounded(new NativePromise(resolve => f.child.once('spawn', resolve)));
  f.child.emit('exit', 0, null); f.child.emit('close', 8, null);
  const state = f.observer.read();
  assert.equal(state.held, true); assert.equal(state.childResourcesClosed, false);
  drain(f.child); await bounded(f.done); await tick();
  assert.equal(f.observer.read().childResourcesClosed, false);
});

test('signal and diagnostic tokens reject terminal newline and control suffixes', {timeout: 5000}, async t => {
  for (const suffix of ['\n', '\r', '\r\n', '\x00']) {
    const f = own(t, 'process.stdin.resume()');
    await bounded(new NativePromise(resolve => f.child.once('spawn', resolve)));
    f.child.stderr.emit('error', Object.assign(Error('not serialized'), {code: 'EPIPE' + suffix}));
    assert.equal(f.observer.read().pipes.stderr.errorCode, 'STREAM_ERROR');
    f.child.emit('exit', null, 'SIGTERM' + suffix);
    const state = f.observer.read();
    assert.equal(state.held, true); assert.equal(state.reasonCode, 'INVALID_EXIT');
    assert.equal(state.childResourcesClosed, false);
    drain(f.child); await bounded(f.done);
  }
});

test('all error listeners precede phase registration; reentrant attachment events stay held', {timeout: 5000}, async t => {
  const f = own(t, 'process.stdin.resume()', {observe: false});
  f.child.on('newListener', name => {
    if (name === 'spawn') f.child.stdin.emit('error', Object.assign(Error('private'), {code: 'EPIPE'}));
  });
  const observer = observeChildTerminal(f.child, binding(1));
  assert.equal(observer.read().held, true); assert.equal(observer.read().reasonCode, 'EVENT_DURING_ATTACHMENT');
  assert.equal(observer.read().pipes.stdin.errorCode, 'EPIPE');
  drain(f.child); await bounded(f.done); await tick();
  assert.equal(observer.read().childResourcesClosed, false);
});

test('production observer never uses the replaceable global Promise', {timeout: 5000}, async t => {
  const previous = global.Promise;
  let f;
  try {
    global.Promise = function Forbidden() {throw Error('GLOBAL_PROMISE_USED');};
    f = own(t, 'process.exit(0)'); drain(f.child); await bounded(f.done); await tick();
    assert.equal(f.observer.read().childResourcesClosed, true);
  } finally {global.Promise = previous;}
});

const bluebirdRoot = process.env.VORTEX_BLUEBIRD_ROOT;
test('reviewed installed Bluebird cancellation settles its wrapper before native child closure',
  {timeout: 5000, skip: bluebirdRoot ? false : 'Set VORTEX_BLUEBIRD_ROOT to the independently pinned installed snapshot'}, async t => {
    const root = path.resolve(bluebirdRoot);
    for (let node = root;; node = path.dirname(node)) {
      const stat = fs.lstatSync(node); assert(stat.isDirectory() && !stat.isSymbolicLink());
      if (node === path.dirname(node)) break;
    }
    const source = fs.readFileSync(path.join(root, 'SOURCE-PINS.json'));
    const pins = JSON.parse(source);
    assert.equal(pins.version, '3.7.2'); assert.equal(pins.files.length, 39);
    const rows = pins.files.map(row => ({file: row.file, bytes: row.bytes, sha256: row.sha256}))
      .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    assert.equal(crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'), 'a1279d5bda68eae7063b8d282f9c4665f15039dbd20b66826d4eb9cb3f2ff1a8');
    for (const row of rows) {
      assert(/^(?:LICENSE|package\.json|js\/release\/[a-z0-9_]+\.js)$/.test(row.file));
      const file = path.join(root, row.file), stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink());
      const bytes = fs.readFileSync(file); assert.equal(bytes.length, row.bytes);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), row.sha256);
    }
    const allowed = new Set(rows.map(row => path.join(root, row.file)));
    for (const cached of Object.keys(require.cache)) assert(!allowed.has(cached), 'independently verified fixture must load fresh');
    const Bluebird = require(path.join(root, 'js/release/bluebird.js')).getNewLibraryCopy();
    Bluebird.config({cancellation: true});
    const f = own(t, 'process.stdin.resume()');
    let finallyState;
    const wrapper = new Bluebird(() => {}).finally(() => {finallyState = f.observer.read();});
    wrapper.cancel(); await bounded(new NativePromise(resolve => setTimeout(resolve, 20)));
    assert(finallyState); assert.equal(finallyState.childResourcesClosed, false);
    drain(f.child); await bounded(f.done); await tick();
    assert.equal(f.observer.read().childResourcesClosed, true);
  });
