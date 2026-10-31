import fs from 'node:fs';
import path from 'node:path';
import paths from './paths.cjs';
import dispatch from './native-dispatch-contract.cjs';
import {createImmutableRecordIO, identity, generation} from './immutable-records.mjs';

const MAX_BYTES = dispatch.LIMITS.bytes + 4096;
const need = (ok, code) => {if (!ok) throw Error('NATIVE_INTENT_' + code);};
const operationId = value => typeof value === 'string' && /^op_[a-f0-9]{32}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function safe(fn) {
  try {return fn();}
  catch (error) {throw Error(/^NATIVE_INTENT_[A-Z_]+$/.test(error?.message || '') ? error.message : 'NATIVE_INTENT_IO_FAILED');}
}
function checked(bytes) {
  try {return dispatch.parseDispatchRequest(bytes);}
  catch {throw Error('NATIVE_INTENT_INVALID_REQUEST');}
}
function names(dir) {
  // The schema permits one file. Stop after the first extra name, rather than
  // allocating an unbounded list from an interfered operation directory.
  const handle = fs.opendirSync(dir), entries = [];
  try {
    let entry;
    while ((entry = handle.readSync()) !== null) {
      entries.push(entry.name); if (entries.length > 1) break;
    }
  } finally {handle.closeSync();}
  return entries;
}
const io = createImmutableRecordIO({maxBytes: MAX_BYTES, prefix: 'NATIVE_INTENT_'});
function result(id, request = null, requestSHA256 = null) {
  return Object.freeze({schema: 'native-intent-status/1', operationId: id,
    state: request ? 'intent_observed' : 'not_observed', request, requestSHA256,
    dispatchState: 'unknown', reconcileRequired: true, canReplay: false,
    effectsAllowed: false, powerLossPersistenceVerified: false});
}
export function createNativeIntentJournal(options = {}) {
  need(exact(options, []) || exact(options, ['root']), 'INVALID_OPTIONS');
  const candidate = options.root ?? path.join(paths.resolvePaths().build, 'native-install-intents');
  need(typeof candidate === 'string' && candidate.length <= 4096 && path.isAbsolute(candidate)
    && !/[\x00-\x1f]/.test(candidate), 'INVALID_ROOT');
  const root = path.resolve(candidate), seen = new Set(); let rootPins;
  function roots(create) {
    const current = io.ancestry(root, create);
    if (rootPins) {need(current, 'PATH_CHANGED'); io.sameAncestry(root, rootPins);}
    else if (current) rootPins = current;
    return current;
  }
  function read(id, expectedRequestSHA256) {
    return safe(() => {
      need(operationId(id), 'INVALID_ID');
      need(typeof expectedRequestSHA256 === 'string' && /^[a-f0-9]{64}$/.test(expectedRequestSHA256), 'INVALID_BINDING');
      if (!roots(false)) return result(id);
      const dir = path.join(root, id); let stat;
      try {stat = fs.lstatSync(dir, {bigint: true});}
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        need(!seen.has(id), 'PATH_CHANGED'); return result(id);
      }
      seen.add(id);
      need(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_PATH');
      const pins = io.ancestry(dir);
      io.sameAncestry(root, rootPins);
      need(JSON.stringify(names(dir)) === '["intent.json"]', 'CORRUPT');
      const observations = new Map(), file = path.join(dir, 'intent.json');
      const record = io.readJSON(file, observations);
      need(exact(record, ['schema', 'operationId', 'requestSHA256', 'rootId', 'directoryId', 'request'])
        && record.schema === 'native-intent-record/1' && record.operationId === id
        && record.rootId === rootPins.get(root) && record.directoryId === identity(stat), 'CORRUPT');
      const bytes = Buffer.from(JSON.stringify(record.request)), request = checked(bytes);
      need(request.operationId === id && dispatch.dispatchRequestDigest(bytes) === record.requestSHA256, 'CORRUPT');
      need(record.requestSHA256 === expectedRequestSHA256, 'BINDING_MISMATCH');
      io.sameAncestry(dir, pins);
      need(JSON.stringify(names(dir)) === '["intent.json"]'
        && generation(fs.lstatSync(file, {bigint: true})) === observations.get(file), 'CHANGED');
      return result(id, request, record.requestSHA256);
    });
  }
  function begin(bytes) {
    return safe(() => {
      const request = checked(bytes), id = request.operationId;
      const canonicalBytes = Buffer.from(JSON.stringify(request));
      const requestSHA256 = dispatch.dispatchRequestDigest(canonicalBytes);
      need(!seen.has(id), 'HELD'); roots(true);
      const dir = path.join(root, id);
      try {fs.mkdirSync(dir, {mode: 0o700});}
      catch (error) {if (error.code === 'EEXIST') throw Error('NATIVE_INTENT_EXISTS_HOLD'); throw error;}
      seen.add(id);
      const pins = io.ancestry(dir);
      io.sameAncestry(root, rootPins);
      const record = Buffer.from(JSON.stringify({schema: 'native-intent-record/1', operationId: id,
        requestSHA256, rootId: rootPins.get(root), directoryId: pins.get(dir), request}) + '\n');
      need(record.length <= MAX_BYTES, 'LIMIT');
      const guard = () => {io.sameAncestry(dir, pins); need(names(dir).length === 0, 'CHANGED');};
      io.publish(dir, 'intent.json', record, pins, guard);
      const observed = read(id, requestSHA256);
      need(observed.requestSHA256 === requestSHA256, 'CHANGED');
      return observed;
    });
  }
  // No resume, append, dispatch token, deletion or flag can upgrade this to a
  // native persistence permit. Cross-operation/job exclusion remains separate.
  return Object.freeze({begin, read});
}
