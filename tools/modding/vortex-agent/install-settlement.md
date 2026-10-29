# Native installation settlement

`install-settlement.cjs` is an observer for the next reviewed task-owned native
helper. It is not a resident MCP operation, installer, replacement policy or
deployment verifier. It has no filesystem, network, Vortex actions or event API.
Existing frozen and retired helpers are not rewritten or upgraded by this file.

For a new helper, use the [maintained preparer](../../../docs/NATIVE-HELPER-PREPARATION.md)
to copy/pin the observer and update the known caller. Verify the prepared code
contract before activation rather than copying the old settlement module again.
Diagnostics include separate guard/read/sleep costs and the last awaited operation.
Tracked Nexus batches use the separate
[manual review route](../../../docs/TRACKED-NEXUS-HELPER-REVIEW.md); the single-own
preparer does not support that template or grant batch-install approval.

## Why this observer exists

A retained 29 October installation took 23m42s from request to final response.
The actual disable/enable/deploy receipts span 7.659s. Its native guard recorded
72 checks totaling 133.326s; the serial background poller's 28.288s is included
in that total, not an additional cost. The first install-workflow attempt began
about 15 minutes after the request. Command durations alone do not provide an
exclusive accounting of the remaining wall time.

That helper's settlement key hashed the complete installed record and selected
flag objects. Any catalog field or flag timestamp change restarted its 3s quiet
timer. Its 30s failure did not say whether size, flags or the quiet window were
still pending. This is a reproducible design defect, but the retained receipt
does not establish which predicate caused that particular live timeout.

The new observer pins `id`, `archiveId`, `installationPath`, `type`, payload byte
count, intended enabled flag and exact old IDs that must be explicitly disabled.
Only these required predicates and `state === 'installed'` govern the sampled
quiet window. Unrelated catalog metadata and flag timestamps do not reset it.
A conflicting defined identity aborts; missing fields keep waiting. Any sampled
required predicate failure restarts the full window. Polling cannot prove that
there was no transient change between samples.

Native mod IDs and download IDs have different domains. Native IDs can derive
from archive/install names, including spaces, dots, parentheses and Unicode.
The observer accepts up to 255 UTF-16 code units, rejects leading/trailing
whitespace, a trailing dot, path separators, Windows-invalid filename characters,
ASCII controls and prototype-related object keys. This is a bounded observer
policy, not proof of filesystem containment or a complete Vortex schema.
Download IDs retain the separate 1–128 ASCII alphanumeric/underscore/hyphen
policy. Neither domain is trimmed, case-folded or normalized for comparison.
The target ID, every explicitly disabled old ID and archive ID remain pinned.

## Bind it to a reviewed one-shot

Copy the module into the prepared helper and include its exact bytes in the
helper's module/source pins and materialization manifest. Import the copy,
not a mutable external source path. Select fresh expectations from the reviewed
package and exact native callback/download identity; do not infer a new identity
from whatever record happens to have the expected size.

```javascript
const { waitForInstallSettlement } = require('./install-settlement.cjs');
await waitForInstallSettlement({
  expected: {
    record: { id: expectedModId, archiveId: downloadId,
      installationPath: expectedInstallationPath, type: expectedType },
    bytes: expectedPayloadBytes,
    enabled: false,
    disabledModIds: [],
  },
  assertOperationalState: checkedGuard,
  read: () => {
    const state = api.getState();
    return {
      record: state.persistent.mods[gameId][expectedModId],
      flags: state.persistent.profiles[profileId].modState,
    };
  },
  record: appendDurableReceipt,
});
```

The guard must retain the reviewed active context, canonical root/filesystem
identities, stopped-game check, dialogs, unresolved-operation interlocks,
unrelated owners/flags/settings and protected byte/hardlink checks. This module
does not justify replacing it with a context-only check. It checks the guard
before every sample and once more before success, re-reading the target after
the final awaited guard. Defaults are 1s polls, 3s sampled quiet and a 30s total
deadline. Injected asynchronous operations share the remaining deadline; a
post-return clock check rejects synchronous adapters that overrun it. A timer
cannot interrupt synchronous blocking code or cancel underlying native work.

`record` must synchronously persist its bounded diagnostic projection. Promise
writers or failures reject settlement. Receipts distinguish `record_missing`,
`identity_missing`, `installed_state`, `mod_size`, `enabled_flags` and
`quiet_window`, without serializing metadata or raw upstream errors. Failures
require reconciliation, never a new native attempt or interlock removal.

Success only proves the observed record/flag predicates. The caller must still
verify staged payload bytes and preserve its no-replay ledger. It must recheck
the live context before any subsequent effect. This observer supplies neither
create-new-only installation nor authorization to enable or deploy.

## Remaining expensive work

In the incident helper, the 271,650,524-byte `app.asar` was explicitly hashed and
also present among 46 source pins. Together those two paths through the guard
read 560,051,610 bytes per full pass, or about 37.6GiB over 72 checks. This is
logical data fed to hashing, not measured physical SSD traffic; OS caching may
serve it. Protected payload files already used a stat-keyed cache, so it is
incorrect to claim every payload was rehashed every time.

That duplicate source hashing, synchronous process checks, full protected-state
scans and startup/restart orchestration remain separate follow-ups. Preserve
fresh pre-effect and boundary proof when removing duplicate work. Do not cache
the absence of a game process across awaits or suppress protective checks merely
to reduce elapsed time. No current live-install speedup is claimed here.

## Verification

```powershell
node --test tools/modding/vortex-agent/install-settlement.test.cjs tools/modding/vortex-agent/local-import-readiness.test.cjs
```

The changing-metadata fixture settles at simulated 3s; the retired whole-record
observer times out at simulated 30s on the equivalent input. Wrong size/flags,
missing records, identity changes, final-guard races, receipt failures, stalled
readers and deadline overruns remain rejection cases. These are local modeled
checks, not ordinary-session native installation or gameplay acceptance.
