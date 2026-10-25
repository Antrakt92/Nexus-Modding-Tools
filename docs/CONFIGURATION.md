# Local configuration

Paths are resolved independently of the current working directory. Environment
variables select local directories, not accounts or credentials. Use absolute
paths; the tooling rejects relative overrides.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXUS_WORKSPACE` | Repository root | Runtime files under `local-state` |
| `NEXUS_CONTEXT_ROOT` | `<workspace>/local-state/upstream-sources` | Pinned external source checkouts |
| `NEXUS_UPLOAD_ACTION_ROOT` | `<context-root>/nexus-upload-action` | Explicit verified uploader checkout |
| `NEXUS_STATE_DIR` | `<workspace>/local-state/nexus-publish-setup` | Persistent publication attempts, locks and receipts |
| `NEXUS_GAME_ROOTS_JSON` | Unset | JSON array of absolute game directories for installer snapshots; explicit `--game-root` flags are also supported |

For example, in the shell used for these tools:

```powershell
$env:NEXUS_WORKSPACE = 'C:/NexusWorkspace'
$env:NEXUS_CONTEXT_ROOT = 'C:/NexusWorkspace/local-state/upstream-sources'
```

The recovery helper uses `--workspace` or `NEXUS_WORKSPACE` for source recovery;
its `sources` command restores into that workspace's default upstream directory.
Use `NEXUS_CONTEXT_ROOT` when an already verified checkout is intentionally
elsewhere. Do not point it at a modified checkout to bypass source verification.

## Files that stay local

- Vortex bearer: `<workspace>/local-state/vortex-agent-build/credentials`, encrypted
  with Windows DPAPI for the current user. Initialize with
  `node tools/modding/vortex-agent/credential.cjs --initialize` on each new account.
- Adapter attempts and receipts: `<workspace>/local-state/vortex-agent-build/receipts`.
  Uncertain operations remain interlocked until explicitly reconciled.
- Adapter package/build outputs: `<workspace>/local-state/vortex-agent-build`.
- Nexus CLI executable: `<workspace>/local-state/nexus-cli`.
- Nexus API key: Windows Credential Manager, using the CLI's existing verified
  credential target. The public tools do not migrate it or extract Vortex's key.
- Publication ledger: `NEXUS_STATE_DIR`. Keep this directory across versions and
  interrupted uploads; never move it merely to get around an existing attempt.

Do not commit these directories, account exports, client databases, cookie files,
game files, mod downloads or crash reports. A Git source backup does not preserve
operational uncertainty records from an in-flight upload or Vortex mutation.

## MCP client entry

The bridge is `tools/modding/vortex-agent/bridge.mjs`; its transport endpoint is
the authenticated loopback service inside the already running Vortex extension.
Keep the bridge and installed package configured for the same runtime workspace.
The package records its compile-time workspace; an explicit process environment
override must be deliberate and consistent.

`scripts/recovery.py configure --apply` creates a generic JSON template, not a
universal client installer. Some clients use TOML or another schema. Review and
merge only the required entry; do not overwrite a working configuration.

## Publication

Without `--publish`, the publication runner validates locally and cannot upload.
For an authorized upload it accepts `--credential prompt`, `windows-cli`, or
`github-secret`. Interactive keys are hidden; the Windows reader accesses only
the verified credential target. No key belongs in a manifest or command argument.
`NEXUS_PUBLISH_KEY` is reserved for an explicitly selected workflow-secret mode;
it is not a general configuration example.

The inactive self-hosted workflow template additionally requires a repository
variable `NEXUS_STATE_DIR` outside `RUNNER_TEMP` and `GITHUB_WORKSPACE`. It is
dispatch-only, defaults to dry-run and is not automatically enabled by restore.
See [publication details](../tools/modding/nexus-publish/README.md).

## Window behavior

The resident client does not call window, launch or restart APIs. Vortex itself
may show a native dialog during a requested operation. Starting minimized is not
a guarantee against a brief window: the inspected Vortex startup shows then
hides its main window. Use the running adapter instead of restarting it for
ordinary reads, downloads, enable changes or deployment.
