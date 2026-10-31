import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {applyExact} from './native-patch-test-fixture.mjs';

// Exact source execution with real computeStateDiff; only timers and transport
// are facades. No Electron, persistence DB, native installation or filesystem writes.
const folder = new URL('./native-patches/vortex-persistence-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('renderer-acknowledged-flush.json', folder)));
const patch = readFileSync(new URL('renderer-acknowledged-flush.patch', folder), 'utf8');
const source = process.env.VORTEX_NATIVE_PERSIST_DIFF_SOURCE;
const diffSource = process.env.VORTEX_NATIVE_STATE_DIFF_SOURCE;
const sha = data => createHash('sha256').update(data).digest('hex');
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: source && diffSource ? false : 'Provide VORTEX_NATIVE_PERSIST_DIFF_SOURCE and VORTEX_NATIVE_STATE_DIFF_SOURCE'}, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {resolve = a; reject = b;});
  return {promise, resolve, reject};
}
function javascript(source) {
  return stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), {mode: 'transform'});
}
function fixture({getApi, send, baseline = false} = {}) {
  const raw = readFileSync(source, 'utf8');
  assert.equal(sha(raw), manifest.inputSHA256);
  const patched = applyExact(raw, patch, manifest.upstreamPath);
  assert.equal(sha(patched), manifest.outputSHA256);
  const diff = readFileSync(diffSource, 'utf8');
  assert.equal(sha(diff), '3f7a243baa908f0fc1143d50df4ba1352dde33d445f19c24675bbdf4df6dd7e9');
  const computeStateDiff = new Function(javascript(diff) + '\nreturn computeStateDiff;')();
  const timers = new Map(), callbacks = [], acknowledged = [], legacy = [], sync = [], logs = [];
  let nextTimer = 1;
  const api = {
    sendDiff: (hive, operations) => legacy.push({hive, operations}),
    sendDiffSync: (hive, operations) => sync.push({hive, operations}),
    sendDiffAcknowledged: batches => {acknowledged.push(structuredClone(batches)); return send?.(batches) ?? Promise.resolve();},
  };
  const module = new Function('computeStateDiff', 'getErrorMessageOrDefault', 'log', 'setTimeout', 'clearTimeout',
    javascript(baseline ? raw : patched) + '\nreturn {createPersistDiffMiddleware, addPersistedHives, flushPendingDiffsSync'
    + (baseline ? '' : ', flushPendingDiffsAcknowledged') + '};')(
    computeStateDiff, () => 'own fixture error', (...args) => logs.push(args),
    callback => {const id = nextTimer++; timers.set(id, callback); callbacks.push(callback); return id;},
    id => timers.delete(id));
  let state = {persistent: {}, settings: {}};
  const middleware = module.createPersistDiffMiddleware(() => getApi ? getApi(api) : api);
  const dispatch = middleware({getState: () => state})(action => {
    if (Object.hasOwn(action, 'state')) state = action.state;
    return action;
  });
  dispatch({type: 'INITIALIZE'});
  const update = (hive, value) => dispatch({type: 'OWN_CHANGE', state: {...state, [hive]: value}});
  const fire = () => {for (const [id, callback] of [...timers]) {timers.delete(id); callback();}};
  return {module, api, update, dispatch, timers, callbacks, acknowledged, legacy, sync, logs, fire,
    flush: () => module.flushPendingDiffsAcknowledged(), state: () => state};
}

test('renderer flush artifact is exact source preparation without native or power-loss authority', () => {
  assert.equal(sha(patch), manifest.patchSHA256);
  assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
  assert.equal(manifest.upstreamPath, 'src/renderer/src/store/persistDiffMiddleware.ts');
  assert.equal(manifest.preparedOnly, true);
  for (const key of ['installed', 'nativeAcceptanceVerified', 'installationPermit', 'powerLossPersistenceVerified']) {
    assert.equal(manifest[key], false);
  }
});

integration('legacy timer and sync behavior before explicit acknowledged flush stays unchanged', () => {
  for (const baseline of [false, true]) {
    const f = fixture({baseline});
    f.update('persistent', {own: 1}); f.fire();
    assert.deepEqual(f.legacy, [{hive: 'persistent', operations: [{type: 'set', path: ['own'], value: 1}]}]);
    f.update('persistent', {own: 2}); f.module.flushPendingDiffsSync();
    assert.deepEqual(f.sync, [{hive: 'persistent', operations: [{type: 'set', path: ['own'], value: 2}]}]);
    assert.equal(f.acknowledged.length, 0);
  }
});

integration('debounced snapshot is detached and its completion waits for the main acknowledgement', async () => {
  const gate = deferred(); const f = fixture({send: () => gate.promise});
  f.update('persistent', {own: 1}); assert.equal(f.timers.size, 1);
  let done = false;
  const flight = f.flush(); flight.then(() => {done = true;});
  assert.equal(f.timers.size, 0); assert.equal(f.legacy.length, 0);
  assert.deepEqual(f.acknowledged, [[{hive: 'persistent', operations: [{type: 'set', path: ['own'], value: 1}]}]]);
  await tick(); assert.equal(done, false);
  gate.resolve(); await flight; assert.equal(done, true);
});

integration('empty snapshot still invokes and awaits the main barrier, including subsequent flush', async () => {
  const gate = deferred(); const f = fixture({send: () => gate.promise});
  let done = false; const flight = f.flush().then(() => {done = true;});
  assert.deepEqual(f.acknowledged, [[]]); await tick(); assert.equal(done, false);
  gate.resolve(); await flight; await f.flush();
  assert.deepEqual(f.acknowledged, [[], []]);
});

integration('single flight is visible before reentrant getApi and preserves changes made by that callback', async () => {
  let f, entered = false, nested;
  f = fixture({getApi: api => {
    if (entered) {entered = false; nested = f.flush(); f.update('persistent', {later: 2});}
    return api;
  }});
  f.update('persistent', {own: 1}); entered = true;
  const flight = f.flush(); assert.equal(flight, nested);
  await flight; await f.flush();
  assert.deepEqual(f.acknowledged[0], [{hive: 'persistent', operations: [{type: 'set', path: ['own'], value: 1}]}]);
  assert.deepEqual(f.acknowledged[1][0].operations, [{type: 'remove', path: ['own']}, {type: 'set', path: ['later'], value: 2}]);
});

integration('updates and reentrant sends during await stay fresh and cannot be deleted by the older completion', async () => {
  const gate = deferred(); let f, sends = 0, nested;
  f = fixture({send: () => {
    if (++sends === 1) {nested = f.flush(); f.update('persistent', {own: 2}); return gate.promise;}
  }});
  f.update('persistent', {own: 1}); const flight = f.flush();
  assert.equal(nested, flight); f.update('settings', {other: false});
  assert.equal(f.timers.size, 0); f.fire(); assert.equal(f.legacy.length, 0);
  gate.resolve(); await flight; await f.flush();
  assert.deepEqual(f.acknowledged[1], [
    {hive: 'persistent', operations: [{type: 'set', path: ['own'], value: 2}]},
    {hive: 'settings', operations: [{type: 'set', path: ['other'], value: false}]},
  ]);
});

integration('strict serializer reentry queues new state without mutating the detached snapshot', async () => {
  let f, armed = false;
  const proxied = new Proxy({v: 1}, {ownKeys(target) {
    if (armed) {armed = false; f.update('settings', {duringSerialization: true});}
    return Reflect.ownKeys(target);
  }});
  f = fixture(); f.update('persistent', {own: [proxied]}); armed = true;
  await f.flush(); await f.flush();
  assert.deepEqual(f.acknowledged[0][0].operations[0].value, [{v: 1}]);
  assert.deepEqual(f.acknowledged[1], [{hive: 'settings', operations: [
    {type: 'set', path: ['duringSerialization'], value: true},
  ]}]);
});

integration('strict lossless JSON rejects unsupported values without converting any into removes', async () => {
  const cycle = []; cycle.push(cycle);
  let getterCalls = 0, toJSONCalls = 0;
  const accessor = Object.defineProperty({}, 'secret', {enumerable: true, get() {getterCalls++; return 1;}});
  const toJSON = {toJSON() {toJSONCalls++; return {};}};
  const symbol = {[Symbol('own')]: 1};
  const extraArray = [1]; extraArray.extra = true;
  const hidden = Object.defineProperty({}, 'hidden', {value: 1});
  const values = [undefined, () => {}, Symbol('own'), 1n, NaN, Infinity, -Infinity,
    cycle, new Array(1), extraArray, accessor, toJSON, symbol, hidden, new Date(0)];
  for (const value of values) {
    const f = fixture(); f.update('persistent', {own: [value]});
    await assert.rejects(f.flush(), /snapshot/);
    await assert.rejects(f.flush(), /held/);
    f.fire(); f.module.flushPendingDiffsSync();
    assert.equal(f.acknowledged.length, 0); assert.equal(f.legacy.length, 0); assert.equal(f.sync.length, 0);
  }
  assert.equal(getterCalls, 0); assert.equal(toJSONCalls, 0);
});

integration('legitimate removal and lossless JSON values remain supported', async () => {
  const f = fixture(); f.update('persistent', {old: true}); await f.flush();
  f.update('persistent', {own: [null, false, 0, '', {text: 'ordinary'}]}); await f.flush();
  assert.deepEqual(f.acknowledged[1][0].operations, [
    {type: 'remove', path: ['old']}, {type: 'set', path: ['own'], value: [null, false, 0, '', {text: 'ordinary'}]},
  ]);
});

integration('API lookup, unsupported API and send failures permanently hold without legacy fallback', async () => {
  const primary = Error('own transport failure');
  for (const mode of ['lookup', 'missing', 'send']) {
    let armed = false;
    const f = fixture({getApi: api => {
      if (!armed) return api;
      if (mode === 'lookup') throw primary;
      if (mode === 'missing') return {...api, sendDiffAcknowledged: undefined};
      return api;
    }, send: () => {throw primary;}});
    f.update('persistent', {own: 1}); armed = true;
    await assert.rejects(f.flush()); await assert.rejects(f.flush(), /held/);
    f.fire(); f.module.flushPendingDiffsSync();
    assert.equal(f.legacy.length, 0); assert.equal(f.sync.length, 0);
    assert.equal(f.acknowledged.length, mode === 'send' ? 1 : 0);
  }
});

integration('rejected acknowledgement retains a hold and neither detached nor fresh data is replayed', async () => {
  const gate = deferred(); const primary = Error('own main failure'); const f = fixture({send: () => gate.promise});
  f.update('persistent', {own: 1}); const flight = f.flush();
  const observed = assert.rejects(flight, error => error === primary);
  f.update('persistent', {own: 2}); gate.reject(primary); await observed;
  await assert.rejects(f.flush(), /held/); f.fire(); f.module.flushPendingDiffsSync();
  assert.equal(f.acknowledged.length, 1); assert.equal(f.legacy.length, 0); assert.equal(f.sync.length, 0);
});

integration('unknown acknowledgement never silently times out into replay or success', async () => {
  const gate = deferred(); const f = fixture({send: () => gate.promise});
  f.update('persistent', {own: 1}); const oldTimer = f.callbacks.at(-1);
  let done = false; const flight = f.flush(); flight.then(() => {done = true;});
  f.update('persistent', {own: 2}); oldTimer(); await tick();
  assert.equal(done, false); assert.equal(f.legacy.length, 0); assert.equal(f.acknowledged.length, 1);
  assert.equal(f.flush(), flight);
  gate.resolve(); await flight;
});

integration('hydration, replacement hydration and main push during await invalidate the late acknowledgement', async () => {
  for (const type of ['__hydrate', '__hydrate_replace', '__persist_push']) {
    const gate = deferred(); const f = fixture({send: () => gate.promise});
    f.update('persistent', {own: 1}); const flight = f.flush();
    const rejected = assert.rejects(flight, /coherence changed/);
    f.dispatch({type, state: {persistent: {main: 2}, settings: {}}});
    gate.resolve(); await rejected;
    await assert.rejects(f.flush(), /held/); f.fire(); assert.equal(f.legacy.length, 0);
  }
});

integration('quit sync during flight invalidates completion and cannot replay detached or fresh snapshots', async () => {
  const gate = deferred(); const f = fixture({send: () => gate.promise});
  f.update('persistent', {own: 1}); const flight = f.flush();
  const rejected = assert.rejects(flight, /coherence changed/);
  f.update('persistent', {own: 2}); f.module.flushPendingDiffsSync();
  gate.resolve(); await rejected; await assert.rejects(f.flush(), /held/);
  assert.equal(f.acknowledged.length, 1); assert.equal(f.sync.length, 0); assert.equal(f.legacy.length, 0);
});

integration('reentrant hydration or quit before dispatch holds without sending a stale packet', async () => {
  for (const mode of ['hydrate', 'quit']) {
    let f, armed = false;
    f = fixture({getApi: api => {
      if (armed) {
        armed = false;
        if (mode === 'hydrate') f.dispatch({type: '__hydrate', state: {persistent: {main: true}}});
        else f.module.flushPendingDiffsSync();
      }
      return api;
    }});
    f.update('persistent', {own: 1}); armed = true;
    await assert.rejects(f.flush(), /coherence changed/);
    assert.equal(f.acknowledged.length, 0); await assert.rejects(f.flush(), /held/);
  }
});

integration('an API returning no completion cannot produce a successful acknowledgement', async () => {
  const f = fixture(); f.update('persistent', {own: 1});
  let calls = 0; f.api.sendDiffAcknowledged = () => {calls++;};
  await assert.rejects(f.flush(), /did not return a completion/);
  await assert.rejects(f.flush(), /held/); assert.equal(calls, 1);
});

integration('acknowledged reentry from active legacy timer or quit sends is held instead of duplicating its packet', async () => {
  for (const origin of ['timer', 'sync']) {
    for (const callback of ['getApi', 'send']) {
      let f, armed = false, nested;
      f = fixture({getApi: api => {
        if (armed && callback === 'getApi') {armed = false; nested = f.flush();}
        return api;
      }});
      const record = origin === 'timer' ? f.legacy : f.sync;
      const method = origin === 'timer' ? 'sendDiff' : 'sendDiffSync';
      f.api[method] = (hive, operations) => {
        record.push({hive, operations});
        if (armed && callback === 'send') {armed = false; nested = f.flush();}
      };
      f.update('persistent', {own: 1}); armed = true;
      if (origin === 'timer') f.fire(); else f.module.flushPendingDiffsSync();
      await assert.rejects(nested, /overlaps a legacy flush/);
      assert.equal(f.acknowledged.length, 0);
      assert.equal(record.length, callback === 'getApi' ? 0 : 1);
      await assert.rejects(f.flush(), /held/);
      f.fire(); f.module.flushPendingDiffsSync();
      assert.equal(record.length, callback === 'getApi' ? 0 : 1);
    }
  }
});

integration('depth, hive, operation and UTF8 packet budgets fail before transport', async () => {
  const fixtures = [];
  const depth = fixture(); let nested = 1;
  for (let n = 0; n < 40; n++) nested = [nested];
  depth.update('persistent', {deep: nested}); fixtures.push(depth);
  const hives = fixture();
  for (let n = 0; n < 33; n++) {hives.module.addPersistedHives(['own' + n]); hives.update('own' + n, {v: n});}
  fixtures.push(hives);
  const operations = fixture(); const many = {};
  for (let n = 0; n < 32769; n++) many['v' + n] = n;
  operations.update('persistent', many); fixtures.push(operations);
  const bytes = fixture(); bytes.update('persistent', {large: 'x'.repeat(32 * 1024 * 1024 + 1)}); fixtures.push(bytes);
  for (const f of fixtures) {
    await assert.rejects(f.flush(), /limit/); assert.equal(f.acknowledged.length, 0);
  }
});
