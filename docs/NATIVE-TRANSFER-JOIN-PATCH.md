# Prepared transfer-worker join patch

The [copy-error repair](NATIVE-COPY-ERROR-PATCH.md) makes a failed copy visible,
but the existing concurrency helper rejects before other workers necessarily
finish. `extractArchive()` can therefore reject into the caller's error cleanup
while another transfer callback is still writing.

The [patch](../tools/modding/vortex-agent/native-patches/vortex-2.9.1/transfer-join.patch)
uses a local joined pool for this method's directory-creation and transfer phases.
The first observed callback failure stops new callback scheduling. Already-started
callbacks are awaited before the method rejects with the original first error.
An explicit failure flag preserves `null`, `undefined` and non-Error rejections.
Synchronous callback throws are handled too.

Success keeps the existing directory/file concurrency caps and once-only job
processing. The global `mapWithConcurrency` helper and its dependency/cancellation
consumers remain unchanged. No `AbortSignal`, timeout, retry, forced cancellation
or native endpoint is added.

## Source and verification

The adjacent manifest pins official Vortex `v2.9.1`, commit
`c80326367cbe6d96621ad6cf4a5488ef49bac110`, the exact original source and the
ordered copy-error prerequisite. The patch is prepared only and uninstalled;
complete application build/typecheck and native acceptance remain open. Preserve
upstream GPL licensing and attribution; never patch the active `app.asar`.

```powershell
$env:VORTEX_NATIVE_INSTALL_MANAGER = 'C:/ReviewedSource/InstallManager.ts'
node --test tools/modding/vortex-agent/native-transfer-join-patch.test.mjs tools/modding/vortex-agent/native-copy-error-patch.test.mjs
```

Tests execute the real source-derived transfer method with controlled filesystem
and API stubs. No application constructor, filesystem transfer, deletion, native
install or game runs. The VM is a test mechanism, not a security sandbox. Missing
independently obtained exact source causes explicit skips, not acceptance.

Deferred mkdir/copy cases prove the baseline early rejection and the repaired
ordering: caller cleanup cannot proceed through this returned Promise until the
other returned callbacks settle. Other cases cover queued work, synchronous
failure, later competing errors, preserved first-error identity, empty input,
successful concurrency and self-copy compatibility. Shared test-fixture extraction
keeps the preceding copy-error regressions intact.

## Remaining boundaries

A joined callback Promise is not proof of extractor/child exit or detached native
work that the callback did not return. A callback that never settles keeps the
method pending; a timeout must not authorize cleanup or ownership release.

The existing remove-before-copy/overwrite behavior, missing-source warning and
path-based error cleanup remain separate problems. Waiting for returned workers
does not make cleanup ownership-safe or prove a complete payload. Owner-aware
registration, no-clobber transfers, held source/ancestor identities and durable
effect exclusion remain required. All native terminal, ownership, no-clobber and
installation-permit flags stay false. Continue through the
[implementation stages](LOCAL-INSTALL-IMPLEMENTATION.md).
