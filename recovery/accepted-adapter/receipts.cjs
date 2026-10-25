'use strict';
const path = require('node:path');
const PROTOCOL = 'vortex-agent/1', VERSION = 2;
const VERIFICATION = 'External manifest/owners/protected hashes/staging-game bytes/hardlink verification and runtime acceptance';
const operations = new Set(['install_download', 'set_mods_enabled', 'deploy_mods', 'download_nexus']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value);
const requestId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
const at = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const keys = (value, allowed) => object(value) && Object.keys(value).every(k => allowed.includes(k));
const common = ['protocol', 'receiptVersion', 'requestId', 'operation', 'gameId', 'profileId', 'at'];
function validParameters(a, operation) {
  if (!keys(a, ['gameId', 'profileId', 'requestId', 'gamePath', 'stagingPath', 'downloadPath', 'filesystemIds', 'modIds', 'enabled', 'downloadId', 'size', 'sha256', 'nexusModId', 'nexusFileId', 'reuseOnly'])
    || !id(a.gameId) || !id(a.profileId) || !requestId(a.requestId)) return false;
  if (!['gamePath', 'stagingPath', 'downloadPath'].every(k => typeof a[k] === 'string' && path.isAbsolute(a[k])
    && typeof a.filesystemIds?.[k] === 'string' && /^\d+:\d+$/.test(a.filesystemIds[k]))) return false;
  if (!keys(a.filesystemIds, ['gamePath', 'stagingPath', 'downloadPath'])) return false;
  if (operation === 'set_mods_enabled' && !(Array.isArray(a.modIds) && a.modIds.length >= 1 && a.modIds.length <= 100 && a.modIds.every(id) && typeof a.enabled === 'boolean')) return false;
  if (['download_nexus', 'install_download'].includes(operation) && !(Number.isSafeInteger(a.size) && a.size > 0 && typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256))) return false;
  if (operation === 'install_download' && !id(a.downloadId)) return false;
  if (operation === 'download_nexus' && !(Number.isSafeInteger(a.nexusModId) && a.nexusModId > 0 && Number.isSafeInteger(a.nexusFileId) && a.nexusFileId > 0
    && (a.reuseOnly === undefined || typeof a.reuseOnly === 'boolean'))) return false;
  return true;
}
function base(value) { return object(value) && value.protocol === PROTOCOL && value.receiptVersion === VERSION && operations.has(value.operation)
  && requestId(value.requestId) && at(value.at); }
function validAttempt(value) {
  return base(value) && keys(value, [...common, 'parameters']) && id(value.gameId) && id(value.profileId)
    && validParameters(value.parameters, value.operation) && value.parameters.requestId === value.requestId
    && value.parameters.gameId === value.gameId && value.parameters.profileId === value.profileId;
}
function same(value, attempt) { return value?.requestId === attempt?.requestId && value?.operation === attempt?.operation
  && value?.gameId === attempt?.gameId && value?.profileId === attempt?.profileId; }
function validFailure(value, attempt) {
  return base(value) && same(value, attempt) && keys(value, [...common, 'operationCompleted', 'effectsMayHaveOccurred', 'inspectBeforeRetry', 'errorCode'])
    && value.operationCompleted === false && typeof value.effectsMayHaveOccurred === 'boolean' && value.inspectBeforeRetry === value.effectsMayHaveOccurred
    && typeof value.errorCode === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value.errorCode);
}
function validCompletion(value, attempt) {
  if (!base(value) || !same(value, attempt) || !validAttempt(attempt) || value.operationCompleted !== true || value.diskDeploymentVerified !== false
    || value.verificationRequired !== VERIFICATION || Date.parse(value.at) < Date.parse(attempt.at)) return false;
  const fields = [...common, 'operationCompleted', 'diskDeploymentVerified', 'verificationRequired'];
  const a = attempt.parameters;
  if (value.operation === 'set_mods_enabled') return keys(value, [...fields, 'modIds', 'enabled', 'enabledFlagsVerified'])
    && JSON.stringify(value.modIds) === JSON.stringify(a.modIds) && value.enabled === a.enabled && value.enabledFlagsVerified === true;
  if (value.operation === 'deploy_mods') return keys(value, [...fields, 'deploymentPromiseResolved']) && value.deploymentPromiseResolved === true;
  if (value.operation === 'download_nexus') return keys(value, [...fields, 'downloadId', 'reused', 'archiveSha256Verified', 'size', 'autoInstall', 'archiveCRCVerified'])
    && id(value.downloadId) && typeof value.reused === 'boolean' && (!a.reuseOnly || value.reused) && value.archiveSha256Verified === true
    && value.size === a.size && value.autoInstall === false && value.archiveCRCVerified === false;
  return false; // Installation cannot have a successful completion in this adapter.
}
module.exports = { VERSION, VERIFICATION, validAttempt, validParameters, validCompletion, validFailure };
