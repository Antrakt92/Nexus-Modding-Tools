# Nexus Modding Tools

Source, tests and recovery tools for a Windows Nexus Mods/Vortex workflow.

- Search Nexus metadata with the community CLI.
- Read Vortex state, download files, enable mods and deploy through an authenticated
  local adapter with profile/path checks and durable operation receipts.
- Validate and publish an explicitly selected Nexus update through the official
  uploader, with local archive checks and uncertain-result recovery.
- Run independent reads together and queue supported changes through the running
  adapter, without client-driven restarts or window manipulation.

The adapter intentionally does not offer unrestricted dispatch or automatic
installation. Current Vortex installation can silently replace an existing mod;
see [the installation boundary](tools/modding/vortex-agent/LOCAL-PACKAGE-INSTALL-DESIGN.md).
Vortex itself can still show native dialogs during a requested operation; this
project does not promise that those dialogs will never appear.

Start with [restoration](docs/RESTORE.md), [configuration](docs/CONFIGURATION.md)
and [license details](docs/LICENSES.md). Build inputs and upstream source revisions
are pinned. A fresh computer needs its own local credentials; this repository
contains no keys, personal Vortex database, game files or mod downloads.

The combined project and adapted Vortex component use GPL-3.0-only. Independent
MIT/Apache dependencies retain their own notices. This is a community project,
not an official Nexus Mods or Vortex product.
