import crypto from 'node:crypto';
import { inspectOwnZip } from './own-helper-binder.mjs';

export const LIMITS = Object.freeze({ archiveBytes: 64 * 1024 * 1024, mods: 10000, downloads: 10000, profiles: 2000,
  stagingNames: 10000, rules: 50000, nodes: 200000, snapshotBytes: 8 * 1024 * 1024 });
export const CONTRACT = Object.freeze({ id: 'vortex291-own-local/1', version: '2.9.1',
  appAsarSHA256: 'ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a',
  extractorContractSHA256: '7d7da582e58f7af2ae492421617cdd168a4476b524287848b2805e7c201a2e93',
  sourcePins: Object.freeze({
    '575': '577d56a8728052069f850face9bb57437dbf2886bd41409fe6a66cfefc08ed33',
    '585': 'c45773ac110808acb3a3bf79bdcb1b3cab1ef498c6ddfdf7c29f11abb60733eb',
    '588': 'd895c7614a692242e1921fa0d9fba1a52743bcd9aed5b1bcac9a539d393b2400',
    '592': '24c237ab98a442ff1091e5e85c043b4ec56a42b96185dbee7727ad645b762a05',
    '622': '8c6ecba83fb524c7bb0a38f7fb9be8f61eb065fabe14e6f203c42abc096f6f50',
    '628': '4993742e685aecf51fecd04805f17d1ec821adc06f300243dc9b12ed8eab6925',
    '643': 'c25f9c1c5468920c75dc9681da2530865d0a94f9d0863f2060a0eba0b8a56a52',
    '3': '81de583c8f3252edc6c500f5524447c450a47b5700eab71503f65eb46fc5bb6f',
    '984': 'c4afbd9cf138639239bb9ff8f64f4785a50b3c23e5e6885eed2d58617b98f85b',
  }) });
const need = (ok, code) => { if (!ok) throw Error(code); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const md5 = v => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9_. -]{1,200}$/.test(v) && v.trim() === v;
const digest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function exact(v, required, optional = []) {
  need(object(v) && required.every(k => Object.hasOwn(v, k))
    && Object.keys(v).every(k => [...required, ...optional].includes(k)), 'PREFLIGHT_FIELDS');
}
function rows(v, max) { need(Array.isArray(v) && v.length <= max, 'PREFLIGHT_LIMIT'); return v; }
function integer(v, max) { need(Number.isSafeInteger(v) && v >= 0 && v <= max, 'PREFLIGHT_FIELDS'); }
function detached(value) {
  let nodes = 0, bytes = 0;
  const spend = n => { bytes += n; need(bytes <= LIMITS.snapshotBytes, 'PREFLIGHT_LIMIT'); };
  function copy(v, depth = 0) {
    need(++nodes <= LIMITS.nodes && depth <= 12, 'PREFLIGHT_LIMIT');
    if (v === null || typeof v === 'boolean') { spend(5); return v; }
    if (typeof v === 'string') { need(v.length <= 1024, 'PREFLIGHT_LIMIT'); spend(Buffer.byteLength(JSON.stringify(v))); return v; }
    if (typeof v === 'number') { need(Number.isSafeInteger(v), 'PREFLIGHT_JSON_REQUIRED'); spend(24); return v; }
    need(v && typeof v === 'object', 'PREFLIGHT_JSON_REQUIRED');
    const array = Array.isArray(v);
    need(array ? Object.getPrototypeOf(v) === Array.prototype : [Object.prototype, null].includes(Object.getPrototypeOf(v)), 'PREFLIGHT_JSON_REQUIRED');
    const keys = Reflect.ownKeys(v);
    need(keys.length <= LIMITS.nodes, 'PREFLIGHT_LIMIT'); spend(2 + keys.length);
    if (array) need(keys.length === v.length + 1 && v.length <= LIMITS.rules, 'PREFLIGHT_JSON_REQUIRED');
    const out = array ? [] : Object.create(null);
    for (const key of array ? Array.from({ length: v.length }, (_, i) => String(i)) : keys) {
      need(typeof key === 'string' && key.length <= 1024 && !['__proto__', 'constructor', 'prototype'].includes(key), 'PREFLIGHT_JSON_REQUIRED');
      if (!array) spend(Buffer.byteLength(JSON.stringify(key)) + 1);
      const d = Object.getOwnPropertyDescriptor(v, key);
      need(d && Object.hasOwn(d, 'value') && d.enumerable, 'PREFLIGHT_JSON_REQUIRED'); out[key] = copy(d.value, depth + 1);
    }
    return out;
  }
  const result = copy(value); need(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.snapshotBytes, 'PREFLIGHT_LIMIT'); return result;
}

// Declared complete inventories and source/build projections remain assertions.
// Only archive bytes/CRC/payload are independently verified by this pure model.
export function evaluateOwnInstall(archive, input) {
  const result = { schema: 'own-install-preflight/1', modelAccepted: false, reasons: [],
    nativeAdmissionRequired: true, nativeQuickProjectionVerified: false, sourceAdmissionVerified: false, inventoryCompletenessVerified: false,
    dependencyClosureVerified: false, contextFreshnessVerified: false, effectsSupported: false, installationSupported: false, removalSupported: false, effectsAllowed: false };
  try {
    need(Buffer.isBuffer(archive) && archive.length <= LIMITS.archiveBytes, 'PREFLIGHT_ARCHIVE_REQUIRED');
    const bytes = Buffer.from(archive), s = detached(input);
    exact(s, ['host', 'context', 'declaredComplete', 'package', 'evidence', 'downloadId', 'mods', 'downloads', 'profiles', 'stagingNames', 'incomingRules', 'metadata', 'options']);
    need(s.declaredComplete === true, 'PREFLIGHT_INCOMPLETE_INVENTORY');
    exact(s.host, ['version', 'appAsarSHA256', 'sourcePins']);
    need(s.host.version === CONTRACT.version && s.host.appAsarSHA256 === CONTRACT.appAsarSHA256
      && same(s.host.sourcePins, CONTRACT.sourcePins), 'PREFLIGHT_UNSUPPORTED_HOST');
    const c = s.context;
    exact(c, ['gameId', 'profileId', 'rootIds', 'automationInstall', 'automationEnable', 'collectionActive', 'dialogs', 'tools', 'installing', 'deploying', 'interlocks']);
    need(c.gameId === 'cyberpunk2077' && id(c.profileId), 'PREFLIGHT_CONTEXT');
    exact(c.rootIds, ['game', 'staging', 'downloads']);
    need(Object.values(c.rootIds).every(v => typeof v === 'string' && /^[1-9]\d{0,24}:[1-9]\d{0,24}$/.test(v)), 'PREFLIGHT_CONTEXT');
    need(c.automationInstall === false && c.automationEnable === false && c.collectionActive === false
      && c.dialogs === 0 && c.tools === 0 && c.installing === 0 && c.deploying === false && c.interlocks === 0, 'PREFLIGHT_NATIVE_BUSY');
    exact(s.options, ['allowAutoEnable', 'profileId']);
    need(s.options.allowAutoEnable === false && s.options.profileId === c.profileId, 'PREFLIGHT_NATIVE_OPTIONS');
    const pkg = s.package;
    exact(pkg, ['fileName', 'ownerId', 'bytes', 'sha256', 'md5', 'expectedUncompressedBytes', 'payload']);
    need(typeof pkg.fileName === 'string' && /^[A-Za-z0-9_. -]{1,200}\.zip$/i.test(pkg.fileName)
      && id(pkg.ownerId) && pkg.ownerId === pkg.fileName.slice(0, -4).trim()
      && !['__proto__', 'constructor', 'prototype', '__folder_managed_by_vortex', 'fomod', 'vortex_override_instructions.json'].includes(pkg.ownerId.toLowerCase())
      && !/[. ]$/.test(pkg.ownerId) && !/\.installing$/i.test(pkg.ownerId)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(pkg.ownerId), 'PREFLIGHT_OWNER_DERIVATION');
    const proof = inspectOwnZip(bytes);
    need(pkg.bytes === proof.bytes && pkg.sha256 === proof.sha256 && pkg.md5 === proof.md5 && pkg.expectedUncompressedBytes === proof.expectedUncompressedBytes && same(pkg.payload, proof.payload), 'PREFLIGHT_ARCHIVE_PROOF');
    exact(s.evidence, ['source', 'build']); exact(s.evidence.source, ['sha256', 'payload']);
    exact(s.evidence.build, ['sha256', 'archiveSHA256', 'archiveBytes', 'expectedUncompressedBytes', 'payload']);
    need(sha(s.evidence.source.sha256) && sha(s.evidence.build.sha256)
      && s.evidence.build.archiveSHA256 === pkg.sha256 && s.evidence.build.archiveBytes === pkg.bytes && s.evidence.build.expectedUncompressedBytes === pkg.expectedUncompressedBytes
      && same(s.evidence.source.payload, pkg.payload) && same(s.evidence.build.payload, pkg.payload), 'PREFLIGHT_EVIDENCE_PROJECTION');
    const owner = pkg.ownerId.toLowerCase(), mods = rows(s.mods, LIMITS.mods), modKeys = new Map();
    for (const mod of mods) {
      exact(mod, ['gameId', 'mapId', 'record']); const r = mod.record;
      exact(r, ['id', 'state', 'rulesSHA256'], ['installationPath', 'archiveId', 'fileMD5']);
      need(id(mod.gameId) && id(mod.mapId) && r.id === mod.mapId && id(r.state) && sha(r.rulesSHA256), 'PREFLIGHT_MOD_IDENTITY');
      const key = mod.gameId + '/' + mod.mapId; need(!modKeys.has(key), 'PREFLIGHT_DUPLICATE_RECORD'); modKeys.set(key, mod);
      if (Object.hasOwn(r, 'installationPath')) need(id(r.installationPath) && !/[\\/]/.test(r.installationPath), 'PREFLIGHT_MOD_IDENTITY');
      if (Object.hasOwn(r, 'archiveId')) need(id(r.archiveId), 'PREFLIGHT_MOD_IDENTITY');
      if (Object.hasOwn(r, 'fileMD5')) need(md5(r.fileMD5), 'PREFLIGHT_MOD_IDENTITY');
      need(r.archiveId !== s.downloadId, 'PREFLIGHT_ARCHIVE_ALREADY_REFERENCED');
      need(r.fileMD5 !== pkg.md5, 'PREFLIGHT_ARCHIVE_ALREADY_INSTALLED');
      if (mod.gameId === c.gameId) for (const name of [mod.mapId, r.installationPath].filter(Boolean))
        need(![owner, owner + '.installing'].includes(name.toLowerCase()), 'PREFLIGHT_OWNER_COLLISION');
    }
    const seenDownloads = new Set(), downloads = rows(s.downloads, LIMITS.downloads);
    need(id(s.downloadId), 'PREFLIGHT_DOWNLOAD');
    for (const d of downloads) {
      exact(d, ['id', 'state', 'localPath', 'gameIds', 'bytes', 'md5'], ['installed']);
      need(id(d.id) && !seenDownloads.has(d.id) && id(d.state) && typeof d.localPath === 'string'
        && d.localPath.length > 0 && md5(d.md5), 'PREFLIGHT_DOWNLOAD'); seenDownloads.add(d.id);
      integer(d.bytes, 1024 ** 4); need(rows(d.gameIds, 20).length > 0 && d.gameIds.every(id), 'PREFLIGHT_DOWNLOAD');
      if (Object.hasOwn(d, 'installed')) {
        need(object(d.installed), 'PREFLIGHT_DOWNLOAD'); exact(d.installed, ['gameId', 'modId']);
        need(id(d.installed.gameId) && id(d.installed.modId), 'PREFLIGHT_DOWNLOAD');
      }
    }
    const download = downloads.find(d => d.id === s.downloadId);
    need(download && download.state === 'finished' && download.localPath === pkg.fileName && download.bytes === pkg.bytes
      && download.md5 === pkg.md5 && same(download.gameIds, [c.gameId]) && !Object.hasOwn(download, 'installed'), 'PREFLIGHT_DOWNLOAD');
    need(downloads.filter(d => d.md5 === pkg.md5 || d.localPath.toLowerCase() === pkg.fileName.toLowerCase()).length === 1, 'PREFLIGHT_AMBIGUOUS_DOWNLOAD');
    const profileIds = new Set(); let selected;
    for (const p of rows(s.profiles, LIMITS.profiles)) {
      exact(p, ['id', 'gameId', 'pendingRemove', 'modState']);
      need(id(p.id) && id(p.gameId) && !profileIds.has(p.id) && typeof p.pendingRemove === 'boolean' && object(p.modState), 'PREFLIGHT_PROFILE'); profileIds.add(p.id);
      for (const [modId, flag] of Object.entries(p.modState)) {
        exact(flag, ['enabled']); need(id(modId) && typeof flag.enabled === 'boolean', 'PREFLIGHT_PROFILE_UNKNOWN_FLAG');
        if (p.gameId === c.gameId) need(modId.toLowerCase() !== owner, 'PREFLIGHT_PROFILE_OWNER_REFERENCE');
      }
      if (p.id === c.profileId) selected = p;
    }
    need(selected && selected.gameId === c.gameId && !selected.pendingRemove, 'PREFLIGHT_PROFILE');
    const stageNames = new Set();
    for (const name of rows(s.stagingNames, LIMITS.stagingNames)) {
      need(id(name) && !stageNames.has(name.toLowerCase()), 'PREFLIGHT_STAGE_IDENTITY'); stageNames.add(name.toLowerCase());
      need(![owner, owner + '.installing'].includes(name.toLowerCase()), 'PREFLIGHT_STAGE_COLLISION');
    }
    const ruleOwners = new Set(); let totalRules = 0;
    for (const r of rows(s.incomingRules, LIMITS.mods)) {
      exact(r, ['gameId', 'ownerId', 'rulesSHA256', 'requiresCount', 'ignoredRequiresCount']);
      const key = r.gameId + '/' + r.ownerId, mod = modKeys.get(key);
      need(mod && !ruleOwners.has(key) && r.rulesSHA256 === mod.record.rulesSHA256, 'PREFLIGHT_RULE_INVENTORY'); ruleOwners.add(key);
      integer(r.requiresCount, LIMITS.rules); integer(r.ignoredRequiresCount, r.requiresCount); totalRules += r.requiresCount;
      need(totalRules <= LIMITS.rules, 'PREFLIGHT_LIMIT');
    }
    need(ruleOwners.size === mods.length, 'PREFLIGHT_RULE_INVENTORY');
    const m = s.metadata;
    exact(m, ['contractId', 'contractSHA256', 'quickProjectionKind', 'quickIdProjection', 'lookupRows', 'lookupQuery', 'choices', 'rules', 'previousProviderIds', 'variantIds']);
    need(object(m.quickIdProjection) && !['modId', 'fileId', 'revisionId'].some(k => Object.hasOwn(m.quickIdProjection, k)), 'PREFLIGHT_NATIVE_ID_DEFINED');
    // This is explicitly an unverified ID-only projection, not the full native
    // quick output (which also contains filename and other extractor fields).
    need(m.quickProjectionKind === 'defined-native-provider-ids/1' && same(m.quickIdProjection, {}) && m.contractId === CONTRACT.id && m.contractSHA256 === CONTRACT.extractorContractSHA256
      && same(m.lookupQuery, { gameId: c.gameId, fileMD5: pkg.md5, fileSize: pkg.bytes })
      && same(m.lookupRows, []), 'PREFLIGHT_NATIVE_METADATA');
    need(['choices', 'rules', 'previousProviderIds', 'variantIds'].every(k => same(m[k], [])), 'PREFLIGHT_NATIVE_BRANCH');
    return { ...result, modelAccepted: true, archiveBytesVerified: true,
      archiveSHA256: proof.sha256, payloadFiles: proof.payloadFiles,
      inventoryProjectionSHA256: digest(s), incomingRuleProjectionSHA256: digest(s.incomingRules) };
  } catch (error) {
    const code = typeof error?.message === 'string' && /^(?:PREFLIGHT|OWN_BINDER)_[A-Z_]+$/.test(error.message)
      ? error.message : 'PREFLIGHT_INVALID_INPUT';
    return { ...result, reasons: [code] };
  }
}
