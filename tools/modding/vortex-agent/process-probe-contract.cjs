'use strict';
const {types} = require('node:util');
const {parseStrictJSON} = require('./strict-json.cjs');

const CONTRACT = Object.freeze({version: 1, schema: 'native-process-snapshot/1',
  backend: 'toolhelp32w', nameKind: 'executable-basename'});
const LIMITS = Object.freeze({requestBytes: 1024, responseBytes: 1024 * 1024,
  count: 65536, nameCodeUnits: 260});
const need = (ok, code) => {if (!ok) throw Error(code);};
const requestId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

// Read only enumerable own data properties. Reject proxies before inspecting
// descriptors so validation cannot execute their traps or caller accessors.
function fields(value, names, code) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === names.length, code);
  const result = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    need(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, code);
    result[name] = descriptor.value;
  }
  return result;
}
function utf16(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function parse(bytes, maxBytes) {
  need(bytes !== null && typeof bytes === 'object' && !types.isProxy(bytes)
    && types.isUint8Array(bytes)
    && (Object.getPrototypeOf(bytes) === Uint8Array.prototype || Object.getPrototypeOf(bytes) === Buffer.prototype),
  'PROCESS_PROBE_INVALID_JSON');
  // strict-json reads byteLength; reject overrides before it touches the buffer.
  for (const name of ['byteLength', 'byteOffset', 'buffer'])
    need(!Object.hasOwn(bytes, name), 'PROCESS_PROBE_INVALID_JSON');
  need(bytes.byteLength <= maxBytes, 'PROCESS_PROBE_MESSAGE_LIMIT');
  // The process-only wire format has no BOM; TextDecoder otherwise strips it.
  need(!(bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf),
    'PROCESS_PROBE_INVALID_JSON');
  try {return parseStrictJSON(bytes, {maxBytes, maxDepth: 4, maxTokens: LIMITS.count * 2 + 64});}
  catch {throw Error('PROCESS_PROBE_INVALID_JSON');}
}

/** Validate a synchronous data request. No path, environment, command or PID is accepted. */
function validateRequest(value) {
  const data = fields(value, ['version', 'requestId'], 'PROCESS_PROBE_INVALID_REQUEST');
  need(data.version === CONTRACT.version && requestId(data.requestId), 'PROCESS_PROBE_INVALID_REQUEST');
  return Object.freeze(data);
}
/** Parse bounded BOM-free UTF-8 bytes, rejecting duplicate decoded keys before validation. */
function parseRequest(bytes) {return validateRequest(parse(bytes, LIMITS.requestBytes));}

/**
 * Validate claims only, preserving names and duplicates exactly. `complete` is
 * the producer's enumeration claim, not independently proved process absence.
 * Caller must additionally bind the admitted executable/request, deadline,
 * exit=0, empty stderr and stdout EOF. This function grants no effects or lease.
 */
function validateReply(value, expectedRequestId) {
  need(requestId(expectedRequestId), 'PROCESS_PROBE_INVALID_REQUEST_ID');
  const data = fields(value, ['schema', 'requestId', 'backend', 'nameKind', 'complete', 'count', 'names', 'effectsAllowed'],
    'PROCESS_PROBE_INVALID_REPLY');
  need(data.schema === CONTRACT.schema && requestId(data.requestId)
    && data.backend === CONTRACT.backend && data.nameKind === CONTRACT.nameKind
    && data.complete === true && data.effectsAllowed === false
    && Number.isSafeInteger(data.count) && data.count > 0 && data.count <= LIMITS.count,
  'PROCESS_PROBE_INVALID_REPLY');
  need(data.requestId === expectedRequestId, 'PROCESS_PROBE_REQUEST_MISMATCH');
  need(!types.isProxy(data.names) && Array.isArray(data.names)
    && Object.getPrototypeOf(data.names) === Array.prototype, 'PROCESS_PROBE_INVALID_NAMES');
  const length = Object.getOwnPropertyDescriptor(data.names, 'length');
  need(length && Object.hasOwn(length, 'value') && length.value === data.count
    && Reflect.ownKeys(data.names).length === data.count + 1, 'PROCESS_PROBE_INVALID_NAMES');
  const names = [];
  // Account incrementally; do not stringify a potentially 17 MiB programmatic
  // list just to discover that its response would exceed the 1 MiB wire budget.
  let bytes = Buffer.byteLength(JSON.stringify({...data, names: []}), 'utf8');
  for (let i = 0; i < data.count; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(data.names, String(i));
    need(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'PROCESS_PROBE_INVALID_NAMES');
    const name = descriptor.value;
    need(typeof name === 'string' && name.length > 0 && name.length <= LIMITS.nameCodeUnits
      && !/[\\/\p{Cc}]/u.test(name) && utf16(name), 'PROCESS_PROBE_INVALID_NAME');
    bytes += Buffer.byteLength(JSON.stringify(name), 'utf8') + (i > 0 ? 1 : 0);
    need(bytes <= LIMITS.responseBytes, 'PROCESS_PROBE_MESSAGE_LIMIT');
    names.push(name);
  }
  data.names = Object.freeze(names);
  return Object.freeze(data);
}
/** Parse a single success document. Exit status, EOF and stderr are not JSON properties. */
function parseReply(bytes, expectedRequestId) {
  need(requestId(expectedRequestId), 'PROCESS_PROBE_INVALID_REQUEST_ID');
  return validateReply(parse(bytes, LIMITS.responseBytes), expectedRequestId);
}

module.exports = Object.freeze({CONTRACT, LIMITS, validateRequest, parseRequest, validateReply, parseReply});
