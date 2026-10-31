# Prepared deployment, purge and refresh ownership

This extends the [manager](NATIVE-MANAGER-EXCLUSION.md) and
[remove/create handler](NATIVE-LIFECYCLE-HANDLERS.md) preparations against Vortex
v2.9.1, commit `c80326367cbe6d96621ad6cf4a5488ef49bac110`. These are exact-source
patches, not an installed application update or an available MCP operation.

## Patch ordering

Each manifest identifies its own source path and prerequisite hashes. Dependencies
can cross source files; never apply a patch to its prerequisite's output merely
because that prerequisite appears first in this table.

| Source | Ordered additions |
| --- | --- |
| `InstallManager.ts` | Existing series through `lifecycle-owner-bridge`, then `lifecycle-result-bridge` |
| `index.ts` | `deployment-lifecycle` |
| `modActivation.ts` | `deployment-cancel` |
| `eventHandlers.ts` | `lifecycle-handler-ownership`, then `refresh-lifecycle` |
| `util/deploy.ts` | `purge-join`, then `purge-ownership` |
| `util/activationStore.ts` | `activation-join`, then `activation-ownership` |

The result bridge preserves fulfilled return values while retaining the same
bounded renderer-class activity set. Existing void producers remain compatible.
Rejection or unknown startup retains ownership; no token reset, expiry, native
dispatch or release API is supplied.

## Deployment queue and writer

The existing deployment Debouncer keeps its identity, coalescing and rescheduling
policy. Its `schedule` and `runNow` reserve a pending owner before enqueueing.
Each callback is delivered once while ownership is still held. Callback exceptions
cannot interrupt delivery to siblings. Successful settlement also waits for the
raw scheduling call to return: a synchronous callback followed by a startup throw
cannot refund the owner. `clear()` never releases pending ownership.

The actual deployment writer takes another owner in the same set. Effects begin
one microtask later, so GenericDebouncer marks itself running before Redux,
progress or extension callbacks can reenter it. Scheduling from a running writer
or callback keeps a separate owner for the next run; there is no moment of false
idle between those runs.

Ownership includes the activation-lock queue, post-lock `did-deploy`, settings
baking and final cleanup. Operational errors still report through existing UI
paths, then reject instead of returning success. A failed error notification
cannot replace the operation error. Single-mod and lower-level activator cancel
promises are awaited, preserving the primary failure even if cleanup/logging fails.

`wait()` remains an observer, with safe one-shot callback delivery. It does not
own or prove completion of every future reschedule. Refusal at the shared capacity
happens before enqueue; it is not an unlimited waiting queue or a retry signal.

## Purge and manifest writers

The low exported roots participate directly: `purgeMods`, `purgeModsInPath`,
`purgeDeployedFiles`, fallback purge/type, `saveActivation` and `withActivationLock`.
This also covers callers outside the purge event, such as profile unmanagement
and manifest-query cleanup. The lock wrapper owns queued work before it starts
and preserves its exact fulfilled result.

Purge joins already-started manifest writes before recovery, then joins recovery
writes before post-purge cleanup. Deployed-file stat/unlink branches are joined
before failure escapes. Synchronous factory failure stops further starts but
joins earlier ones. Separate failure flags preserve rejected `undefined`/`null`.
The first relevant error survives recovery, postPurge, progress/events and final
notification/activity cleanup. Existing successful recovery after ProcessCanceled
keeps its ordinary policy; independent failed writer owners are not refunded.

Manifest settlement is not successful persistence proof. Existing saveActivation
backup/delete error suppression remains upstream behavior and needs independent
readback before any future success claim.

## Refresh tails

Both public refresh handlers keep their void interfaces while their private bodies
return the actual initialization, old-method purge, refresh and final event tails.
A canceled old-method purge cannot continue activator selection and refresh.
Error presentation preserves the original rejection. Local parallel old-method
manifest batches use the joined helper; imported staging/refresh/extension
internals still need their own evidence.

## Qualification and limits

Exact installed-source cache inputs cover the manager, event handlers and index.
Additional deployment, activation, modActivation and GenericDebouncer inputs come
from the official pinned Git tree. Their installed-package parity is not yet
established. Source tests execute actual declarations and the pinned
GenericDebouncer with own API, filesystem, promise and timer stubs. Deployment
core tests substitute the activation-lock body while exercising its real post-lock
continuation; they do not perform physical deployment. A timer-factory component
case exercises the actual `once` initialization prefix.

Set the matching exact-source paths, then run:

```powershell
node --test tools/modding/vortex-agent/native-deployment-lifecycle-patch.test.mjs tools/modding/vortex-agent/native-refresh-lifecycle-patch.test.mjs tools/modding/vortex-agent/native-purge-join-patch.test.mjs tools/modding/vortex-agent/native-purge-ownership-patch.test.mjs
```

Required environment inputs are `VORTEX_NATIVE_INSTALL_MANAGER`,
`VORTEX_NATIVE_EVENT_HANDLERS`, `VORTEX_NATIVE_MOD_INDEX`,
`VORTEX_NATIVE_DEBOUNCER_SOURCE`, `VORTEX_NATIVE_MOD_ACTIVATION_SOURCE`,
`VORTEX_NATIVE_DEPLOY_SOURCE` and `VORTEX_NATIVE_ACTIVATION_SOURCE`.
Missing source causes explicit skips, not acceptance. No VM is a security sandbox.

Full application build/typecheck, import-cycle/renderer acceptance, physical
filesystem completion and extension-listener termination remain unproved.
Arbitrary Redux/profile/extension writers are not covered by these patches.
[Startup incomplete-install cleanup](NATIVE-STARTUP-CLEANUP.md) has a separate
prepared ownership patch. Host-wide idle, durable dispatch, new-only
registration, terminal release and safe keeper/removal still require their gates.
Never patch the installed app or treat this source preparation as permission to
run a legacy installer or clear an unresolved journal.
