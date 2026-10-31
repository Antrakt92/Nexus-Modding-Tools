# Local installation implementation

This work prepares one new own-local mod, installed disabled. It does not enable
`install_download`, add generic dispatch, change the installed Vortex application
or authorize installation from a successful offline model.

The first executable family will use an exact existing tracked download. Import
of a new ZIP and direct-local installation have distinct native contracts; neither
is a fallback after an uncertain tracked operation.

## Stages and evidence

| Stage | Evidence or deliverable | Current boundary |
| --- | --- | --- |
| Native source | Vortex tag `v2.9.1`, commit `c80326367cbe6d96621ad6cf4a5488ef49bac110`; five reviewed installed renderer entries byte-identical to upstream | Source identity, not new native safety APIs |
| Archive seal | Nine Windows sharing checks passed; the exact installed extractor binary also extracted the sealed test ZIP with matching payload | Mechanics/binary fixture only; node-7z wrapper, ancestor handoff and crash lifetime remain unproved |
| Operation data model | Strict tracked-new-disabled plan, canonical identity and bounded event replay | Pure data; no journal writes, native dispatch or installation permission |
| Ordinary tracking | [Pinned source patch](NATIVE-TRACKING-PATCH.md) and eight source-backed regressions | Prepared only; ordinary tracking separated, dependency keys retained; application/native acceptance pending |
| Callback safety | [Ordered callback patch](NATIVE-CALLBACK-PATCH.md), one-shot notification and exact tracking ownership | Prepared only; forced debug cleanup is not native termination |
| Native ownership | No replacement, exclusive owner/path reservation and owned cleanup | Missing from the reviewed ordinary host contract |
| Native activity | [Core-tail diagnostic patch](NATIVE-ACTIVITY-PATCH.md), separate IDs and joined error cleanup | Prepared only; no extractor/process exit proof or native dispatch acknowledgement |
| Native terminal | Exact intent/job binding and proven extractor/mandatory cleanup completion | Not accepted by the reviewed ordinary host contract |
| Durable executor | One server-owned operation and durable per-effect intents | Not implemented by the data model |
| New local ZIP | Atomic no-clobber import, or separately accepted direct-local contract | Not implemented |
| Enable/deploy | Reuse existing reviewed operations after accepted disabled installation | Not connected to installation |

The source comparison covers `InstallManager.ts`, mod-management handlers/index,
`filterModInfo.ts` and the download-management index. Package/source fingerprints
are recorded in [native lifecycle gates](NATIVE-LIFECYCLE-GATES.md).

## Pure operation model

`tools/modding/vortex-agent/install-job-contract.cjs` accepts only
`install-job-plan/1`, family `tracked-new-disabled`, contract
`own-install-job-model/1`. It performs no filesystem access or native operation.

The exact plan contains context/root identity, an existing download ID, an ASCII
ZIP basename and derived owner, type `''`, byte/hash/payload expectations, source/
build/native-admission document hashes, and `enabled:false, deploy:false`.
Profiles, roots and package data are part of the canonical semantic plan ID.
Unknown fields, unsafe Windows names, overlapping or physically identical roots,
unsupported installer files, aliases and malformed JSON are refused.

Limits are 1 MiB for the combined state document, 32 events, 4,096 payload paths,
64 MiB compressed archive and 256 MiB unpacked bytes. These are data-model bounds,
not a measured process-memory ceiling or proof of archive contents.

The native-admission document hash identifies the selected source/capability
evidence. It is distinct from the fresh context snapshot hash. Both are claims
until the future native executor verifies their contents and freshness.

```javascript
const model = require('./tools/modding/vortex-agent/install-job-contract.cjs');
const plan = model.parseInstallPlan(reviewedPlanBytes);
const planId = model.installPlanId(plan);
const state = model.initialInstallState(plan);
const status = model.inspectInstallState(state);
// status.effectsAllowed === false, even after a complete model event sequence.
```

`parseInstallState` checks strict JSON before replay. `advanceInstallState`
detaches and freezes accepted data and replays its entire bounded history rather
than trusting supplied phase/completion flags. Neither function persists it.

Required observation order:

1. Admission observation binds the selected native-admission document and fresh
   context snapshot; install intent binds that snapshot and a native job ID.
2. Native callback records resolved/failed and only the intended owner or an
   absent partial owner. A supplied job ID must equal the intent's job ID.
3. A separate native terminal observation must match that same job. Callback
   success alone cannot advance to payload settlement or completion.
4. Settlement, non-forced worker cleanup and final readback observations precede
   model completion.

Cancellation or failure stops forward progression. Bounded late callback/terminal
observations remain representable without erasing the earlier stop. A failed
callback can name the exact partially created owner; it never authorizes success.
Malformed, missing or contradictory history refuses replay.

All outputs keep `effectsAllowed`, `nativeAdmissionVerified`, `archiveVerified`
and `payloadVerified` false. `modelCompleted` means only that the supplied claims
follow the model. `reconcileRequired:false` or no recorded intent is not proof
that no external/native effect occurred. This is not a permit or a liveness API.

## Next native work

Prepare small independent upstream fixes against the exact source, keeping the
ordinary MCP install refusal until the combined contract passes native tests:

- Validate the prepared ordinary tracking and callback patches in the full
  application. Their source-derived tests do not prove extractor exit or
  dependency queue integration.
- Make final owner/path reservation apply after legacy retargeting too; exclusively
  acquire new directories and refuse cleanup when physical ownership changes.
- Enforce new-only selection before dependency-ignore, enable and removal paths.
- Make import refuse existing destinations atomically; do not rely on an earlier
  stat, a notification setting or a filename-only in-progress set.

An upstream patch artifact is preparation, not an installed application update.
Never patch the active packaged application or replay a historical helper to
bypass these gates. Native tests need an isolated fixture and a coordinated host
window. No game launch is required or authorized.
