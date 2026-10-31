import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, randomBytes} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import {applyExact, extractClassDeclaration} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('refresh-lifecycle.json', base)));
const hash = value => createHash('sha256').update(value).digest('hex');
const managerPath = process.env.VORTEX_NATIVE_INSTALL_MANAGER;
const handlersPath = process.env.VORTEX_NATIVE_EVENT_HANDLERS;
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: managerPath && handlersPath ? false : 'Provide exact original manager/eventHandlers sources'}, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function patched(source, name) {
  const m = JSON.parse(readFileSync(new URL(name+'.json', base)));
  const p = readFileSync(new URL(name+'.patch', base), 'utf8');
  assert.equal(hash(source), m.inputSHA256); assert.equal(hash(p), m.patchSHA256);
  const output = applyExact(source, p, m.upstreamPath);
  assert.equal(hash(output), m.outputSHA256); return output;
}
let cached;
function sources() {
  if (cached) return cached;
  let manager = readFileSync(managerPath, 'utf8');
  for (const name of ['ordinary-tracking', 'callback-order', 'native-activity', 'strict-selection',
    'copy-error', 'transfer-join', 'manager-exclusion', 'lifecycle-owner-bridge', 'lifecycle-result-bridge']) manager = patched(manager, name);
  const original = readFileSync(handlersPath, 'utf8');
  const prior = patched(original, 'lifecycle-handler-ownership');
  return cached = {manager, prior, handlers: patched(prior, 'refresh-lifecycle')};
}
function fixture({refresh, manifest: getManifestResult, save, activator, baseline = false, stateFailure,
  changeActivator = false, showFailure} = {}) {
  const calls = [];
  class ProcessCanceled extends Error {}
  class UserCanceled extends Error {}
  class TemporaryError extends Error {}
  class VortexError extends Error {}
  const errors = {ProcessCanceled, UserCanceled, TemporaryError, VortexError};
  const Manager = vm.runInNewContext(extractClassDeclaration(sources().manager)+'\nInstallManager;',
    {randomBytes, ...errors}, {timeout: 1000});
  const manager = Object.assign(Object.create(Manager.prototype), {
    mNativeInstallScopeId: 'manager-own-1', mPendingInstalls: new Map(), mActiveInstalls: new Map(),
    mNativeInstallActivities: new Map(), mOptionalDownloadsInFlight: new Set(), mDependencyInstalls: {},
  });
  manager.registerNativeManager();
  const profile = {id: 'ownProfile', gameId: 'ownGame'};
  const state = {app: {instanceId: 'own'}, settings: {gameMode: {discovered: {ownGame: {path: 'ownGamePath'}}}},
    persistent: {mods: {ownGame: {}}}};
  const api = {store: {getState: () => {if (stateFailure) throw stateFailure; return state;}, dispatch: value => calls.push(['dispatch', value])},
    getState: () => state, translate: text => text,
    events: {emit: name => calls.push(['event', name])},
    emitAndAwait: async name => {calls.push(['await', name]);},
    showErrorNotification: (...args) => calls.push(['notification', ...args]),
    sendNotification: value => calls.push(['notification', value]), dismissNotification: () => {},
  };
  const defaultActivator = activator ?? {id: 'ownActivator'};
  const environment = {...errors, InstallManager: Manager,
    activeProfile: () => profile, installPath: () => 'ownStage', getSafe: (v, keys, fallback) => keys.reduce((v,k) => v?.[k], v) ?? fallback,
    getGame: () => ({name: 'ownGame', getModPaths: () => ({first: 'ownData1', second: 'ownData2'})}),
    getSupportedActivators: () => changeActivator ? [] : [defaultActivator],
    getCurrentActivator: () => changeActivator ? undefined : defaultActivator,
    allTypesSupported: () => ({errors: [{description: () => 'own incompatibility'}]}),
    currentActivator: () => defaultActivator.id, getSelectedActivator: () => ({id: 'selected'}),
    setErrorContext: () => {}, truthy: Boolean, log: () => {},
    getErrorCode: error => error?.code, getErrorMessageOrDefault: error => error?.message,
    unknownToError: error => error instanceof Error ? error : Error(String(error)),
    showError: (...args) => {calls.push(['showError', ...args]); if (showFailure) throw showFailure;},
    refreshMods: (...args) => {calls.push(['refresh', ...args]); return refresh?.promise ?? Promise.resolve();},
    getManifest: (...args) => {calls.push(['manifest', ...args]); return getManifestResult?.(...args) ?? Promise.resolve({instance: 'own', gameId: 'ownGame', files: []});},
    ensureStagingDirectory: async () => 'ownStage', getNormalizeFunc: async () => value => value,
    saveActivation: (...args) => {calls.push(['save', ...args]); return save?.(...args) ?? Promise.resolve();},
    setActivator: () => ({}), setInstallPath: () => ({}), dropMissingMods: () => {}, addMod: () => ({}),
  };
  const js = stripTypeScriptTypes(baseline ? sources().prior : sources().handlers, {mode: 'transform'})
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  const h = vm.runInNewContext(js+'\n({onGameModeActivated,onPathsChanged,purgeOldMethod});', environment, {timeout: 1000});
  return {h, manager, Manager, api, calls, profile, errors};
}

test('refresh patch binds the exact prior handler packet and grants no permit', () => {
  const previous = JSON.parse(readFileSync(new URL('lifecycle-handler-ownership.json', base)));
  assert.equal(manifest.inputSHA256, previous.outputSHA256);
  assert.equal(manifest.prerequisitePatchSHA256, previous.patchSHA256);
  const p = readFileSync(new URL('refresh-lifecycle.patch', base), 'utf8');
  assert.equal(hash(p), manifest.patchSHA256); assert(!p.includes('\r'));
  assert.equal(manifest.preparedOnly, true);
  for (const key of ['installed','nativeAcceptanceVerified','nativeTerminalGuarantee','globalIdleGuarantee','installationPermit'])
    assert.equal(manifest[key], false);
});

integration('path refresh retains its actual deferred tail and preserves public void', async () => {
  const refresh = deferred(), f = fixture({refresh});
  assert.equal(f.h.onPathsChanged(f.api, {ownGame: 'old'}, {ownGame: 'new'}), undefined);
  assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
  refresh.resolve(); await tick(); await tick();
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 0);
});

integration('game activation retains initialization and refresh until actual settlement', async () => {
  const refresh = deferred(), init = deferred();
  const f = fixture({refresh, manifest: () => init.promise});
  assert.equal(f.h.onGameModeActivated(f.api, [], 'ownGame'), undefined);
  assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
  init.resolve({instance: 'own', gameId: 'ownGame', files: []}); await tick();
  assert.equal(f.calls.filter(row => row[0] === 'refresh').length, 1);
  assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
  refresh.resolve(); await tick(); await tick();
  assert(f.calls.some(row => row[1] === 'mods-refreshed'));
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 0);
});

integration('exclusive refusal starts neither refresh nor manifest work', async () => {
  const f = fixture(); f.manager.reserveNativeInstallExclusion();
  assert.equal(f.h.onPathsChanged(f.api, {ownGame: 'old'}, {ownGame: 'new'}), undefined);
  assert.equal(f.h.onGameModeActivated(f.api, [], 'ownGame'), undefined);
  await tick(); assert(!f.calls.some(row => ['refresh','manifest'].includes(row[0])));
  assert.equal(f.calls.filter(row => row[0] === 'showError').length, 2);
});

integration('refresh rejection reports its existing failure and keeps ownership held', async () => {
  const refresh = deferred(), f = fixture({refresh});
  f.h.onPathsChanged(f.api, {ownGame: 'old'}, {ownGame: 'new'});
  const failure = Error('own failure'); refresh.reject(failure); await tick(); await tick();
  assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
  const reports = f.calls.filter(row => row[0] === 'showError');
  assert.equal(reports.length, 1); assert.equal(reports[0][3], failure);
});

integration('old-method manifest save failures join siblings before postPurge and retain first error', async () => {
  const sibling = deferred(), primary = Error('first save'), cleanup = Error('cleanup');
  let post = 0;
  const activator = {id: 'old', prePurge: async () => {}, purge: async () => {},
    postPurge: async () => {post++; throw cleanup;}};
  const f = fixture({activator, save: (_game, type) => type === 'first' ? Promise.reject(primary) : sibling.promise});
  const result = f.h.purgeOldMethod(f.api, activator, f.profile, 'ownGame', 'ownStage', {first: 'data1', second: 'data2'});
  const settled = result.then(() => assert.fail('must reject'), error => error);
  await tick(); assert.equal(post, 0);
  sibling.resolve(); assert.equal(await settled, primary); assert.equal(post, 1);
});

integration('baseline path refresh returns before its pending work; patched ownership prevents admission', async () => {
  const refresh = deferred(), original = fixture({refresh, baseline: true});
  original.h.onPathsChanged(original.api, {ownGame: 'old'}, {ownGame: 'new'});
  assert.equal(original.manager.getNativeInstallExclusion().legacyCalls, 0);
  original.manager.reserveNativeInstallExclusion();
  refresh.resolve(); await tick();
  const pending = deferred(), current = fixture({refresh: pending});
  current.h.onPathsChanged(current.api, {ownGame: 'old'}, {ownGame: 'new'});
  assert.throws(() => current.manager.reserveNativeInstallExclusion(), /busy/);
  pending.resolve(); await tick(); await tick();
});

integration('synchronous startup failure reports once and cannot refund lifecycle ownership', async () => {
  const failure = Error('own startup'), f = fixture({stateFailure: failure});
  assert.doesNotThrow(() => f.h.onPathsChanged(f.api, {ownGame: 'old'}, {ownGame: 'new'}));
  await tick(); assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
  const reports = f.calls.filter(row => row[0] === 'showError');
  assert.equal(reports.length, 1); assert.equal(reports[0][3], failure);
});

integration('baseline purge loses a running manifest sibling; patched purge joins it before reporting', async () => {
  for (const baseline of [true, false]) {
    const sibling = deferred(), primary = Error('own manifest failure');
    const f = fixture({baseline, manifest: (_api, type) => type === 'first' ? Promise.reject(primary) : sibling.promise});
    let settled = false;
    const result = f.h.purgeOldMethod(f.api, {}, f.profile, 'ownGame', 'ownStage', {first: 'data1', second: 'data2'})
      .then(() => {settled = true; return null;}, error => {settled = true; return error;});
    await tick(); assert.equal(settled, baseline);
    sibling.resolve({files: []});
    assert.equal(await result, baseline ? null : primary);
  }
});

integration('purge notification failure never replaces the primary joined error', async () => {
  const primary = Error('own primary');
  const activator = {prePurge: async () => {}, purge: async () => {throw primary;}, postPurge: async () => {}};
  const f = fixture({activator});
  f.api.showErrorNotification = () => {throw Error('own notification');};
  await assert.rejects(f.h.purgeOldMethod(f.api, activator, f.profile, 'ownGame', 'ownStage', {first: 'data1'}),
    error => error === primary);
});

integration('full game activation cannot swallow a canceled old-method purge and continue refreshing', async () => {
  const activator = {id: 'old', prePurge: async () => {throw primary;}};
  const f = fixture({activator, changeActivator: true});
  const primary = new f.errors.ProcessCanceled('own canceled purge');
  let observed;
  const track = f.Manager.trackNativeLifecycleCall;
  f.Manager.trackNativeLifecycleCall = action => {
    const result = track.call(f.Manager, action);
    result.catch(error => {observed = error;}); return result;
  };
  assert.equal(f.h.onGameModeActivated(f.api, [activator], 'ownGame'), undefined);
  await tick(); await tick();
  assert.equal(observed, primary);
  assert(!f.calls.some(row => row[0] === 'refresh'));
  assert(!f.calls.some(row => row[0] === 'dispatch'));
  assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
});

integration('both complete public refresh handlers retain original failure when error presentation throws', async () => {
  for (const gameActivation of [false, true]) {
    const refresh = deferred(), primary = Error('own refresh failure');
    const f = fixture({refresh, showFailure: Error('own presentation failure')});
    let observed;
    const track = f.Manager.trackNativeLifecycleCall;
    f.Manager.trackNativeLifecycleCall = action => {
      const result = track.call(f.Manager, action);
      result.catch(error => {observed = error;}); return result;
    };
    if (gameActivation) f.h.onGameModeActivated(f.api, [], 'ownGame');
    else f.h.onPathsChanged(f.api, {ownGame: 'old'}, {ownGame: 'new'});
    await tick(); refresh.reject(primary); await tick(); await tick();
    assert.equal(observed, primary);
    assert.equal(f.calls.filter(row => row[0] === 'showError').length, 1);
    assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
  }
});
