# Prepared installation activity patch

This source patch follows the exact [callback patch](NATIVE-CALLBACK-PATCH.md)
against official Vortex `v2.9.1`, commit
`c80326367cbe6d96621ad6cf4a5488ef49bac110`. It is not installed and does not
enable installation, cancellation or generic dispatch through MCP.

Vortex's debug active-install map can lose an entry on a timeout or callback
while its installation promise still runs. The callback-backed limiter can also
settle before the core promise's final cleanup and fallback. Neither counter is
enough to decide that a particular native operation has finished.

The [patch](../tools/modding/vortex-agent/native-patches/vortex-2.9.1/native-activity.patch)
adds a separate per-invocation diagnostic registry. `install()` retains its
signature and void return; its original body moves to a private method. The
registry observes queued, running and settled work without changing dependency
deduplication or using the debug map as a lifetime signal.

Each manager has a scope containing a nonce and checked manager sequence; each
invocation has a checked sequence within that scope. Two managers cannot reuse
an ID within the loaded class, even if their nonces collide. A future executor
must still bind the renderer/process generation across reloads.
Generated IDs fit the existing pure operation model; this compatibility does not
connect that model to native dispatch. The diagnostic list is not an operation
acknowledgement. A future entrypoint must bind its intent to the exact native ID
before effects, rather than guessing from list differences or the mod basename.

## Reading observations

`getNativeInstallActivities()` returns detached active and recent observations.
`getNativeInstallActivity(nativeJobId)` reads one exact ID. Results contain no
archive paths, raw errors or account data.

- `coreStarted` records entry into core startup. A synchronous startup failure
  with uncertain effects remains held rather than inventing completion.
- `coreTailSettled` records settlement of the observed core tail, including its
  joined destructive cleanup and missing-callback fallback. It is false when an
  invocation settles before a core tail exists.
- `callbackOutcome` is independent of core settlement. A timeout notice cannot
  settle a running core; a settled core does not imply callback success.
- `metadataPending` tracks the existing staging-size calculation separately.
  That calculation reads staging and updates `modSize`; it does not write the
  payload or read the archive. Optional metadata does not delay core settlement.

Only the latest 128 settled jobs are retained. An unknown, evicted or foreign
ID returns `not_observed`; it never establishes completion or absence of work.
Recent rows are diagnostic observations rather than immutable durable receipts:
metadata can finish after a row enters the recent set. Previously returned
snapshots remain detached.

The legacy limiter's `clearQueue()` does not settle its abandoned promises.
Such queued activities remain held. This patch adds no cancellation, timeout
completion, automatic replay or global-idle claim.

## Verification and remaining gates

The [manifest](../tools/modding/vortex-agent/native-patches/vortex-2.9.1/native-activity.json)
pins the ordered prerequisite, input, patch and output. Source-derived tests
apply the series in memory and run the trusted class with deferred owned values
and mocked dependencies. They exercise the real callback, cleanup and fallback
tails, but replace the preceding extraction/instruction pipeline. No application
constructor, extraction, native event or filesystem deletion runs. The VM is a
test mechanism, not a security sandbox.

```powershell
$env:VORTEX_NATIVE_INSTALL_MANAGER = 'C:/ReviewedSource/InstallManager.ts'
node --test tools/modding/vortex-agent/native-activity-patch.test.mjs
```

Source-derived cases explicitly skip without the separately supplied exact
source. Full upstream build/typecheck, dependency integration and native host
acceptance have not been run. No extractor-process or child-process exit proof,
asynchronous extension-listener completion, deployment proof or filesystem
ownership is established. `coreTailSettled` is not an archive-seal release permit.

Keep the ordinary MCP install refusal until the combined native contract passes
the [remaining stages](LOCAL-INSTALL-IMPLEMENTATION.md). Never apply this patch
directly to an installed `app.asar`.
