<div align="center">

# Nexus Modding Tools

**Guarded Nexus Mods & Vortex automation for Windows.**

Inspect a running session. Review changes offline. Keep recovery evidence intact.

[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D4)](docs/RESTORE.md) [![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-2563EB)](LICENSE) [![Community project](https://img.shields.io/badge/community-project-0F766E)](#project-and-license)

[Get started](docs/RESTORE.md) · [Configuration](docs/CONFIGURATION.md) · [Agent workflow](docs/AGENT-WORKFLOW.md) · [Verification](docs/FULL-AUDIT-20261025.md)

</div>

---

## Three tools, one workflow

| Tool | What it does | Guide |
| --- | --- | --- |
| **Vortex adapter** | Read profiles, mods, downloads and conflicts; perform guarded download-only, enable and deploy operations | [Adapter reference](tools/modding/vortex-agent/README.md) |
| **Nexus CLI** | Search public metadata, inspect requirements and identify archives | [CLI setup and usage](tools/modding/nexus-cli/README.md) |
| **Publication runner** | Validate an archive offline, then run an authorized update through the pinned official uploader | [Publication contract](tools/modding/nexus-publish/README.md) |

The resident adapter reuses the running Vortex process. Supported reads and managed
operations do not need a temporary plugin, restart or client-driven window changes.
Writes check the active profile, paths and filesystem identities, and retain durable
operation receipts. Uncertain effects block retries until reviewed reconciliation.

## Start here

**New machine or first installation?** Follow [Restore the tooling](docs/RESTORE.md).
It covers source verification, pinned build inputs, local credentials, extension
installation and client configuration. A clone alone does not install the tools.

**Already have a working adapter?** Run these commands from the repository root:

```powershell
node tools/modding/vortex-agent/bridge.mjs --health
node tools/modding/vortex-agent/session.mjs inspect
```

Vortex and its resident extension must already be running. If the installation
uses a different runtime workspace, set the matching process-local
`NEXUS_WORKSPACE` first; see [configuration](docs/CONFIGURATION.md). Keep the
existing credential and receipt directories when changing source checkouts.

**Ready to change enabled mods?** Start with the
[reviewed-plan workflow](docs/NO-RESTART-WORKFLOW.md). Plan validation is offline
by default; applying it requires an explicit `--apply`. The queue processes
changes serially and performs at most one requested final deploy.

### Requirements

| Component | Requirement |
| --- | --- |
| Host | Windows, Git and a separately installed Vortex |
| Python tools | Python 3.11 or newer |
| Publisher | Node 24 with built-in Undici 7.18.2 or newer in the 7.x line |
| Adapter build | [Pinned build requirements](docs/DEPENDENCY-AUDIT.md) |
| Community CLI | Separately installed .NET 10 runtime for the pinned Windows x64 release |

## Boundaries that matter

- **No automatic mod installation.** Native Vortex installation can silently
  replace an existing mod. The adapter therefore refuses generic installation;
  read [the installation boundary](tools/modding/vortex-agent/LOCAL-PACKAGE-INSTALL-DESIGN.md).
- **No unrestricted control.** There is no generic dispatch, game-launch or
  profile-switching API. Vortex can still show its own native dialogs.
- **Local credentials stay local.** The source contains no keys, account session,
  Vortex database, game files or mod downloads. Each new Windows account initializes
  its own credentials; existing stores are not copied into recovery archives.
- **Evidence has a scope.** Adapter receipts do not prove disk deployment or
  gameplay. Compare manifest owners, bytes and hardlinks separately; game behavior
  needs its own acceptance test.

## Documentation

| I want to… | Read |
| --- | --- |
| Set up or recover the tools | [Restoration](docs/RESTORE.md) |
| Choose paths, credential locations or client settings | [Configuration](docs/CONFIGURATION.md) |
| Inspect Vortex or apply a reviewed plan without restarting it | [Running-session workflow](docs/NO-RESTART-WORKFLOW.md) |
| Choose the right skill, tool and verification boundary | [Agent workflow](docs/AGENT-WORKFLOW.md) |
| Review tested behavior and known limits | [Full integration audit](docs/FULL-AUDIT-20261025.md) |
| Check dependency pins and point-in-time audit evidence | [Dependency audit](docs/DEPENDENCY-AUDIT.md) |
| Understand licenses and upstream attribution | [Licenses and provenance](docs/LICENSES.md) |

## Development and verification

`main` is the integration branch. Read [AGENTS.md](AGENTS.md) before changing
tooling, and use short-lived branches for review. Remove a completed task branch
only after its commits are merged and no worktree still uses it.

Useful local checks, run from the repository root:

```powershell
python -B scripts/recovery.py verify
python -B -m unittest discover -s tests -v
node --test tools/modding/vortex-agent/session.test.mjs
```

The tool READMEs describe their broader suites and prerequisites. Source changes
must also update the reviewed recovery inventory as described in
[AGENTS.md](AGENTS.md). Run checks locally; do not infer live compatibility from
a unit test or dispatch hosted workflows without authorization.

### Repository layout

```text
tools/modding/    Maintained adapter, CLI wrapper and publication runner
scripts/         Source verification, recovery and pinned build-tool bootstrap
tests/           Recovery and bootstrap regressions
dependencies/    Source-pinned Vortex MCP component and retained notices
recovery/        Historical accepted-source snapshots and import provenance
docs/            Setup, workflows, verification records and license guidance
```

Runtime files and build outputs belong in ignored `local-state/`. Historical
recovery snapshots are evidence, not a second maintained implementation.

## Project and license

This is a **community project**, not an official Nexus Mods or Vortex product.
The combined project and adapted Vortex component use **GPL-3.0-only**.
Independent MIT and Apache dependencies retain their own notices.

Built on [Alan Tse's vortex-mcp](https://github.com/alandtse/vortex-mcp), the
[community Nexus CLI](https://github.com/vadimtrifonov/nexusmods-cli) and the
[official Nexus uploader](https://github.com/Nexus-Mods/upload-action).
See [LICENSE](LICENSE) and [component attribution](docs/LICENSES.md).
