# Review a helper for tracked Nexus originals

This is a task-owned preparation/review procedure, not an installer or activation approval.
The permanent MCP still refuses native installation. The automated
[single-own-package preparer](NATIVE-HELPER-PREPARATION.md) does not support a
multi-Nexus template; do not remove its admission checks to make one pass.
No helper is installed, materialized, restarted or invoked by this procedure.

## Supported offline preparation

`prepare-tracked-nexus.mjs` recognizes one source-pinned multi-Nexus template
family and one read-capture family listed in `tracked-nexus-template.json`.
Unknown source/module hashes fail. Output is restricted to a new directory below
this source checkout's ignored `local-state/`; its parent must already exist.
It copies code only, never archives, old baselines, controls or approvals.

First review a held plan: 1–4 unique exact Nexus mod/file pairs, versions, bytes
and SHA-256 values. Actual tracked/provider/type/flag/payload/baseline bindings
remain null. Pin the plan's raw SHA-256. Then run from the tools repository:

```powershell
node tools/modding/vortex-agent/prepare-tracked-nexus.mjs --reference 'C:/Task/reviewed-multi-reference' --plan 'C:/Task/UNBOUND-TEMPLATE.json' --plan-sha256 REVIEWED_PLAN_SHA --output 'C:/Tools/local-state/new-tracked-kit'
# Add --apply to create the reviewed held output.
node tools/modding/vortex-agent/prepare-tracked-nexus.mjs verify 'C:/Tools/local-state/new-tracked-kit'
```

The generated code integrates maintained settlement with durable per-item event
receipts, exact type/download pins and a post-settlement flag check. It uses
generation-checked physical hashing, retains effect-phase guards and simulations,
and removes the unused private-overlay policy. Move Your Way preference checks
compare the fresh captured values; they do not force the old two/two values.
Native target identity is projected from the pinned map key, while a conflicting
stored ID is rejected. No completed helper is modified.
At startup, the generated installer checks the baseline against the reviewed
batch size and scope policy, including unique download and native target IDs.
The pinned reference's original two-package limit is not retained.

Generate the read-only capture code from its separately pinned source family:

```powershell
node tools/modding/vortex-agent/prepare-tracked-nexus.mjs capture --reference 'C:/Task/reviewed-capture-reference' --install-kit 'C:/Tools/local-state/new-tracked-kit' --output 'C:/Tools/local-state/new-capture-kit'
# Review the plan, then repeat with --apply.
node tools/modding/vortex-agent/prepare-tracked-nexus.mjs capture-verify 'C:/Tools/local-state/new-capture-kit'
```

Capture code preserves the admitted native metadata/previous-provider selection,
all-game mod/profile digests, complete stages and protected disk/preferences
checks. The timestamp policy is copied/pinned locally rather than loaded from a
historical task path; an old task-specific diagnostic is removed. This reviewed
capture family remains scoped to Cyberpunk and profile `ptndev1016`; it never
switches profiles. Returned `missingBindings` lists fresh inputs still required.
Preparing this code does not perform a capture or verify live freshness.

An own published Collection Patches original uses a **separate one-item Nexus
batch**, with `ownStableCPIncluded=true`, a source commit and own-source proof
SHA. It cannot be mixed into the four-original batch. Reuse its tracked original
archive, never import another local ZIP. Capture its baseline again after the
first batch's native operations are independently reconciled and verified.

## Prepare the bounded review packet

Use a new inactive task directory. Retain completed/attempted helpers, receipts
and interlocks unchanged. Keep activation held and actual baseline binding false
until a new coordinated capture is available. Historical profiles, provider
counts, package lists and settings inventories are references, not current proof.

For every item, include the exact Nexus game/mod/file IDs, selected variant and
version, official archive bytes/SHA-256, tracked download ID, payload projection,
expected native target and previous-provider IDs, intended native type/flags,
rules/overrides transfer evidence and source-admission pins. Reuse the existing
finished download: no reimport, archive copy or substitute acquisition.

After the exclusive Vortex window returns, capture fresh active context, root
paths/filesystem identities, complete stage/provider inventory, all profiles,
deployed owners/bytes/hardlinks and all protected preferences/drafts. Inspect
same-ID replacement, existing same-file providers, patched/DEV owners, userdata
and other-profile users before accepting any item. Do not infer these fields
from package size or a matching display name.

## Review and adapt the caller

The tooling owner reviews the exact entrypoint, all runtime dependencies and
source pins. Freeze one explicit batch allowlist; review its package count,
duplicate handling, scope pins and forbidden own-build items together. A copied
two-item helper or a three-item comment is not a reviewed four-item workflow.
Include every required policy JSON and module; copied `.cjs` files alone may
omit required inputs such as `scope-pins.json`.

Use the maintained `install-settlement.cjs` directly, with one exact expectation
per sequential native operation. Native mod IDs can contain spaces; they are
not download UUIDs. Pin `id`, `archiveId`, `installationPath`, `type`, payload
bytes, expected enabled flag and old IDs that must be explicitly disabled.
Project only the record selected by the pinned map key and the required flags;
do not adopt an identity from a different observed record. Supply the full
reviewed operational guard and a synchronous durable receipt writer. Reject
identity drift and stop later items after an uncertain outcome.

The old settlement module's `observe`/`flagsReady` exports are not exports of
the maintained observer or its single-own compatibility shim. The generated
Nexus kit uses its own maintained `wait`/`flagsReady` compatibility entry;
it retains the exact post-settlement flag recheck. Do not substitute the own
shim or assume a fulfilled native callback proves transfer. Keep the
earlier accepted items' records, staged payloads and profile transfers protected
through every subsequent item. Native version choice can transfer enablement
despite `allowAutoEnable:false`; this requires its own exact reviewed plan.

If adopting `physical-proof.cjs`, retain ancestry/containment checks and scope
its generation cache to the reviewed checkpoint. Preserve its invalidation at
effect boundaries. Remove duplicate `app.asar` hashes only when the same guard
pass already verifies the exact required pin; checks at different effect phases
are not interchangeable. Full guard/poller costs remain separate follow-ups.

## Gate materialization separately

The single-own preparer's `verify DIR --materialization` belongs only to its
own kit; do not fabricate that manifest to bless a different entrypoint. The
tracked-Nexus preparer has separate install/capture verifiers and requires an exact files-to-copy map, entrypoint/module and
config hashes, required policy/data files, frozen host/root approval and fresh
baseline/source/package admission. A held packet with null tracked/provider or
baseline fields is not install-ready. Source review does not grant native effects.

Both new kits contain an immutable control `COPY-MAP.prepared.json` and a complete
runtime graph. Use every runtime entry, including JSON policy data. Install kits
add `index.prepared.js` to `index.js`, `info.json`, `reviewed.json` and `frozen.json`;
capture kits use the same base without `frozen.json`. Reference source, kit manifests
and the control copy-map are not plugin entries. Current install/capture graphs
contain 20/9 runtime files, making their final copy maps 24/12 entries; derive
these counts from the kit rather than hardcoding an old host list.

Fresh binding must retain both the exact module pins and `helperSHA256`.
Prepare and review a new host/materializer, with a unique plugin path and the
current complete copy map; do not reuse the historical fixed map or host approvals.
The host must reject a wrong map **before** closing Vortex. Root materialization
creates/pins reviewed config (and install freeze data) before the host copies
anything. Null config/freeze pins are accepted only while those future files
are absent; existing files require exact SHA values. Plugin metadata must be
present and pinned for the final map check.

```powershell
node tools/modding/vortex-agent/prepare-tracked-nexus.mjs capture-verify 'C:/Task/final-inactive-capture' --materialization
node tools/modding/vortex-agent/prepare-tracked-nexus.mjs verify 'C:/Task/final-inactive-install' --materialization
```

These commands check held code/bindings/map contracts and retain
`activationGranted=false`. They do not approve a host script, execute source
admission, prove that the supplied baseline is current, or grant lifecycle effects.
Fresh root approval and actual native/disk guards remain mandatory. After a
successful read capture, review `BASELINE.json`, `STAGE-INVENTORY.json`,
`INSTALL-HELPER-BINDINGS.json`, metadata results and source admission before
binding installation; do not invent missing installer/type/transfer evidence.

Local tests:

```powershell
node --test tools/modding/vortex-agent/tracked-nexus.test.mjs
```

Set `VORTEX_TRACKED_REFERENCE` and `VORTEX_TRACKED_CAPTURE_REFERENCE` to the exact
reviewed source-family directories to include the real-template integration
case. Without the private reference, that case is explicitly skipped; the pure
policy/settlement/preference tests remain portable. Release verification must
run the integration case with both inputs, including inert-entrypoint execution,
dependency closure and map refusals. No test loads a live Vortex extension.

Run focused observer tests, reviewed generated-template tests, inert-entrypoint
tests, scope/duplicate/collision refusal cases and exact copy-map/freeze tests.
Exercise distinct per-item IDs and a later failure without replaying earlier
items. Run all required protected-stage, settings, dependency and transfer tests.
Do not repeat unrelated source suites merely to activate an unchanged package.

After separately authorized execution, require exact callback/native identity,
complete staged byte proof and preservation of protected state. Reconcile a
timeout before retrying anything. Deployment, independent owner/byte/hardlink
proof, helper retirement and gameplay acceptance remain separate boundaries.
