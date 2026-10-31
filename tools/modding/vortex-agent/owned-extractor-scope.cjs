'use strict';
// GPL-3.0-only. Internal explicit ownership for the separately pinned ISC node-7z
// factory patches. No spawn/kill/cleanup, ALS, configurable executable or endpoint.
// Branding and caller hashes are not native admission or durable job exclusion.
const path = require('node:path').win32;
const {isProxy} = require('node:util').types;
const {observeChildTerminal, copyChildBinding} = require('./child-terminal-observer.cjs');
const owners = new WeakMap(), tickets = new WeakMap();
const LIMIT = 4;
const fail = code => {throw Error('OWNED_EXTRACTOR_' + code);};
function object(value, keys) {
  if (!value || typeof value !== 'object' || isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== keys.length) fail('INVALID_DATA');
  const prototype = Object.getPrototypeOf(value);
  if (prototype && Object.keys(prototype).length) fail('INHERITED_OPTIONS');
  const copy = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) fail('INVALID_DATA');
    copy[key] = field.value;
  }
  return copy;
}
function normalized(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z]:[\\/]/.test(value)
      || !/^[\x20-\x7e]+$/.test(value)) fail('INVALID_PATH');
  const parts = value.slice(3).split(/[\\/]/);
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.length > 255
      || /[. ]$/.test(part) || /[<>:"|?*~]/.test(part)
      || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('INVALID_PATH');
  return path.normalize(value);
}
function ownerState(owner) {
  const state = owner && typeof owner === 'object' && !isProxy(owner) ? owners.get(owner) : null;
  if (!state) fail('INVALID_OWNER');
  return state;
}
function observations(state) {
  return state.rows.map(row => row.observer ? row.observer.read() : null);
}
function hasErrors(observation) {
  return observation && (observation.childErrorObserved || Object.values(observation.pipes).some(pipe => pipe.errorObserved));
}
function open(state) {
  const values = observations(state);
  if (state.sealed || state.cancelled || state.failed || state.uncertain || values.some(value => value?.held || hasErrors(value))) fail('SEALED_OR_HELD');
  if (state.rows.some((row, n) => !values[n]?.childResourcesClosed)) fail('CHILD_ACTIVE_OR_UNKNOWN');
  if (state.rows.length >= LIMIT) fail('ATTEMPT_LIMIT');
}
function read(state) {
  const values = observations(state);
  const held = state.uncertain || values.some(value => value?.held);
  const children = state.rows.map((row, n) => Object.freeze({attempt: n + 1,
    spawnAttempted: row.spawnAttempted, childReturned: !!row.child, uncertain: row.uncertain,
    observation: values[n]}));
  return Object.freeze({schema: 'owned-extractor-observation/1', binding: state.binding,
    launchSealed: state.sealed, cancelRequested: state.cancelled, wrapperFailureObserved: state.failed,
    held, attempts: state.rows.length, attemptLimit: LIMIT,
    errorsObserved: state.failed || values.some(hasErrors), children: Object.freeze(children),
    allChildrenResourcesClosed: state.sealed && !held && state.rows.every((row, n) => values[n]?.childResourcesClosed),
    nativeInstallAccepted: false, persistenceVerified: false, descendantsVerified: false});
}
function createChildOwner(binding, input) {
  const checked = copyChildBinding(binding), spec = object(input, ['archivePath', 'destinationPath']);
  const archivePath = normalized(spec.archivePath), destinationPath = normalized(spec.destinationPath);
  if (!/\.zip$/i.test(archivePath) || archivePath.toLowerCase() === destinationPath.toLowerCase()
      || archivePath.toLowerCase().startsWith(destinationPath.toLowerCase() + '\\')
      || destinationPath.toLowerCase().startsWith(archivePath.toLowerCase() + '\\')) fail('INVALID_SPEC');
  const state = {binding: checked, spec: Object.freeze({archivePath, destinationPath}), rows: [],
    sealed: false, cancelled: false, failed: false, uncertain: false};
  const owner = Object.create(null);
  Object.assign(owner, {
    cancel() {state.cancelled = true; state.sealed = true; return read(state);},
    seal() {state.sealed = true; return read(state);},
    read() {return read(state);},
  });
  owners.set(owner, state);
  return Object.freeze(owner);
}
function assertOwner(owner) {ownerState(owner);}
function copyOptions(owner, input) {
  ownerState(owner);
  const checked = object(input, ['ssc']);
  if (checked.ssc !== false) fail('INVALID_OPTIONS');
  const result = Object.create(null);
  result.bb3 = true; result.ssc = false;
  return result;
}
function prepareExtract(owner, archive, destination, options, progress, password) {
  const state = ownerState(owner);
  if (normalized(archive) !== state.spec.archivePath || normalized(destination) !== state.spec.destinationPath) fail('TUPLE_MISMATCH');
  copyOptions(owner, options);
  if (password !== undefined || progress !== undefined && typeof progress !== 'function') fail('UNSUPPORTED_CALLBACK');
  const switches = Object.create(null); switches.ssc = false;
  return {archivePath: state.spec.archivePath, destinationPath: state.spec.destinationPath, options: switches,
    progress: progress === undefined ? undefined : (lines, percentage) => progress(lines, percentage)};
}
function prepareRun(owner, args, inputSwitches) {
  const state = ownerState(owner), checked = object(inputSwitches, ['bb3', 'ssc']);
  if (checked.bb3 !== true || checked.ssc !== false || !Array.isArray(args) || isProxy(args)
      || Object.getPrototypeOf(args) !== Array.prototype || Reflect.ownKeys(args).length !== 4) fail('INVALID_RUN');
  const expected = ['x', state.spec.archivePath, '-o' + state.spec.destinationPath];
  const copy = [];
  for (let n = 0; n < 3; n++) {
    const field = Object.getOwnPropertyDescriptor(args, String(n));
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable || field.value !== expected[n]) fail('TUPLE_MISMATCH');
    copy.push(field.value);
  }
  const switches = Object.create(null); switches.bb3 = true; switches.ssc = false;
  return {args: copy, switches};
}
function reserveSpawn(owner, args) {
  const state = ownerState(owner);
  // SDK switches have already been built from a private null-prototype object.
  const expected = ['x', state.spec.archivePath, '-o' + state.spec.destinationPath, '-bb3', '-ssc-', '-y', '-bsp1'];
  if (!Array.isArray(args) || isProxy(args) || args.length !== expected.length
      || !expected.every((value, n) => Object.getOwnPropertyDescriptor(args, String(n))?.value === value)) fail('INVALID_ARGV');
  open(state);
  const row = {spawnAttempted: true, child: null, observer: null, uncertain: false};
  state.rows.push(row); // Reserve before the actual spawn; never refund this row.
  const ticket = Object.freeze(Object.create(null)); tickets.set(ticket, {state, row});
  return ticket;
}
function ticketState(ticket) {
  const entry = ticket && typeof ticket === 'object' && !isProxy(ticket) ? tickets.get(ticket) : null;
  if (!entry) fail('INVALID_TICKET');
  return entry;
}
function spawnFailed(ticket) {
  const {state, row} = ticketState(ticket);
  row.uncertain = state.uncertain = state.failed = state.sealed = true;
}
function adoptChild(ticket, child) {
  const {state, row} = ticketState(ticket);
  if (row.child || row.uncertain) {state.uncertain = state.sealed = true; return false;}
  row.child = child; // Retain the actual object BEFORE observer attachment.
  try {row.observer = observeChildTerminal(child, state.binding);}
  catch {row.uncertain = state.uncertain = state.failed = state.sealed = true; return false;}
  if (row.observer.read().held) {row.uncertain = state.uncertain = state.failed = state.sealed = true; return false;}
  return true;
}
function wrapperFailed(owner) {
  const state = ownerState(owner); state.failed = state.sealed = true;
}
// Protocol helpers are internal SDK patch wiring, not MCP operations or an
// executable/argv/spawn-function endpoint. Only the patched SDK performs spawn.
module.exports = {createChildOwner, assertOwner, copyOptions, prepareExtract, prepareRun,
  reserveSpawn, spawnFailed, adoptChild, wrapperFailed};
