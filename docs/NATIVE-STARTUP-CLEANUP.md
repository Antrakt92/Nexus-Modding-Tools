# Prepared startup cleanup ownership

The `startup-cleanup-ownership` patch extends the reviewed Vortex 2.9.1 source
series. It is not installed and adds no install or removal endpoint.

## Correct the incomplete-install failure path

`mod_management/index.ts` calls `cleanupIncompleteInstalls()` synchronously from
`once()`, before startup can discover unknown staging directories. Previously,
failure to remove an incomplete mod directory was logged and suppressed. Cleanup
then attempted the `.installing` directory and removed the mod record anyway.
The remaining files could consequently lose their known incomplete-install row.

The prepared patch enters the existing shared lifecycle owner before reading
state or deleting anything. Cleanup still runs synchronously: successful file
removals and record changes finish before the function returns. Only successful
ownership settlement occurs in a later microtask.

An error other than `ENOENT` stops the cleanup loop, preserves the current mod
record and starts no later deletion, row or game. Earlier completed removals
cannot be rolled back. If the second path fails, the first may already be gone;
keeping the record is not a claim that its contents are intact. The rejected
operation retains its owner. Failed notifications and logging cannot release
that owner or leave an unobserved rejected notification tail.

An existing exclusive reservation refuses cleanup before state/filesystem access.
The wrapper reports the failure and returns `void`; it does not abort the rest
of `once()`. Missing paths remain benign. Installed rows and ordinary successful
cleanup retain their previous behavior.

## Verification and boundary

The source-derived tests compare the old and patched functions using exact
original source pins. They cover record loss after a failed first deletion,
failure of the `.installing` path, later-row/game suppression, exclusive refusal,
synchronous startup ordering, successful microtask settlement, missing paths and
notification/logger failure. Their filesystem and state are owned mocks.

```powershell
node --test tools/modding/vortex-agent/native-startup-cleanup-patch.test.mjs
```

The integration cases need `VORTEX_NATIVE_INSTALL_MANAGER` and
`VORTEX_NATIVE_MOD_INDEX` pointing to the exact original files. Missing originals
produce explicit skips, not native acceptance. Apply the complete fixed series
and use the [renderer qualification](NATIVE-SOURCE-ASSEMBLY.md) for compilation.

Shared ownership does not prove physical ownership of either directory. It does
not authorize deleting a directory after keeper loss, clear a durable pending
operation or establish crash recovery. Native registration and installation stay
disabled until those contracts and isolated host acceptance pass.

## Remaining core producers

The next exclusion work is limited to confirmed core routes:

- Staging settings perform normalization, dialogs, purge, transfer and the final
  `setInstallPath`. Owning only purge leaves the later transfer outside that
  lifetime. A disabled Apply button cannot cover an already pending callback.
- Profile switching imports/exports profile files and confirms the new profile
  around separate deployment calls. The whole switch needs a joined lifetime.
- Profile removal sets `pendingRemove`, deletes its directory asynchronously and
  removes state. Its current deployment-only activity check and void completion
  cannot stand in for native exclusion.
- Enabled-state helpers dispatch before emitting `mods-enabled`; the profile
  transfer dialog also dispatches directly. Protected context actions need a
  synchronous admission gate before the reducer, not only a later event handler.

The inspected `refreshMods` callers already return their metadata tail through
tracked wrappers. Their failure keeps ownership held; this audit found no new
successful-release gap requiring another refresh patch.
