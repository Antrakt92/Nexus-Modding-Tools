# Custody across a caller crash

`tools/modding/vortex-agent/native-custody-process.test.py` is an opt-in Windows
x64 integration test with a separate surviving custodian. It uses an own ZIP,
new temporary directories and the pinned installed 7z binary. It is not a
launcher connected to Vortex, the Node SDK or MCP. Import is inert.

## Why child-only inheritance was rejected

The first experiment passed lease handles to a suspended 7z child, deliberately
terminated its keeper, then resumed extraction. One run kept five access probes
blocked in all 23 observed live batches. A later diagnostic run exposed a gap:
the first 22 batches were blocked, but all five opens succeeded in the final
batch while both surrounding process waits still returned `WAIT_TIMEOUT`.
The child subsequently signaled and reported exit 0. That run correctly failed
`LIVE_FENCE_RELEASED`; its result was not reclassified as success.

Windows documents that [ExitProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-exitprocess)
closes process handles before signaling the process object. The observed gap is
consistent with that order, although probes do not identify the precise internal
instruction. Inheriting file handles cannot by itself guarantee custody until
another process observes termination. A retained process handle or Job Object
membership does not retain the child's file handles.

## Surviving custodian

The supervisor owns the [archive/temp lease](ARCHIVE-TEMP-CUSTODY.md). It holds
the admitted archive and newly created temporary root while a separate caller
launches 7z. The caller deliberately exits after handing the exact process,
thread and pipe handles to the supervisor. Its death cannot release the
supervisor's lease.

The caller creates 7z suspended through `CreateProcessW` and `STARTUPINFOEXW`,
with explicit child stdio handles and creation-time `JOB_LIST` assignment.
The unnamed job has a queried `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` setting.
The caller closes its temporary job handle before ACK; 7z does not inherit it.
The supervisor checks creation time, image, thread ownership and membership in
its exact job before takeover. Unsupported or incompatible nested-job creation
refuses without a non-atomic fallback.

After caller exit 73, the supervisor probes the still-suspended reader, resumes
its retained thread once, then samples access around exact process waits. It
requires child exit 0 and separate stdout/stderr EOF observations. Payload
size/hash, temporary-root identity and source/binary pins must match.

All five access probes must remain blocked even after child and pipes terminate,
until the custodian explicitly closes its lease. They must succeed afterward.
The control omits custodian ownership and requires open access while the child
is still suspended after caller exit. Probes request archive write or DELETE
access to the archive, temporary root and both parents; they never perform a
write, rename or deletion.

## Run explicitly

Default execution skips the native cases:

```powershell
$env:VORTEX_NATIVE_CUSTODY_TEST = '1'
python -B tools/modding/vortex-agent/native-custody-process.test.py -v
```

The test admits only `7z-bin/win32/7z.exe` beneath the default Windows Vortex
installation, SHA-256
`fcd699098397e8981104c51afe32f4527cb6f02a5b64cbb6b2581f4749808e8c`,
and its adjacent DLL, SHA-256
`bbd705e3b58ca7677c1e9e67473f166a6712da034dcb567d571fbb67507a443f`.
Missing/different binaries fail before generating the 32 MiB payload; the test
installs nothing and accepts no alternate command. Each case creates fresh
ignored output below `local-state/native-custody-process-tests`; an existing
intent is never replayed. Keep recipes/plans/reports for reconciliation and
follow [local cleanup](LOCAL-CLEANUP.md) separately.

On 31 October 2026, both opt-in cases passed on Windows build 26300, Python
3.14 and NTFS. The guardian case recorded 22 live batches with all five opens
blocked, retained them after child exit 0 and both pipe EOFs, then released them
explicitly. The control recorded open access before reader start and after its
termination. Both 32 MiB payloads matched their size and SHA-256. Default
execution skipped both cases as intended. These counts describe this run,
not a timing or throughput guarantee.

## Loss of the guardian

Two additional cases terminate the guardian itself after the launcher has
closed its temporary job handle. An outer observer receives only the exact
reader process/thread and output-pipe handles, never the job or file seals.
The guardian is the sole remaining owner of the kill-on-close job handle.

The suspended case never resumes the reader. The running case first reads
known own-entry output from 7z, then stops reading and requires eight observations
of a full stdout buffer with the exact process still unsignaled. Its ZIP adds
2,048 empty own entries to make output exceed the measured pipe buffer. This
is an observed backpressure fixture, not a thread-instruction or throughput
measurement.

After the controlled guardian exit, the observer requires exact reader
termination and both pipe EOFs. It also requires absence of a normal guardian
success report. Exit code is recorded, never treated as success proof: in the
first actual runs, even the never-resumed reader ended with code 0. Microsoft's
[kill-on-close contract](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)
specifies termination, not a particular exit value. The original tests' nonzero
expectation was rejected; those failed reports were preserved.

Before launching the guardian, the observer writes a real
[`native-intent-journal`](NATIVE-DISPATCH-CONTRACT.md#immutable-intent-storage)
fixture. The full request binds the own archive/payload and fixture context,
not admitted live Vortex roots. Its independently retained operation ID and
request digest are supplied to a fresh journal reader after termination.
The required result remains `intent_observed`, `dispatchState:unknown`,
`reconcileRequired:true`, `canReplay:false` and `effectsAllowed:false`.
Containment cannot turn a lost owner into a completion or retry permit.

The intent fixture pins its Python and Node entrypoints, native module, helper
and the helper's six local journal/protocol dependencies. Checks before and
after helper calls reject source drift. Separate metadata-only Node tests
exercise stale source pins, incorrect expected digests, repeated begin and
preservation of the original intent bytes. These tests do not validate ZIP
format or perform native installation.

The four native cases passed together on the reviewed host on 31 October 2026.
Both controlled guardian-loss cases observed reader exit code 0, exact process
termination and both EOFs; neither produced a normal completion receipt. Their
fresh journal statuses matched the original pre-launch bindings and remained
unknown and non-replayable. The running case recorded own-entry output and all
eight full-pipe observations before guardian loss; the suspended case never
resumed its reader.

## Remaining gates

The normal custody pair requires a surviving guardian. The controlled loss
cases test containment after launcher takeover; they do not cover every crash
before process creation/handoff, arbitrary simultaneous failures, descendant
behavior or a production recovery transaction. Guardian death releases its
seals: the loss cases do not claim custody until observed reader termination or
authorize successor filesystem actions. Directory handles do not fence
arbitrary descendants. Sampling cannot prove protection at every instant.

The prepared Node SDK spawn path does not use this launcher. Earlier SDK
normal-path tests plus this separate experiment do not establish crash-safe
SDK or Vortex integration. Durable admission/recovery, no-clobber extraction,
registration and cleanup remain unproved. Every result retains
`nativeInstallAccepted:false`, `persistenceVerified:false` and
`descendantsVerified:false`.

This is not a performance benchmark: compression, hashing, probes and process
supervision add unmeasured costs. The local Windows SDK 10.0.26100.0
`WinBase.h` defines `JOB_LIST` as input attribute 13 under its Windows 10 guard.
See Microsoft's [process creation](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
and [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
references for the underlying APIs.
