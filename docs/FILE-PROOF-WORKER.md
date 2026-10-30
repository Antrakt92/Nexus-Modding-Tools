# Read-only file-proof worker

This internal component moves file-content hashing away from its caller. It is
not a Vortex endpoint, installer or replacement for the current guard. Production
installer guards and the resident adapter do not import it. Isolated acceptance
probes have their own packets and receipts.

## Contract

`createFileProofClient` accepts `{roots, epoch, hostGeneration, timeoutMs}`.
Each admitted root has a label, an absolute ordinary directory path and its
expected `dev:ino` identity. `prove(rows, {fresh, signal})` names only known
relative leaves and their expected `nodeId`, decimal byte count, link count and
SHA-256. It returns a Promise. Epoch is a positive safe integer; host generation
is an opaque ASCII token, not a credential. Paths, identities and expected data
come from a separately admitted checkpoint; this API does not discover them.
There are no production executable, filesystem, transport or worker-path options.

Caps are eight roots, 4,096 rows, 8 GiB per file, 32 GiB logical bytes per request
and 4 MiB per request/reply. Hashing streams 64 KiB chunks. Timeout defaults to
30 seconds and is bounded to 120 seconds. An oversized baseline needs a separately
reviewed design. The transport accepts data only: no extraction, directory
inventory, native Vortex APIs, arbitrary commands or returned file contents.

Nonce, request ID, list digest, epoch and host generation must match. Descriptor,
path and ancestor generations are checked around content reads; the parent
resamples metadata before accepting a reply and requires the expected backend.
One request may be outstanding, including while executable admission and child
initialization finish. There is no queue of later requests. Timeout, crash, abort,
malformed reply or stale identity poisons the client permanently. There is no
transparent retry, replacement process or transport fallback.

Parent admission and reply metadata checks remain synchronous. Large batches
can pause the caller while traversing ancestors. Measure both parent phases,
executable admission, startup, transfer and reply validation, rather than hash
duration alone. Both parent modules use the same `node:perf_hooks` clock for the
internal startup deadline; a renderer's Chromium clock has a different origin.

Generation caching belongs to one client/checkpoint. Every path is observed,
including hardlink aliases sharing a hash. Fresh mode bypasses earlier requests'
hashes while aliases within that new batch may share a verified generation.
No cache entries are imported into the installer guard, and its independent final
payload rehash remains separate.

`effectsAllowed`, `hostCompatibilityVerified`, `diskDeploymentVerified` and
`directoryInventoryVerified` remain false. Known leaves cannot prove that no
extra files exist, or prevent arbitrary writers changing bytes after the last
observation. Runtime compatibility of this component grants no native effects.

## Fixed runtime backends

Standalone Node uses `node:fs` and the existing Worker Thread transport. Its worker
has an empty environment, no inherited Node arguments and V8 resource limits of
96 MiB old generation, 16 MiB young generation and a 4 MiB stack.

The Electron backend supports only Windows, Electron **44.2.0** and Node
**24.20.0**. Parent metadata reads and the child proof engine both require literal
`original-fs`; missing or unsupported backends fail without falling back to
Electron's virtualized `node:fs`. The physical `app.asar` is a file under this
backend, whereas the default Electron filesystem exposes it as a directory.

In the reviewed Vortex renderer, constructing a Node Worker Thread failed with
`ERR_MISSING_PLATFORM_FOR_WORKER`. The production factory therefore selects its
fixed child IPC transport before startup on the admitted Electron runtime. It
does not try a thread and then recover through another transport.

Before forking, the parent asynchronously streams and verifies its current
`process.execPath`, capped at 512 MiB, against the reviewed Vortex 2.9.1 executable SHA:

```text
d93fbf17b44afd6b9ae721b95deb7372e0cab59e19d60f7f64d7b41d3251adbe
```

The opened descriptor, path and ancestors are pinned. One full hash is followed
by descriptor reopen/generation checks; the final synchronous check immediately
precedes fork. The executable path cannot change during admission. There is no
executable hash cache shared across clients. The outer request deadline and
cancellation cover admission and initialization, preventing a late fork after
poisoning. The known executable's RunAsNode behavior was checked separately;
its hash does not establish the current application archive or loaded extensions.

Only that current executable starts the fixed `file-proof-child.cjs`, with no
script arguments and fixed sibling modules. Its environment supplies only
`ELECTRON_RUN_AS_NODE=1`; Node/Windows may add IPC variables and `SystemRoot`.
Credentials and the parent's environment/Node flags are not inherited. The fixed
flags are `--max-old-space-size=96`, `--max-semi-space-size=16` and
`--stack-size=4096`. The admitted runtime reported a **144 MiB V8 heap limit**;
this is not a 96 MiB total-memory or RSS cap. A worker or child still has the
same user's OS permissions and is not a sandbox.

Initialization binds nonce, epoch, host generation, roots digest, exact runtime
and physical backend before releasing the waiting request. Unexpected IPC or
runtime metadata fails closed. No application profile or normal Vortex instance
is launched by this transport.

## Close and cleanup evidence

`await client.close()` poisons the client immediately and returns its cleanup
outcome. Inspect that outcome; requesting termination alone does not prove exit.
For the Electron child, disconnect allows graceful exit, followed after two
seconds by termination of only that owned child if necessary. The bounded join
reports uncertainty after five seconds without confirmed process exit. The
ordinary Vortex host is never a termination target.

An actual child `exit` event proves process death. Electron may omit the aggregate
ChildProcess `close` event even after exit; waiting solely for it caused a false
five-second cleanup hold in the first production smoke. The repaired adapter
releases its parent-owned IPC/stdout/stderr resources and distinguishes
`childExitObserved`, `childCloseObserved`, `parentPipesDestroyed`,
`parentPipesClosed` and `ipcDisconnected`. Parent-pipe closure is observed
separately, with a bounded 100 ms wait after process exit. Confirmed exit can be
returned with `parentPipesClosed:false`; that does not claim every handle closed.
`exited`, `forced` and `uncertain` describe the process outcome. No new process
is spawned to recover an uncertain cleanup. Preserve its receipt for inspection.

## Native integration gate

Fresh process context, host/application source parity, loaded-extension and
module pins, active game/profile/root identities, process state and interlocks
remain separate admission requirements. An isolated RunAsNode success does not
establish behavior in the actual Vortex renderer. A separate exact-production
renderer packet subsequently passed the component checks described below.

Do not change `guard()` to `async` alone. Its startup, root-ready, settlement,
poller and final-readback callers need correct propagation. Newly prepared
own-local kits preserve returned Promises and conditionally await thenables,
without adding yields to synchronous guards. Historical kits remain unchanged.
Future integration must serialize overlapping checks and recheck live context
after every await and immediately before native effects. A proof reply grants
no install, removal or deployment permission.

Other blocking work remains: process enumeration, directory/source-tree walks
and native-state hashing. On 30 October, the maintained standalone process
enumerator measured a 246.874 ms median after two warmups and five samples
(242.804–248.488 ms). Raw process names were not recorded. This is not a
live-helper measurement or a before/after installation benchmark.

Electron's [process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
and [multithreading guidance](https://www.electronjs.org/docs/latest/tutorial/multithreading/)
do not establish Vortex acceptance. The [Node worker API](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)
and [child-process API](https://nodejs.org/docs/latest-v24.x/api/child_process.html)
describe transport options; exact-host receipts provide the separate runtime
evidence. See the [implementation checklist](LIFECYCLE-IMPLEMENTATION.md).

## Local verification — 30 October 2026

```powershell
node --test tools/modding/vortex-agent/file-proof-backend.test.cjs tools/modding/vortex-agent/file-proof-child-client.test.cjs tools/modding/vortex-agent/file-proof-worker.test.mjs
```

The current 41-test transport suite passed without skips, including independent
review. It covers backend refusal, executable pin/generation/path drift, streamed
admission cancellation, late initialization, shared-clock deadlines, uncertainty,
exit without aggregate close, owned-child cleanup races and existing proof/cache
behavior. The original foundation pass had 27 tests: 17 worker tests plus ten
physical/payload checks. Its during-open ancestor-change case injected the changed
observation because Windows sharing rules prevented an actual directory rename.

The earlier standalone 64 MiB comparison used the same streamed proof algorithm
on the caller and through the real Worker Thread client. After two warmups,
five alternating samples had median phase times of 33.391 / 33.624 ms. The worker
phase included parent admission, transfer and reply validation; its first phase
including construction took 54.178 ms. File generation and monitor margins were
outside the phases. Storage was warm and every phase freshly hashed all 64 MiB.
These figures do not compare the later Electron transport or establish a speedup.

A fresh production-factory RunAsNode packet then passed cold, warm, fresh,
mutation-poison/no-respawn and dispatch-abort/awaited-cleanup checks. It copied
exact source bytes without patches or a private factory. One observed cold phase
took 397.875 ms including executable admission, child startup and request checks;
warm took 3.114 ms and fresh 153.790 ms. Inputs were the physical 271,650,524-byte
application archive and a 16 MiB own fixture plus its hardlink alias. Independently
streamed expected hashes were outside those phases; the full probe took 1.536 s.
Both child cleanups observed exit without force, closed parent pipes and
disconnected IPC, while aggregate ChildProcess close remained unobserved. The
failed predecessor packet and its five-second hold remain preserved separately.

A separate packet in the actual Vortex 2.9.1 renderer passed all five groups
using the same production factory and six unchanged source files. Cold took
665.290 ms, warm 1.890 ms and fresh 166.120 ms; the full probe took 1.848 s.
Both child processes exited without force or uncertainty; parent pipes closed
and IPC disconnected. Aggregate ChildProcess close was not observed. These are
single diagnostic samples with the same timing exclusions described above.
Fresh session reads matched the pre-maintenance active context, all 344 mods,
407 downloads, empty dialogs/external changes and deployment-manifest hash.

This establishes the component's operation in that exact renderer. It does not
establish an installation latency improvement, guard integration, native
no-replacement admission or collection preservation during an installation.
