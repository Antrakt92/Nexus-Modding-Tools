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
write. It then processes the plan serially. Before each write, it checks that
the ID is still unused and reads fresh health to compare the game, profile,
paths and filesystem IDs against the plan. The adapter independently enforces
installed-mod eligibility, a stopped game and its ordinary context/effect guards.

Only `set_mods_enabled` steps are accepted. Setting `deploy` to `null` skips
deployment; otherwise exactly one `deploy_mods` call runs after all steps.
Enabling a mod does not implicitly request deployment. There is no install,
replacement, generic dispatch, game launch or restart command.

Each successful step needs both a matching acknowledgement and a verified
terminal adapter receipt. A rejected call, lost response, malformed result,
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

## Boundaries

The client cannot prevent Vortex itself from presenting a legitimate native
dialog during a requested operation. It does not manipulate application windows.
Routine supported operations no longer need a temporary extension or restart;
native local-package installation remains outside this client's scope.

Tests use modeled adapter responses and make no live Vortex writes:

```powershell
node --test tools/modding/vortex-agent/session.test.mjs
```
