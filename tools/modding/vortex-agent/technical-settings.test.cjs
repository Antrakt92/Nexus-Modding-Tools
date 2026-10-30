'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, compare, paths, source } = require('./technical-settings.cjs');
const options = { appAsarSHA256: source.appAsarSHA256 };
function fixture() {
  const settings = { gameMode: { discovered: {} }, profiles: { activeProfileId: 'a', nextProfileId: 'a', lastActiveProfile: { cyberpunk2077: 'a', other: 'b' } },
    interface: { language: 'en', custom: [1, 2] } };
  for (const path of paths) {
    const [, , , game, , tool] = path.split('/');
    settings.gameMode.discovered[game] ??= { tools: {} };
    settings.gameMode.discovered[game].tools[tool] = { timestamp: 1, path: `C:/tools/${tool}`, custom: true };
  }
  return settings;
}
const node = settings => settings.gameMode.discovered.cyberpunk2077.tools['REDprelauncher.exe'];
test('admits exactly the eight observed timestamp refreshes without mutating snapshots', () => {
  const before = fixture(), after = fixture(), original = structuredClone(before);
  for (const game of Object.values(after.gameMode.discovered)) for (const tool of Object.values(game.tools)) tool.timestamp = 2;
  assert.deepEqual(compare(before, after, options), { equal: true, changedTimestampPaths: paths });
  assert.deepEqual(before, original); assert.equal(node(after).timestamp, 2);
  assert(!Object.hasOwn(node(normalize(before, options)), 'timestamp'));
  assert.deepEqual(compare(before, before, options).changedTimestampPaths, []);
});
test('source pin is mandatory and cannot opt into unknown builds or ignore paths', () => {
  for (const candidate of [undefined, {}, { appAsarSHA256: 'a'.repeat(64) }])
    assert.throws(() => compare(fixture(), fixture(), candidate), /UNSUPPORTED_SETTINGS_SOURCE/);
});
test('personal settings, tool fields, pointers, other games and unknown timestamps stay strict', () => {
  const mutations = [
    s => { s.interface.language = 'de'; }, s => { s.interface.custom.reverse(); },
    s => { s.profiles.activeProfileId = 'b'; }, s => { s.profiles.nextProfileId = 'b'; },
    s => { s.profiles.lastActiveProfile.cyberpunk2077 = 'b'; }, s => { s.profiles.lastActiveProfile.other = 'a'; },
    s => { node(s).path += '-changed'; }, s => { node(s).custom = false; },
    s => { s.gameMode.discovered.farcry6.path = 'new'; },
    s => { s.gameMode.discovered.other = { tools: { unknown: { timestamp: 2 } } }; },
    s => { s.gameMode.discovered.cyberpunk2077.tools.unknown = { timestamp: 2 }; },
    s => { s.timestamp = 2; }, s => { node(s).Timestamp = 2; },
    s => { s.interface.custom[0] = -0; },
  ];
  for (const mutate of mutations) {
    const before = fixture(), after = fixture(); mutate(after);
    assert.throws(() => compare(before, after, options), /TECHNICAL_SETTINGS_CHANGED/);
  }
});
test('timestamp removal, node replacement and invalid types fail even if equal on both sides', () => {
  const mutations = [s => { delete node(s).timestamp; }, s => { delete s.gameMode.discovered.farcry6; },
    ...[-1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, {}, undefined].map(value => s => { node(s).timestamp = value; }),
    s => { s.gameMode.discovered.cyberpunk2077.tools['REDprelauncher.exe'] = []; }];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value);
    assert.throws(() => compare(value, value, options), /INVALID_TECHNICAL_SETTINGS/);
  }
});
test('non-JSON snapshots cannot hide changes through coercion, getters or omitted data', () => {
  const mutations = [s => { s.extra = undefined; }, s => { s.extra = new Date(); },
    s => { s.extra = new Map(); }, s => { s.extra = BigInt(1); }, s => { s.extra = () => {}; },
    s => { s.extra = s; }, s => { s.extra = [, 1]; }, s => { s.extra = Infinity; },
    s => { s.extra = [1]; s.extra.custom = 2; }, s => { s[Symbol('hidden')] = 1; },
    s => Object.defineProperty(s, 'hidden', { value: 1 }),
    s => Object.defineProperty(s, 'getter', { enumerable: true, get() { throw Error('GETTER_EXECUTED'); } })];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value);
    assert.throws(() => normalize(value, options), /INVALID_TECHNICAL_SETTINGS/);
  }
});
test('key order is irrelevant; literal __proto__ data remains strict', () => {
  const a = fixture(), b = fixture(); a.extra = { z: 1, a: 2 }; b.extra = { a: 2, z: 1 };
  assert.equal(compare(a, b, options).equal, true);
  a.extra = JSON.parse('{"__proto__":{"value":1}}'); b.extra = JSON.parse('{"__proto__":{"value":2}}');
  assert.throws(() => compare(a, b, options), /TECHNICAL_SETTINGS_CHANGED/);
});
