'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { importLocalArchiveReady } = require('./local-import-readiness.cjs');
const SHA = 'a'.repeat(64);

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function fixture() {
  const callback = deferred();
  const state = { imports: 0, guards: 0, clock: 0, rows: [{ id: 'baseline', state: 'finished' }], events: [] };
  const ready = (id = 'new_1') => ({ id, state: 'finished', game: ['cyberpunk2077'], localPath: 'Own.zip', modInfo: {} });
  const options = {
    expected: { gameId: 'cyberpunk2077', fileName: 'Own.zip', downloadRoot: 'D:\\Downloads', bytes: 123, sha256: SHA },
    baselineDownloadIds: ['baseline'],
    readDownloads: () => structuredClone(state.rows),
    importOnce: () => { ++state.imports; state.rows.push(ready()); return callback.promise; },
    assertOperationalState: () => { ++state.guards; },
    getFileProof: path => ({ path, regularFile: true, reparse: false, bytes: 123, sha256: SHA }),
    record: event => { state.events.push(event); },
    now: () => state.clock,
    sleep: async ms => { state.clock += ms; }, timeoutMs: 30, pollIntervalMs: 10,
  };
  return { state, options, callback, ready };
}

test('finished exact file becomes ready before delayed metadata callback; callback still observed', async () => {
  const f = fixture();
  const result = await importLocalArchiveReady(f.options);
  assert.equal(result.downloadId, 'new_1');
  assert.equal(result.readyBeforeCallback, true);
  assert.equal(f.state.imports, 1);
  assert(!f.state.events.some(e => e.phase === 'import_callback'));
  f.callback.resolve(['new_1']);
  assert.equal((await result.callbackObservation).status, 'resolved');
  assert(f.state.events.some(e => e.phase === 'import_callback' && e.status === 'resolved'));
});

test('late callback rejection is handled and recorded without reimport', async () => {
  const f = fixture();
  const result = await importLocalArchiveReady(f.options);
  f.callback.reject(new Error('private upstream details'));
  const observed = await result.callbackObservation;
  assert.equal(observed.status, 'rejected');
  assert.equal(observed.code, 'IMPORT_CALLBACK_FAILED');
  assert.equal(f.state.imports, 1);
  assert(!JSON.stringify(f.state.events).includes('private upstream'));
});

test('late mismatching callback ID remains a visible reconciliation failure', async () => {
  const f = fixture();
  const result = await importLocalArchiveReady(f.options);
  f.callback.resolve(['wrong']);
  assert.equal((await result.callbackObservation).code, 'IMPORT_CALLBACK_RECORD_MISMATCH');
});

test('ambiguous newly registered archives fail closed', async () => {
  const f = fixture();
  f.options.importOnce = () => { ++f.state.imports; f.state.rows.push(f.ready('one'), f.ready('two')); return f.callback.promise; };
  await assert.rejects(importLocalArchiveReady(f.options), { code: 'AMBIGUOUS_IMPORTED_DOWNLOADS' });
  assert.equal(f.state.imports, 1);
});

test('wrong archive bytes fail instead of waiting for callback or importing again', async () => {
  const f = fixture();
  f.options.getFileProof = path => ({ path, regularFile: true, reparse: false, bytes: 123, sha256: 'b'.repeat(64) });
  await assert.rejects(importLocalArchiveReady(f.options), { code: 'IMPORT_ARCHIVE_PROOF_MISMATCH' });
  assert.equal(f.state.imports, 1);
});

test('operational drift after invocation prevents readiness', async () => {
  const f = fixture();
  f.options.assertOperationalState = () => { if (++f.state.guards === 3) throw Error('profile/owner changed'); };
  await assert.rejects(importLocalArchiveReady(f.options), { code: 'IMPORT_OPERATIONAL_DRIFT' });
  assert.equal(f.state.imports, 1);
});

test('existing tracked archive requires reuse and never invokes import', async () => {
  const f = fixture();
  f.state.rows[0] = f.ready('baseline');
  await assert.rejects(importLocalArchiveReady(f.options), { code: 'EXISTING_ARCHIVE_REQUIRES_REUSE' });
  assert.equal(f.state.imports, 0);
});

test('timeout keeps late callback observation and never invokes import twice', async () => {
  const f = fixture();
  f.options.importOnce = () => { ++f.state.imports; return f.callback.promise; };
  await assert.rejects(importLocalArchiveReady(f.options), { code: 'IMPORT_READINESS_TIMEOUT_RECONCILE' });
  f.callback.resolve(['late']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.imports, 1);
  assert(f.state.events.some(e => e.phase === 'import_callback' && e.status === 'resolved'));
});

test('legacy alternate Nexus identity container is not hidden by empty primary container', async () => {
  const f = fixture();
  f.options.importOnce = () => {
    ++f.state.imports;
    f.state.rows.push({ ...f.ready(), modInfo: { nexus: { ids: {} }, ids: { mod_id: 123 } } });
    return f.callback.promise;
  };
  await assert.rejects(importLocalArchiveReady(f.options), { code: 'IMPORT_NEXUS_IDENTITY_APPEARED' });
});

test('file identity change while proof awaits is rejected', async () => {
  const f = fixture();
  f.options.getFileProof = async path => {
    f.state.rows[1].game = ['other'];
    return { path, regularFile: true, reparse: false, bytes: 123, sha256: SHA };
  };
  await assert.rejects(importLocalArchiveReady(f.options), { code: 'IMPORT_GAME_SCOPE_CHANGED' });
});

test('hung injected I/O is bounded and leaves an uncertain-operation error', async () => {
  const f = fixture();
  f.options.now = Date.now;
  f.options.timeoutMs = 20;
  f.options.getFileProof = () => new Promise(() => {});
  await assert.rejects(importLocalArchiveReady(f.options), { code: 'IMPORT_ADAPTER_TIMEOUT_RECONCILE' });
  assert.equal(f.state.imports, 1);
});

test('late callback receipt failure is reported without unhandled rejection', async () => {
  const f = fixture();
  f.options.record = event => { if (event.phase === 'import_callback') throw Error('disk unavailable'); };
  const result = await importLocalArchiveReady(f.options);
  f.callback.resolve(['new_1']);
  assert.equal((await result.callbackObservation).receiptFailed, true);
});

test('async receipt writer is rejected before invocation and its rejection is handled', async () => {
  const f = fixture();
  f.options.record = () => Promise.reject(Error('not a durable synchronous receipt'));
  await assert.rejects(importLocalArchiveReady(f.options), { code: 'IMPORT_RECEIPT_FAILED' });
  assert.equal(f.state.imports, 0);
});
