'use strict';
const { isNativeModId, isDownloadId } = require('./install-settlement.cjs');
const path = require('node:path').win32;
const need = (value, code) => { if (!value) throw Error(code); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);

function createScopePolicy(input) {
  need(input && typeof input === 'object' && !Array.isArray(input), 'EXACT_NEXUS_SCOPE_REQUIRED');
  const pins = structuredClone(input), keys = Object.keys(pins);
  need(keys.length > 0 && keys.length <= 4, 'BOUNDED_NEXUS_SCOPE_REQUIRED');
  for (const key of keys) {
    const p = pins[key];
    need(/^[1-9]\d*$/.test(key) && positive(Number(key)) && p
      && positive(p.nexusFileId) && positive(p.size) && sha(p.sha256) && text(p.version), 'INVALID_NEXUS_SCOPE_PIN');
  }
  function target(p) {
    const x = p && pins[p.nexusModId];
    need(positive(p?.nexusModId) && x && p.nexusFileId === x.nexusFileId
      && p.bytes === x.size && p.sha256 === x.sha256 && p.version === x.version
      && p.key === `${p.nexusModId}-${p.nexusFileId}`, 'EXACT_TRACKED_NEXUS_SCOPE_REQUIRED');
    need(text(p.version) && Array.isArray(p.acceptedVersions) && p.acceptedVersions.includes(p.version)
      && p.acceptedVersions.every(v => typeof v === 'string' && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v)), 'FRESH_SELECTED_VERSION_REQUIRED');
    need(isDownloadId(p.requiredDownloadId) && isNativeModId(p.expectedModId)
      && typeof p.expectedType === 'string' && p.expectedType.length <= 100 && !/[\x00-\x1f\x7f]/.test(p.expectedType)
      && /^[a-f0-9]{32}$/.test(p.md5 || '') && p.payload && !Array.isArray(p.payload)
      && Object.keys(p.payload).length > 0 && p.crcVerified === true, 'FINAL_TRACKED_PACKAGE_PINS_REQUIRED');
    for (const [name, digest] of Object.entries(p.payload)) {
      need(typeof name === 'string' && name.length <= 1000 && !/[\\:\x00-\x1f\x7f]/.test(name)
        && !name.startsWith('/') && name.split('/').every(v => v && v !== '.' && v !== '..')
        && sha(digest), 'EXACT_PAYLOAD_MAP_REQUIRED');
    }
    need(p.expectedPreviousCaptured === true && Object.hasOwn(p, 'expectedPreviousModId')
      && (p.expectedPreviousModId === null || isNativeModId(p.expectedPreviousModId))
      && typeof p.expectedEnabled === 'boolean' && Array.isArray(p.oldEnabledModIds)
      && p.oldEnabledModIds.every(isNativeModId) && new Set(p.oldEnabledModIds).size === p.oldEnabledModIds.length
      && !p.oldEnabledModIds.includes(p.expectedModId) && p.nativeSelectorInputs
      && sha(p.expectedNativeRulesDigest) && sha(p.expectedNativeOverridesDigest), 'FRESH_NATIVE_PROVIDER_CAPTURE_REQUIRED');
    need(p.expectedEnabled ? p.expectedPreviousModId !== null && p.oldEnabledModIds.length === 1
      && p.oldEnabledModIds[0] === p.expectedPreviousModId : p.oldEnabledModIds.length === 0,
      'EXACT_NATIVE_FLAG_TRANSFER_REQUIRED');
    need(p.sameIdCollisionChecked === true && p.expectedTargetAbsent === true
      && p.previousStagePreservationReviewed === true && p.activePatchedOwnerProtectionReviewed === true
      && sha(p.nativeSelectionEvidenceSHA256) && sha(p.actualInstallationProjectionSHA256), 'REPLACEMENT_AND_MAPPING_REVIEW_REQUIRED');
  }
  function completeScope(rows) {
    need(Array.isArray(rows) && rows.length === keys.length, 'EXACT_TRACKED_NEXUS_COUNT_REQUIRED');
    const seen = new Set(), ids = new Set(), targets = new Set();
    for (const p of rows) {
      target(p);
      need(!seen.has(p.nexusModId) && !ids.has(p.requiredDownloadId)
        && !targets.has(p.expectedModId.toLowerCase()), 'DUPLICATE_TRACKED_NEXUS_TARGET');
      seen.add(p.nexusModId); ids.add(p.requiredDownloadId); targets.add(p.expectedModId.toLowerCase());
    }
    need(keys.every(key => seen.has(Number(key))), 'EXACT_TRACKED_NEXUS_SCOPE_REQUIRED');
    need(rows.every(p => !p.oldEnabledModIds.some(id => targets.has(id.toLowerCase()))
      && (p.expectedPreviousModId === null || !targets.has(p.expectedPreviousModId.toLowerCase()))), 'BATCH_TRANSFER_TARGET_COLLISION');
    return true;
  }
  function captureScope(rows) {
    need(Array.isArray(rows) && rows.length === keys.length, 'EXACT_TRACKED_CAPTURE_COUNT_REQUIRED');
    const seen = new Set(), downloads = new Set(), targets = new Set();
    for (const p of rows) {
      const x = pins[p?.nexusModId];
      need(x && !seen.has(p.nexusModId) && p.nexusFileId === x.nexusFileId
        && p.bytes === x.size && p.sha256 === x.sha256 && p.version === x.version
        && p.key === `${p.nexusModId}-${p.nexusFileId}` && isDownloadId(p.requiredDownloadId)
        && isNativeModId(p.expectedModId) && typeof p.archive === 'string' && p.archive.length <= 4096
        && !/[\x00-\x1f\x7f]/.test(p.archive) && path.isAbsolute(p.archive) && p.crcVerified === true
        && /^[a-f0-9]{32}$/.test(p.md5 || ''), 'EXACT_TRACKED_CAPTURE_INPUT_REQUIRED');
      need(!downloads.has(p.requiredDownloadId) && !targets.has(p.expectedModId.toLowerCase()), 'DUPLICATE_TRACKED_CAPTURE_TARGET');
      seen.add(p.nexusModId); downloads.add(p.requiredDownloadId); targets.add(p.expectedModId.toLowerCase());
    }
    need(keys.every(k => seen.has(Number(k))), 'EXACT_TRACKED_CAPTURE_INPUT_REQUIRED');
    return true;
  }
  return { target, completeScope, captureScope };
}
module.exports = { createScopePolicy };
