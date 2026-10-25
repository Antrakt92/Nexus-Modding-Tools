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
node tools/modding/vortex-agent/session.mjs inspect
node tools/modding/vortex-agent/session.mjs plan reviewed-plan.json
```

The plan command is offline by default. Add `--apply` only for an authorized,
reviewed plan. It uses stable request IDs, serial enable changes and one optional
final deployment, then checks acknowledgements and exact terminal receipts.
See [the no-restart workflow](../../../docs/NO-RESTART-WORKFLOW.md).

The client does not call window or restart APIs. Vortex itself can still show a
legitimate native dialog during a requested operation. Starting minimized is
not a guarantee against a brief window.

## Paths and authentication

`NEXUS_WORKSPACE` defaults to the repository root. Runtime build files,
credentials and receipts live in its ignored `local-state` directory.
`NEXUS_CONTEXT_ROOT` defaults to `<workspace>/local-state/upstream-sources`.
Overrides must be absolute. Compiled packages retain their build workspace;
keep the installed package and bridge environment consistent.

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
python -B tools/modding/vortex-agent/install.test.py
```

Wire/package tests additionally require the locally prepared compiled package.
The isolated native fixture uses a separate user-data directory and synthetic
files. It requires an explicitly supplied support extension/hash, never launches
a game, and checks original-file restoration and ordinary-session preservation.
It does not prove real Nexus acquisition, ordinary-profile deployment or gameplay.

The current portable candidate passed the isolated Vortex 2.9 native fixture;
the ordinary running adapter remains a separately accepted older package.
Earlier Vortex 2.7/2.8 source-target fields and the
[accepted source snapshot](../../../recovery/accepted-adapter/README.md) are
historical evidence, not today's installed-host version or acceptance claim.
Use the exact package SHA/provenance and fresh health, not version labels alone.

Current dependency pins, audit results and build limitations are recorded in
[the dependency audit](../../../docs/DEPENDENCY-AUDIT.md). Do not carry forward
an old audit count as a current security verdict.
