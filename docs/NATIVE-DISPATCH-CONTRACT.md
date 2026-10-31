# Next native dispatch contract

This is the implementation contract for the next installation stage. It is not
an available API, an installed capability or permission to invoke legacy install
events. The [job model](LOCAL-INSTALL-IMPLEMENTATION.md) and
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

The closed native request binds the contract version, operation ID, plan hash,
native job ID, manager scope, renderer generation, admission hash and exact
tracked-package descriptor. Its canonical digest binds all fields. The next code
stage must specify the complete field schema before accepting any request.

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

The reviewed `create-mod` handler registers state before asynchronously ensuring
its directory. Folder-drop copies after registration, and failure does not undo
that registration. Preparing a directory first does not turn either route into
atomic ownership or new-only adoption. A new adopter would be a separate install
engine with its own recovery obligations, not a shortcut through existing APIs.
