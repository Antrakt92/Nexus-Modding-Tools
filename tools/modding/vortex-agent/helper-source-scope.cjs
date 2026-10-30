'use strict';
const path = require('node:path');
const core = require('./file-proof-worker.cjs');
const need = (ok, code) => {if (!ok) throw Error(code);};
const keys = value => value && typeof value === 'object' ? Object.keys(value) : [];
function canonical(value) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 1024 && path.isAbsolute(value)
    && !/[\x00-\x1f\x7f]/.test(value) && !value.split(/[\\/]/).some(part => part === '.' || part === '..'),
  'FILE_PROOF_SCOPE_INVALID_PATH');
  if (process.platform === 'win32') {
    need(/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(value)
      && !/[<>"|?*]/.test(value) && !value.slice(2).includes(':'), 'FILE_PROOF_SCOPE_INVALID_PATH');
    const components = value.replace(/^[a-z]:/i, '').split(/[\\/]/).filter(Boolean);
    need(components.every(part => !/[. ]$/.test(part)
      && !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part)),
    'FILE_PROOF_SCOPE_INVALID_PATH');
    const normalized = path.win32.normalize(value).toLowerCase();
    return normalized.length === path.win32.parse(normalized).root.length ? normalized : normalized.replace(/[\\/]+$/, '');
  }
  return path.normalize(value).replace(/\/+$/, '') || '/';
}
// Membership validation only: descriptor identities are claims until the coordinator
// observes and proves them. The fixed generator supplies exact mutable output paths;
// immutable baselines and historical evidence are not excluded automatically.
function validateSourceScope(value) {
  need(core.exact(value, ['sourcePins', 'sourceProof', 'excludedPaths']), 'FILE_PROOF_SCOPE_INVALID_OPTIONS');
  const names = keys(value.sourcePins);
  need(core.exact(value.sourcePins, names) && names.length > 0 && names.length <= core.LIMITS.rows,
    'FILE_PROOF_SCOPE_PIN_LIMIT');
  const pins = new Map();
  for (const name of names) {
    const pin = value.sourcePins[name], file = canonical(name);
    need(core.sha(pin), 'FILE_PROOF_SCOPE_INVALID_PIN');
    need(!pins.has(file) || pins.get(file) === pin, 'FILE_PROOF_SCOPE_ALIAS_CONFLICT'); pins.set(file, pin);
  }
  need(Array.isArray(value.excludedPaths) && value.excludedPaths.length <= 256 && core.dense(value.excludedPaths), 'FILE_PROOF_SCOPE_EXCLUSION_LIMIT');
  const excluded = new Set(value.excludedPaths.map(canonical));
  need(excluded.size === value.excludedPaths.length, 'FILE_PROOF_SCOPE_DUPLICATE_EXCLUSION');
  const input = value.sourceProof, fields = ['roots', 'rows', 'epoch', 'hostGeneration',
    ...(Object.hasOwn(input ?? {}, 'timeoutMs') ? ['timeoutMs'] : [])];
  need(core.exact(input, fields), 'FILE_PROOF_SCOPE_INVALID_OPTIONS');
  // Check original spelling before core normalization can turn a rooted-current-drive
  // path into an apparently fully qualified descriptor.
  need(Array.isArray(input.roots) && input.roots.length > 0 && input.roots.length <= core.LIMITS.roots
    && core.dense(input.roots), 'FILE_PROOF_INVALID_CONFIG');
  for (const root of input.roots) {
    need(core.exact(root, ['id', 'path', 'nodeId']), 'FILE_PROOF_INVALID_ROOT'); canonical(root.path);
  }
  const config = core.validateConfig({protocol: core.PROTOCOL, nonce: '0'.repeat(32),
    roots: input.roots, epoch: input.epoch, hostGeneration: input.hostGeneration});
  if (Object.hasOwn(input, 'timeoutMs')) need(Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0
    && input.timeoutMs <= 120000, 'FILE_PROOF_INVALID_TIMEOUT');
  const rows = core.validateRows(input.rows, config.roots), roots = new Map(config.roots.map(root => [root.id, root]));
  const rootPaths = config.roots.map(root => canonical(root.path));
  for (let i = 0; i < rootPaths.length; i++) for (let j = i + 1; j < rootPaths.length; j++) {
    const nested = (a, b) => {const rel = path.relative(a, b); return rel === '' || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);};
    need(!nested(rootPaths[i], rootPaths[j]) && !nested(rootPaths[j], rootPaths[i]), 'FILE_PROOF_SCOPE_OVERLAPPING_ROOTS');
  }
  const used = new Set(), projected = new Map();
  for (const row of rows) {
    used.add(row.rootId);
    const file = canonical(path.join(roots.get(row.rootId).path, row.relativePath));
    need(!projected.has(file), 'FILE_PROOF_SCOPE_DUPLICATE_FILE');
    need(!excluded.has(file), 'FILE_PROOF_SCOPE_MUTABLE_SOURCE');
    need(pins.has(file) && pins.get(file) === row.expected.sha256, 'FILE_PROOF_SCOPE_PIN_MISMATCH');
    projected.set(file, row.expected.sha256);
  }
  need(used.size === roots.size, 'FILE_PROOF_SCOPE_UNUSED_ROOT');
  need(projected.size === pins.size, 'FILE_PROOF_SCOPE_PIN_MISMATCH');
  for (const file of pins.keys()) need(!excluded.has(file), 'FILE_PROOF_SCOPE_MUTABLE_SOURCE');
  const output = {roots: config.roots, rows, epoch: config.epoch, hostGeneration: config.hostGeneration,
    ...(Object.hasOwn(input, 'timeoutMs') ? {timeoutMs: input.timeoutMs} : {})};
  core.budget(output); return output;
}
module.exports = {validateSourceScope};
