'use strict';
const fs = require('node:fs/promises');
const disk = require('node:fs');
const path = require('node:path');
const { insist, normalized, identity } = require('./guard.cjs');
const { resolveDownload } = require('./download-identity.cjs');
function externalChanges(api) {
  const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
  return (api.getState().session?.mods?.changes || []).map(item => Object.fromEntries(
    ['filePath', 'source', 'modTypeId', 'type', 'action', 'sourceModified', 'destModified'].map(key => [key, scalar(item[key])])));
}
function listDownloads(api, selectors, args, catalog) {
  const state = api.getState(), gameId = args.gameId ?? selectors.activeGameId(state);
  insist(typeof gameId === 'string' && (selectors.knownGames?.(state) || []).some(g => g.id === gameId), 'UNKNOWN_GAME');
  const states = new Set(args.states || ['finished', 'started', 'paused', 'failed', 'init', 'finalizing']);
  return Object.entries(state.persistent?.downloads?.files || {}).map(([id, item]) => ({ id, item, identity: resolveDownload(item, state, selectors, catalog) }))
    .filter(({ item, identity }) => states.has(item?.state) && (identity.gameId === gameId || identity.games.includes(gameId)))
    .sort((a, b) => (Number(b.item.startTime) || 0) - (Number(a.item.startTime) || 0)).slice(0, args.limit || 100)
    .map(({ id, item, identity }) => ({ id, name: typeof item.modInfo?.name === 'string' ? item.modInfo.name : typeof item.localPath === 'string' ? item.localPath : id,
      state: item.state, size: Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null,
      progress: Number.isFinite(item.received) && item.size > 0 ? Math.round(item.received / item.size * 100) : 0,
      startTime: Number.isFinite(item.startTime) ? item.startTime : null,
      installedModId: typeof item.installed?.modId === 'string' ? item.installed.modId : undefined,
      gameId: identity.gameId ?? undefined, nexusDomain: identity.domain ?? undefined,
      nexusModId: identity.ambiguous ? null : identity.modId, nexusFileId: identity.ambiguous ? null : identity.fileId,
      identityVerified: identity.complete, identityAmbiguous: identity.ambiguous || !identity.complete }));
}
function scanScope(state, gameId, profileId) {
  const profile = state.persistent?.profiles?.[profileId];
  return JSON.stringify(Object.entries(profile?.modState || {}).filter(([, mod]) => mod.enabled === true).map(([id]) => {
    const mod = state.persistent?.mods?.[gameId]?.[id]; return [id, mod?.state ?? null, mod?.installationPath ?? null, mod?.archiveId ?? null, mod?.type ?? null];
  }).sort((a, b) => a[0].localeCompare(b[0])));
}
function dialogs(api) {
  return (api.getState().session?.notifications?.dialogs || []).map(d => ({
    id: d.id, type: d.type, title: d.title,
    message: d.content?.message ?? d.content?.text ?? d.content?.bbcode ?? d.content?.md,
    actions: (d.actions || []).map(a => typeof a === 'string' ? a : { label: a.label }),
    defaultAction: d.defaultAction,
    // Never copy the value, defaultValue, choice or callback from an input control.
    input: (d.content?.input || []).map(i => ({ id: i.id, label: i.label })),
  }));
}
async function conflicts(api, selectors, args) {
  const state = api.getState(), profileId = selectors.activeProfileId(state);
  const profile = state.persistent?.profiles?.[profileId];
  const gameId = args.gameId || selectors.activeGameId(state);
  insist(profile?.gameId === gameId, 'CONFLICT_SCAN_REQUIRES_ACTIVE_GAME');
  const scope = scanScope(state, gameId, profileId);
  const configured = selectors.installPathForGame(state, gameId);
  insist(typeof configured === 'string' && path.isAbsolute(configured), 'ABSOLUTE_STAGING_REQUIRED');
  const root = await fs.realpath(configured);
  const rootIdentity = identity(root);
  const owners = new Map(); let entries = 0;
  const deadline = Date.now() + 10000;
  async function walk(dir, modRoot, modId, depth = 0) {
    insist(depth <= 32 && Date.now() <= deadline, 'CONFLICT_SCAN_LIMIT');
    // opendir streams entries instead of allocating an unbounded directory array.
    for await (const item of await fs.opendir(dir)) {
      insist(++entries <= 20000 && Date.now() <= deadline, 'CONFLICT_SCAN_LIMIT');
      const file = path.join(dir, item.name);
      const stat = await fs.lstat(file), real = await fs.realpath(file);
      insist(!stat.isSymbolicLink() && normalized(real) === normalized(file)
        && path.relative(root, real) !== '..' && !path.relative(root, real).startsWith('..' + path.sep), 'STAGING_REPARSE_OR_ESCAPE');
      if (stat.isDirectory()) await walk(file, modRoot, modId, depth + 1);
      else if (stat.isFile()) {
        const rel = path.relative(modRoot, file).replaceAll('\\', '/');
        const key = rel.toLowerCase();
        if (!owners.has(key)) owners.set(key, { path: rel, modIds: [] });
        owners.get(key).modIds.push(modId);
      } else insist(false, 'UNSUPPORTED_STAGE_ENTRY');
    }
  }
  const mods = Object.entries(state.persistent?.mods?.[gameId] || {}).filter(([id]) => profile.modState?.[id]?.enabled === true);
  insist(mods.length <= 500, 'CONFLICT_SCAN_LIMIT');
  for (const [id, mod] of mods) {
    const name = mod.installationPath;
    insist(typeof name === 'string' && name.length > 0 && !/[\\/<>:"|?*]/.test(name) && name !== '.' && name !== '..', 'INSTALLATION_PATH_TRAVERSAL');
    const dir = path.join(root, name), stat = await fs.lstat(dir), real = await fs.realpath(dir);
    insist(stat.isDirectory() && !stat.isSymbolicLink() && normalized(dir) === normalized(real), 'STAGING_REPARSE_OR_ESCAPE');
    await walk(dir, dir, id);
  }
  insist(Date.now() <= deadline, 'CONFLICT_SCAN_LIMIT');
  const live = api.getState();
  const liveConfigured = selectors.installPathForGame(live, gameId);
  insist(selectors.activeProfileId(live) === profileId && selectors.activeGameId(live) === gameId
    && typeof liveConfigured === 'string' && path.isAbsolute(liveConfigured), 'STALE_SCAN_CONTEXT');
  const liveRoot = disk.realpathSync(liveConfigured);
  insist(normalized(liveRoot) === normalized(root) && identity(liveRoot) === rootIdentity, 'STALE_SCAN_CONTEXT');
  insist(live.persistent?.profiles?.[profileId]?.gameId === gameId && scanScope(live, gameId, profileId) === scope, 'STALE_SCAN_SCOPE');
  const all = [...owners.values()].filter(item => item.modIds.length > 1
    && (!args.nameFilter || item.path.toLowerCase().includes(args.nameFilter.toLowerCase())));
  return { conflicts: all.slice(0, args.limit || 100), totalCount: all.length,
    truncated: all.length > (args.limit || 100), entriesScanned: entries, winnerVerified: false };
}
module.exports = { dialogs, conflicts, externalChanges, listDownloads, scanScope };
