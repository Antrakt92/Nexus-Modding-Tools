# Prepared native copy-error propagation patch

The reviewed Vortex `v2.9.1` transfer method catches a failed copy fallback and
returns successfully even when the failure is unrelated to self-copy.
For example, a hardlink rejected with `EXDEV` followed by a copy rejected with
`ENOSPC` can make `extractArchive()` resolve without completing that transfer.

The [patch](../tools/modding/vortex-agent/native-patches/vortex-2.9.1/copy-error.patch)
adds error propagation after the existing self-copy exception. It preserves the
original rejection value, including non-Error values, so the native caller can
observe failure instead of receiving false success. The patch is prepared only;
it has not been installed or accepted by a complete Vortex build/typecheck.

Its adjacent manifest pins official commit
`c80326367cbe6d96621ad6cf4a5488ef49bac110`, the original source and the exact
ordered [strict-selection prerequisite](NATIVE-STRICT-SELECTION.md). Tests apply
the series in memory without changing the source cache or installed application.
Preserve upstream GPL licensing and attribution. Never patch the active
`app.asar` directly.

## Verification

```powershell
$env:VORTEX_NATIVE_INSTALL_MANAGER = 'C:/ReviewedSource/InstallManager.ts'
node --test tools/modding/vortex-agent/native-copy-error-patch.test.mjs
```

The source-derived fixture executes the real `extractArchive` method and its
real `mapWithConcurrency` helper with owned filesystem/API stubs. It bypasses
the application constructor; no copy, deletion, extractor or native install runs.
The VM is a unit-test mechanism, not a security sandbox. Missing independently
obtained source is an explicit skip, not native acceptance.

Regressions demonstrate the baseline false success, failure propagation across
recognized copy fallbacks, preserved hardlink/copy/self-copy behavior, original
non-Error rejections and other directory/link/removal failures. A parallel-worker
test proves that method rejection can occur while another transfer is still
running; it is not a terminal signal or permission to release ownership.

## Remaining gates

This repair does not change existing remove-before-copy or overwrite behavior,
the self-copy message heuristic, or the missing-source warning-and-continue
branch. The caller's existing failure cleanup can still run after rejection;
this patch does not make that cleanup ownership-safe. Successful promises still
require independent payload verification.

The future strict path needs no-clobber transfers, source/ancestor fences,
owner-aware registration and cleanup, and joined extractor/worker termination.
All corresponding manifest guarantees remain false. Ordinary MCP installation
remains unavailable; continue through the
[implementation stages](LOCAL-INSTALL-IMPLEMENTATION.md).
