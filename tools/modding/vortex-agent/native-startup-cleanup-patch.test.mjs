import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, randomBytes} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import {applyExact, hunks, extractClassDeclaration} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('startup-cleanup-ownership.json', base)));
const patch = readFileSync(new URL('startup-cleanup-ownership.patch', base), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const required = ['VORTEX_NATIVE_INSTALL_MANAGER', 'VORTEX_NATIVE_MOD_INDEX'];
const integration = (name, action) => test(name, {timeout: 10000,
  skip: required.every(key => process.env[key]) ? false : 'Provide exact original InstallManager and mod-management index sources'}, action);
const tick = () => new Promise(resolve => setImmediate(resolve));
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
  const original = readFileSync(process.env.VORTEX_NATIVE_MOD_INDEX, 'utf8');
  assert.equal(hash(original), manifest.originalSourceSHA256);
  const prior = apply(apply(original, 'deployment-lifecycle'), 'deployment-error-types');
  assert.equal(hash(prior), manifest.inputSHA256);
  const index = apply(prior, 'startup-cleanup-ownership');
  return cache = {manager, prior, index};
}
function declaration(source, name) {
  const start = source.indexOf('function '+name+'('); assert(start >= 0);
  const end = source.indexOf('\n}', start); assert(end > start);
  return source.slice(start, end+2);
}
function fixture({baseline = false, remove, reportFailure, logFailure, mods, stateFailure} = {}) {
  const calls = [];
  class ProcessCanceled extends Error {}
  class UserCanceled extends Error {}
  const errors = {ProcessCanceled, UserCanceled};
  const Manager = vm.runInNewContext(extractClassDeclaration(sources().manager)+'\nInstallManager;',
    {randomBytes, ...errors}, {timeout: 1000});
  const manager = Object.assign(Object.create(Manager.prototype), {
    mNativeInstallScopeId: 'manager-startup-1', mActiveInstalls: new Map(), mPendingInstalls: new Map(),
    mNativeInstallActivities: new Map(), mOptionalDownloadsInFlight: new Set(), mDependencyInstalls: {},
  });
  manager.registerNativeManager();
  const state = {persistent: {mods: mods ?? {own: {
    first: {id: 'first', state: 'installing', installationPath: 'first'},
    second: {id: 'second', state: 'installing', installationPath: 'second'},
    installed: {id: 'installed', state: 'installed', installationPath: 'installed'},
  }}}};
  const api = {store: {
    getState: () => {calls.push(['state']); if (stateFailure) throw stateFailure; return state;},
    dispatch: action => {calls.push(['remove-record', action.gameId, action.modId]); delete state.persistent.mods[action.gameId][action.modId];},
  }, showErrorNotification: (...args) => {calls.push(['report', ...args]); if (reportFailure) throw reportFailure;}};
  const environment = {InstallManager: Manager, ...errors, path: path.win32,
    getErrorCode: error => error?.code,
    unknownToError: error => error instanceof Error ? error : Error(String(error)),
    installPathForGame: () => 'F:/OwnStage', removeMod: (gameId, modId) => ({gameId, modId}),
    fs: {removeSync: file => {calls.push(['remove-file', file]); return remove?.(file);}},
    log: (_level, message) => {calls.push(['log', message]); const error = logFailure?.(message); if (error) throw error;},
  };
  const declarations = baseline ? declaration(sources().prior, 'cleanupIncompleteInstalls')
    : declaration(sources().index, 'cleanupIncompleteInstalls')+'\n'+declaration(sources().index, 'cleanupIncompleteInstallsTracked');
  const js = stripTypeScriptTypes(declarations, {mode: 'transform'});
  const cleanup = vm.runInNewContext(js+'\ncleanupIncompleteInstalls;', environment, {timeout: 1000});
  return {cleanup, manager, Manager, state, api, calls};
}

test('startup patch binds the final deployment source and remains preparation only', () => {
  const previous = JSON.parse(readFileSync(new URL('deployment-error-types.json', base)));
  assert.equal(manifest.upstreamPath, 'src/renderer/src/extensions/mod_management/index.ts');
  assert.equal(manifest.inputSHA256, previous.outputSHA256);
  assert.equal(manifest.prerequisitePatchSHA256, previous.patchSHA256);
  assert.equal(hash(patch), manifest.patchSHA256); assert.equal(manifest.preparedOnly, true);
  for (const flag of ['installed', 'nativeAcceptanceVerified', 'nativeTerminalGuarantee', 'globalIdleGuarantee', 'installationPermit'])
    assert.equal(manifest[flag], false);
  assert(!patch.includes('\r'));
  for (const h of hunks(patch, manifest.upstreamPath)) for (const line of h.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1), /[\t ]$/);
});

integration('baseline swallowed deletion failure loses its record; patched cleanup stops and retains ownership', async () => {
  for (const baseline of [true, false]) {
    const primary = Object.assign(Error('own remove failure'), {code: 'EACCES'});
    const f = fixture({baseline, remove: () => {throw primary;}});
    assert.equal(f.cleanup(f.api), undefined);
    if (baseline) {
      assert(!Object.hasOwn(f.state.persistent.mods.own, 'first'));
      assert(!Object.hasOwn(f.state.persistent.mods.own, 'second'));
      assert.equal(f.calls.filter(row => row[0] === 'remove-file').length, 4);
      f.manager.reserveNativeInstallExclusion();
    } else {
      assert(Object.hasOwn(f.state.persistent.mods.own, 'first'));
      assert(Object.hasOwn(f.state.persistent.mods.own, 'second'));
      assert.equal(f.calls.filter(row => row[0] === 'remove-file').length, 1);
      assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
      await tick();
      assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
      assert.equal(f.calls.filter(row => row[0] === 'report')[0][2], primary);
    }
  }
});

integration('exclusive refusal precedes state and filesystem access rather than allowing baseline cleanup', async () => {
  for (const baseline of [true, false]) {
    const f = fixture({baseline}); f.manager.reserveNativeInstallExclusion();
    assert.equal(f.cleanup(f.api), undefined); await tick();
    if (baseline) assert(f.calls.some(row => row[0] === 'remove-file'));
    else {
      assert(!f.calls.some(row => ['state', 'remove-file', 'remove-record'].includes(row[0])));
      assert.equal(f.calls.filter(row => row[0] === 'report').length, 1);
      assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 0);
    }
  }
});

integration('success completes both synchronous deletions and state writes before returning; ownership refunds later', async () => {
  const f = fixture(); assert.equal(f.cleanup(f.api), undefined);
  assert.deepEqual(f.calls.filter(row => row[0] === 'remove-file').map(row => row[1]), [
    'F:\\OwnStage\\first', 'F:\\OwnStage\\first.installing', 'F:\\OwnStage\\second', 'F:\\OwnStage\\second.installing',
  ]);
  assert.deepEqual(Object.keys(f.state.persistent.mods.own), ['installed']);
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
  assert.throws(() => f.manager.reserveNativeInstallExclusion(), /busy/);
  await tick(); assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 0);
  f.manager.reserveNativeInstallExclusion();
});

integration('failure of the installing suffix preserves that record and starts no later rows or games', async () => {
  const primary = Object.assign(Error('own suffix failure'), {code: 'EBUSY'});
  const f = fixture({remove: file => {if (file.endsWith('.installing')) throw primary;}, mods: {
    own: {first: {state: 'installing', installationPath: 'first'}, later: {state: 'installing', installationPath: 'later'}},
    another: {last: {state: 'installing', installationPath: 'last'}},
  }});
  f.cleanup(f.api);
  assert.equal(f.calls.filter(row => row[0] === 'remove-file').length, 2);
  assert.equal(f.calls.filter(row => row[0] === 'remove-record').length, 0);
  assert.equal(Object.keys(f.state.persistent.mods.own).length, 2); await tick();
  assert.equal(f.calls.filter(row => row[0] === 'report')[0][2], primary);
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
});

integration('ENOENT stays benign, no-path records are removed and ordinary/no-record cases remain unchanged', async () => {
  const f = fixture({remove: () => {throw Object.assign(Error('own missing'), {code: 'ENOENT'});}, mods: {
    own: {missing: {state: 'installing', installationPath: 'missing'}, noPath: {state: 'installing'},
      installed: {state: 'installed', installationPath: 'installed'}},
  }});
  f.cleanup(f.api); assert.deepEqual(Object.keys(f.state.persistent.mods.own), ['installed']);
  assert.equal(f.calls.filter(row => row[0] === 'remove-file').length, 2);
  await tick(); assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 0);
  assert(!f.calls.some(row => row[0] === 'report'));
  const empty = fixture({mods: {}}); empty.cleanup(empty.api); await tick();
  assert(!empty.calls.some(row => ['remove-file', 'remove-record', 'report'].includes(row[0])));
  assert.equal(empty.manager.getNativeInstallExclusion().legacyCalls, 0);
});

integration('notification and reporting logger failures cannot detach rejected tails or release failed cleanup', async () => {
  const primary = Object.assign(Error('own primary'), {code: 'EACCES'});
  const f = fixture({remove: () => {throw primary;}, reportFailure: Error('own notification failure'),
    logFailure: message => message.includes('could not be reported') ? Error('own reporting logger failure') : undefined});
  assert.doesNotThrow(() => f.cleanup(f.api)); await tick(); await tick();
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls, 1);
  assert(Object.hasOwn(f.state.persistent.mods.own, 'first'));
  assert.equal(f.calls.filter(row => row[0] === 'report')[0][2], primary);
  const startup = fixture({stateFailure: Error('own state failure')});
  assert.doesNotThrow(() => startup.cleanup(startup.api)); await tick();
  assert.equal(startup.manager.getNativeInstallExclusion().legacyCalls, 1);
  assert(!startup.calls.some(row => row[0] === 'remove-file'));
});
