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
| Native source | Vortex tag `v2.9.1`, commit `c80326367cbe6d96621ad6cf4a5488ef49bac110`; six installed renderer entries rechecked byte-identical to the official originals | Current installed package contains the original implementation, not the prepared safety patches |
| Renderer qualification | [Complete source assembly](NATIVE-SOURCE-ASSEMBLY.md): current 30-patch/ten-source graph passed actual TypeScript/webpack and Program/map binding with original config/lock | Isolated development renderer only; no main-process/native ABI, installed loading or registration acceptance |
| Startup cleanup | [Synchronous cleanup ownership](NATIVE-STARTUP-CLEANUP.md), stop on deletion failure and retain the incomplete-install record | Prepared core path only; no physical cleanup permission, durable crash recovery or installed-host acceptance |
| Archive seal and temp handoff | [Archive/temp custody](ARCHIVE-TEMP-CUSTODY.md), 35 Windows tests and one actual owned-SDK extraction followed by transfer through the original held root | Normal path with surviving keeper only; crash lifetime, no-clobber extraction and native installation remain unproved |
| Keeper-crash mechanics | [Controlled Windows process experiment](NATIVE-CRASH-CUSTODY.md), surviving custodian, creation-time Job assignment and exact process/thread takeover | Isolated installed-7z fixture only; no SDK/Vortex launcher integration or arbitrary-supervisor-crash guarantee |
| Controlled guardian loss | [Process containment and held intent](NATIVE-CRASH-CUSTODY.md#loss-of-the-guardian), suspended/running reader cases and independent journal binding | Isolated fixture; no general crash recovery, successor filesystem permit or native installation |
| Internal extractor owner | [Fixed process owner](OWNED-EXTRACTOR-PROCESS.md), shared custody, suspended child, bounded polling and terminal-gated handoff | Internal component; no worker transport, ZIP no-clobber or Vortex registration authority |
| ZIP output ownership | [Retained-handle ZIP backend](OWNED-ZIP-EXTRACTOR.md), exclusive relative creation and transfer from the original output handles | Internal own-package ZIP component; no Vortex registration, durable executor or installation endpoint |
| Background ZIP execution | [Guardian and coordinator](OWNED-ZIP-WORKER.md), autonomous pumping, original-handle copy and permanent operation/job bindings | Standalone own-scratch execution; no native manager exclusion, reconnect recovery or Vortex registration |
| Manager installation exclusion | [Prepared shared activity ownership](NATIVE-MANAGER-EXCLUSION.md), opaque permanent reservation, guarded simulation/dependency routes and joined limiter tails | Source-derived only; no release/dispatch, removal/create-mod exclusion, native registration or host acceptance |
| Removal/creation ownership | [Paired lifecycle handler patches](NATIVE-LIFECYCLE-HANDLERS.md), shared admission and joined undeploy/removal tails | Source-derived only; no general deploy/purge/refresh exclusion, release or host acceptance |
| Deployment/purge/refresh ownership | [Prepared queue and writer ownership](NATIVE-DEPLOYMENT-LIFECYCLE.md), joined cleanup/recovery and guarded low-level effect roots | Source-derived only; application build, installed parity, arbitrary state writers, physical completion and registration remain unproved |
| Extractor error settlement | [Pinned node-7z patch](NATIVE-EXTRACTOR-CLOSE-PATCH.md) joins the exact child's close before rejecting the first asynchronous failure | Prepared only; cancellation, descendants, native wrapper acceptance and cleanup ownership remain separate gates |
| Child resource observation | [Passive child observer](CHILD-TERMINAL-OBSERVER.md), actual child/pipe events and status independent of a caller promise | Internal component only; no extractor adoption, durable executor, descendant or cleanup permit |
| Extraction job ownership | [Explicit owned factory](NATIVE-OWNED-EXTRACTOR.md), fixed archive/destination, bounded attempts and per-instance child ownership | Prepared source only; native call sites, durable executor and safe cleanup remain held |
| Operation data model | Strict tracked-new-disabled plan, canonical identity and bounded event replay | Pure data; no journal writes, native dispatch or installation permission |
| Ordinary tracking | [Pinned source patch](NATIVE-TRACKING-PATCH.md) and eight source-backed regressions | Prepared only; ordinary tracking separated, dependency keys retained; application/native acceptance pending |
| Callback safety | [Ordered callback patch](NATIVE-CALLBACK-PATCH.md), one-shot notification and exact tracking ownership | Prepared only; forced debug cleanup is not native termination |
| Strict selection | [Private new-disabled selection patch](NATIVE-STRICT-SELECTION.md), fresh metadata/context and all-profile conflict checks before registration | Prepared only; legacy entrypoint unchanged; no path reservation or native permit |
| Transfer failure | [Copy-error propagation patch](NATIVE-COPY-ERROR-PATCH.md), actual native transfer/concurrency regressions | Prepared only; error propagation is not no-clobber, safe cleanup or terminal proof |
| Transfer worker join | [Joined transfer patch](NATIVE-TRANSFER-JOIN-PATCH.md), stop new callbacks after failure and await started mkdir/copy callbacks | Prepared only; callback settlement is not detached I/O/extractor exit or safe path cleanup |
| Staging/download folder transfer | [Joined callbacks and retained partial targets](NATIVE-STAGING-TRANSFER.md), exact 30-patch/ten-source graph and source-backed regressions | Prepared only; Settings memory ownership is covered, while background download writers, durable commit, physical custody and installed acceptance remain separate |
| Renderer target hold | [Root reducer fence](NATIVE-ADOPTION-BOUNDARY.md#renderer-target-fence), including nested batches, hydration/push and same-reducer store ambiguity | Prepared lifetime hold only; actual host binding, main writer fencing, registration and safe release remain separate |
| Native ownership | No replacement, exclusive owner/path reservation and owned cleanup | Missing from the reviewed ordinary host contract |
| File transfer primitive | [Handle-owned transfer](OWNED-FILE-TRANSFER.md), exclusive relative creation, native identity pins, retained failure output and borrowed temp-root handoff | Windows fixture library only; no Vortex connection, crash custody or cleanup permit |
| Native activity | [Core-tail diagnostic patch](NATIVE-ACTIVITY-PATCH.md), separate IDs and joined error cleanup | Prepared only; no extractor/process exit proof or native dispatch acknowledgement |
| Native terminal | Exact intent/job binding and proven extractor/mandatory cleanup completion | Not accepted by the reviewed ordinary host contract |
| Dispatch data contract | Closed full-plan request and bounded synchronous consumed-ID model with operation/job exclusion | Offline only; caller-provided lifetime claims, no native invocation or persistence |
| Intent storage | Exclusive operation reservation, immutable full-request record and externally bound readback | File/process-exit checks only; no power-loss publication proof, shared durable job exclusion or dispatch permit |
| Durable executor | [Fixed native dispatch contract](NATIVE-DISPATCH-CONTRACT.md), one server-owned ID and durable per-effect intents | Not implemented by the data model or diagnostic registry |
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

Start with the [registration boundary](NATIVE-ADOPTION-BOUNDARY.md). The executable
extension-first probe confirms a new CAS action is possible, but existing native
side effects, batches and main persistence are not fenced by an extension action
check. The prepared per-batch main persistence acknowledgement is a prerequisite,
not a registration endpoint. Complete the target admission, publication,
registration/persistence and recovery gates there before expanding the ordinary
pipeline. Keep the ordinary MCP install refusal until native acceptance.

Already prepared ordinary-pipeline fixes remain separate qualification work:

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
