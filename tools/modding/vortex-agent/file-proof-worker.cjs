'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { parentPort, workerData, isMainThread } = require('node:worker_threads');
const { createPhysicalReader } = require('./physical-proof.cjs');
const PROTOCOL = 'file-proof/1';
const LIMITS = Object.freeze({ roots: 8, rows: 4096, fileBytes: 8 * 1024 ** 3, totalBytes: 32 * 1024 ** 3,
  messageBytes: 4 * 1024 ** 2, chunkBytes: 64 * 1024, cacheEntries: 50000 });
const fail = code => { throw Error(code); }, need = (ok, code) => { if (!ok) fail(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, keys) {
  return object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(k => {
    const d = Object.getOwnPropertyDescriptor(value, k); return d && Object.hasOwn(d, 'value') && d.enumerable;
  });
}
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const nodeId = value => typeof value === 'string' && /^[1-9]\d{0,24}:[1-9]\d{0,24}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const decimal = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,24})$/.test(value);
const signed = value => typeof value === 'string' && /^-?(?:0|[1-9]\d{0,24})$/.test(value);
function dense(value) {
  return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, n) => Object.getOwnPropertyDescriptor(value, String(n)))
      .every(d => d && Object.hasOwn(d, 'value') && d.enumerable);
}
const identity = stat => `${stat.dev}:${stat.ino}`;
const generation = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function budget(value) { need(Buffer.byteLength(JSON.stringify(value)) <= LIMITS.messageBytes, 'FILE_PROOF_MESSAGE_LIMIT'); }
function validateConfig(value) {
  need(exact(value, ['protocol', 'nonce', 'epoch', 'hostGeneration', 'roots']) && value.protocol === PROTOCOL
    && typeof value.nonce === 'string' && /^[a-f0-9]{32}$/.test(value.nonce)
    && Number.isSafeInteger(value.epoch) && value.epoch > 0 && token(value.hostGeneration)
    && Array.isArray(value.roots) && value.roots.length > 0 && value.roots.length <= LIMITS.roots && dense(value.roots), 'FILE_PROOF_INVALID_CONFIG');
  const names = new Set(), nodes = new Set();
  const roots = value.roots.map(root => {
    need(exact(root, ['id', 'path', 'nodeId']) && token(root.id) && !names.has(root.id) && nodeId(root.nodeId)
      && !nodes.has(root.nodeId) && typeof root.path === 'string' && root.path.length <= 1024 && path.isAbsolute(root.path)
      && !/[\x00-\x1f\x7f]/.test(root.path) && !root.path.split(/[\\/]/).some(p => p === '.' || p === '..'), 'FILE_PROOF_INVALID_ROOT');
    names.add(root.id); nodes.add(root.nodeId); return { id: root.id, path: path.resolve(root.path), nodeId: root.nodeId };
  });
  const config = { protocol: PROTOCOL, nonce: value.nonce, epoch: value.epoch, hostGeneration: value.hostGeneration, roots };
  budget(config); return config;
}
function relative(value) {
  need(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !path.isAbsolute(value)
    && !/[\x00-\x1f\x7f<>:"\\|?*]/.test(value)
    && value.split('/').every(p => p && p.length <= 255 && p !== '.' && p !== '..' && !/[. ]$/.test(p)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), 'FILE_PROOF_INVALID_PATH');
}
function validateRows(value, roots) {
  need(Array.isArray(value) && value.length > 0 && value.length <= LIMITS.rows && dense(value), 'FILE_PROOF_ROW_LIMIT');
  const ids = new Set(roots.map(r => r.id)), seen = new Set(); let total = 0n;
  const rows = value.map(row => {
    need(exact(row, ['rootId', 'relativePath', 'expected']) && ids.has(row.rootId), 'FILE_PROOF_INVALID_ROW'); relative(row.relativePath);
    const name = row.rootId + '/' + (process.platform === 'win32' ? row.relativePath.toLowerCase() : row.relativePath);
    need(!seen.has(name), 'FILE_PROOF_DUPLICATE_PATH'); seen.add(name);
    const e = row.expected;
    need(exact(e, ['nodeId', 'bytes', 'links', 'sha256']) && nodeId(e.nodeId) && decimal(e.bytes)
      && BigInt(e.bytes) <= BigInt(LIMITS.fileBytes) && Number.isSafeInteger(e.links) && e.links > 0 && sha(e.sha256), 'FILE_PROOF_INVALID_EXPECTATION');
    total += BigInt(e.bytes); need(total <= BigInt(LIMITS.totalBytes), 'FILE_PROOF_BYTE_LIMIT');
    return { rootId: row.rootId, relativePath: row.relativePath,
      expected: { nodeId: e.nodeId, bytes: e.bytes, links: e.links, sha256: e.sha256 } };
  });
  budget(rows); return rows;
}
function directories(dir) {
  const chain = []; for (let p = dir; ; p = path.dirname(p)) { chain.unshift(p); if (p === path.dirname(p)) break; }
  const result = new Map();
  for (const p of chain) {
    const stat = fs.lstatSync(p, { bigint: true });
    need(stat.isDirectory() && !stat.isSymbolicLink() && nodeId(identity(stat)), 'FILE_PROOF_UNSAFE_ANCESTOR'); result.set(p, identity(stat));
  }
  return result;
}
function assertDirectories(pins) {
  for (const [p, node] of pins) {
    const stat = fs.lstatSync(p, { bigint: true });
    need(stat.isDirectory() && !stat.isSymbolicLink() && identity(stat) === node, 'FILE_PROOF_ANCESTOR_CHANGED');
  }
}
function observeRoots(roots) {
  const result = new Map();
  for (const root of roots) {
    const pins = directories(root.path); need(pins.get(root.path) === root.nodeId, 'FILE_PROOF_ROOT_CHANGED');
    for (const [p, id] of pins) { need(!result.has(p) || result.get(p) === id, 'FILE_PROOF_ANCESTOR_CHANGED'); result.set(p, id); }
  }
  assertDirectories(result); return result;
}
function observeLeaf(root, row) {
  const file = path.join(root.path, row.relativePath), within = path.relative(root.path, file);
  need(within && within !== '..' && !within.startsWith('..' + path.sep) && !path.isAbsolute(within), 'FILE_PROOF_INVALID_PATH');
  const parents = directories(path.dirname(file)); need(parents.get(root.path) === root.nodeId, 'FILE_PROOF_ROOT_CHANGED');
  const stat = fs.lstatSync(file, { bigint: true });
  need(stat.isFile() && !stat.isSymbolicLink() && nodeId(identity(stat)) && stat.size >= 0n
    && stat.size <= BigInt(LIMITS.fileBytes) && stat.nlink > 0n && stat.nlink <= BigInt(Number.MAX_SAFE_INTEGER), 'FILE_PROOF_NONREGULAR');
  return { file, parents, stat, generation: generation(stat) };
}
function matches(stat, expected) {
  return identity(stat) === expected.nodeId && String(stat.size) === expected.bytes && Number(stat.nlink) === expected.links;
}
function safeCode(error) { return /^FILE_PROOF_[A-Z_]+$/.test(error?.message || '') ? error.message : 'FILE_PROOF_IO_FAILED'; }
function binding(config, request) {
  need(exact(request, ['protocol', 'nonce', 'epoch', 'hostGeneration', 'rootsDigest', 'requestId', 'listDigest', 'fresh', 'rows'])
    && request.protocol === PROTOCOL && request.nonce === config.nonce && request.epoch === config.epoch
    && request.hostGeneration === config.hostGeneration && request.rootsDigest === digest(config.roots)
    && typeof request.requestId === 'string' && /^[a-f0-9]{32}$/.test(request.requestId)
    && sha(request.listDigest) && typeof request.fresh === 'boolean', 'FILE_PROOF_INVALID_REQUEST');
  const rows = validateRows(request.rows, config.roots); need(digest(rows) === request.listDigest, 'FILE_PROOF_LIST_CHANGED'); budget(request); return rows;
}
function createProofEngine(input) {
  need(!process.versions.electron, 'FILE_PROOF_ELECTRON_UNVERIFIED');
  const config = validateConfig(input), roots = new Map(config.roots.map(r => [r.id, r])); let current;
  const hash = file => {
    need(current?.file === file, 'FILE_PROOF_UNBOUND_FILE'); assertDirectories(current.parents);
    const fd = fs.openSync(file, 'r');
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      need(generation(before) === current.generation && generation(fs.lstatSync(file, { bigint: true })) === current.generation,
        'FILE_PROOF_FILE_CHANGED');
      const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(LIMITS.chunkBytes); let bytes = 0, count;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        bytes += count; need(bytes <= Number(before.size) && bytes <= LIMITS.fileBytes, 'FILE_PROOF_FILE_CHANGED'); hash.update(buffer.subarray(0, count));
      }
      need(bytes === Number(before.size) && generation(fs.fstatSync(fd, { bigint: true })) === current.generation
        && generation(fs.lstatSync(file, { bigint: true })) === current.generation, 'FILE_PROOF_FILE_CHANGED');
      assertDirectories(current.parents); return hash.digest('hex');
    } finally { fs.closeSync(fd); }
  };
  const checkpoint = createPhysicalReader({ fs, hash });
  return request => {
    const rows = binding(config, request), rootPins = observeRoots(config.roots);
    const physical = request.fresh ? createPhysicalReader({ fs, hash }) : checkpoint, before = physical.metrics();
    const proofs = rows.map(row => {
      const root = roots.get(row.rootId); current = observeLeaf(root, row);
      need(matches(current.stat, row.expected), 'FILE_PROOF_EXPECTATION_CHANGED');
      const initial = current, proof = physical(current.file), after = observeLeaf(root, row);
      assertDirectories(initial.parents);
      need(after.generation === initial.generation && proof.sha256 === row.expected.sha256 && matches(after.stat, row.expected), 'FILE_PROOF_EXPECTATION_CHANGED');
      return { rootId: row.rootId, relativePath: row.relativePath, ...proof, mtimeNs: String(after.stat.mtimeNs), ctimeNs: String(after.stat.ctimeNs) };
    });
    assertDirectories(rootPins); const final = physical.metrics();
    const result = { protocol: PROTOCOL, nonce: config.nonce, epoch: config.epoch, hostGeneration: config.hostGeneration,
      rootsDigest: request.rootsDigest, requestId: request.requestId, listDigest: request.listDigest, fresh: request.fresh,
      ok: true, proofs, metrics: Object.fromEntries(Object.keys(final).map(k => [k, final[k] - before[k]])),
      backend: 'node:fs', hostCompatibilityVerified: false, effectsAllowed: false, diskDeploymentVerified: false, directoryInventoryVerified: false };
    budget(result); return result;
  };
}
module.exports = { PROTOCOL, LIMITS, exact, dense, token, nodeId, sha, decimal, signed, identity, generation,
  digest, budget, validateConfig, validateRows, observeRoots, assertDirectories, observeLeaf, matches, safeCode, createProofEngine };
if (require.main === module && !isMainThread) {
  let run;
  try { run = createProofEngine(workerData); }
  catch { throw Error('FILE_PROOF_WORKER_INITIALIZATION_FAILED'); }
  parentPort.on('message', request => {
    try { parentPort.postMessage(run(request)); }
    catch (error) {
      parentPort.postMessage({ protocol: PROTOCOL, nonce: workerData.nonce, epoch: workerData.epoch, hostGeneration: workerData.hostGeneration,
        rootsDigest: digest(workerData.roots), requestId: request?.requestId, listDigest: request?.listDigest, fresh: request?.fresh,
        ok: false, error: safeCode(error) });
    }
  });
}
