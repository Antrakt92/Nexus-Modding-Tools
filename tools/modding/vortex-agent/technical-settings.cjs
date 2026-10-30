'use strict';

// Comparison projection only. Never write its result back to Vortex.
const { isDeepStrictEqual } = require('node:util');
const source = Object.freeze({
  appAsarSHA256: 'ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a',
  startup: '417-index.ts:925-971 -> 399-GameModeManager.ts:281-296',
  discovery: '425-discovery.ts:464-508,525-553 -> 399-GameModeManager.ts:596-606',
  reducer: '421-settings.ts:82-104',
});
const pairs = Object.freeze([
  ['assassinscreedunity', 'assassinscreedunity-customlaunch'],
  ['cyberpunk2077', 'REDprelauncher.exe'],
  ['cyberpunk2077', 'V2077-game-exe-modded'],
  ['cyberpunk2077', 'V2077-tools-redMod'],
  ['farcry6', 'farcry6-customlaunch'],
  ['farcry6', 'farcry6-modinstaller'],
  ['farcry6', 'farcry6-savemanager'],
  ['witcher3', 'witcher3_DX12'],
].map(pair => Object.freeze(pair)));
const paths = Object.freeze(pairs.map(([game, tool]) => `/gameMode/discovered/${game}/tools/${tool}/timestamp`));
const invalid = () => { throw Error('INVALID_TECHNICAL_SETTINGS'); };

// Reject values that JSON serialization would silently omit or coerce. Read only
// data descriptors, so validating a supplied snapshot never invokes its getters.
function copyJSON(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value; }
  if (typeof value !== 'object' || ancestors.has(value)) invalid();
  const array = Array.isArray(value);
  if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) invalid();
  if (array && (Object.keys(descriptors).length !== value.length + 1
      || Array.from({ length: value.length }, (_, i) => String(i)).some(key => !Object.hasOwn(descriptors, key)))) invalid();
  ancestors.add(value);
  const result = array ? [] : {};
  for (const key of Object.keys(descriptors).sort()) {
    if (array && key === 'length') continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    Object.defineProperty(result, key, { value: copyJSON(descriptor.value, ancestors), enumerable: true, writable: true, configurable: true });
  }
  ancestors.delete(value);
  return result;
}

function normalize(settings, options) {
  if (!options || options.appAsarSHA256 !== source.appAsarSHA256) throw Error('UNSUPPORTED_SETTINGS_SOURCE');
  const result = copyJSON(settings);
  if (!result || Array.isArray(result) || typeof result !== 'object') invalid();
  for (const [game, tool] of pairs) {
    const node = result.gameMode?.discovered?.[game]?.tools?.[tool];
    if (!node || Array.isArray(node) || typeof node !== 'object' || !Object.hasOwn(node, 'timestamp')
        || !Number.isSafeInteger(node.timestamp) || node.timestamp < 0 || Object.is(node.timestamp, -0)) invalid();
    delete node.timestamp;
  }
  return result;
}

function compare(before, after, options) {
  if (!isDeepStrictEqual(normalize(before, options), normalize(after, options))) throw Error('TECHNICAL_SETTINGS_CHANGED');
  return { equal: true, changedTimestampPaths: pairs.flatMap(([game, tool], i) =>
    before.gameMode.discovered[game].tools[tool].timestamp !== after.gameMode.discovered[game].tools[tool].timestamp ? [paths[i]] : []) };
}

module.exports = { normalize, compare, paths, source };
