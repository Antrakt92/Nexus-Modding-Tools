'use strict';

// Observation only. Native invocation, byte proof and durable no-replay ownership
// remain with the reviewed one-shot; this module has no Vortex or filesystem API.
class InstallSettlementError extends Error {
  constructor(code, observation) {
    super(code);
    this.name = 'InstallSettlementError';
    this.code = code;
    this.reconcileRequired = true;
    if (observation) this.observation = observation;
  }
}
const fail = (code, observation) => { throw new InstallSettlementError(code, observation); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fields = ['id', 'archiveId', 'installationPath', 'type'];

async function waitForInstallSettlement(options = {}) {
  const { expected, assertOperationalState, read, record,
    now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    timeoutMs = 30000, quietMs = 3000, pollMs = 1000 } = options;
  if (!object(expected) || !object(expected.record) || !id(expected.record.id)
      || Object.keys(expected).sort().join(',') !== 'bytes,disabledModIds,enabled,record'
      || Object.keys(expected.record).sort().join(',') !== 'archiveId,id,installationPath,type'
      || !id(expected.record.archiveId)
      || typeof expected.record.installationPath !== 'string' || !expected.record.installationPath
      || typeof expected.record.type !== 'string'
      || typeof expected.enabled !== 'boolean'
      || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0
      || !Array.isArray(expected.disabledModIds) || expected.disabledModIds.some(value => !id(value))
      || new Set(expected.disabledModIds).size !== expected.disabledModIds.length
      || expected.disabledModIds.includes(expected.record.id)
      || ![assertOperationalState, read, record, now, sleep].every(fn => typeof fn === 'function')
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 2 || timeoutMs > 120000
      || !Number.isSafeInteger(quietMs) || quietMs < 1 || quietMs >= timeoutMs
      || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs)
    fail('INVALID_INSTALL_SETTLEMENT_OPTIONS');

  // Freeze only the allowlisted expectation; callers cannot retarget an await.
  const pin = Object.fromEntries(fields.map(key => [key, expected.record[key]]));
  const enabled = expected.enabled, bytes = expected.bytes;
  const disabled = [...expected.disabledModIds];
  const timing = Object.fromEntries(['guard', 'read', 'sleep'].map(key => [key, { calls: 0, totalMs: 0, maxMs: 0 }]));
  let lastOperation = null;
  const diagnostics = () => ({ lastOperation,
    timing: Object.fromEntries(Object.entries(timing).map(([key, value]) => [key, { ...value }])) });
  let lastTime, started, since, observation, checks = 0, lastWaiting;
  function clock() {
    const value = now();
    if (!Number.isFinite(value) || value < 0 || (lastTime !== undefined && value < lastTime))
      fail('NONMONOTONIC_INSTALL_SETTLEMENT_CLOCK', observation);
    lastTime = value;
    return value;
  }
  started = clock();
  const deadline = started + timeoutMs;
  function timeLeft() {
    const left = deadline - clock();
    if (left <= 0) fail('INSTALL_SETTLEMENT_TIMEOUT_RECONCILE', observation);
    return left;
  }
  async function bounded(fn, operation) {
    const left = timeLeft();
    const begin = clock(); lastOperation = operation; timing[operation].calls++;
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new InstallSettlementError(
            'INSTALL_SETTLEMENT_TIMEOUT_RECONCILE', observation)), left);
        }),
      ]);
      timeLeft();
      return result;
    } finally {
      clearTimeout(timer);
      const elapsed = clock() - begin;
      timing[operation].totalMs += elapsed;
      timing[operation].maxMs = Math.max(timing[operation].maxMs, elapsed);
    }
  }
  function emit(event) {
    try {
      const result = record(event);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        fail('INSTALL_SETTLEMENT_RECEIPT_FAILED', observation);
      }
    } catch { fail('INSTALL_SETTLEMENT_RECEIPT_FAILED', observation); }
  }
  function observe(snapshot) {
    if (!object(snapshot) || !object(snapshot.flags)
        || (snapshot.record !== undefined && snapshot.record !== null && !object(snapshot.record)))
      fail('INVALID_INSTALL_SETTLEMENT_PROJECTION', observation);
    const mod = snapshot.record;
    const identityReady = !!mod && fields.every(key => mod[key] === pin[key]);
    // A missing identity can settle later. A conflicting identity cannot be
    // accepted as our installation, even if its size and flags happen to match.
    if (mod && fields.some(key => mod[key] !== undefined && mod[key] !== pin[key]))
      fail('INSTALL_SETTLEMENT_IDENTITY_CHANGED', observation);
    const flag = snapshot.flags[pin.id];
    const validFlag = value => value === undefined || (object(value) && typeof value.enabled === 'boolean');
    if (![flag, ...disabled.map(key => snapshot.flags[key])].every(validFlag))
      fail('INVALID_INSTALL_SETTLEMENT_FLAGS', observation);
    const flagsReady = (enabled ? flag?.enabled === true : flag === undefined || flag.enabled === false)
      && disabled.every(key => snapshot.flags[key]?.enabled === false);
    const stateReady = mod?.state === 'installed';
    const sizeReady = mod?.attributes?.modSize === bytes;
    const at = clock();
    // Unrelated catalog metadata and flag timestamps are deliberately excluded.
    // Every required predicate must stay true for the entire sampled quiet span.
    if (!identityReady || !flagsReady || !stateReady || !sizeReady) since = undefined;
    else if (since === undefined) since = at;
    const quietForMs = since === undefined ? 0 : at - since;
    const waiting = [];
    if (!mod) waiting.push('record_missing');
    else if (!identityReady) waiting.push('identity_missing');
    if (!stateReady) waiting.push('installed_state');
    if (!sizeReady) waiting.push('mod_size');
    if (!flagsReady) waiting.push('enabled_flags');
    if (!waiting.length && quietForMs < quietMs) waiting.push('quiet_window');
    observation = { checks: ++checks, elapsedMs: at - started, quietForMs,
      identityReady, flagsReady, stateReady, sizeReady, ready: waiting.length === 0, waiting, ...diagnostics() };
    const key = waiting.join(',');
    if (key !== lastWaiting) {
      // Do not expose the full record, raw errors, account data or metadata.
      emit({ phase: 'install_settlement_wait', ...observation, waiting: [...waiting] });
      lastWaiting = key;
    }
    return observation;
  }

  try {
    while (true) {
      await bounded(assertOperationalState, 'guard');
      let current = observe(await bounded(read, 'read'));
      if (current.ready) {
        await bounded(assertOperationalState, 'guard');
        // The final guard may await I/O. Re-read the target instead of returning
        // the pre-guard result when its flags or record changed in that interval.
        current = observe(await bounded(read, 'read'));
        if (current.ready) {
          emit({ phase: 'install_settlement_ready', ...current, waiting: [] });
          return current;
        }
      }
      await bounded(() => sleep(Math.min(pollMs, timeLeft())), 'sleep');
    }
  } catch (error) {
    const failure = error instanceof InstallSettlementError ? error
      : new InstallSettlementError('INSTALL_SETTLEMENT_OBSERVATION_FAILED', observation);
    failure.diagnostics = diagnostics();
    if (failure.code !== 'INSTALL_SETTLEMENT_RECEIPT_FAILED')
      emit({ phase: 'install_settlement_failed', code: failure.code,
        ...(observation ? { observation } : {}), ...diagnostics(), noReplay: true });
    throw failure;
  }
}

module.exports = { waitForInstallSettlement, InstallSettlementError };
