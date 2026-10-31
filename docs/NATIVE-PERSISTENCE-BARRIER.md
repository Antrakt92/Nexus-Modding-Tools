# Acknowledged renderer persistence

This prepared Vortex 2.9.1 source change connects one renderer snapshot to an
actual main-process write completion. It does not install a mod, freeze all
renderers, grant native admission or change the installed Vortex application.

## Snapshot and completion

`flushPendingDiffsAcknowledged()` cancels the pending debounce, detaches its hive
maps and publishes a single in-flight promise before calling the API or serializer.
Concurrent callers share that promise. Changes generated meanwhile enter fresh
maps; an older completion cannot delete them.

The serializer accepts plain lossless JSON and legitimate remove operations.
It rejects unsupported objects, accessors, cycles, sparse arrays, undefined/
function/symbol/bigint values and non-finite numbers. It never converts a failed
serialization into a remove. Limits are 32 hives, 32,768 operations, 32 MiB UTF-8,
depth 32 and 200,000 visited values. These bound accepted packets, not every
temporary allocation made while inspecting an input.

The preload forwards a typed `persist:diffs-acknowledged` request. Main validates
the entire packet and captures its already registered backends before enqueueing
anything. All hive batches run as one queue unit behind previously accepted work.
An empty packet still waits for that queue. Hive batches commit sequentially;
failure does not roll back earlier successful hives or run the remaining batches.

Main also rejects more than 32 path segments, segments over 2,048 characters and
physical `###` separator aliases. The acknowledged route does not weaken the
existing target reservation guard. Old fire-and-forget/quit channels keep their
existing contracts; their responses are not write acknowledgements.

## Failure and sender lifetime

Main remembers any backend write failure for the rest of its process lifetime.
A later successful ordinary write or a drained queue does not clear it. Both a
new barrier and native reservation refuse this unresolved history. Ordinary
legacy persistence retains its existing error/recovery behavior.

Application binds the real main-window `WebContents` immediately after creating
the window. The new IPC handler requires that object and its current main frame,
then checks the same sender/frame again after the write. A missing frame, foreign
window, subframe, destroyed owner or frame replacement refuses acknowledgement.
There is no first-caller ownership or client-supplied owner token.

The renderer holds a failed or uncertain flight without replay or legacy fallback.
Hydration, main push or quit while it waits invalidates the completion. Reentry
from an active legacy flush is refused before it can send the same pending data
twice. The detached snapshot, exact serialized packet when available, and fresh
pending changes remain private to that middleware instance.

**A held acknowledged flush pauses subsequent timer and quit flushing in that
instance.** Pending changes are retained in memory, not certified as saved. There
is no reset/resume API; a future coordinator must surface and reconcile the hold
before this route is used in an installed application. Restarting the renderer
loses those buffers and does not resolve the owning operation's durable intent.
No existing production call site invokes the new flush helper.

Successful completion resumes ordinary flushing of fresh pending changes. It
proves the submitted snapshot and earlier accepted main work completed without
an observed failure. It does not prove renderer idle, flush another renderer's
buffers, exclude raw database writers or survive power loss. Native registration
still needs target exclusion, coherence across the final check/write, filesystem
ownership and restart reconciliation.

## Source and verification

All patches are pinned to official `v2.9.1`, commit
`c80326367cbe6d96621ad6cf4a5488ef49bac110`:

- `acknowledged-packet` follows `target-reservation` and its query companion.
- `ack-shared-ipc`, `ack-shared-preload`, `ack-preload`, `ack-main-ipc` and
  `ack-application-owner` connect types, transport and the actual window owner.
- `renderer-acknowledged-flush` supplies the snapshot helper and hold behavior.

These artifacts live in `tools/modding/vortex-agent/native-patches/vortex-persistence-2.9.1`.
They are separate from the published 21-patch mod-management source series.
Partial application is not a supported host update.

With original pinned source fixtures, the local source-backed suites are:

```powershell
node --test tools/modding/vortex-agent/native-persistence-packet.test.mjs tools/modding/vortex-agent/native-persistence-ack-ipc.test.mjs tools/modding/vortex-agent/native-renderer-acknowledged-flush.test.mjs tools/modding/vortex-agent/native-persistence-barrier-integration.test.mjs
```

Fixture environment variables are `VORTEX_NATIVE_PERSISTOR_SOURCE`,
`VORTEX_NATIVE_ACK_IPC_SOURCE_ROOT`, `VORTEX_NATIVE_PERSIST_DIFF_SOURCE` and
`VORTEX_NATIVE_STATE_DIFF_SOURCE`. Missing fixtures skip dependent cases rather
than downloading inputs. All 42 cases ran without skips, including a joined
actual renderer/main source flow. Electron transport/frame lifetime and backend
promises use controlled test adapters; this is not an installed-host test.

The actual main/preload/renderer/shared TypeScript targets passed with the
official lock and compiler configurations. Main, preload and renderer bundles
also built. The seven changed sources were bound to their TypeScript Programs;
all five runtime sources matched the corresponding bundle source-map contents.
The renderer base was the published 21-patch series, not the unfinished transfer
experiment in another branch.

Upstream checks passed: 49 main, 7 preload and 18 renderer tests. The renderer
middleware test initially failed during import because its general builders
module eagerly loaded a missing `winapi` binary. The separate test-only
`vortex-tests-2.9.1/persist-diff-builders` adapter keeps all test bodies/assertions
byte-identical and copies the same four pure factory bodies locally. Five
source-backed checks verify that equivalence. It supplies no native mock or
replacement binding and makes no claim about native `winapi` acceptance.
