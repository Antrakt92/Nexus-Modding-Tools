'use strict';

// An internal helper for a reviewed native one-shot. This is not an adapter tool
// and does not install, enable, dispatch events, read credentials or touch files.
const path = require('node:path').win32;

class ImportReadinessError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ImportReadinessError';
    this.code = code;
    this.reconcileRequired = true;
  }
}

const fail = code => { throw new ImportReadinessError(code); };
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const normalize = p => path.resolve(p).replace(/\\/g, '/').toLowerCase();

function localIdentity(row) {
  const m = row.modInfo;
  const holders = [row, row.attributes, row.ids, row.nexus?.ids, m, m?.ids,
    m?.nexus?.ids, m?.meta, m?.meta?.details, m?.meta?.value?.details];
  for (const holder of holders) {
    if (holder?.source === 'nexus') return false;
    for (const key of ['modId', 'mod_id', 'fileId', 'file_id']) {
      const value = holder?.[key];
      if (value !== undefined && value !== null && !['', '0'].includes(String(value).trim())) return false;
    }
  }
  return true;
}

function validateExpected(expected) {
  if (!expected || typeof expected.gameId !== 'string' || !expected.gameId
      || typeof expected.fileName !== 'string' || !expected.fileName
      || expected.fileName !== path.basename(expected.fileName)
      || /[\\/:]/.test(expected.fileName) || ['.', '..'].includes(expected.fileName)
      || typeof expected.downloadRoot !== 'string' || !path.isAbsolute(expected.downloadRoot)
      || !Number.isSafeInteger(expected.bytes) || expected.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(expected.sha256)) fail('INVALID_IMPORT_EXPECTATION');
}

/**
 * Call a caller-supplied native import once, then reconcile its exact new record.
 * readDownloads returns only download identity/state/path fields, never whole state.
 * assertOperationalState must protect profile/paths/flags/mods/deployed ownership.
 * getFileProof must reject symlink/reparse traversal and return its independently
 * checked path, regularFile:true, reparse:false, bytes and SHA-256.
 * record is a synchronous durable receipt writer supplied by the one-shot.
 * Keep callbackObservation attached until it settles: readiness is not metadata
 * completion, and a late callback failure must remain visible to the caller.
 */
async function importLocalArchiveReady(options) {
  const { expected: expectation, baselineDownloadIds, readDownloads, importOnce, getFileProof,
    assertOperationalState, record, timeoutMs = 30000, pollIntervalMs = 100,
    now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options || {};
  validateExpected(expectation);
  const expected = Object.freeze(Object.fromEntries(
    ['gameId', 'fileName', 'downloadRoot', 'bytes', 'sha256'].map(key => [key, expectation[key]])));
  if (!Array.isArray(baselineDownloadIds) || baselineDownloadIds.some(id => !validId(id))
      || new Set(baselineDownloadIds).size !== baselineDownloadIds.length
      || ![readDownloads, importOnce, getFileProof, assertOperationalState, record, now, sleep]
        .every(fn => typeof fn === 'function')
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000
      || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > timeoutMs)
    fail('INVALID_IMPORT_OPTIONS');
  const baseline = new Set(baselineDownloadIds);
  const deadline = now() + timeoutMs;
  const bounded = async (promise, checkCompletion = true) => {
    let timer;
    try {
      const result = await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ImportReadinessError('IMPORT_ADAPTER_TIMEOUT_RECONCILE')),
          Math.max(1, deadline - now()));
      })]);
      // A synchronous/CPU-bound adapter can finish after the deadline before
      // the event loop runs its timer. Never turn that race into readiness.
      if (checkCompletion && now() >= deadline) fail('IMPORT_ADAPTER_TIMEOUT_RECONCILE');
      return result;
    } finally { clearTimeout(timer); }
  };
  let receiptFailed = false;
  const emit = event => {
    try {
      const result = record(event);
      if (result && typeof result.then === 'function') {
        // A promise does not prove that the required durable marker was written.
        receiptFailed = true;
        Promise.resolve(result).catch(() => {});
      }
    }
    catch { receiptFailed = true; }
  };
  const guard = async () => {
    if (receiptFailed) fail('IMPORT_RECEIPT_FAILED');
    if (now() >= deadline) fail('IMPORT_READINESS_TIMEOUT_RECONCILE');
    try { await bounded(assertOperationalState()); }
    catch (error) {
      if (error instanceof ImportReadinessError) throw error;
      fail('IMPORT_OPERATIONAL_DRIFT');
    }
  };
  async function rows() {
    const current = await bounded(readDownloads());
    if (!Array.isArray(current) || current.some(row => !row || !validId(row.id))
        || new Set(current.map(row => row.id)).size !== current.length)
      fail('INVALID_DOWNLOAD_PROJECTION');
    const ids = new Set(current.map(row => row.id));
    if ([...baseline].some(id => !ids.has(id))) fail('BASELINE_DOWNLOAD_REMOVED');
    return current;
  }
  function scope(row) {
    const games = Array.isArray(row.game) ? row.game : [row.game];
    if (games.length !== 1 || games[0] !== expected.gameId) fail('IMPORT_GAME_SCOPE_CHANGED');
    if (typeof row.localPath !== 'string' || row.localPath.toLowerCase() !== expected.fileName.toLowerCase()
        || path.basename(row.localPath) !== row.localPath) fail('IMPORT_PATH_CHANGED');
    if (!localIdentity(row)) fail('IMPORT_NEXUS_IDENTITY_APPEARED');
  }
  async function checkImported(downloadId, code) {
    const checked = await rows();
    const added = checked.filter(row => !baseline.has(row.id));
    if (added.length !== 1 || added[0].id !== downloadId || added[0].state !== 'finished') fail(code);
    scope(added[0]);
  }
  const target = path.join(expected.downloadRoot, expected.fileName);
  async function proofFor(row) {
    scope(row);
    const proof = await bounded(getFileProof(target));
    if (!proof || typeof proof.path !== 'string' || !path.isAbsolute(proof.path)
        || normalize(proof.path) !== normalize(target)
        || normalize(path.dirname(proof.path)) !== normalize(expected.downloadRoot)
        || proof.regularFile !== true || proof.reparse !== false
        || proof.bytes !== expected.bytes || proof.sha256 !== expected.sha256)
      fail('IMPORT_ARCHIVE_PROOF_MISMATCH');
    return { path: proof.path, bytes: proof.bytes, sha256: proof.sha256 };
  }
  await guard();
  const initial = await rows();
  if (initial.some(row => !baseline.has(row.id))) fail('IMPORT_BASELINE_IDS_CHANGED');
  if (initial.some(row => typeof row.localPath === 'string'
      && row.localPath.toLowerCase() === expected.fileName.toLowerCase()))
    fail('EXISTING_ARCHIVE_REQUIRES_REUSE');
  emit({ phase: 'import_invocation', invocationCount: 1 });
  await guard();

  let callbackState = { status: 'pending' };
  let seenNewId, readyId;
  let importPromise;
  try { importPromise = importOnce(); }
  catch { importPromise = Promise.reject(new ImportReadinessError('IMPORT_CALLBACK_FAILED')); }
  const callbackObservation = Promise.resolve(importPromise).then(ids => {
    callbackState = Array.isArray(ids) && ids.length === 1 && ids.every(validId)
      ? { status: 'resolved', ids: [...ids] }
      : { status: 'invalid', code: 'IMPORT_CALLBACK_INVALID' };
    if (readyId && callbackState.status === 'resolved' && ids[0] !== readyId)
      callbackState = { status: 'invalid', code: 'IMPORT_CALLBACK_RECORD_MISMATCH' };
    emit({ phase: 'import_callback', ...callbackState });
    return { ...callbackState, receiptFailed };
  }, () => {
    callbackState = { status: 'rejected', code: 'IMPORT_CALLBACK_FAILED' };
    emit({ phase: 'import_callback', ...callbackState });
    return { ...callbackState, receiptFailed };
  });
  try {
    while (true) {
      await guard();
      const current = await rows();
      const added = current.filter(row => !baseline.has(row.id));
      if (added.length > 1) fail('AMBIGUOUS_IMPORTED_DOWNLOADS');
      if (seenNewId && (!added.length || added[0].id !== seenNewId)) fail('IMPORTED_DOWNLOAD_DISAPPEARED');
      if (added.length) {
        const row = added[0];
        scope(row);
        seenNewId = row.id;
        if (['failed', 'paused', 'redirect', 'removed', 'cancelled'].includes(row.state))
          fail('IMPORT_DOWNLOAD_FAILED');
        if (!['init', 'started', 'finalizing', 'finished'].includes(row.state))
          fail('IMPORT_DOWNLOAD_STATE_UNKNOWN');
        if (row.state === 'finished') {
          const downloadId = row.id;
          const proof = await proofFor(row);
          await guard();
          // Hashing can await I/O. Re-read identity after that boundary.
          await checkImported(downloadId, 'IMPORTED_DOWNLOAD_CHANGED_DURING_PROOF');
          if (['invalid', 'rejected'].includes(callbackState.status)) fail(callbackState.code);
          if (callbackState.status === 'resolved' && callbackState.ids[0] !== downloadId)
            fail('IMPORT_CALLBACK_RECORD_MISMATCH');
          readyId = downloadId;
          await guard();
          await checkImported(downloadId, 'IMPORTED_DOWNLOAD_CHANGED_BEFORE_READY');
          if (['invalid', 'rejected'].includes(callbackState.status)) fail(callbackState.code);
          const readyBeforeCallback = callbackState.status === 'pending';
          emit({ phase: 'import_ready', downloadId, readyBeforeCallback,
            archiveSHA256: proof.sha256, archiveBytes: proof.bytes });
          if (receiptFailed) fail('IMPORT_RECEIPT_FAILED');
          return { downloadId, proof, readyBeforeCallback, callbackObservation };
        }
      }
      if (['invalid', 'rejected'].includes(callbackState.status)) fail(callbackState.code);
      if (now() >= deadline) fail('IMPORT_READINESS_TIMEOUT_RECONCILE');
      // Sleeping to the boundary is normal; the next guard owns poll expiry.
      await bounded(sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now()))), false);
    }
  } catch (error) {
    const code = error instanceof ImportReadinessError ? error.code : 'IMPORT_READINESS_FAILED';
    emit({ phase: 'import_readiness_failed', code, downloadId: seenNewId, noReplay: true });
    throw error instanceof ImportReadinessError ? error : new ImportReadinessError(code);
  }
}

module.exports = { importLocalArchiveReady, ImportReadinessError };
