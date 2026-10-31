import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {applyExact} from './native-patch-test-fixture.mjs';

const folder = new URL('./native-patches/vortex-persistence-2.9.1/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = process.env.VORTEX_NATIVE_PERSISTOR_SOURCE;
const stages = ['batch-acknowledgement', 'target-reservation', 'acknowledged-packet'].map(name => ({
  manifest: JSON.parse(readFileSync(new URL(name+'.json', folder))),
  patch: readFileSync(new URL(name+'.patch', folder), 'utf8'),
}));
const integration = (name, action) => test(name, {timeout: 10000,
  skip: source ? false : 'Provide exact original ReduxPersistorIPC.ts'}, action);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const set = (id, value = id) => ({type: 'set', path: ['own', id], value});
const batch = (hive, ...operations) => ({hive, operations});
let prepared;
function actualSource() {
  if (prepared) return prepared;
  let raw = readFileSync(source, 'utf8');
  for (const {manifest, patch} of stages) {
    assert.equal(hash(raw), manifest.inputSHA256); assert.equal(hash(patch), manifest.patchSHA256);
    raw = applyExact(raw, patch, manifest.upstreamPath); assert.equal(hash(raw), manifest.outputSHA256);
  }
  const js = stripTypeScriptTypes(raw, {mode: 'transform'});
  const start = js.indexOf('class ReduxPersistorIPC {'), end = js.lastIndexOf('export default ReduxPersistorIPC;');
  assert(start >= 0 && end > start);
  return prepared = js.slice(start, end)+'\nReduxPersistorIPC;';
}
function fixture({write, commit, rollback, notify, query = async () => false} = {}) {
  const calls = []; let f;
  const Persistor = vm.runInNewContext(actualSource(), {
    Buffer, structuredClone,
    unknownToError: error => error instanceof Error ? error : Error(String(error)),
    log: (...args) => calls.push(['log', ...args]),
    terminate: error => {calls.push(['terminate']); throw error;},
  }, {timeout: 1000});
  const owner = new Persistor();
  const makeBackend = hive => ({
    async setItem(key, value) {calls.push(['write', hive, [...key], value]); await write?.(hive, key, value, f);},
    async removeItem(key) {calls.push(['remove', hive, [...key]]);},
  });
  const backends = {persistent: makeBackend('persistent'), settings: makeBackend('settings')};
  Object.assign(owner.mPersistors, backends);
  const level = {
    async beginTransaction() {calls.push(['begin']);},
    async getDirtyTables() {return notify ? ['own'] : [];},
    async commitTransaction() {calls.push(['commit']); await commit?.(f);},
    async rollbackTransaction() {calls.push(['rollback']); await rollback?.(f);},
    async hasNewModRegistrationConflict(...args) {calls.push(['query', ...args]); return query(...args);},
  };
  const invalidator = {notifyDirtyTables() {calls.push(['notify']); notify?.(f);}};
  owner.setQueryInvalidator(level, invalidator);
  return f = {owner, calls, backends, makeBackend, level, invalidator};
}
const writes = f => f.calls.filter(row => row[0] === 'write');
function status(f, failed) {
  const value = f.owner.getNativeModPersistenceReservation();
  assert.equal(value.writeFailureObserved, failed);
  assert.equal(value.effectsAllowed, false); assert.equal(value.installationPermit, false);
  assert.equal(value.releaseSupported, false);
  return value;
}

test('packet is a separate exact-source prerequisite without installed or native authority', () => {
  for (const {manifest, patch} of stages) {
    assert.equal(hash(patch), manifest.patchSHA256);
    assert.equal(manifest.upstreamPath, 'src/main/src/store/ReduxPersistorIPC.ts');
    assert.equal(manifest.preparedOnly, true); assert.equal(manifest.installed, false);
    assert.equal(manifest.installationPermit, false);
  }
  for (let i = 1; i < stages.length; i++) assert.equal(stages[i].manifest.inputSHA256, stages[i-1].manifest.outputSHA256);
});

integration('legacy or acknowledged write failure before reservation remains sticky after later good writes', async () => {
  for (const mode of ['legacy','ack']) {
    const primary = Error('own earlier failure');
    const f = fixture({write: (_hive, key) => {if (key[1] === 'bad') throw primary;}});
    if (mode === 'legacy') f.owner.applyDiffOperations('persistent', [set('bad')]);
    else await assert.rejects(f.owner.applyDiffOperationsAcknowledged('persistent', [set('bad')]), error => error === primary);
    await f.owner.finalizeWrite(); status(f, true);
    await f.owner.applyDiffOperationsAcknowledged('persistent', [set('good')]);
    await f.owner.finalizeWrite(); status(f, true);
    await assert.rejects(f.owner.reserveNativeModPersistence('game', 'new'), /unresolved write failure/);
    assert(!f.calls.some(row => row[0] === 'query'));
    await assert.rejects(f.owner.flushPersistenceAcknowledged([]), /unresolved failure/);
  }
});

integration('empty packet waits for an older successful write instead of acknowledging an enqueue', async () => {
  const gate = deferred(), f = fixture({write: () => gate.promise}); let done = false;
  f.owner.applyDiffOperations('persistent', [set('old')]);
  const flush = f.owner.flushPersistenceAcknowledged([]).then(() => {done = true;});
  await tick(); assert.equal(done, false);
  gate.resolve(); await flush; status(f, false);
  assert.equal(writes(f).length, 1);
});

integration('empty packet observes a failure that occurs after the barrier was requested', async () => {
  const gate = deferred(), primary = Error('own deferred failure');
  const f = fixture({write: () => gate.promise});
  f.owner.applyDiffOperations('persistent', [set('old')]);
  const flush = assert.rejects(f.owner.flushPersistenceAcknowledged([]), /unresolved failure/);
  await tick(); gate.reject(primary); await flush; status(f, true);
});

integration('invalid second batch, duplicate hive and malformed members reject the whole packet before any writes', async () => {
  const sparse = new Array(2); sparse[1] = batch('settings', set('later'));
  for (const packet of [
    [batch('persistent', set('first')), batch('missing', set('second'))],
    [batch('persistent', set('first')), batch('persistent', set('second'))],
    [batch('persistent', set('first')), {hive: 'settings', operations: [undefined]}],
    [batch('persistent', set('first')), {hive: 'settings', operations: [], extra: true}],
    sparse, [batch('persistent', set('bad', NaN))],
    [batch('persistent', {type: 'set', path: ['own','bad'], value: undefined})],
    [batch('persistent', {type: 'remove', path: ['own###alias']})],
  ]) {
    const f = fixture(); await assert.rejects(f.owner.flushPersistenceAcknowledged(packet));
    await f.owner.finalizeWrite(); assert.deepEqual(f.calls, []); status(f, false);
  }
});

integration('hive, operation and byte budgets refuse oversized packets before enqueue', async () => {
  const packets = [
    Array.from({length: 33}, (_, i) => batch('h'+i, set('own'))),
    [batch('persistent', ...Array.from({length: 32769}, () => set('own')))],
    [batch('persistent', set('own', 'x'.repeat(32 * 1024 * 1024)))],
  ];
  for (const packet of packets) {
    const f = fixture(); await assert.rejects(f.owner.flushPersistenceAcknowledged(packet), /limit|Invalid/);
    await f.owner.finalizeWrite(); assert.deepEqual(f.calls, []); status(f, false);
  }
});

integration('two hives form one queue unit even when their backend reenters ordinary enqueue', async () => {
  let queued = false;
  const f = fixture({write: (_hive, key, _value, current) => {
    if (key[1] === 'packet-first' && !queued) {
      queued = true;
      current.owner.applyDiffOperations('settings', [set('reentrant-later')]);
    }
  }});
  await f.owner.flushPersistenceAcknowledged([
    batch('persistent', set('packet-first')), batch('settings', set('packet-second')),
  ]);
  await f.owner.finalizeWrite();
  assert.deepEqual(writes(f).map(row => row[2][1]), ['packet-first','packet-second','reentrant-later']);
  status(f, false);
});

integration('first failed batch preserves the raw failure and suppresses all later packet batches', async () => {
  for (const afterCommit of [false, true]) for (const primary of [Error('own failure'), undefined, null]) {
    const f = fixture({write: (_hive, key) => key[1] === 'bad' ? Promise.reject(primary) : undefined});
    f.owner.mPersistors.app = f.makeBackend('app');
    const packet = afterCommit ? [batch('persistent', set('committed')), batch('settings', set('bad'))]
      : [batch('persistent', set('bad'))];
    packet.push(batch('app', set('must-not-start')));
    let rejected = false;
    await f.owner.flushPersistenceAcknowledged(packet)
      .then(() => assert.fail('failed batch was acknowledged'), error => {rejected = true; assert.equal(error, primary);});
    assert(rejected); assert.deepEqual(writes(f).map(row => row[2][1]), afterCommit ? ['committed','bad'] : ['bad']);
    assert.equal(f.calls.filter(row => row[0] === 'commit').length, afterCommit ? 1 : 0);
    status(f, true); await f.owner.finalizeWrite();
  }
});

integration('backend changes while a packet waits refuse before any packet write', async () => {
  for (const kind of ['hive','level','invalidator']) {
    const gate = deferred(); const f = fixture({write: (_hive, key) => key[1] === 'old' ? gate.promise : undefined});
    f.owner.applyDiffOperations('settings', [set('old')]);
    const rejected = assert.rejects(f.owner.flushPersistenceAcknowledged([batch('persistent', set('packet'))]), /backend change/);
    if (kind === 'hive') f.owner.mPersistors.persistent = f.makeBackend('replacement');
    else f.owner.setQueryInvalidator(kind === 'level' ? {...f.level} : f.level,
      kind === 'invalidator' ? {...f.invalidator} : f.invalidator);
    gate.resolve(); await rejected;
    assert.deepEqual(writes(f).map(row => row[2][1]), ['old']); status(f, true);
  }
});

integration('backend drift after the first committed batch stops the next batch and does not undo the first', async () => {
  const f = fixture({write: (_hive, key, _value, current) => {
    if (key[1] === 'first') current.owner.mPersistors.settings = current.makeBackend('replacement');
  }});
  await assert.rejects(f.owner.flushPersistenceAcknowledged([
    batch('persistent', set('first')), batch('settings', set('second')),
  ]), /backend change/);
  assert.deepEqual(writes(f).map(row => row[2][1]), ['first']);
  assert.equal(f.calls.filter(row => row[0] === 'commit').length, 1); status(f, true);
});

integration('target reservation checks the entire packet before an earlier unrelated batch can write', async () => {
  const f = fixture(); await f.owner.reserveNativeModPersistence('game', 'new');
  await assert.rejects(f.owner.flushPersistenceAcknowledged([
    batch('settings', set('first')),
    batch('persistent', {type: 'set', path: ['mods','game','new','state'], value: 'installed'}),
  ]), /reserved/);
  assert.deepEqual(writes(f), []);
  assert.equal(status(f, false).phase, 'held');
});

integration('waiting packet paths and nested values are detached from subsequent caller changes', async () => {
  const gate = deferred(), f = fixture({write: (_hive, key) => key[1] === 'old' ? gate.promise : undefined});
  f.owner.applyDiffOperations('settings', [set('old')]);
  const packet = [batch('persistent', set('own', {nested: {enabled: false}}))];
  const flush = f.owner.flushPersistenceAcknowledged(packet);
  packet[0].hive = 'settings'; packet[0].operations[0].path[1] = 'foreign';
  packet[0].operations[0].value.nested.enabled = true; packet.push(batch('settings', set('extra')));
  gate.resolve(); await flush;
  assert.deepEqual(writes(f).map(row => [row[1],row[2][1],row[3]]), [
    ['settings','old','"old"'], ['persistent','own','{"nested":{"enabled":false}}'],
  ]); status(f, false);
});
