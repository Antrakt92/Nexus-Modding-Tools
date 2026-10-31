# Background owned-ZIP worker

`owned-zip-worker-client.mjs` runs one fixed Python guardian. That process
acquires the archive lease, drives the [ZIP decoder](OWNED-ZIP-EXTRACTOR.md)
locally and retains its handles across extraction and copying. Reading status
does not advance the decoder.

This internal component writes its own scratch directories. It does not register
a Vortex mod, import a tracked archive, enable or deploy anything. The public MCP
installation operation remains disabled.

## Fixed scope and runtime

The first accepted runtime is standalone Windows x64 Node 24.20.0 and the reviewed
`C:/Python314/python.exe` build of Python 3.14.8. Executable/core hashes are pinned.
Its zlib is built into `python314.dll`, version `1.3.1.zlib-ng`; no separate zlib
extension is claimed. Electron is not accepted by this coordinator. A runtime
change needs new admission and qualification.

Python starts with fixed `-I -S -B` arguments and only the required SystemRoot
environment entry. There are no executable, script, argv, callback or backend
options. The guardian seals the three fixed Python sources and its runtime files
read-only before its ready response. Those seals remain until release or process
death. This is not an attestation of every Python/Windows library.
The coordinator hashes admitted files through one open descriptor in 64 KiB
chunks, reads at most the admitted size plus one byte and rejects changed file
generations. A size check does not authorize an unbounded whole-file read.

The separate archive binding requires explicit `win-file-id128/1` parent/file
identities. Node `dev:ino` context labels must not be converted into that domain.
All output paths derive from the maintained source checkout:
`local-state/owned-zip-worker-work/<operationId>/Extract` and `Final`.
The coordinator checks the scratch ancestry without creating directories. The
guardian opens or exclusively creates the fixed parent directories relative to
retained native handles, refusing reparse points even after coordinator preflight.
The operation directory and outputs are created exclusively. Embedded game and
staging paths do not authorize writes there. A real staging target still needs
native admission, shared exclusion and registration.

## Intent and job reservation

`createNativeExecutorJournal({root})` reuses the immutable operation intent, then
reserves `jobs/<nativeJobId>/binding.json`. The default root is
`<runtime>/local-state/vortex-agent-build/native-install-executor`.

The reservation binds the original request digest, operation/job IDs, actual
worker lifetime nonce and exact start-packet digest. Duplicates refuse; a failed
second reservation does not delete the first intent. Fresh reads require
independently retained request/job/packet bindings and check ancestor identities
again after record discovery and final reads.

`reserved`, `intent_only`, `reservation_only` and `not_observed` are observations.
Every result retains unknown dispatch state, reconciliation required, no replay,
no effects permit and unverified power-loss persistence. Missing records do not
prove that nothing happened. Never erase or reroot the ledger to retry. This is
not the native manager's consumed-ID registry or global UI-install lock.
File flush/readback and process-exit tests do not prove power-loss survival.

## Coordinator lifecycle

`createOwnedZipWorker(requestBytes, archiveBindingBytes)` is inert. Its `start()`
admits the runtime/sources, checks the private child's nonce/PID/creation time,
publishes both journal bindings, then attempts exactly one start-packet write.
Only one worker may occupy a coordinator module at a time.

| Method | Behavior |
| --- | --- |
| `status()` | Copies cached bound observations without I/O |
| `waitFor(phase, timeoutMs)` | Waits passively; timeout preserves ownership and never restarts or kills work |
| `cancel()` | Reserves cancellation before delivery; stops future steps and retains partial output |
| `handoff()` | Once only, in the same Python process; copies the frozen payload through original handles to the fixed Final root |
| `release()` | After completed work or acknowledged cancellation, closes borrower, ZIP owner, parent and runtime guard, then observes child/stdio closure |
| `inspectIntent()` | Reads original journal bindings without resuming work |
| `retireInert()` | Explicit retirement of that exact retained child only before a start-packet write attempt; refuses active/uncertain work |

NDJSON frames have fixed schemas and size limits. The coordinator permits one
pipe write in flight and at most three queued controls. Cancellation supersedes
an unsent handoff. The guardian's input queue holds at most eight commands; its
latest-status slot prevents a blocked status writer from blocking the pump.
Status sequences may have gaps.

For an operational error, acknowledge cancellation before release. The original
failure remains visible. Releasing during a pending handoff refuses immediately;
historical extraction success cannot authorize closing active copy work.

Decoder pumping uses bounded chunks. Archive admission and each existing
`OwnedFileTransfer.transfer()` call remain synchronous inside the guardian.
Handoff cancellation is observed between files, not necessarily between 64 KiB
writes. Chunk sizes are not a wall-clock deadline or throughput claim.

## Disconnect and failure

Losing a status consumer does not dispose the coordinator or guardian. Controller
pipe EOF is different: it stops further work and holds custody without automatic
release or exit. A severed pipe cannot be repaired by launching another worker or
reopening paths. Controller reconnection/recovery is not implemented here.

Guardian death can release HANDLEs. Cached completion fields cannot reconstruct
custody. The coordinator records `CUSTODY_LOST`, refuses handoff and preserves
the no-replay journal. Tests deliberately retire their own quiescent held process;
this is not an automatic active-worker termination or recovery API. Survival of
a coordinator/OS job/boot is not established by the EOF test.

## Local qualification

```powershell
node --test tools/modding/vortex-agent/native-executor-journal.test.mjs
$env:VORTEX_OWNED_ZIP_WORKER_TEST = '1'
node --test tools/modding/vortex-agent/owned-zip-worker-client.test.mjs
```

The suites use own archives and scratch. They exercise autonomous extraction,
same-handle copy, explicit release, cancellation under START backpressure,
observer timeout, EOF custody, guardian loss, competing reservations, partial
records, source growth and ancestor replacement before and after preflight. They
are not live Vortex or performance tests.
