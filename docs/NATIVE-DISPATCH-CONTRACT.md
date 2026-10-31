# Next native dispatch contract

This is the implementation contract for the next installation stage. The closed
request and consumed-ID model below are implemented offline; native dispatch and
the durable executor remain absent. This is not an available native API, an
installed capability or permission to invoke legacy install events. The
[job model](LOCAL-INSTALL-IMPLEMENTATION.md) and
[activity patch](NATIVE-ACTIVITY-PATCH.md) remain separate preparations.

## One fixed native entrypoint

Use a new fixed `start-install-tracked-new-disabled` entrypoint with closed
runtime validation. Adding a field to legacy install options is insufficient:
the current handler ignores unknown options and can still enter replacement
logic. An absent capability/listener, unsupported contract or mismatched source
must refuse before dispatch. Never fall back to `start-install-download`, direct
local installation, folder-drop or `create-mod`.

The first family is one exact existing tracked own-local ZIP, installed disabled,
with no automatic deployment. Context, expected owner/type, archive bytes/hash,
payload and source/admission evidence come from the frozen plan. No arbitrary
events, installer code, replacement options or dependency operations are inputs.

## Bind the intent before effects

The executor allocates an opaque `exec_<32 lowercase hex>` native job ID before
writing its intent. It also pins the current manager scope and renderer generation.
The latter must identify the renderer lifetime; a manager counter or process ID
alone is insufficient across restart/PID reuse.

## Closed request and consumed-ID model

`tools/modding/vortex-agent/native-dispatch-contract.cjs` accepts strict UTF-8 JSON
bytes only. Its closed request has these exact fields:

| Field | Required value |
| --- | --- |
| `schema` | `native-dispatch-request/1` |
| `contractId` | `tracked-new-disabled-dispatch/1` |
| `operationId` | `op_` plus 32 lowercase hexadecimal digits |
| `nativeJobId` | `exec_` plus 32 lowercase hexadecimal digits |
| `planId` | Canonical SHA-256 of the complete validated embedded plan |
| `managerScope` | Existing diagnostic `manager-<nonce>-<sequence>`; nonce is 1–64 ASCII letters/digits/underscores/hyphens, sequence is a positive safe integer in ordinary decimal without leading zeroes |
| `rendererGeneration` | `renderer_` plus 32 lowercase hexadecimal digits |
| `admissionSHA256` | SHA-256 of the fresh admission snapshot, corresponding to the job model's `admission_observed.snapshotSHA256` |
| `plan` | Complete validated `install-job-plan/1`, including context, root identities, package, payload, evidence and disabled/no-deploy options |

`plan.evidence.nativeAdmissionSHA256` identifies the source/capability admission
document; it is distinct from the fresh snapshot hash. Unknown fields and a
mismatched `planId` refuse. The request digest binds every field with recursively
sorted object keys; JSON whitespace and key order do not change it. The byte
boundary copies non-shared `Buffer`/`Uint8Array` contents without invoking caller
accessors; shared buffers, proxies, duplicate decoded keys and malformed UTF-8
refuse. The complete envelope is limited to 1 MiB + 4 KiB, depth 18 and 50,128
JSON tokens. The embedded plan retains its own stricter budgets.

`createConsumedRegistry` takes a separate closed JSON byte document containing
only `managerScope` and `rendererGeneration` (maximum 1 KiB). Its synchronous
`consume(requestBytes)` validates that lifetime, then records compact request
digest/ID bindings in two indexes. Either a reused operation ID with another job
or a reused job ID with another descriptor refuses. Exact duplicate consumption
also refuses. `inspect(requestBytes)` reads only an exact matching binding and
never consumes it. The capacity is 1,024 operations; no entry is evicted or
released, including after errors, lost replies or caller cancellation. Existing
exact status remains readable at capacity. There is no callback, await or native
invocation in this module, and every status has `effectsAllowed:false`.

The factory does not establish a renderer generation, durable operation, source
admission, cancellation or an installation permit. The future renderer owner must
mint a fresh lifetime nonce, instantiate exactly one registry per live manager,
and never recreate it to bypass a hold. The executor must allocate and persist
the operation/job IDs and matching request digest before requesting consumption.
A new registry has no durable history; it cannot authorize cross-generation
replay. Shape checks and matching caller-supplied hashes prove no external facts.

## Required executor ordering

### Immutable intent storage

`native-intent-journal.mjs` supplies `createNativeIntentJournal({root})`, with
`begin(requestBytes)` and `read(operationId, expectedRequestSHA256)`. The default
root is `<runtime>/local-state/vortex-agent-build/native-install-intents`, beside
the existing plan journals and flat receipts. It is not inside the receipts
directory, whose installer inventory does not accept subdirectories.

`begin` validates and detaches the entire request before creating anything. It
exclusively reserves `<operationId>` and publishes one fixed `intent.json` record
containing the full semantic request, canonical digest and root/directory
identities. Both journals share the internal `immutable-records.mjs` I/O:
exclusive temporary file creation, file flush, no-overwrite hardlink publication,
pending-name removal, writer close and exact reopened-byte verification. The
record budget is 1 MiB + 8 KiB, including the bounded request wrapper. The native
reader inspects at most two directory entries to detect unexpected files.

Partial directories, pending files, write errors or an existing reservation hold
the operation; nothing is deleted to retry. Root identity is checked again after
child-directory discovery/reservation, so a replacement root cannot become new
authority. Existing enable/deploy journals receive the same repair, including
readback when the original operation directory was moved into a foreign root.
These are observed namespace checks, not an OS-enforced boundary against a
hostile process with write access to the workspace.

Fresh readback requires the caller's independently retained request digest. A
matching digest calculated from the same stored record is not independent
binding. Missing binding, mismatched requests and inconsistent records refuse;
the caller must retain the original binding for recovery. A missing operation
returns `not_observed`, with `dispatchState:unknown`, `canReplay:false` and
`reconcileRequired:true`. A valid intent also has unknown dispatch state. Neither
state proves whether an external effect occurred.

This storage layer has no append/resume, acknowledgement, dispatch token,
cancellation or cleanup API. Every status retains `effectsAllowed:false` and
`powerLossPersistenceVerified:false`. File flush and process-exit readback tests
do not establish survival of directory publication after OS crash/power loss.
The intent journal reserves operation IDs only. The separate
[scratch worker and executor journal](OWNED-ZIP-WORKER.md) add permanent job-ID
bindings before that worker's filesystem effects. They do not provide shared
native-manager exclusion, authoritative renderer lifetime, capability admission,
effect ordering and the remaining native gates. No caller option can promote
the observed intent into an installation permit.

Synthetic tests cover ten real child-process exit windows (reservation through
post-return), two simultaneous reserving processes, injected I/O failures,
partial/corrupt and coherently replaced records, root replacement and a near-limit
request whose complete record exceeds the older journal's 1 MiB limit. They
exercise local filesystem mechanics, not Vortex or hardware power loss:

```powershell
node --test tools/modding/vortex-agent/native-intent-journal.test.mjs tools/modding/vortex-agent/plan-journal.test.mjs
```

### Native invocation remains held

Required order:

1. Exclusively create the durable operation and verify native capability/source
   admission. Record the exact ID, request digest and lifetime pins in the intent.
2. Complete the intent's persistence gate before any native invocation. Check
   cancellation and current context immediately before dispatch.
3. Validate the native request and lifetime pins synchronously. Consume its ID
   before the first await, hook, queue insertion or installer invocation.
4. Register native activity under that exact ID and enter only the strict
   new-disabled path. Do not infer identity from list differences or filenames.
5. Keep acknowledgement, callback, status and final readback bound to that ID and
   descriptor. A callback is independent of native completion and payload proof.

The persistence gate must state its process-crash and power-loss boundaries.
File readback alone is not proof that directory entries survive power loss; an
uncertain persistence result must stop before dispatch.

Legacy `install()` retains its existing generated IDs and signature. It must not
gain a caller-controlled ID override. Only the new strict entrypoint can accept
executor-owned IDs in a separate namespace.

## One-shot consumption and recovery

Keep a separate bounded consumed-ID registry for strict requests. The activity
registry's 128 recent rows are diagnostics, not a deduplication ledger. Start
with a hard capacity of 1,024 strict IDs per manager lifetime, no eviction, TTL,
stale takeover or release after failure. Refuse new strict requests at capacity;
legacy jobs do not consume this budget.

Reject a consumed ID without a second invocation. Returning an existing status
also requires the exact descriptor digest; a different descriptor under that ID
must refuse. Persisted executor state must prevent replay across native generations.

A lost reply requires inspection of the original bound ID. A missing/evicted
activity, changed generation or intent without known native acceptance remains
uncertain. Never resend automatically, create a new job ID to bypass the hold,
or clear a consumed ID after a partial failure. A crash after consumption cannot
make that ID reusable within the surviving manager lifetime.

Before dispatch, only the live executor can establish that cancellation prevented
invocation. After dispatch, cancellation blocks later effects while observation
continues; it does not stop an extractor, undo installation or authorize replay.

## Required regressions and remaining native gates

The offline request/registry suite covers complete-plan digest binding, canonical
formatting, closed IDs/lifetimes, malformed and oversized input, accessors/proxies,
shared buffers, synchronous duplicate consumption, two-index replay exclusion,
full capacity without eviction and a lost reply. It does not exercise a native
installer or a durable intent. Run it with:

```powershell
node --test tools/modding/vortex-agent/native-dispatch-contract.test.cjs
```

Test exact ID persistence before invocation; simultaneous duplicate requests;
descriptor mismatch; wrong manager/renderer generation; callback reentrancy;
lost acknowledgements; crashes around intent/consume/ack; cache eviction; hard
capacity; cancellation on both sides of dispatch; and late observations with
wrong bindings. Legacy argument and dependency behavior must remain unchanged.

This protocol does not establish no replacement, exclusive owner/path reservation,
atomic no-clobber import, extractor/child exit, global idle or payload integrity.
Those contracts and full host acceptance remain mandatory before enabling MCP
installation. A separate inert reservation protocol would add another lifecycle
without removing these gates; it is not needed merely to allocate an ID.

The prepared [private strict-selection patch](NATIVE-STRICT-SELECTION.md) refuses
legacy metadata/replacement routes for its internal branch. It does not connect
this protocol to a native listener or establish physical ownership, safe cleanup
or a complete no-replacement installation guarantee.

The reviewed `create-mod` handler registers state before asynchronously ensuring
its directory. Folder-drop copies after registration, and failure does not undo
that registration. Preparing a directory first does not turn either route into
atomic ownership or new-only adoption. A new adopter would be a separate install
engine with its own recovery obligations, not a shortcut through existing APIs.
