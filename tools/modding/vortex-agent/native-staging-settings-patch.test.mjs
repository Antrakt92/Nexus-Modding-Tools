import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, randomBytes} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import {applyExact, hunks, extractClassDeclaration} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('staging-settings-ownership.json', base)));
const patch = readFileSync(new URL('staging-settings-ownership.patch', base), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const integration = (name, action) => test(name, {timeout: 10000,
  skip: process.env.VORTEX_NATIVE_INSTALL_MANAGER && process.env.VORTEX_NATIVE_STAGING_SETTINGS_SOURCE
    ? false : 'Provide exact original InstallManager.ts and mod-management views/Settings.tsx'}, action);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
function apply(raw, name) {
  const m = JSON.parse(readFileSync(new URL(name+'.json', base)));
  const p = readFileSync(new URL(name+'.patch', base), 'utf8');
  assert.equal(hash(raw), m.inputSHA256); assert.equal(hash(p), m.patchSHA256);
  const output = applyExact(raw, p, m.upstreamPath); assert.equal(hash(output), m.outputSHA256);
  return output;
}
let cache;
function sources() {
  if (cache) return cache;
  let manager = readFileSync(process.env.VORTEX_NATIVE_INSTALL_MANAGER, 'utf8');
  for (const name of ['ordinary-tracking', 'callback-order', 'native-activity', 'strict-selection',
    'copy-error', 'transfer-join', 'manager-exclusion', 'lifecycle-owner-bridge', 'lifecycle-result-bridge']) manager = apply(manager, name);
  const original = readFileSync(process.env.VORTEX_NATIVE_STAGING_SETTINGS_SOURCE, 'utf8');
  assert.equal(hash(original), manifest.originalSourceSHA256);
  return cache = {manager, original, settings: apply(original, 'staging-settings-ownership')};
}
// The actual non-rendering methods are compiled together. No JSX, constructor,
// React mount, transfer utility, native API or filesystem operation is executed.
function method(source, name, field = false) {
  const start = source.indexOf('  private '+name+(field ? ' =' : '(')); assert(start >= 0, name);
  const ending = field ? '\n  };' : '\n  }'; const end = source.indexOf(ending, start); assert(end > start, name);
  return source.slice(start, end+ending.length);
}
function fixture({baseline = false, normalize, testTransfer, ensure, dialog, purge, move,
  files = [], sourceMissing = false, showFailure, logFailure, statFailure, defaultStaging = false, noActivator = false,
  afterSetTransfer, noopSetPath = false} = {}) {
  const calls = [], dialogs = []; let f;
  class ProcessCanceled extends Error {}
  class UserCanceled extends Error {}
  class TemporaryError extends Error {}
  class CleanupFailedException extends Error {constructor(error) {super('own cleanup failed'); this.errorObject = error;}}
  class InsufficientDiskSpace extends Error {}
  class UnsupportedOperatingSystem extends Error {}
  class NotFound extends Error {}
  class NoDeployment extends Error {}
  const errors = {ProcessCanceled, UserCanceled, TemporaryError, CleanupFailedException,
    InsufficientDiskSpace, UnsupportedOperatingSystem, NotFound, NoDeployment};
  const Manager = vm.runInNewContext(extractClassDeclaration(sources().manager)+'\nInstallManager;',
    {randomBytes, ...errors}, {timeout: 1000});
  const manager = Object.assign(Object.create(Manager.prototype), {
    mNativeInstallScopeId: 'manager-staging-1', mActiveInstalls: new Map(), mPendingInstalls: new Map(),
    mNativeInstallActivities: new Map(), mOptionalDownloadsInFlight: new Set(), mDependencyInstalls: {},
  }); manager.registerNativeManager();
  const runtime = {activeGame: 'own', activeProfile: 'p', app: {instanceId: 'instance'},
    settings: {mods: {installPath: {own: defaultStaging ? undefined : 'F:/Old'}, activator: {own: noActivator ? undefined : 'old'}},
      gameMode: {discovered: {own: {path: 'F:/Game'}}}},
    persistent: {profiles: {p: {gameId: 'own'}, p2: {gameId: 'own'}}, transactions: {transfer: {}}}};
  const api = {getState: () => {calls.push(['read-state']); return runtime;},
    store: {getState: () => runtime}, showErrorNotification: (...args) => {calls.push(['notification', ...args]); if (showFailure) throw showFailure;},
    events: {emit: (name, fallback, callback) => {
      assert.equal(name, 'purge-mods'); calls.push(['purge', runtime.activeGame]);
      Promise.resolve(purge?.promise).then(() => callback(null), error => callback(error));
    }}};
  const environment = {...errors, InstallManager: Manager, path: path.win32,
    unknownToError: error => error instanceof Error ? error : Error(String(error)), getErrorCode: error => error?.code,
    getErrorMessageOrDefault: error => error?.message ?? String(error), getInstallPath: value => value ?? 'F:/Default',
    selectors: {activeGameId: state => state.activeGame, activeProfileId: state => state.activeProfile},
    getSafe: (value, keys, fallback) => keys.reduce((v, key) => v?.[key], value) ?? fallback,
    getVortexPath: () => 'F:/Vortex', isReservedDirectory: () => false, isChildPath: () => false,
    STAGING_DIR_TAG: 'staging-tag',
    getNormalizeFunc: target => {calls.push(['normalize', target]); return normalize?.promise ?? Promise.resolve(value => value);},
    testPathTransfer: (oldPath, newPath) => {calls.push(['test', oldPath, newPath]); return testTransfer?.promise ?? Promise.resolve();},
    transferPath: (oldPath, newPath) => {calls.push(['move', oldPath, newPath]); return move?.promise ?? Promise.resolve();},
    cleanFailedTransfer: target => {calls.push(['unsafe-cleanup', target]); f.destination.clear(); return Promise.resolve();},
    withTrackedActivity: (_a, _b, _c, work) => work(),
    log: (_level, message) => {const error = logFailure?.(message); if (error) throw error;},
    fs: {
      statSync: () => {throw statFailure ?? Object.assign(Error('own new target'), {code: 'ENOENT'});},
      statAsync: target => {calls.push(['stat-source', target]); return sourceMissing
        ? Promise.reject(Object.assign(Error('own missing source'), {code: 'ENOENT'})) : Promise.resolve({});},
      ensureDirAsync: target => {calls.push(['ensure', target]); return ensure?.promise ?? Promise.resolve();},
      readdirAsync: target => {calls.push(['readdir', target]); return Promise.resolve(files);},
      readFileAsync: () => Promise.resolve(JSON.stringify({instance: 'other-instance'})),
    },
  };
  const source = baseline ? sources().original : sources().settings;
  const code = 'class SettingsHarness {\n'+[
    ...(!baseline ? [method(source, 'assertStagingOperation')] : []),
    method(source, 'transferPath'), method(source, 'applyPaths', true),
    method(source, 'checkTargetEmpty'), method(source, 'purgeActivation'), method(source, 'onApply', true),
  ].join('\n')+'\n}';
  const Harness = vm.runInNewContext(stripTypeScriptTypes(code, {mode: 'transform'})+'\nSettingsHarness;', environment, {timeout: 1000});
  const settings = new Harness(); settings.context = {api};
  settings.state = {installPath: 'F:/New', progress: 0, supportedActivators: [{id: 'old'}]};
  settings.nextState = {};
  settings.props = {gameMode: 'own', instanceId: 'instance', installPath: defaultStaging ? undefined : 'F:/Old', discovery: {path: 'F:/Game'},
    currentActivator: noActivator ? undefined : 'old', t: value => value,
    onSetTransfer: (game, target) => {calls.push(['set-transfer', game, target]); if (target === undefined) delete runtime.persistent.transactions.transfer[game]; else runtime.persistent.transactions.transfer[game] = target; afterSetTransfer?.(game, target, runtime);},
    onSetInstallPath: (game, target) => {calls.push(['set-path', game, target]); if (!noopSetPath) runtime.settings.mods.installPath[game] = target;},
    onShowError: (...args) => {calls.push(['error', ...args]); if (showFailure) throw showFailure;},
    onShowDialog: (_type, title, _content, actions) => {
      calls.push(['dialog', title]); dialogs.push({title, actions});
      const result = dialog?.(title, actions) ?? Promise.resolve({action: title === 'Confirm' ? 'Continue' : 'Close'});
      // This models the official showDialog thunk: selected optional action
      // executes before its returned result promise resolves.
      return Promise.resolve(result).then(value => {actions.find(action => action.label === value.action)?.action?.(); return value;});
    },
  };
  f = {settings, manager, Manager, runtime, calls, dialogs, errors, destination: new Map([['existing.txt', 'keep']])};
  return f;
}

function observeFailure(f) {
  const track = f.Manager.trackNativeLifecycleCall; let failure;
  f.Manager.trackNativeLifecycleCall = action => {
    const result = track.call(f.Manager, action);
    result.catch(error => {failure = error;}); return result;
  };
  return () => failure;
}

test('staging Settings patch pins one original TSX source and the shared result bridge without admission', () => {
  const bridge = JSON.parse(readFileSync(new URL('lifecycle-result-bridge.json', base)));
  assert.equal(manifest.requiredManagerPatchSHA256, bridge.patchSHA256);
  assert.equal(manifest.inputSHA256, manifest.originalSourceSHA256); assert.equal(hash(patch), manifest.patchSHA256);
  assert.equal(manifest.preparedOnly, true);
  for (const flag of ['installed', 'nativeAcceptanceVerified', 'nativeTerminalGuarantee', 'globalIdleGuarantee', 'installationPermit']) assert.equal(manifest[flag], false);
  for (const h of hunks(patch, manifest.upstreamPath)) for (const line of h.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1), /[\t ]$/);
});

integration('baseline onApply detaches the transfer; patched void handler owns normalize and the whole transfer tail', async () => {
  for (const baseline of [true, false]) {
    const normalize = deferred(), move = deferred(), f = fixture({baseline, normalize, move});
    const returned = f.settings.onApply();
    if (!baseline) {
      assert.equal(returned, undefined); assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
      assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
    }
    normalize.resolve(value => value); await tick();
    assert(f.calls.some(row => row[0] === 'move'));
    if (baseline) {await returned; f.manager.reserveNativeInstallExclusion();}
    else assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
    move.resolve(); await tick(); await tick();
    assert(f.calls.some(row => row[0] === 'set-path' && row[2] === 'F:/New'));
    if (!baseline) assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 0);
  }
});

integration('exclusive refusal happens before normalize, actual Redux reads, dialogs or filesystem work', async () => {
  const f = fixture(); f.manager.reserveNativeInstallExclusion();
  assert.equal(f.settings.onApply(), undefined); await tick();
  assert.deepEqual(f.calls.map(row => row[0]), ['error']);
});

integration('deferred test, ensure, target dialog and purge each retain ownership before later effects', async () => {
  for (const stage of ['test', 'ensure', 'dialog', 'purge']) {
    const pending = deferred();
    const f = fixture({testTransfer: stage === 'test' ? pending : undefined, ensure: stage === 'ensure' ? pending : undefined,
      purge: stage === 'purge' ? pending : undefined, files: stage === 'dialog' ? ['staging-tag'] : [],
      dialog: stage === 'dialog' ? () => pending.promise : undefined});
    f.settings.onApply(); await tick();
    assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
    assert(!f.calls.some(row => row[0] === 'move'));
    pending.resolve(stage === 'dialog' ? {action: 'Continue'} : undefined); await tick(); await tick();
    assert(f.calls.some(row => row[0] === 'set-path'));
    assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 0);
  }
});

integration('cleanup-failed and insufficient-space dialogs remain joined and primary errors cannot become success', async () => {
  for (const kind of ['cleanup', 'space']) {
    const move = deferred(), presentation = deferred();
    const f = fixture({move, dialog: () => presentation.promise});
    const observed = observeFailure(f);
    f.settings.onApply(); await tick();
    const primary = kind === 'cleanup' ? new f.errors.CleanupFailedException(Error('own old-folder cleanup')) : new f.errors.InsufficientDiskSpace('own space');
    move.reject(primary); await tick();
    assert(f.calls.some(row => row[0] === 'dialog'));
    assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
    presentation.reject(Error('own presentation failure')); await tick(); await tick();
    assert.equal(observed(), primary);
    assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
    assert.equal(f.calls.filter(row => row[0] === 'unsafe-cleanup').length, 0);
  }
});

integration('failed merge preserves pre-existing destination data and pending transaction instead of deleting the whole directory', async () => {
  for (const baseline of [true, false]) {
    const move = deferred(), f = fixture({baseline, move, files: ['staging-tag']});
    const result = f.settings.onApply(); if (baseline) await result;
    await tick(); assert(f.calls.some(row => row[0] === 'move'));
    move.reject(Error('own partial merge failure')); await tick(); await tick();
    if (baseline) {assert.equal(f.destination.size, 0); assert(f.calls.some(row => row[0] === 'unsafe-cleanup'));}
    else {
      assert.equal(f.destination.get('existing.txt'), 'keep'); assert(!f.calls.some(row => row[0] === 'unsafe-cleanup'));
      assert.equal(f.runtime.persistent.transactions.transfer.own, 'F:/New');
      assert(!f.calls.some(row => row[0] === 'set-path')); assert.equal(f.settings.nextState.busy, undefined);
      assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
    }
  }
});

integration('user cancellation and reporting/logger failures are observed once and retain failed operation ownership', async () => {
  const move = deferred(), primary = Error('own transfer failure'), f = fixture({move, showFailure: Error('own notification failure')});
  const observed = observeFailure(f);
  f.settings.onApply(); await tick(); move.reject(primary); await tick(); await tick();
  assert.equal(observed(), primary);
  assert.equal(f.calls.filter(row => row[0] === 'error').length, 2);
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
  const normalize = deferred(), before = fixture({normalize, showFailure: Error('own reporting failure'), logFailure: () => Error('own logging failure')});
  assert.doesNotThrow(() => before.settings.onApply()); normalize.reject(Error('own normalize failure')); await tick(); await tick();
  assert.equal(before.calls.filter(row => row[0] === 'error').length, 1);
  assert.equal(before.manager.getNativeInstallExclusion().legacyCalls, 1);
  const canceled = deferred(), c = fixture({move: canceled}); c.settings.onApply(); await tick();
  canceled.reject(new c.errors.UserCanceled()); await tick(); await tick();
  assert.equal(c.manager.getNativeInstallExclusion().legacyCalls, 1); assert(!c.calls.some(row => row[0] === 'unsafe-cleanup'));
});

integration('frozen paths survive editable component state changes during normalize, dialogs and transfer', async () => {
  const normalize = deferred(), target = deferred(), move = deferred();
  const f = fixture({normalize, move, files: ['staging-tag'], dialog: () => target.promise});
  f.settings.onApply(); f.settings.state.installPath = 'F:/ChangedBeforeNormalize';
  normalize.resolve(value => value); await tick();
  f.settings.state.installPath = 'F:/ChangedInDialog'; target.resolve({action: 'Continue'}); await tick();
  assert.deepEqual(f.calls.find(row => row[0] === 'move').slice(1), ['F:/Old', 'F:/New']);
  f.settings.state.installPath = 'F:/ChangedDuringMove'; move.resolve(); await tick(); await tick();
  assert.equal(f.runtime.settings.mods.installPath.own, 'F:/New');
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 0);
});

integration('actual active-game or staging/discovery drift refuses purge, move and final dispatch despite stale props', async () => {
  for (const stage of ['normalize', 'dialog']) for (const drift of ['game', 'profile', 'profile-game', 'activator', 'props-activator', 'path', 'discovery']) {
    const pending = deferred();
    const f = fixture({normalize: stage === 'normalize' ? pending : undefined,
      files: stage === 'dialog' ? ['staging-tag'] : [], dialog: stage === 'dialog' ? () => pending.promise : undefined});
    f.settings.onApply(); await tick();
    if (drift === 'game') f.runtime.activeGame = 'another';
    if (drift === 'profile') f.runtime.activeProfile = 'p2';
    if (drift === 'profile-game') f.runtime.persistent.profiles.p.gameId = 'another';
    if (drift === 'activator') f.runtime.settings.mods.activator.own = 'another-activator';
    if (drift === 'props-activator') f.settings.props.currentActivator = 'another-activator';
    if (drift === 'path') f.runtime.settings.mods.installPath.own = 'F:/ForeignStaging';
    if (drift === 'discovery') f.runtime.settings.gameMode.discovered.own.path = 'F:/MovedGame';
    pending.resolve(stage === 'normalize' ? value => value : {action: 'Continue'}); await tick(); await tick();
    assert(!f.calls.some(row => ['purge', 'move', 'set-path', 'unsafe-cleanup'].includes(row[0])));
    assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
  }
});

integration('initial stale activator props refuse before normalization while undefined/default staging remains valid', async () => {
  const stale = fixture(); stale.settings.props.currentActivator = 'stale-activator';
  stale.settings.onApply(); await tick();
  assert(!stale.calls.some(row => ['normalize', 'test', 'ensure', 'purge', 'move', 'set-path'].includes(row[0])));
  assert.equal(stale.manager.getNativeInstallExclusion().legacyCalls, 1);
  const defaults = fixture({defaultStaging: true, noActivator: true});
  defaults.settings.onApply(); await tick(); await tick();
  assert.deepEqual(defaults.calls.find(row => row[0] === 'move').slice(1), ['F:/Default', 'F:/New']);
  assert(!defaults.calls.some(row => row[0] === 'purge'));
  assert.equal(defaults.runtime.settings.mods.installPath.own, 'F:/New');
  assert.equal(defaults.manager.getNativeInstallExclusion().legacyCalls, 0);
});

integration('purge completion, missing-source dialog and transfer completion recheck actual context before their next effects', async () => {
  for (const stage of ['purge', 'missing-source', 'move']) {
    const pending = deferred();
    const f = fixture({purge: stage === 'purge' ? pending : undefined, move: stage === 'move' ? pending : undefined,
      sourceMissing: stage === 'missing-source', dialog: stage === 'missing-source' ? () => pending.promise : undefined});
    f.settings.onApply(); await tick(); f.runtime.activeProfile = 'p2';
    pending.resolve(stage === 'missing-source' ? {action: 'Reinitialize'} : undefined); await tick(); await tick();
    assert.equal(f.calls.filter(row => row[0] === 'move').length, stage === 'move' ? 1 : 0);
    assert(!f.calls.some(row => ['set-path', 'unsafe-cleanup'].includes(row[0])));
    assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
  }
});

integration('unknown stat errors and canceled target dialogs cannot advance to purge or transfer', async () => {
  const failure = Object.assign(Error('own denied stat'), {code: 'EACCES'});
  const denied = fixture({statFailure: failure}), observed = observeFailure(denied);
  denied.settings.onApply(); await tick();
  assert.equal(observed(), failure);
  assert(!denied.calls.some(row => ['test', 'ensure', 'purge', 'move'].includes(row[0])));
  assert.equal(denied.manager.getNativeInstallExclusion().legacyCalls, 1);
  const canceled = fixture({files: ['staging-tag'], dialog: () => Promise.resolve({action: 'Cancel'})});
  canceled.settings.onApply(); await tick(); await tick();
  assert(!canceled.calls.some(row => ['purge', 'move', 'set-path', 'unsafe-cleanup'].includes(row[0])));
  assert.equal(canceled.manager.getNativeInstallExclusion().legacyCalls, 1);
});

integration('transaction-clear reentrancy cannot commit a staging path under a different profile in either completion branch', async () => {
  for (const baseline of [true, false]) for (const cleanupFailed of [false, true]) {
    const move = deferred();
    const f = fixture({baseline, move, afterSetTransfer: (_game, target, state) => {
      if (target === undefined) state.activeProfile = 'p2';
    }});
    const observed = observeFailure(f);
    const returned = f.settings.onApply(); if (baseline) await returned;
    await tick();
    const primary = new f.errors.CleanupFailedException(Error('own cleanup failure'));
    if (cleanupFailed) move.reject(primary); else move.resolve();
    await tick(); await tick();
    if (baseline) assert(f.calls.some(row => row[0] === 'set-path'));
    else {
      assert(!f.calls.some(row => row[0] === 'set-path'));
      assert.equal(f.runtime.settings.mods.installPath.own, 'F:/Old');
      assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
      assert.equal(f.calls.filter(row => row[0] === 'error').length, 1);
      if (cleanupFailed) assert.equal(observed(), primary);
      else assert(observed() instanceof f.errors.ProcessCanceled);
    }
  }
});

integration('a no-op path dispatcher cannot bless the old Redux setting as a committed move', async () => {
  for (const cleanupFailed of [false, true]) {
    const move = deferred(), f = fixture({move, noopSetPath: true});
    const observed = observeFailure(f); f.settings.onApply(); await tick();
    const primary = new f.errors.CleanupFailedException(Error('own cleanup failure'));
    if (cleanupFailed) move.reject(primary); else move.resolve();
    await tick(); await tick();
    assert.equal(f.calls.filter(row => row[0] === 'set-path').length, 1);
    assert.equal(f.runtime.settings.mods.installPath.own, 'F:/Old');
    assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
    assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
    assert.equal(f.calls.filter(row => row[0] === 'error').length, 1);
    if (cleanupFailed) assert.equal(observed(), primary);
    else assert(observed() instanceof f.errors.ProcessCanceled);
  }
});

integration('initial transfer-marker dispatch reentrancy cannot start moving files for a different profile', async () => {
  for (const baseline of [true, false]) {
    const f = fixture({baseline, afterSetTransfer: (_game, target, state) => {
      if (target !== undefined) state.activeProfile = 'p2';
    }});
    const observed = observeFailure(f);
    const returned = f.settings.onApply(); if (baseline) await returned;
    await tick(); await tick();
    if (baseline) assert(f.calls.some(row => row[0] === 'move'));
    else {
      assert(!f.calls.some(row => ['move', 'set-path', 'unsafe-cleanup'].includes(row[0])));
      assert.equal(f.runtime.persistent.transactions.transfer.own, 'F:/New');
      assert.equal(f.runtime.settings.mods.installPath.own, 'F:/Old');
      assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
      assert(observed() instanceof f.errors.ProcessCanceled);
    }
  }
});
