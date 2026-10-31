'use strict';
// Pure protocol producer. No persistence, native dispatch or capability admission.
const crypto = require('node:crypto');
const {isUint8Array, isSharedArrayBuffer} = require('node:util').types;
const {parseStrictJSON} = require('./strict-json.cjs');
const {LIMITS: PLAN_LIMITS, validateInstallPlan, installPlanId} = require('./install-job-contract.cjs');
const CONTRACT_ID = 'tracked-new-disabled-dispatch/1';
const LIMITS = Object.freeze({bytes: PLAN_LIMITS.bytes + 4096,
  depth: PLAN_LIMITS.depth + 2, tokens: PLAN_LIMITS.nodes + 128, consumed: 1024});
const need = (ok, code) => {if (!ok) throw Error(code);};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value, prefix) => typeof value === 'string' && new RegExp('^' + prefix + '_[a-f0-9]{32}$').test(value);
function scope(value) {
  if (typeof value !== 'string') return false;
  const match = /^manager-[A-Za-z0-9_-]{1,64}-([1-9][0-9]{0,15})$/.exec(value);
  return !!match && Number.isSafeInteger(Number(match[1]));
}
function parse(bytes, maxBytes = LIMITS.bytes) {
  try {
    need(isUint8Array(bytes), 'NATIVE_DISPATCH_INVALID_JSON');
    const typed = Object.getPrototypeOf(Uint8Array.prototype);
    const length = Object.getOwnPropertyDescriptor(typed, 'byteLength').get.call(bytes);
    const backing = Object.getOwnPropertyDescriptor(typed, 'buffer').get.call(bytes);
    need(length <= maxBytes && !isSharedArrayBuffer(backing), 'NATIVE_DISPATCH_INVALID_JSON');
    const snapshot = new Uint8Array(length);
    Uint8Array.prototype.set.call(snapshot, bytes);
    return parseStrictJSON(snapshot, {maxBytes, maxDepth: LIMITS.depth, maxTokens: LIMITS.tokens});
  }
  catch {throw Error('NATIVE_DISPATCH_INVALID_JSON');}
}
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function freeze(value) {
  if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}
  return value;
}
function parseDispatchRequest(bytes) {
  const value = parse(bytes);
  need(exact(value, ['schema', 'contractId', 'operationId', 'planId', 'nativeJobId', 'managerScope',
    'rendererGeneration', 'admissionSHA256', 'plan']) && value.schema === 'native-dispatch-request/1'
    && value.contractId === CONTRACT_ID && id(value.operationId, 'op') && id(value.nativeJobId, 'exec')
    && scope(value.managerScope) && id(value.rendererGeneration, 'renderer')
    && sha(value.planId) && sha(value.admissionSHA256), 'NATIVE_DISPATCH_INVALID_REQUEST');
  value.plan = validateInstallPlan(value.plan);
  need(value.planId === installPlanId(value.plan), 'NATIVE_DISPATCH_PLAN_MISMATCH');
  return freeze(value);
}
const dispatchRequestDigest = bytes => digest(parseDispatchRequest(bytes));
function createConsumedRegistry(lifetimeBytes) {
  // One registry belongs to one live manager. Its owner must not recreate it to
  // bypass a hold; cross-process replay protection requires the durable executor.
  const lifetime = parse(lifetimeBytes, 1024);
  need(exact(lifetime, ['managerScope', 'rendererGeneration']) && scope(lifetime.managerScope)
    && id(lifetime.rendererGeneration, 'renderer'), 'NATIVE_DISPATCH_INVALID_LIFETIME');
  const jobs = new Map(), operations = new Map();
  function bound(bytes) {
    const request = parseDispatchRequest(bytes);
    need(request.managerScope === lifetime.managerScope && request.rendererGeneration === lifetime.rendererGeneration,
      'NATIVE_DISPATCH_LIFETIME_MISMATCH');
    const requestSHA256 = digest(request), previous = jobs.get(request.nativeJobId);
    need(!previous || previous.requestSHA256 === requestSHA256, 'NATIVE_DISPATCH_DESCRIPTOR_MISMATCH');
    need(!operations.has(request.operationId) || operations.get(request.operationId) === request.nativeJobId,
      'NATIVE_DISPATCH_OPERATION_REUSED');
    return {request, requestSHA256, previous};
  }
  function status(request, requestSHA256, modelConsumed) {
    return Object.freeze({schema: 'native-dispatch-model-status/1', operationId: request.operationId,
      nativeJobId: request.nativeJobId, managerScope: lifetime.managerScope,
      rendererGeneration: lifetime.rendererGeneration, requestSHA256, modelConsumed, effectsAllowed: false});
  }
  return Object.freeze({
    inspect(bytes) {
      const {request, requestSHA256, previous} = bound(bytes);
      return status(request, requestSHA256, !!previous);
    },
    consume(bytes) {
      const {request, requestSHA256, previous} = bound(bytes);
      // Check duplicates before capacity; neither lost replies nor a full registry
      // permit a second invocation. No hook or await runs across this insertion.
      need(!previous, 'NATIVE_DISPATCH_ALREADY_CONSUMED');
      need(jobs.size < LIMITS.consumed, 'NATIVE_DISPATCH_CAPACITY');
      jobs.set(request.nativeJobId, {requestSHA256});
      operations.set(request.operationId, request.nativeJobId);
      return status(request, requestSHA256, true);
    },
  });
}
module.exports = {CONTRACT_ID, LIMITS, parseDispatchRequest, dispatchRequestDigest, createConsumedRegistry};
