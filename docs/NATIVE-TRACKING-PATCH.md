# Prepared ordinary-install tracking patch

This source patch targets official Vortex `v2.9.1`, commit
`c80326367cbe6d96621ad6cf4a5488ef49bac110`. It is not installed, does not update
Vortex, and grants no installation capability to this MCP.

The original `InstallManager.ts` uses a source/download composite key for all
active installations. Two ordinary installs of the same download overwrite the
same tracking entry. Direct installs without a source/download also collide.
The dummy archive ID does not change that tracking key.

The [patch](../tools/modding/vortex-agent/native-patches/vortex-2.9.1/ordinary-tracking.patch):

- assigns a separate ordinary-install ID when there is no source collection;
- refuses an allocated ID collision before changing the active map or entering
  the install limiter;
- retains dependency composite keys and queued dependency placeholders;
- records explicit `sourceModId` in both active-record constructors and compares
  it exactly when cleaning active entries for a collection.

The [manifest](../tools/modding/vortex-agent/native-patches/vortex-2.9.1/ordinary-tracking.json)
pins the complete original file, patch and resulting file. The base source is
byte-identical to the installed renderer source reviewed for this task. Preserve
the upstream GPL license and attribution when preparing an upstream contribution.

## Verification

Supply a separately obtained exact source file from the pinned tag:

```powershell
$env:VORTEX_NATIVE_INSTALL_MANAGER = 'C:/ReviewedSource/InstallManager.ts'
node --test tools/modding/vortex-agent/native-tracking-patch.test.mjs
```

The source-backed tests verify raw SHA-256, apply the diff in memory without fuzz,
strip TypeScript types with Node's built-in transformer, and evaluate the trusted
class with mocked registration dependencies. They bypass the constructor and do
not run the install task, extraction, native events or filesystem changes. The VM
is a unit-test mechanism, not a security sandbox.

Eight tests passed with the exact source, including baseline overwrite, independent
ordinary jobs/callbacks, forced allocation collision, unfinished downloads, exact
active-source cleanup, dependency deduplication and canceled queued placeholders.
Without the external source file, two portable patch checks run and six source
cases are explicitly skipped. No test downloads upstream code automatically.

The complete Vortex build, application typecheck, renderer/native integration and
dependency queue integration have not been run for this artifact. An upstream
contribution needs the upstream verification gates too. Never apply this patch
directly to an installed `app.asar` or infer activation from passing these tests.

## Remaining contracts

Dependency tracking still uses composite IDs. Pending/retry cleanup behavior,
callback/terminal ordering, owner/temp reservation, replacement selection and
archive-import collision handling are unchanged. This patch is one prerequisite,
not the new-only installer or a reason to release an archive seal. Continue with
[the local installation stages](LOCAL-INSTALL-IMPLEMENTATION.md).
