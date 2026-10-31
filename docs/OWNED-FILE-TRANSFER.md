# Handle-owned file transfer

`tools/modding/vortex-agent/owned-file-transfer.py` is an internal Windows x64
library for copying a bounded payload into a newly created directory. It is not
connected to Vortex, the bridge or an installation endpoint. Importing it and
constructing `OwnedFileTransfer` do not open files or create directories.

## Acquisition and copying

The caller supplies an existing source root, an existing destination parent,
their independently admitted native identities, and one new destination leaf.
`acquire()` opens each ancestor through retained directory handles, refuses
reparse points, verifies the root identities and exclusively creates the new
destination directory. An existing target, including an empty directory or a
case alias, is refused. A source sibling such as `Owner.installing` below the
destination parent is allowed; overlapping source/final roots are refused.

`transfer(source_relative, destination_relative, expected_size, expected_sha256)`
uses slash-separated relative paths. Every output directory/file is created
new, relative to an already held parent handle. Source bytes are hashed before
copying, hashed during copying and checked for metadata drift. Destination bytes
are read back and hashed through the retained handle. Partial writes, unexpected
destination hardlinks and mismatching hashes stop the lease. No existing file is overwritten.

This first backend admits fixed local NTFS drives with a canonical
`HarddiskVolume` mapping, ASCII components, at most 32 path components and
512-character root/relative paths. Device names, traversal, ADS, tilde aliases,
trailing dots/spaces, network paths and SUBST mappings refuse. Bounds are 4,096
attempted files, 256 MiB per file and in aggregate, 16,384 retained handle entries
and 64 KiB copy chunks. These are admission limits, not measured memory usage.

## Identity domain

Both root pins have exactly this shape; numeric values are positive decimal
strings, bounded to 64 and 128 bits respectively:

```json
{
  "schema": "win-file-id128/1",
  "volumeSerialNumber": "NATIVE_VOLUME_SERIAL",
  "fileId": "NATIVE_FILE_ID"
}
```

Obtain pins from `FILE_ID_INFO` through independently admitted native handles.
The file ID is the little-endian integer representation of its 16 bytes.
Do not convert the bridge's untagged `dev:ino` into this schema: on the tested
NTFS volume, Node's device serial had 32 bits while native `FILE_ID_INFO` and
Python 3.14 exposed a different 64-bit value. Matching path strings do not repair
that difference. A future executor must bind both domains explicitly.

## Failure and lifetime

Keep the lease alive throughout copying and reconciliation. Errors expose
`error.lease`; cancellation preserves `KeyboardInterrupt`/`SystemExit` while
poisoning the lease. Native output-handle storage is registered before creation,
so an interruption after a successful kernel call does not lose ownership.
Acquisition, transfer and close are confined to the acquiring thread and refuse
reentrant/concurrent work. Status reads are observational and do not acquire that lock.

`status()` reports acquisition, poison, retained resources and close uncertainty.
`close()` releases handles only: it never deletes partial output or retries the
operation. Confirmed closed handles are forgotten individually. A close interrupted
after the native call remains uncertain and is never attempted again against a
possibly reused raw handle. Ordinary failed closes may be attempted explicitly;
they do not establish release. There is no automatic destructor or rollback.

Sharing restrictions block ordinary rename/delete of opened names and file writes
while held, including writes through another hardlink name. A separately opened
hardlink alias may still be renamed. They do not fence directory
contents: siblings or new hardlink names can still appear. The target directory
is visible before copying completes. This is not atomic publication, an ACL
sandbox or protection from privileged actors, existing writable mappings or
hostile drive-map changes. No `FlushFileBuffers`/power-loss claim is made.

All results retain `effectsAllowed:false` and `persistenceVerified:false`;
status also retains `nativeInstallAccepted:false`. These mean no installation
permit is granted, despite the explicit filesystem effects of this library.

## Verification and remaining integration

The [archive/temp custody lease](ARCHIVE-TEMP-CUSTODY.md) can lend its original
temporary-root handle to one already acquired transfer. Both share a lock and
aggregate handle limit; borrower handles close separately, before the parent's
archive/root handles. This is physical custody, not extractor-terminal admission.

Run the native suite explicitly; it is separate from the Node test glob and
Python `tests/` discovery:

```powershell
python -B tools/modding/vortex-agent/owned-file-transfer.test.py -v
```

On the tested Windows x64/NTFS host with Python 3.14, 22 cases passed with no
skips. They exercise actual creation, byte readback, hardlink write refusal,
junction refusal, partial outputs and handle release; injected failures cover
post-create cancellation, reentrancy and post-close interruption. Tests use
only their own ignored scratch roots and retain them for inspection.

Before native installation can consume this component, it still needs durable
intent/job binding, parent/owner admission, an accepted extractor lifetime and
handoff, registration/cleanup ownership, and complete isolated Vortex acceptance.
The current legacy extraction/removal paths cannot be made compatible by
releasing handles early or falling back to pathname copying/deletion. No native
installation or end-to-end speedup is established by this component.
