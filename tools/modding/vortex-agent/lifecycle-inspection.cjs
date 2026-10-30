'use strict';

const LIMITS = Object.freeze({targets: 20, profiles: 2000, mods: 10000, allGameMods: 20000,
  rules: 50000, matcherChecks: 200000, incomingRequires: 5000, archiveReferences: 5000,
  profileReferences: 5000, responseBytes: 2 * 1024 * 1024});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const archiveId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const type = value => typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const insist = (ok, code) => {if (!ok) throw Error(code);};
const exactFileId = reference => {
  const fileId = reference.repo?.fileId;
  if (typeof reference.repo?.repository !== 'string' || !reference.repo.repository.length
      || !['string', 'number'].includes(typeof fileId)
      || typeof fileId === 'string' && !/^[1-9]\d*$/.test(fileId)) return null;
  const value = Number(fileId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

function readModLifecycle(api, selectors, util, args) {
  insist(object(args) && Object.keys(args).every(key => ['gameId', 'modIds'].includes(key))
    && (args.gameId === undefined || id(args.gameId)) && Array.isArray(args.modIds)
    && args.modIds.length > 0 && args.modIds.length <= LIMITS.targets && args.modIds.every(id)
    && new Set(args.modIds).size === args.modIds.length, 'INVALID_LIFECYCLE_REQUEST');
  insist(typeof util?.testModReference === 'function', 'LIFECYCLE_MATCHER_UNAVAILABLE');
  const state = api.getState(), gameId = selectors.activeGameId(state), profileId = selectors.activeProfileId(state);
  insist(id(gameId) && id(profileId) && (args.gameId === undefined || args.gameId === gameId)
    && state.persistent?.profiles?.[profileId]?.gameId === gameId, 'LIFECYCLE_CONTEXT_UNAVAILABLE');
  const allMods = state.persistent?.mods, profiles = state.persistent?.profiles;
  insist(object(allMods) && Object.hasOwn(allMods, gameId) && object(allMods[gameId]) && object(profiles), 'LIFECYCLE_STATE_INVALID');
  const mods = allMods[gameId], selected = args.modIds.map(modId => {
    const record = Object.hasOwn(mods, modId) ? mods[modId] : null;
    insist(object(record) && record.state === 'installed', 'LIFECYCLE_TARGET_NOT_INSTALLED');
    insist(type(record.type) && (record.attributes === undefined || object(record.attributes))
      && (record.archiveId === undefined || record.archiveId === null || archiveId(record.archiveId)),
      'LIFECYCLE_STATE_INVALID');
    return {native: {...record, id: modId}, result: {id: modId, installationState: record.state, type: record.type,
      archiveId: record.archiveId ?? null, activeEnabled: null, profiles: [], incomingRequires: [], archiveReferences: []}};
  });
  let profileCount = 0, modCount = 0, allGameModCount = 0, ruleCount = 0, matcherChecks = 0;
  let incomingCount = 0, archiveReferenceCount = 0, profileReferenceCount = 0, unknownProfileFlagCount = 0;
  for (const key of Object.keys(profiles)) {
    insist(++profileCount <= LIMITS.profiles, 'LIFECYCLE_READ_LIMIT');
    const profile = profiles[key];
    insist(id(key) && object(profile) && id(profile.gameId)
      && (profile.modState === undefined || object(profile.modState)), 'LIFECYCLE_STATE_INVALID');
    if (profile.gameId !== gameId) continue;
    for (const target of selected) {
      const present = profile.modState !== undefined && Object.hasOwn(profile.modState, target.result.id);
      const flag = present ? profile.modState[target.result.id] : undefined;
      const enabled = !present ? false : object(flag) && typeof flag.enabled === 'boolean' ? flag.enabled : null;
      if (enabled === null) unknownProfileFlagCount++;
      if (key === profileId) target.result.activeEnabled = enabled;
      if (present || key === profileId) {
        insist(++profileReferenceCount <= LIMITS.profileReferences, 'LIFECYCLE_READ_LIMIT');
        target.result.profiles.push({id: key, gameId, present, enabled,
          pendingRemove: profile.pendingRemove === undefined ? false
            : typeof profile.pendingRemove === 'boolean' ? profile.pendingRemove : null});
      }
    }
  }
  const archives = new Map(selected.filter(target => target.result.archiveId !== null)
    .map(target => [target.result.archiveId, []]));
  for (const currentGame of Object.keys(allMods)) {
    insist(id(currentGame) && object(allMods[currentGame]), 'LIFECYCLE_STATE_INVALID');
    for (const modId of Object.keys(allMods[currentGame])) {
      insist(++allGameModCount <= LIMITS.allGameMods, 'LIFECYCLE_READ_LIMIT');
      const record = allMods[currentGame][modId];
      insist(id(modId) && object(record)
        && (record.archiveId === undefined || record.archiveId === null || archiveId(record.archiveId)), 'LIFECYCLE_STATE_INVALID');
      const references = archives.get(record.archiveId);
      if (references) {
        insist(++archiveReferenceCount <= LIMITS.archiveReferences, 'LIFECYCLE_READ_LIMIT');
        references.push({gameId: currentGame, modId});
      }
      if (currentGame !== gameId) continue;
      insist(++modCount <= LIMITS.mods, 'LIFECYCLE_READ_LIMIT');
      insist(type(record.type) && id(record.state) && (record.attributes === undefined || object(record.attributes))
        && (record.rules === undefined || Array.isArray(record.rules)), 'LIFECYCLE_STATE_INVALID');
      for (const rule of record.rules || []) {
        insist(++ruleCount <= LIMITS.rules, 'LIFECYCLE_READ_LIMIT');
        insist(object(rule) && typeof rule.type === 'string', 'LIFECYCLE_STATE_INVALID');
        if (rule.type !== 'requires') continue;
        insist(object(rule.reference), 'LIFECYCLE_STATE_INVALID');
        for (const target of selected) {
          insist(++matcherChecks <= LIMITS.matcherChecks, 'LIFECYCLE_READ_LIMIT');
          let matched;
          // A third source argument can update native reference caches. This is
          // an observation-only matcher call, including ignored requires rules.
          try {matched = util.testModReference(target.native, rule.reference);}
          catch {throw Error('LIFECYCLE_MATCHER_FAILED');}
          insist(typeof matched === 'boolean', 'LIFECYCLE_MATCHER_INVALID');
          if (!matched) continue;
          insist(++incomingCount <= LIMITS.incomingRequires, 'LIFECYCLE_READ_LIMIT');
          target.result.incomingRequires.push({ownerId: modId, ownerType: record.type,
            ignored: rule.ignored === undefined ? false : typeof rule.ignored === 'boolean' ? rule.ignored : null,
            exactFileId: exactFileId(rule.reference)});
        }
      }
    }
  }
  let projectedArchiveReferences = 0;
  for (const target of selected) {
    target.result.archiveReferences = archives.get(target.result.archiveId) || [];
    projectedArchiveReferences += target.result.archiveReferences.length;
    insist(projectedArchiveReferences <= LIMITS.archiveReferences, 'LIFECYCLE_READ_LIMIT');
  }
  const result = {protocol: 'vortex-agent/1', gameId, profileId, profileCount, modCount, allGameModCount, ruleCount, matcherChecks,
    unknownProfileFlagCount, metadataOnly: true, effectsAllowed: false, diskDeploymentVerified: false,
    installationSupported: false, removalSupported: false, limits: {...LIMITS}, mods: selected.map(target => target.result)};
  insist(Buffer.byteLength(JSON.stringify(result), 'utf8') <= LIMITS.responseBytes, 'LIFECYCLE_READ_LIMIT');
  return result;
}

module.exports = {readModLifecycle, LIMITS};
