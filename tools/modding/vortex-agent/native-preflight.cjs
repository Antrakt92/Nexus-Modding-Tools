'use strict';
const path = require('node:path');
const {types} = require('node:util');
const {performance} = require('node:perf_hooks');
const {context: readContext} = require('./guard.cjs');
const TIMEOUT_MS = 2000;
const ROOTS = ['gamePath','stagingPath','downloadPath'];
const STATES = new Set(['disabled','idle','checking','available','downgrade-offered','downloading','staged','error']);
const insist = (ok, code) => {if (!ok) throw Error(code);};
const clean = (s, limit, empty = false) => typeof s === 'string' && s.length <= limit && (empty || s.length > 0) && !/[\x00-\x1f\x7f]/.test(s);
const objectSource = Function.prototype.toString.call(Object);
function plain(o) {
  if (o === null || typeof o !== 'object' || types.isProxy(o)) return false;
  const proto = Object.getPrototypeOf(o);
  if (proto === null) return true;
  if (types.isProxy(proto) || Object.getPrototypeOf(proto) !== null) return false;
  // A foreign realm's intrinsic Object.prototype is valid. Inspect descriptors
  // rather than reading constructor/toStringTag or running caller callbacks.
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'constructor');
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
  const ctor = descriptor.value;
  if (typeof ctor !== 'function' || types.isProxy(ctor)
    || Function.prototype.toString.call(ctor) !== objectSource) return false;
  const ownPrototype = Object.getOwnPropertyDescriptor(ctor, 'prototype');
  return Boolean(ownPrototype && Object.hasOwn(ownPrototype, 'value') && ownPrototype.value === proto);
}
function field(o, key) {
  insist(plain(o), 'NATIVE_PREFLIGHT_NATIVE_DATA_INVALID');
  const d = Object.getOwnPropertyDescriptor(o, key);
  insist(d && Object.hasOwn(d, 'value') && d.enumerable, 'NATIVE_PREFLIGHT_NATIVE_DATA_INVALID');
  return d.value;
}
function absolute(p) {
  insist(clean(p,4096) && path.isAbsolute(p) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(p), 'NATIVE_PREFLIGHT_TARGETS_INVALID');
  if (process.platform === 'win32') insist(/^[a-z]:[\\/]/i.test(p) && !p.slice(2).includes(':'), 'NATIVE_PREFLIGHT_TARGETS_INVALID');
  return path.resolve(p);
}
const norm = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
function current(api, selectors) {
  try {
    const c = readContext(api, selectors);
    insist(clean(c.gameId,200) && clean(c.profileId,200)
      && api.getState().persistent?.profiles?.[c.profileId]?.gameId === c.gameId, 'NATIVE_PREFLIGHT_CONTEXT_INVALID');
    for (const key of ROOTS) {
      absolute(c[key]);
      insist(typeof c.filesystemIds[key] === 'string' && /^\d+:\d+$/.test(c.filesystemIds[key]), 'NATIVE_PREFLIGHT_CONTEXT_INVALID');
    }
    return c;
  } catch {throw Error('NATIVE_PREFLIGHT_CONTEXT_INVALID');}
}
function targets(util, c) {
  try {
    insist(typeof util?.getGame === 'function', 'NATIVE_PREFLIGHT_TARGETS_INVALID');
    const game = util.getGame(c.gameId);
    const getModPaths = game?.getModPaths;
    insist(typeof getModPaths === 'function', 'NATIVE_PREFLIGHT_TARGETS_INVALID');
    const raw = getModPaths.call(game,c.gamePath);
    insist(plain(raw), 'NATIVE_PREFLIGHT_TARGETS_INVALID');
    const keys = Reflect.ownKeys(raw);
    insist(keys.length > 0 && keys.length <= 32 && keys.includes('')
      && keys.every(k => clean(k,128,true) && /^[A-Za-z0-9_-]{0,128}$/.test(k)
        && !['__proto__','constructor','prototype'].includes(k)), 'NATIVE_PREFLIGHT_TARGETS_INVALID');
    const rows = keys.sort().map(typeId => ({typeId,path:absolute(field(raw,typeId))}));
    const defaultPath = rows.find(row => row.typeId === '').path;
    return rows.map(row => ({...row,sameAsDefault:norm(row.path) === norm(defaultPath)}));
  } catch {throw Error('NATIVE_PREFLIGHT_TARGETS_INVALID');}
}
const sameContext = (a,b) => a.gameId === b.gameId && a.profileId === b.profileId
  && ROOTS.every(k => norm(a[k]) === norm(b[k]) && a.filesystemIds[k] === b.filesystemIds[k]);
const sameTargets = (a,b) => a.length === b.length && a.every((row,i) => row.typeId === b[i].typeId && norm(row.path) === norm(b[i].path));
function bounded(call, project, label, timers) {
  const now = timers.now ?? (() => performance.now()), deadline = now() + TIMEOUT_MS;
  const expired = () => now() >= deadline;
  return new Promise(resolve => {
    let done = false, timer;
    const finish = value => {if (done) return; done = true; if (timer !== undefined) timers.clearTimeout(timer); resolve(value);};
    timer = timers.setTimeout(() => finish({available:false,code:'NATIVE_PREFLIGHT_' + label + '_TIMEOUT'}), TIMEOUT_MS);
    // Promise reactions observe late rejection even when the timeout already won.
    Promise.resolve().then(() => {if (expired()) return undefined; return call();}).then(value => {
      if (done) return;
      if (expired()) {finish({available:false,code:'NATIVE_PREFLIGHT_' + label + '_TIMEOUT'}); return;}
      try {const result=project(value); finish(expired() ? {available:false,code:'NATIVE_PREFLIGHT_' + label + '_TIMEOUT'} : result);} catch {finish({available:false,code:'NATIVE_PREFLIGHT_' + label + '_INVALID'});}
    }, () => finish({available:false,code:'NATIVE_PREFLIGHT_' + label + '_UNAVAILABLE'}));
  });
}
async function readNativePreflight(api, selectors, util, options = {}) {
  const initial = current(api,selectors), initialTargets = targets(util,initial);
  const timers = options.timers ?? {setTimeout,clearTimeout};
  insist(typeof timers.setTimeout === 'function' && typeof timers.clearTimeout === 'function', 'NATIVE_PREFLIGHT_OPTIONS_INVALID');
  let native;
  try {native = (options.getWindow ?? (() => globalThis.window))()?.api;} catch {native = undefined;}
  const [appVersion, updater] = await Promise.all([
    bounded(() => {
      const receiver=native?.app, getter=receiver?.getVersion;
      insist(typeof getter === 'function', 'UNAVAILABLE');
      return getter.call(receiver);
    }, value => {
      insist(typeof value === 'string' && value.length <= 128
        && /^\d{1,4}(?:\.\d{1,6}){2,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?(?:\+[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/.test(value), 'INVALID');
      return {available:true,value};
    }, 'APP_VERSION',timers),
    bounded(() => {
      const receiver=native?.updater, getter=receiver?.getStatus;
      insist(typeof getter === 'function', 'UNAVAILABLE');
      return getter.call(receiver);
    }, value => {
      const sequence=field(value,'seq'), state=field(field(field(value,'snapshot'),'state'),'type');
      insist(Number.isSafeInteger(sequence) && sequence >= 0 && STATES.has(state), 'INVALID');
      return {available:true,state,sequence};
    }, 'UPDATER',timers),
  ]);
  const final = current(api,selectors);
  insist(sameContext(initial,final), 'NATIVE_PREFLIGHT_CONTEXT_CHANGED');
  const finalTargets = targets(util,final);
  insist(sameTargets(initialTargets,finalTargets), 'NATIVE_PREFLIGHT_TARGETS_CHANGED');
  return {protocol:'vortex-agent/1',schema:'native-preflight/1',observedAtUTC:new Date().toISOString(),
    context:final,appVersion,deploymentTargets:finalTargets,updater,snapshotAtomic:false,nativeEffects:false,
    shutdownPermit:false,sourceAdmissionVerified:false,status:appVersion.available && updater.available ? 'ok' : 'partial'};
}
module.exports = {TIMEOUT_MS,readNativePreflight};
