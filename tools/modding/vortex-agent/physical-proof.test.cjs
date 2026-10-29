'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createPhysicalReader } = require('./physical-proof.cjs');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-proof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'stage'), b = path.join(dir, 'game');
  fs.writeFileSync(a, 'payload'); fs.linkSync(a, b);
  return { a, b, dir };
}
test('hardlink aliases hash once but every returned path has checked identity', t => {
  const { a, b } = fixture(t), proof = createPhysicalReader({ fs, hash });
  assert.deepEqual(proof(a), proof(b));
  assert.deepEqual(proof.metrics(), { reads: 2, hashes: 1, cacheHits: 1, bytesHashed: 7 });
});
test('replaced alias cannot reuse another inode proof', t => {
  const { a, b } = fixture(t), proof = createPhysicalReader({ fs, hash }), before = proof(a);
  fs.unlinkSync(b); fs.writeFileSync(b, 'payload');
  assert.notEqual(proof(b).nodeId, before.nodeId);
  assert.equal(proof.metrics().hashes, 2);
});
test('same-length byte changes invalidate the generation cache', t => {
  const { a } = fixture(t), proof = createPhysicalReader({ fs, hash }), before = proof(a);
  fs.writeFileSync(a, 'changed');
  fs.utimesSync(a, new Date(1000), new Date(1000));
  assert.notEqual(proof(a).sha256, before.sha256);
  assert.equal(proof.metrics().hashes, 2);
});
test('link-count changes invalidate a cached generation', t => {
  const { a, dir } = fixture(t), proof = createPhysicalReader({ fs, hash }); proof(a);
  fs.linkSync(a, path.join(dir, 'other'));
  assert.equal(proof(a).links, 3); assert.equal(proof.metrics().hashes, 2);
});
test('mutation during hashing fails and does not seed the cache', t => {
  const { a } = fixture(t), cache = new Map();
  const proof = createPhysicalReader({ fs, cache, hash: p => {
    const value = hash(p); fs.writeFileSync(p, 'changed'); fs.utimesSync(p, new Date(1000), new Date(1000)); return value;
  } });
  assert.throws(() => proof(a), /PHYSICAL_PROOF_CHANGED/); assert.equal(cache.size, 0);
});
test('leaf symlinks and directories are rejected', t => {
  const { a, dir } = fixture(t), proof = createPhysicalReader({ fs, hash });
  const link = path.join(dir, 'alias'); fs.symlinkSync(a, link);
  assert.throws(() => proof(link), /PHYSICAL_PROOF_NONREGULAR/);
  assert.throws(() => proof(dir), /PHYSICAL_PROOF_NONREGULAR/);
});
test('checkpoint cache can be explicitly cleared and is not shared across readers', t => {
  const { a } = fixture(t), proof = createPhysicalReader({ fs, hash });
  proof(a); proof.clear(); proof(a);
  assert.equal(proof.metrics().hashes, 2);
  const other = createPhysicalReader({ fs, hash }); other(a); assert.equal(other.metrics().hashes, 1);
});
