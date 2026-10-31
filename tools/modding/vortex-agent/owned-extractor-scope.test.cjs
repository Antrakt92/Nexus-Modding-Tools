'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const scope = require('./owned-extractor-scope.cjs');
const NativePromise = Promise;
const base = path.join(__dirname, 'native-patches/node-7z-b75def8');
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'owned-factory.json')));
const sourceRoot = process.env.VORTEX_NODE_7Z_RUN && path.dirname(path.dirname(process.env.VORTEX_NODE_7Z_RUN));
const bluebirdRoot = process.env.VORTEX_BLUEBIRD_ROOT;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const binding = n => ({operationId: 'op_' + String(n).padStart(32, '0'), nativeJobId: 'exec_' + String(n).padStart(32, '0'),
  requestSHA256: 'a'.repeat(64), rendererGeneration: 'renderer_' + 'b'.repeat(32)});
const spec = n => ({archivePath: `F:\\Owned Fixture\\archive${n}.zip`, destinationPath: `F:\\Owned Fixture\\target${n}`});
const options = () => ({ssc: false});
const tick = () => new NativePromise(resolve => setImmediate(resolve));
function bounded(promise, ms = 2500) {
  let timer;
  return NativePromise.race([promise, new NativePromise((_, reject) => {
    timer = setTimeout(() => reject(Error('OWNED_FIXTURE_DEADLINE')), ms);
  })]).finally(() => clearTimeout(timer));
}
const integration = (name, action) => test(name, {timeout: 10000,
  skip: sourceRoot && bluebirdRoot ? false : 'Set VORTEX_NODE_7Z_RUN and canonical VORTEX_BLUEBIRD_ROOT to the independently pinned source fixtures'}, action);
function checkedBluebird() {
  const root = path.resolve(bluebirdRoot);
  for (let node = root;; node = path.dirname(node)) {
    const stat = fs.lstatSync(node); assert(stat.isDirectory() && !stat.isSymbolicLink());
    if (node === path.dirname(node)) break;
  }
  const pins = JSON.parse(fs.readFileSync(path.join(root, 'SOURCE-PINS.json')));
  assert.equal(pins.version, '3.7.2'); assert.equal(pins.files.length, 39);
  const rows = pins.files.map(row => ({file: row.file, bytes: row.bytes, sha256: row.sha256}))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  assert.equal(hash(JSON.stringify(rows)), 'a1279d5bda68eae7063b8d282f9c4665f15039dbd20b66826d4eb9cb3f2ff1a8');
  for (const row of rows) {
    assert(/^(?:LICENSE|package\.json|js\/release\/[a-z0-9_]+\.js)$/.test(row.file));
    const file = path.join(root, row.file), stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink());
    const bytes = fs.readFileSync(file); assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256);
  }
  return require(path.join(root, 'js/release/bluebird.js')).getNewLibraryCopy();
}
let capturedSources;
async function sources() {
  if (capturedSources) return capturedSources;
  const {applyExact} = await import('./native-patch-test-fixture.mjs');
  const original = {};
  for (const row of manifest.sourceFiles) {
    const bytes = fs.readFileSync(path.join(sourceRoot, row.path));
    assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256);
    original[row.path] = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  }
  assert.equal(hash(original['util/run.js']), '219ccdb78bc5bf6a5a82be4a2fb7772c87834b1532bc8fa431bcde289f3dd571');
  const prepared = {...original};
  prepared['util/run.js'] = applyExact(prepared['util/run.js'], fs.readFileSync(path.join(base, 'error-close.patch'), 'utf8'), 'util/run.js');
  assert.equal(hash(prepared['util/run.js']), manifest.prerequisiteOutputSHA256);
  for (const row of manifest.files) {
    const patch = fs.readFileSync(path.join(base, row.patch), 'utf8');
    assert.equal(hash(prepared[row.path]), row.inputSHA256); assert.equal(hash(patch), row.patchSHA256);
    prepared[row.path] = applyExact(prepared[row.path], patch, row.path);
    assert.equal(hash(prepared[row.path]), row.outputSHA256);
  }
  return capturedSources = {original, prepared};
}
async function sdk(t, config = {}) {
  const captured = await sources(), code = config.legacy ? captured.original : captured.prepared;
  const Bluebird = checkedBluebird(); Bluebird.config({cancellation: true});
  const calls = [], children = [], cache = new Map();
  t.after(async () => {
    for (const record of children) {
      const child = record.child, active = child.exitCode === null && child.signalCode === null, waits = [];
      if (active) waits.push(new NativePromise(resolve => child.once('close', resolve)));
      for (const stream of child.stdio) if (stream && !stream.closed) waits.push(new NativePromise(resolve => stream.once('close', resolve)));
      if (active) child.kill();
      await bounded(NativePromise.all(waits));
      assert(child.stdio.every(stream => !stream || stream.closed));
    }
  });
  const childProcess = {spawn(command, args, spawnOptions) {
    calls.push({command, args: Array.from(args), options: spawnOptions});
    assert.equal(command, process.execPath, 'fixture replaces only the fixed 7z-bin resolver');
    if (config.spawnThrow) throw config.spawnThrow;
    const script = config.script ?? 'process.stdout.write("- owned fixture\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0))';
    // Only the fixed own Node fixture is launched, never 7z, Vortex or game code.
    const child = spawn(process.execPath, ['-e', script], {env: {}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    child.on('error', () => {});
    const closed = new NativePromise(resolve => child.once('close', resolve));
    const pipes = child.stdio.map(stream => new NativePromise(resolve => stream.once('close', resolve)));
    const record = {child, done: NativePromise.all([closed, ...pipes])}; children.push(record);
    config.afterSpawn?.(child);
    return child;
  }};
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = {exports: {}}; cache.set(file, module);
    if (!Object.hasOwn(code, file)) {
      assert(/^lib\/(?:add|delete|extract|list|test|update)\.js$/.test(file));
      module.exports = () => {throw Error('UNUSED_LEGACY_METHOD');}; return module.exports;
    }
    const requireFixture = name => {
      if (name === '7z-bin') return process.execPath;
      if (name === 'bluebird') return Bluebird;
      if (name === 'child_process') return childProcess;
      if (name.endsWith('owned-extractor-scope.cjs')) return scope;
      if (['os', 'path'].includes(name)) return require(name);
      assert(name.startsWith('.'), 'unexpected SDK dependency');
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
      return load(next.endsWith('.js') ? next : next + '.js');
    };
    vm.runInThisContext('(function(require,module,exports){' + code[file] + '\n})', {filename: 'pinned-node-7z/' + file})(requireFixture, module, module.exports);
    return module.exports;
  }
  const Zip = load('lib/index.js');
  return {Zip, Bluebird, calls, children, load,
    async finish(n = children.length - 1) {
      const record = children[n]; record.child.stdin.end(); await bounded(record.done); await tick();
    }};
}

test('owner creation is detached data, fixed Windows tuple and no native permit', () => {
  const input = spec(1), bind = binding(1), owner = scope.createChildOwner(bind, input);
  input.archivePath = 'changed'; bind.requestSHA256 = 'changed';
  assert(Object.isFrozen(owner)); assert.equal(Object.getPrototypeOf(owner), null);
  assert.deepEqual(Object.keys(owner).sort(), ['cancel', 'read', 'seal']);
  assert.equal(owner.read().binding.requestSHA256, 'a'.repeat(64));
  assert.equal(owner.read().attempts, 0); assert.equal(owner.read().allChildrenResourcesClosed, false);
  assert.equal(owner.seal().allChildrenResourcesClosed, true);
  for (const key of ['nativeInstallAccepted', 'persistenceVerified', 'descendantsVerified']) assert.equal(owner.read()[key], false);
  assert.throws(() => scope.createChildOwner(binding(1), {...spec(1), extra: true}), /INVALID_DATA/);
  for (const archivePath of ['relative.zip', 'F:/x/../a.zip', 'F:/NUL.zip', 'F:/a.zip\n'])
    assert.throws(() => scope.createChildOwner(binding(1), {...spec(1), archivePath}), /INVALID_PATH/);
  for (const [archivePath, destinationPath] of [['F:/Own.zip', 'f:/OWN.ZIP/Extract'], ['F:/Own/a.zip', 'f:/OWN'], ['F:/Own.zip', 'f:/OWN.ZIP']])
    assert.throws(() => scope.createChildOwner(binding(1), {archivePath, destinationPath}), /INVALID_SPEC/);
  assert.throws(() => scope.assertOwner({...owner}), /INVALID_OWNER/);
});

test('manifest pins actual source patches and portable three-file runtime copy closure', () => {
  assert.equal(manifest.upstreamCommit, 'b75def8d0d7d81a03f4526c52b8ada9a34a06479');
  assert.equal(manifest.files.length, 4); assert.equal(manifest.sourceFiles.length, 9); assert.equal(manifest.copyMap.length, 3);
  for (const row of manifest.copyMap) {
    assert(!path.isAbsolute(row.target)); assert(!row.target.includes('..'));
    assert.equal(hash(fs.readFileSync(path.resolve(__dirname, '../../..', row.source))), row.sha256);
  }
  for (const key of ['installed', 'nativeAcceptanceVerified', 'nativeTerminalGuarantee', 'noReplacementGuarantee',
    'ownerReservationGuarantee', 'installationPermit', 'persistenceVerified', 'descendantsVerified']) assert.equal(manifest[key], false);
});

integration('complete owned SDK factory launches exact golden argv with copied options and two-argument progress', async t => {
  const f = await sdk(t), input = spec(1), owner = scope.createChildOwner(binding(1), input), zip = f.Zip.createOwned(owner);
  assert.equal(Object.getPrototypeOf(zip), null); assert(Object.isFrozen(zip)); assert.deepEqual(Object.keys(zip), ['extractFull']);
  const opts = options(), progress = [];
  const result = zip.extractFull(input.archivePath, input.destinationPath, opts, (...args) => progress.push(args));
  assert.deepEqual(opts, {ssc: false}); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, ['x', input.archivePath, '-o' + input.destinationPath, '-bb3', '-ssc-', '-y', '-bsp1']);
  assert.equal(f.calls[0].options.windowsHide, true); assert.equal(f.calls[0].options.shell, false);
  assert.deepEqual(Array.from(f.calls[0].options.stdio), ['pipe', 'pipe', 'pipe']);
  await f.finish(); assert.equal((await result).code, 0);
  assert(progress.length > 0); assert(progress.every(args => args.length === 2));
  assert.equal(owner.read().allChildrenResourcesClosed, false, 'physical completion does not implicitly seal launches');
  assert.equal(owner.seal().allChildrenResourcesClosed, true);
});

integration('ordinary new Zip retains extraction options, overload and legacy spawn call shape', async t => {
  for (const legacy of [true, false]) {
    const f = await sdk(t, {legacy}), zip = new f.Zip();
    const result = zip.extractFull('F:/legacy.zip', 'F:/legacy', {raw: ['-own-legacy-switch']}, () => {});
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options, undefined);
    assert(f.calls[0].args.includes('-own-legacy-switch'));
    await f.finish(); assert.equal((await result).code, 0);
    let progressCalls = 0;
    const overloaded = zip.extractFull('F:/legacy.zip', 'F:/legacy', () => {progressCalls++;}, undefined);
    await f.finish(); assert.equal((await overloaded).code, 0); assert(progressCalls > 0);
    assert.equal(f.calls[1].options, undefined);
  }
});

integration('owned options, getters, inherited switches, tuples and passwords refuse before spawn', async t => {
  const f = await sdk(t), input = spec(1), owner = scope.createChildOwner(binding(1), input), zip = f.Zip.createOwned(owner);
  let invoked = 0;
  const getter = Object.defineProperty({}, 'ssc', {enumerable: true, get() {invoked++; return false;}});
  for (const opts of [undefined, null, () => {}, {}, {ssc: true}, {ssc: false, raw: ['-oF:/escape']},
    {ssc: false, wildcards: '*'}, {ssc: false, o: 'F:/escape'}, Object.assign(Object.create({raw: ['-oF:/escape']}), {ssc: false}), getter]) {
    assert.throws(() => zip.extractFull(input.archivePath, input.destinationPath, opts), /OWNED_EXTRACTOR_/);
  }
  assert.throws(() => zip.extractFull('F:/nested.zip', input.destinationPath, options()), /TUPLE_MISMATCH/);
  assert.throws(() => zip.extractFull(input.archivePath, 'F:/other', options()), /TUPLE_MISMATCH/);
  assert.throws(() => zip.extractFull(input.archivePath, input.destinationPath, options(), undefined, () => {}), /UNSUPPORTED_CALLBACK/);
  assert.equal(invoked, 0); assert.equal(f.calls.length, 0);
  assert.throws(() => f.Zip.createOwned(undefined), /INVALID_OWNER/);
  assert.throws(() => f.Zip.createOwned(binding(1)), /INVALID_OWNER/);
  const foreign = {exports: {}};
  vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(path.join(__dirname, 'owned-extractor-scope.cjs'), 'utf8') + '\n})')(
    name => name === './child-terminal-observer.cjs' ? require('./child-terminal-observer.cjs') : require(name), foreign, foreign.exports);
  assert.throws(() => f.Zip.createOwned(foreign.exports.createChildOwner(binding(1), input)), /INVALID_OWNER/);
});

integration('two owners remain distinct across interleaved real Bluebird callbacks', async t => {
  const f = await sdk(t), a = scope.createChildOwner(binding(1), spec(1)), b = scope.createChildOwner(binding(2), spec(2));
  const za = f.Zip.createOwned(a), zb = f.Zip.createOwned(b);
  const pa = f.Bluebird.resolve().then(() => za.extractFull(spec(1).archivePath, spec(1).destinationPath, options()));
  const pb = f.Bluebird.resolve().then(() => zb.extractFull(spec(2).archivePath, spec(2).destinationPath, options()));
  await tick(); assert.equal(f.children.length, 2);
  await f.finish(0); await f.finish(1); await bounded(NativePromise.all([pa, pb]));
  assert.equal(a.read().children[0].observation.binding.operationId, binding(1).operationId);
  assert.equal(b.read().children[0].observation.binding.operationId, binding(2).operationId);
  assert.equal(a.read().attempts, 1); assert.equal(b.read().attempts, 1);
});

integration('one active child and four total attempts are enforced without budget refund', async t => {
  const f = await sdk(t), input = spec(1), owner = scope.createChildOwner(binding(1), input), zip = f.Zip.createOwned(owner);
  for (let n = 0; n < 4; n++) {
    const current = zip.extractFull(input.archivePath, input.destinationPath, options());
    await assert.rejects(zip.extractFull(input.archivePath, input.destinationPath, options()), /CHILD_ACTIVE_OR_UNKNOWN/);
    assert.equal(f.calls.length, n + 1); assert.equal(owner.read().attempts, n + 1);
    await f.finish(n); await current;
  }
  await assert.rejects(zip.extractFull(input.archivePath, input.destinationPath, options()), /ATTEMPT_LIMIT/);
  assert.equal(f.calls.length, 4); assert.equal(owner.seal().allChildrenResourcesClosed, true);
});

integration('cancel and seal block late Bluebird retries before any new spawn', async t => {
  for (const method of ['cancel', 'seal']) {
    const f = await sdk(t), input = spec(1), owner = scope.createChildOwner(binding(1), input), zip = f.Zip.createOwned(owner);
    owner[method]();
    await assert.rejects(f.Bluebird.resolve().then(() => zip.extractFull(input.archivePath, input.destinationPath, options())), /SEALED_OR_HELD/);
    assert.equal(f.calls.length, 0); assert.equal(owner.read().attempts, 0);
    assert.equal(owner.read().cancelRequested, method === 'cancel');
  }
});

integration('synchronous spawn failure is held unknown and observer failure retains its returned child', async t => {
  const first = await sdk(t, {spawnThrow: Error('own fixed spawn fixture')}), input = spec(1);
  const owner = scope.createChildOwner(binding(1), input), zip = first.Zip.createOwned(owner);
  await assert.rejects(zip.extractFull(input.archivePath, input.destinationPath, options()), /own fixed spawn fixture/);
  const unknown = owner.read(); assert.equal(unknown.attempts, 1); assert.equal(unknown.held, true);
  assert.equal(unknown.children[0].childReturned, false); assert.equal(unknown.allChildrenResourcesClosed, false);
  await assert.rejects(zip.extractFull(input.archivePath, input.destinationPath, options()), /SEALED_OR_HELD/);
  const second = await sdk(t, {afterSpawn: child => {child.stdout = null;}});
  const held = scope.createChildOwner(binding(2), spec(2)), z = second.Zip.createOwned(held);
  await assert.rejects(z.extractFull(spec(2).archivePath, spec(2).destinationPath, options()), /OWNED_EXTRACTOR_OBSERVER_FAILED|TypeError|Cannot read/);
  await bounded(second.children[0].done);
  assert.equal(held.read().children[0].childReturned, true); assert.equal(held.read().held, true);
  assert.equal(held.read().allChildrenResourcesClosed, false);
});

integration('wrapper failure seals before its progress error can request another spawn', async t => {
  const f = await sdk(t), input = spec(1), owner = scope.createChildOwner(binding(1), input), zip = f.Zip.createOwned(owner);
  const error = Error('owned progress failure');
  await assert.rejects(zip.extractFull(input.archivePath, input.destinationPath, options(), () => {throw error;}), value => value === error);
  await bounded(f.children[0].done); await tick();
  assert.equal(owner.read().launchSealed, true); assert.equal(owner.read().wrapperFailureObserved, true);
  assert.equal(owner.read().errorsObserved, true);
  await assert.rejects(zip.extractFull(input.archivePath, input.destinationPath, options()), /SEALED_OR_HELD/);
  assert.equal(f.calls.length, 1);
});

integration('arbitrary wrapper cancellation is not owner cancellation; supported cancellation seals first', async t => {
  const f = await sdk(t), input = spec(1), owner = scope.createChildOwner(binding(1), input), zip = f.Zip.createOwned(owner);
  let final;
  const wrapper = zip.extractFull(input.archivePath, input.destinationPath, options()).finally(() => {final = owner.read();});
  wrapper.cancel(); await bounded(new NativePromise(resolve => setTimeout(resolve, 20)));
  assert(final); assert.equal(final.launchSealed, false); assert.equal(final.allChildrenResourcesClosed, false);
  owner.cancel(); // Supported driver must perform this BEFORE its wrapper cancel.
  await assert.rejects(f.Bluebird.resolve().then(() => zip.extractFull(input.archivePath, input.destinationPath, options())), /SEALED_OR_HELD/);
  await f.finish(); assert.equal(owner.read().cancelRequested, true);
  assert.equal(owner.read().allChildrenResourcesClosed, true); assert.equal(owner.read().nativeInstallAccepted, false);
});


integration('actual exited child with retained stdin cannot release the next launch slot', async t => {
  let release;
  const f = await sdk(t, {script: 'process.stdout.write("- own fixture\\n");setTimeout(()=>process.exit(0),20)', afterSpawn(child) {
    if (release) return;
    const pipe = child.stdin, destroy = pipe.destroy;
    let pending;
    pipe.destroy = function(...args) {pending = args; return this;};
    release = () => {pipe.destroy = destroy; destroy.apply(pipe, pending ?? []);};
  }});
  const input = spec(1), owner = scope.createChildOwner(binding(1), input), zip = f.Zip.createOwned(owner);
  const result = zip.extractFull(input.archivePath, input.destinationPath, options());
  try {
    await bounded(new NativePromise(resolve => f.children[0].child.once('exit', resolve)));
    await tick();
    const observation = owner.read().children[0].observation;
    assert.equal(observation.exitObserved, true);
    assert.equal(observation.pipes.stdin.closeObserved, false);
    assert.equal(observation.childResourcesClosed, false);
    await assert.rejects(zip.extractFull(input.archivePath, input.destinationPath, options()), /CHILD_ACTIVE_OR_UNKNOWN/);
    assert.equal(f.calls.length, 1);
  } finally {release();}
  await bounded(f.children[0].done); assert.equal((await result).code, 0);
  const next = zip.extractFull(input.archivePath, input.destinationPath, options());
  assert.equal(f.calls.length, 2); await f.finish(1); await next;
});
