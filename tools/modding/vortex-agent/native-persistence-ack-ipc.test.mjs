import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {applyExact} from './native-patch-test-fixture.mjs';

const folder = new URL('./native-patches/vortex-persistence-2.9.1/', import.meta.url);
const root = process.env.VORTEX_NATIVE_ACK_IPC_SOURCE_ROOT;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const names = ['ack-shared-ipc', 'ack-shared-preload', 'ack-preload', 'ack-main-ipc', 'ack-application-owner'];
const stages = Object.fromEntries(names.map(name => [name, {
  meta: JSON.parse(fs.readFileSync(new URL(name + '.json', folder))),
  patch: fs.readFileSync(new URL(name + '.patch', folder), 'utf8'),
}]));
const integration = (name, fn) => test(name, {timeout: 5000,
  skip: root ? false : 'Provide pinned original source tree via VORTEX_NATIVE_ACK_IPC_SOURCE_ROOT'}, fn);
function prepared(name) {
  const {meta, patch} = stages[name];
  const raw = fs.readFileSync(path.join(root, meta.upstreamPath), 'utf8');
  assert.equal(sha(raw), meta.inputSHA256);
  assert.equal(crypto.createHash('sha1').update(`blob ${Buffer.byteLength(raw)}\0`).update(raw).digest('hex'), meta.upstreamGitBlob);
  const output = applyExact(raw, patch, meta.upstreamPath);
  assert.equal(sha(output), meta.outputSHA256);
  return output;
}
function support(file, hash) {
  const raw = fs.readFileSync(path.join(root, file), 'utf8');
  assert.equal(sha(raw), hash);
  return stripTypeScriptTypes(raw, {mode: 'transform'});
}
function deferred() {let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise, resolve, reject};}
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(flush = async () => {}) {
  const handlers = new Map(), calls = [];
  let event;
  const ipcMain = {handle(channel, fn) {assert.equal(handlers.has(channel), false); handlers.set(channel, fn);}, on() {}};
  // Execute actual pinned envelope helpers; serializers are transparent owned
  // facades here. Native Electron transport/error-class hydration is not claimed.
  const mainJS = support('src/main/src/ipc.ts', '94233362e708f56197cba0fd34272d69e136d8fcf1cc207f0728875875ca90f7');
  const start = mainJS.indexOf('function mainHandle('), end = mainJS.indexOf('function mainSend(', start);
  const handle = vm.runInNewContext(mainJS.slice(start, end) + '\nmainHandle;', {
    ipcMain, ipcLogger() {}, assertTrustedSender() {}, toWireError: error => error,
  });
  const main = stripTypeScriptTypes(prepared('ack-main-ipc'), {mode: 'transform'})
    .replace(/^import .*;\n/gm, '').replace(/export function /g, 'function ');
  const api = vm.runInNewContext(main + '\n({setupPersistenceIPC, bindPersistenceAcknowledgementSender});', {
    ipcMain, betterIpcMain: {handle, on() {}, send() {}}, log() {}, registerAllPersistedHives: async () => ({}),
  });
  api.setupPersistenceIPC({flushPersistenceAcknowledged(batches) {calls.push(batches); return flush(batches);}});
  const rendererJS = support('src/preload/src/ipc.ts', '8dfa598bc23a779849a84c009e5448c848c78c623b3d77ab962160e811c382cb');
  const a = rendererJS.indexOf('export async function rendererInvoke('), b = rendererJS.indexOf('export function rendererSend(', a);
  const invoke = vm.runInNewContext(rendererJS.slice(a,b).replace('export ', '') + '\nrendererInvoke;', {
    ipcRenderer: {invoke(channel, ...args) {return handlers.get(channel)(event, ...args);}},
    deserializeVortexError: error => error, errorOriginTracker: {},
  });
  const preload = stripTypeScriptTypes(prepared('ack-preload'), {mode: 'transform'});
  const p = preload.indexOf('persist: {'), q = preload.indexOf('extensions: {', p);
  assert.ok(p >= 0 && q > p);
  const persist = vm.runInNewContext('({' + preload.slice(p,q) + '}).persist;', {betterIpcRenderer: {invoke}});
  const owner = {mainFrame: {}, isDestroyed: () => false};
  return {calls, owner, bind: api.bindPersistenceAcknowledgementSender,
    setEvent(value) {event = value;}, send: persist.sendDiffAcknowledged};
}
function owned(f) {f.bind(f.owner); f.setEvent({sender: f.owner, senderFrame: f.owner.mainFrame});}

test('five exact-source IPC artifacts are preparation only and do not export an install permit', () => {
  for (const {meta, patch} of Object.values(stages)) {
    assert.equal(sha(patch), meta.patchSHA256);
    assert.equal(meta.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
    assert.equal(meta.preparedOnly, true);
    for (const key of ['installed', 'nativeAcceptanceVerified', 'installationPermit', 'powerLossPersistenceVerified']) assert.equal(meta[key], false);
  }
});

integration('all five patches apply exactly; shared batch contract matches the preload invoke', () => {
  for (const name of names) prepared(name);
  assert.match(prepared('ack-shared-ipc'), /"persist:diffs-acknowledged": \(batches: PersistenceBatch\[\]\) => Promise<void>/);
  assert.match(prepared('ack-shared-preload'), /sendDiffAcknowledged\(batches: PersistenceBatch\[\]\): Promise<void>/);
  const app = prepared('ack-application-owner');
  assert.match(app, /this\.mMainWindowReady = this\.mMainWindow\.create\(\);\n    bindPersistenceAcknowledgementSender\(this\.mMainWindow\.getHandle\(\)\?\.webContents\);/);
});

integration('actual Application init binds the newly created owned window before waiting for ready', async () => {
  const js = stripTypeScriptTypes(prepared('ack-application-owner'), {mode: 'transform'});
  const start = js.indexOf('async initMainWindow()'), end = js.indexOf('async awaitMainWindowReady()', start);
  assert.ok(start >= 0 && end > start);
  const calls = [], ready = deferred(), contents = {};
  const init = vm.runInNewContext('({' + js.slice(start, end) + '}).initMainWindow;', {
    readPersistedValue: async () => {calls.push('settings'); return {};},
    log() {},
    MainWindow: class {
      constructor() {calls.push('construct');}
      create() {calls.push('create'); return ready.promise;}
      getHandle() {calls.push('handle'); return {webContents: contents};}
    },
    bindPersistenceAcknowledgementSender(owner) {calls.push('bind'); assert.equal(owner, contents);},
  });
  const application = {mArgs: {}};
  await init.call(application);
  assert.deepEqual(calls, ['settings', 'construct', 'create', 'handle', 'bind']);
  assert.equal(application.mMainWindowReady, ready.promise);
  ready.resolve(contents);
});

integration('actual preload/main helpers forward exact batches and await the exact barrier', async () => {
  const gate = deferred(); const f = fixture(() => gate.promise); owned(f);
  const input = [{hive: 'persistent', operations: [{type: 'set', path: ['mods','own'], value: false}]}];
  let done = false;
  const result = f.send(input).then(value => {done = true; assert.equal(value, undefined);});
  await tick(); assert.equal(done, false); assert.equal(f.calls.length, 1); assert.equal(f.calls[0], input);
  gate.resolve(); await result;
});

integration('sync and async backend failures reject through both actual envelope helpers', async () => {
  for (const asyncFailure of [false, true]) {
    const failure = Error('own barrier failure');
    const f = fixture(() => {if (asyncFailure) return Promise.reject(failure); throw failure;}); owned(f);
    await assert.rejects(f.send([]), error => error === failure);
    assert.equal(f.calls.length, 1);
  }
});

integration('unbound, foreign, subframe and absent-frame senders never reach backend', async () => {
  const f = fixture();
  f.setEvent({sender: f.owner, senderFrame: f.owner.mainFrame});
  await assert.rejects(f.send([]), /owned main frame/);
  f.bind(f.owner);
  for (const event of [{sender: {...f.owner}, senderFrame: f.owner.mainFrame},
    {sender: f.owner, senderFrame: {}}, {sender: f.owner}, {sender: f.owner, senderFrame: null}]) {
    f.setEvent(event); await assert.rejects(f.send([]), /owned main frame/);
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.bind({...f.owner}), /cannot be bound/);
  assert.throws(() => f.bind(undefined), /cannot be bound/);
  const dead = fixture(); dead.owner.isDestroyed = () => true;
  assert.throws(() => dead.bind(dead.owner), /cannot be bound/);
  f.owner.isDestroyed = () => true;
  f.setEvent({sender: f.owner, senderFrame: f.owner.mainFrame});
  await assert.rejects(f.send([]), /owned main frame/);
  assert.equal(f.calls.length, 0);
});

integration('late destroyed owner or changed main frame cannot acknowledge a completed write', async () => {
  for (const change of ['destroy', 'mainFrame', 'eventFrame']) {
    const gate = deferred(); const f = fixture(() => gate.promise); owned(f);
    const event = {sender: f.owner, senderFrame: f.owner.mainFrame}; f.setEvent(event);
    const result = f.send([]); const refused = assert.rejects(result, /owned main frame/);
    await tick(); assert.equal(f.calls.length, 1);
    if (change === 'destroy') f.owner.isDestroyed = () => true;
    else if (change === 'mainFrame') f.owner.mainFrame = {};
    else event.senderFrame = {};
    gate.resolve(); await refused;
    assert.equal(f.calls.length, 1, 'no cancellation or retry of accepted write');
  }
});

integration('current main frame after a reload is accepted for a fresh call without changing owner', async () => {
  const f = fixture(); owned(f); await f.send([]);
  f.owner.mainFrame = {}; f.setEvent({sender: f.owner, senderFrame: f.owner.mainFrame});
  await f.send([]); assert.equal(f.calls.length, 2);
});

integration('malformed and unknown-hive batches remain backend-owned validation, without success conversion', async () => {
  const failure = Error('closed batch validation refused'); const observed = [];
  const f = fixture(batches => {observed.push(batches); throw failure;}); owned(f);
  for (const malformed of [null, undefined, {}, [{hive: 'unknown', operations: []}]]) {
    await assert.rejects(f.send(malformed), error => error === failure);
    assert.equal(observed.at(-1), malformed);
  }
});
