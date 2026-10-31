import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import contract from './install-job-contract.cjs';
import {applyExact, hunks, extractClassDeclaration} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('native-activity.json', base)));
const callbackManifest = JSON.parse(readFileSync(new URL('callback-order.json', base)));
const patch = readFileSync(new URL('native-activity.patch', base), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourcePath = process.env.VORTEX_NATIVE_INSTALL_MANAGER;
const integration = (name, fn) => test(name, {timeout: 10000,
  skip: sourcePath ? false : 'Set VORTEX_NATIVE_INSTALL_MANAGER to the exact original InstallManager.ts'}, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function sources() {
  const raw = readFileSync(sourcePath);
  assert.equal(hash(raw), manifest.originalSourceSHA256);
  let input = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  for (const name of ['ordinary-tracking', 'callback-order']) {
    const m = JSON.parse(readFileSync(new URL(`${name}.json`, base)));
    const p = readFileSync(new URL(`${name}.patch`, base), 'utf8');
    assert.equal(hash(input), m.inputSHA256); assert.equal(hash(p), m.patchSHA256);
    input = applyExact(input, p, manifest.upstreamPath);
    assert.equal(hash(input), m.outputSHA256);
  }
  assert.equal(hash(input), manifest.inputSHA256);
  const patched = applyExact(input, patch, manifest.upstreamPath);
  assert.equal(hash(patched), manifest.outputSHA256);
  return {input, patched};
}

test('activity patch is pinned after callback repair, diagnostic only and not native acceptance', () => {
  assert.equal(manifest.schema, 'native-source-patch/1');
  assert.equal(manifest.upstreamRepository, 'https://github.com/Nexus-Mods/Vortex');
  assert.equal(manifest.upstreamTag, 'v2.9.1');
  assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
  assert.equal(manifest.upstreamPath, 'src/renderer/src/extensions/mod_management/InstallManager.ts');
  assert.equal(manifest.originalSourceSHA256, '577d56a8728052069f850face9bb57437dbf2886bd41409fe6a66cfefc08ed33');
  assert.equal(manifest.inputSHA256, callbackManifest.outputSHA256);
  assert.equal(manifest.prerequisitePatch, 'callback-order.patch');
  assert.equal(manifest.prerequisitePatchSHA256, callbackManifest.patchSHA256);
  assert.equal(manifest.patchSHA256, hash(patch));
  assert.equal(manifest.preparedOnly, true);
  for (const key of ['installed', 'nativeAcceptanceVerified', 'nativeTerminalGuarantee', 'globalIdleGuarantee',
    'noReplacementGuarantee', 'importNoClobberGuarantee', 'ownerReservationGuarantee']) assert.equal(manifest[key], false);
  assert.equal(manifest.testSourceEnvironment, 'VORTEX_NATIVE_INSTALL_MANAGER');
  assert.match(manifest.outputSHA256, /^[a-f0-9]{64}$/);
  for (const hunk of hunks(patch, manifest.upstreamPath)) for (const line of hunk.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1), /[\t ]$/);
  assert(!patch.includes('\r'));
});

// The real registration, callback, success continuation, failure cleanup, final
// indicator cleanup and fallback execute. Only the preceding archive/extraction
// instruction chain is replaced by owned values/promises. No constructor, native
// dispatch, filesystem mutation or application dependency initialization runs.
function fixture(source, {queued = false, fail, start, cleanup, metadata, zipFailure,
  setupFailure, callbackFailure, missingCallback = false, coreStartupFailure,
  admissionFailure, repeatedNonce = false, formatterFailure, errorCodeFailure,
  cleanupStartupFailure, reportFailure} = {}) {
  const startOffset = source.indexOf('const installationPromise = withTrackedActivity(');
  const filter = source.indexOf('return filterModInfo(fullInfo, destinationPath);', startOffset);
  const success = source.indexOf('.then((modInfo) => {', filter);
  const end = source.indexOf('// Handle the installationPromise completion/failure', success);
  assert(startOffset >= 0 && filter > startOffset && success > filter && end > success);
  const suffix = /\),\n\s*\{\},\n\s*\);\n\n\s*$/;
  const tail = source.slice(success, end); assert(suffix.test(tail));
  const pipeline = `installGameId='ownGame';modId='ownMod';destinationPath='ownDestination';installContext=__context;
          const installationPromise = Promise.resolve().then(__start)
          ${tail.replace(suffix, ');\n\n          ')}`;
  let observed = coreStartupFailure ? source : source.slice(0, startOffset) + pipeline + source.slice(end);
  const anchor = observed.indexOf('    if (archiveId != null)', observed.indexOf('const trackedCallback ='));
  assert(anchor > 0);
  observed = observed.slice(0, anchor) + '    this.__callbacks.push(trackedCallback);\n' + observed.slice(anchor);
  const events = [], tasks = [], operations = [], calls = [], removals = [];
  const state = {persistent: {downloads: {files: {}}, mods: {ownGame: {ownMod: {
    id: 'ownMod', state: 'installed', installationPath: 'ownMod', attributes: {}}}}}};
  class SetupError extends Error {}
  class UserCanceled extends Error {}
  class ProcessCanceled extends Error {}
  class TemporaryError extends Error {}
  class ArchiveBrokenError extends Error {}
  class DataInvalid extends Error {}
  class InsufficientDiskSpace extends Error {}
  const api = {getState: () => {if (setupFailure) throw setupFailure; return state;},
    store: {getState: () => state, dispatch: () => events.push('dispatch')},
    dismissNotification: () => {}, translate: value => value, genMd5Hash: async () => ({}),
    sendNotification: () => events.push('archive-error-notification'),
    events: {emit: name => {assert.equal(name, 'did-install-mod'); events.push(name); return true;}}};
  const context = {beginBatch: () => {}, finishInstallCB: outcome => {
    events.push(`finish-${outcome}`); if (!missingCallback) context.mInstallOutcome = outcome;
  }, flushBatch: () => [], reportError: () => {events.push('reportError'); if (reportFailure) throw reportFailure;},
  stopIndicator: () => events.push('stopIndicator')};
  let shortIds = 0;
  const globals = {path, shortid: () => repeatedNonce ? 'repeated' : `own-${++shortIds}`, Zip: class {constructor() {
    events.push('Zip'); if (zipFailure) throw zipFailure;
  }}, SetupError, UserCanceled, ProcessCanceled, TemporaryError, ArchiveBrokenError, DataInvalid, InsufficientDiskSpace,
  getBatchContext: () => undefined, activeProfile: () => ({id: 'ownProfile', gameId: 'ownGame'}),
  profileById: () => ({id: 'ownProfile', gameId: 'ownGame'}), activeGameId: () => 'ownGame',
  downloadToModRef: () => ({}), truthy: Boolean, unknownToError: value => value instanceof Error ? value : Error(String(value)),
  withTrackedActivity: () => {throw coreStartupFailure;},
  getErrorCode: value => {if (errorCodeFailure) throw errorCodeFailure; return value?.code;},
  getErrorMessageOrDefault: value => value?.message ?? 'ERROR',
  prettifyNodeErrorMessage: value => {if (formatterFailure) throw formatterFailure;
    return {message: value.message, replace: {}};}, setError: () => {},
  getSafe: (value, keys, fallback) => keys.reduce((v, k) => v?.[k], value) ?? fallback, log: () => {},
  _: {omit: value => value}, batchDispatch: () => events.push('batchDispatch'),
  setFileOverride: () => ({}), addModRule: () => ({}), dismissNotification: () => ({}),
  fs: {removeAsync: name => {removals.push(name); events.push('remove-start');
    if (cleanupStartupFailure) throw cleanupStartupFailure;
    return Promise.resolve(cleanup?.promise).then(() => events.push('remove-end'));}}, __context: context,
  __start: () => {if (fail === 'archive') throw new ArchiveBrokenError('own archive failure');
    if (fail) throw fail; return start?.promise ?? {own: 'metadata'};}};
  const Manager = vm.runInNewContext(extractClassDeclaration(observed) + '\nInstallManager;', globals, {timeout: 1000});
  function createManager() {
    const manager = Object.create(Manager.prototype);
    Object.assign(manager, {mApi: api, mActiveInstalls: new Map(), mPendingInstalls: new Map(), __callbacks: [],
      mNativeInstallScopeId: Manager.allocateNativeInstallScope?.(),
      mNativeInstallSequence: 0, mNativeInstallActivities: new Map(), mNativeInstallTerminals: new Map(),
      mRecentChangedPaths: new Set(), setModSize: () => {events.push('modSize'); return metadata?.promise ?? Promise.resolve();},
      isBrowserAssistantError: () => false,
      mInstallLimit: {clearQueue: () => events.push('queue-cleared'), do: action => {
        operations.push(action);
        const result = admissionFailure ? Promise.reject(admissionFailure) :
          queued ? new Promise(() => {}) : Promise.resolve().then(action);
        result.catch(() => {}); tasks.push(result); return result;
      }}});
    return manager;
  }
  const manager = createManager();
  function install(archiveId = null, sourceModId) {
    manager.install(archiveId, 'ownMod.zip', ['ownGame'], api, {}, false, false, (err, id) => {
      calls.push([err, id]); events.push(err ? 'callback-error' : 'callback-success');
      if (callbackFailure) throw callbackFailure;
    }, 'ownGame', undefined, false, undefined, false, sourceModId);
  }
  return {manager, createManager, install, events, tasks, operations, calls, removals, state, context, api, ProcessCanceled};
}

integration('callback and debug timeout never declare a deferred core settled', async () => {
  const start = deferred(), f = fixture(sources().patched, {start});
  f.install(); await tick();
  const id = f.manager.getNativeInstallActivities().active[0].nativeJobId;
  assert.equal(f.manager.getNativeInstallActivity(id).state, 'running');
  f.manager.__callbacks[0](null, 'ownMod');
  assert.equal(f.manager.mActiveInstalls.size, 0);
  assert.equal(f.manager.getNativeInstallActivity(id).coreTailSettled, false);
  assert.equal(f.manager.getNativeInstallActivity(id).callbackOutcome, 'success');
  start.resolve({}); await f.tasks[0]; await tick();
  assert.equal(f.manager.getNativeInstallActivity(id).state, 'settled');
  assert.equal(f.calls.length, 1);

  const pending = deferred(), timed = fixture(sources().patched, {start: pending});
  timed.install(); await tick();
  const timedId = timed.manager.getNativeInstallActivities().active[0].nativeJobId;
  timed.manager.getActiveInstallations()[0].startTime = 0;
  assert.equal(timed.manager.forceCleanupStuckInstalls(timed.api, 0), 1);
  assert.equal(timed.manager.getActiveInstallationCount(), 0);
  assert.equal(timed.manager.getNativeInstallActivity(timedId).state, 'running');
  assert.equal(timed.manager.getNativeInstallActivity(timedId).coreTailSettled, false);
  pending.resolve({}); await tick(); await tick();
  assert.equal(timed.manager.getNativeInstallActivity(timedId).state, 'settled');
  assert.equal(timed.calls.length, 1, 'late core callback cannot redeliver timeout notice');
});

integration('MODULE_NOT_FOUND baseline outruns destructive cleanup; patched core waits for it', async () => {
  const {input, patched} = sources();
  const error = Object.assign(Error('own module failure'), {code: 'MODULE_NOT_FOUND'});
  const oldCleanup = deferred(), old = fixture(input, {fail: error, cleanup: oldCleanup});
  old.install(); await tick();
  assert(old.events.includes('stopIndicator')); assert.equal(old.calls.length, 1);
  assert(!old.events.includes('remove-end'), 'baseline cleanup still pending');
  oldCleanup.resolve(); await tick();
  const cleanup = deferred(), f = fixture(patched, {fail: error, cleanup});
  f.install(); await tick();
  const id = f.manager.getNativeInstallActivities().active[0].nativeJobId;
  assert.equal(f.manager.getNativeInstallActivity(id).state, 'running');
  assert.equal(f.calls.length, 0); assert(!f.events.includes('stopIndicator'));
  cleanup.resolve(); await assert.rejects(f.tasks[0], value => value === error); await tick();
  assert(f.events.indexOf('remove-end') < f.events.indexOf('callback-error'));
  assert(f.events.indexOf('callback-error') < f.events.indexOf('stopIndicator'));
  assert.equal(f.manager.getNativeInstallActivity(id).state, 'settled');
  assert.equal(f.manager.getNativeInstallActivity(id).callbackOutcome, 'failed');
});

integration('missing-callback fallback completes before core settlement and remains no success evidence', async () => {
  const f = fixture(sources().patched, {fail: 'archive', missingCallback: true});
  const settlements = [];
  const settle = f.manager.settleNativeInstallActivity.bind(f.manager);
  f.manager.settleNativeInstallActivity = job => {settlements.push([...f.events]); settle(job);};
  f.install(); await f.tasks[0]; await tick();
  assert.equal(f.calls.length, 0);
  assert.equal(settlements.length, 1);
  assert(settlements[0].includes('finish-success'));
  assert(settlements[0].includes('dispatch'));
  assert(settlements[0].includes('stopIndicator'));
  const row = f.manager.getNativeInstallActivities().recent[0];
  assert.equal(row.state, 'settled'); assert.equal(row.callbackOutcome, 'not_observed');
});

integration('formatter or error-code failure cannot detach already-started mandatory cleanup', async () => {
  for (const key of ['formatterFailure', 'errorCodeFailure']) {
    const cleanup = deferred();
    const f = fixture(sources().patched, {fail: Error('own native failure'), cleanup,
      [key]: Error(`own ${key}`)});
    f.install(); await tick();
    const id = f.manager.getNativeInstallActivities().active[0]?.nativeJobId;
    assert.ok(id, `${key}: activity must stay held while removal is pending`);
    assert.equal(f.manager.getNativeInstallActivity(id).coreTailSettled, false);
    assert(f.events.includes('remove-start')); assert(!f.events.includes('remove-end'));
    cleanup.resolve(); await tick(); await tick();
    assert(f.events.includes('remove-end'));
    assert.equal(f.manager.getNativeInstallActivity(id).state, 'settled');
    assert.equal(f.manager.getNativeInstallActivity(id).coreTailSettled, true);
    assert.equal(f.manager.getNativeInstallActivity(id).coreRejected, true);
  }
});

integration('unknown mandatory cleanup startup remains held rather than claiming a joined tail', async () => {
  const error = Error('own cleanup startup failure');
  const f = fixture(sources().patched, {fail: Error('own native failure'), cleanupStartupFailure: error});
  f.install(); await assert.rejects(f.tasks[0], value => value === error); await tick();
  const row = f.manager.getNativeInstallActivities().active[0];
  assert.ok(row); assert.equal(row.state, 'running'); assert.equal(row.coreTailSettled, false);
  assert.equal(row.coreRejected, true); assert.equal(f.manager.getNativeInstallActivities().recent.length, 0);
});

integration('rejected cleanup/reporter is joined without an unhandled promise or clean-disk claim', async () => {
  const cleanup = deferred(), failure = Error('own cleanup reporter failure');
  const f = fixture(sources().patched, {fail: Error('own native failure'), cleanup, reportFailure: failure});
  f.install(); await tick();
  const id = f.manager.getNativeInstallActivities().active[0].nativeJobId;
  assert.equal(f.manager.getNativeInstallActivity(id).coreTailSettled, false);
  cleanup.reject(Error('own removal failure'));
  await assert.rejects(f.tasks[0], value => value === failure); await tick();
  const row = f.manager.getNativeInstallActivity(id);
  assert.equal(row.state, 'settled'); assert.equal(row.coreRejected, true);
  assert.equal(row.coreTailSettled, true);
  assert.equal(Object.hasOwn(row, 'diskCleanupVerified'), false);
});

integration('registry finalizer failure leaves observed running activity held', async () => {
  const f = fixture(sources().patched);
  f.manager.settleNativeInstallActivity = () => {throw Error('own registry finalizer failure');};
  f.install(); await f.tasks[0]; await tick();
  const row = f.manager.getNativeInstallActivities().active[0];
  assert.ok(row); assert.equal(row.state, 'running'); assert.equal(row.coreTailSettled, false);
  assert.equal(row.coreRejected, true); assert.equal(f.manager.getNativeInstallActivities().recent.length, 0);
});

integration('queued orphan stays held after legacy queue clear and has not started native work', () => {
  const f = fixture(sources().patched, {queued: true});
  f.install(); f.manager.mInstallLimit.clearQueue();
  const inventory = f.manager.getNativeInstallActivities();
  assert.equal(inventory.active.length, 1); assert.equal(inventory.recent.length, 0);
  assert.equal(inventory.active[0].state, 'queued');
  assert.equal(inventory.active[0].coreTailSettled, false);
  assert.equal(inventory.globalIdleVerified, false);
  assert.equal(f.events.includes('Zip'), false); assert.equal(f.calls.length, 0);
});

integration('early failure and synchronous pre-core throw are recorded without duplicate callbacks', async () => {
  const f = fixture(sources().patched, {callbackFailure: Error('own callback failure')});
  f.state.persistent.downloads.files.incomplete = {state: 'paused'};
  f.install('incomplete');
  assert.equal(f.operations.length, 0); assert.equal(f.calls.length, 1);
  assert.equal(f.manager.getNativeInstallActivities().recent[0].callbackOutcome, 'failed');
  const setupError = Error('own setup failure'), setup = fixture(sources().patched, {setupFailure: setupError,
    callbackFailure: Error('own notification failure')});
  assert.throws(() => setup.install(), value => value === setupError);
  assert.equal(setup.calls.length, 1); assert.equal(setup.operations.length, 0);
  assert.equal(setup.manager.getNativeInstallActivities().recent[0].coreRejected, true);
  const zipError = Error('own Zip failure'), zip = fixture(sources().patched, {zipFailure: zipError});
  zip.install(); await assert.rejects(zip.tasks[0], value => value === zipError); await tick();
  assert.equal(zip.calls.length, 1);
  assert.equal(zip.manager.getNativeInstallActivities().active.length, 0);
  assert.equal(zip.manager.getNativeInstallActivities().recent[0].coreRejected, true);
});

integration('optional staging metadata remains observable but does not block core settlement', async () => {
  const metadata = deferred(), f = fixture(sources().patched, {metadata});
  f.install(); await f.tasks[0]; await tick();
  let row = f.manager.getNativeInstallActivities().recent[0];
  const firstSnapshot = row;
  assert.equal(row.coreTailSettled, true); assert.equal(row.metadataPending, true);
  assert.equal(row.callbackOutcome, 'success');
  metadata.reject(Error('own size diagnostic failure')); await tick();
  row = f.manager.getNativeInstallActivity(row.nativeJobId);
  assert.equal(row.metadataPending, false); assert.equal(row.coreTailSettled, true);
  assert.equal(firstSnapshot.metadataPending, true, 'previous detached observation stays unchanged');
  const {input, patched} = sources();
  const method = source => source.slice(source.indexOf('  private setModSize('), source.indexOf('  private cleanupPendingInstalls('));
  assert.equal(method(input), method(patched), 'staging-only metadata method is unchanged');
});

integration('pre-start limiter rejection settles but ambiguous core startup failure remains held', async () => {
  const failure = Error('own limiter rejection'), before = fixture(sources().patched, {admissionFailure: failure});
  before.install(); await assert.rejects(before.tasks[0], value => value === failure); await tick();
  assert.equal(before.events.includes('Zip'), false);
  assert.equal(before.calls.length, 1);
  assert.equal(before.manager.getNativeInstallActivities().active.length, 0);
  assert.equal(before.manager.getNativeInstallActivities().recent[0].coreRejected, true);

  const startupError = Error('own tracing startup failure');
  const ambiguous = fixture(sources().patched, {coreStartupFailure: startupError});
  ambiguous.install(); await assert.rejects(ambiguous.tasks[0], value => value === startupError); await tick();
  const row = ambiguous.manager.getNativeInstallActivities().active[0];
  assert.equal(row.state, 'running'); assert.equal(row.coreTailSettled, false);
  assert.equal(row.callbackOutcome, 'failed'); assert.equal(row.coreRejected, true);
  assert.equal(ambiguous.manager.getNativeInstallActivities().recent.length, 0);
});

integration('dependency composite aliases have independent native invocation identities', () => {
  const f = fixture(sources().patched, {queued: true});
  f.install('download', 'collection'); f.install('download', 'collection');
  const rows = f.manager.getNativeInstallActivities().active;
  assert.equal(rows.length, 2); assert.notEqual(rows[0].nativeJobId, rows[1].nativeJobId);
  assert.equal(f.manager.mActiveInstalls.size, 1);
  assert.equal(f.manager.mActiveInstalls.has('collection:download'), true);
  assert.equal(f.calls.length, 0);
});

integration('diagnostics are detached, bounded, manager-scoped and missing IDs are not observed', () => {
  const f = fixture(sources().patched);
  f.state.persistent.downloads.files.incomplete = {state: 'paused'};
  for (let i = 0; i < 130; i++) f.install('incomplete');
  const inventory = f.manager.getNativeInstallActivities();
  const scope = inventory.managerScopeId;
  assert.equal(inventory.scope, 'manager-lifetime-install-core-only');
  assert.equal(inventory.globalIdleVerified, false);
  assert.equal(inventory.active.length, 0); assert.equal(inventory.recent.length, 128);
  assert.equal(f.manager.getNativeInstallActivity(`${scope}-native-1`).state, 'not_observed');
  assert.equal(f.manager.getNativeInstallActivity('foreign').state, 'not_observed');
  assert.equal(f.manager.getNativeInstallActivity(`${scope}-native-130`).state, 'settled');
  inventory.recent[0].state = 'forged'; inventory.recent.pop();
  assert.equal(f.manager.getNativeInstallActivities().recent.length, 128);
  assert.equal(f.manager.getNativeInstallActivity(`${scope}-native-3`).state, 'settled');
  assert.deepEqual(Object.keys(f.manager.getNativeInstallActivity(`${scope}-native-130`)).sort(),
    ['callbackOutcome', 'coreRejected', 'coreStarted', 'coreTailSettled', 'managerScopeId', 'metadataPending', 'nativeJobId', 'state']);
});

integration('sequence overflow or injected collision refuses without overwriting another activity', () => {
  const f = fixture(sources().patched, {queued: true});
  f.manager.mNativeInstallSequence = Number.MAX_SAFE_INTEGER;
  assert.throws(() => f.install(), /sequence exhausted/);
  assert.equal(f.manager.mActiveInstalls.size, 0); assert.equal(f.operations.length, 0);
  f.manager.mNativeInstallSequence = 0;
  const id = `${f.manager.mNativeInstallScopeId}-native-1`;
  const sentinel = {nativeJobId: id, state: 'queued'};
  f.manager.mNativeInstallActivities.set(id, sentinel);
  assert.throws(() => f.install(), /sequence collision/);
  assert.equal(f.manager.mNativeInstallActivities.get(id), sentinel);
  assert.equal(f.manager.mActiveInstalls.size, 0); assert.equal(f.operations.length, 0);
});

integration('two managers at the same invocation sequence have distinct scoped IDs', () => {
  const f = fixture(sources().patched, {queued: true, repeatedNonce: true});
  const second = f.createManager();
  f.install();
  second.install(null, 'ownMod.zip', ['ownGame'], f.api, {}, false, false, () => {}, 'ownGame');
  const firstRow = f.manager.getNativeInstallActivities().active[0];
  const secondRow = second.getNativeInstallActivities().active[0];
  assert.equal(f.manager.mNativeInstallSequence, 1); assert.equal(second.mNativeInstallSequence, 1);
  assert.notEqual(firstRow.managerScopeId, secondRow.managerScopeId);
  assert.notEqual(firstRow.nativeJobId, secondRow.nativeJobId);
  const unknown = second.getNativeInstallActivity(firstRow.nativeJobId);
  assert.equal(unknown.state, 'not_observed'); assert.equal(unknown.managerScopeId, secondRow.managerScopeId);
});

integration('actual generated opaque native ID is admitted by the pure install-job model', () => {
  const f = fixture(sources().patched, {queued: true}); f.install();
  const nativeJobId = f.manager.getNativeInstallActivities().active[0].nativeJobId;
  assert.match(nativeJobId, /^[A-Za-z0-9_-]{1,128}$/);
  const h = 'a'.repeat(64);
  const plan = {schema: 'install-job-plan/1', family: 'tracked-new-disabled', contractId: contract.CONTRACT_ID,
    context: {gameId: 'cyberpunk2077', profileId: 'fixture-profile', gamePath: 'F:/Fixture/Game',
      stagingPath: 'F:/Fixture/Stage', downloadPath: 'D:/Fixture/Downloads',
      filesystemIds: {gamePath: '1:2', stagingPath: '1:3', downloadPath: '2:4'}},
    package: {downloadId: 'tracked_1', fileName: 'Own Fixture.zip', expectedModId: 'Own Fixture', expectedType: '',
      bytes: 200, sha256: h, md5: 'b'.repeat(32), expectedUncompressedBytes: 10, payload: {'r6/scripts/own.reds': h}},
    evidence: {buildSHA256: h, sourceSHA256: h, nativeAdmissionSHA256: h}, options: {enabled: false, deploy: false}};
  let state = contract.initialInstallState(plan);
  state = contract.advanceInstallState(state, {sequence: 1, kind: 'admission_observed',
    snapshotSHA256: h, nativeAdmissionSHA256: h});
  state = contract.advanceInstallState(state, {sequence: 2, kind: 'install_intent', admissionSHA256: h, nativeJobId});
  assert.equal(state.events[1].nativeJobId, nativeJobId);
  const status = contract.inspectInstallState(state);
  assert.equal(status.phase, 'dispatch_unknown'); assert.equal(status.effectsAllowed, false);
  assert.equal(status.nativeAdmissionVerified, false);
});
