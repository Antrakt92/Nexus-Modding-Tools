import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { unresolvedConflicts, collectionHealth } = require('./inspection.cjs');
const { safe } = require('./serialization.cjs');

function fixture(count = 0) {
  const base = { id: 'base', attributes: { name: 'Base', referenceTag: 'ncr-base', fileMD5: 'md5-base' } };
  const addon = { id: 'addon', attributes: { name: 'Addon' }, rules: [{ type: 'after',
    reference: { tag: 'ncr-base', fileMD5: 'md5-base' }, extra: { fromCollection: 'old-revision' } }] };
  const overlap = { otherMod: { id: base.id, name: 'Base', referenceTag: 'ncr-base', fileMD5: 'md5-base' },
    files: ['example.reds'], suggestion: null };
  const state = { persistent: { profiles: { p: { gameId: 'game' } }, mods: { game: { base, addon } } },
    session: { dependencies: { conflicts: { addon: [overlap] }, unsolvedConflictsCount: count, hasUnsolvedConflicts: count > 0 },
      collections: { activeSession: undefined } } };
  const calls = [];
  // Contract double, deliberately NOT a replacement implementation of Vortex's
  // matcher. It recognizes only these fixtures; production receives native util.
  const util = { renderModName: mod => mod.attributes.name, testModReference: (target, reference) => {
    calls.push({ target, reference });
    const lookup = target.attributes || target;
    return (reference.tag !== undefined && reference.tag === lookup.referenceTag)
      || (reference.fileMD5 !== undefined && reference.fileMD5 === lookup.fileMD5)
      || (reference.id !== undefined && reference.id === target.id);
  } };
  return { state, base, addon, overlap, calls, util, api: { getState: () => state },
    selectors: { activeGameId: () => 'game', activeProfileId: () => 'p' } };
}

test('tag/MD5 portable rule delegates to native predicate rather than ID-only lookup', () => {
  const f = fixture();
  assert.equal(f.addon.rules.some(r => r.reference.id === f.base.id || r.reference.idHint === f.base.id), false);
  assert.deepEqual(unresolvedConflicts(f.api, f.selectors, f.util), []);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].target, f.overlap.otherMod);
  assert.equal(f.calls[0].reference, f.addon.rules[0].reference);
  assert.equal(f.calls[0].reference.tag, 'ncr-base');
  assert.equal(f.calls[0].reference.fileMD5, 'md5-base');
});
test('reverse rule passes the complete installed source mod to native matcher', () => {
  const f = fixture(); f.addon.rules = [];
  f.base.rules = [{ type: 'before', reference: { id: 'addon' } }];
  assert.deepEqual(unresolvedConflicts(f.api, f.selectors, f.util), []);
  assert.equal(f.calls[0].target, f.addon);
});
test('positive native count returns complete compatible array with safe projection and deduplication', () => {
  const f = fixture(1); f.addon.rules = [];
  f.overlap.otherMod.password = 'never-copy'; f.overlap.otherMod.account = { private: true };
  f.state.session.dependencies.conflicts.base = [{ ...f.overlap, otherMod: { id: 'addon' } }];
  assert.deepEqual(unresolvedConflicts(f.api, f.selectors, f.util), [{ modId: 'addon', modName: 'Addon',
    otherModId: 'base', otherModName: 'Base', files: ['example.reds'], suggestion: null }]);
});
test('global fallback: native zero is authoritative even without a direct rule', () => {
  const f = fixture(); f.addon.rules = [];
  assert.deepEqual(unresolvedConflicts(f.api, f.selectors, f.util), []);
});
test('global fallback cannot silently emit partial or stale conflicting details', () => {
  const f = fixture(1); f.addon.rules = [];
  f.state.session.dependencies.conflicts.addon.push({ ...f.overlap, otherMod: { id: 'third' } });
  assert.throws(() => unresolvedConflicts(f.api, f.selectors, f.util), /NATIVE_CONFLICT_DETAILS_UNAVAILABLE/);
  f.state.session.dependencies.conflicts.addon = [];
  assert.throws(() => unresolvedConflicts(f.api, f.selectors, f.util), /NATIVE_CONFLICT_DETAILS_UNAVAILABLE/);
});
for (const count of [undefined, null, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid native count ${String(count)} is unavailable, never healthy zero`, () => {
    const f = fixture(); f.state.session.dependencies.unsolvedConflictsCount = count;
    assert.equal(collectionHealth(f.api, f.selectors).nativeConflicts.available, false);
    assert.equal(collectionHealth(f.api, f.selectors).nativeConflicts.count, null);
    assert.throws(() => unresolvedConflicts(f.api, f.selectors, f.util), /NATIVE_CONFLICT_STATE_UNAVAILABLE/);
  });
}
test('missing/wrong-type/inconsistent native flag and uncalculated conflicts fail closed', () => {
  for (const flag of [undefined, 'false', true]) {
    const f = fixture(); f.state.session.dependencies.hasUnsolvedConflicts = flag;
    assert.equal(collectionHealth(f.api, f.selectors).nativeConflicts.consistent, false);
    assert.throws(() => unresolvedConflicts(f.api, f.selectors, f.util), /NATIVE_CONFLICT_STATE_UNAVAILABLE/);
  }
  const f = fixture(); delete f.state.session.dependencies.conflicts;
  assert.equal(collectionHealth(f.api, f.selectors).nativeConflicts.conflictsCalculated, false);
  assert.throws(() => unresolvedConflicts(f.api, f.selectors, f.util), /NATIVE_CONFLICT_STATE_UNAVAILABLE/);
});
test('malformed state, wrong context or absent native matcher cannot produce a success', () => {
  const f = fixture(); f.state.session.dependencies.conflicts.addon[0].files = ['ok', { secret: 'not-a-path' }];
  assert.throws(() => unresolvedConflicts(f.api, f.selectors, f.util), /NATIVE_CONFLICT_STATE_INVALID/);
  delete f.util.testModReference;
  assert.throws(() => unresolvedConflicts(f.api, f.selectors, f.util), /NATIVE_CONFLICT_MATCHER_UNAVAILABLE/);
  f.state.persistent.profiles.p.gameId = 'different';
  assert.throws(() => collectionHealth(f.api, f.selectors), /CONFLICT_READ_REQUIRES_ACTIVE_GAME/);
  assert.throws(() => unresolvedConflicts(f.api, f.selectors, f.util), /CONFLICT_READ_REQUIRES_ACTIVE_GAME/);
});
test('health only projects safe numeric/boolean session observations, never infers completion', () => {
  const f = fixture(); f.state.session.collections.activeSession = { stalled: false, totalRequired: 2,
    installedCount: 2, failedCount: '0', mods: { private: 'never-copy' }, token: 'never-copy', status: 'private://value' };
  const result = collectionHealth(f.api, f.selectors);
  assert.equal(result.collectionSession.present, true);
  assert.equal(result.collectionSession.counters.failedCount, null);
  assert.equal(result.recalculationVerified, false);
  assert.equal(result.diskDeploymentVerified, false);
  assert.equal(JSON.stringify(result).includes('never-copy'), false);
  assert.equal('isComplete' in result.collectionSession, false);
  delete f.state.session.collections;
  assert.equal(collectionHealth(f.api, f.selectors).collectionSession.present, null);
});
test('existing serializer still redacts credentials, account strings and URI display fields', () => {
  const f = fixture(1); f.addon.rules = [];
  f.state.confidential = { token: 'secret-value' }; f.state.persistent.nexus = { userInfo: { username: 'private-person' } };
  f.addon.attributes.name = 'private-person secret-value nxm://private';
  f.overlap.files = ['secret-value private-person https://private'];
  const result = safe(unresolvedConflicts(f.api, f.selectors, f.util), f.api, 'list_unsolved_conflicts');
  const text = JSON.stringify(result);
  assert.equal(text.includes('secret-value'), false); assert.equal(text.includes('private-person'), false);
  assert.equal(text.includes('nxm://'), false); assert.equal(text.includes('https://'), false);
  assert.equal(result[0].modId, 'addon');
});
test('registration uses curated replacement and exposes narrow health read', () => {
  const text = fs.readFileSync(new URL('./extension.cjs', import.meta.url), 'utf8');
  assert.match(text, /add\('list_unsolved_conflicts', \{\}, \(\) => unresolvedConflicts\(api, selectors, util\)\)/);
  assert.match(text, /add\('read_collection_health', \{\}, \(\) => collectionHealth\(api, selectors\)\)/);
  assert.doesNotMatch(text, /control\.listUnsolvedConflicts\(api\)/);
});
