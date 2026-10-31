import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {applyExact, hunks, extractClassDeclaration} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manager-exclusion.json', base)));
const patch = readFileSync(new URL('manager-exclusion.patch', base), 'utf8');
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
let cached;
function sources() {
  if(cached) return cached;
  let input=readFileSync(sourcePath,'utf8');assert.equal(hash(input),manifest.originalSourceSHA256);
  for(const name of ['ordinary-tracking','callback-order','native-activity','strict-selection','copy-error','transfer-join']) {
    const m=JSON.parse(readFileSync(new URL(name+'.json',base)));
    const p=readFileSync(new URL(name+'.patch',base),'utf8');
    assert.equal(hash(input),m.inputSHA256);assert.equal(hash(p),m.patchSHA256);
    input=applyExact(input,p,manifest.upstreamPath);assert.equal(hash(input),m.outputSHA256);
  }
  assert.equal(hash(input),manifest.inputSHA256);
  const patched=applyExact(input,patch,manifest.upstreamPath);assert.equal(hash(patched),manifest.outputSHA256);
  return cached={input,patched};
}
// Preserve actual callback/core-cleanup tails; replace only the preceding archive
// pipeline with owned promises. No constructor/native installation/filesystem runs.
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
  const globals = {randomBytes,
    installPathForGame: () => "own-stage", calculateFolderSize: () => metadata?.promise ?? Promise.resolve(10),
    setModAttribute: () => ({}),
    ConcurrencyLimiter: class {}, InstallPhaseTracker: class {}, NotificationAggregator: class {}, MAX_SIMULTANEOUS_INSTALLS: 2, path, shortid: () => repeatedNonce ? 'repeated' : `own-${++shortIds}`, Zip: class {constructor() {
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
      mDependencyInstalls: {}, mOptionalDownloadsInFlight: new Set(), mRecentChangedPaths: new Set(), setModSize: () => {events.push('modSize'); return metadata?.promise ?? Promise.resolve();},
      isBrowserAssistantError: () => false,
      mInstallLimit: {clearQueue: () => events.push('queue-cleared'), do: action => {
        operations.push(action);
        const result = admissionFailure ? Promise.reject(admissionFailure) :
          queued ? new Promise(() => {}) : Promise.resolve().then(action);
        result.catch(() => {}); tasks.push(result); return result;
      }}});
    manager.registerNativeManager?.();
    return manager;
  }
  const manager = createManager();
  function install(archiveId = null, sourceModId) {
    manager.install(archiveId, 'ownMod.zip', ['ownGame'], api, {}, false, false, (err, id) => {
      calls.push([err, id]); events.push(err ? 'callback-error' : 'callback-success');
      if (callbackFailure) throw callbackFailure;
    }, 'ownGame', undefined, false, undefined, false, sourceModId);
  }
  return {Manager, manager, createManager, install, events, tasks, operations, calls, removals, state, context, api, ProcessCanceled};
}

test('exclusion patch is exact-source preparation with no dispatch or release permit', () => {
  const previous=JSON.parse(readFileSync(new URL('transfer-join.json',base)));
  assert.equal(manifest.inputSHA256,previous.outputSHA256);
  assert.equal(manifest.prerequisitePatchSHA256,previous.patchSHA256);
  assert.equal(hash(patch),manifest.patchSHA256);
  assert.equal(manifest.preparedOnly,true);
  for(const key of ['installed','nativeAcceptanceVerified','nativeTerminalGuarantee','globalIdleGuarantee','noReplacementGuarantee','ownerReservationGuarantee','installationPermit']) assert.equal(manifest[key],false);
  assert(!patch.includes('\r'));
  for(const h of hunks(patch,manifest.upstreamPath)) for(const line of h.body)
    if(line.startsWith('+')) assert.doesNotMatch(line.slice(1),/[\t ]$/);
});

integration('all intended method bodies receive exactly one wrapper and extraction helpers remain unchanged', () => {
  const f=fixture(sources().patched);
  for(const name of ['setModSize','simulate','installDependencies','installRecommendations','installDependenciesImpl','installRecommendationsImpl',
    'handleDownloadFinished','handleDownloadFailed','handleDownloadSkipped','queueInstallation','startQueuedInstallation',
    'pollAllPhasesComplete','pollPhaseSettlement','scheduleDeployOnPhaseSettled','driveSelectedOptionals','markPhaseDownloadsFinished',
    'startPendingForPhase','admitSettledOptionalPhase','failOutstandingMembers','maybeAdvancePhase','repairRules','cleanupPendingInstalls',
    'reQueueDownloadedMods','markPhaseDeployed','writeCollectionSession']) {
    assert.equal((f.Manager.prototype[name].toString().match(/this\.trackNativeLegacyCall\(/g)??[]).length,1,name);
  }
  for(const name of ['extractWithRetry','extractArchive','installInner'])
    assert.equal((f.Manager.prototype[name].toString().match(/this\.trackNativeLegacyCall\(/g)??[]).length,0,name);
});

integration('one opaque exclusion owner blocks real manager entries before queues, bookkeeping or extraction', () => {
  const f=fixture(sources().patched),second=f.createManager();
  const token=f.manager.reserveNativeInstallExclusion();
  f.manager.checkNativeInstallExclusion(token);
  assert.throws(()=>second.checkNativeInstallExclusion(token),/owner mismatch/);
  assert.throws(()=>f.manager.checkNativeInstallExclusion({}),/owner mismatch/);
  assert.throws(()=>second.reserveNativeInstallExclusion(),/busy/);
  for(const manager of [f.manager,second]) {
    for(const name of ['simulate','installDependencies','installRecommendations','installDependenciesImpl','installRecommendationsImpl',
      'handleDownloadFinished','handleDownloadFailed','handleDownloadSkipped','queueInstallation','startQueuedInstallation',
      'pollAllPhasesComplete','pollPhaseSettlement','scheduleDeployOnPhaseSettled','repairRules','cleanupPendingInstalls'])
      assert.throws(()=>manager[name](),/exclusion held/,name);
  }
  assert.throws(()=>f.install(),/exclusion held/);
  assert.equal(f.operations.length,0);assert.deepEqual(f.events,[]);assert.equal(f.manager.mActiveInstalls.size,0);
  assert.equal(f.manager.getNativeInstallExclusion().effectsAllowed,false);
  assert.equal(f.manager.getNativeInstallExclusion().globalIdleVerified,false);
  assert.match(f.manager.getNativeInstallExclusion().rendererGeneration,/^renderer_[a-f0-9]{32}$/);
});

integration('queued core ownership survives callback, debug cleanup and limiter queue clearing', () => {
  const f=fixture(sources().patched,{queued:true});f.install();
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
  f.manager.__callbacks[0](new f.ProcessCanceled('own callback'),null);
  f.manager.mActiveInstalls.clear();f.manager.mInstallLimit.clearQueue();
  assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
});

integration('actual core settlement, not its early callback, releases installation ownership', async () => {
  const start=deferred(),f=fixture(sources().patched,{start});f.install();await tick();
  f.manager.__callbacks[0](null,'ownMod');
  assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
  start.resolve({own:'metadata'});await f.tasks[0];await tick();await tick();
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
  f.manager.reserveNativeInstallExclusion();
});

integration('mandatory cleanup and unknown cleanup startup preserve exclusion until a joined terminal', async () => {
  const cleanup=deferred(),f=fixture(sources().patched,{fail:Error('own failure'),cleanup});
  f.install();await tick();assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
  cleanup.resolve();await assert.rejects(f.tasks[0],/own failure/);await tick();await tick();
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
  const bad=fixture(sources().patched,{fail:Error('own failure'),cleanupStartupFailure:Error('unknown cleanup')});
  bad.install();await assert.rejects(bad.tasks[0],/unknown cleanup/);await tick();
  assert.throws(()=>bad.manager.reserveNativeInstallExclusion(),/busy/);
});

integration('retained pending, dependency and optional state in any registered manager prevents admission', () => {
  for(const field of ['mPendingInstalls','mActiveInstalls','mOptionalDownloadsInFlight','mDependencyInstalls']) {
    const f=fixture(sources().patched),second=f.createManager();
    if(field==='mDependencyInstalls') second[field].own=()=>{};
    else if(field==='mOptionalDownloadsInFlight') second[field].add('own');
    else second[field].set('own',{});
    assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/,field);
  }
});

integration('returned promise tails stay owned without reusing the ordinary install limiter', async () => {
  const f=fixture(sources().patched),pending=deferred();
  const result=f.manager.trackNativeLegacyCall(()=>pending.promise);
  assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
  pending.resolve('own');assert.equal(await result,'own');
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
  assert.equal(f.operations.length,0);
  const sync=fixture(sources().patched);
  assert.throws(()=>sync.manager.trackNativeLegacyCall(()=>{throw Error('uncertain setup');}),/uncertain setup/);
  assert.throws(()=>sync.manager.reserveNativeInstallExclusion(),/busy/);
});

integration('dependency limiter tail remains held after its legacy maps are cleared', async () => {
  const f=fixture(sources().patched),tail=deferred();
  f.manager.mPhaseTracker={get:()=>({activeByPhase:new Map()})};
  f.manager.mDependencyPipelineLimit={do:()=>tail.promise};
  f.manager.startQueuedInstallation(f.api,{reference:{}},'download','ownGame','parent',false,0);
  f.manager.mPendingInstalls.clear();f.manager.mActiveInstalls.clear();
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,1);
  assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
  tail.resolve();await tick();await tick();
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
});


integration('delegating wrappers preserve every declared argument and return value', async () => {
  const f=fixture(sources().patched);
  const arities={handleDownloadFinished:3,handleDownloadFailed:2,handleDownloadSkipped:3,simulate:8,
    installDependencies:6,installRecommendations:4,setModSize:3,cleanupPendingInstalls:2,queueInstallation:7,
    startQueuedInstallation:7,pollAllPhasesComplete:2,pollPhaseSettlement:3,reQueueDownloadedMods:4,
    markPhaseDeployed:2,scheduleDeployOnPhaseSettled:4,driveSelectedOptionals:2,markPhaseDownloadsFinished:3,
    startPendingForPhase:2,admitSettledOptionalPhase:2,failOutstandingMembers:2,maybeAdvancePhase:2,repairRules:3,
    installDependenciesImpl:8,installRecommendationsImpl:8,writeCollectionSession:4};
  for(const [name,count] of Object.entries(arities)) {
    const args=Array.from({length:count},(_,i)=>({argument:i}));
    const result={own:name};let observed;
    f.manager[name+'LegacyBody']=(...values)=>{observed=values;return name==='startQueuedInstallation' ? Promise.resolve(result) : result;};
    const returned=f.Manager.prototype[name].call(f.manager,...args);
    assert.deepEqual(observed,args,name);
    assert.equal(returned,name==='startQueuedInstallation' ? undefined : result,name);
  }
  await tick();assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
});

integration('actual metadata size tail prevents exclusive admission until its final dispatch', async () => {
  const metadata=deferred(),f=fixture(sources().patched,{metadata});
  const tail=f.Manager.prototype.setModSize.call(f.manager,f.api,'ownMod','ownGame');
  assert.throws(()=>f.manager.reserveNativeInstallExclusion(),/busy/);
  assert(!f.events.includes('dispatch'));
  metadata.resolve(42);await tail;
  assert(f.events.includes('dispatch'));
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
});

integration('actual constructor dependency listener refuses before its first profile or rule access', () => {
  const f=fixture(sources().patched),listeners=new Map(),events=new Map();
  f.api.onAsync=(name,fn)=>listeners.set(name,fn);f.api.events.on=(name,fn)=>events.set(name,fn);
  const nativeManager=new f.Manager(f.api,()=> 'own-stage');
  assert(listeners.has('install-from-dependencies'));
  nativeManager.reserveNativeInstallExclusion();
  assert.throws(()=>listeners.get('install-from-dependencies')('parent',[],false,'profile'),/exclusion held/);
  assert.throws(()=>new f.Manager(f.api,()=> 'own-stage'),/exclusion held/);
  nativeManager.handleDownloadFinished=()=>{throw Error('download handler must not run');};
  nativeManager.handleDownloadFailed=()=>{throw Error('failure handler must not run');};
  assert.doesNotThrow(()=>events.get('did-finish-download')('unrelated','finished'));
  assert.doesNotThrow(()=>events.get('did-finish-download')('unrelated','failed'));
  assert.equal(f.operations.length,0);assert.deepEqual(f.events,[]);
});

integration('legacy ownership has a finite capacity and cannot release foreign or duplicate tokens', () => {
  const f=fixture(sources().patched),tokens=[];
  for(let i=0;i<4096;i++) tokens.push(f.manager.beginNativeLegacyCall());
  assert.throws(()=>f.manager.beginNativeLegacyCall(),/exclusion held/);
  assert.throws(()=>f.manager.endNativeLegacyCall({}),/owner mismatch/);
  for(const token of tokens) f.manager.endNativeLegacyCall(token);
  assert.throws(()=>f.manager.endNativeLegacyCall(tokens[0]),/owner mismatch/);
  assert.equal(f.manager.getNativeInstallExclusion().legacyCalls,0);
});
