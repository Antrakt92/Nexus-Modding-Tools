# ZIP extraction through retained handles

`ArchiveTempLease.create_zip_extractor(expected_payload, expected_total)` is an
internal ZIP backend. It reads the lease's original archive handle and creates
each output with relative NT `FILE_CREATE`. An existing file or directory is
refused, even when its contents match the expected payload.

The fixed 7z backend remains separate. In a controlled test, a file inserted
between its empty-root check and child resume was overwritten by 7z's `-y`
invocation. Another preflight or an overwrite switch cannot establish ownership
of every output. The ZIP backend therefore performs its own bounded extraction.

## Inputs and supported ZIPs

The payload is a detached map of exact relative filenames to SHA-256 hashes.
The total is the expected unpacked byte count, matching the existing install
plan. Neither is an archive verification receipt: both are checked against
the original held bytes and actual output.

The supported subset is classic single-disk ZIP with STORED or raw DEFLATE
entries. Central and local headers must agree. Local records must cover their
declared range without overlaps, gaps or unexplained trailing compressed data.
ZIP64, encryption, data descriptors, extra fields, links and special objects are
refused. Directory entries must be STORED with zero data and CRC32 zero.
Paths use ordinary ASCII components, with consistent case at every
prefix. DOS device names, ADS, tilde aliases, traversal, backslashes, conflicting
file/directory paths and installer instructions are refused.

Admission checks the complete metadata before creating descendants. Limits
include 4,096 entries, 64 MiB of archive bytes, 64 MiB per file and 256 MiB
unpacked. The aggregate
handle budget includes all unique intermediate directories and existing lease
handles; counting files alone is insufficient.

## Lifecycle and output custody

| Method | Contract |
| --- | --- |
| `start()` | Checks acquired custody, metadata, payload scope and resource budget before output creation |
| `pump()` | Advances bounded creation, archive-read, inflate, write or readback work under the shared thread and lock |
| `cancel()` | Stops further work without deleting output or refunding the attempt |
| `close()` | Explicitly ends the backend's processing; incomplete healthy work must first be cancelled |
| `status()` | Returns detached cached facts; does not advance I/O or grant installation permission |

Both extractor factories share one attempt reservation. An unsupported, failed,
cancelled or closed backend cannot switch to the other factory or fall back to
external extraction. The existing 7z and never-factory legacy contracts remain
separate. ZIP completion does not fabricate a process exit code or pipe EOFs.

Every created native output cell belongs to the parent lease's close ledger
before the create call. Interrupted creates and writes retain the original
objects. Partial output remains in place; there is no retry or automatic deletion.

The ZIP owner closes its processing, while the parent retains the original
read/write output handles. Those handles deny ordinary competing writes and
rename/delete. Closing them and reopening source paths would introduce a race.
Reopening a source with the existing read-only sharing policy would also conflict
with the retained writer. The borrower instead reads the same original handles,
checking ledger ownership, phase, identity, size, link count and content.

Close the borrower before the parent. Parent close refuses an active borrower;
poisoned or partially closed custody cannot serve stale source-map handles.
Directory handles do not prevent unrelated files from being inserted below a
root. Such files are never adopted as outputs or included in the borrowed map,
and this component grants no authority to delete the whole temporary tree.

## Bounds and verification

Data pumping uses bounded input, output and readback chunks. Raw DEFLATE must
reach its exact end without unused or truncated input. Actual bytes, CRC32 and
SHA-256 must match, followed by readback through the held output handle.
[`decompress(max_length)`](https://docs.python.org/3.14/library/zlib.html#zlib.Decompress.decompress)
limits output per call; `flush(length)` is not an output-size cap. Chunk bounds
do not establish a wall-clock deadline or measured peak memory.

Run the explicit own-scratch native suite:

```powershell
$env:VORTEX_OWNED_ZIP_TEST = '1'
python -B tools/modding/vortex-agent/owned-zip-extractor.test.py -v
```

The format reference is [PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).
Tests use our own synthetic ZIPs and local temporary directories. Actual Vortex
registration, shared native-install exclusion, durable worker execution and host
acceptance remain separate gates. This backend exposes no MCP/CLI installation
endpoint and keeps `nativeInstallAccepted`, `effectsAllowed` and
`persistenceVerified` false.
