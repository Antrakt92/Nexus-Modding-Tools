# Guarded Vortex adapter

An authenticated local MCP adapter for selected Vortex operations. It reuses
the running Vortex process; ordinary reads, Nexus download-only acquisition,
enable changes and deployment need no temporary extension or restart.

This is an adapted GPL-3.0-only community project based on
[Alan Tse's vortex-mcp](https://github.com/alandtse/vortex-mcp). The vendor source
has broader capabilities than this adapter. Generic dispatch, game launch,
profile switching, automatic installation and unrestricted API access are not
part of this guarded surface.

## Use the running session

From the repository root:

```powershell
node tools/modding/vortex-agent/bridge.mjs --health
node tools/modding/vortex-agent/bridge.mjs --call read_native_preflight '{}'
node tools/modding/vortex-agent/session.mjs inspect
node tools/modding/vortex-agent/session.mjs plan reviewed-plan.json
```

The plan command is offline by default. Add `--apply` only for an authorized,
reviewed plan. It uses stable request IDs, serial download/enable changes and one optional
final deployment, then checks acknowledgements and exact terminal receipts.
See [the no-restart workflow](../../../docs/NO-RESTART-WORKFLOW.md).

Adapter 1.1.0 includes [resident native preflight](../../../docs/NATIVE-PREFLIGHT.md):
the actual deployment-target table, application version and updater status from
fixed native getters. Reads preserve target aliases and reject context drift;
unavailable getters remain explicit partial results. No temporary helper or
restart is needed per read after the adapter upgrade. This does not approve
installation or shutdown.

For update or removal preparation, the current source adds the bounded read-only
[`read_mod_lifecycle` preflight](../../../docs/LIFECYCLE-PERFORMANCE.md): exact
installed IDs, usage across profiles, native incoming requirements and global
archive references. It requires the new resident bundle and grants no effects.

The client does not call window or restart APIs. Vortex itself can still show a
legitimate native dialog during a requested operation. Starting minimized is
not a guarantee against a brief window.

## Paths and authentication

`NEXUS_WORKSPACE` defaults to the repository root. Runtime build files,
credentials and receipts live in its ignored `local-state` directory.
`NEXUS_CONTEXT_ROOT` defaults to `<workspace>/local-state/upstream-sources`.
Overrides must be absolute. Compiled packages retain their selected runtime
workspace; `NEXUS_RUNTIME_WORKSPACE` selects it independently of build artifacts.
Keep the installed package and bridge environment consistent. The installer
accepts an explicit `--package-root` but refuses a different runtime workspace
before replacing anything, preserving the existing credential and receipt paths.

`manage-install.py sync-provenance --expected-sha <installed-bundle-sha256>`
updates only installed provenance for that exact bundle. It also accepts
`--package-root <absolute-verified-package-directory>` when build artifacts live
outside the runtime workspace. Source pins, package licenses, runtime workspace
and receipt preservation are still checked; the flag does not bypass them or
replace the running bundle. Snapshot and compare reject this flag.

On a new Windows account, initialize the per-user bearer explicitly:

```powershell
node tools/modding/vortex-agent/credential.cjs --initialize
```

The token is DPAPI-encrypted and never printed. Existing credentials are not
overwritten. This does not initialize or extract a Nexus API key. See
[configuration](../../../docs/CONFIGURATION.md) and
[restoration](../../../docs/RESTORE.md) before changing a working setup.

## Curated operations

Reads include health, profiles, installed-mod/download projections, mod rules
and dependents, bounded file conflicts, native unresolved conflicts, collection
health observations, dialogs and external changes. They do not expose raw
Vortex state or account/config exports. Collection health returns observed
numbers/booleans; it does not infer installation completion or force recalculation.

The bridge also exposes `inspect_session` with optional `{ "diagnostics": true }`.
It composes existing curated reads with at most four in flight, checks context
before and after, and reports per-read errors and inventory caps. Diagnostics add
native unresolved conflicts and collection observations without a staging scan.
A partial snapshot is an MCP error with retained successful results, never a
healthy empty inventory. `status: "ok"` means the reads completed; inspect the
returned observations to assess conflicts or collection state. It is not an
atomic snapshot or disk proof. This client-side tool needs a bridge/client reload
in existing MCP sessions, but no Vortex restart or extension upgrade. The bridge
CLI can call it immediately. See [usage](../../../docs/NO-RESTART-WORKFLOW.md).

`run_mod_plan` brings that reviewed workflow to MCP: offline validation by
default, explicit `apply:true` for pinned Nexus download-only steps, batched
enable/disable changes and at most one requested final deploy. Initial receipt
checks overlap at most four at a time; mutations stay serial. Cancellation or
disconnection stops later steps after an invoked write's receipt is reconciled.
Apply persists the exact plan and a durable intent before each write; the full
`planId` also supports read-only `inspect_mod_plan` or `session.mjs plan-status`.
Existing journals cannot be replayed or resumed. Status reports historical
receipts, uncertainty and missing local history, without claiming current state
or deployment proof. All clients must retain the same configured runtime
workspace. It does not install or replace mods. See the
[plan guide](../../../docs/NO-RESTART-WORKFLOW.md#run-the-reviewed-plan-through-mcp).

For collection preparation, use the bridge-local `find_collection_downloads`
tool with the expected active `gameId` and up to 100 exact Nexus mod/file pairs.
One bounded inventory read returns compact matching download IDs and states,
duplicate candidates and unknown identity counts. It shares the session reader's
context/cap/error handling and makes no managed changes. See the
[collection-download guide](../../../docs/COLLECTION-DOWNLOADS.md) for the schema,
partial-result rules and the separate archive-verification gate.

Supported writes are deliberately separate:

| Operation | Contract |
| --- | --- |
| `set_mods_enabled` | Installed records, exact IDs and effective flags; auto-deploy disabled |
| `deploy_mods` | Native `awaitModsDeployment(profileId)`; no manual bypass |
| `download_nexus` | Exact Nexus IDs, archive size/hash and context pins; download-only, with verified existing-download reuse |
| `install_download` | Refused before installation; not advertised by the bridge |

Writes require an explicit request ID, active game/profile, canonical
game/staging/download paths and filesystem identity pins. The adapter checks
that the game/tools are stopped, persists attempt/interlock evidence and
rechecks eligibility immediately before effects. No cached absence of a game
process authorizes a later write.

The [native-install design](LOCAL-PACKAGE-INSTALL-DESIGN.md) explains why a fresh
archive name and `allowAutoEnable:false` do not prove non-replacement. A queue
around the same native install event would not repair that boundary.

### Prepare one own-local helper offline

`own-helper-binder.mjs` prepares a held helper from one pinned, reviewed
Clean Inventory template family. It checks the ZIP's CRCs, sizes, hashes,
complete payload and pinned source/build evidence before producing anything.
It does not contact Vortex or install, enable or deploy a mod.

```powershell
node tools/modding/vortex-agent/own-helper-binder.mjs --reference ABSOLUTE_TEMPLATE_DIRECTORY --plan ABSOLUTE_PLAN_JSON --plan-sha256 RAW_PLAN_SHA256 --output ABSOLUTE_NEW_LOCAL_STATE_DIRECTORY
```

The default is a dry run. On Windows, `--apply` writes a new inactive directory
under this checkout's ignored `local-state`; existing outputs are refused.
The template itself is environment-specific: this is not a portable installer.
The output explicitly lists missing current-session bindings and still needs
source/build review, native admission and a separately reviewed materializer.
Old approvals, baselines, attempts and completions are never inherited.
See the [input and output contract](../../../docs/OWN-LOCAL-BINDER.md) and
[implementation checklist](../../../docs/LIFECYCLE-IMPLEMENTATION.md).

For a native read capture without packages, use the separate
[read-capture preparer](../../../docs/READ-CAPTURE-PREPARATION.md). It reconstructs
one pinned read-only family, omits historical optional diagnostics and leaves
current-session bindings empty. It does not install an extension or capture a
running host; code verification is separate from native execution approval.
The [external baseline CLI](../../../docs/READ-CAPTURE-BASELINE.md) checks protected
hardlink pairs and preference files before native capture. Its default plan avoids
a full payload hash pass; explicit capture writes only new local evidence.

For reviewed task-owned one-shots, the [installation settlement observer](install-settlement.md)
provides pinned record/flag checks and specific waiting diagnostics without
resetting its quiet window for unrelated metadata. It must be copied and pinned
in the next helper; existing frozen helpers and the live adapter are unchanged.

The internal [file-proof worker foundation](../../../docs/FILE-PROOF-WORKER.md)
checks bounded known-file lists with checkpoint-local hashes, stale-reply
rejection and parent-side metadata checks. Exact production components passed
read-only probes inside Vortex 2.9.1. Helper preparation can opt into shared
source proofs with `--source-proof-mode worker`; the default remains
`cached-sync`. Generated kits stay inactive pending their native admission checks.
The worker is not a general-purpose adapter operation, and these component probes
do not establish native installer acceptance or an installation speedup.

## Receipts and uncertainty

Operations serialize through a filesystem lock. Attempts, failures and committed
completion receipts live under `<workspace>/local-state/vortex-agent-build/receipts`.
An unresolved effect blocks further mutations. Changing a request ID or creating
another client does not clear it.

`reconcile_operation` is read-only. It compares exact receipt identity/schema and
current bounded observations, but never clears an interlock or retries an effect.
Inspect an uncertain operation before any manual recovery; do not remove a lock
merely because a callback timed out.

Success always reports `diskDeploymentVerified:false`. Independently compare the
deployment manifest, owners, preserved hashes, staged/game bytes and hardlinks.
Game behavior needs a separate user test. Source compatibility, MCP connectivity,
package installation and gameplay acceptance are different gates.

## Build and verification

[Restoration](../../../docs/RESTORE.md) contains the source-locked build sequence.
The vendored dependency snapshot has original/current file pins and a documented
local change set. Compile receipts bind the accepted inputs and workspace;
packaging refuses drift.

Local modeled tests:

```powershell
node --test tools/modding/vortex-agent/tests.mjs tools/modding/vortex-agent/review.test.mjs tools/modding/vortex-agent/rereview.test.mjs tools/modding/vortex-agent/audit-fixes.test.mjs tools/modding/vortex-agent/native-conflicts.test.mjs tools/modding/vortex-agent/process-guard.test.mjs tools/modding/vortex-agent/session.test.mjs tools/modding/vortex-agent/stdio.test.mjs tools/modding/vortex-agent/response-cleanup.test.mjs
node --test tools/modding/vortex-agent/inspection-client.test.mjs
node --test tools/modding/vortex-agent/catalog-snapshot.test.mjs tools/modding/vortex-agent/collection-downloads.test.mjs
python -B tools/modding/vortex-agent/install.test.py
```

Wire/package tests additionally require the locally prepared compiled package.
The isolated native fixture uses a separate user-data directory and synthetic
files. It requires an explicitly supplied support extension/hash, never launches
a game, and checks original-file restoration and ordinary-session preservation.
It does not prove real Nexus acquisition, ordinary-profile deployment or gameplay.

The portable package passed the isolated Vortex 2.9 native fixture and a later
ordinary-session upgrade/read/no-op acceptance check. See
[the verification record](../../../docs/AUDIT-20261025.md) for the precise scope.
Earlier Vortex 2.7/2.8 source-target fields and the
[accepted source snapshot](../../../recovery/accepted-adapter/README.md) are
historical evidence, not today's installed-host version or acceptance claim.
Use the exact package SHA/provenance and fresh health, not version labels alone.

Current dependency pins, audit results and build limitations are recorded in
[the dependency audit](../../../docs/DEPENDENCY-AUDIT.md). Do not carry forward
an old audit count as a current security verdict.
The [29 October follow-up](../../../docs/AUDIT-20261029.md) records newer HTTP
dependency pins, stricter read validation, the update review and the remaining
inventory-read investigation and the subsequent authorized live upgrade and
preservation checks. An isolated build alone remains separate from host activation.
