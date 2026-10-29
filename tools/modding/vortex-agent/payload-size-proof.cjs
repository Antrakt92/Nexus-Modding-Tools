'use strict';

// Pure validation of a fresh physical-reader tree against the reviewed payload.
// Filesystem containment, generation checks and native identity remain callers'
// responsibilities. A matching aggregate size alone never proves a payload.
function verifiedPayloadBytes(tree, expected) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const fail = () => { throw Error('SETTLEMENT_PAYLOAD_PROOF_DIFFERS'); };
  if (!object(tree) || !object(expected)) fail();
  const names = Object.keys(expected);
  if (!names.length || names.length !== Object.keys(tree).length) fail();
  let total = 0;
  for (const name of names) {
    const row = Object.hasOwn(tree, name) && tree[name], pin = expected[name];
    const bytes = typeof row?.bytes === 'string' && /^(0|[1-9]\d*)$/.test(row.bytes) ? Number(row.bytes) : row?.bytes;
    if (typeof pin !== 'string' || !/^[a-f0-9]{64}$/.test(pin) || !object(row)
        || row.sha256 !== pin || !Number.isSafeInteger(bytes) || bytes < 0) fail();
    total += bytes;
    if (!Number.isSafeInteger(total)) fail();
  }
  return total;
}
module.exports = { verifiedPayloadBytes };
