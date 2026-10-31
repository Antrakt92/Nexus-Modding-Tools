import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {applyExact} from './native-patch-test-fixture.mjs';

// Executes the pinned actual persistor class. The concrete storage/invalidator
// are owned facades; this is neither a native database test nor an install permit.
const folder = new URL('./native-patches/vortex-persistence-2.9.1/', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = process.env.VORTEX_NATIVE_PERSISTOR_SOURCE;
const stages = ['batch-acknowledgement', 'target-reservation'].map(name => {
  const manifest = JSON.parse(readFileSync(new URL(name + '.json', folder)));
  const patch = readFileSync(new URL(name + '.patch', folder), 'utf8');
  return {manifest, patch};
});
const integration = (name, fn) => test(name, {timeout: 5000,
  skip: source ? false : 'Provide the exact original ReduxPersistorIPC.ts via VORTEX_NATIVE_PERSISTOR_SOURCE'}, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {resolve = a; reject = b;});
  return {promise, resolve, reject};
}
const set = (parts, value = 'own') => ({type: 'set', path: parts, value});
const remove = parts => ({type: 'remove', path: parts});

function fixture({query = async () => false, write, hydration} = {}) {
  let raw = readFileSync(source, 'utf8');
  for (const {manifest, patch} of stages) {
    assert.equal(sha(raw), manifest.inputSHA256);
    assert.equal(sha(patch), manifest.patchSHA256);
    raw = applyExact(raw, patch, manifest.upstreamPath);
    assert.equal(sha(raw), manifest.outputSHA256);
  }
  const js = stripTypeScriptTypes(raw, {mode: 'transform'});
  const start = js.indexOf('class ReduxPersistorIPC {');
  const end = js.lastIndexOf('export default ReduxPersistorIPC;');
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const Persistor = vm.runInNewContext(js.slice(start, end) + '\nReduxPersistorIPC;', {
    structuredClone,
    unknownToError: error => error instanceof Error ? error : Error(String(error)),
    log: (...args) => calls.push(['log', ...args]),
    terminate: error => {calls.push(['terminate']); throw error;},
  }, {timeout: 1000});
  const owner = new Persistor();
  const backend = {
    getAllKVs: async () => {calls.push(['hydrate']); return await hydration?.() ?? [];},
    setResetCallback: callback => {backend.reset = callback;},
    setItem: async (key, value) => {calls.push(['set', [...key], value]); await write?.(key, value);},
    removeItem: async key => {calls.push(['remove', [...key]]);},
  };
  const level = {
    beginTransaction: async () => {calls.push(['begin']);},
    getDirtyTables: async () => [],
    commitTransaction: async () => {calls.push(['commit']);},
    rollbackTransaction: async () => {calls.push(['rollback']);},
    hasNewModRegistrationConflict: async (...args) => {calls.push(['query', ...args]); return await query(...args);},
  };
  const invalidator = {notifyDirtyTables: () => assert.fail('no dirty tables in this fixture')};
  owner.mPersistors.persistent = backend;
  owner.setQueryInvalidator(level, invalidator);
  return {owner, calls, backend, level, invalidator};
}
const writes = f => f.calls.filter(row => row[0] === 'set' || row[0] === 'remove');
function held(f) {
  assert.equal(f.owner.getNativeModPersistenceReservation().phase, 'held');
}

test('reservation artifact is exact-source preparation with no release or native authority', () => {
  for (const {manifest, patch} of stages) {
    assert.equal(sha(patch), manifest.patchSHA256);
    assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
    assert.equal(manifest.upstreamPath, 'src/main/src/store/ReduxPersistorIPC.ts');
    assert.equal(manifest.preparedOnly, true);
    for (const key of ['installed', 'nativeAcceptanceVerified', 'installationPermit']) {
      assert.equal(manifest[key], false, key);
    }
  }
  assert.equal(stages[0].manifest.powerLossPersistenceVerified, false);
  assert.equal(stages[1].manifest.releaseSupported, false);
  assert.equal(stages[1].manifest.inputSHA256, stages[0].manifest.outputSHA256);
  const companion = JSON.parse(readFileSync(new URL('new-mod-conflict-query.json', folder)));
  assert.equal(stages[1].manifest.requiredCompanionPatch, 'new-mod-conflict-query.patch');
  assert.equal(stages[1].manifest.requiredCompanionPatchSHA256, companion.patchSHA256);
  assert.equal(stages[1].manifest.requiredCompanionOutputSHA256, companion.outputSHA256);
});

integration('reservation becomes pending synchronously and admission waits for earlier queued writes', async () => {
  const prior = deferred();
  const f = fixture({write: () => prior.promise});
  f.owner.applyDiffOperations('persistent', [set(['mods', 'old-game', 'old-mod'])]);
  let admitted = false;
  const pending = f.owner.reserveNativeModPersistence('fixture', 'new').then(token => {admitted = true; return token;});
  assert.equal(f.owner.getNativeModPersistenceReservation().phase, 'pending');
  assert.equal(f.calls.some(row => row[0] === 'query'), false);
  await tick(); assert.equal(admitted, false);
  prior.resolve();
  const token = await pending;
  f.owner.checkNativeModPersistenceReservation(token);
  assert.equal(f.owner.getNativeModPersistenceReservation().phase, 'reserved');
  assert.deepEqual(f.calls.map(row => row[0]), ['begin', 'set', 'commit', 'query']);
});

integration('delayed query plus new overlap refuses the whole batch and cannot mint an owner', async () => {
  const gate = deferred();
  const f = fixture({query: () => gate.promise});
  const admission = f.owner.reserveNativeModPersistence('fixture', 'new');
  const rejected = assert.rejects(admission, /changed/);
  await tick();
  assert.throws(() => f.owner.applyDiffOperations('persistent', [
    set(['mods', 'unrelated', 'safe']), set(['mods', 'fixture', 'new', 'state']),
  ]), /reserved/);
  held(f); gate.resolve(false); await rejected;
  await f.owner.finalizeWrite(); assert.equal(writes(f).length, 0);
});

integration('both batch entrypoints refuse exact target, ancestors, descendants and all-profile state', async () => {
  const conflicting = [
    ['mods'], ['mods', 'fixture'], ['mods', 'fixture', 'new'],
    ['mods', 'fixture', 'new', 'attributes', 'name'],
    ['profiles'], ['profiles', 'other-profile'], ['profiles', 'other-profile', 'modState'],
    ['profiles', 'other-profile', 'modState', 'new'],
    ['profiles', 'other-profile', 'modState', 'new', 'enabled'],
    ['profiles', 'another-game-profile', 'modState', 'new', 'disabledTime'],
    ['unrelated###ambiguous'],
  ];
  for (const entry of ['ordinary', 'acknowledged']) {
    for (const parts of conflicting) {
      for (const operation of [set, remove]) {
        const f = fixture();
        const token = await f.owner.reserveNativeModPersistence('fixture', 'new');
        const batch = [set(['mods', 'other-game', 'safe']), operation(parts)];
        if (entry === 'ordinary') assert.throws(() => f.owner.applyDiffOperations('persistent', batch), /reserved/);
        else await assert.rejects(f.owner.applyDiffOperationsAcknowledged('persistent', batch), /reserved/);
        held(f);
        assert.throws(() => f.owner.checkNativeModPersistenceReservation(token), /mismatch/);
        await f.owner.finalizeWrite(); assert.equal(writes(f).length, 0, `${entry}:${parts.join('/')}`);
      }
    }
  }
});

integration('mod-prefix neighbors and safe profile fields remain writable without broad collection locking', async () => {
  const f = fixture();
  const token = await f.owner.reserveNativeModPersistence('fixture', 'new');
  const safe = [
    ['mods', 'fixture', 'newer', 'state'], ['mods', 'other-game', 'new', 'state'],
    ['profiles', 'profile', 'name'], ['profiles', 'profile', 'gameId'],
    ['profiles', 'profile', 'modState', 'newer', 'enabled'], ['unrelated'],
  ];
  f.owner.applyDiffOperations('persistent', safe.map(p => set(p)));
  await f.owner.applyDiffOperationsAcknowledged('persistent', safe.map(p => remove(p)));
  await f.owner.finalizeWrite();
  assert.equal(writes(f).length, safe.length * 2);
  f.owner.checkNativeModPersistenceReservation(token);
});

integration('ordinary and acknowledged waiting batches detach paths and nested values before mutation', async () => {
  for (const entry of ['ordinary', 'acknowledged']) {
    const gate = deferred();
    const f = fixture({query: () => gate.promise});
    const admission = f.owner.reserveNativeModPersistence('fixture', 'new');
    await tick();
    const input = [set(['mods', 'fixture', 'safe'], {id: 'safe', nested: {enabled: false}})];
    const queued = entry === 'ordinary' ? f.owner.applyDiffOperations('persistent', input)
      : f.owner.applyDiffOperationsAcknowledged('persistent', input);
    input[0].path[2] = 'new'; input[0].value.nested.enabled = true;
    input.push(set(['mods', 'fixture', 'new']));
    gate.resolve(false); const token = await admission;
    await queued; await f.owner.finalizeWrite();
    assert.deepEqual(writes(f), [['set', ['mods', 'fixture', 'safe'], '{"id":"safe","nested":{"enabled":false}}']]);
    f.owner.checkNativeModPersistenceReservation(token);
  }
});

integration('duplicate reservation and counterfeit owner cannot replace or acquire the held capability', async () => {
  const f = fixture();
  const token = await f.owner.reserveNativeModPersistence('fixture', 'new');
  assert.ok(Object.isFrozen(token));
  for (const target of [['fixture', 'new'], ['different', 'other']]) {
    await assert.rejects(f.owner.reserveNativeModPersistence(...target), /already held/);
  }
  for (const fake of [{}, Object.freeze({}), null, undefined]) {
    assert.throws(() => f.owner.checkNativeModPersistenceReservation(fake), /mismatch/);
  }
  f.owner.checkNativeModPersistenceReservation(token);
  assert.equal(f.calls.filter(row => row[0] === 'query').length, 1);
});

integration('read conflicts and exact read errors leave a permanent hold, never an absence result', async () => {
  const primary = Error('own query failure');
  for (const query of [async () => true, async () => {throw primary;}]) {
    const f = fixture({query});
    const admission = f.owner.reserveNativeModPersistence('fixture', 'new');
    await assert.rejects(admission, error => error === primary || /already exists/.test(error.message));
    held(f);
    await assert.rejects(f.owner.reserveNativeModPersistence('fixture', 'new'), /already held/);
    await f.owner.finalizeWrite(); assert.equal(writes(f).length, 0);
  }
});

integration('direct persistent hydration replacement is refused before reading or changing the backend', async () => {
  const f = fixture();
  const token = await f.owner.reserveNativeModPersistence('fixture', 'new');
  const foreign = {getAllKVs: () => assert.fail('must not begin replacement hydration')};
  await assert.rejects(f.owner.insertPersistor('persistent', foreign), /cannot be replaced/);
  held(f); assert.equal(f.owner.mPersistors.persistent, f.backend);
  assert.throws(() => f.owner.checkNativeModPersistenceReservation(token), /mismatch/);
});

integration('hydration already in flight cannot replace the persistent backend after reservation begins', async () => {
  const gate = deferred();
  const f = fixture();
  const foreign = {getAllKVs: () => gate.promise, setResetCallback: () => assert.fail('foreign reset must not register')};
  const hydration = f.owner.insertPersistor('persistent', foreign);
  const rejected = assert.rejects(hydration, /cannot be replaced/);
  const token = await f.owner.reserveNativeModPersistence('fixture', 'new');
  gate.resolve([]); await rejected;
  held(f); assert.equal(f.owner.mPersistors.persistent, f.backend);
  assert.throws(() => f.owner.checkNativeModPersistenceReservation(token), /mismatch/);
});

integration('query-time persistor replacement is detected even when no public setter was used', async () => {
  const gate = deferred();
  const f = fixture({query: () => gate.promise});
  const admission = f.owner.reserveNativeModPersistence('fixture', 'new');
  const rejected = assert.rejects(admission, /changed/);
  await tick(); f.owner.mPersistors.persistent = {};
  gate.resolve(false); await rejected; held(f);
});

integration('level or invalidator replacement during query is held and original objects stay installed', async () => {
  for (const changed of ['level', 'invalidator']) {
    const gate = deferred();
    const f = fixture({query: () => gate.promise});
    const admission = f.owner.reserveNativeModPersistence('fixture', 'new');
    const rejected = assert.rejects(admission, /changed/);
    await tick();
    assert.throws(() => f.owner.setQueryInvalidator(changed === 'level' ? {} : f.level,
      changed === 'invalidator' ? {} : f.invalidator), /cannot be replaced/);
    gate.resolve(false); await rejected; held(f);
  }
});

integration('unrelated writes can continue after conflict but never restore the owner or create a release path', async () => {
  const f = fixture();
  const token = await f.owner.reserveNativeModPersistence('fixture', 'new');
  assert.throws(() => f.owner.applyDiffOperations('persistent', [remove(['mods', 'fixture', 'new'])]));
  f.owner.applyDiffOperations('persistent', [set(['mods', 'fixture', 'safe'])]);
  await f.owner.finalizeWrite(); assert.equal(writes(f).length, 1); held(f);
  assert.throws(() => f.owner.checkNativeModPersistenceReservation(token), /mismatch/);
  const status = f.owner.getNativeModPersistenceReservation();
  assert.ok(Object.isFrozen(status));
  assert.equal(status.effectsAllowed, false); assert.equal(status.installationPermit, false);
  assert.equal(status.releaseSupported, false); assert.equal(Object.hasOwn(status, 'owner'), false);
  assert.equal(f.owner.releaseNativeModPersistenceReservation, undefined);
});

integration('previous accepted legacy or acknowledged failure prevents admission despite a drained queue', async () => {
  for (const entry of ['ordinary', 'acknowledged']) {
    const gate = deferred();
    const primary = Error('prior owned failure');
    const f = fixture({write: () => gate.promise});
    const earlier = entry === 'ordinary'
      ? f.owner.applyDiffOperations('persistent', [set(['mods', 'fixture', 'old'])])
      : f.owner.applyDiffOperationsAcknowledged('persistent', [set(['mods', 'fixture', 'old'])]);
    const observedEarlier = entry === 'acknowledged' ? assert.rejects(earlier, error => error === primary) : undefined;
    const admission = f.owner.reserveNativeModPersistence('fixture', 'new');
    const rejected = assert.rejects(admission, /changed/);
    gate.reject(primary);
    await observedEarlier; await rejected; await f.owner.finalizeWrite();
    held(f);
    assert.equal(f.calls.filter(row => row[0] === 'query').length, 0);
  }
});

integration('later unrelated batch failure holds an admitted owner instead of silently recovering admission', async () => {
  for (const entry of ['ordinary', 'acknowledged']) {
    const primary = Error('later owned failure');
    const f = fixture({write: () => {throw primary;}});
    const token = await f.owner.reserveNativeModPersistence('fixture', 'new');
    if (entry === 'ordinary') f.owner.applyDiffOperations('persistent', [set(['mods', 'fixture', 'safe'])]);
    else await assert.rejects(f.owner.applyDiffOperationsAcknowledged('persistent', [set(['mods', 'fixture', 'safe'])]),
      error => error === primary);
    await f.owner.finalizeWrite(); held(f);
    assert.throws(() => f.owner.checkNativeModPersistenceReservation(token), /mismatch/);
  }
});

integration('only an exact false backend conflict result can admit the owner', async () => {
  for (const result of [undefined, null, 0, '', {}, []]) {
    const f = fixture({query: async () => result});
    await assert.rejects(f.owner.reserveNativeModPersistence('fixture', 'new'), /already exists/);
    held(f); assert.equal(writes(f).length, 0);
  }
});

integration('backend query reentry cannot hide a target conflict by catching it and returning false', async () => {
  let f;
  f = fixture({query: () => {
    assert.throws(() => f.owner.applyDiffOperations('persistent', [set(['mods', 'fixture', 'new'])]), /reserved/);
    return false;
  }});
  await assert.rejects(f.owner.reserveNativeModPersistence('fixture', 'new'), /changed/);
  held(f); await f.owner.finalizeWrite(); assert.equal(writes(f).length, 0);
});
