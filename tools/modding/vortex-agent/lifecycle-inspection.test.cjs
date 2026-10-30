'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {readModLifecycle, LIMITS} = require('./lifecycle-inspection.cjs');

const game = 'cyberpunk2077';
const mod = patch => ({state: 'installed', type: '', attributes: {}, ...patch});
const reference = () => ({repo: {repository: 'nexus', modId: '34413', fileId: '170152'}});
function fixture() {
  const target = 'Clean Inventory 3.4.0';
  const state = {persistent: {mods: {[game]: {
    [target]: mod({id: 'conflicting-stored-id', archiveId: 'tracked_340', attributes: {source: 'nexus', modId: 34413, fileId: 170152}}),
    collection: mod({id: 'conflicting-owner-id', type: 'collection', rules: [{type: 'requires', reference: reference()}]}),
  }}, profiles: {active: {gameId: game, modState: {[target]: {enabled: false}}},
    normal: {gameId: game, modState: {[target]: {enabled: true}}}}}};
  let stateReads = 0, matches = 0;
  const api = {getState() {stateReads++; return state;}};
  const selectors = {activeGameId: received => {assert.equal(received, state); return game;},
    activeProfileId: received => {assert.equal(received, state); return 'active';}};
  const util = {testModReference(...args) {
    matches++; assert.equal(args.length, 2, 'no source argument that could update native caches');
    const [candidate, ref] = args;
    if (ref.id !== undefined) return candidate.id === ref.id;
    return ref.repo?.repository === candidate.attributes?.source
      && ref.repo.modId === String(candidate.attributes?.modId) && ref.repo.fileId === String(candidate.attributes?.fileId);
  }};
  return {state, api, selectors, util, target, args: {gameId: game, modIds: [target]},
    read() {return readModLifecycle(api, selectors, util, this.args);},
    get stateReads() {return stateReads;}, get matches() {return matches;}};
}

test('one native snapshot finds repository exact-file requires without idHint and preserves read-only state', () => {
  const f = fixture(), before = structuredClone(f.state);
  f.state.persistent.mods[game].collection.rules[0].comment = 'private text must never be copied';
  before.persistent.mods[game].collection.rules[0].comment = 'private text must never be copied';
  const result = f.read();
  assert.equal(f.stateReads, 1); assert.equal(f.matches, 1);
  assert.deepEqual(result.mods[0].incomingRequires, [{ownerId: 'collection', ownerType: 'collection', ignored: false, exactFileId: 170152}]);
  assert.deepEqual(result.mods[0].archiveReferences, [{gameId: game, modId: f.target}]);
  assert.equal(result.mods[0].activeEnabled, false); assert.equal(result.profileCount, 2);
  assert.equal(result.metadataOnly, true); assert.equal(result.effectsAllowed, false);
  assert.equal(result.installationSupported, false); assert.equal(result.removalSupported, false);
  assert.equal(result.diskDeploymentVerified, false);
  assert(!JSON.stringify(result).includes('private text'));
  assert.deepEqual(f.state, before);
});

test('one twenty-target batch preserves individual details while reducing state snapshots from twenty to one', () => {
  const f = fixture();
  const modIds = Array.from({length: 20}, (_, n) => 'selected_' + n);
  for (const [n, modId] of modIds.entries()) f.state.persistent.mods[game][modId] = mod({
    archiveId: 'tracked_' + n, attributes: {source: 'nexus', modId: n + 1, fileId: n + 100}});
  const batch = readModLifecycle(f.api, f.selectors, f.util, {modIds});
  assert.equal(f.stateReads, 1);
  const individual = modIds.map(modId => readModLifecycle(f.api, f.selectors, f.util, {modIds: [modId]}).mods[0]);
  assert.equal(f.stateReads, 21);
  assert.deepEqual(batch.mods, individual);
});

test('map-key IDs override stored target IDs and ignored incoming requires remain visible', () => {
  const f = fixture();
  f.state.persistent.mods[game].collection.rules = [
    {type: 'requires', reference: {id: f.target}, ignored: true},
    {type: 'requires', reference: {id: f.target}, ignored: 'unknown'},
  ];
  assert.deepEqual(f.read().mods[0].incomingRequires.map(row => [row.ownerId, row.ignored, row.exactFileId]),
    [['collection', true, null], ['collection', null, null]]);
});

test('all same-game profiles including pending removal are checked; unknown flags stay unknown', () => {
  const f = fixture();
  Object.assign(f.state.persistent.profiles, {
    pending: {gameId: game, pendingRemove: true, modState: {[f.target]: {enabled: true}}},
    unknown: {gameId: game, modState: {[f.target]: {enabled: 'yes'}}},
    missing: {gameId: game},
    anotherGame: {gameId: 'skyrimse', modState: {[f.target]: {enabled: true}}},
  });
  delete f.state.persistent.profiles.active.modState[f.target];
  const result = f.read(), target = result.mods[0];
  assert.equal(result.profileCount, 6);
  assert.equal(result.unknownProfileFlagCount, 1);
  assert.deepEqual(target.profiles.map(p => [p.id, p.present, p.enabled, p.pendingRemove]), [
    ['active', false, false, false], ['normal', true, true, false],
    ['pending', true, true, true], ['unknown', true, null, false],
  ]);
  assert.equal(target.activeEnabled, false);
});

test('shared archive references are global but same-ID profiles in other games are not target usage', () => {
  const f = fixture();
  f.state.persistent.mods.skyrimse = {[f.target]: mod({archiveId: 'tracked_340'})};
  f.state.persistent.profiles.skyrim = {gameId: 'skyrimse', modState: {[f.target]: {enabled: true}}};
  const result = f.read();
  assert.deepEqual(result.mods[0].archiveReferences, [{gameId: game, modId: f.target}, {gameId: 'skyrimse', modId: f.target}]);
  assert.equal(result.mods[0].profiles.some(p => p.id === 'skyrim'), false);
  assert.equal(result.allGameModCount, 3);
});

test('missing/unsupported targets and malformed requests fail before matching', () => {
  const f = fixture();
  for (const args of [null, {}, {modIds: []}, {modIds: [f.target, f.target]}, {modIds: [1]},
    {modIds: Array.from({length: 21}, (_, n) => 'target_' + n)}, {...f.args, extra: true}]) {
    assert.throws(() => readModLifecycle(f.api, f.selectors, f.util, args), /INVALID_LIFECYCLE_REQUEST/);
  }
  assert.equal(f.stateReads, 0);
  assert.throws(() => readModLifecycle(f.api, f.selectors, f.util, {modIds: ['missing']}), /LIFECYCLE_TARGET_NOT_INSTALLED/);
  f.state.persistent.mods[game][f.target].state = 'downloaded';
  assert.throws(() => f.read(), /LIFECYCLE_TARGET_NOT_INSTALLED/);
  assert.equal(f.matches, 0);
});

test('wrong context, malformed native records and unavailable matcher never produce empty success', () => {
  const f = fixture();
  assert.throws(() => readModLifecycle(f.api, f.selectors, {}, f.args), /LIFECYCLE_MATCHER_UNAVAILABLE/);
  assert.throws(() => readModLifecycle(f.api, f.selectors, f.util, {...f.args, gameId: 'skyrimse'}), /LIFECYCLE_CONTEXT_UNAVAILABLE/);
  for (const mutate of [
    f => {f.state.persistent.profiles.active.gameId = 'skyrimse';},
    f => {f.state.persistent.profiles.normal.modState = [];},
    f => {f.state.persistent.mods[game].collection.rules = {};},
    f => {f.state.persistent.mods[game].collection.rules = [{type: 'requires', reference: null}];},
    f => {f.state.persistent.mods[game].collection.archiveId = 'not an opaque archive ID';},
    f => {f.state.persistent.mods[game][f.target].attributes = 'malformed';},
    f => {f.state.persistent.mods[game].collection = null;},
  ]) {const f = fixture(); mutate(f); assert.throws(() => f.read(), /LIFECYCLE_CONTEXT_UNAVAILABLE|LIFECYCLE_STATE_INVALID/);}
});

test('native matcher errors and nonboolean results fail with private details removed', () => {
  const f = fixture();
  assert.throws(() => readModLifecycle(f.api, f.selectors, {testModReference() {throw Error('private source detail');}}, f.args),
    error => error.message === 'LIFECYCLE_MATCHER_FAILED');
  assert.throws(() => readModLifecycle(f.api, f.selectors, {testModReference() {return undefined;}}, f.args), /LIFECYCLE_MATCHER_INVALID/);
});

test('bounded profile, active mod, global mod and rule scans fail instead of truncating', () => {
  for (const [kind, fill] of [
    ['profiles', f => {for (let n = 0; n < LIMITS.profiles; n++) f.state.persistent.profiles['p' + n] = {gameId: game};}],
    ['mods', f => {for (let n = 0; n < LIMITS.mods; n++) f.state.persistent.mods[game]['m' + n] = mod();}],
    ['all games', f => {f.state.persistent.mods.other = Object.fromEntries(Array.from({length: LIMITS.allGameMods}, (_, n) => ['m' + n, mod()]));}],
    ['rules', f => {f.state.persistent.mods[game].collection.rules = Array.from({length: LIMITS.rules + 1}, () => ({type: 'before'}));}],
  ]) {const f = fixture(); fill(f); assert.throws(() => f.read(), /LIFECYCLE_READ_LIMIT/, kind);}
});

test('matcher and incoming result budgets fail instead of claiming complete closure', () => {
  const checks = fixture();
  checks.args.modIds = Array.from({length: 20}, (_, n) => 'selected_' + n);
  for (const selected of checks.args.modIds) checks.state.persistent.mods[game][selected] = mod();
  checks.state.persistent.mods[game].collection.rules = Array.from({length: 10001}, () => ({type: 'requires', reference: {id: 'unmatched'}}));
  assert.throws(() => checks.read(), /LIFECYCLE_READ_LIMIT/);
  const incoming = fixture();
  incoming.state.persistent.mods[game].collection.rules = Array.from({length: LIMITS.incomingRequires + 1}, () => ({type: 'requires', reference: reference()}));
  assert.throws(() => incoming.read(), /LIFECYCLE_READ_LIMIT/);
});

test('shared archives and profile references are bounded after expanding each selected target', () => {
  const shared = fixture();
  shared.args.modIds = Array.from({length: 20}, (_, n) => 'selected_' + n);
  for (const selected of shared.args.modIds) shared.state.persistent.mods[game][selected] = mod({archiveId: 'shared_archive'});
  for (let n = 0; n < 251; n++) shared.state.persistent.mods[game]['keeper_' + n] = mod({archiveId: 'shared_archive'});
  assert.throws(() => shared.read(), /LIFECYCLE_READ_LIMIT/);
  const profiles = fixture(); profiles.args.modIds = shared.args.modIds;
  for (const selected of profiles.args.modIds) profiles.state.persistent.mods[game][selected] = mod();
  const modState = Object.fromEntries(profiles.args.modIds.map(id => [id, {enabled: false}]));
  for (let n = 0; n < 251; n++) profiles.state.persistent.profiles['profile_' + n] = {gameId: game, modState};
  assert.throws(() => profiles.read(), /LIFECYCLE_READ_LIMIT/);
});

test('UTF-8 result bytes remain bounded even when every row and input scan fits its own limit', () => {
  const f = fixture(); delete f.state.persistent.mods[game].collection;
  for (let n = 0; n < 2000; n++) f.state.persistent.mods[game]['界'.repeat(190) + n] = mod({
    type: '界'.repeat(190), rules: [{type: 'requires', reference: reference()}]});
  assert.throws(() => f.read(), /LIFECYCLE_READ_LIMIT/);
});
