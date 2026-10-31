# Child resource observation

`tools/modding/vortex-agent/child-terminal-observer.cjs` observes one trusted
owner's actual Node `ChildProcess`. It supplies a constant-size `read()` snapshot
independently of a caller's promise. It does not spawn, cancel or kill a process,
read files, remove listeners on request, clean up paths or expose an MCP tool.
Production observation creates no promise, so replacing the global Promise with
Bluebird does not make observation itself cancellable.

## Attach and retain

The owning executor must attach synchronously immediately after its trusted
`spawn()` returns, before awaiting anything. Supply the exact child and its three
distinct piped stdin/stdout/stderr objects. Inherited streams, IPC and late
adoption are outside this contract. Keep the observer, child and streams alive
until the executor reconciles the operation. Do not reconstruct evidence from
a PID, current process list, elapsed timeout or an already-settled promise.

The detached binding contains exactly `operationId`, `nativeJobId`,
`requestSHA256` and `rendererGeneration`. Their formats match the dispatch
contract's ID/hash domains. They are labels from a future admitted executor;
shape validation does not establish source admission, native identity, durable
intent or exclusion against another child using the same job ID. The existing
executor/consumed-ID contract remains responsible for those checks.

Each child can be observed once by this module instance. Repeated attachment
refuses rather than replacing the first observer. There is no retry, takeover,
expiry or independent job catalog. The owner must not reload the module to
bypass this boundary.

## Closed resources and operation result

`read()` returns detached, frozen observations. `childResourcesClosed` requires
the exact child's close and all three observed pipe closes, plus consistent
spawn/exit evidence or the separately recognized failed-spawn sequence. A
normal exit by itself, a kill request, cancellation or a pipe error is insufficient.
Missing events, ambiguous late attachment or contradictory observations remain
held rather than being reconstructed as successful termination.

Callback order matters: in an observed Windows run, the child close callback
preceded our stdout/stdin close callbacks. The observer therefore joins its own
four close observations instead of releasing resources inside child close alone.
It does not consume output or drain pipes; the trusted owner must keep bounded
output readers running so a full pipe cannot block the child.

Closed resources are not a successful extraction or a cleanup permit.
`exitSucceeded` reports only an observed zero exit code without a signal; it can
be true before pipes close and does not override a held observation. Exit code
zero does not erase errors or external cancellation. The executor still needs
sticky cancellation/failure state, matching durable intent and independent payload
and ownership checks before subsequent effects. Descendant processes, detached
work, OS crash persistence and safe directory deletion are not proved. The
module grants no native installation permission.

Its error listeners deliberately record child/pipe errors instead of leaving
those events unhandled. This changes EventEmitter error handling; passive means
no process or filesystem action, not zero effect on listener semantics. The
owner must still reconcile those errors and retain its own error policy.

## Verification

```powershell
node --test tools/modding/vortex-agent/child-terminal-observer.test.cjs
```

The suite uses owned Node children; it does not invoke Vortex, a game or 7-Zip.
For the optional installed Bluebird comparison, set `VORTEX_BLUEBIRD_ROOT` to an
independently captured, pinned runtime source cache. Never install a dependency
just to satisfy this diagnostic. A missing fixture is an explicit skip and does
not establish that runtime's cancellation behavior.

The prerequisite experiment used exact installed Bluebird 3.7.2 JavaScript and
the prepared runner with a simulated child: canceling the promise ran `finally`
without child close or a kill request. That proves a promise mechanism, not that
a particular Vortex UI cancellation path reaches it. The observer tests must
keep that distinction and verify actual child lifetimes separately.

This is an internal observation component, unconnected to native installation.
It is not an in-process security sandbox: a trusted owner must supply the real
child and preserve the event machinery. Shape checks cannot authenticate events
against hostile code that can emit or replace them in the same process.
