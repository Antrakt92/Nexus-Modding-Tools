import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {applyExact, hunks, extractClassDeclaration} from './native-patch-test-fixture.mjs';

const base = new URL('./native-patches/vortex-2.9.1/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('strict-selection.json', base)));
const patch = readFileSync(new URL('strict-selection.patch', base), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourcePath = process.env.VORTEX_NATIVE_INSTALL_MANAGER;
const integration = (name, fn) => test(name, {timeout: 10000, skip: sourcePath ? false :
  'Set VORTEX_NATIVE_INSTALL_MANAGER to the exact original InstallManager.ts'}, fn);
const tick = () => new Promise(resolve => setImmediate(resolve));
function sources() {
  const raw = readFileSync(sourcePath);
  assert.equal(hash(raw), manifest.originalSourceSHA256);
  let input = new TextDecoder('utf-8', {fatal: true}).decode(raw);
  for (const name of ['ordinary-tracking', 'callback-order', 'native-activity']) {
    const m = JSON.parse(readFileSync(new URL(`${name}.json`, base)));
    const p = readFileSync(new URL(`${name}.patch`, base), 'utf8');
    assert.equal(hash(input), m.inputSHA256); assert.equal(hash(p), m.patchSHA256);
    input = applyExact(input, p, manifest.upstreamPath); assert.equal(hash(input), m.outputSHA256);
  }
  assert.equal(hash(input), manifest.inputSHA256);
  const patched = applyExact(input, patch, manifest.upstreamPath);
  assert.equal(hash(patched), manifest.outputSHA256);
  return {input, patched};
}

test('selection patch is exact-source, private and never advertises native ownership or permission', () => {
  const previous = JSON.parse(readFileSync(new URL('native-activity.json', base)));
  assert.equal(manifest.schema, 'native-source-patch/1');
  assert.equal(manifest.upstreamCommit, 'c80326367cbe6d96621ad6cf4a5488ef49bac110');
  assert.equal(manifest.inputSHA256, previous.outputSHA256);
  assert.equal(manifest.prerequisitePatchSHA256, previous.patchSHA256);
  assert.equal(manifest.patchSHA256, hash(patch)); assert.equal(manifest.preparedOnly, true);
  for (const key of ['installed', 'nativeAcceptanceVerified', 'nativeTerminalGuarantee', 'globalIdleGuarantee',
    'noReplacementGuarantee', 'importNoClobberGuarantee', 'ownerReservationGuarantee', 'installationPermit']) assert.equal(manifest[key], false);
  for (const h of hunks(patch, manifest.upstreamPath)) for (const line of h.body)
    if (line.startsWith('+')) assert.doesNotMatch(line.slice(1), /[\t ]$/);
  assert(!patch.includes('\r'));
});

// The actual tracked-install selection chain executes, including will-install,
// metadata lookup, deriveInstallName, name loop, quick extractor, dependent and
// version branches and startInstallCB. No constructor or application dependency
// is initialized. Owned API stubs observe calls; installInner returns a pending
// promise at the extraction boundary, so no instructions/staging/native effects run.
function fixture(source, options = {}) {
  const events = [], tasks = [], callbacks = [], removals = [];
  const profile = {id: 'fixture', gameId: 'cyberpunk2077', modState: {}};
  const state = {activeProfileId: 'fixture', activeGameId: 'cyberpunk2077', persistent: {
    profiles: {fixture: profile}, mods: {cyberpunk2077: {}}, downloads: {files: {tracked: {
      state: 'finished', game: ['cyberpunk2077'], localPath: 'Own.zip', fileMD5: 'a'.repeat(32), size: 200,
    }}}}};
  class ProcessCanceled extends Error {}
  class UserCanceled extends Error {}
  class SetupError extends Error {}
  class TemporaryError extends Error {}
  class ArchiveBrokenError extends Error {}
  class DataInvalid extends Error {}
  class InsufficientDiskSpace extends Error {}
  const context = {startIndicator: () => events.push('indicator'), stopIndicator: () => events.push('stop'),
    startInstallCB: (...args) => {events.push('start'); options.onStart?.(state, args);},
    setInstallPathCB: () => events.push('set-path'), finishInstallCB: () => {},
    reportError: () => events.push('report'), beginBatch: () => {}, flushBatch: () => []};
  const api = {getState: () => state, store: {getState: () => state, dispatch: () => events.push('dispatch')},
    dismissNotification: () => {}, translate: value => value, sendNotification: () => {},
    emitAndAwait: async (name, _game, _archive, _mod, info) => {
      events.push(name); await options.hook?.(state, info);
    },
    genMd5Hash: async () => {events.push('hash'); return options.computedHash ?? {md5sum: 'a'.repeat(32), numBytes: 200};},
    lookupModMeta: async () => {events.push('lookup'); await options.lookup?.(state); return Object.hasOwn(options, 'metadata') ? options.metadata : [];},
    events: {emit: (name, ...args) => {events.push(name); if (name === 'remove-mod') args[2](null); return true;}}};
  const globals = {path: path.win32, shortid: () => 'fixture_nonce', ProcessCanceled, UserCanceled, SetupError,
    TemporaryError, ArchiveBrokenError, DataInvalid, InsufficientDiskSpace,
    Zip: class {}, InstallContext: class {constructor() {return context;}},
    getBatchContext: () => options.batch,
    getCollectionActiveSession: () => undefined,
    activeProfile: s => s.persistent.profiles[s.activeProfileId], activeGameId: s => s.activeGameId,
    profileById: (s, id) => s.persistent.profiles[id],
    knownGames: () => options.games ?? [{id: 'cyberpunk2077'}], convertGameIdReverse: (_games, id) => options.converted ?? id,
    discoveryByGame: () => ({path: 'F:/Game'}), isExtensionDownload: () => false,
    downloadToModRef: () => {events.push('download-ref'); return {};},
    withTrackedActivity: (_a, _b, _c, action) => action(() => {}, () => {}),
    filterModInfo: async () => {events.push('quick'); await options.quickMutation?.(state);
      return Object.hasOwn(options, 'quick') ? options.quick : {fileName: 'Own.zip', logicalFileName: 'Own'};},
    metaLookupMatch: rows => rows[0],
    classifyInstallKind: () => {options.classify?.(state); events.push('classify'); return 'new';},
    testModReference: candidate => options.dependent === true && candidate?.id === 'Old',
    lookupFromDownload: () => ({}), idOnlyRef: () => options.dependent !== true,
    INSTALL_ACTION: 'Update current profile', REPLACE_ACTION: 'Update all profiles',
    setModsEnabled: () => events.push('disable'),
    getSafe: (value, keys, fallback) => {const found = keys.reduce((v, k) => v?.[k], value); return found === undefined ? fallback : found;},
    setdefault: (value, key, fallback) => value[key] ?? (value[key] = fallback), truthy: Boolean,
    unknownToError: value => value, getErrorCode: () => undefined, getErrorMessageOrDefault: value => value?.message,
    prettifyNodeErrorMessage: value => ({message: value.message, replace: {}}),
    log: () => {}, _: {merge: Object.assign, omit: value => value},
    batchDispatch: () => {}, setFileOverride: () => ({}), addModRule: () => ({}), dismissNotification: () => ({}),
    fs: {removeAsync: async name => {removals.push(name);}},
  };
  const sandbox = vm.createContext(globals);
  const Manager = vm.runInContext(extractClassDeclaration(source) + '\nInstallManager;', sandbox, {timeout: 1000});
  const manager = Object.create(Manager.prototype);
  Object.assign(manager, {mApi: api, mActiveInstalls: new Map(), mPendingInstalls: new Map(),
    mNativeInstallScopeId: 'manager-fixture-1', mNativeInstallSequence: 0, mNativeInstallActivities: new Map(), mNativeInstallTerminals: new Map(),
    mRecentChangedPaths: new Set(), isBrowserAssistantError: () => false,
    mInstallLimit: {do: action => {events.push('queue'); const p = Promise.resolve().then(() => {
      options.queued?.(state); return action();}); p.catch(() => {}); tasks.push(p); return p;}},
    deriveInstallName: name => {events.push('derive'); return options.derived ?? name;},
    queryUserReplace: async () => {events.push('replace-dialog'); return {id: 'Own', replaceChoice: 'replace'};},
    findPreviousVersionMod: () => {events.push('previous'); return options.previous;},
    queryIgnoreDependent: async () => events.push('ignore-dialog'),
    userVersionChoice: async () => {events.push('version-dialog'); return options.versionAction === 'install' ? 'Update current profile' : 'Update all profiles';},
    mGetInstallPath: () => 'F:/Stage',
    installInner: () => {events.push('inner'); return new Promise(() => {});},
  });
  const descriptor = {archiveId: 'tracked', md5: 'a'.repeat(32), size: 200, gameId: 'cyberpunk2077', profileId: 'fixture', modId: 'Own'};
  sandbox.__descriptor = JSON.stringify(options.descriptor ?? descriptor);
  const strict = options.descriptor === null ? null : vm.runInContext('JSON.parse(__descriptor)', sandbox);
  const info = options.info ?? {};
  let activity;
  function install(strictMode = true) {
    activity = manager.beginNativeInstallActivity();
    const args = [activity, 'tracked', 'F:/Downloads/Own.zip', ['cyberpunk2077'], api, info, false, false,
      (...call) => callbacks.push(call), 'cyberpunk2077', undefined, true, undefined, false, undefined, undefined, strictMode ? strict : undefined];
    for (const [index, value] of Object.entries(options.parameters ?? {})) args[Number(index)] = value;
    manager.installTracked(...args);
  }
  return {state, events, tasks, callbacks, removals, manager, install, descriptor: strict, sandbox, get activity() {return activity;}};
}
async function selected(source, options = {}, strict = true) {
  const f = fixture(source, options); options.before?.(f); f.install(strict); await tick(); await tick(); return f;
}
function refused(f) {
  assert(!f.events.includes('start')); assert(!f.events.includes('set-path')); assert(!f.events.includes('inner'));
  assert(!f.events.includes('replace-dialog')); assert(!f.events.includes('version-dialog'));
  assert(!f.events.includes('ignore-dialog')); assert(!f.events.includes('disable')); assert(!f.events.includes('remove-mod'));
  assert.deepEqual(f.removals, []);
  if (f.events.includes('queue')) {
    assert.equal(f.callbacks.length, 1, 'one exact failure callback, not a stalled or stub-failed chain');
    assert.match(f.callbacks[0][0]?.message ?? '', /^Strict new installation:/);
  }
}

integration('baseline selection can consult replacement while strict source refuses before queue', async () => {
  const {input, patched} = sources();
  const before = await selected(input, {before: f => {f.state.persistent.mods.cyberpunk2077.Own = {id: 'Own'};}});
  assert(before.events.includes('replace-dialog')); assert(before.events.includes('start'));
  const after = fixture(patched); after.state.persistent.mods.cyberpunk2077.Own = {id: 'Own'};
  assert.throws(() => after.install(), /Strict new installation/); refused(after); assert(!after.events.includes('queue'));
});

integration('actual strict chain reaches extraction boundary with one exact owner and no legacy selection', async () => {
  const f = await selected(sources().patched);
  assert.deepEqual(f.events.filter(x => ['derive', 'quick', 'start', 'set-path', 'inner'].includes(x)), ['derive', 'quick', 'start', 'set-path', 'inner']);
  assert(!f.events.includes('download-ref')); assert(!f.events.includes('previous')); assert(!f.events.includes('replace-dialog'));
  assert.equal(f.callbacks.length, 0); assert.deepEqual(f.removals, []);
});

integration('legacy branch and public install signature remain unchanged; info cannot activate strict mode', async () => {
  const {input, patched} = sources();
  const signature = source => source.slice(source.indexOf('  public install('), source.indexOf('  public install(') + 700).split('  ): void {')[0];
  assert.equal(signature(input), signature(patched));
  for (const source of [input, patched]) {
    const f = await selected(source, {info: {strictNew: {modId: 'Unrelated'}}, metadata: [{value: {name: 'native'}}]}, false);
    assert(f.events.includes('download-ref')); assert(f.events.includes('start')); assert(f.events.includes('quick'));
  }
});

integration('private descriptor and unsafe options fail before queue, with undefined alone preserving legacy', () => {
  const source = sources().patched;
  for (const descriptor of [null, {}, {archiveId: 'tracked', md5: 'a'.repeat(32), size: 200, gameId: 'site', profileId: 'fixture', modId: 'Own'},
    {archiveId: 'tracked', md5: 'a'.repeat(32), size: 200, gameId: 'cyberpunk2077', profileId: 'fixture', modId: 'CON'}]) {
    const f = fixture(source, {descriptor}); assert.throws(() => f.install(), /invalid context/); refused(f);
  }
  for (const parameters of [{6: true}, {7: true}, {9: 'site'}, {10: []}, {11: false}, {12: 'custom'}, {13: true}, {14: null}, {15: {}}]) {
    const f = fixture(source, {parameters}); assert.throws(() => f.install(), /selection refused/); refused(f); assert(!f.events.includes('queue'));
  }
});

integration('case, map-key, stage aliases, archive references and MD5 duplicates cannot select a provider', () => {
  const source = sources().patched;
  for (const [key, mod] of [['own', {}], ['Own.installing', {}], ['other', {id: 'Own'}],
    ['other', {installationPath: 'f:/Stage/OWN'}], ['other', {installationPath: 'Own.installing'}],
    ['other', {archiveId: 'tracked'}], ['other', {attributes: {fileMD5: 'a'.repeat(32)}}], ['other', null],
    ['Own.', {id: 'Own.'}], ['Own ', {id: 'Own '}], ['other', {id: 'other', installationPath: 'Own.'}],
    ['other', {id: 'other', installationPath: 'Own '}], ['other', {id: 'other', installationPath: 'bad./Own'}],
    ['other', {installationPath: 'Other'}]]) {
    const f = fixture(source); f.state.persistent.mods.cyberpunk2077[key] = mod;
    assert.throws(() => f.install(), /selection refused/); refused(f);
  }
});

integration('queued/context and awaited hook/lookup/quick mutations are freshly refused before registration', async () => {
  const source = sources().patched;
  for (const options of [
    {queued: s => {s.activeProfileId = 'missing';}},
    {hook: s => {s.persistent.downloads.files.tracked.installed = undefined;}},
    {hook: (_s, info) => {info.custom = {variant: 'other'};}},
    {hook: (_s, info) => {info.modReference = {idHint: 'other'};}},
    {lookup: s => {s.persistent.mods.cyberpunk2077.own = {};}},
    {quickMutation: s => {s.persistent.mods.cyberpunk2077.other = {installationPath: 'Own'};}},
    {classify: s => {s.persistent.profiles.fixture.pendingRemove = true;}},
  ]) {const f = await selected(source, options); refused(f);}
});

integration('metadata matches, derived-owner mismatch and wrong computed archive tuple refuse', async () => {
  const source = sources().patched;
  for (const options of [{metadata: [{value: {revoked: true}}]}, {metadata: {}}, {metadata: null}, {derived: 'other'},
    {computedHash: {md5sum: 'b'.repeat(32), numBytes: 200}}, {computedHash: {md5sum: 'a'.repeat(32), numBytes: 201}}]) {
    const f = await selected(source, options); refused(f);
  }
  const f = fixture(source, {info: {download: {fileMD5: 'b'.repeat(32), size: 200}}});
  assert.throws(() => f.install(), /selection refused/); assert(!f.events.includes('queue'));
});

integration('provider IDs including zero, null, own undefined and inherited values refuse before legacy dependence', async () => {
  const source = sources().patched;
  for (const key of ['modId', 'fileId', 'revisionId']) for (const value of [0, null, undefined]) {
    const f = await selected(source, {quick: {fileName: 'Own.zip', [key]: value}}); refused(f); assert(!f.events.includes('previous'));
  }
  const inherited = await selected(source, {quick: Object.create({fileId: 1})}); refused(inherited);
  for (const quick of [null, [], true]) refused(await selected(source, {quick}));
  for (const value of [0, null, undefined]) {
    const f = fixture(source); f.state.persistent.downloads.files.tracked.modInfo = {nexus: {ids: {modId: value}}};
    assert.throws(() => f.install(), /selection refused/); assert(!f.events.includes('will-install-mod'));
  }
});

integration('unknown/oversized inventory, batch, wrong game and previously installed archives refuse', async () => {
  const source = sources().patched;
  for (const mutate of [s => {s.persistent.mods.cyberpunk2077 = null;},
    s => {s.persistent.mods.cyberpunk2077 = Object.fromEntries(Array.from({length: 10001}, (_, i) => ['m' + i, {}]));},
    s => {s.persistent.profiles = Object.fromEntries(Array.from({length: 2001}, (_, i) => ['p' + i, {}]));},
    s => {s.persistent.downloads.files.tracked.game.push('other');},
    s => {s.persistent.downloads.files.tracked.installed = null;}]) {
    const f = fixture(source); mutate(f.state); assert.throws(() => f.install(), /selection refused/); refused(f);
  }
  const batch = fixture(source, {batch: {}}); assert.throws(() => batch.install(), /selection refused/);
  for (const options of [{games: []}, {converted: 'site'}]) {const f = await selected(source, options); refused(f); assert(!f.events.includes('will-install-mod'));}
});

integration('all same-game profiles reject enabled, disabled, unknown and aliased target tombstones', async () => {
  const source = sources().patched;
  for (const elsewhere of [false, true]) for (const enabled of [false, true, null, undefined]) {
    const f = fixture(source), id = elsewhere ? 'elsewhere' : 'fixture';
    if (elsewhere) f.state.persistent.profiles[id] = {id, gameId: 'cyberpunk2077', pendingRemove: true, modState: {}};
    f.state.persistent.profiles[id].modState.Own = {enabled};
    assert.throws(() => f.install(), /selection refused/); refused(f);
  }
  for (const target of ['own', 'Own.installing', 'Own.', 'Own ']) {
    const f = fixture(source); f.state.persistent.profiles.fixture.modState[target] = {};
    assert.throws(() => f.install(), /selection refused/); refused(f);
  }
  const differentGame = await selected(source, {before: f => {
    f.state.persistent.profiles.other = {id: 'other', gameId: 'skyrimse', modState: {Own: {enabled: true}}};
  }});
  assert(differentGame.events.includes('start'), 'same opaque ID in another game is not actual target usage');
});

integration('unknown profile records and aggregate profile-state budget refuse before queue', () => {
  const source = sources().patched;
  for (const entry of [null, {}, {id: 'mismatch', gameId: 'cyberpunk2077', modState: {}},
    {id: 'other', gameId: null, modState: {}}, {id: 'other', gameId: 'cyberpunk2077', modState: null}]) {
    const f = fixture(source); f.state.persistent.profiles.other = entry;
    assert.throws(() => f.install(), /selection refused/); assert(!f.events.includes('queue'));
  }
  const f = fixture(source); f.state.persistent.profiles.fixture.modState =
    Object.fromEntries(Array.from({length: 50001}, (_, n) => ['old' + n, {}]));
  assert.throws(() => f.install(), /selection refused/); assert(!f.events.includes('queue'));
});

integration('strict internal descriptor is copied before awaiting queued work', async () => {
  const f = fixture(sources().patched, {queued: s => {s.persistent.downloads.files.tracked.size = 201;}});
  f.install(); f.descriptor.size = 201;
  await tick(); await tick(); refused(f);
  assert.equal(f.activity.state, 'settled'); assert.equal(f.activity.coreRejected, true);
  assert.equal(f.activity.coreStarted, false); assert.equal(f.activity.coreTailSettled, false);
  assert.equal(f.manager.mNativeInstallActivities.size, 0);
  assert.equal(f.manager.getNativeInstallActivity(f.activity.nativeJobId).state, 'settled');
});

integration('legacy version selection, dependent dialog, disable and remove paths execute unchanged', async () => {
  const {input, patched} = sources();
  for (const versionAction of ['install', 'replace']) for (const source of [input, patched]) {
    const previous = {id: 'Old', attributes: {}, rules: []};
    const f = await selected(source, {previous, dependent: true, versionAction, quick: {fileId: 7, modId: 8},
      before: fixture => {
        fixture.state.persistent.mods.cyberpunk2077.Old = previous;
        fixture.state.persistent.mods.cyberpunk2077.Dependent = {id: 'Dependent', rules: [{type: 'requires', reference: {idHint: 'Old'}}]};
        fixture.state.persistent.profiles.fixture.modState.Old = {enabled: true};
      }}, false);
    for (const event of ['previous', 'ignore-dialog', 'version-dialog', 'start', 'inner']) assert(f.events.includes(event), event);
    assert(f.events.includes(versionAction === 'install' ? 'disable' : 'remove-mod'));
    assert.equal(f.callbacks.length, 0);
  }
});

integration('descriptor accessors are rejected without executing the getter', () => {
  const f = fixture(sources().patched); let invoked = 0;
  Object.defineProperty(f.descriptor, 'modId', {enumerable: true, get() {invoked++; throw Error('not data');}});
  assert.throws(() => f.install(), /invalid context/); assert.equal(invoked, 0); assert(!f.events.includes('queue'));
});

integration('existing MD5 metadata is canonical, present undefined is not absent, and uppercase cannot hide sharing', async () => {
  const source = sources().patched;
  for (const md5 of ['A'.repeat(32), null, undefined, 'short', 123]) {
    const f = fixture(source);
    f.state.persistent.mods.cyberpunk2077.other = {id: 'other', attributes: {fileMD5: md5}};
    assert.throws(() => f.install(), /selection refused/); refused(f); assert(!f.events.includes('queue'));
  }
  const valid = await selected(source, {before: f => {
    f.state.persistent.mods.cyberpunk2077.other = {id: 'other', attributes: {fileMD5: 'b'.repeat(32)}};
  }});
  assert(valid.events.includes('start'), 'different canonical MD5 does not create a duplicate');
});
