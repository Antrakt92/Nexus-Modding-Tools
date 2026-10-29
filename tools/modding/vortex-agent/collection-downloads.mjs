import {createToolCaller, inspectDownloadSession} from './session.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const states = new Set(['finished', 'started', 'paused', 'failed', 'init', 'finalizing']);
const pair = file => `${file.nexusModId}:${file.nexusFileId}`;
function insist(ok, code) {if (!ok) throw Error(code);}

export function validateCollectionRequest(input) {
  insist(object(input) && Object.keys(input).sort().join(',') === 'files,gameId'
    && typeof input.gameId === 'string' && /^[a-z0-9_-]{1,200}$/.test(input.gameId)
    && Array.isArray(input.files) && input.files.length > 0 && input.files.length <= 100, 'INVALID_COLLECTION_REQUEST');
  const unique = new Map();
  for (const file of input.files) {
    insist(object(file) && Object.keys(file).sort().join(',') === 'nexusFileId,nexusModId'
      && positive(file.nexusModId) && positive(file.nexusFileId), 'INVALID_COLLECTION_REQUEST');
    unique.set(pair(file), {nexusModId: file.nexusModId, nexusFileId: file.nexusFileId});
  }
  return {gameId: input.gameId, requestedCount: input.files.length, files: [...unique.values()]};
}

function validObservation(row, gameId) {
  return object(row) && id(row.id) && states.has(row.state)
    && (row.size === null || Number.isSafeInteger(row.size) && row.size >= 0)
    && typeof row.identityVerified === 'boolean' && typeof row.identityAmbiguous === 'boolean'
    && (row.installedModId === undefined || id(row.installedModId))
    && [row.nexusModId, row.nexusFileId].every(n => n === null || positive(n))
    && (!row.identityVerified || row.identityAmbiguous === false && row.gameId === gameId
      && positive(row.nexusModId) && positive(row.nexusFileId));
}

// The join uses only already-curated metadata. It neither opens archives nor
// authorizes a new download when no candidate is visible in a bounded read.
export async function findCollectionDownloads(input, {call = createToolCaller()} = {}) {
  const request = validateCollectionRequest(input);
  const snapshot = await inspectDownloadSession({call, gameId: request.gameId});
  const errors = [...snapshot.errors], index = new Map(request.files.map(file => [pair(file), []]));
  const rows = snapshot.results.list_downloads;
  let unverifiedIdentityCount = 0;
  const contextStable = !errors.some(error => error.tool === 'health');
  let valid = Array.isArray(rows);
  if (valid && (rows.length > 500 || !rows.every(row => validObservation(row, request.gameId)) || new Set(rows.map(row => row.id)).size !== rows.length)) {
    valid = false; errors.push({tool: 'list_downloads', code: 'INVALID_DOWNLOAD_OBSERVATION'});
  }
  if (valid && contextStable) for (const row of rows) {
    if (!row.identityVerified || row.identityAmbiguous) {unverifiedIdentityCount++; continue;}
    const candidates = index.get(pair(row));
    if (!candidates) continue;
    candidates.push({downloadId: row.id, state: row.state, size: row.size,
      ...(row.installedModId === undefined ? {} : {installedModId: row.installedModId})});
  }
  const complete = errors.length === 0;
  const files = request.files.map(file => {
    const candidates = index.get(pair(file));
    const availability = candidates.some(row => row.state === 'finished') ? 'finished'
      : candidates.some(row => ['init', 'started', 'finalizing'].includes(row.state)) ? 'active'
      : candidates.some(row => row.state === 'paused') ? 'paused'
      : candidates.length ? 'failed' : complete ? 'not_observed' : 'unknown';
    return {...file, availability, candidates, duplicateCandidates: candidates.length > 1 ? true : complete ? false : null};
  });
  return {status: complete ? 'ok' : 'partial', gameId: request.gameId,
    ...(contextStable && snapshot.results.health ? {context: snapshot.results.health} : {}),
    requestedCount: request.requestedCount, uniqueCount: files.length,
    observedDownloadCount: valid && contextStable ? rows.length : null,
    unverifiedIdentityCount: valid && contextStable ? unverifiedIdentityCount : null,
    observationComplete: complete, inventoryLimit: 500, snapshotAtomic: false,
    metadataOnly: true, archiveIntegrityVerified: false, files, errors};
}
