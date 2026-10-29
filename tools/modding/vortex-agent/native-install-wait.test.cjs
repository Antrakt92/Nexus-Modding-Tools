'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { wait } = require('./native-install-wait.cjs');
function options() {
  let clock = 0, reads = 0;
  const events = [];
  return { events, opts: { pkg: { expectedModId: 'own', expectedEnabled: false, oldEnabledModIds: [] },
    expectedDownloadId: 'download_1', expectedType: '', expectedSize: 9,
    guard: () => {}, read: () => ({ record: { id: 'own', archiveId: 'download_1', installationPath: 'own',
      type: '', state: 'installed', attributes: { modSize: 9, metadata: ++reads } }, flags: {} }),
    now: () => clock, sleep: async ms => { clock += ms; }, record: e => events.push(e),
  } };
}
test('compatibility entry uses pinned observer and durable diagnostics despite metadata churn', async () => {
  const { opts, events } = options(); const result = await wait(opts);
  assert.equal(result.ready, true); assert.equal(result.elapsedMs, 3000);
  assert.equal(events.at(-1).phase, 'install_settlement_ready');
});
test('old unpinned invocations cannot silently use the compatibility observer', async () => {
  for (const key of ['expectedDownloadId', 'expectedType', 'record']) {
    const { opts } = options(); delete opts[key];
    await assert.rejects(wait(opts), { code: 'INVALID_INSTALL_SETTLEMENT_OPTIONS' });
  }
});
test('conflicting archive ID cannot be adopted from the observed record', async () => {
  const { opts } = options(); opts.expectedDownloadId = 'different';
  await assert.rejects(wait(opts), { code: 'INSTALL_SETTLEMENT_IDENTITY_CHANGED' });
});
