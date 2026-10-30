# Read-only file-proof worker

This is an internal source-only foundation for moving cold file hashing off a
caller thread. It is not a Vortex endpoint, installer or replacement for the
current guard. No helper or running extension imports it yet.

## Contract

`createFileProofClient` accepts a frozen catalog of admitted roots, an operation
epoch and a host-generation token. Each root has a label, an absolute ordinary
directory path and its expected `dev:ino` identity. A proof request names only
known relative leaf paths beneath those roots and their expected physical tuples:
`nodeId`, decimal byte count, link count and SHA-256.

The factory accepts `{roots, epoch, hostGeneration, timeoutMs}`;
`prove(rows, {fresh, signal})` returns a Promise and `close()` permanently closes
the client. Epoch is a positive safe integer and host generation is an opaque
ASCII token, not a credential. Root/path identities and expected proof data must
come from a separately admitted checkpoint; this API does not discover them.
There are no executable, filesystem-adapter or worker-path overrides in the
production options.

Fixed caps are eight roots, 4,096 rows, 8 GiB per file, 32 GiB logical bytes per
request and 4 MiB per request/reply. Hashing streams 64 KiB chunks. Timeout defaults
to 30 seconds and is bounded to 120 seconds. These limits define the supported
scope; an oversized baseline requires a separately reviewed design.

The fixed worker receives data only. It streams file bytes through an opened
descriptor, checks descriptor/path generations and ancestor/root identities,
and returns bounded hashes and metadata. It does not extract archives, enumerate
the collection, use native Vortex APIs or return file contents. The worker starts
with an empty environment and no inherited Node CLI arguments. This reduces
incidental credential/preload inheritance; a worker is not an OS permission
sandbox and still runs as the same user.

Nonce, request ID, list digest, epoch and host generation must match the current
request. The parent resamples root, ancestor and leaf metadata before accepting
the reply. One request may be outstanding; there is no background queue. Timeout,
crash, abort, malformed reply or stale identity permanently holds that client
and terminates its worker. There is no transparent retry or replacement worker.
Parent-side metadata admission and reply validation are still synchronous.
Large batches can therefore pause the caller while traversing ancestors; this
foundation does not claim zero caller-thread blocking. Measurements must include
both parent phases, transfer and worker startup, not only hash duration.

Generation caching belongs to that client/checkpoint only. Every selected path
is observed even when hardlink aliases share a hash. Fresh mode bypasses cached
hashes from earlier requests, while aliases within the fresh batch can share a
newly verified generation. This code does not export or import cache entries into the existing
guard, and it does not replace its independent final payload rehash.

`effectsAllowed`, `hostCompatibilityVerified`, `diskDeploymentVerified` and
`directoryInventoryVerified` remain false. A known-leaf proof cannot establish
that no additional files exist. Neither metadata resampling nor a hash promises
that arbitrary writers cannot change bytes after the last observation.

## Native integration gate

The first implementation supports standalone Node filesystem semantics and
refuses Electron. Vortex uses `original-fs` for physical archive handling;
standalone Node tests cannot establish that behavior inside the exact installed
Electron/Vortex process. Current process context, source/module pins, worker
startup and physical `app.asar` handling need separate admission and acceptance.

Do not change `guard()` to `async` alone. The reviewed helper has synchronous
callers in startup, root-ready waiting, settlement callbacks, the serial poller
and final readback. Several callbacks currently discard the return value. A
future integration must preserve waiting/error propagation, serialize overlapping
checks and recheck current API/profile/process/interlock/root context after each
await and immediately before native effects. A worker reply grants no effects.

Other blocking work also remains: process enumeration, directory/source-tree
walks and native-state hashing. On 30 October, an isolated read-only run of the
maintained process enumerator measured a 246.874 ms median after two warmups and
five samples (242.804–248.488 ms). Raw process names were not recorded. This is a
sample of the current standalone implementation, not a live-helper measurement
or a before/after install benchmark.

Electron recommends moving long CPU tasks off its main thread, but its
[process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
and [multithreading guidance](https://www.electronjs.org/docs/latest/tutorial/multithreading/)
distinguish main-process utilities and browser workers. They do not establish
acceptance of this Node worker in Vortex. The
[Node worker API](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)
documents the environment, CLI argument and message-cloning options used here.
See the [implementation checklist](LIFECYCLE-IMPLEMENTATION.md) for remaining gates.

## Local verification — 30 October 2026

```powershell
node --test tools/modding/vortex-agent/file-proof-worker.test.mjs tools/modding/vortex-agent/physical-proof.test.cjs tools/modding/vortex-agent/payload-size-proof.test.cjs
```

All 27 focused tests passed without skips: 17 new worker tests and ten existing
physical/payload checks. Cases include sparse-array refusal, hardlink/fresh-cache
parity, descriptor/path mutation, real post-proof root replacement, malformed or
stale replies, cancellation, deadlines and constructor error sanitization. The
during-open ancestor-change observation is injected on Windows because its
sharing rules prevent that directory rename; this is modeled coverage.

A standalone 64 MiB generated-file comparison used the same streamed proof
algorithm on the caller and through the real worker client. After two warmups,
five alternating samples had median phase times of 33.391 / 33.624 ms. The worker
phase included parent admission, transfer and reply validation. Its first phase,
including construction, took 54.178 ms. File generation and monitor margins were
outside those phase times. Storage was warm and each phase freshly hashed all
64 MiB; no wall-time speedup is claimed. Tests establish caller-loop progress
during worker content reads, with synchronous parent work still present.

Neither this comparison nor these tests establish live Vortex compatibility,
end-to-end install latency or current collection preservation.
