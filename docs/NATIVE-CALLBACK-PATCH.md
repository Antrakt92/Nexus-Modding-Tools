# Prepared installation callback patch

This patch follows the [ordinary tracking patch](NATIVE-TRACKING-PATCH.md) against
official Vortex `v2.9.1`, commit
`c80326367cbe6d96621ad6cf4a5488ef49bac110`. It is a source artifact, not an
installed application update or an MCP installation endpoint.

The original success path invokes the completion callback before emitting
`did-install-mod`. A synchronous event listener can then throw and enter the
error path that removes the destination. A callback exception can also enter
that destructive error path. Repeated completion and debug cleanup can deliver
the same callback more than once.

The [patch](../tools/modding/vortex-agent/native-patches/vortex-2.9.1/callback-order.patch):

- emits synchronous `did-install-mod` before reporting success;
- delivers each callback once, isolating callback and success-bookkeeping errors
  from native installation failures;
- checks the exact tracking object before updating or deleting its map entry,
  including delayed fallback and forced debug cleanup; fallback deletion checks
  again after synchronous state subscribers can replace the entry;
- routes forced debug cleanup through the same one-shot callback.

The [manifest](../tools/modding/vortex-agent/native-patches/vortex-2.9.1/callback-order.json)
pins the prerequisite patch, complete input, diff and output. Apply only to that
exact prerequisite output. Retain the upstream GPL license and attribution.

## Verification and limits

```powershell
$env:VORTEX_NATIVE_INSTALL_MANAGER = 'C:/ReviewedSource/InstallManager.ts'
node --test tools/modding/vortex-agent/native-tracking-patch.test.mjs tools/modding/vortex-agent/native-callback-patch.test.mjs
```

The tests verify the raw original source, apply the patches in memory without
fuzz, and execute the trusted class with mocked registration dependencies. They
replace the preceding extraction/instruction pipeline with owned values, then
exercise the real success, error, callback, fallback and debug cleanup code. No
application constructor, extractor, native install or filesystem deletion runs.
The VM is a unit-test mechanism, not a security sandbox. Without the separately
supplied pinned source, source-derived cases are explicitly skipped.

Regressions cover event failures, callback and diagnostic exceptions, success
bookkeeping failures, native failures, repeated callbacks, replacement map entries
and forced cleanup followed by late completion. These checks do not replace the
full upstream build, typecheck, dependency integration or native acceptance.

The callback remains a synchronous notification. Its returned promise, any
asynchronous event listener and later native cleanup are not awaited by this
patch. Forced cleanup does not stop an extractor or prove native termination.
The existing recovery fallback can still report success after certain failures;
the callback alone cannot establish an accepted payload or successful operation.

No replacement prevention, exclusive filesystem ownership, import collision
protection or native terminal contract is added. Keep ordinary MCP installation
refused and continue through [the implementation stages](LOCAL-INSTALL-IMPLEMENTATION.md).
Never apply this diff directly to the installed `app.asar`.
