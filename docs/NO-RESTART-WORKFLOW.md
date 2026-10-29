# Work with the running Vortex session

`session.mjs` uses the existing authenticated bridge in one Node process. It does
not start, restart, hide, close or focus Vortex. Vortex and its resident adapter
must already be running. The bridge's SID/token cache survives across calls in
this process; credentials are not written into plans or output.

## Inspect

From the repository root:

```powershell
node tools/modding/vortex-agent/session.mjs inspect
```

This reads health, mods, downloads, dialogs and external changes. At most four
reads overlap. Health is checked again afterward to detect context changes.
The output says `partial` and exits with code 1 if a read fails, the context
changes, or a mods/downloads list reaches its 500-entry cap. It is a bounded
inspection, not an atomic snapshot or a claim that all mods work in the game.

For native unresolved-conflict and collection observations in the same snapshot:

```powershell
node tools/modding/vortex-agent/session.mjs inspect --diagnostics
```

Agents can make the same combined read through the bridge's `inspect_session`
MCP tool, with `{ "diagnostics": true }` to include those observations. The
default is the basic inspection above. It overlaps at most four existing reads
and performs no mutations, conflict recalculation or staging-file scan. Missing
diagnostic tools and unavailable native details remain per-read errors; they
are never converted into zero conflicts. A successful read can still return
unavailable (`null`) observations; `ok` describes acquisition, not collection
health. The MCP result retains successful reads and sets `isError` for `partial`.
Diagnostic responses must contain the native flags, nullable nonnegative counts
and collection counters with their expected types. Missing or malformed fields
produce `INVALID_COLLECTION_HEALTH_RESPONSE`. When a tool returns both JSON text
and structured content, they must describe the same value; contradictory copies
are refused before a snapshot or a write acknowledgement is trusted.

The equivalent command, also available before reloading an existing MCP client:

```powershell
node tools/modding/vortex-agent/bridge.mjs --call inspect_session '{"diagnostics":true}'
```

This operation is composed in the bridge, rather than added to the loaded host
extension. Existing MCP processes need reloading to discover it; Vortex stays
running. CLI partial results exit with code 1. Both paths verify context again
after the reads, but changes that leave and return to the same context between
checks cannot be excluded by this bounded, non-atomic inspection.

## Review a write plan offline

Save a JSON plan with context copied from a fresh health result. Use the actual
paths, filesystem IDs and installed Vortex mod IDs. The values below are examples:

```json
{
  "version": 1,
  "context": {
    "gameId": "cyberpunk2077",
    "profileId": "YOUR_PROFILE_ID",
    "gamePath": "F:/SteamLibrary/steamapps/common/Cyberpunk 2077",
    "stagingPath": "F:/Vortex Mods/cyberpunk2077",
    "downloadPath": "D:/Modding/Vortex/downloads/cyberpunk2077",
    "filesystemIds": {
      "gamePath": "1:2",
      "stagingPath": "1:3",
      "downloadPath": "2:4"
    }
  },
  "steps": [
    {
      "operation": "set_mods_enabled",
      "requestId": "reviewed_enable_20261025_001",
      "modIds": ["EXACT_INSTALLED_MOD_ID"],
      "enabled": true
    }
  ],
  "deploy": {"requestId": "reviewed_deploy_20261025_001"}
}
```

```powershell
node tools/modding/vortex-agent/session.mjs plan reviewed-plan.json
```

The default only validates the plan locally. It makes **zero Vortex calls**.
This proves the plan's shape, not the current profile, installed mods or files.
No request ID is generated automatically. Choose stable IDs for this particular
reviewed plan and retain the file. A request ID must be 8–80 letters, digits,
underscores or hyphens and must be unique within the plan.

## Apply the reviewed plan

```powershell
node tools/modding/vortex-agent/session.mjs plan reviewed-plan.json --apply
```

The client checks all request IDs for previous or uncertain receipts before any
write, with at most four independent receipt reads in flight. Every check must
finish successfully before the first effect. It then processes the plan serially.
Before each write, it checks that
the ID is still unused and reads fresh health to compare the game, profile,
paths and filesystem IDs against the plan. The adapter independently enforces
installed-mod eligibility, a stopped game and its ordinary context/effect guards.

`set_mods_enabled` and pinned `download_nexus` steps are accepted. Setting `deploy` to `null` skips
deployment; otherwise exactly one `deploy_mods` call runs after all steps.
Enabling a mod does not implicitly request deployment. There is no install,
replacement, generic dispatch, game launch or restart command.

Each successful step needs both a matching acknowledgement and a verified
terminal adapter receipt. The acknowledgement's fields must also match the
completion receipt, including the exact download ID. A rejected call, lost response, malformed result,
context change, existing request or uncertain receipt stops the queue. Already
completed steps remain recorded; they are not rolled back or replayed.
The queue is serial within this client, not an atomic transaction across other
Vortex clients; the adapter retains its per-operation exclusion and guards.

If it stops, inspect the returned request ID and reconcile that exact operation
through the existing adapter/receipt workflow. Do not change the IDs to get past
the refusal. The client may read reconciliation once after a failed write; it
never retries a write, clears an interlock or resumes an old plan automatically.

`completed` means the adapter verified its receipts. It always reports
`diskDeploymentVerified:false`. Independently compare the deployment manifest,
owners, staged/game hashes and hardlinks before claiming a deployed result;
gameplay acceptance is a separate user test.

## Download and activation phases

A download step requires exact reviewed size/SHA-256 pins and an explicit
`reuseOnly` boolean, in addition to the plan's existing context and request IDs:

```json
{
  "operation": "download_nexus",
  "requestId": "reviewed_download_20261029_001",
  "nexusModId": 123,
  "nexusFileId": 456,
  "size": 123456,
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "reuseOnly": true
}
```

The IDs, size and hash above are placeholders, not a usable archive pin. Obtain
the exact evidence through the established research/lifecycle workflow. A true
`reuseOnly` forbids new acquisition; false permits the guarded download-only
route if no verified tracked archive is reusable. It never permits auto-install.
Completed download steps report their exact download ID, reuse decision, size,
SHA-256 verification and `archiveCRCVerified:false`. CRC and preservation checks
remain separate. A lost acknowledgement stops the plan even if reconciliation
observes a terminal receipt; it does not authorize replay.

For a newly acquired package, end the acquisition plan with `deploy:null`, hand
its exact tracked download ID to the separately reviewed native installer, and
verify installation before preparing the activation plan. Download completion
is not installation. This queue does not implement install, import, replacement,
removal or a reference from a download result to a newly installed mod.

For an already installed update candidate, batch the explicitly reviewed old
IDs into one disable step and the new IDs into one enable step, then request one
final deploy. Each flag step accepts 1–100 exact installed IDs. Preserve the
requested ordering where intermediate state matters; the client never merges,
reorders or rewrites an existing plan or its request IDs automatically.
In the modeled ten-disable/ten-enable example, two flag batches plus deployment
use 3 guarded mutation calls and 15 total guarded calls, versus 21 mutation calls and 105
calls for individual steps. This is a call-count comparison, not a live latency
benchmark. Fresh native process/context guards remain in place for every write.

## Run the reviewed plan through MCP

The bridge exposes `run_mod_plan` with `{ "plan": PLAN }`. Its default is offline
validation and makes no upstream calls. Applying the exact authorized reviewed
plan requires `{ "plan": PLAN, "apply": true }`. Invalid and stopped plans set
MCP `isError`; successful validation and completion retain structured results.
The tool is advertised as mutating and non-idempotent, even though its default
is validation. Discovery does not grant permission for effects.

The tool uses the same executor and receipt checks as `session.mjs plan`.
Existing MCP sessions must reload their bridge to discover it. No host-extension
upgrade or Vortex restart is required. The bridge CLI can also call the tool;
its ordinary preliminary health check is additional to offline plan validation.
For long acquisition queues, the session CLI avoids a caller's MCP tool timeout.

MCP `notifications/cancelled` stops the addressed plan before its next write.
Closing the bridge input/output also cancels pending plans. If a write was
already invoked, it is allowed to settle and its receipt is checked before the
executor stops; cancellation neither rolls it back nor abandons its identity.
Completed steps remain listed. Cancelled or stopped plans never automatically
resume, clear interlocks or generate replacement request IDs. An unrelated
cancellation cannot stop another request. A client timeout that sends no
cancellation and leaves the connection open is not proof of cancellation;
reconcile the original request IDs before any recovery.

## Boundaries

The client cannot prevent Vortex itself from presenting a legitimate native
dialog during a requested operation. It does not manipulate application windows.
Routine supported operations no longer need a temporary extension or restart;
native local-package installation remains outside this client's scope.

Tests use modeled adapter responses and make no live Vortex writes:

```powershell
node --test tools/modding/vortex-agent/session.test.mjs
```
