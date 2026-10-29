'use strict';
const { waitForInstallSettlement, isNativeModId } = require('./install-settlement.cjs');

function flagsReady(flags, pkg) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)
      || !pkg || !isNativeModId(pkg.expectedModId) || typeof pkg.expectedEnabled !== 'boolean'
      || !Array.isArray(pkg.oldEnabledModIds) || !pkg.oldEnabledModIds.every(isNativeModId)) return false;
  const current = flags[pkg.expectedModId];
  const valid = row => row === undefined || row && typeof row === 'object' && !Array.isArray(row) && typeof row.enabled === 'boolean';
  return valid(current) && (pkg.expectedEnabled ? current?.enabled === true : current === undefined || current.enabled === false)
    && pkg.oldEnabledModIds.every(id => valid(flags[id]) && flags[id]?.enabled === false);
}
function wait({ guard, read, record, sleep, now, pkg, expectedSize,
  expectedDownloadId, expectedType, timeoutMs, quietMs, pollMs } = {}) {
  return waitForInstallSettlement({ expected: { record: { id: pkg?.expectedModId,
    archiveId: expectedDownloadId, installationPath: pkg?.expectedModId, type: expectedType },
    bytes: expectedSize, enabled: pkg?.expectedEnabled, disabledModIds: pkg?.oldEnabledModIds },
    assertOperationalState: guard, read, record, sleep, now, timeoutMs, quietMs, pollMs });
}
module.exports = { wait, flagsReady };
