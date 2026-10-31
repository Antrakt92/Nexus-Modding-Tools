import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {applyExact} from './native-patch-test-fixture.mjs';

const folder = new URL('./native-patches/vortex-persistence-2.9.1/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('batch-acknowledgement.json', folder)));
const patch = fs.readFileSync(new URL('batch-acknowledgement.patch', folder), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const originalFile = process.env.VORTEX_NATIVE_PERSISTOR_SOURCE;
const integration = (name, fn) => test(name, {timeout: 5000,
  skip: originalFile ? false : 'Provide the pinned original ReduxPersistorIPC.ts'}, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return {promise, resolve, reject};};
const set = (name, value = name) => ({type: 'set', path: ['mods', name], value});
function fixture({baseline = false, write, transaction = false, commit, rollback, notify, logFailure} = {}) {
  const raw = fs.readFileSync(originalFile, 'utf8');
  assert.equal(sha(raw), manifest.inputSHA256);
  const patched = applyExact(raw, patch, manifest.upstreamPath);
  assert.equal(sha(patched), manifest.outputSHA256);
  const js = stripTypeScriptTypes(baseline ? raw : patched, {mode: 'transform'});
  const start = js.indexOf('class ReduxPersistorIPC {'), end = js.lastIndexOf('export default ReduxPersistorIPC;');
  assert(start >= 0 && end > start);
  const calls = [];
  const Persistor = vm.runInNewContext(js.slice(start, end)+'\nReduxPersistorIPC;', {
    structuredClone, unknownToError: error => error instanceof Error ? error : Error(String(error)),
    terminate: error => {calls.push(['terminate', error]); throw error;},
    log: (...args) => {calls.push(['log', ...args]); if (logFailure) throw logFailure;},
  }, {timeout: 1000});
  const owner = new Persistor();
  const backend = {setItem: async (key, value) => {calls.push(['set', [...key], value]); await write?.(key, value);},
    removeItem: async key => {calls.push(['remove', [...key]]);}};
  owner.mPersistors.persistent = backend;
  if (transaction) owner.setQueryInvalidator({
    beginTransaction: async () => {calls.push(['begin']);},
    getDirtyTables: async () => ['mods'],
    commitTransaction: async () => {calls.push(['commit']); await commit?.();},
    rollbackTransaction: async () => {calls.push(['rollback']); await rollback?.();},
  }, {notifyDirtyTables: () => {calls.push(['notify']); notify?.();}});
  return {owner, calls, backend};
}

test('persistence patch is exact-source preparation, separate from the renderer packet', () => {
  assert.equal(sha(patch), manifest.patchSHA256);
  assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
  assert.equal(manifest.upstreamPath, 'src/main/src/store/ReduxPersistorIPC.ts');
  assert.equal(manifest.preparedOnly, true);
  for (const key of ['installed','nativeAcceptanceVerified','installationPermit','powerLossPersistenceVerified']) assert.equal(manifest[key], false);
});

integration('baseline drain swallows a write failure; acknowledged batch preserves the exact failure', async () => {
  const primary = Error('own write failure');
  const before = fixture({baseline: true, write: async () => {throw primary;}});
  assert.equal(before.owner.applyDiffOperations('persistent', [set('own')]), undefined);
  await before.owner.finalizeWrite();
  assert.equal(before.calls.filter(row => row[0] === 'terminate').length, 1);
  const after = fixture({write: async () => {throw primary;}});
  await assert.rejects(after.owner.applyDiffOperationsAcknowledged('persistent', [set('own')]), error => error === primary);
  await after.owner.finalizeWrite();
  assert.equal(after.calls.filter(row => row[0] === 'terminate').length, 0);
});

integration('acknowledgement waits for this write and transaction commit', async () => {
  const write = deferred(), commit = deferred(); let done = false;
  const f = fixture({transaction: true, write: () => write.promise, commit: () => commit.promise});
  const result = f.owner.applyDiffOperationsAcknowledged('persistent', [set('own')]).then(() => {done = true;});
  await tick(); assert.equal(done, false); assert.equal(f.calls.some(row => row[0] === 'commit'), false);
  write.resolve(); await tick(); assert.equal(done, false); assert.equal(f.calls.some(row => row[0] === 'commit'), true);
  commit.resolve(); await result;
  assert.deepEqual(f.calls.map(row => row[0]), ['begin','set','commit','notify']);
});

integration('a later blocked batch does not delay an earlier exact acknowledgement', async () => {
  const gate = deferred();
  const f = fixture({write: key => key[1] === 'second' ? gate.promise : undefined});
  const first = f.owner.applyDiffOperationsAcknowledged('persistent', [set('first')]);
  let secondDone = false;
  const second = f.owner.applyDiffOperationsAcknowledged('persistent', [set('second')]).then(() => {secondDone = true;});
  await first; await tick(); assert.equal(secondDone, false);
  gate.resolve(); await second;
});

integration('queued batch detaches paths and nested values before the caller can mutate them', async () => {
  const gate = deferred(); const f = fixture({write: key => key[1] === 'block' ? gate.promise : undefined});
  const first = f.owner.applyDiffOperationsAcknowledged('persistent', [set('block')]);
  const input = [set('own', {id: 'own', nested: {enabled: false}})];
  const next = f.owner.applyDiffOperationsAcknowledged('persistent', input);
  input[0].path[1] = 'foreign'; input[0].value.nested.enabled = true; input.push(set('extra'));
  gate.resolve(); await Promise.all([first, next]);
  assert.deepEqual(f.calls.filter(row => row[0] === 'set').map(row => [row[1], row[2]]), [
    [['mods','block'], '"block"'], [['mods','own'], '{"id":"own","nested":{"enabled":false}}'],
  ]);
});

integration('failed acknowledged batch does not poison later ordinary or acknowledged writes', async () => {
  const primary = Error('first fails');
  const f = fixture({write: key => {if (key[1] === 'first') throw primary;}});
  const first = f.owner.applyDiffOperationsAcknowledged('persistent', [set('first')]);
  f.owner.applyDiffOperations('persistent', [set('legacy')]);
  const second = f.owner.applyDiffOperationsAcknowledged('persistent', [set('second')]);
  await assert.rejects(first, error => error === primary); await second; await f.owner.finalizeWrite();
  assert.deepEqual(f.calls.filter(row => row[0] === 'set').map(row => row[1][1]), ['first','legacy','second']);
});

integration('unknown hive and clone failures reject before enqueuing any write', async () => {
  const f = fixture();
  await assert.rejects(f.owner.applyDiffOperationsAcknowledged('missing', [set('own')]), /registered hive/);
  await assert.rejects(f.owner.applyDiffOperationsAcknowledged('persistent', [set('own', () => {})]));
  await f.owner.finalizeWrite(); assert.equal(f.calls.length, 0);
});

integration('sparse, unknown and malformed operations reject the whole batch before writes', async () => {
  const sparse = new Array(2); sparse[1] = set('must-write');
  const pathWithHole = ['mods', , 'own'];
  const malformed = [sparse, [set('first'), undefined], [null], [], [set('first'), {type: 'replace', path: ['own']}],
    [{type: 'remove', path: pathWithHole}], [{type: 'set', path: [], value: 1}],
    [{type: 'remove', path: ['own'], value: 1}], [{type: 'set', path: ['own']}]];
  const f = fixture();
  for (const ops of malformed) await assert.rejects(f.owner.applyDiffOperationsAcknowledged('persistent', ops));
  await f.owner.finalizeWrite(); assert.equal(f.calls.length, 0);
});

integration('inherited hive keys cannot select a fake backend or alter its registry prototype', async () => {
  const f = fixture(); let factoryCalls = 0;
  f.owner.setPersistorFactory(() => {factoryCalls++; return f.backend;});
  for (const hive of ['__proto__', 'constructor', 'prototype', ''])
    await assert.rejects(f.owner.applyDiffOperationsAcknowledged(hive, [set('own')]));
  assert.equal(factoryCalls, 0); assert.equal(f.calls.length, 0);
});

integration('factory-selected persistor is retained by this queued batch', async () => {
  const f = fixture(); let count = 0;
  f.owner.setPersistorFactory(hive => {assert.equal(hive, 'new'); count++; return f.backend;});
  await f.owner.applyDiffOperationsAcknowledged('new', [set('own')]);
  await f.owner.applyDiffOperationsAcknowledged('new', [set('next')]);
  assert.equal(count, 1);
  assert.deepEqual(f.calls.filter(row => row[0] === 'set').map(row => row[1][1]), ['own','next']);
});

integration('disk-full failure rejects once without the legacy terminate/retry path', async () => {
  const primary = Error('no space left on device'); const f = fixture({transaction: true, write: () => {throw primary;}});
  await assert.rejects(f.owner.applyDiffOperationsAcknowledged('persistent', [set('own')]), error => error === primary);
  assert.deepEqual(f.calls.map(row => row[0]), ['begin','set','rollback']);
});

integration('commit failure rejects; post-commit invalidator failure also cannot produce success', async () => {
  for (const phase of ['commit','notify']) {
    const primary = Error(phase+' failed'); const f = fixture({transaction: true, [phase]: () => {throw primary;}});
    await assert.rejects(f.owner.applyDiffOperationsAcknowledged('persistent', [set('own')]), error => error === primary);
    assert.equal(f.calls.some(row => row[0] === 'rollback'), true);
  }
});

integration('rollback or diagnostic failure never masks the acknowledged primary write error', async () => {
  const primary = Error('write failed'), secondary = Error('rollback failed');
  const f = fixture({transaction: true, write: () => {throw primary;}, rollback: () => {throw secondary;}, logFailure: Error('logger failed')});
  await assert.rejects(f.owner.applyDiffOperationsAcknowledged('persistent', [set('own')]), error => error === primary);
});
