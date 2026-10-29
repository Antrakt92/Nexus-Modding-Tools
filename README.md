<div align="center">

![Nexus Modding Tools — Vortex automation for Windows](assets/banner.svg)

**Inspect your mod setup. Reuse downloads. Apply reviewed changes.**

[![Latest source release](https://img.shields.io/github/v/release/Antrakt92/Nexus-Modding-Tools?label=source%20release&color=0f766e)](https://github.com/Antrakt92/Nexus-Modding-Tools/releases/latest)
[![Windows](https://img.shields.io/badge/platform-Windows-0078D4)](docs/GETTING-STARTED.md)
[![GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-2563EB)](LICENSE)

[Get started](docs/GETTING-STARTED.md) · [Download source](https://github.com/Antrakt92/Nexus-Modding-Tools/releases/latest) · [Changelog](CHANGELOG.md) · [Report a problem](https://github.com/Antrakt92/Nexus-Modding-Tools/issues/new/choose)

</div>

Nexus Modding Tools connects a running **Vortex** session to an MCP-compatible
AI client or your terminal. It also includes tools for public Nexus Mods research
and author uploads. It is built for collection maintainers, mod authors and
Windows users who want repeatable operations with a record of what happened.

**Current distribution: source code, with a manual build and setup.** There is
no one-click installer. Routine inspection, downloads, enable changes and deploy
reuse the running Vortex process; native mod installation is a separate workflow.

## What you can do

| Task | How it helps | Guide |
| --- | --- | --- |
| Inspect a mod setup | Read profiles, mods, downloads, dialogs and conflicts in a combined snapshot | [Session inspection](docs/NO-RESTART-WORKFLOW.md) |
| Prepare a collection | Match exact Nexus mod/file IDs to existing tracked downloads | [Download reuse](docs/COLLECTION-DOWNLOADS.md) |
| Change enabled mods and deploy | Validate a plan offline, apply changes serially and request one final deployment | [Reviewed plans](docs/NO-RESTART-WORKFLOW.md#run-the-reviewed-plan-through-mcp) |
| Research Nexus Mods | Search public metadata and requirements through the community CLI | [Nexus CLI](tools/modding/nexus-cli/README.md) |
| Publish your own mod | Validate an archive locally and submit an authorized update through the pinned official uploader | [Publication runner](tools/modding/nexus-publish/README.md) |

The MCP bridge exposes `inspect_session`, `find_collection_downloads` and
`run_mod_plan`. Managed changes pin the active profile, paths and filesystem
identities. Durable receipts help reconcile interrupted operations before a retry.

## Start with a read

First follow the [setup guide](docs/GETTING-STARTED.md). With the adapter installed
and Vortex running, run from the repository root:

```powershell
node tools/modding/vortex-agent/bridge.mjs --health
node tools/modding/vortex-agent/session.mjs inspect
```

Example requests for your connected AI client:

> Inspect my active Vortex profile and report incomplete reads or conflicts.
>
> Find existing downloads for these exact Nexus mod and file IDs.
>
> Validate this enable/deploy plan offline before applying it.

If you use a separate runtime workspace, keep its credentials and receipts and
set the matching `NEXUS_WORKSPACE`; see [configuration](docs/CONFIGURATION.md).

## Compatibility and boundaries

- **Windows.** Git, Python 3.11+ and Node are required. The adapter build uses
  the Node 24 toolchain; the optional community CLI needs .NET 10. See
  [exact prerequisites](docs/GETTING-STARTED.md#requirements).
- **Vortex 2.9.1 / Cyberpunk 2077:** the latest ordinary-session acceptance is
  recorded in [the live verification report](docs/AUDIT-20261029.md#subsequent-live-upgrade-and-acceptance--2026-10-29).
  Other game write guards are listed in the setup guide; they are not equivalent
  to end-to-end validation for every game.
- **Mod installation is not a resident MCP endpoint.** Expert helper preparation
  supports specific reviewed template families and fresh native admission.
  It does not install arbitrary archives. See [native helpers](docs/NATIVE-HELPER-PREPARATION.md)
  and [tracked Nexus batches](docs/TRACKED-NEXUS-HELPER-REVIEW.md).
- **Credentials stay local.** No account sessions, Vortex database, mod archives
  or game files are included. There is no generic dispatch, game-launch or
  profile-switching API. Receipts do not replace independent deployed-file checks.

The suite version in [VERSION](VERSION) is separate from the embedded adapter's
1.0.4 label. Source releases do not update an already installed extension.

## Help and development

[Setup and troubleshooting](docs/GETTING-STARTED.md) · [Support](SUPPORT.md) ·
[Contributing](CONTRIBUTING.md) · [Security reporting](.github/SECURITY.md)

For architecture, recovery, dependency pins and verification records, use the
[documentation index](docs/README.md). Runtime/build outputs belong in ignored
`local-state/`. Historical recovery snapshots retain provenance; the maintained
implementation lives in `tools/modding/`.

This is an independent community project under **GPL-3.0-only**, based on
[Alan Tse's vortex-mcp](https://github.com/alandtse/vortex-mcp), the
[community Nexus CLI](https://github.com/vadimtrifonov/nexusmods-cli) and the
[official Nexus uploader](https://github.com/Nexus-Mods/upload-action).
It is not an official Nexus Mods or Vortex product. [Licenses and attribution](docs/LICENSES.md).

<details>
<summary>My Cyberpunk 2077 collection and mods</summary>

## My Cyberpunk 2077 projects

[**Past the Night**](https://www.nexusmods.com/games/cyberpunk2077/collections/scqalj)
is a Cyberpunk 2077 collection with additional quests and interactions, visual
mods, fixes and maintained collection patches.

| Mod | What it adds |
| --- | --- |
| [Clean Inventory — Search and Filters](https://www.nexusmods.com/cyberpunk2077/mods/34413) | Search, category filters and separate sorting preferences for inventory, stash and vendors |
| [Nearby Auto Loot — Automatic Pickup](https://www.nexusmods.com/cyberpunk2077/mods/34650) | Configurable automatic pickup of nearby loot |
| [Smart Vendor — Automatic Selling](https://www.nexusmods.com/cyberpunk2077/mods/34656) | Automatic selling of eligible junk, duplicate equipment and surplus supplies |
| [Skip Intro and Auto Continue](https://www.nexusmods.com/cyberpunk2077/mods/34645) | Skip startup intros and automatically confirm Continue after loading a save |
| [FSR Exit Guard — AMD Crash on Exit](https://www.nexusmods.com/cyberpunk2077/mods/35845) | A targeted workaround for an AMD FSR-related crash when quitting the game |
| [Move Your Way](https://www.nexusmods.com/cyberpunk2077/mods/36249) | Movement settings for recovery, climbing, air dashes and extra jumps |
| [Past the Night — Collection Patches](https://www.nexusmods.com/cyberpunk2077/mods/35196) | Fixes for the Past the Night collection |

</details>
