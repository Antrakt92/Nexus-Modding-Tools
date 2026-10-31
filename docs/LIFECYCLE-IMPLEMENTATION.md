# Lifecycle implementation

This checklist tracks the implementation requested on 30 October 2026. Each
stage has its own source change, regressions, independent review and publication.
Local verification, native acceptance and user gameplay remain separate.

| Stage | Deliverable | Acceptance gate | State |
| --- | --- | --- | --- |
| 1 | Own-local binder and early support checks | One pinned supported family; exact archive/payload evidence; inert output; no inherited live approvals; actual package regressions | Source verified; native activation excluded |
| 2 | Durable status for existing enable/deploy plans | Stable plan/step identity; receipts remain authoritative; lost response/cancellation/restart cannot replay an uncertain effect | Source verified; client reload required |
| 3 | Read-only file-proof worker | Same proof results and freshness checks; bounded input/output; worker crash and stale replies rejected; exact host backend verified | Component renderer gate verified; coordination source verified; installer integration pending |
| 4 | One deterministic native install contract | Proven no replacement/variant path, exact installer/source/identity, no auto-enable/deploy, durable effect intent and independent readback | Offline preflight verified; native invocation remains held |
| 5 | Keeper and consumer retention | Current build inputs and rollback scope explicit; isolated restore test; unknown external consumers block deletion | Catalog/copy/isolated archive restore verified; native restore unproven |
| 6 | Sequential native removal | One ID at a time; all-profile/rule/owner closure; verified keeper; partial callbacks stop for reconciliation; deletion semantics explicit | Pending native contract |
| 7 | Reference-cache status and reconstruction | Independently established input provenance, compatible pinned tool, immutable accepted output and preserved failed attempts | Source and local cache verified; full API coverage unproven |
| 8 | Shared Git hook and current framework route | Inspect canonical owner and intended checks; preserve historical pins; fix only the active supported route | Hook migration, discovery and current verifier source gates verified |
| 9 | Final integration audit | Affected suites, generated inventory, protocol/receipt compatibility, failure injection, measured critical path and explicit residual gates | Pending |

## Boundaries

- No generic dispatch or arbitrary task-code endpoint.
- Existing `install_download` remains unsupported until a separate native
  contract proves the particular operation safe. Binder output grants no effects.
- Runtime work needs a fresh coordinated window. A current user game test or
  another task's native operation is not a maintenance opportunity.
- Existing attempts, completions, locks and interlocks are evidence, not cache.
  Never repin or replay a previously attempted helper to make a new task pass.
- New request IDs do not resolve an uncertain native effect. Neither a timeout
  nor a missing heartbeat establishes that native work stopped.
- Native deletion is permanent in the inspected host; do not describe it as
  Recycle Bin or infer permission from a backup's existence.
- Authoritative mod/build archives and private runtime evidence stay outside the
  public source tree. No game, staging, profile or database edits are a shortcut.

Stages 7 and 8 are independent of source-only lifecycle work. Stage 5 is a
prerequisite for deletion, not for read-only inspection. General updates,
interactive installers, side-by-side exact-file dependency changes and parallel
native effects require additional contracts; they are not implicit in stage 4.

The [source-reviewed native gates](NATIVE-LIFECYCLE-GATES.md) document the exact
replacement, dependency-ignore and permanent-removal branches that keep effects
held. A new archive basename alone does not exclude silent replacement.

The [strict dispatch preparation](NATIVE-DISPATCH-CONTRACT.md) now includes a
closed full-plan request, a bounded synchronous consumed-ID model and immutable
intent storage with digest-bound readback. Process-exit tests and root-replacement
regressions verify this storage scope. Power-loss publication, shared durable
job exclusion and native no-replacement/ownership remain open; stage 4 is not
accepted for installation.

The [private selection patch](NATIVE-STRICT-SELECTION.md) prepares fresh context,
tracked-package and all-profile conflict checks while bypassing legacy replacement
branches. It remains uninstalled and requires separate owner/reservation, full
application-build and native acceptance gates.

The [transfer-error patch](NATIVE-COPY-ERROR-PATCH.md) repairs swallowed native
copy failures. Source-derived tests preserve the existing successful/self-copy
routes and demonstrate that other workers can still run after rejection. This
does not close no-clobber, ownership or terminal gates.

The subsequent [transfer join patch](NATIVE-TRANSFER-JOIN-PATCH.md) waits for
already-started mkdir/transfer callbacks before rejecting into error cleanup and
stops scheduling new callbacks after the first failure. Detached native work and
physical ownership remain outside that source-derived callback boundary.

The current bottleneck evidence and architectural constraints are in
[Lifecycle performance](LIFECYCLE-PERFORMANCE.md). This checklist does not replace
the [agent workflow](AGENT-WORKFLOW.md) or task-specific native admission.

## Stage 1 verification — 30 October 2026

The [own-local binder](OWN-LOCAL-BINDER.md) validates the entire archive/package
tuple and pinned source/build evidence before returning a plan or publishing a
held kit. It constructs a fresh held config rather than adopting old session
approvals. Publication refuses an existing destination, revalidates inputs and
generated bytes, and preserves an interfered temporary directory for inspection.

Independent reviews found and repaired shared-buffer mutation between constructor
calls, alternate ZIP names in extra fields, an impossible native owner name and
temporary cleanup that could remove a foreign replacement. Regressions cover
these cases, partial writes, changed evidence, retained-component coverage and
the real generated engine's package guard. The existing preparer's 30-file
output was byte-identical across the constructor refactor.

Local verification passed 330 Node tests with the real pinned template fixtures
and no skips, 21 recovery/bootstrap tests and 28 synthetic installer tests.
Offline acceptance also checked an existing 58-file own package: 51 primary
source paths plus seven explicitly pinned retained component paths. The new kit
passed code verification and its generated scope test without native calls.
Private manifests, payloads and receipts remain in ignored local state.

This completes offline binding only. No running extension was upgraded, no
helper activated and no game launched. Install readiness, fresh source/session
admission, deployment proof and gameplay acceptance are not granted by this kit.

## Stage 2 verification — 30 October 2026

Reviewed plans now return a stable full `planId`. Apply reserves an immutable
local plan journal and persists each intent before dispatch; a storage failure
stops later effects. The read-only `inspect_mod_plan` and `plan-status` CLI check
exact original receipts, retain uncertainty and never resume or replay a plan.
The journal lives beside the adapter's flat receipts, preserving installer
upgrade/retirement consumers. See the [workflow](NO-RESTART-WORKFLOW.md).

Regressions cover lost acknowledgements, cancellation during intent persistence,
async storage misuse, corrupt/pending histories, URI rejection before storage,
same-size write mutation, a fresh process, exact receipt/context drift, bounded
status concurrency, journal advancement and the full 101-operation limit.
Windows timestamp finalization after closing a writer is checked by reopening
and verifying exact bytes before pinning the file generation.

Local verification passed 361 Node tests without skips, 21 recovery/bootstrap
tests and 29 synthetic installer tests. Two independent reviews found no remaining
confirmed blocker in this scope. The package provenance was refreshed against
the existing verified resident bundle; no host upgrade or native effect occurred.
Current-state/disk proof, hardware power-loss durability and a host-global
cross-client transaction remain separate limits. Existing MCP clients need a
bridge reload to discover the new status tool; Vortex need not restart.

## Stage 3 foundation — 30 October 2026

The [internal file-proof client/worker](FILE-PROOF-WORKER.md) offloads streamed
hashing of explicitly admitted leaf files, with bounded requests, exact context
binding, descriptor/path/root generation checks and parent-side readback. Fresh
proofs have a new checkpoint cache. Failure, timeout or cancellation poisons the
client; it never retries or starts a replacement worker automatically.

The worker is not wired into current helpers or an MCP endpoint. The existing
guard remains synchronous. Historical callers discarded return values; new kits
include the propagation repair described below. Electron/original-fs acceptance
and a fresh native pre-effect barrier remain required. Directory
inventory, process enumeration and native-state hashing are not supplied by this
known-file worker. This stage's installer integration gate remains open. A later
exact-production renderer acceptance verified the component backend, as recorded
in [the worker contract](FILE-PROOF-WORKER.md#local-verification--30-october-2026).

All 378 maintained Node tests passed with real pinned template fixtures and no
skips, together with 21 recovery/bootstrap and 29 synthetic installer tests.
Two independent audits found no remaining confirmed blocker in this standalone
scope. A 64 MiB generated-file comparison included parent work and worker
construction; its measured scope and limits are in the worker documentation.
The temporary payload was recycled after verifying its hash and retained
reconstruction recipe. No running host, mod or game files were changed.

New own-local code kits now propagate guard Promises through settlement/poller
callbacks and conditionally wait at startup, root-ready and final readback.
An independent audit caught the microtask gap introduced by unconditional
`await` on a synchronous result; the final implementation preserves the original
same-turn behavior. Regressions exercise pending/rejected Promises and queued
state mutation. This removes lost-return hazards, but does not connect the
worker or supply the required post-await native context barrier.
The checkpoint passed 384 Node tests with the real pinned fixtures and no skips.

### Held worker-mode integration — 30 October 2026

New kits can opt into `--source-proof-mode worker`; the default cached-sync
packet remains byte-identical to the previous constructor on the real Family
input (30 files). Worker mode admits the complete reviewed template, binds the
exact source scope and uses a shared CommonJS client. Runtime modules are pinned
before import. Post-proof live guards and synchronous effect-adjacent barriers
retain the existing native context checks. Final readback stops/drains the poller,
freshly proves sources, verifies cleanup and samples source/native state before
writing completion. Mutable receipt aliases and damaged source encoding are
covered by regressions.

All 498 Node tests passed without skips. Independent reviews covered the source
scope, poller, generated barriers, finalization and plain-preparer owner drift.
The exact nine-file runtime closure separately passed eight read-only component
groups in the actual Vortex renderer, including four verified child cleanups.
The temporary probe was retired, Vortex restarted normally, and fresh session
values plus the deployment manifest matched the pre-maintenance baseline.

This does not accept a generated installer executing a real intended package.
The new mode remains held until fresh operation/source/state admission; no
general install/remove endpoint is exposed. Source-only offloading also leaves
the full guard's repeated metadata traversal and synchronous process checks.

## Stage 4 preflight foundation — 30 October 2026

The [31 October continuation](LOCAL-INSTALL-IMPLEMENTATION.md) separates native
source/ownership/terminal gates from a pure tracked-install job model. Neither
the model nor archive-sealing mechanics grants invocation permission.

The new pure own-install evaluator checks an exact archive and bounded detached
inventory against the source-reviewed collision and previous-provider branches.
It rejects defined native provider IDs, shared archive references, owner/path
aliases, unknown profile flags, unsupported metadata and incomplete projections.
Eleven regressions and 18 real-family binder checks passed without skips.
Independent review repaired the distinction between full native quick metadata
and its ID-only projection, raw installed associations and reserved owner names.

`modelAccepted` proves only this model's checks. Source/extractor admission,
inventory completeness, native metadata capture, context freshness and dependency
closure remain unverified. It supplies no permit or effects endpoint. Fresh native
proof, durable host-wide exclusion and post-install readback are still required.

## Stage 5 retention foundation — 30 October 2026

The [keeper](KEEPER-RETENTION.md) verifies a pinned explicit consumer catalog,
retains exact files and restores them into another isolated directory. It uses
the existing ZIP/CRC/payload inspector and strict JSON parser. A permanent target
reservation, unique owned temporary directory and Windows no-overwrite publication
preserve partial evidence and refuse replay. Restore follows retained copies,
never historical absolute input paths.

Fourteen regressions passed, including original inputs absent during restore,
tampering, foreign directory replacement, publication races and Windows filename
aliases. Independent review found and repaired case-folded artifact collisions;
source and copied-file generations are checked again after publication.
Actual offline acceptance retained seven package/evidence artifacts and restored
their exact bytes/payload proof without changing originals. Unknown external
consumers and native preference/profile recovery were explicitly retained as gaps.

This is a retained-byte/archive restore, not a rebuild or installation through
Vortex. Consumer assertions are not independently proven exhaustive. Retirement
still requires owner review and returns no deletion actions, even with an empty
unknown-consumer list. No mod, profile or download was removed.

## Stage 7 verification — 30 October 2026

The [API cache helper](PRISTINE-API-CACHE.md) now exposes read-only status before
generation. Full input/tool/recipe pins and immutable acceptance receipts govern
reuse; failed or incomplete attempts are held rather than overwritten or bypassed.
The installed compatibility wrapper forwards to this maintained source.

The current input matched its local installed Steam depot manifest. That parser
does not authenticate Valve's signature, so local metadata agreement is the
provenance boundary. After dependency review, standalone CLI 0.5.32 replaced
0.5.31 in the authoring manifest. After checking consumers, the old executable
was moved to the Windows Recycle Bin; provenance and the failed log remain intact.
One generation produced 22,728,153 bytes in an observed 844 ms helper run.
Independent inspection and repeat calls verified receipt/output hashes and reuse
without invoking the tool. Required declarations passed; full API coverage and
gameplay remain unproven. Installed SCC, Vortex and game files were not changed.

Twenty cache regressions and three existing compatibility-wrapper lock tests
passed. The broader checkpoint passed 378 Node tests without skips, 41 Python
recovery/bootstrap/cache tests and 29 synthetic installer tests.
Skill tree/alias/link checks passed; native OpenCode discovery was subsequently
verified under stage 8. The initial Python environments lacked PyYAML. Both
affected canonical skills subsequently passed the maintained validator using
the existing skill-validation environment; no package installation was needed.

## Stage 8 hook and discovery verification — 30 October 2026

The [exact legacy Rusty-hook retirement](LEGACY-GIT-HOOKS.md) passed eleven
synthetic regressions and was applied to the coordination workspace after
checking the effective hooks path and stopping concurrent Git work. All 19
template entrypoints and two helpers were copied and verified before retirement.
The inactive backup, immutable attempt and completion record remain under `.git`.
The only remaining active hook checks staged whitespace; unknown/sample hooks,
the Rusty config and unrelated dirty source were preserved. No Rust install ran.

The local shared skill checker now retries only missing native discovery names,
bounded to six calls and one 45-second deadline. Duplicates and owner/body/path
errors still fail immediately. Twenty checker tests passed; all four fresh
native snapshots returned 29 skills with exact required owner/body matches.
The earlier empty/two-item responses are consistent with asynchronous plugin
registration; their historical startup trigger was not independently reproduced.
No OpenCode configuration, model call or service restart was needed.

The framework route audit preserved the historical 0.2.22-specific verifier.
The current own compiler snapshot helper had a separate gap: it hashed copied
framework files without proving the installed sources stayed stable. That owning
source project now pins both opaque inputs before/after exclusive copy and before/
after compilation. Eleven fake-compiler regressions passed, including concurrent
mutation and preservation of a foreign copy destination. Installed 0.2.28 metadata
and the two input hashes were checked read-only. No actual compiler, mod build or
game test ran for that tooling change; its two-file scope is explicit.
