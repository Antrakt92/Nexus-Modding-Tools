# Archive and temporary-directory custody

`ArchiveTempLease` in `tools/modding/vortex-agent/owned-file-transfer.py`
retains a read-only archive handle and creates one new temporary root through
held parent handles. It is an internal Windows x64/NTFS component, separate
from Vortex and the MCP installation surface.

## Acquire and hand off

The constructor is inert. Supply exactly four detached binding labels:
`operationId`, `nativeJobId`, `requestSHA256` and `rendererGeneration`;
archive parent/file identities, archive leaf, byte count and SHA-256;
and a temporary parent identity and new leaf. Identities use the
[`win-file-id128/1` domain](OWNED-FILE-TRANSFER.md#identity-domain).
The labels associate observations; they do not authenticate an executor.

`acquire()` opens and retains the archive's ancestors, verifies its identity,
size, hash and metadata, then exclusively creates the temporary root. An
existing root is refused. Compressed input is bounded to 64 MiB. This component
checks bytes and custody, not ZIP format or admissible archive contents.

The lease can create one [fixed 7z process owner](OWNED-EXTRACTOR-PROCESS.md) or
one [ZIP decoder](OWNED-ZIP-EXTRACTOR.md). The factories share a single attempt:
failure or cancellation cannot switch backends or fall back to external work.
Handoff requires that original owner's verified completion and explicit close.
The ZIP decoder keeps its created output handles in the parent lease through
transfer; its completion does not claim a child process or pipe observations.

Only legacy callers that never attempt a factory retain the separate obligation
to seal their actual extractor and observe its child and pipes before calling
`begin_transfer(destination_parent, parent_identity, new_leaf)`.
That method rechecks archive custody and returns an
already acquired `OwnedFileTransfer`. It borrows the original temporary-root
handle without closing or reopening its path. Only one borrow is allowed.
It does not accept JSON terminal assertions or export raw handles.

Parent and borrower share a nonreentrant lock, acquiring thread and aggregate
handle limit, with separate lists of handles to close. Close the borrower first,
then the parent. Parent close refuses while borrower resources remain open or
uncertain. Acquisition/copy failures retain partial output and expose the
responsible lease; an interruption after borrower acquisition retains that
borrower through `error.lease`. No automatic deletion or retry occurs.

## Sharing and crash limits

Ordinary archive writes, including writes through hardlink aliases, are denied
while held. The opened canonical archive name, retained ancestors and temporary
root resist ordinary rename/delete. A separately opened hardlink alias may
still be renamed. The observed metadata drift from such an alias change stops
handoff; this is not a fence around every alias or directory descendant.

The root handle does not prevent insertion of files below it. The prepared 7z
invocation still has overwrite behavior. A fresh empty root and one extraction
attempt were used in the native fixture; this does not establish general
no-clobber extraction or authorize retries.

If the keeper process dies, Windows can release its handles while an extractor
survives. Crash custody, descendant containment, durable recovery, registration
and cleanup remain unproved. Status therefore always reports
`nativeTerminalVerified:false`, `nativeInstallAccepted:false`,
`effectsAllowed:false` and `persistenceVerified:false`. Explicit close releases
handles only; these flags do not mean the component had no filesystem effects.

## Verification — 31 October 2026

Run both native suites explicitly:

```powershell
python -B tools/modding/vortex-agent/owned-file-transfer.test.py
python -B tools/modding/vortex-agent/archive-temp-lease.test.py
```

All 35 cases passed on Windows x64/NTFS with Python 3.14: the existing 22 transfer
cases and 13 custody cases. Tests cover aliases, identity/hash/size rejection,
existing-root preservation, shared limits/locking, the original-root borrow,
partial copies, interruptions and uncertain close ownership.

An isolated normal-path fixture also retained this lease while the prepared
[owned SDK factory](NATIVE-OWNED-EXTRACTOR.md) ran the actual installed 7z binary.
One own ZIP produced the expected 28-byte payload, exit 0 and no reported
errors. The Node owner observed the child and all three pipes closed. During
38 parent-process samples, ordinary archive write/delete and ancestor/root
delete access were denied with Windows sharing error 32. Those samples surround
the Node operation; they do not measure only the child execution window.

Afterward the transfer borrowed the same original temporary-root handle,
verified the payload by hash/readback and refused early parent close. Sharing
fences remained through borrower close and were released after explicit parent
close. This proves normal-path compatibility with a surviving keeper. It does
not establish crash lifetime, a rebuilt Vortex package or native installation.

A separate [controlled caller-crash experiment](NATIVE-CRASH-CUSTODY.md) tests
a surviving custodian in a fixed Win32 launcher. Child-only inherited handles
were rejected after an observed early-release gap. That launcher is not yet
connected to the SDK or Vortex; it does not upgrade this lease into an
extractor-terminal or crash-recovery authority.
