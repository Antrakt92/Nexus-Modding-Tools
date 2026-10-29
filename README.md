<div align="center">

# Nexus Modding Tools

**Nexus Mods and Vortex tools for Windows.**

[![Release: 0.2.0](https://img.shields.io/badge/release-0.2.0-0F766E)](https://github.com/Antrakt92/Nexus-Modding-Tools/releases/tag/v0.2.0) [![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D4)](docs/RESTORE.md) [![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-2563EB)](LICENSE)

[Get started](docs/RESTORE.md) · [What's new](CHANGELOG.md) · [Configuration](docs/CONFIGURATION.md) · [Verification](docs/FULL-AUDIT-20261029.md)

</div>

---

## Tools

| Tool | What it does | Guide |
| --- | --- | --- |
| **Vortex adapter** | Read profiles, mods, downloads and conflicts; perform guarded download-only, enable and deploy operations | [Adapter reference](tools/modding/vortex-agent/README.md) |
| **Nexus CLI** | Search public metadata, inspect requirements and identify archives | [CLI setup and usage](tools/modding/nexus-cli/README.md) |
| **Publication runner** | Validate an archive offline, then run an authorized update through the pinned official uploader | [Publication contract](tools/modding/nexus-publish/README.md) |

The resident adapter reuses the running Vortex process. Supported reads and managed
operations do not need a temporary plugin, restart or client-driven window changes.
Writes check the active profile, paths and filesystem identities, and retain durable
operation receipts. Uncertain effects block retries until reviewed reconciliation.

## Session workflows

| Workflow | Entry point | Result |
| --- | --- | --- |
| Inspect the active session | MCP `inspect_session` or CLI `session.mjs inspect` | Combined curated reads, optional collection/conflict diagnostics and explicit partial results |
| Reuse collection downloads | MCP `find_collection_downloads` | Match up to 100 exact Nexus mod/file pairs against tracked archives |
| Apply a reviewed plan | MCP `run_mod_plan` or CLI `session.mjs plan` | Offline validation, pinned download-only steps, batched enable/disable changes and one optional final deploy |
| Prepare a native install helper | Offline `prepare-native-helper.mjs` | Held code kit for the supported single-package Cyberpunk template, maintained observers and complete module/copy-map verification |

Independent reads overlap; managed changes stay serial. Plans retain stable
request IDs and reconcile receipts before continuing. Cancellation stops later
steps after any invoked operation settles. See the
[session guide](docs/NO-RESTART-WORKFLOW.md) and
[collection download guide](docs/COLLECTION-DOWNLOADS.md).

Version **0.2.0** identifies this source release. The embedded adapter's **1.0.4**
label is separate. Existing clients need their MCP connection refreshed to load
new bridge code; native adapter changes require the reviewed upgrade procedure.

Release 0.2.0 adds the
[native helper preparation workflow](docs/NATIVE-HELPER-PREPARATION.md).
Preparation does not activate a plugin or grant installation approval. See the
[changelog](CHANGELOG.md) and [maintenance and release review](docs/MAINTENANCE.md)
for the release range, accepted dependency updates and remaining verification.

Unreleased work on `main` also includes source-pinned
[tracked Nexus preparation and fresh capture](docs/TRACKED-NEXUS-HELPER-REVIEW.md).
These are held code kits, not resident installation endpoints or live approvals.

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

## Supported operations and limits

- **No automatic mod installation.** Native Vortex installation can silently
  replace an existing mod. The adapter therefore refuses generic installation;
  read [the installation boundary](tools/modding/vortex-agent/LOCAL-PACKAGE-INSTALL-DESIGN.md).
- **No unrestricted control.** There is no generic dispatch, game-launch or
  profile-switching API. Vortex can still show its own native dialogs.
- **Local credentials stay local.** The source contains no keys, account session,
  Vortex database, game files or mod downloads. Each new Windows account initializes
  its own credentials; existing stores are not copied into recovery archives.
- **Verification limits.** Adapter receipts do not prove disk deployment or
  gameplay. Compare manifest owners, bytes and hardlinks separately; game behavior
  needs its own acceptance test.

## Documentation

| I want to… | Read |
| --- | --- |
| Set up or recover the tools | [Restoration](docs/RESTORE.md) |
| Choose paths, credential locations or client settings | [Configuration](docs/CONFIGURATION.md) |
| Inspect Vortex or apply a reviewed plan without restarting it | [Running-session workflow](docs/NO-RESTART-WORKFLOW.md) |
| Choose the right skill, tool and verification boundary | [Agent workflow](docs/AGENT-WORKFLOW.md) |
| Review tested behavior and known limits | [Latest full tooling audit](docs/FULL-AUDIT-20261029.md), [earlier integration evidence](docs/FULL-AUDIT-20261025.md) |
| Check dependency pins and point-in-time audit evidence | [Dependency audit](docs/DEPENDENCY-AUDIT.md) |
| Review branch policy, dependency decisions and the next release | [Maintenance](docs/MAINTENANCE.md) |
| Understand licenses and upstream attribution | [Licenses and provenance](docs/LICENSES.md) |

## Development and verification

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and source-inventory
updates. The tool READMEs describe additional suites and prerequisites.

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

## My Cyberpunk 2077 projects

### Past the Night collection

[**Past the Night**](https://www.nexusmods.com/games/cyberpunk2077/collections/scqalj)
is a Cyberpunk 2077 collection with additional quests and interactions, visual
mods, fixes and maintained collection patches.

### Mods on Nexus Mods

| Mod | What it adds |
| --- | --- |
| [Clean Inventory — Search and Filters](https://www.nexusmods.com/cyberpunk2077/mods/34413) | Search, category filters and separate sorting preferences for inventory, stash and vendors |
| [Nearby Auto Loot — Automatic Pickup](https://www.nexusmods.com/cyberpunk2077/mods/34650) | Configurable automatic pickup of nearby loot |
| [Smart Vendor — Automatic Selling](https://www.nexusmods.com/cyberpunk2077/mods/34656) | Automatic selling of eligible junk, duplicate equipment and surplus supplies |
| [Skip Intro and Auto Continue](https://www.nexusmods.com/cyberpunk2077/mods/34645) | Skip startup intros and automatically confirm Continue after loading a save |
| [FSR Exit Guard — AMD Crash on Exit](https://www.nexusmods.com/cyberpunk2077/mods/35845) | A targeted workaround for an AMD FSR-related crash when quitting the game |
| [Move Your Way](https://www.nexusmods.com/cyberpunk2077/mods/36249) | Movement settings for recovery, climbing, air dashes and extra jumps |
| [Past the Night — Collection Patches](https://www.nexusmods.com/cyberpunk2077/mods/35196) | Fixes for the Past the Night collection |
