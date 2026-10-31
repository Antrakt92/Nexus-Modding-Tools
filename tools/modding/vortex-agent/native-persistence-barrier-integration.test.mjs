import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {applyExact} from './native-patch-test-fixture.mjs';

// Joined actual renderer diff/middleware and main persistor class. The transport
// is a transparent owned asynchronous facade, not Electron IPC; the separate
// native-persistence-ack-ipc suite executes the pinned wire helper chain.
// Backend writes and timers are also facades, without disk/native side effects.
const folder = new URL('./native-patches/vortex-persistence-2.9.1/', import.meta.url);
const mainSource = process.env.VORTEX_NATIVE_PERSISTOR_SOURCE;
const rendererSource = process.env.VORTEX_NATIVE_PERSIST_DIFF_SOURCE;
const diffSource = process.env.VORTEX_NATIVE_STATE_DIFF_SOURCE;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: mainSource && rendererSource && diffSource ? false : 'Provide pinned main persistor, renderer middleware and stateDiff sources'}, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
function prepared(source, stages) {
  let raw = fs.readFileSync(source, 'utf8');
  for (const name of stages) {
    const meta = JSON.parse(fs.readFileSync(new URL(name + '.json', folder)));
    const patch = fs.readFileSync(new URL(name + '.patch', folder), 'utf8');
    assert.equal(hash(raw), meta.inputSHA256); assert.equal(hash(patch), meta.patchSHA256);
    raw = applyExact(raw, patch, meta.upstreamPath); assert.equal(hash(raw), meta.outputSHA256);
  }
  return raw;
}
function js(source) {
  return stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), {mode: 'transform'});
}
function fixture({write} = {}) {
  const main = stripTypeScriptTypes(prepared(mainSource,
    ['batch-acknowledgement', 'target-reservation', 'acknowledged-packet']), {mode: 'transform'});
  const start = main.indexOf('class ReduxPersistorIPC {'), end = main.lastIndexOf('export default ReduxPersistorIPC;');
  assert.ok(start >= 0 && end > start);
  const Persistor = new Function('unknownToError', 'log', 'terminate', main.slice(start,end) + '\nreturn ReduxPersistorIPC;')(
    value => value instanceof Error ? value : Error(String(value)), () => {}, error => {throw error;});
  const owner = new Persistor(), writes = [], packets = [], legacy = [], timers = new Map();
  for (const hive of ['persistent', 'settings']) owner.mPersistors[hive] = {
    async setItem(parts, value) {
      writes.push({hive, parts: [...parts], value});
      await write?.(hive, parts, value);
    },
    async removeItem(parts) {writes.push({hive, parts: [...parts], remove: true});},
  };
  const diff = fs.readFileSync(diffSource, 'utf8');
  assert.equal(hash(diff), '3f7a243baa908f0fc1143d50df4ba1352dde33d445f19c24675bbdf4df6dd7e9');
  const compute = new Function(js(diff) + '\nreturn computeStateDiff;')();
  const api = {
    sendDiff(hive, operations) {legacy.push({hive, operations}); owner.applyDiffOperations(hive, operations);},
    sendDiffAcknowledged(batches) {
      packets.push(structuredClone(batches));
      // Explicit facade boundary: emulate a reply envelope without claiming
      // Electron sender validation or real error serialization in this suite.
      return Promise.resolve().then(() => owner.flushPersistenceAcknowledged(structuredClone(batches)))
        .then(data => ({data}), error => ({error}))
        .then(reply => {if (reply.error !== undefined) throw reply.error; return reply.data;});
    },
  };
  let timerId = 0;
  const renderer = new Function('computeStateDiff', 'getErrorMessageOrDefault', 'log', 'setTimeout', 'clearTimeout',
    js(prepared(rendererSource, ['renderer-acknowledged-flush']))
    + '\nreturn {createPersistDiffMiddleware, flushPendingDiffsAcknowledged, flushPendingDiffsSync};')(
    compute, String, () => {}, callback => {const id = ++timerId; timers.set(id, callback); return id;}, id => timers.delete(id));
  let state = {persistent: {}, settings: {}};
  const dispatch = renderer.createPersistDiffMiddleware(() => api)({getState: () => state})(action => {
    if (action.state !== undefined) state = action.state;
    return action;
  });
  dispatch({type: 'INITIALIZE'});
  return {owner, writes, packets, legacy, timers,
    update(hive, value) {dispatch({type: 'OWN_CHANGE', state: {...state, [hive]: value}});},
    flush: renderer.flushPendingDiffsAcknowledged, sync: renderer.flushPendingDiffsSync,
    fire() {for (const [id, callback] of [...timers]) {timers.delete(id); callback();}},
  };
}

integration('joined renderer snapshot waits for an older blocked actual main queue write before acknowledgement', async () => {
  const gate = deferred();
  const f = fixture({write: (_hive, parts) => parts[0] === 'older' ? gate.promise : undefined});
  f.owner.applyDiffOperations('persistent', [{type: 'set', path: ['older'], value: 'first'}]);
  f.update('persistent', {own: 1}); assert.equal(f.timers.size, 1);
  let complete = false; const flight = f.flush().then(() => {complete = true;});
  await tick(); assert.equal(complete, false); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.writes.map(row => row.parts), [['older']]);
  assert.deepEqual(f.packets, [[{hive: 'persistent', operations: [{type: 'set', path: ['own'], value: 1}]}]]);
  gate.resolve(); await flight;
  assert.deepEqual(f.writes.map(row => row.parts), [['older'], ['own']]);
  assert.equal(f.legacy.length, 0);
});

integration('new renderer changes survive an older ACK and the later exact flush never replays old operations', async () => {
  const gate = deferred(); let first = true;
  const f = fixture({write: () => {if (first) {first = false; return gate.promise;}}});
  f.update('persistent', {own: 1}); const flight = f.flush();
  await tick(); f.update('persistent', {own: 2}); f.update('settings', {fresh: false});
  f.fire(); assert.equal(f.legacy.length, 0); assert.equal(f.packets.length, 1);
  gate.resolve(); await flight; await f.flush(); f.fire(); await f.owner.finalizeWrite();
  assert.deepEqual(f.writes, [
    {hive: 'persistent', parts: ['own'], value: '1'},
    {hive: 'persistent', parts: ['own'], value: '2'},
    {hive: 'settings', parts: ['fresh'], value: 'false'},
  ]);
  assert.equal(f.packets.length, 2); assert.equal(f.legacy.length, 0);
  assert.equal(f.packets[1][0].operations[0].value, 2);
});

integration('earlier main write failure crosses the facade as rejection and renderer holds without automatic replay', async () => {
  const gate = deferred(), primary = Error('own earlier backend failure');
  const f = fixture({write: async (_hive, parts) => {if (parts[0] === 'older') {await gate.promise; throw primary;}}});
  f.owner.applyDiffOperations('persistent', [{type: 'set', path: ['older'], value: 'first'}]);
  f.update('persistent', {own: 1});
  const refused = assert.rejects(f.flush(), /unresolved failure/);
  await tick(); gate.resolve(); await refused;
  assert.equal(f.owner.getNativeModPersistenceReservation().writeFailureObserved, true);
  f.update('persistent', {own: 2}); f.fire(); f.sync();
  await assert.rejects(f.flush(), /held/); await f.owner.finalizeWrite();
  assert.equal(f.packets.length, 1); assert.equal(f.legacy.length, 0);
  assert.deepEqual(f.writes.map(row => row.parts), [['older']]);
});
