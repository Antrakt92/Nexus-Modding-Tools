# Prepared extractor error-close patch

The `node-7z` runner shipped with the reviewed Vortex 2.9.1 rejects its promise
immediately after requesting termination when a progress callback throws or the
child emits an error. Requesting `kill()` does not establish that the process
and its pipes have closed. The caller can therefore enter retry/removal paths
while extraction is still unsettled.

The prepared [patch](../tools/modding/vortex-agent/native-patches/node-7z-b75def8/error-close.patch)
latches the first failure, requests termination once and waits for that exact
child's `close` before rejecting. Stdin/stdout/stderr errors and exceptions from
asynchronous captured cancellation use the same failure path. A failed or throwing kill request cannot
replace the first error or establish completion. Further output is drained
without calling progress again after failure. An `exit` event alone does not
settle the operation. If `close` never arrives, the operation remains pending;
there is no timeout, second process or automatic replay that pretends it ended.

Normal success and nonzero/signal exit result shapes stay unchanged. A synchronous
spawn throw with no returned child still rejects directly. Ordinary password
cancellation retains its existing classification: the cancel path requests
termination and later resolves `{code, errors}`. That behavior needs a separate cancellation
contract before native installation can be accepted.

## Source and verification

The Vortex 2.9.1 lockfile selects Nexus-Mods/node-7z commit
`b75def8d0d7d81a03f4526c52b8ada9a34a06479`. Its original `util/run.js`
SHA-256 is `219ccdb78bc5bf6a5a82be4a2fb7772c87834b1532bc8fa431bcde289f3dd571`.
The installed runner bytes matched that source. The adjacent manifest binds the
input, patch and output; it does not imply whole-package byte parity. Preserve
the upstream [ISC copyright and license](../tools/modding/vortex-agent/native-patches/node-7z-b75def8/LICENSE).

```powershell
$env:VORTEX_NODE_7Z_RUN = 'C:/ReviewedSource/node-7z/util/run.js'
node --test tools/modding/vortex-agent/native-extractor-close-patch.test.mjs
```

The source-derived tests run the exact original/patched module with injected
child events and Promise dependencies. They cover early rejection, deferred
close, first-error identity, kill failures/reentrancy and unchanged normal
results. An additional controlled Node child verifies that rejection reaches the
caller only after that child's close. These are lifecycle regressions, not a
complete application build or proof of the exact shipped Bluebird/7-Zip
integration. Missing independently obtained source is an explicit skip, never
native acceptance.

## Remaining gates

This patch is uninstalled. It neither kills descendant processes nor proves
global idleness, registration ownership, persistence, no-clobber transfer or
safe cleanup. A password promise can still resolve after close and attempt a
late stdin write; this patch handles stream errors but does not cancel that
continuation. Cancellation classification and the complete extractor wrapper
still require native integration review. Waiting for one child's close does
not authorize the legacy remove-before-extract path or cleanup of a directory
whose ownership has changed. The public MCP install refusal remains in place.
Bluebird cancellation and `finally` propagation need their own runtime tests;
settlement of a caller's canceled promise is not a native terminal observation.
