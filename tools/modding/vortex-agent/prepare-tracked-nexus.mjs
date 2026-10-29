import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { createScopePolicy } = require('./tracked-nexus-policy.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(here, 'tracked-nexus-template.json')));
const scratch = path.resolve(here, '../../../local-state');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const need = (v, code) => { if (!v) throw Error(code); };
const ownerNames = ['install-settlement.cjs', 'tracked-nexus-policy.cjs', 'physical-proof.cjs'];
// This private-overlay admission helper is not reachable from the Nexus engine.
const referenceModules = Object.keys(catalog.modules).filter(n => n !== 'deferred-policy.cjs');
const scopeAlias = Buffer.from("'use strict';\nmodule.exports=require('./tracked-nexus-policy.cjs').createScopePolicy(require('./scope-pins.json'));\n");
const baseMap = [['index.js', 'index.prepared.js'], ['info.json', 'info.json'],
  ['reviewed.json', 'reviewed.json'], ['frozen.json', 'frozen.json']];
function ordinary(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try { need(!fs.lstatSync(current).isSymbolicLink(), 'TRACKED_KIT_REPARSE_PATH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) return;
  }
}
function absolute(value) {
  need(typeof value === 'string' && path.isAbsolute(value), 'ABSOLUTE_TRACKED_KIT_PATH_REQUIRED');
  const result = path.resolve(value); ordinary(result);
  need(!/[\\/]vortex[\\/]plugins(?:[\\/]|$)/i.test(result), 'ACTIVE_TRACKED_KIT_PATH_REFUSED');
  return result;
}
function read(file, maxBytes = 1024 * 1024) {
  ordinary(file); const stat = fs.lstatSync(file);
  need(stat.isFile() && stat.size <= maxBytes, 'ORDINARY_BOUNDED_KIT_INPUT_REQUIRED');
  return fs.readFileSync(file);
}
function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !path.isAbsolute(a) || !path.isAbsolute(b)) return false;
  const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return normalize(a) === normalize(b);
}
function once(source, old, replacement) {
  need(source.split(old).length === 2, 'UNSUPPORTED_TRACKED_TEMPLATE');
  return source.replace(old, replacement);
}

export function adaptTrackedIndex(input) {
  let text = input.toString('utf8');
  text = once(text, "let originalProfiles,originalDownloads,transferStart", "let settlementSequence=0;\nlet originalProfiles,originalDownloads,transferStart");
  const physical = /function physical\(file\)\{[^\r\n]+\}/g;
  need([...text.matchAll(physical)].length === 1 && text.includes('physicalCache.get(file)'), 'UNSUPPORTED_TRACKED_TEMPLATE');
  text = text.replace(physical, "const physical=require('./physical-proof.cjs').createPhysicalReader({fs,hash,cache:physicalCache});");
  text = once(text, 'now:()=>Date.now(),pkg,expectedSize,timeoutMs:30000,quietMs:3000',
    "now:()=>Date.now(),pkg,expectedSize,expectedDownloadId:downloadId,expectedType:pkg.expectedType,record:event=>save(pkg.key+'-settlement-'+(++settlementSequence),event),timeoutMs:30000,quietMs:3000");
  text = once(text, "return {record:current,flags:state.persistent.profiles[baseline.health.profileId].modState||{}};",
    "return {record:{...current,id},flags:state.persistent.profiles[baseline.health.profileId].modState||{}};");
  text = once(text, "m?.state==='installed'&&m.archiveId===downloadId&&m.installationPath===pkg.expectedModId",
    "m?.state==='installed'&&(m.id===undefined||m.id===pkg.expectedModId)&&m.archiveId===downloadId&&m.installationPath===pkg.expectedModId&&m.type===pkg.expectedType");
  text = text.replace('exact three final-cutoff official tracked updates', 'exact reviewed bounded official tracked updates')
    .replaceAll('ALL2_NATIVE_SIMULATION_MAPPING_DIFFERS_NO_INSTALL', 'ALL_BATCH_NATIVE_SIMULATION_MAPPING_DIFFERS_NO_INSTALL')
    .replaceAll('all2-simulations-accepted', 'all-batch-simulations-accepted');
  return Buffer.from(text);
}

export function scopeFromHeld(plan) {
  need(plan && plan.activationApproved === false && plan.activationHold === true
    && plan.allActivationHold === true && plan.freshActualBaselineBound === false
    && plan.noEffects === true && plan.materializationPermitted === false
    && typeof plan.ownStableCPIncluded === 'boolean'
    && ['health', 'pluginPath', 'baselineFile', 'baselineSHA256', 'rootApproval'].every(k => plan[k] === null), 'UNBOUND_NEXUS_PLAN_REQUIRED');
  const rows = plan.reviewedPackages;
  need(Array.isArray(rows) && rows.length > 0 && rows.length <= 4, 'BOUNDED_NEXUS_SCOPE_REQUIRED');
  const own = rows.some(p => p?.nexusModId === 35196);
  need(plan.ownStableCPIncluded === own && (!own || rows.length === 1
    && /^[a-f0-9]{40}$/.test(plan.ownSourceCommit || '')
    && /^[a-f0-9]{64}$/.test(plan.ownSourceProofSHA256 || '')), 'SEPARATE_PUBLISHED_OWN_BATCH_REQUIRED');
  const pins = {};
  for (const row of rows) {
    need(row && Number.isSafeInteger(row.nexusModId) && row.nexusModId > 0
      && !Object.hasOwn(pins, row.nexusModId)
      && typeof row.sourceVersion === 'string' && row.sourceVersion.trim().length > 0
      && row.sourceVersion.length <= 200 && !/[\x00-\x1f\x7f]/.test(row.sourceVersion)
      && ['requiredDownloadId', 'nativeTargetId', 'nativePreviousId', 'expectedEnabled', 'payloadProjection']
        .every(k => row[k] === null), 'EXACT_UNBOUND_NEXUS_ITEM_REQUIRED');
    pins[row.nexusModId] = { nexusFileId: row.nexusFileId, size: row.officialBytes,
      sha256: row.officialSHA256, version: row.sourceVersion };
  }
  createScopePolicy(pins);
  return pins;
}

function runtimeFiles(contents) {
  return [...contents.keys()].filter(n => n.endsWith('.cjs') || n === 'scope-pins.json');
}
function ownerContent() {
  return new Map([...ownerNames.map(n => [n, read(path.join(here, n))]),
    ['settlement.cjs', read(path.join(here, 'tracked-nexus-settlement.cjs'))],
    ['preference-policy.cjs', read(path.join(here, 'tracked-preferences.cjs'))], ['scope-policy.cjs', scopeAlias]]);
}
export function prepareTracked({ reference, planFile, planSha256, output, apply = false }) {
  need(typeof apply === 'boolean', 'INVALID_TRACKED_PREPARATION_ARGUMENTS');
  reference = absolute(reference); planFile = absolute(planFile); output = absolute(output);
  need(inside(scratch, output) && output !== scratch && !inside(reference, output), 'TRACKED_OUTPUT_ROOT_REFUSED');
  need(!fs.existsSync(output), 'TRACKED_OUTPUT_EXISTS');
  need(!fs.readdirSync(reference).some(n => /^(?:reviewed\.json|attempt\.json|failed\.json|completed\.json|HOST-)/.test(n)), 'ATTEMPTED_TRACKED_REFERENCE_REFUSED');
  const planBytes = read(planFile);
  need(/^[a-f0-9]{64}$/.test(planSha256 || '') && sha(planBytes) === planSha256, 'TRACKED_PLAN_PIN_MISMATCH');
  const plan = JSON.parse(planBytes), pins = scopeFromHeld(plan), contents = new Map();
  const original = read(path.join(reference, catalog.entry));
  need(sha(original) === catalog.entrySHA256, 'TRACKED_REFERENCE_ENTRY_DRIFT');
  for (const name of referenceModules) {
    const hash = catalog.modules[name];
    const bytes = read(path.join(reference, name));
    need(sha(bytes) === hash, 'TRACKED_REFERENCE_MODULE_DRIFT'); contents.set(name, bytes);
  }
  contents.set('reference-index.js', original);
  contents.set('index.prepared.js', adaptTrackedIndex(original));
  for (const [name, bytes] of ownerContent()) contents.set(name, bytes);
  contents.set('scope-pins.json', Buffer.from(JSON.stringify(pins, null, 2) + '\n'));
  const runtime = runtimeFiles(contents);
  const held = { purpose: 'tracked-nexus-native-install/1', activationApproved: false, activationHold: true, allActivationHold: true,
    freshActualBaselineBound: false, noEffects: true, materializationPermitted: false,
    control: output, pluginPath: null, health: null, baselineFile: null, baselineSHA256: null,
    ownStableCPIncluded: plan.ownStableCPIncluded, ownSourceCommit: plan.ownSourceCommit ?? null,
    ownSourceProofSHA256: plan.ownSourceProofSHA256 ?? null, sourcePlanSHA256: planSha256,
    identityModulePins: Object.fromEntries(runtime.map(n => [n, sha(contents.get(n))])),
    helperSHA256: sha(contents.get('index.prepared.js')),
    reviewedPackages: plan.reviewedPackages.map(p => ({ key: `${p.nexusModId}-${p.nexusFileId}`,
      nexusModId: p.nexusModId, nexusFileId: p.nexusFileId, bytes: p.officialBytes, sha256: p.officialSHA256,
      version: p.sourceVersion, acceptedVersions: [p.sourceVersion], requiredDownloadId: null,
      expectedModId: null, expectedPreviousModId: null, expectedPreviousCaptured: false,
      expectedType: null, expectedEnabled: null, oldEnabledModIds: null, payload: null })),
  };
  held.modulePins = { ...held.identityModulePins };
  contents.set('reviewed.prepared.json', Buffer.from(JSON.stringify(held, null, 2) + '\n'));
  contents.set('COPY-MAP.prepared.json', Buffer.from(JSON.stringify(
    [...baseMap, ...runtime.map(n => [n, n])].map(([destination, source]) => ({ source, destination,
      sha256: contents.has(source) ? sha(contents.get(source)) : null })), null, 2) + '\n'));
  const contract = { schema: 'tracked-nexus-kit/1', referenceSHA256: catalog.entrySHA256, planSHA256: planSha256,
    ownStableCPIncluded: plan.ownStableCPIncluded, ownSourceCommit: plan.ownSourceCommit ?? null,
    ownSourceProofSHA256: plan.ownSourceProofSHA256 ?? null,
    scopePins: pins, runtime, files: Object.fromEntries([...contents].map(([n, b]) => [n, sha(b)])),
    activationGranted: false, nativeEffects: false };
  contents.set('TRACKED-NEXUS-KIT.json', Buffer.from(JSON.stringify(contract, null, 2) + '\n'));
  if (apply) {
    ordinary(output); fs.mkdirSync(output);
    for (const [name, bytes] of contents) {
      const file = path.join(output, name); ordinary(file); fs.writeFileSync(file, bytes, { flag: 'wx' });
    }
  }
  return { status: apply ? 'tracked-kit-held' : 'plan', output, files: contents.size,
    packages: plan.reviewedPackages.length, runtime: runtime.length, activationGranted: false, nativeEffects: false };
}

export function verifyTracked(value, { materialization = false } = {}) {
  const dir = absolute(value), contract = JSON.parse(read(path.join(dir, 'TRACKED-NEXUS-KIT.json')));
  need(contract.schema === 'tracked-nexus-kit/1' && contract.activationGranted === false
    && contract.nativeEffects === false && contract.referenceSHA256 === catalog.entrySHA256
    && contract.files && Object.keys(contract.files).length <= 64 && Array.isArray(contract.runtime), 'INVALID_TRACKED_KIT');
  const owners = ownerContent();
  const requiredRuntime = [...new Set([...referenceModules, ...owners.keys(), 'scope-pins.json'])].sort();
  need(JSON.stringify([...contract.runtime].sort()) === JSON.stringify(requiredRuntime), 'TRACKED_RUNTIME_SET_DIFFERS');
  const required = [...requiredRuntime, 'reference-index.js', 'index.prepared.js', 'reviewed.prepared.json', 'COPY-MAP.prepared.json'].sort();
  need(JSON.stringify(Object.keys(contract.files).sort()) === JSON.stringify(required), 'TRACKED_FILE_SET_DIFFERS');
  for (const [name, pin] of Object.entries(contract.files)) {
    need(/^[a-zA-Z0-9.-]+$/.test(name) && /^[a-f0-9]{64}$/.test(pin), 'INVALID_TRACKED_KIT_PIN');
    const bytes = read(path.join(dir, name));
    if (name !== 'reviewed.prepared.json') need(sha(bytes) === pin, 'TRACKED_KIT_DRIFT');
    if (owners.has(name)) need(pin === sha(owners.get(name)), 'STALE_TRACKED_KIT');
    else if (Object.hasOwn(catalog.modules, name)) need(pin === catalog.modules[name], 'TRACKED_REFERENCE_MODULE_DRIFT');
  }
  const original = read(path.join(dir, 'reference-index.js'));
  need(sha(original) === catalog.entrySHA256
    && sha(adaptTrackedIndex(original)) === contract.files['index.prepared.js'], 'TRACKED_ENTRY_CONTRACT_DIFFERS');
  const pins = JSON.parse(read(path.join(dir, 'scope-pins.json')));
  need(JSON.stringify(pins) === JSON.stringify(contract.scopePins), 'TRACKED_SCOPE_DIFFERS');
  const policy = createScopePolicy(pins);
  const cfg = JSON.parse(read(path.join(dir, 'reviewed.prepared.json')));
  need(cfg.purpose === 'tracked-nexus-native-install/1' && cfg.activationApproved === false && cfg.activationHold === true && cfg.allActivationHold === true
    && cfg.noEffects === true && cfg.ownStableCPIncluded === contract.ownStableCPIncluded
    && cfg.ownSourceCommit === contract.ownSourceCommit && cfg.ownSourceProofSHA256 === contract.ownSourceProofSHA256,
    'TRACKED_HOLD_REQUIRED');
  need(cfg.helperSHA256 === contract.files['index.prepared.js'] && cfg.identityModulePins
    && JSON.stringify(Object.keys(cfg.identityModulePins).sort()) === JSON.stringify(requiredRuntime)
    && requiredRuntime.every(n => cfg.identityModulePins[n] === contract.files[n]), 'TRACKED_BINDING_PINS_DIFFER');
  need(cfg.sourcePlanSHA256 === contract.planSHA256 && cfg.modulePins
    && JSON.stringify(Object.keys(cfg.modulePins).sort()) === JSON.stringify(requiredRuntime)
    && requiredRuntime.every(n => cfg.modulePins[n] === contract.files[n]), 'TRACKED_BINDING_PINS_DIFFER');
  need(Array.isArray(cfg.reviewedPackages) && cfg.reviewedPackages.length === Object.keys(pins).length
    && new Set(cfg.reviewedPackages.map(p => p.nexusModId)).size === cfg.reviewedPackages.length
    && cfg.reviewedPackages.every(p => { const x = pins[p.nexusModId]; return x && p.nexusFileId === x.nexusFileId
      && p.bytes === x.size && p.sha256 === x.sha256 && p.version === x.version; }), 'TRACKED_BINDING_SCOPE_DIFFERS');
  const requiredConfigKeys = [...new Set([...adaptTrackedIndex(original).toString().matchAll(/cfg\.([A-Za-z0-9_]+)/g)].map(m => m[1]))];
  const missingBindings = requiredConfigKeys.filter(k => cfg[k] === undefined || cfg[k] === null);
  if (cfg.health === undefined || cfg.health === null) missingBindings.push('health');
  const packageKeys = ['requiredDownloadId', 'expectedModId', 'expectedType', 'expectedEnabled',
    'oldEnabledModIds', 'md5', 'payload', 'nativeSelectorInputs', 'expectedNativeRulesDigest',
    'expectedNativeOverridesDigest', 'nativeSelectionEvidenceSHA256', 'actualInstallationProjectionSHA256'];
  const missingPackageBindings = cfg.reviewedPackages.map(p => ({ key: p.key,
    fields: [...packageKeys.filter(k => p[k] === undefined || p[k] === null),
      ...['expectedPreviousCaptured', 'crcVerified', 'sameIdCollisionChecked', 'expectedTargetAbsent',
        'previousStagePreservationReviewed', 'activePatchedOwnerProtectionReviewed'].filter(k => p[k] !== true)] }));
  const expected = new Map([...baseMap, ...requiredRuntime.map(n => [n, n])]);
  function checkMap(rows, allowUnbound) {
    need(Array.isArray(rows) && rows.length === expected.size, 'TRACKED_COPY_MAP_INCOMPLETE');
    const seen = new Set();
    for (const row of rows) {
      need(row && !seen.has(row.destination) && expected.get(row.destination) === row.source, 'TRACKED_COPY_MAP_DIFFERS');
      seen.add(row.destination);
      if (row.sha256 === null && (allowUnbound && ['info.json', 'reviewed.json', 'frozen.json'].includes(row.source)
        || ['reviewed.json', 'frozen.json'].includes(row.source) && !fs.existsSync(path.join(dir, row.source)))) continue;
      need(sha(read(path.join(dir, row.source))) === row.sha256, 'TRACKED_COPY_PIN_DIFFERS');
    }
  }
  checkMap(JSON.parse(read(path.join(dir, 'COPY-MAP.prepared.json'))), true);
  if (materialization) {
    policy.completeScope(cfg.reviewedPackages);
    need(missingBindings.length === 0 && cfg.freshRootDiskBaselineFinalized === true
      && cfg.freshActualBaselineBound === true && cfg.health?.gameId === 'cyberpunk2077'
      && typeof cfg.health.profileId === 'string' && cfg.health.profileId.length > 0
      && ['gamePath', 'stagingPath', 'downloadPath'].every(k => path.isAbsolute(cfg.health[k] || '')
        && /^\d+:\d+$/.test(cfg.health.filesystemIds?.[k] || ''))
      && sha(read(absolute(cfg.baselineFile), 64 * 1024 * 1024)) === cfg.baselineSHA256, 'FRESH_TRACKED_BASELINE_REQUIRED');
    need(samePath(cfg.control, dir) && samePath(cfg.processGuard, path.join(here, 'guard.cjs'))
      && cfg.processGuardSHA256 === sha(read(path.join(here, 'guard.cjs'))), 'TRACKED_PROCESS_GUARD_DIFFERS');
    const ready = JSON.parse(read(path.join(dir, 'READY.prepared.json')));
    need(samePath(ready.control, dir) && samePath(ready.pluginPath, cfg.pluginPath) && ready.purpose === cfg.purpose
      && ready.preparedOnly === true && ready.activationApproved === false
      && samePath(ready.host?.path, path.join(dir, 'host.prepared.ps1'))
      && ready.host.sha256 === sha(read(ready.host.path)), 'TRACKED_HOST_BINDING_DIFFERS');
    need(Array.isArray(ready.filesToCopy) && ready.filesToCopy.length === expected.size
      && ready.runtimeModules === requiredRuntime.length, 'TRACKED_COPY_MAP_INCOMPLETE');
    checkMap(ready.filesToCopy, false);
  }
  return { status: 'tracked-code-contract-verified', runtime: requiredRuntime.length,
    packages: cfg.reviewedPackages.length, materializationMappingVerified: materialization,
    missingBindings, missingPackageBindings, installReady: false, liveFreshnessVerified: false,
    activationGranted: false, nativeEffects: false };
}

function captureCode(entry, body) {
  let index = entry.toString('utf8').replaceAll('\r\n', '\n');
  index = once(index, "'read-only-morning-native-capture-20261029-v3/1'", "'tracked-nexus-read-capture/1'");
  index = once(index, "   save('CP-SETTLEMENT-DIAGNOSTIC',require('./own-diagnostic.cjs').project(context.api.getState(),cfg.health.profileId));\n", '');
  let code = body.toString('utf8').replaceAll('\r\n', '\n');
  const start = code.indexOf('const timestampModule='), end = code.indexOf("const {admission}=", start);
  need(start >= 0 && end > start, 'UNSUPPORTED_TRACKED_CAPTURE_TEMPLATE');
  code = code.slice(0, start) + "const toolTimestamps=require('./tool-timestamps.cjs');\n" + code.slice(end);
  code = once(code, "installBaseline:{schema:'hardening-native-install-baseline/1',health:h,packages,",
    "installBaseline:{schema:'hardening-native-install-baseline/1',health:h,packages,profilesDigest:initial.expectedNativeProfilesSHA256,");
  return { index: Buffer.from(index), body: Buffer.from(code) };
}
const captureScopeAlias = Buffer.from("'use strict';\nmodule.exports={validate:require('./tracked-nexus-policy.cjs').createScopePolicy(require('./scope-pins.json')).captureScope};\n");
export function prepareTrackedCapture({ reference, installKit, output, apply = false }) {
  need(typeof apply === 'boolean', 'INVALID_TRACKED_PREPARATION_ARGUMENTS');
  reference = absolute(reference); installKit = absolute(installKit); output = absolute(output);
  need(inside(scratch, output) && output !== scratch && !inside(reference, output)
    && !inside(installKit, output), 'TRACKED_OUTPUT_ROOT_REFUSED');
  need(!fs.existsSync(output), 'TRACKED_OUTPUT_EXISTS');
  // A completed historical capture is read only as a pinned source reference;
  // no controls, baselines, receipts or approvals are copied from it.
  verifyTracked(installKit);
  const entry = read(path.join(reference, 'index.prepared.js')), body = read(path.join(reference, 'capture.cjs'));
  need(sha(entry) === catalog.capture.entrySHA256 && sha(body) === catalog.capture.bodySHA256,
    'TRACKED_CAPTURE_REFERENCE_DRIFT');
  const adapted = captureCode(entry, body), contents = new Map();
  for (const [name, pin] of Object.entries(catalog.capture.modules)) {
    const bytes = read(path.join(reference, name)); need(sha(bytes) === pin, 'TRACKED_CAPTURE_REFERENCE_DRIFT');
    contents.set(name, bytes);
  }
  for (const name of ['tracked-nexus-policy.cjs', 'install-settlement.cjs']) contents.set(name, read(path.join(here, name)));
  contents.set('tool-timestamps.cjs', read(path.join(installKit, 'tool-timestamps.cjs')));
  contents.set('scope-pins.json', read(path.join(installKit, 'scope-pins.json')));
  contents.set('scope.cjs', captureScopeAlias);
  contents.set('capture.cjs', adapted.body); contents.set('index.prepared.js', adapted.index);
  contents.set('reference-index.js', entry); contents.set('reference-capture.cjs', body);
  const source = JSON.parse(read(path.join(installKit, 'reviewed.prepared.json')));
  const runtime = [...contents.keys()].filter(n => (n.endsWith('.cjs') && n !== 'reference-capture.cjs') || n === 'scope-pins.json');
  const cfg = { purpose: 'tracked-nexus-read-capture/1', control: output, pluginPath: null,
    activationApproved: false, allActivationHold: true, noEffects: true, freshRootDiskBaselineFinalized: false,
    health: null, expectedHostVersion: null, guard: null, sourcePins: null, diskBaseline: null,
    manifestPath: null, admissionFile: null, admissionSHA256: null, nativeTempPath: null,
    helperSHA256: sha(adapted.index), modulePins: Object.fromEntries(runtime.map(n => [n, sha(contents.get(n))])),
    packages: source.reviewedPackages.map(p => ({ key: p.key, nexusModId: p.nexusModId, nexusFileId: p.nexusFileId,
      bytes: p.bytes, sha256: p.sha256, version: p.version, officialSourceVersion: p.version, acceptedVersions: [p.version],
      requiredDownloadId: null, expectedModId: null, archive: null, md5: null, crcVerified: false,
      payloadProjectionPending: true, notInstallerReadyUntilNativeProjection: true })) };
  contents.set('reviewed.prepared.json', Buffer.from(JSON.stringify(cfg, null, 2) + '\n'));
  const maps = [['index.js', 'index.prepared.js'], ['info.json', 'info.json'], ['reviewed.json', 'reviewed.json'], ...runtime.map(n => [n, n])];
  contents.set('COPY-MAP.prepared.json', Buffer.from(JSON.stringify(maps.map(([destination, source]) => ({ source, destination,
    sha256: contents.has(source) ? sha(contents.get(source)) : null })), null, 2) + '\n'));
  const contract = { schema: 'tracked-nexus-capture-kit/1', runtime,
    installKitEntrySHA256: source.helperSHA256, scopePins: JSON.parse(contents.get('scope-pins.json')),
    files: Object.fromEntries([...contents].map(([n, b]) => [n, sha(b)])), activationGranted: false, nativeEffects: false };
  contents.set('TRACKED-CAPTURE-KIT.json', Buffer.from(JSON.stringify(contract, null, 2) + '\n'));
  if (apply) {
    ordinary(output); fs.mkdirSync(output);
    for (const [name, bytes] of contents) { const file = path.join(output, name); ordinary(file); fs.writeFileSync(file, bytes, { flag: 'wx' }); }
  }
  return { status: apply ? 'tracked-capture-held' : 'plan', output, packages: cfg.packages.length,
    runtime: runtime.length, files: contents.size, activationGranted: false, nativeEffects: false };
}

export function verifyTrackedCapture(value, { materialization = false } = {}) {
  const dir = absolute(value), contract = JSON.parse(read(path.join(dir, 'TRACKED-CAPTURE-KIT.json')));
  const runtime = [...Object.keys(catalog.capture.modules), 'tracked-nexus-policy.cjs', 'install-settlement.cjs',
    'tool-timestamps.cjs', 'scope-pins.json', 'scope.cjs', 'capture.cjs'].sort();
  const required = [...runtime, 'reference-index.js', 'reference-capture.cjs', 'index.prepared.js', 'reviewed.prepared.json', 'COPY-MAP.prepared.json'].sort();
  need(contract.schema === 'tracked-nexus-capture-kit/1' && contract.activationGranted === false && contract.nativeEffects === false
    && JSON.stringify([...contract.runtime].sort()) === JSON.stringify(runtime)
    && JSON.stringify(Object.keys(contract.files).sort()) === JSON.stringify(required), 'INVALID_TRACKED_CAPTURE_KIT');
  for (const [name, pin] of Object.entries(contract.files)) {
    need(/^[a-zA-Z0-9.-]+$/.test(name) && /^[a-f0-9]{64}$/.test(pin), 'INVALID_TRACKED_CAPTURE_PIN');
    const bytes = read(path.join(dir, name));
    if (name !== 'reviewed.prepared.json') need(sha(bytes) === pin, 'TRACKED_CAPTURE_DRIFT');
    if (Object.hasOwn(catalog.capture.modules, name)) need(pin === catalog.capture.modules[name], 'TRACKED_CAPTURE_REFERENCE_DRIFT');
  }
  for (const name of ['tracked-nexus-policy.cjs', 'install-settlement.cjs'])
    need(contract.files[name] === sha(read(path.join(here, name))), 'STALE_TRACKED_CAPTURE_KIT');
  need(contract.files['tool-timestamps.cjs'] === catalog.modules['tool-timestamps.cjs']
    && contract.files['scope.cjs'] === sha(captureScopeAlias), 'TRACKED_CAPTURE_POLICY_DIFFERS');
  const entry = read(path.join(dir, 'reference-index.js')), body = read(path.join(dir, 'reference-capture.cjs'));
  need(sha(entry) === catalog.capture.entrySHA256 && sha(body) === catalog.capture.bodySHA256, 'TRACKED_CAPTURE_REFERENCE_DRIFT');
  const code = captureCode(entry, body);
  need(sha(code.index) === contract.files['index.prepared.js'] && sha(code.body) === contract.files['capture.cjs'], 'TRACKED_CAPTURE_ENTRY_DIFFERS');
  const pins = JSON.parse(read(path.join(dir, 'scope-pins.json'))), policy = createScopePolicy(pins);
  need(JSON.stringify(pins) === JSON.stringify(contract.scopePins), 'TRACKED_CAPTURE_SCOPE_DIFFERS');
  const cfg = JSON.parse(read(path.join(dir, 'reviewed.prepared.json')));
  need(cfg.activationApproved === false && cfg.allActivationHold === true && cfg.noEffects === true
    && cfg.purpose === 'tracked-nexus-read-capture/1' && cfg.helperSHA256 === contract.files['index.prepared.js']
    && cfg.modulePins && JSON.stringify(Object.keys(cfg.modulePins).sort()) === JSON.stringify(runtime)
    && runtime.every(n => cfg.modulePins[n] === contract.files[n]), 'TRACKED_CAPTURE_BINDING_DIFFERS');
  need(Array.isArray(cfg.packages) && cfg.packages.length === Object.keys(pins).length
    && new Set(cfg.packages.map(p => p.nexusModId)).size === cfg.packages.length
    && cfg.packages.every(p => { const x = pins[p.nexusModId]; return x && p.nexusFileId === x.nexusFileId
      && p.bytes === x.size && p.sha256 === x.sha256 && p.version === x.version; }), 'TRACKED_CAPTURE_SCOPE_DIFFERS');
  const keys = ['health', 'expectedHostVersion', 'guard', 'sourcePins', 'diskBaseline', 'manifestPath', 'admissionFile', 'admissionSHA256', 'nativeTempPath', 'pluginPath'];
  const missingBindings = keys.filter(k => cfg[k] === null || cfg[k] === undefined);
  const missingPackageBindings = cfg.packages.map(p => ({ key: p.key,
    fields: [...['requiredDownloadId', 'expectedModId', 'archive', 'md5'].filter(k => p[k] === undefined || p[k] === null),
      ...(p.crcVerified === true ? [] : ['crcVerified'])] }));
  const expected = new Map([['index.js', 'index.prepared.js'], ['info.json', 'info.json'], ['reviewed.json', 'reviewed.json'], ...runtime.map(n => [n, n])]);
  const checkMap = (rows, bound) => {
    need(Array.isArray(rows) && rows.length === expected.size, 'TRACKED_CAPTURE_COPY_MAP_INCOMPLETE');
    const seen = new Set();
    for (const row of rows) {
      need(row && !seen.has(row.destination) && expected.get(row.destination) === row.source, 'TRACKED_CAPTURE_COPY_MAP_DIFFERS'); seen.add(row.destination);
      if (row.sha256 === null && (!bound && row.source === 'info.json'
        || row.source === 'reviewed.json' && !fs.existsSync(path.join(dir, row.source)))) continue;
      need(sha(read(path.join(dir, row.source))) === row.sha256, 'TRACKED_CAPTURE_COPY_PIN_DIFFERS');
    }
  };
  checkMap(JSON.parse(read(path.join(dir, 'COPY-MAP.prepared.json'))), false);
  if (materialization) {
    policy.captureScope(cfg.packages);
    need(missingBindings.length === 0 && cfg.freshRootDiskBaselineFinalized === true
      && cfg.health?.gameId === 'cyberpunk2077' && cfg.health.profileId === 'ptndev1016'
      && cfg.diskBaseline && sha(read(absolute(cfg.diskBaseline.path), 64 * 1024 * 1024)) === cfg.diskBaseline.sha256
      && sha(read(absolute(cfg.admissionFile))) === cfg.admissionSHA256, 'FRESH_TRACKED_CAPTURE_BINDING_REQUIRED');
    need(samePath(cfg.control, dir) && samePath(cfg.guard, path.join(here, 'guard.cjs'))
      && cfg.sourcePins?.[cfg.guard] === sha(read(path.join(here, 'guard.cjs'))), 'TRACKED_CAPTURE_PROCESS_GUARD_DIFFERS');
    const ready = JSON.parse(read(path.join(dir, 'READY.prepared.json')));
    need(samePath(ready.control, dir) && samePath(ready.pluginPath, cfg.pluginPath) && ready.purpose === cfg.purpose
      && ready.preparedOnly === true && ready.activationApproved === false
      && samePath(ready.host?.path, path.join(dir, 'host.prepared.ps1'))
      && ready.host.sha256 === sha(read(ready.host.path)), 'TRACKED_CAPTURE_HOST_BINDING_DIFFERS');
    need(ready.runtimeModules === runtime.length, 'TRACKED_CAPTURE_COPY_MAP_INCOMPLETE'); checkMap(ready.filesToCopy, true);
  }
  return { status: 'tracked-capture-code-verified', packages: cfg.packages.length, runtime: runtime.length,
    missingBindings, missingPackageBindings, materializationMappingVerified: materialization,
    liveFreshnessVerified: false, activationGranted: false, nativeEffects: false };
}

export function main(args = process.argv.slice(2)) {
  if (args[0] === 'capture-verify' && (args.length === 2 || args.length === 3 && args[2] === '--materialization'))
    return verifyTrackedCapture(args[1], { materialization: args.length === 3 });
  if (args[0] === 'verify' && (args.length === 2 || args.length === 3 && args[2] === '--materialization'))
    return verifyTracked(args[1], { materialization: args.length === 3 });
  const capture = args[0] === 'capture'; if (capture) args = args.slice(1);
  const opts = {}, keys = capture ? { '--reference': 'reference', '--output': 'output', '--install-kit': 'installKit' }
    : { '--reference': 'reference', '--plan': 'planFile', '--plan-sha256': 'planSha256', '--output': 'output' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && opts.apply === undefined) opts.apply = true;
    else { const key = keys[args[i]]; need(key && opts[key] === undefined && args[i + 1], 'INVALID_TRACKED_PREPARATION_ARGUMENTS'); opts[key] = args[++i]; }
  }
  return capture ? prepareTrackedCapture(opts) : prepareTracked(opts);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(main()) + '\n'); }
  catch (error) { process.stderr.write((/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'TRACKED_PREPARATION_FAILED') + '\n'); process.exitCode = 1; }
}
