# Local packages without a Vortex restart

## What works today

The resident authenticated adapter already handles health, inventory, dialogs,
conflicts, Nexus download-only acquisition, enabling installed mods and deployment.
These operations need no temporary extension, Vortex restart or application
launch. Reuse the resident adapter; keep native installation separate.

Installing a temporary extension requires Vortex to load it. A persistent,
specialized operation would remove that repeated load/restart cycle. Merely
moving the existing install callback into a permanent queue does not make native
installation non-replacing.

`install_download` remains disabled. No new installation endpoint or executable
queue is introduced by this document.

## Current native boundary

Reviewed the actual installed Vortex 2.9.0 archive:

`C:/Program Files/Vortex/resources/app.asar`

SHA-256: `1faeab9820c3a7314cd2a2c3e4adfa855ea5980c2f849a1174ed5ed76b49ed85`.

Its embedded source maps were read as context, without running Vortex code or
changing the installed archive. Relevant extracted sources are under
`F:/AI/Codex/home/agent-context/repos/vortex-v2.9.0-installed-20261025/`.

Native `start-install-download(downloadId, {allowAutoEnable:false, profileId}, cb)`
does not accept an enforced expected-new-mod ID or a no-replacement requirement.
In `InstallManager.ts`:

- Lines 1439–1458 perform asynchronous metadata lookup and derive the install ID
  after the initial event and preflight. Archive basename uniqueness does not
  fix the final identity.
- Lines 1470–1510 also consider existing variants with the same archive ID.
- Lines 1569–1580 find an existing version from file/mod/logical-file metadata.
- Lines 1655–1688 can disable or remove that existing version. A post-callback
  check discovers the effect after it has happened.
- Lines 4785–4822 show the newest-file ID and Nexus/logical-name matching paths;
  lines 5243–5249 permit automatic replacement in a one-profile case.

Therefore an empty expected target ID, a unique ZIP basename, no Nexus IDs in
the initial download, a dialog watcher and `allowAutoEnable:false` are useful
guards but do not independently prove that an unrelated mod cannot be replaced.
`allowAutoEnable` controls enabling; it is not a no-replacement flag.

The native local import also needs care. `download_management-index.ts`, lines
435–460 and 550–568, queries replacement and removes an existing archive before
copying. Its stat-then-copy sequence is not an atomic exclusive-create contract.
Reuse a verified tracked download instead of importing it again. A future local
import operation must establish an exclusive destination policy separately.

## Narrow future operation

A specialized owned-package operation should accept only an existing finished
local download ID, exact archive size/SHA-256, explicit new target ID, an exact
payload manifest, request ID and the adapter's existing game/profile/path/inode
pins. Local packages must not fabricate Nexus identities.

Before any effect: validate the archive containment and bytes; reject target,
installation-path and archive ownership collisions across all mods/profiles;
confirm the game is stopped and automation/dialog state is suitable; persist the
attempt and unresolved marker; then recheck immediately before invocation.
The operation installs disabled and never deploys, replaces, removes, changes
settings or resolves an unexpected dialog. It verifies every staged payload and
pre-existing record afterward. An uncertain result remains interlocked, never
replayed under a new request ID.

This operation additionally needs a source-proven native primitive that enforces
create-new-only **after metadata resolution and inside the native installation
transaction**, before any existing mod is disabled, removed or overwritten.
An expected final ID must be checked there, including archive variants and
previous-version detection. All native install jobs must participate in the
same exclusion; locking only our HTTP requests does not lock the UI installer.
The current public event does not establish these properties. Do not implement
an apparently safe queue around that event and call it non-replacing.

Local synthetic tests can cover rejection, archive integrity, no-replay,
receipt durability and output validation. An isolated native fixture must also
prove collision, metadata-assisted replacement and concurrent UI-install cases
before this new operation is enabled. Existing install-only fixture success on
an empty inventory does not cover those cases.

## Window visibility

`Application.ts:473` skips the splash when `startMinimized` is true. However,
`MainWindow.ts:334–350` calls `BrowserWindow.show()` before `hide()`; its own
comment acknowledges that a split-second window can appear. The Windows
`Start-Process -WindowStyle Hidden` request does not override that later
application-level show call. Starting minimized is not a no-focus guarantee.

Do not restart an already running resident adapter for supported operations.
Do not use `VORTEX_E2E_HEADLESS` for the user's normal Vortex session: it is an
isolated test route, not a verified ordinary-session startup option. No window
hooks, foreground stealing, application launch or settings changes were made.
