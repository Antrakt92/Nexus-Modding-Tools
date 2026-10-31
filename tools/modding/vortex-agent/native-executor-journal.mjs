import fs from 'node:fs';
import path from 'node:path';
import paths from './paths.cjs';
import dispatch from './native-dispatch-contract.cjs';
import {createNativeIntentJournal} from './native-intent-journal.mjs';
import {createImmutableRecordIO, identity, generation} from './immutable-records.mjs';

const need = (ok, code) => {if (!ok) throw Error('NATIVE_EXECUTOR_' + code);};
const id = (value, prefix) => typeof value === 'string' && new RegExp('^' + prefix + '_[a-f0-9]{32}$').test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const BINDING_KEYS = ['schema', 'operationId', 'nativeJobId', 'requestSHA256', 'packetSHA256',
  'workerLifetime', 'rootId', 'jobsRootId', 'directoryId'];
const io = createImmutableRecordIO({maxBytes: 8192, prefix: 'NATIVE_EXECUTOR_'});

function safe(fn) {
  try {return fn();}
  catch (error) {
    if (/^NATIVE_EXECUTOR_[A-Z_]+$/.test(error?.message || '')) throw Error(error.message);
    const intent = /^NATIVE_INTENT_([A-Z_]+)$/.exec(error?.message || '');
    throw Error(intent ? 'NATIVE_EXECUTOR_INTENT_' + intent[1] : 'NATIVE_EXECUTOR_IO_FAILED');
  }
}
function checked(bytes) {
  try {return dispatch.parseDispatchRequest(bytes);}
  catch {throw Error('NATIVE_EXECUTOR_INVALID_REQUEST');}
}
function names(dir) {
  const handle = fs.opendirSync(dir), entries = [];
  try {
    let entry;
    while ((entry = handle.readSync()) !== null) {
      entries.push(entry.name); if (entries.length > 1) break;
    }
  } finally {handle.closeSync();}
  return entries;
}

// Both indexes are permanent holds. Observation is never a dispatch or cleanup
// permit, including when only one side survived an interrupted publication.
export function createNativeExecutorJournal(options = {}) {
  need(exact(options, []) || exact(options, ['root']), 'INVALID_OPTIONS');
  const candidate = options.root ?? path.join(paths.resolvePaths().build, 'native-install-executor');
  need(typeof candidate === 'string' && candidate.length <= 4096 && path.isAbsolute(candidate)
    && !/[\x00-\x1f]/.test(candidate), 'INVALID_ROOT');
  const root = path.resolve(candidate), jobsRoot = path.join(root, 'jobs');
  const intents = createNativeIntentJournal({root: path.join(root, 'operations')});
  const seenJobs = new Set();
  let rootPins, jobsPins;
  function roots(create) {
    const current = io.ancestry(root, create);
    if (rootPins) {need(current, 'PATH_CHANGED'); io.sameAncestry(root, rootPins);}
    else if (current) rootPins = current;
    return current;
  }
  function jobs(create) {
    const current = io.ancestry(jobsRoot, create);
    io.sameAncestry(root, rootPins);
    if (jobsPins) {need(current, 'PATH_CHANGED'); io.sameAncestry(jobsRoot, jobsPins);}
    else if (current) jobsPins = current;
    return current;
  }
  function result(operationId, nativeJobId, intent = null, binding = null) {
    const intentObserved = intent?.state === 'intent_observed';
    const jobReservationObserved = binding !== null;
    return Object.freeze({schema: 'native-executor-status/1', operationId, nativeJobId,
      state: intentObserved ? jobReservationObserved ? 'reserved' : 'intent_only'
        : jobReservationObserved ? 'reservation_only' : 'not_observed',
      intentObserved, jobReservationObserved, request: intentObserved ? intent.request : null,
      requestSHA256: intentObserved ? intent.requestSHA256 : binding?.requestSHA256 ?? null,
      packetSHA256: binding?.packetSHA256 ?? null, workerLifetime: binding?.workerLifetime ?? null,
      dispatchState: 'unknown', reconcileRequired: true, canReplay: false,
      effectsAllowed: false, powerLossPersistenceVerified: false});
  }
  function reservation(operationId, requestSHA256, nativeJobId, packetSHA256) {
    if (!jobs(false)) return null;
    const dir = path.join(jobsRoot, nativeJobId); let stat;
    try {stat = fs.lstatSync(dir, {bigint: true});}
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      need(!seenJobs.has(nativeJobId), 'PATH_CHANGED'); return null;
    }
    seenJobs.add(nativeJobId);
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_PATH');
    const pins = io.ancestry(dir);
    // Do not adopt replacement ancestors discovered while finding the child.
    io.sameAncestry(root, rootPins); io.sameAncestry(jobsRoot, jobsPins);
    need(JSON.stringify(names(dir)) === '["binding.json"]', 'CORRUPT');
    const observations = new Map(), file = path.join(dir, 'binding.json');
    const record = io.readJSON(file, observations);
    need(exact(record, BINDING_KEYS) && record.schema === 'native-executor-binding/1'
      && id(record.operationId, 'op') && id(record.nativeJobId, 'exec')
      && id(record.workerLifetime, 'worker') && sha(record.requestSHA256) && sha(record.packetSHA256)
      && record.rootId === rootPins.get(root) && record.jobsRootId === jobsPins.get(jobsRoot)
      && record.directoryId === identity(stat), 'CORRUPT');
    need(record.operationId === operationId && record.nativeJobId === nativeJobId
      && record.requestSHA256 === requestSHA256 && record.packetSHA256 === packetSHA256, 'BINDING_MISMATCH');
    io.sameAncestry(dir, pins);
    need(JSON.stringify(names(dir)) === '["binding.json"]'
      && generation(fs.lstatSync(file, {bigint: true})) === observations.get(file), 'CHANGED');
    io.sameAncestry(dir, pins);
    return record;
  }
  function read(operationId, expectedRequestSHA256, expectedNativeJobId, expectedPacketSHA256) {
    return safe(() => {
      need(id(operationId, 'op') && id(expectedNativeJobId, 'exec'), 'INVALID_ID');
      need(sha(expectedRequestSHA256) && sha(expectedPacketSHA256), 'INVALID_BINDING');
      if (!roots(false)) return result(operationId, expectedNativeJobId);
      const intent = intents.read(operationId, expectedRequestSHA256);
      io.sameAncestry(root, rootPins);
      if (intent.state === 'intent_observed')
        need(intent.request.nativeJobId === expectedNativeJobId, 'JOB_BINDING_MISMATCH');
      const binding = reservation(operationId, expectedRequestSHA256, expectedNativeJobId, expectedPacketSHA256);
      io.sameAncestry(root, rootPins);
      if (jobsPins) io.sameAncestry(jobsRoot, jobsPins);
      return result(operationId, expectedNativeJobId, intent, binding);
    });
  }
  function begin(requestBytes, workerLifetime, packetSHA256) {
    return safe(() => {
      const request = checked(requestBytes);
      need(id(workerLifetime, 'worker'), 'INVALID_WORKER_LIFETIME');
      need(sha(packetSHA256), 'INVALID_BINDING');
      const canonicalBytes = Buffer.from(JSON.stringify(request));
      const requestSHA256 = dispatch.dispatchRequestDigest(canonicalBytes);
      roots(true);
      // Publish the operation hold first. A failed job reservation must never
      // refund it, remove either index, or authorize another worker attempt.
      intents.begin(canonicalBytes);
      io.sameAncestry(root, rootPins);
      jobs(true);
      const dir = path.join(jobsRoot, request.nativeJobId);
      try {fs.mkdirSync(dir, {mode: 0o700});}
      catch (error) {if (error.code === 'EEXIST') throw Error('NATIVE_EXECUTOR_JOB_EXISTS_HOLD'); throw error;}
      seenJobs.add(request.nativeJobId);
      const pins = io.ancestry(dir);
      io.sameAncestry(root, rootPins); io.sameAncestry(jobsRoot, jobsPins);
      const bytes = Buffer.from(JSON.stringify({schema: 'native-executor-binding/1',
        operationId: request.operationId, nativeJobId: request.nativeJobId, requestSHA256,
        packetSHA256, workerLifetime, rootId: rootPins.get(root),
        jobsRootId: jobsPins.get(jobsRoot), directoryId: pins.get(dir)}) + '\n');
      need(bytes.length <= 8192, 'LIMIT');
      const guard = () => {
        io.sameAncestry(root, rootPins); io.sameAncestry(jobsRoot, jobsPins);
        io.sameAncestry(dir, pins); need(names(dir).length === 0, 'CHANGED');
      };
      io.publish(dir, 'binding.json', bytes, pins, guard);
      const observed = read(request.operationId, requestSHA256, request.nativeJobId, packetSHA256);
      need(observed.state === 'reserved' && observed.workerLifetime === workerLifetime, 'CHANGED');
      return observed;
    });
  }
  return Object.freeze({begin, read});
}
