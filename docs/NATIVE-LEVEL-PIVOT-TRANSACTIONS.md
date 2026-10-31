# Native LevelDB transaction checks

The installation path needs mod fields and their operation marker to commit
together. A DuckDB memory-table test does not establish that behavior for
Vortex's LevelDB storage extension.

The offline [fixture](../tools/modding/vortex-agent/native-level-pivot-transaction.test.mjs)
uses an explicitly supplied official `level_pivot` binary and an existing
`@duckdb/node-api` package. It creates fresh LevelDB directories under this
checkout's ignored `local-state`, then closes and reopens them before comparison.
It does not open Vortex databases, install dependencies, download extensions or
modify the global extension cache.

## Reviewed inputs

[The input manifest](../tools/modding/vortex-agent/native-level-pivot-inputs.json)
pins source commit `329121d729dc40d303db304f945ca789754a0d06`, its immutable Pages
deployment, compressed/raw hashes, Windows AMD64 footer and DuckDB/API versions.
The official HTTP bytes matched the immutable Pages Git blob. The embedded source
prefix and build/deployment metadata support that association; a signed
attestation or independently reproduced build was not available. This is not a
claim that an installed Vortex binary has been compared with this input.

The [transaction implementation](https://github.com/Nexus-Mods/duckdb-level-pivot/blob/329121d729dc40d303db304f945ca789754a0d06/src/storage/level_pivot_transaction.cpp)
shares one pending WriteBatch across statements. Commit applies it, while rollback
discards it. The [storage implementation](https://github.com/Nexus-Mods/duckdb-level-pivot/blob/329121d729dc40d303db304f945ca789754a0d06/src/storage/level_pivot_storage.cpp)
checks the write status before reporting success, but sets `WriteOptions.sync`
to false. A write error can leave an unknown physical outcome; discarding an
in-memory batch does not undo data already written.

## Run locally

Use reviewed existing inputs matching the manifest. Package installation and
dependency upgrades require their separate dependency review.

```powershell
$env:VORTEX_NATIVE_DUCKDB_NODE_API = 'C:/reviewed/node_modules/@duckdb/node-api'
$env:VORTEX_NATIVE_LEVEL_PIVOT_EXTENSION = 'C:/reviewed/level_pivot.duckdb_extension'
node --test tools/modding/vortex-agent/native-level-pivot-transaction.test.mjs
```

Without both explicit inputs, native cases skip and metadata checks still run.
A supplied invalid path or mismatched binary fails. Native cases require Windows
AMD64. The test loads the exact absolute binary with autoinstall/autoload disabled
and verifies those settings. Runtime input hashes are checked before and after.
Every run retains its own databases and evidence; it does not delete uncertain
output. Test timeouts are not OS-level containment for a blocked native call.

## Acceptance and limits

The private precursor and maintained fixture passed five real-extension cases on
31 October 2026. The maintained run passed all seven checks without skips,
including two metadata/input checks; the precursor also received independent
receipt and input-hash verification:

- Rollback/reopen: none of the four mod fields or marker remained.
- Commit/reopen: all five rows matched exactly.
- A 521-row transaction spanning three SQL batches reopened with every row.
- A SQL error after the first 256 rows followed by rollback left no rows.
- After a real commit and injected lost acknowledgement, exact committed readback
  was available without another commit or automatic replay.

These establish the exercised transaction/reopen behavior, not process-crash,
power-loss or native commit-I/O-fault recovery. The lost-acknowledgement flag is
controlled by the fixture; it is not an implemented Vortex reconciliation service.
No result grants installation authority or establishes payload ownership,
all-profile exclusion, renderer adoption or release of native holds. Those remain
separate [registration gates](NATIVE-ADOPTION-BOUNDARY.md#next-implementation-gates).
