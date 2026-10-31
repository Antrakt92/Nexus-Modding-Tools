'use strict';
// Pure data model. Every native observation remains a caller-supplied claim.
// This module never grants a permit, dispatches an event or accesses a path.
const crypto = require('node:crypto');
const path = require('node:path').win32;
const {isProxy} = require('node:util').types;
const {parseStrictJSON} = require('./strict-json.cjs');
const LIMITS = Object.freeze({bytes: 1024 * 1024, nodes: 50000, depth: 16, events: 32,
  files: 4096, archiveBytes: 64 * 1024 * 1024, unpackedBytes: 256 * 1024 * 1024});
const CONTRACT_ID = 'own-install-job-model/1';
const need = (ok, code) => {if (!ok) throw Error(code);};
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,99}$/.test(value);
const positive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function freeze(value) {
  if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}
  return value;
}
function detach(input) {
  let nodes = 0, bytes = 0;
  const seen = new Set();
  const spend = n => {bytes += n; need(bytes <= LIMITS.bytes, 'INSTALL_JOB_LIMIT');};
  function copy(value, depth) {
    need(++nodes <= LIMITS.nodes && depth <= LIMITS.depth, 'INSTALL_JOB_LIMIT');
    if (value === null || typeof value === 'boolean') {spend(5); return value;}
    if (typeof value === 'string') {need(value.length <= 4096, 'INSTALL_JOB_LIMIT'); spend(Buffer.byteLength(JSON.stringify(value))); return value;}
    if (typeof value === 'number') {need(Number.isSafeInteger(value), 'INSTALL_JOB_JSON_REQUIRED'); spend(24); return value;}
    need(value && typeof value === 'object' && !isProxy(value) && !seen.has(value), 'INSTALL_JOB_JSON_REQUIRED');
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    need(array ? proto === Array.prototype : proto === Object.prototype || proto === null, 'INSTALL_JOB_JSON_REQUIRED');
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    need(keys.length <= LIMITS.nodes, 'INSTALL_JOB_LIMIT');
    if (array) need(value.length <= LIMITS.nodes && keys.length === value.length + 1, 'INSTALL_JOB_JSON_REQUIRED');
    const out = array ? [] : Object.create(null); spend(2 + keys.length);
    for (const key of array ? Array.from({length: value.length}, (_, index) => String(index)) : keys) {
      need(typeof key === 'string' && key.length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(key), 'INSTALL_JOB_JSON_REQUIRED');
      const property = Object.getOwnPropertyDescriptor(value, key);
      need(property && property.enumerable && Object.hasOwn(property, 'value'), 'INSTALL_JOB_JSON_REQUIRED');
      spend(Buffer.byteLength(JSON.stringify(key)) + 1); out[key] = copy(property.value, depth + 1);
    }
    seen.delete(value); return out;
  }
  return copy(input, 0);
}
const reserved = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i;
function component(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && /^[\x20-\x7e]+$/.test(value) && !/[<>:"/\\|?*]/.test(value)
    && !/[. ]$/.test(value) && !['.', '..'].includes(value) && !reserved.test(value)
    && !['__proto__', 'constructor', 'prototype', '__folder_managed_by_vortex'].includes(value.toLowerCase());
}
function rootPath(value) {
  return typeof value === 'string' && value.length <= 512 && /^[A-Za-z]:[\\/]/.test(value)
    && value.length > 3 && !/[\x00-\x1f\x7f]/.test(value)
    && value.slice(3).split(/[\\/]/).every(component);
}
function validate(value) {
  need(exact(value, ['schema', 'family', 'contractId', 'context', 'package', 'evidence', 'options'])
    && value.schema === 'install-job-plan/1' && value.family === 'tracked-new-disabled'
    && value.contractId === CONTRACT_ID, 'INSTALL_JOB_INVALID_PLAN');
  const c = value.context, roots = ['gamePath', 'stagingPath', 'downloadPath'];
  need(exact(c, ['gameId', 'profileId', ...roots, 'filesystemIds']) && c.gameId === 'cyberpunk2077'
    && opaque(c.profileId) && exact(c.filesystemIds, roots), 'INSTALL_JOB_INVALID_CONTEXT');
  const paths = roots.map(key => {
    need(rootPath(c[key]) && typeof c.filesystemIds[key] === 'string'
      && /^[1-9]\d{0,24}:[1-9]\d{0,24}$/.test(c.filesystemIds[key]), 'INSTALL_JOB_INVALID_CONTEXT');
    return path.normalize(c[key]).toLowerCase();
  });
  need(new Set(roots.map(key => c.filesystemIds[key])).size === roots.length, 'INSTALL_JOB_ROOT_ALIAS');
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const inside = (a, b) => {const rel = path.relative(a, b); return rel === '' || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\');};
    need(!inside(paths[i], paths[j]) && !inside(paths[j], paths[i]), 'INSTALL_JOB_ROOT_OVERLAP');
  }
  const p = value.package;
  need(exact(p, ['downloadId', 'fileName', 'expectedModId', 'expectedType', 'bytes', 'sha256', 'md5', 'expectedUncompressedBytes', 'payload'])
    && opaque(p.downloadId) && component(p.fileName) && p.fileName.length <= 204 && /\.zip$/i.test(p.fileName)
    && /^[A-Za-z0-9_. -]+$/.test(p.fileName) && component(p.expectedModId)
    && p.expectedModId === p.fileName.slice(0, -4).trim() && !/\.installing$/i.test(p.expectedModId)
    && p.expectedType === '' && positive(p.bytes, LIMITS.archiveBytes) && sha(p.sha256)
    && typeof p.md5 === 'string' && /^[a-f0-9]{32}$/.test(p.md5)
    && positive(p.expectedUncompressedBytes, LIMITS.unpackedBytes), 'INSTALL_JOB_INVALID_PACKAGE');
  const names = p.payload && typeof p.payload === 'object' && !Array.isArray(p.payload) ? Object.keys(p.payload) : [];
  need(names.length > 0 && names.length <= LIMITS.files, 'INSTALL_JOB_PAYLOAD_LIMIT');
  const files = new Set(), directories = new Set(), casing = new Map();
  for (const name of names) {
    const parts = name.split('/');
    need(name.length <= 512 && parts.every(component) && !name.includes('\\') && sha(p.payload[name])
      && !parts.some(part => ['fomod', 'vortex_override_instructions.json'].includes(part.toLowerCase())), 'INSTALL_JOB_INVALID_PAYLOAD');
    const folded = name.toLowerCase(); need(!files.has(folded) && !directories.has(folded), 'INSTALL_JOB_PAYLOAD_COLLISION');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/'), lower = prefix.toLowerCase();
      need(!casing.has(lower) || casing.get(lower) === prefix, 'INSTALL_JOB_PAYLOAD_COLLISION'); casing.set(lower, prefix);
      if (index < parts.length) {need(!files.has(lower), 'INSTALL_JOB_PAYLOAD_COLLISION'); directories.add(lower);}
    }
    files.add(folded);
  }
  need(exact(value.evidence, ['buildSHA256', 'sourceSHA256', 'nativeAdmissionSHA256'])
    && Object.values(value.evidence).every(sha), 'INSTALL_JOB_INVALID_EVIDENCE');
  need(exact(value.options, ['enabled', 'deploy']) && value.options.enabled === false && value.options.deploy === false,
    'INSTALL_JOB_INVALID_OPTIONS');
  return value;
}
function validateInstallPlan(value) {return freeze(validate(detach(value)));}
function parse(bytes) {
  let parsed;
  try {parsed = parseStrictJSON(bytes, {maxBytes: LIMITS.bytes, maxDepth: LIMITS.depth, maxTokens: LIMITS.nodes});}
  catch {throw Error('INSTALL_JOB_INVALID_JSON');}
  return parsed;
}
function parseInstallPlan(bytes) {return validateInstallPlan(parse(bytes));}
const installPlanId = value => digest(validateInstallPlan(value));
const installPayloadDigest = value => digest(validateInstallPlan(value).package.payload);
function initialInstallState(plan) {
  return freeze(checkedState({schema: 'install-job-state/1', plan: validateInstallPlan(plan), events: []}));
}
function replay(plan, events) {
  const state = {schema: 'install-job-status/1', planId: digest(plan), phase: 'prepared', eventCount: events.length,
    intentObserved: false, callbackObserved: false, nativeTerminalObserved: false, settlementObserved: false,
    cleanupObserved: false, cancellationObserved: false, failureObserved: false, completionObserved: false,
    modelCompleted: false, effectsAllowed: false, nativeAdmissionVerified: false,
    archiveVerified: false, payloadVerified: false, nativeActivity: 'no-intent-observed', reconcileRequired: false};
  let admission, intentJobId, callback, terminal;
  for (const [index, event] of events.entries()) {
    need(!state.completionObserved && event?.sequence === index + 1, 'INSTALL_JOB_EVENT_ORDER');
    const fields = names => exact(event, ['sequence', 'kind', ...names]);
    const blocked = () => state.cancellationObserved || state.failureObserved;
    switch (event.kind) {
      case 'admission_observed':
        need(fields(['snapshotSHA256', 'nativeAdmissionSHA256']) && sha(event.snapshotSHA256)
          && event.nativeAdmissionSHA256 === plan.evidence.nativeAdmissionSHA256
          && !admission && !state.intentObserved && !blocked(), 'INSTALL_JOB_EVENT_ORDER');
        admission = event.snapshotSHA256; state.phase = 'admission_observed'; break;
      case 'install_intent':
        need(fields(['admissionSHA256', 'nativeJobId']) && admission && event.admissionSHA256 === admission
          && opaque(event.nativeJobId) && !state.intentObserved && !blocked(), 'INSTALL_JOB_EVENT_ORDER');
        intentJobId = event.nativeJobId;
        state.intentObserved = true; state.nativeActivity = 'unknown'; state.phase = 'dispatch_unknown'; break;
      case 'native_callback':
        need(fields(['outcome', 'modId', 'code', 'nativeJobId']) && state.intentObserved && !callback
          && (event.nativeJobId === null || event.nativeJobId === intentJobId)
          && (event.outcome === 'resolved' && event.modId === plan.package.expectedModId && event.code === null
            || event.outcome === 'failed' && (event.modId === null || event.modId === plan.package.expectedModId)
              && code(event.code)), 'INSTALL_JOB_INVALID_CALLBACK');
        callback = event; state.callbackObserved = true;
        if (event.outcome === 'failed') state.failureObserved = true;
        if (!blocked()) state.phase = 'callback_observed'; break;
      case 'native_terminal_observed':
        need(fields(['nativeJobId', 'outcome', 'code']) && callback && !terminal && event.nativeJobId === intentJobId
          && (callback.nativeJobId === null || callback.nativeJobId === event.nativeJobId)
          && (event.outcome === 'resolved' && callback.outcome === 'resolved' && event.code === null
            || event.outcome === 'failed' && code(event.code)), 'INSTALL_JOB_INVALID_NATIVE_TERMINAL');
        terminal = event; state.nativeTerminalObserved = true; state.nativeActivity = 'terminal-claim';
        if (event.outcome === 'failed') state.failureObserved = true;
        if (!blocked()) state.phase = 'native_terminal_observed'; break;
      case 'settlement_observed':
        need(fields(['payloadSHA256', 'disabled']) && terminal?.outcome === 'resolved' && !blocked()
          && !state.settlementObserved && event.disabled === true && event.payloadSHA256 === digest(plan.package.payload), 'INSTALL_JOB_INVALID_SETTLEMENT');
        state.settlementObserved = true; state.phase = 'settlement_observed'; break;
      case 'cleanup_observed':
        need(fields(['exited', 'forced', 'uncertain']) && state.intentObserved && !state.cleanupObserved
          && (state.settlementObserved || blocked()) && event.exited === true && event.forced === false && event.uncertain === false,
        'INSTALL_JOB_INVALID_CLEANUP');
        state.cleanupObserved = true; if (!blocked()) state.phase = 'cleanup_observed'; break;
      case 'completion_observed':
        need(fields(['readbackSHA256']) && sha(event.readbackSHA256) && state.cleanupObserved && state.settlementObserved
          && terminal?.outcome === 'resolved' && !blocked(), 'INSTALL_JOB_INVALID_COMPLETION');
        state.completionObserved = true; state.modelCompleted = true; state.phase = 'completion_observed'; break;
      case 'cancellation_requested':
        need(fields([]) && !state.cancellationObserved, 'INSTALL_JOB_EVENT_ORDER');
        state.cancellationObserved = true; break;
      case 'failure_observed':
        need(fields(['code']) && code(event.code) && !state.failureObserved, 'INSTALL_JOB_EVENT_ORDER');
        state.failureObserved = true; break;
      default: throw Error('INSTALL_JOB_INVALID_EVENT');
    }
    if (blocked()) state.phase = state.intentObserved ? 'held' : 'stopped_before_intent';
  }
  state.reconcileRequired = state.intentObserved && !state.modelCompleted;
  return freeze(state);
}
function checkedState(input) {
  const state = detach(input);
  need(exact(state, ['schema', 'plan', 'events']) && state.schema === 'install-job-state/1'
    && Array.isArray(state.events) && state.events.length <= LIMITS.events, 'INSTALL_JOB_INVALID_STATE');
  const plan = validate(state.plan); replay(plan, state.events); return state;
}
function advanceInstallState(input, event) {
  const state = checkedState(input); need(state.events.length < LIMITS.events, 'INSTALL_JOB_EVENT_LIMIT');
  // Recheck the combined document budget too; individually bounded inputs must
  // not produce a state that the next reader cannot admit.
  state.events.push(detach(event)); return freeze(checkedState(state));
}
function inspectInstallState(input) {const state = checkedState(input); return replay(state.plan, state.events);}
function parseInstallState(bytes) {return freeze(checkedState(parse(bytes)));}
module.exports = {CONTRACT_ID, LIMITS, parseInstallPlan, validateInstallPlan, installPlanId, installPayloadDigest,
  initialInstallState, advanceInstallState, inspectInstallState, parseInstallState};
