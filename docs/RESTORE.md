# Restore the tooling on another Windows computer

This restores source and prepares local tooling. It does not restore a Vortex
database, game files, mod collection, credentials or account session. Existing
files that differ are refused; recovery never resets or cleans a checkout.

Use Python 3.11+, Git and a compatible Node installation. The publisher requires
Node 24 with built-in Undici 7.18.2+ in the 7.x line. The adapter build's current
requirements are in [the dependency audit](DEPENDENCY-AUDIT.md). Install Vortex
itself separately. Commands below run from this repository's root.

## 1. Verify the source snapshot

```powershell
python scripts/recovery.py verify
```

The final `recovery-manifest.json` pins the distributed source. A changed or
missing input stops verification. This is source integrity, not a signature or
proof that an upstream package is safe.

Choose an absolute runtime workspace; it may contain spaces:

```powershell
$env:NEXUS_WORKSPACE = 'C:/NexusWorkspace'
```

This sets the variable only in the current shell. Leaving it unset uses this
repository as the workspace. See [configuration](CONFIGURATION.md) for all paths.

## 2. Recover the pinned upstream repositories

```powershell
python scripts/recovery.py sources --workspace "$env:NEXUS_WORKSPACE"
```

This plans recovery without downloading or changing a checkout. To execute the
reviewed plan:

```powershell
python scripts/recovery.py sources --workspace "$env:NEXUS_WORKSPACE" --apply
```

`source-lock.json` records release-bundle URLs, exact sizes, hashes and commits.
The helper verifies a bundle before fetching it into a new repository under
`<workspace>/local-state/upstream-sources`. It rejects an existing checkout with
a different commit or tracked modifications. It never copies a developer's
uncommitted working tree. An offline bundle directory can be supplied with
`--archive-dir 'C:/RecoveryBundles'`.

The maintained adapter builds from the verified source in
`dependencies/vortex-mcp`. The recovered uploader is used by the publication
runner. Recovering the CLI source does not install its executable.

## 3. Prepare the adapter build

First plan the pinned local pnpm bootstrap, then explicitly unpack it:

```powershell
python scripts/bootstrap_pnpm.py
python scripts/bootstrap_pnpm.py --apply
```

The bootstrap checks the size, SHA-512 and archive inventory recorded in
`dependencies/vortex-mcp/PNPM-BOOTSTRAP.json`. It installs no global package and
runs no package scripts. Use `--archive 'C:/RecoveryBundles/pnpm-9.15.0.tgz'`
with `--apply` for an already obtained archive.

Prepare a new isolated build tree, install its frozen dependencies with scripts
disabled, then compile and package:

```powershell
node tools/modding/vortex-agent/build.mjs --prepare
node dependencies/vortex-mcp/.tooling/pnpm-9.15.0/bin/pnpm.cjs --dir "$env:NEXUS_WORKSPACE/local-state/vortex-agent-build/upstream" install --ignore-scripts --frozen-lockfile
node tools/modding/vortex-agent/build.mjs --patch
node tools/modding/vortex-agent/build.mjs --compile
node tools/modding/vortex-agent/build.mjs --package
```

`--prepare` refuses an existing build tree. Do not delete or reset an existing
tree to bypass a mismatch; inspect its inputs and provenance. Compilation and
packaging recheck source, dependency and workspace pins. The package is under
`<workspace>/local-state/vortex-agent-build/plugin/vortex-agent`.

## 4. Initialize local credentials and review installation

On a new Windows account, explicitly initialize its local bearer:

```powershell
node tools/modding/vortex-agent/credential.cjs --initialize
```

The bearer stays in a per-user DPAPI file. Nothing is printed for copying into
client settings. Existing credentials are not overwritten. Do not copy another
computer's credential files into the repository or a recovery archive.

Installing the built Vortex extension is a separate effect. Review
`python tools/modding/vortex-agent/manage-install.py --help`, the frozen package
hash and protected-game snapshots first. The installer requires Vortex and games
to be stopped and explicit hash pins. It does not launch Vortex or a game.
Loading a new extension requires a deliberate Vortex restart; routine operations
after loading it do not. A successful build does not establish native-host or
gameplay acceptance.

For an upgrade built in a separate source workspace, set
`NEXUS_RUNTIME_WORKSPACE` to the existing runtime workspace throughout patch,
compile and package. Keep the artifact workspace separate. When installing,
set `NEXUS_WORKSPACE` to the existing live workspace and select the built package
with `--package-root 'C:/SourceWorkspace/local-state/vortex-agent-build/plugin/vortex-agent'`.
Supply both the new `--expected-sha` and existing `--from-sha` for `upgrade`.
The installer verifies the package's runtime workspace before any swap and
preserves receipts in the original workspace. Do not initialize new credentials
or move uncertainty records merely to make an upgrade connect.

## 5. Prepare client settings without overwriting them

```powershell
python scripts/recovery.py configure --workspace "$env:NEXUS_WORKSPACE"
python scripts/recovery.py configure --workspace "$env:NEXUS_WORKSPACE" --apply
```

The second command writes a matching-only JSON template under
`<workspace>/local-state/nexus-tools-recovery/client-template.json`. It does not
modify any live client configuration. Merge the entry into the format supported
by your client after review; preserve unrelated entries. The template contains
local paths and environment settings, not a bearer or Nexus API key.

With Vortex already running, use the [no-restart client](NO-RESTART-WORKFLOW.md)
for inspection and reviewed enable/deploy plans.

## Optional CLI and private instructions

`python tools/modding/nexus-cli/install.py` explicitly downloads or reuses the
pinned Windows CLI asset and verifies its archive and installed files. It is an
installation command, not a dry run. See [its README](../tools/modding/nexus-cli/README.md).
Nexus authentication must be configured separately in Windows Credential Manager.

If you own a separate private instruction snapshot, recovery can plan its skills:

```powershell
python scripts/recovery.py skills --snapshot 'C:/PrivateWorkflowBackup' --skills-home 'C:/MyAgentHome/skills'
```

Add `--apply` only after reviewing that plan. The helper verifies snapshot hashes
and every destination before writing; unrelated or differing files remain intact.
Private instructions are not included in this public repository and are not
required to use its tools.
