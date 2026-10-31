import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {setImmediate as turn} from 'node:timers/promises';
import {applyExact, hunks} from './native-patch-test-fixture.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const kinds = [['purge-join', 'VORTEX_NATIVE_DEPLOY_SOURCE'], ['activation-join', 'VORTEX_NATIVE_ACTIVATION_SOURCE']];
function artifacts(name) {
  const base = new URL(`./native-patches/vortex-2.9.1/${name}`, import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL(base.href + '.json')));
  const patch = fs.readFileSync(new URL(base.href + '.patch'), 'utf8');
  return {manifest, patch};
}
function sources(name, environment) {
  const {manifest, patch} = artifacts(name), original = fs.readFileSync(process.env[environment], 'utf8');
  assert.equal(sha(original), manifest.inputSHA256, 'exact original source pin');
  const changed = applyExact(original, patch, manifest.upstreamPath);
  assert.equal(sha(changed), manifest.outputSHA256, 'exact resulting source pin');
  return {original, changed};
}
function declaration(source, name, next) {
  const code = stripTypeScriptTypes(source, {mode: 'strip'});
  const positions = [`async function ${name}(`, `function ${name}(`].map(v => code.indexOf(v)).filter(v => v >= 0);
  assert(positions.length); const start = Math.min(...positions), end = code.indexOf(next, start);
  assert(end > start, `${name} bounded declaration`); return code.slice(start, end);
}
function compile(source, name, next, context) {
  const helper = source.includes('async function joinPurgeOperations(')
    ? declaration(source, 'joinPurgeOperations', name === 'purgeModsImpl' ? 'async function purgeModsImpl(' : 'export function purgeDeployedFiles(') : '';
  const code = helper + declaration(source, name, next) + `\nthis.call = ${name};`;
  return vm.runInNewContext(code, context), context.call;
}
const deferred = () => Promise.withResolvers();
async function until(predicate) {
  for (let n = 0; n < 100; n++) {if (predicate()) return; await turn();}
  assert.fail('Owned deferred fixture did not reach its bounded phase');
}
function observe(promise) {
  const state = {settled: false, rejected: false, error: null};
  state.done = promise.then(() => {state.settled = true;}, error => {
    state.settled = state.rejected = true; state.error = error;
  }); return state;
}

for (const [name, environment] of kinds) test(`${name}: portable immutable patch metadata and syntax`, () => {
  const {manifest, patch} = artifacts(name);
  assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
  assert.equal(manifest.originalSourceSHA256, manifest.inputSHA256);
  assert.equal(sha(patch), manifest.patchSHA256); assert.equal(manifest.testSourceEnvironment, environment);
  assert(hunks(patch, manifest.upstreamPath).length > 0);
  for (const flag of ['installed', 'nativeAcceptanceVerified', 'nativeTerminalGuarantee', 'globalIdleGuarantee', 'noReplacementGuarantee'])
    assert.equal(manifest[flag], false);
  assert.equal(manifest.preparedOnly, true);
});
const activationOptions = {skip: !process.env.VORTEX_NATIVE_ACTIVATION_SOURCE, timeout: 15000};
const deployOptions = {skip: !process.env.VORTEX_NATIVE_DEPLOY_SOURCE, timeout: 15000};

test('actual activation stat failure cannot settle while a later stat/unlink remains started', activationOptions, async () => {
  const variants = sources(...kinds[1]);
  for (const [name, source] of Object.entries(variants)) {
    const a = deferred(), b = deferred(), unlink = deferred(), events = [], first = Error('own stat failure');
    const fn = compile(source, 'purgeDeployedFiles', 'function queryPurgeTextSafe(', {
      path: {join: (_, leaf) => leaf}, getErrorCode: error => error.code,
      fs: {statAsync: leaf => {events.push(`stat:${leaf}`); return leaf === 'a' ? a.promise : b.promise;},
        unlinkAsync: leaf => {events.push(`unlink:${leaf}`); return unlink.promise;}},
    });
    const state = observe(fn('own', [{relPath: 'a', time: 0}, {relPath: 'b', time: 0}]));
    a.reject(first); await turn();
    const early = state.settled;
    b.resolve({mtime: new Date(0)}); await until(() => events.includes('unlink:b'));
    const beforeUnlink = state.settled; unlink.resolve(); await state.done;
    assert.equal(early, name === 'original', 'baseline exposes fail-fast; patched joins stat');
    assert.equal(beforeUnlink, name === 'original', 'patched joins the unlink started by pending stat');
    assert.equal(state.error, first); assert(state.rejected);
  }
});

test('actual activation unlink failure waits for its sibling and ENOENT remains ignored', activationOptions, async () => {
  const {original, changed} = sources(...kinds[1]);
  for (const source of [original, changed]) {
    const first = Error('own unlink failure'), a = deferred(), b = deferred();
    const fn = compile(source, 'purgeDeployedFiles', 'function queryPurgeTextSafe(', {
      path: {join: (_, leaf) => leaf}, getErrorCode: error => error.code,
      fs: {statAsync: () => Promise.resolve({mtime: new Date(0)}), unlinkAsync: leaf => leaf === 'a' ? a.promise : b.promise},
    });
    const state = observe(fn('own', [{relPath: 'a', time: 0}, {relPath: 'b', time: 0}]));
    a.reject(first); await turn(); assert.equal(state.settled, source === original);
    b.resolve(); await state.done; assert.equal(state.error, first);
  }
  const fn = compile(changed, 'purgeDeployedFiles', 'function queryPurgeTextSafe(', {
    path: {join: (_, leaf) => leaf}, getErrorCode: error => error.code,
    fs: {statAsync: () => Promise.reject(Object.assign(Error('missing own fixture'), {code: 'ENOENT'})),
      unlinkAsync: () => assert.fail('Missing file must not unlink')},
  });
  assert.equal(await fn('own', [{relPath: 'a', time: 0}]), undefined);
});

function purgeHarness(source, initial, recovery, faults = {}) {
  const events = []; class ProcessCanceled extends Error {}
  const activator = {id: 'own', prePurge: async () => {}, purge: async () => {},
    postPurge: async () => {events.push('post'); if (Object.hasOwn(faults, 'post')) throw faults.post;}};
  const api = {store: {getState: () => ({app: {instanceId: 'fixture'}}), dispatch: value => {
      events.push(value); if (value === 'stop' && Object.hasOwn(faults, 'stop')) throw faults.stop;
    }},
    sendNotification: () => {}, dismissNotification: () => {
      events.push('dismiss'); if (Object.hasOwn(faults, 'dismiss')) throw faults.dismiss;
    },
    emitAndAwait: async name => {events.push(name);}};
  const fn = compile(source, 'purgeModsImpl', 'export function purgeModsInPath(', {
    installPathForGame: () => 'own-stage', discoveryByGame: () => ({path: 'own-game'}),
    getCurrentActivator: () => activator, getSafe: () => ({}), log: () => {}, shortid: () => 'fixture',
    truthy: Boolean, getGame: () => ({getModPaths: () => ({a: 'own-a', b: 'own-b'})}),
    startActivity: () => 'start', stopActivity: () => 'stop', ProcessCanceled,
    withActivationLock: async fn => {try {return await fn();} finally {events.push('unlock');}},
    loadAllManifests: async () => ({a: ['old-a'], b: ['old-b']}), dealWithExternalChanges: async () => {},
    filterManifest: async (_, __, ___, files) => {events.push('recover-filter'); return files;},
    saveActivation: (_, type, __, ___, ____, files) => {
      const phase = files.length ? 'recover' : 'initial'; events.push(`${phase}:${type}`);
      return (phase === 'initial' ? initial : recovery)(type);
    },
  });
  return {events, ProcessCanceled, run: () => fn(api, activator, {gameId: 'own', id: 'fixture'})};
}

test('actual purge waits for old manifest writes before recovery begins', deployOptions, async () => {
  const variants = sources(...kinds[0]);
  for (const [name, source] of Object.entries(variants)) {
    const a = deferred(), b = deferred(), first = Error('own save failure');
    const h = purgeHarness(source, type => type === 'a' ? a.promise : b.promise, () => Promise.resolve());
    const state = observe(h.run()); await until(() => h.events.includes('initial:b'));
    a.reject(first); await turn(); const earlyRecovery = h.events.includes('recover-filter');
    b.resolve(); await state.done;
    assert.equal(earlyRecovery, name === 'original', 'original overlaps recovery with an old write');
    assert.equal(state.error, first); assert(state.rejected); assert(h.events.includes('unlock'));
  }
});

test('actual purge joins failed recovery writes and retains the primary manifest error', deployOptions, async () => {
  const variants = sources(...kinds[0]);
  for (const [name, source] of Object.entries(variants)) {
    const a = deferred(), b = deferred(), recoveryA = deferred(), recoveryB = deferred();
    const first = Error('own primary failure'), secondary = Error('own recovery failure');
    const h = purgeHarness(source, type => type === 'a' ? a.promise : b.promise,
      type => type === 'a' ? recoveryA.promise : recoveryB.promise);
    const state = observe(h.run()); await until(() => h.events.includes('initial:b'));
    a.reject(first); b.resolve(); await until(() => h.events.includes('recover:b'));
    recoveryA.reject(secondary); await turn(); const earlyPost = h.events.includes('post');
    recoveryB.resolve(); await state.done;
    assert.equal(earlyPost, name === 'original', 'patched post/lock-release waits for recovery sibling');
    assert.equal(state.error, name === 'original' ? secondary : first);
    if (name === 'changed') assert(!h.events.includes('did-purge'));
  }
});

test('otherwise swallowed cancellation surfaces joined recovery failure without did-purge', deployOptions, async () => {
  const {changed} = sources(...kinds[0]), a = deferred(), b = deferred(), recoveryB = deferred();
  const recoveryError = Error('own recovery failure');
  const h = purgeHarness(changed, type => type === 'a' ? a.promise : b.promise,
    type => type === 'a' ? Promise.reject(recoveryError) : recoveryB.promise);
  const state = observe(h.run()); await until(() => h.events.includes('initial:b'));
  a.reject(new h.ProcessCanceled('own cancellation')); b.resolve(); await until(() => h.events.includes('recover:b'));
  await turn(); assert(!state.settled); assert(!h.events.includes('post'));
  recoveryB.resolve(); await state.done; assert.equal(state.error, recoveryError);
  assert(!h.events.includes('did-purge'));
});

test('primary purge errors survive postPurge and both final cleanup failures, including undefined/null', deployOptions, async () => {
  const {changed} = sources(...kinds[0]);
  for (const primary of [Error('own primary'), undefined, null]) {
    for (const faults of [{post: Error('post failure')}, {dismiss: Error('notification failure')},
      {stop: Error('activity failure')}, {post: Error('post failure'), dismiss: Error('dismiss failure'), stop: Error('stop failure')}]) {
      const h = purgeHarness(changed, () => Promise.reject(primary), () => Promise.resolve(), faults);
      const result = observe(h.run()); await result.done;
      assert(result.rejected); assert.equal(result.error, primary);
      assert(h.events.includes('post')); assert(h.events.includes('dismiss')); assert(h.events.includes('stop'));
      assert(!h.events.includes('did-purge'));
    }
  }
});

test('recovery and post-only errors retain precedence while successful cancellation stays swallowed', deployOptions, async () => {
  const {changed} = sources(...kinds[0]);
  for (const recovery of [Error('own recovery'), undefined, null]) {
    // ProcessCanceled is meaningful only to the actual source's shared class.
    const a = deferred(), b = deferred();
    const cancelled = purgeHarness(changed, type => type === 'a' ? a.promise : b.promise,
      () => Promise.reject(recovery), {post: Error('later post'), dismiss: Error('later dismiss')});
    const result = observe(cancelled.run()); await until(() => cancelled.events.includes('initial:b'));
    a.reject(new cancelled.ProcessCanceled('own cancellation')); b.resolve(); await result.done;
    assert(result.rejected); assert.equal(result.error, recovery); assert(!cancelled.events.includes('did-purge'));
    assert(cancelled.events.includes('stop'));
  }
  const post = Error('first relevant post failure');
  const h = purgeHarness(changed, () => Promise.resolve(), () => Promise.resolve(),
    {post, dismiss: Error('later notification failure'), stop: Error('later activity failure')});
  const result = observe(h.run()); await result.done; assert(result.rejected); assert.equal(result.error, post);
  assert(h.events.includes('stop'));
  for (const dismiss of [Error('first cleanup failure'), undefined, null]) {
    const clean = purgeHarness(changed, () => Promise.resolve(), () => Promise.resolve(),
      {dismiss, stop: Error('later cleanup failure')});
    const result = observe(clean.run()); await result.done;
    assert(result.rejected); assert.equal(result.error, dismiss); assert(clean.events.includes('stop'));
  }
});

test('successful cancellation recovery preserves existing completion and changed files remain untouched',
  {skip: !process.env.VORTEX_NATIVE_DEPLOY_SOURCE || !process.env.VORTEX_NATIVE_ACTIVATION_SOURCE, timeout: 15000}, async () => {
    const {changed} = sources(...kinds[0]), a = deferred(), b = deferred(), recoveryB = deferred();
    const h = purgeHarness(changed, type => type === 'a' ? a.promise : b.promise,
      type => type === 'a' ? Promise.resolve() : recoveryB.promise);
    const state = observe(h.run()); await until(() => h.events.includes('initial:b'));
    a.reject(new h.ProcessCanceled('own cancellation')); b.resolve(); await until(() => h.events.includes('recover:b'));
    await turn(); assert(!state.settled); recoveryB.resolve(); await state.done;
    assert.equal(state.rejected, false); assert.equal(h.events.filter(v => v === 'did-purge').length, 1);
    const activation = sources(...kinds[1]).changed;
    const purge = compile(activation, 'purgeDeployedFiles', 'function queryPurgeTextSafe(', {
      path: {join: (_, leaf) => leaf}, getErrorCode: error => error.code,
      fs: {statAsync: () => Promise.resolve({mtime: new Date(1000)}),
        unlinkAsync: () => assert.fail('Changed timestamp must preserve the file')},
    });
    assert.equal(await purge('own', [{relPath: 'a', time: 0}]), undefined);
  });

for (const [name, environment] of kinds) test(`${name}: synchronous startup failure joins earlier work without starting later work`,
  {skip: !process.env[environment], timeout: 15000}, async () => {
    const {changed} = sources(name, environment);
    const next = name === 'purge-join' ? 'async function purgeModsImpl(' : 'export function purgeDeployedFiles(';
    const context = {};
    vm.runInNewContext(declaration(changed, 'joinPurgeOperations', next) + '\nthis.join = joinPurgeOperations;', context);
    const first = deferred(), calls = [];
    const result = observe(context.join([() => {calls.push('first'); return first.promise;},
      () => {calls.push('throw'); throw undefined;}, () => {calls.push('forbidden'); return Promise.resolve();}]));
    await turn(); assert(!result.settled); assert.deepEqual(calls, ['first', 'throw']);
    first.resolve(); await result.done; assert(result.rejected); assert.equal(result.error, undefined);
    const a = deferred(), b = deferred(), primary = Error('first observed, not first array index');
    const observed = observe(context.join([() => a.promise, () => b.promise]));
    b.reject(primary); await turn(); assert(!observed.settled); a.reject(Error('later failure'));
    await observed.done; assert.equal(observed.error, primary);
  });
