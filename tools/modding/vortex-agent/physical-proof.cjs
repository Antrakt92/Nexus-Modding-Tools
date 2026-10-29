'use strict';

// Read-only, injected filesystem/hash adapters. One reader belongs to one
// reviewed helper/checkpoint, never a shared cache across clients or deployments.
function createPhysicalReader({ fs, hash, cache = new Map() }) {
  if (!fs || typeof fs.lstatSync !== 'function' || typeof hash !== 'function' || !(cache instanceof Map))
    throw Error('INVALID_PHYSICAL_PROOF_ADAPTER');
  const totals = { reads: 0, hashes: 0, cacheHits: 0, bytesHashed: 0 };
  const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(':');
  function sample(file) {
    const s = fs.lstatSync(file, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink()) throw Error('PHYSICAL_PROOF_NONREGULAR');
    return s;
  }
  const physical = file => {
    totals.reads++;
    const before = sample(file), key = stamp(before);
    let sha256 = cache.get(key);
    if (sha256 === undefined) {
      sha256 = hash(file);
      if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw Error('INVALID_PHYSICAL_PROOF_HASH');
      totals.hashes++;
      totals.bytesHashed += Number(before.size);
    } else totals.cacheHits++;
    // A read racing with a write/rename/link change cannot seed the cache.
    if (stamp(sample(file)) !== key) throw Error('PHYSICAL_PROOF_CHANGED');
    if (!cache.has(key)) {
      if (cache.size >= 50000) cache.delete(cache.keys().next().value);
      cache.set(key, sha256);
    }
    return { nodeId: `${before.dev}:${before.ino}`, bytes: String(before.size),
      links: Number(before.nlink), sha256 };
  };
  physical.metrics = () => ({ ...totals });
  physical.clear = () => cache.clear();
  return physical;
}

module.exports = { createPhysicalReader };
