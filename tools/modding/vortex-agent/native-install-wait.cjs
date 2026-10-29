'use strict';
const { waitForInstallSettlement } = require('./install-settlement.cjs');

// Compatibility boundary for reviewed task helpers. Archive/type pins and a
// durable diagnostic writer are mandatory, rather than inferred from live state.
function wait({ guard, read, record, sleep, now, pkg, expectedSize,
  expectedDownloadId, expectedType, timeoutMs, quietMs, pollMs, sizeSource } = {}) {
  return waitForInstallSettlement({
    expected: { record: { id: pkg?.expectedModId, archiveId: expectedDownloadId,
      installationPath: pkg?.expectedModId, type: expectedType },
    bytes: expectedSize, enabled: pkg?.expectedEnabled, disabledModIds: pkg?.oldEnabledModIds },
    assertOperationalState: guard, read, record, sleep, now, timeoutMs, quietMs, pollMs, sizeSource,
  });
}
module.exports = { wait };
