<h1 align="center">Nexus Modding Tools</h1>

<p align="center">Nexus research and Vortex automation through MCP or the command line.</p>

<p align="center">
  <a href="docs/GETTING-STARTED.md"><strong>Get started</strong></a>
  · <a href="https://github.com/Antrakt92/Nexus-Modding-Tools/releases/latest"><strong>Download source</strong></a>
  · <a href="CHANGELOG.md">Changelog</a>
  · <a href="https://github.com/Antrakt92/Nexus-Modding-Tools/issues/new/choose">Report a problem</a>
</p>

<p align="center">
  <a href="https://github.com/Antrakt92/Nexus-Modding-Tools/releases/latest"><img src="https://img.shields.io/github/v/release/Antrakt92/Nexus-Modding-Tools?label=source%20release&amp;color=0f766e" alt="Latest source release"></a>
  <a href="docs/GETTING-STARTED.md"><img src="https://img.shields.io/badge/platform-Windows-0078D4" alt="Windows"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-2563EB" alt="GPL-3.0-only license"></a>
</p>

Nexus Modding Tools connects a running **Vortex** session to an MCP-compatible
AI client or the command line. You can inspect mods and conflicts, find existing
downloads, enable or disable mods, and deploy them. Separate tools handle Nexus
Mods metadata searches and uploads.

**Build from source on Windows.** Follow the [setup guide](docs/GETTING-STARTED.md)
to install the Vortex extension. Inspection, downloads, enabling mods and deployment
use the running Vortex process. Installing mod archives requires a separate script.

## What you can do

| Task | What it does | Guide |
| --- | --- | --- |
| Inspect a mod setup | Read profiles, mods, downloads, dialogs and conflicts in a combined snapshot | [Session inspection](docs/NO-RESTART-WORKFLOW.md) |
| Inspect mod usage | Read all-profile usage, incoming requirements and archive references for exact installed IDs | [Lifecycle preflight](docs/LIFECYCLE-PERFORMANCE.md) |
| Prepare a collection | Match exact Nexus mod/file IDs to existing tracked downloads | [Download reuse](docs/COLLECTION-DOWNLOADS.md) |
| Change enabled mods and deploy | Check a plan before running it, apply changes one at a time and deploy once at the end | [Plan format](docs/NO-RESTART-WORKFLOW.md#run-the-reviewed-plan-through-mcp) |
| Check an interrupted plan | Read its saved intents and reconcile the exact operation receipts without replay | [Plan status](docs/NO-RESTART-WORKFLOW.md#inspect-a-plan-after-a-disconnect) |
| Research Nexus Mods | Search public metadata and requirements through the community CLI | [Nexus CLI](tools/modding/nexus-cli/README.md) |
| Publish your own mod | Check an archive locally and upload an update through the official Nexus uploader | [Publication runner](tools/modding/nexus-publish/README.md) |
| Inspect a Cyberpunk API cache | Check input/tool/output pins and explain failed or incomplete generation without retrying | [Pristine API cache](docs/PRISTINE-API-CACHE.md) |

The MCP bridge exposes `inspect_session`, `find_collection_downloads`,
`run_mod_plan` and `inspect_mod_plan`. Before changing mods, the adapter checks the active profile and
folder identities. It records each operation so an interrupted request can be
checked before retrying it.

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
- **Tested with Vortex 2.9.1 and Cyberpunk 2077.** Results are
  recorded in [the live verification report](docs/AUDIT-20261029.md#subsequent-live-upgrade-and-acceptance--2026-10-29).
  The setup guide lists other games with process checks; those games have not
  all been tested through a full install and deploy cycle.
- **The MCP does not install mod archives.** Separate tools prepare installation
  scripts for specific templates. Each script needs its own source, package and
  current-state checks. See [native helpers](docs/NATIVE-HELPER-PREPARATION.md)
  and [tracked Nexus batches](docs/TRACKED-NEXUS-HELPER-REVIEW.md).
- **Credentials stay local.** No account sessions, Vortex database, mod archives
  or game files are included. There is no generic dispatch, game-launch or
  profile-switching API. Receipts do not replace independent deployed-file checks.

The suite version in [VERSION](VERSION) is separate from the embedded adapter's
1.0.4 label. Source releases do not update an already installed extension.

## Help and development

[Setup and troubleshooting](docs/GETTING-STARTED.md) · [Support](SUPPORT.md) ·
[Contributing](CONTRIBUTING.md) · [Security reporting](.github/SECURITY.md)

See the [documentation index](docs/README.md) for build instructions, configuration
and test reports. Current code lives in `tools/modding/`; build output and local
operation records belong in the ignored `local-state/` directory.

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
