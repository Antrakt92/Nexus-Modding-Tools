'use strict';
const disk = require('node:fs');
const path = require('node:path');
const ACTIVE = new Set(['init', 'started', 'finalizing']);
const TERMINAL = new Set(['finished', 'failed', 'paused', 'redirect', 'cancelled', 'canceled', 'removed']);
const aliases = { skyrimse: 'skyrimspecialedition', skyrimvr: 'skyrimspecialedition', falloutnv: 'newvegas', fallout4vr: 'fallout4', teso: 'elderscrollsonline' };
const present = value => value !== undefined && value !== null;
function positiveId(value) {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
// v2.7.2 nexus_integration/util.ts cachePath(), selectors.ts and convertGameId.ts:
// nexus.ids.gameId is a domain; meta.gameId is numeric. Never fetch a catalogue.
function catalogFromDisk(util) {
  return () => {
    const file = path.join(util.getVortexPath('temp'), 'nexus_gamelist.json');
    const fd = disk.openSync(file, 'r');
    try {
      if (disk.fstatSync(fd).size > 4 * 1024 * 1024) throw Error('NEXUS_CATALOG_TOO_LARGE');
      const bytes = Buffer.alloc(4 * 1024 * 1024 + 1); const size = disk.readSync(fd, bytes, 0, bytes.length, 0);
      if (size > 4 * 1024 * 1024) throw Error('NEXUS_CATALOG_TOO_LARGE');
      const rows = JSON.parse(bytes.subarray(0, size).toString('utf8'));
      if (!Array.isArray(rows) || rows.length > 10000) throw Error('NEXUS_CATALOG_INVALID');
      return rows.map(row => ({ id: row.id, domain_name: row.domain_name }));
    } finally { disk.closeSync(fd); }
  };
}
// A synchronous scan sees one catalogue. Every later scan gets a fresh reader,
// including the final acquisition preflight; failures are never cached globally.
function catalogSnapshot(read = () => []) {
  let loaded = false, failed = false, rows, error;
  return () => {
    if (!loaded) {
      loaded = true;
      try { rows = read(); } catch (cause) { failed = true; error = cause; }
    }
    if (failed) throw error;
    return rows;
  };
}
function domainForGame(gameId, state, selectors) {
  const game = selectors.knownGames?.(state)?.find(g => g.id === gameId);
  return game?.details?.nexusPageId ?? aliases[gameId] ?? gameId;
}
function resolveDownload(item, state, selectors, catalog = () => []) {
  const info = item?.modInfo || {}, ids = info.nexus?.ids || {}, meta = info.meta || {};
  let ambiguous = false;
  const mergeId = values => {
    const supplied = values.filter(present), parsed = supplied.map(positiveId);
    if (parsed.some(id => id === null) || new Set(parsed).size > 1) ambiguous = true;
    return parsed[0] ?? null;
  };
  const modId = mergeId([ids.modId, info.modId]), fileId = mergeId([ids.fileId, info.fileId]);
  const gameValues = Array.isArray(item?.game) ? item.game : present(item?.game) ? [item.game] : [];
  if (Array.isArray(item?.game) && item.game.length === 0) ambiguous = true;
  const games = gameValues.filter(g => typeof g === 'string' && /^[a-z0-9_-]{1,200}$/.test(g));
  if (games.length !== gameValues.length || new Set(games).size !== games.length) ambiguous = true;
  const domains = games.map(g => domainForGame(g, state, selectors));
  if (domains.some(domain => typeof domain !== 'string' || !/^[a-z0-9_-]{1,200}$/.test(domain) || /^\d+$/.test(domain))) ambiguous = true;
  for (const domain of [ids.gameId, meta.domainName]) if (present(domain)) {
    if (typeof domain !== 'string' || !/^[a-z0-9_-]{1,200}$/.test(domain) || /^\d+$/.test(domain)) ambiguous = true;
    else domains.push(domain);
  }
  if (present(meta.gameId)) {
    const numeric = positiveId(meta.gameId); let rows;
    try { rows = catalog(); } catch { rows = []; }
    const matches = Array.isArray(rows) ? rows.filter(row => positiveId(row.id) === numeric) : [];
    if (numeric === null || matches.length !== 1 || typeof matches[0]?.domain_name !== 'string'
      || !/^[a-z0-9_-]{1,200}$/.test(matches[0].domain_name)) ambiguous = true;
    else domains.push(matches[0].domain_name);
  }
  if (new Set(domains).size > 1) ambiguous = true;
  const domain = domains[0] ?? null;
  // A Nexus domain can serve multiple Vortex games (SE/VR). Without record.game
  // only a unique installed provider mapping is enough to choose its directory.
  let gameId = games.length === 1 ? games[0] : null;
  if (!games.length && domain) {
    const candidates = (selectors.knownGames?.(state) || []).filter(g => domainForGame(g.id, state, selectors) === domain);
    if (candidates.length === 1) gameId = candidates[0].id;
    else if (!selectors.knownGames && !Object.values(aliases).includes(domain)) gameId = domain;
  }
  return { gameId, domain, modId, fileId, ambiguous: ambiguous || games.length > 1,
    complete: !ambiguous && !!gameId && !!modId && !!fileId, games };
}
function matchingDownloads(files, args, state, selectors, catalog) {
  const matches = [];
  const snapshot = catalogSnapshot(catalog);
  for (const [id, item] of Object.entries(files)) {
    const info = item?.modInfo || {};
    const mods = [info.nexus?.ids?.modId, info.modId].map(positiveId);
    const ids = [info.nexus?.ids?.fileId, info.fileId].map(positiveId);
    const modMatch = mods.includes(args.nexusModId), fileMatch = ids.includes(args.nexusFileId);
    const relevant = modMatch && (fileMatch || ids.every(id => id === null)) || fileMatch && mods.every(id => id === null);
    if (!relevant) continue;
    const identity = resolveDownload(item, state, selectors, snapshot);
    if (!identity.ambiguous && identity.gameId && identity.gameId !== args.gameId) {
      if (identity.domain === domainForGame(args.gameId, state, selectors)) throw Error('AMBIGUOUS_DOWNLOAD_IDENTITY');
      continue;
    }
    // Unknown/conflicting game metadata for the same file must not authorize a
    // second acquisition. Explicit, consistent other-game records are unrelated.
    if (identity.ambiguous || !identity.complete) throw Error('AMBIGUOUS_DOWNLOAD_IDENTITY');
    if (identity.gameId === args.gameId) matches.push([id, item]);
  }
  if (matches.length > 1) throw Error('AMBIGUOUS_EXISTING_DOWNLOAD');
  return matches;
}
module.exports = { ACTIVE, TERMINAL, positiveId, domainForGame, resolveDownload, matchingDownloads, catalogFromDisk, catalogSnapshot };
