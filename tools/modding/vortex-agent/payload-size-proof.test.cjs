'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { verifiedPayloadBytes: proof } = require('./payload-size-proof.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createPhysicalReader } = require('./physical-proof.cjs');
const pin = 'a'.repeat(64), expected = { first: pin, second: pin };
const tree = () => ({ first: { bytes: 4, sha256: pin }, second: { bytes: 5, sha256: pin } });
test('cached physical reads detect a same-size staged mutation before settlement', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-settlement-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'file'); fs.writeFileSync(file, 'original');
  const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const physical = createPhysicalReader({ fs, hash }), expected = { file: hash(file) };
  assert.equal(proof({ file: physical(file) }, expected), 8);
  fs.writeFileSync(file, 'modified');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.throws(() => proof({ file: physical(file) }, expected), /SETTLEMENT_PAYLOAD_PROOF_DIFFERS/);
});
test('fresh exact payload proof returns physical bytes without native metadata', () => {
  assert.equal(proof(tree(), expected), 9);
  assert.equal(proof({ first: { bytes: '4', sha256: pin }, second: { bytes: '5', sha256: pin } }, expected), 9);
});
test('equal aggregate size cannot hide missing, extra, changed or invalid files', () => {
  for (const value of [null, [], {}, { first: { bytes: 9, sha256: pin } },
    { ...tree(), extra: { bytes: 0, sha256: pin } },
    { first: { bytes: 4, sha256: 'b'.repeat(64) }, second: tree().second },
    { first: { bytes: '4.0', sha256: pin }, second: tree().second },
    { first: { bytes: Number.MAX_SAFE_INTEGER, sha256: pin }, second: tree().second }])
    assert.throws(() => proof(value, expected), /SETTLEMENT_PAYLOAD_PROOF_DIFFERS/);
});
