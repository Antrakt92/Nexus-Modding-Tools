# Internal extractor process owner

`ArchiveTempLease.create_extractor()` creates one inert process owner from the
fixed sibling `owned-extractor-process.py`. It is an internal building block,
not a Vortex installer, CLI or MCP endpoint. The archive lease remains the
custodian of the archive and temporary root. The owner uses the same thread,
nonreentrant lock, aggregate handle budget and close ledger.

## Lifecycle

| Method | Behavior |
| --- | --- |
| `start()` | Requires acquired healthy custody and an empty temporary root; verifies and holds the pinned executable/DLL; creates one suspended child in its own kill-on-close job |
| `resume()` | Resumes that exact retained thread once; an attempted resume is never refunded |
| `poll()` | Performs bounded nonblocking pipe reads and observes the exact process; process exit and both pipe EOFs are independent facts |
| `terminate()` | Records cancellation before terminating only the owned job; cancellation cannot be erased by exit code 0 |
| `close()` | Refuses active/unknown resources; releases process/job/pipe/runtime handles after terminal observation, without closing the archive lease |
| `status()` | Returns detached cached facts; no native polling or permission grant |

The initial backend admits only the reviewed 7z executable/DLL from the default
Windows Vortex installation. Executable paths, arguments and callbacks are not
caller options. Runtime files are opened through held local-NTFS ancestry and
hashed through retained read-only handles before process creation. The fixed
invocation still contains `-y`; this is not a per-file no-clobber extractor.

The child receives only its three stdio handles. It does not inherit the job,
archive or temporary-directory seals. Job membership is established during
process creation through `JOB_LIST`, before the suspended child executes. The
owner verifies image, creation time, thread ownership and job membership.
Unsupported process attributes refuse without a non-atomic fallback.

Native process/thread and pipe output storage is registered before kernel
calls. Scalar-return allocation windows are marked before entry; an interruption
that loses the returned handle remains uncertain rather than inventing closure.
Shared handle close is premarked before the native call, so an ambiguous raw
value is never retried. Once resource closure starts, polling uses cached facts
and termination cannot query or mutate already closed handle cells.

## Custody and handoff

Premature close refuses without implicitly canceling the child or releasing
the parent lease. After a normal resumed child reaches exit 0 and both EOFs,
the caller explicitly closes the process owner. Only then can that same lease
lend its original temporary-root handle to the transfer primitive. Payload
validation and native admission remain separate requirements.

Once factory creation is attempted, the lease cannot discard a failed, inert,
cancelled or poisoned owner and fall back to external extraction. Existing
leases that never called the factory retain their older trusted-external
quiescence contract. There is no new fallback switch or JSON terminal proof.

Errors retain the owner and lease. Known resources may be joined/closed through
the same object; uncertain resources stay held. No destructor, automatic retry,
partial-output deletion or rollback is provided. Dropping a response or reaching
a timeout does not establish termination. A worker that loses ownership still
requires the [guardian-loss recovery contract](NATIVE-CRASH-CUSTODY.md).

## Polling and responsiveness

The future guardian worker must drive `poll()` locally, independently of MCP
requests. Agents should read cached status rather than control pipe drainage
one remote call at a time. Slow drainage can backpressure the child.

Each pipe read is bounded to 64 KiB. Only a 4 KiB tail per stream is retained,
with bounded byte counters and an 8 MiB output limit per stream. These are
admission/storage bounds, not a measured peak-memory or latency guarantee.
There are no background threads in this component; worker scheduling and
transport are separate integration work.

## Verification

The native component suite is explicit and opt-in:

```powershell
$env:VORTEX_OWNED_EXTRACTOR_TEST = '1'
python -B tools/modding/vortex-agent/owned-extractor-process.test.py -v
```

The existing 22 transfer and 13 archive-custody cases remain separate suites.
The post-native-close interruption regression follows the shared single-entry
close helper after its extraction; its no-retry assertion is unchanged.

The 13 process-owner cases cover actual extraction/handoff, suspended cancellation,
foreign temporary content, wrong-thread refusal, and faults around process
creation, parent pipe closure, resource closure and attribute-list lifetime.
A fixture that witnesses a lost job-handle return or completed attribute deletion
checks permanent refusal before using its private witness for test cleanup.
That cleanup is not a production recovery path. The pipe-overflow case lowers
the limit to one byte while reading real child output; it checks the stop policy,
not throughput or an 8 MiB load. The separate guardian-loss fixtures exercise an
earlier process primitive, not a crash of this component's future worker.

All statuses keep `effectsAllowed:false`, `persistenceVerified:false`,
`nativeInstallAccepted:false` and `descendantsVerified:false`. These do not
deny the explicit process/filesystem effects of the component. They mean the
component grants no installation, durability or complete native-operation permit.

Still required: validated ZIP paths/instructions, no-clobber output ownership,
descendant/global operation policy, durable executor, native Vortex registration
and cleanup, and acceptance with the actual host entrypoint. Directory handles
do not prevent arbitrary insertion below the temporary root. This owner has no
Vortex state access and does not enable the adapter's installation operation.
