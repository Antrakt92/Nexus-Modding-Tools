import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {applyExact, hunks, extractClassDeclaration} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('callback-order.json', base)));
const prerequisite = JSON.parse(readFileSync(new URL('ordinary-tracking.json', base)));
const patch = readFileSync(new URL('callback-order.patch', base), 'utf8');
const tracking = readFileSync(new URL('ordinary-tracking.patch', base), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourcePath = process.env.VORTEX_NATIVE_INSTALL_MANAGER;
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: sourcePath ? false : 'Set VORTEX_NATIVE_INSTALL_MANAGER to the exact original InstallManager.ts'}, fn);
function sources() {
  const raw = readFileSync(sourcePath);
  assert.equal(hash(raw), manifest.originalSourceSHA256, 'original raw source pin');
  const input = applyExact(new TextDecoder('utf-8', {fatal: true}).decode(raw), tracking, manifest.upstreamPath);
  assert.equal(hash(input), manifest.inputSHA256, 'tracking prerequisite output');
  const patched = applyExact(input, patch, manifest.upstreamPath);
  assert.equal(hash(patched), manifest.outputSHA256, 'callback patch output');
  return {input, patched};
}

test('callback patch requires exact tracking prerequisite and grants no native guarantees', () => {
  assert.equal(manifest.schema, 'native-source-patch/1');
  assert.equal(manifest.upstreamRepository, 'https://github.com/Nexus-Mods/Vortex');
  assert.equal(manifest.upstreamTag, 'v2.9.1');
  assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
  assert.equal(manifest.upstreamPath, 'src/renderer/src/extensions/mod_management/InstallManager.ts');
  assert.equal(manifest.originalSourceSHA256, '577d56a8728052069f850face9bb57437dbf2886bd41409fe6a66cfefc08ed33');
  assert.equal(manifest.inputSHA256, '3a82d810f47409332262b204f4cde3ff11e7cbf0acbc9036715048a25594a050');
  assert.equal(manifest.originalSourceSHA256, prerequisite.inputSHA256);
  assert.equal(manifest.inputSHA256, prerequisite.outputSHA256);
  assert.equal(manifest.prerequisitePatchSHA256, hash(tracking));
  assert.equal(manifest.prerequisitePatch, 'ordinary-tracking.patch');
  assert.equal(manifest.patchSHA256, hash(patch)); assert.equal(manifest.preparedOnly, true);
  for (const key of ['installed', 'nativeAcceptanceVerified', 'nativeTerminalGuarantee', 'noReplacementGuarantee',
    'importNoClobberGuarantee', 'ownerReservationGuarantee']) assert.equal(manifest[key], false);
  for (const hunk of hunks(patch, manifest.upstreamPath)) for (const line of hunk.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1), /[\t ]$/);
  assert(!patch.includes('\r')); assert.match(manifest.outputSHA256, /^[a-f0-9]{64}$/);
});

// The real callbacks, success continuation, destructive catch, stopIndicator
// finally, missing-callback fallback and limiter catch all execute unmodified.
// Only the preceding extraction/instruction pipeline is replaced with a supplied
// resolved/rejected value. No constructor, filesystem API or native event runs.
function fixture(source, {callback = () => {}, fail, eventFailure, diagnosticFailure = false,
  successLogFailure = false, recentFailure = false, beforeTail} = {}) {
  const start = source.indexOf('const installationPromise = withTrackedActivity(');
  const filter = source.indexOf('return filterModInfo(fullInfo, destinationPath);', start);
  const success = source.indexOf('.then((modInfo) => {', filter);
  const end = source.indexOf('// Handle the installationPromise completion/failure', success);
  assert(start >= 0 && filter > start && success > filter && end > success);
  const suffix = /\),\n\s*\{\},\n\s*\);\n\n\s*$/;
  const tail = source.slice(success, end); assert(suffix.test(tail));
  const pipeline = `installGameId='ownGame';modId='ownMod';destinationPath='ownDestination';installContext=__context;
          const installationPromise = Promise.resolve().then(__start)
          ${tail.replace(suffix, ');\n\n          ')}`;
  let observed = source.slice(0, start) + pipeline + source.slice(end);
  const anchor = observed.indexOf('    if (archiveId != null)', observed.indexOf('const trackedCallback ='));
  assert(anchor > 0);
  observed = observed.slice(0, anchor) + '    this.__callbacks.push(trackedCallback);\n' + observed.slice(anchor);
  const events = [], removals = [], logs = [], tasks = [], calls = [];
  const state = {settings: {automation: {enable: false}}, persistent: {downloads: {files: {}}, mods: {ownGame: {
    ownMod: {id: 'ownMod', state: 'installed', installationPath: 'ownMod', attributes: {}}}}}};
  class SetupError extends Error {}
  class UserCanceled extends Error {}
  class ProcessCanceled extends Error {}
  class TemporaryError extends Error {}
  class ArchiveBrokenError extends Error {}
  class DataInvalid extends Error {}
  class InsufficientDiskSpace extends Error {}
  const api = {getState: () => state, store: {getState: () => state, dispatch: () => {}},
    dismissNotification: () => {}, translate: value => value, genMd5Hash: async () => ({}),
    sendNotification: () => events.push('archive-error-notification'),
    events: {emit: name => {assert.equal(name, 'did-install-mod'); events.push(name); if (eventFailure) throw eventFailure; return true;}}};
  const context = {beginBatch: () => {}, finishInstallCB: outcome => {context.mInstallOutcome = outcome;},
    flushBatch: () => [], reportError: () => {}, stopIndicator: () => events.push('stopIndicator')};
  const globals = {path, shortid: () => 'own-id', Zip: class {}, SetupError, UserCanceled, ProcessCanceled,
    TemporaryError, ArchiveBrokenError, DataInvalid, InsufficientDiskSpace,
    getBatchContext: () => undefined, activeProfile: () => ({id: 'ownProfile', gameId: 'ownGame'}),
    profileById: () => ({id: 'ownProfile', gameId: 'ownGame'}), activeGameId: () => 'ownGame',
    downloadToModRef: () => ({}), truthy: Boolean, unknownToError: value => value instanceof Error ? value : Error(String(value)),
    getErrorCode: () => undefined, getErrorMessageOrDefault: value => value?.message ?? 'ERROR',
    prettifyNodeErrorMessage: value => ({message: value.message, replace: {}}), setError: () => {},
    getSafe: (value, keys, fallback) => keys.reduce((v, k) => v?.[k], value) ?? fallback,
    log: (...args) => {logs.push(args); if (successLogFailure && args[1] === 'Installation completed successfully'
      || diagnosticFailure && ['InstallManager: completion callback threw', 'InstallManager: completion bookkeeping failed'].includes(args[1])) throw Error('own log failure');},
    _: {omit: value => value}, batchDispatch: () => {},
    setFileOverride: () => ({}), addModRule: () => ({}), dismissNotification: () => ({}),
    fs: {removeAsync: async name => {removals.push(name);}}, __context: context,
    __start: () => {beforeTail?.(manager); if (fail === 'archive') throw new ArchiveBrokenError('own archive failure'); if (fail) throw fail; return {own: 'metadata'};}};
  const Manager = vm.runInNewContext(extractClassDeclaration(observed) + '\nInstallManager;', globals, {timeout: 1000});
  const manager = Object.create(Manager.prototype);
  Object.assign(manager, {mApi: api, mActiveInstalls: new Map(), mPendingInstalls: new Map(), __callbacks: [],
    mRecentChangedPaths: new Set(), setModSize: () => events.push('setModSize'), isBrowserAssistantError: () => false,
    mInstallLimit: {do: action => {const result = Promise.resolve().then(action); result.catch(() => {}); tasks.push(result); return result;}}});
  if (recentFailure) manager.markRecentInstall = () => {throw Error('private recent failure');};
  function install() {
    manager.install(null, 'ownMod.zip', ['ownGame'], api, {}, false, false, (err, id) => {
      calls.push([err, id]); events.push(err ? 'callback-error' : 'callback-success'); callback(err, id, manager);
    }, 'ownGame', undefined, false, undefined, false);
  }
  return {manager, install, events, removals, logs, calls, tasks, context, SetupError};
}
const tick = () => new Promise(resolve => setImmediate(resolve));

integration('source-derived baseline exposes success before event; patch emits event before one success callback', async () => {
  const {input, patched} = sources();
  for (const [source, expected] of [[input, ['setModSize', 'callback-success', 'did-install-mod']],
    [patched, ['setModSize', 'did-install-mod', 'callback-success']]]) {
    const f = fixture(source); f.install(); assert.equal(await f.tasks[0], 'ownMod'); await tick();
    assert.deepEqual(f.events.slice(0, 3), expected); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], null); assert.equal(f.calls[0][1], 'ownMod'); assert.equal(f.removals.length, 0);
    assert.equal(f.events.filter(name => name === 'stopIndicator').length, 1);
  }
});
integration('source-derived callback throw no longer enters destination removal or duplicates notification', async () => {
  const {input, patched} = sources();
  const before = fixture(input, {callback: () => {if (before.calls.length === 1) throw Error('private callback payload');}});
  before.install(); await assert.rejects(before.tasks[0]); await tick();
  assert.deepEqual(before.removals, ['ownDestination']); assert(before.calls.length > 1);
  const after = fixture(patched, {callback: () => {throw Error('private callback payload');}});
  after.install(); assert.equal(await after.tasks[0], 'ownMod'); await tick();
  assert.equal(after.calls.length, 1); assert.deepEqual(after.removals, []);
  assert.equal(after.manager.getActiveInstallationCount(), 0); assert(after.events.includes('stopIndicator'));
  const diagnostic = after.logs.find(row => row[1] === 'InstallManager: completion callback threw');
  assert(diagnostic); assert(!JSON.stringify(diagnostic).includes('private callback payload'));
});
integration('failed callback exception retains native rejection and original callback arguments exactly once', async () => {
  const nativeError = Error('own native failure'), callbackError = Error('own callback failure');
  const f = fixture(sources().patched, {fail: nativeError, callback: () => {throw callbackError;}});
  f.install(); await assert.rejects(f.tasks[0], error => error === nativeError); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], nativeError); assert.equal(f.calls[0][1], 'ownMod');
  assert.deepEqual(f.removals, ['ownDestination']); assert.equal(f.manager.getActiveInstallationCount(), 0);
  assert.equal(f.events.filter(value => value === 'stopIndicator').length, 1);
});
integration('callback diagnostics cannot throw back into destructive native cleanup', async () => {
  const f = fixture(sources().patched, {diagnosticFailure: true, callback: () => {throw Error('own callback failure');}});
  f.install(); assert.equal(await f.tasks[0], 'ownMod'); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.removals.length, 0); assert.equal(f.manager.getActiveInstallationCount(), 0);
});
integration('source-derived success log and recent-install bookkeeping failures cannot suppress native outcome', async () => {
  for (const options of [{successLogFailure: true}, {recentFailure: true}, {successLogFailure: true, diagnosticFailure: true}]) {
    const f = fixture(sources().patched, options); f.install();
    assert.equal(await f.tasks[0], 'ownMod'); await tick();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], null); assert.equal(f.calls[0][1], 'ownMod');
    assert.equal(f.removals.length, 0); assert.equal(f.manager.getActiveInstallationCount(), 0);
    const diagnostic = f.logs.find(row => row[1] === 'InstallManager: completion bookkeeping failed');
    assert(diagnostic); assert(!JSON.stringify(diagnostic).includes('private recent failure'));
  }
});
integration('replacement tracking record is neither mutated, marked recent nor deleted by callback or fallback', async () => {
  const foreign = {installId: 'ordinary-own-id', gameId: 'foreignGame', modId: 'foreignMod', startTime: 7};
  let marks = 0;
  const f = fixture(sources().patched, {beforeTail: manager => {
    manager.mActiveInstalls.set(foreign.installId, foreign); manager.markRecentInstall = () => {marks++;};
  }});
  f.install(); assert.equal(await f.tasks[0], 'ownMod'); await tick();
  assert.equal(f.calls.length, 1); assert.equal(marks, 0);
  assert.equal(f.manager.mActiveInstalls.get(foreign.installId), foreign);
  assert.deepEqual(foreign, {installId: 'ordinary-own-id', gameId: 'foreignGame', modId: 'foreignMod', startTime: 7});
  assert.equal(f.removals.length, 0);
});
integration('replacement created inside user callback survives callback finally and outer fallback', async () => {
  const foreign = {installId: 'ordinary-own-id', gameId: 'foreignGame', modId: 'foreignMod'};
  const f = fixture(sources().patched, {callback: (err, id, manager) => manager.mActiveInstalls.set(foreign.installId, foreign)});
  f.install(); assert.equal(await f.tasks[0], 'ownMod'); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.manager.mActiveInstalls.get(foreign.installId), foreign);
});
integration('tracking replacement before limiter admission refuses only the old job without touching replacement', async () => {
  const f = fixture(sources().patched), foreign = {installId: 'ordinary-own-id', modId: 'foreignMod', gameId: 'foreignGame'};
  f.install(); f.manager.mActiveInstalls.set(foreign.installId, foreign);
  await assert.rejects(f.tasks[0], error => error.message === 'Installation tracking lost'); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0].message, 'Installation tracking lost');
  assert.equal(f.manager.mActiveInstalls.get(foreign.installId), foreign);
  assert.equal(f.removals.length, 0); assert(!f.events.includes('did-install-mod'));
});
integration('actual force-clean notification and late native success share one callback without claiming native termination', async () => {
  let cleaned;
  const f = fixture(sources().patched, {beforeTail: manager => {
    for (const row of manager.mActiveInstalls.values()) row.startTime = 0;
    cleaned = manager.forceCleanupStuckInstalls(manager.mApi, 1);
  }});
  f.install(); assert.equal(await f.tasks[0], 'ownMod'); await tick();
  assert.equal(cleaned, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0].name, 'InstallationTimeoutError'); assert.equal(f.calls[0][1], 'ownMod');
  assert(f.events.includes('did-install-mod'), 'native pipeline still proceeds after forced tracking cleanup');
  assert(!f.events.includes('callback-success')); assert.equal(f.removals.length, 0);
  assert.equal(f.manager.getActiveInstallationCount(), 0);
});
integration('force-clean snapshot skips a row replaced by an earlier collected callback', () => {
  const f = fixture(sources().patched), foreign = {installId: 'second', modId: 'foreign', startTime: 1};
  let secondCalls = 0;
  const first = {installId: 'first', modId: 'own-first', startTime: 0,
    callback: () => f.manager.mActiveInstalls.set('second', foreign)};
  const second = {installId: 'second', modId: 'own-second', startTime: 0, callback: () => {secondCalls++;}};
  f.manager.mActiveInstalls.set('first', first); f.manager.mActiveInstalls.set('second', second);
  assert.equal(f.manager.forceCleanupStuckInstalls(f.manager.mApi, 1), 1);
  assert.equal(secondCalls, 0); assert.equal(f.manager.mActiveInstalls.get('second'), foreign);
  assert.equal(f.manager.mActiveInstalls.size, 1);
});
integration('duplicate and reentrant completion invokes user callback once and preserves another job', async () => {
  const f = fixture(sources().patched, {callback: (err, id, manager) => {
    manager.__callbacks[0](Error('reentrant'), 'other');
  }});
  f.manager.mActiveInstalls.set('other-job', {installId: 'other-job', modId: 'untouched'});
  f.install(); assert.equal(await f.tasks[0], 'ownMod'); await tick();
  f.manager.__callbacks[0](Error('late'), null);
  assert.equal(f.calls.length, 1); assert.equal(f.manager.mActiveInstalls.size, 1);
  assert.equal(f.manager.mActiveInstalls.get('other-job').modId, 'untouched');
});
integration('did-install-mod listener failure cannot produce an earlier success callback', async () => {
  const failure = Error('own event failure'), f = fixture(sources().patched, {eventFailure: failure});
  f.install(); await assert.rejects(f.tasks[0], error => error === failure); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], failure);
  assert(!f.events.includes('callback-success')); assert.equal(f.manager.getActiveInstallationCount(), 0);
});
integration('early unfinished-download callback throw is contained and never enters the installer limiter', () => {
  const f = fixture(sources().patched, {callback: () => {throw Error('own callback failure');}});
  // Invoke the actual early rejection path with a supplied finished-state error.
  f.manager.mApi.getState().persistent.downloads.files.incomplete = {state: 'paused'};
  assert.doesNotThrow(() => f.manager.install('incomplete', 'ownMod.zip', ['ownGame'], f.manager.mApi, {}, false, false,
    () => {throw Error('own callback failure');}, 'ownGame'));
  assert.equal(f.tasks.length, 0); assert.equal(f.manager.getActiveInstallationCount(), 0);
});
integration('no synthetic success is added to existing missing-callback recovery and native finally stays after callback', () => {
  const {input, patched} = sources();
  const fallback = source => source.slice(source.indexOf('// Handle the installationPromise completion/failure'),
    source.indexOf('  public installDependencies('));
  assert.equal(fallback(patched).replaceAll('this.mActiveInstalls.get(installId) === installInfo', 'this.mActiveInstalls.has(installId)'), fallback(input));
  const promiseCallback = source => source.slice(source.indexOf('          const promiseCallback ='),
    source.indexOf('          let existingMod:'));
  assert.equal(promiseCallback(patched).replace('if (activeInstall === installInfo)', 'if (activeInstall)'), promiseCallback(input));
  assert(patched.indexOf('promiseCallback?.(null, modId)') < patched.indexOf('installContext.stopIndicator(mod)'));
});
integration('source-derived archive-error notification fallback still delivers no synthetic success callback', async () => {
  const {input, patched} = sources();
  for (const source of [input, patched]) {
    const f = fixture(source, {fail: 'archive'}); f.install();
    assert.equal(await f.tasks[0], 'ownMod'); await tick();
    assert.equal(f.calls.length, 0); assert.equal(f.context.mInstallOutcome, 'failed');
    assert(f.events.includes('archive-error-notification')); assert(f.events.includes('stopIndicator'));
    assert.equal(f.manager.getActiveInstallationCount(), 0);
  }
});
integration('callback patch refuses an unpatched original or changed prerequisite instead of fuzzy application', () => {
  const original = new TextDecoder('utf-8', {fatal: true}).decode(readFileSync(sourcePath));
  assert.throws(() => applyExact(original, patch, manifest.upstreamPath), /exact hunk context/);
  assert.throws(() => applyExact(sources().input.replace('callback?.(err, id);', 'callback?.(id, err);'), patch, manifest.upstreamPath), /exact hunk context/);
});
