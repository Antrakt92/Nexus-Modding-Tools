# New-mod registration boundary

The first installation target remains one supported own ZIP, installed as a new
disabled mod. Enable/deploy stays a separate existing operation. Replacement,
FOMOD, dependency installation and automatic removal are outside this first path.

The extension-first experiment on 2026-10-31 found that a new CAS reducer is
possible, but extension action checks alone do not provide a transaction boundary.
The installer remains unavailable in the ordinary adapter.

## Executable source experiment

`extension-admission-source-probe.test.mjs` reads exact source from official
Vortex `v2.9.1`, commit `c80326367cbe6d96621ad6cf4a5488ef49bac110`.
It checks source hashes, selects actual functions through the TypeScript AST and
executes them with pinned Redux, redux-act and redux-batched-actions libraries.
It does not run Electron, a database or filesystem effects.

Seven cases establish these limits:

- `registerReducer` merges a new CAS action without replacing `ADD_MOD`.
  The ordinary action can still overwrite that record.
- `reduxSanity` returns the original action when refusing it; dispatch return is
  not an acknowledgement. The actual `onAddMod` handler can still create its
  directory and call back successfully after that refusal.
- Reducer-level batches bypass a per-`ADD_MOD` middleware check.
- `__persist_push` changes the record without an `ADD_MOD` check. In the actual
  main push function, the backend calls precede the renderer notification; a
  renderer veto is too late to prevent them. Those backend calls are mocked in
  this experiment, so it proves ordering, not database persistence.

There is a separate persistence gap: renderer diffs normally wait for the
100 ms debounce before IPC. `persist:diff-sync` acknowledges enqueueing, while
`finalizeWrite()` drains a queue whose error handler can absorb write failure.
Neither is the result of a particular new registration.

## Prepared per-batch completion

`native-patches/vortex-persistence-2.9.1/batch-acknowledgement.patch` adds an
internal `applyDiffOperationsAcknowledged` method to `ReduxPersistorIPC`.
It is included in the fixed complete source series. No installed application is
changed by keeping or assembling this patch.

The new method:

- detaches and validates a nonempty dense batch before enqueueing;
- rejects unknown hives, inherited registry keys and malformed operations;
- retains the selected backend and returns the exact batch's completion;
- waits for backend writes and, when configured, transaction commit/notification;
- rejects the original error after attempting rollback, including disk-full;
- keeps queue recovery separate from the caller's success/error result;
- leaves the existing void method and its fatal-error handling unchanged.

A failed rollback or a failure after commit leaves the outcome uncertain.
A later successful batch does not reconcile an earlier failed one. The future
executor must retain its hold and inspect the original operation.

This acknowledgement covers the selected backend's promises. It does not prove
power-loss durability, restart survival, a physical payload, an all-profile
disabled state or safe Vortex registration. In particular it does not flush the
renderer queue, block main-origin writers or prevent a late older renderer diff
from overwriting a newer registration.

## Prepared main persistence reservation

The separate `target-reservation.patch` layers on the batch acknowledgement.
`reserveNativeModPersistence(gameId, modId)` establishes a main-owned pending
reservation synchronously, then waits behind previously accepted persistence
work before checking the database. It requires the concrete backend/invalidator
to be ready and retains their identity across that wait and the read.

New intersecting persistent batches are refused in full before enqueueing:
ordinary renderer diffs, quit-sync diffs and acknowledged batches use the same
guard. Protected paths include the exact mod, its descendants and ancestors,
and every profile's `modState[modId]`, including whole-profile replacement.
In that original target-only layer, unrelated mods and profile fields continue
through the queue. The composed backend hold below deliberately tightens this
admission. Accepted batches
are detached before they can wait, preventing later caller mutation from
retargeting a safe path. Physical `###` separator aliases are refused.

Read failure, a conflicting batch, an earlier queued failure or a backend
replacement leaves the reservation held. Async hydration rechecks before replacing
the backend. The internal owner is an object identity; status never exposes it.
There is deliberately no registration, write, release, reset or replay method.

`new-mod-conflict-query.patch` adds a concrete `LevelPersist` query for this
reservation. One parameterized `SELECT 1 ... LIMIT 1` detects target leaves,
exact records, ancestor blobs and profile-state entries without returning stored
values or hydrating the collection. Even a disabled tombstone for the same mod ID
is a conflict: this first path requires a new identity. Ambiguous parent blobs
also refuse. A read error is never converted into absence. Bounded returned data
does not establish an indexed query or constant execution time.

This covers the persistor queue, not all database writers. Startup/admin/import/
repair paths that write directly still need admission. The separate
[acknowledged renderer snapshot](NATIVE-PERSISTENCE-BARRIER.md) now prepares an
explicit pending-diff flush and detects older failed main writes. It still does
not freeze future renderer changes. A registration must coordinate and
resynchronize the renderer before any safe release; a late diff cannot become
permission to overwrite the new record. Neither reservation nor a clean database
snapshot establishes filesystem custody, crash recovery or an installation permit.

In this pinned upstream revision, the production `getDatabase` search finds only
the getter definition. Current `writePersistedValue` callers write app fields,
and backup import/key repair run before `initMainPersistence`. These are exposed
bypass APIs, not evidence that a conflicting target write is currently running.
Previously issued raw connections and Tables cannot be revoked by checking only
a connection getter. The backend hold below therefore refuses after raw exposure.

## Backend write admission

`backend-write-admission.patch` follows the new-mod conflict query in
`LevelPersist.ts`. `backend-reservation-admission.patch` follows the acknowledged
packet in `ReduxPersistorIPC.ts`. They compose as a pair: the existing main
reservation drains earlier accepted queue units, then acquires the concrete
backend's opaque writer owner before querying target absence. Main checks the
same owner and backend identities again after acquisition, after the query and
on subsequent reservation checks. There is no second unused install interface.

The backend tracks intents before argument handling, logging, SQL or the first
await in the four KV writers, transaction methods and close. Freeze is
synchronous; it joins previously started intents before granting its owner.
Write failures remain observed even when their caller handled the rejection.
Thrown `null` or `undefined` is still failure. In the backend timing wrapper,
reporting errors cannot replace the primary SQL rejection. The separate legacy
rollback repair below preserves its original fatal flow. No timeout or empty
queue converts uncertainty into success. The ordinary inactive path adds no SQL or collection scans.

An open transaction or pending transaction call refuses admission. A `BEGIN`
promise is not a whole transaction. Legacy COMMIT/ROLLBACK may finish cleanup of
an existing transaction while the hold stays invalid; no automatic rollback,
reset or admission retry is added. Close attempts and any earlier raw connection
exposure also prevent admission. The getter records exposure before returning
the connection: cached Tables/raw SQL remain usable outside this boundary, so
the fence refuses them rather than claiming to revoke them.

**This is a whole-backend lifetime hold.** New writes, BEGIN, close and raw
connection access refuse while held. Composed main admission also refuses new
ordinary and acknowledged writes for all hives before enqueueing, including
unrelated settings. Earlier accepted queue work finishes before backend freeze.
This is not a transparent pause/resume feature: there is no release yet. A future
coordinator must bound this window and reconcile it before enabling the route.

Other `DuckDBSingleton` connections and QueryRegistry execution are outside
this backend pair; the managed SQL layer below binds the reviewed instance. In the pinned official source, QueryRegistry runs five setup CALLs during
initialization and two fixed SELECT bodies afterward. The parser's `@type` comment
does not enforce read-only SQL and accepts extra files. Only completed setup plus
exact file/body/parameter qualification can support a later read-only connection
claim. This backend pair grants no global SQL isolation, registration, native
installation, crash recovery or power-loss guarantee.

### Backend admission checks

```powershell
$env:VORTEX_EXTENSION_ADMISSION_REPO = 'ABSOLUTE_OFFICIAL_GIT_CACHE'
node --test tools/modding/vortex-agent/native-backend-write-admission.test.mjs tools/modding/vortex-agent/native-backend-reservation-admission.test.mjs
```

All 26 exact-source cases ran without skips, including a coupled flow through
the actual patched main persistor and LevelPersist classes. SQL and invalidation
are controlled test facades. Cases cover old queued transactions and packets,
concurrent direct writes, early all-hive refusal, raw exposure, pending BEGIN,
terminal cleanup, failed or missing owner receipts, query reentry, late failures
and argument/factory callbacks. This does not execute `level_pivot`, Electron IPC
or an installed Vortex database.

The composed main source passed the actual TypeScript target, direct main build
and 49 upstream unit tests (15 persistor, 31 backend and three IPC cases). The
four main sources, including both changed classes, matched the actual Program
and new bundle source map. The other 16 qualified source inputs retained their
renderer/preload/shared baseline; those bundles were not rebuilt for this pair.
Compiler configuration and lockfile were unchanged. This is development source/
bundle qualification, not installed native ABI or database acceptance.

### Legacy rollback diagnostics

`legacy-rollback-primary.patch` follows the backend reservation patch. If both
the original operation and rollback fail, an exception while formatting or
logging the rollback diagnostic must not bypass the original fatal/terminate
path. Only that secondary diagnostic is caught; rollback is still awaited and
the primary failure, including `null` or `undefined`, reaches the existing
normalization/fatal path. Successful work, successful rollback, the acknowledged
path and the outer legacy queue reporter retain their behavior. A drained legacy
queue is not an operation-success acknowledgement.

```powershell
$env:VORTEX_EXTENSION_ADMISSION_REPO = 'ABSOLUTE_OFFICIAL_GIT_CACHE'
node --test tools/modding/vortex-agent/native-legacy-rollback-primary.test.mjs
```

All ten exact-source cases passed without skips, including a before/after case
where the diagnostic previously prevented fatal handling. Independent review,
the actual main TypeScript/direct build and 49 upstream unit tests passed. Four
main sources matched the actual Program/new map; the other 16 qualified sources
retained their separate baseline. Configuration and lockfile were unchanged.
The patch changes no installed application and grants no native capability.

## Main initialization readiness

The prepared `native-main-readiness` layer keeps the exact production
`initQuerySystem` promise and a private completion signal for its captured main
persistor/backend attempt. `initMainPersistence` still returns synchronously;
ordinary startup does not wait for queries. Internal
`waitForNativeMainPersistenceReady()` returns an opaque frozen identity only after
complete Registry/Invalidator/Database/Watcher wiring. A fulfilled skip (singleton
unavailable, parser failure or zero queries) is unavailable for native work.
`checkNativeMainPersistenceReady(owner)` rechecks the captured attempt and tuple.
Neither API acquires a reservation or drains a queue.

Close, repeated initialization and observed failure invalidate the attempt and
settle waiting observers immediately, even if the raw SQL initialization is still
pending. They do not cancel that raw operation. Query objects remain local until
generation and captured-instance checks pass; old completion cannot bind a new
main persistor or overwrite its published query tuple. Retained old hive factories
cannot adopt the backend of a later initialization. A current ordinary factory
continues working when only native eligibility has been held.

Close captures its selected instances and installs one shared tail before calling
finalizers. Concurrent/reentrant callers share that operation; a failed captured
close retains its original rejection and is not automatically retried. This does
not pause ordinary writes during close or prove resource cleanup. A stale query
connection already acquired by an interrupted attempt is not revoked; the
singleton capability ledger must remain conservative. Readiness is separate from
SQL qualification, queue completion, renderer flushing, registration and native
host acceptance. No readiness API is exposed through MCP or IPC.

Nineteen readiness source tests passed without skips. Two execute the exact
predecessor source and reproduce stale initialization/factory adoption; repaired
cases prevent both. Other cases cover pending/fulfilled-skip/failed setup, immediate
invalidation of observers, setup callback reentry and shared close rejection.
Fifteen coupled SQL tests now use the actual production `initMainPersistence`
entry rather than manually assigning the main instance. The combined source,
renderer, assembly and SQL/source-intake run passed 122 cases without skips.

The actual main TypeScript target, direct main build and 52 upstream unit cases
passed. Seven main inputs matched the new Program/map; 17 unchanged renderer,
preload and shared inputs retained their qualification baselines. Configuration,
lockfile and the reviewed Node test path adapter were unchanged. The Electron
package remained without its SDK directory/path marker before and after the run;
no import-time installer was invoked. These are isolated source/build checks.

## Managed SQL connection admission

The prepared SQL layer composes five source changes: QueryRegistry source
qualification, DuckDBSingleton connection ownership, the private LevelPersist
bridge, the existing main reservation and its production initialization binding.
It does not add a SQL/MCP endpoint or expose a raw connection.

Query qualification checks the actual detached initialization inputs and stored
query bodies, names and parameters. Exactly five setup CALLs must finish before
the two reviewed SELECTs are eligible. A current closed inventory of the three
SQL files is a filesystem observation, not a disk lease. An extra empty SQL file
also refuses qualification. `@type select` is only a parser label. Unknown input
retains ordinary legacy behavior but supplies no native read-only proof.

Owner checks use private runtime state without rereading the SQL directory.
Reinitialization or a changed registered query invalidates an issued owner;
removing the conflicting input cannot restore it. An opaque owner is bound to
the actual class, initialization generation and exact connection, rather than a
caller-provided boolean or serialized status.

The singleton records creation, attachment, detachment and close intents before
callbacks or awaits. Admission requires the selected backend attachment and one
qualified query connection, with no additional issued, failed or pending
capability. A connect promise that has not returned a connection is still work.
Public attachment-map contents cannot replace the private issued-connection
ledger. Cached additional connections refuse admission; they are not revoked.

The existing main reservation first drains prior queue work and joins the backend
writer hold, then acquires this SQL scope before checking target absence. Backend,
query registry and singleton owners are checked around that wait/read and on
later reservation checks. Production initialization passes the actual registry
and SQL directory; a missing or unqualified registry cannot grant admission.

In its packaged ASAR layout, Vortex resolves SQL under `app.asar`. The source
qualifier supports both ordinary files and that packed layout: physical checks
use Electron's `original-fs` for the container/ancestors, while virtual entries
are checked only for type, size and exact bounded contents. Synthetic virtual
inodes/times are not physical identity evidence. The ASAR branch uses the pinned
Electron 44.2 `readdirSync` API; `opendirSync` does not support this virtual tree.
Virtual symlinks, unpacked SQL redirects and container drift refuse qualification.
See the [pinned Electron implementation](https://raw.githubusercontent.com/electron/electron/v44.2.0/lib/node/asar-fs-wrapper.ts).

The owner checks perform no SQL-directory reads. Source qualification runs only
around initialization; its observed file generations do not establish a lasting
filesystem lease or an atomic snapshot against arbitrary external writers.

This is a hold over the reviewed source-managed singleton and its connections.
It does not isolate arbitrary privileged JavaScript, unrelated DuckDB instances
or external processes. Native installation, registration, release, crash
reconciliation and physical payload ownership still need their own integration.

### Managed SQL checks

```powershell
$env:VORTEX_EXTENSION_ADMISSION_REPO = 'ABSOLUTE_OFFICIAL_GIT_CACHE'
node --test tools/modding/vortex-agent/native-query-source-admission.test.mjs tools/modding/vortex-agent/native-singleton-sql-admission.test.mjs tools/modding/vortex-agent/native-main-sql-admission.test.mjs
```

All 47 coupled source-backed cases passed without skips. They execute the five actual
classes/functions, including production initialization, with owned SQL/connection
facades. A before/after case proves that shadowing the target-absence method
cannot hide a real conflict: the original prototype query runs and refuses it.
Other cases cover pending connections, source drift, extra files, repeated
initialization, cached capabilities and failed owner checks.

A separate official Electron 44.2.0 SDK ran the actual qualifier and parser in
Node-only mode against an owned ASAR with the three pinned SQL files. Packed and
ordinary inputs qualified; a packed extra empty SQL file refused. Both accepted
inputs completed five stubbed setup calls, and owner checks succeeded with both
FS interfaces replaced by throwing proxies. This tests real Electron ASAR reads,
not DuckDB or installed Vortex. Electron may internally cache extracted entries;
this is not a claim of zero runtime cache writes. SDK release checksums and the
RunAsNode fuse were verified; no application window, account profile or Vortex
process was started. A pinned SDK compatibility check is not a production
Electron security or native-addon qualification.

The final composed main TypeScript target, direct main build and 52 upstream
unit cases passed. Seven current main inputs matched the actual Program/new
source map; 16 renderer/preload/shared inputs retained their separate baseline.
The official compiler configurations and lockfile were unchanged. The first
compiler attempt failed on strict types; explicit runtime guards repaired it
without weakening configuration. Earlier attempts remain separate evidence.

The new runtime LevelPersist import exposed Electron's npm require-time installer
in an earlier Node test run. That run materialized an SDK in isolated dependencies;
it did not launch Vortex. The separate `main-persistence-path-intake` test adapter
adds one fail-closed path-lookup mock, retaining all upstream test bodies and
assertions byte-for-byte. Three source-contract cases verify this boundary. The
final run passed with the package's SDK directory and path marker absent both
before and after, with no installer message. The Node-only `original-fs` alias
uses a private qualification config; it is not ASAR or native Electron proof.
Install-script suppression alone does not prevent import-time installers.

## Core readiness observation

This prepared layer joins startup identities with a fixed read-only main IPC
observation. It is internal application source, not a new adapter/MCP tool.

The static mod-management loader retains the namespace from its existing literal
`f()` result before extracting the default initializer. It does not import or
require the module again. Only that static row can bind the private namespace;
dynamic extensions with a matching name and mutable public `api.ext` are not
readiness authority. The captured default/readiness/accessor function references
are rechecked around calls and awaits. Capture failure disables native eligibility
without replacing the ordinary initializer's result or error.

`waitForNativeRendererManagerReady(store)` and its check method combine the actual
ExtensionManager load owner with that namespace's manager startup owner. An
internal instance accessor checks those owners and the same store before returning
the already-created manager. No new manager, store or connection is constructed.
Imports of InstallManager types do not evaluate its module early.

`observeNativeCoreReadiness(requestId)` admits one logical observation before any
await. Its five-second caller deadline uses a monotonic clock as well as a timer.
Expiration does not cancel the underlying startup/IPC work or free the logical
slot early. A late startup result cannot begin IPC after expiration. Further
calls are busy until that original work settles; no automatic retry or queued
observers accumulate. Settled transport failure can be retried explicitly and
does not itself invalidate healthy local startup identities. Observed source
identity drift remains held even if the old value is restored.

The fixed preload method is `persist.observeMainReadiness(requestId)` and the
channel is `persist:native-main-readiness`. The request contains only one bounded
correlation string. Main selects its owned WebContents/main frame, checks the
handler's persistor against the current main instance, and waits on the actual
main readiness producer. It retains opaque main owners privately. One source
observer serves one active read; the five-second main deadline and navigation
invalidation release the read without cancelling initialization.

The reply has exactly 12 scalar fields: schema/request ID, main PID, WebContents
ID, renderer OS PID, frame process/routing IDs, main-generated frame epoch and
four fixed readiness/authority flags. Main generates all process/frame values and
rechecks them after waits and before replying. Main-frame navigation, renderer
loss and destruction invalidate pending observations, including a same-object,
same-URL reload. Watcher failure makes readiness unavailable while preserving the
ordinary acknowledgement binding. Unknown metadata errors are normalized without
reading their arbitrary message getters.

The renderer checks local owners before and after IPC and copies only the exact
validated schema into a frozen result. `mainReadinessObserved` describes main
only; `effectsAllowed`, `installationPermit` and `nativeAdmission` remain false.
Correlation IDs and returned PIDs are not authorization or OS image/start-time
proof. The observation is not a lasting frame lease, pending-diff completion,
target reservation or permission for installation. Future effects must bind the
current window/context again and acquire their separate source-owned admission.

Twenty-four module/consumer cases and 17 main IPC cases passed, including a real
source-method counterexample that accepted a reply after a delayed timer; the
monotonic repair now refuses it. Nine prior ACK cases remain green. The combined
source suite passed 191 cases without skips. These tests use exact source bodies,
controlled module/IPC dependencies and EventEmitter windows, not native Electron
transport or full ExtensionManager construction.

Main, renderer, preload and shared TypeScript/build targets all passed, followed
by 52 upstream Node unit cases. All 25 selected source inputs matched actual
Programs; 23 matched new runtime maps (the two shared type-only sources do not
appear there). All 24 graph outputs and six runtime output/map hashes matched,
with configuration/lockfile/test adapters unchanged. Electron's npm package
remained cold. No application, game or native window was started by these checks.

## Renderer and manager startup readiness

The prepared startup layer observes two separate production boundaries. The
actual `renderer()` function captures its already-created Redux store and starts
an instance-local attempt on the actual `ExtensionManager`. It observes the exact
`load(extensions)` promise without returning it from ordinary nonblocking startup.
`startupFinished()` occurs before later subscription/render setup; the outer
startup chain does not await load. Neither earlier signal certifies its tail.

The internal methods are `waitForNativeRendererLoadReady()` and
`checkNativeRendererLoadReady(owner, store)`, with source-owned begin/observe/fail
producer hooks. Repeated entry, API/store drift, rejection or observed validation
failure permanently holds the attempt and settles waiting observers. Matching
failure hooks preserve primary setup errors even if secondary diagnostics fail.

Mod-management separately observes its specific `context.once` callback. It
records success only after `once(api)`, `extendApi` assignment and `history.init()`
all return. Generic `ExtensionManager.doOnce()` catches callback failures, so its
fulfilment cannot replace this observation. Ordinary callback failures retain
their original error; a passive stamp failure only disables native eligibility.
The module's `waitForNativeManagerStartupReady(store)` and
`checkNativeManagerStartupReady(owner, store)` retain the actual manager and
private API proxy. Callers supply the shared store and opaque owner, not the
private proxy: `ExtensionManager.getApi()` returns the underlying raw API instead.

The official `APIProxyHandler` forwards `store` unchanged. Rejecting every API
proxy would break the actual production path. Store reads through this reviewed
proxy are a trusted source boundary; identities and sticky invalidation are
rechecked after callbacks. Renderer and manager checks must use the same store.

This is setup-tail observation, not constructor attestation, UI paint, successful
completion of every handled startup warning, global idle or a persistence flush.
History callbacks and fire-and-forget work started during once remain live work;
ordinary extension cleanup is not joined by this receipt. Future operation-time
admission still needs actual window/sender identity, lifecycle exclusion, fresh
store checks, acknowledged diffs and main readiness/SQL owners. No startup receipt
reserves lifecycle/persistence ownership or exposes a new MCP/IPC operation.

Nineteen source-backed cases passed without skips. They execute the actual
renderer/load functions, the specific once wrapper and APIProxyHandler, with
controlled external dependencies and an ExtensionManager prototype fixture rather
than its full constructor. Exact prior renderer and pinned Bluebird doOnce
controls prove the earlier completion gaps. The combined source/assembly suite
passed 141 cases without skips. The actual renderer TypeScript and webpack targets
passed with unchanged configurations and lockfile: 15 renderer inputs matched
the fresh Program/map, while ten main/preload/shared inputs retained unchanged
baselines. These are isolated development-build checks, not installed acceptance.

## Renderer target fence

The prepared `renderer-target-fence.patch` wraps the actual root reducer, inside
recursive batching and outside the combining reducer's exception handler. Its
internal reservation requires the new target to be absent from the selected
game's mods and every profile's mod state. A disabled tombstone also conflicts.
The internal exports are `reserveNativeRendererTarget(gameId, modId)`,
`checkNativeRendererTarget(owner)` and `getNativeRendererTargetStatus()`. The
owner is an opaque object identity; status exposes no owner. There is no
registration action, release, reset or installation permit.

The fence checks individual nested batch items as well as the outer transaction.
Hydration, replacement hydration and main-process pushes use the same boundary.
A protected mutation rejects the whole dispatch; with the normal immutable
reducer contract, earlier unrelated items in the same batch are not committed. A combining reducer's swallowed exception still
invalidates the reservation. Protected working containers are detached before
calling reducers so an in-place write cannot corrupt the previous target spine.
Unrelated nested payloads remain shared: reducers are trusted not to mutate
closed-over old state or arbitrary external references.

Without a reservation, the original reducer/batching path retains its behavior
and performs no protected-container traversal. Active checks share a 16,384
container-entry budget across the inspected root, maps and profile containers,
with at most 4,096 profiles. Only a leaf reducer input receives working copies;
reservation, owner checks and post-validation do not allocate copied maps. These bounds do not prove a measured
installation speedup or bound temporary allocation by `Reflect.ownKeys`.

This is a lifetime renderer hold, not an independent attestation of the native
window, a persistence transaction or a fence against arbitrary replacement
reducers. Multiple observed factories, repeated initialization and a discontinuous
root state chain refuse admission, including two stores reusing one reducer function.

The passive store-binding layer calls `bindNativeRendererStore(store)` from the
actual renderer startup after hydration and app metadata, before
`extensions.setStore`. It captures the selected store and its own data `getState`
method. Reservation and owner checks require that same method and the same root
tracked by the reducer. Duplicate binding, method drift, root mismatch or reentry
invalidates native eligibility; a failed bind returns false so ordinary startup
can continue. No reservation or protected-state scan starts merely by binding.

Status reports `storeBinding` as `unbound`, `binding`, `bound` or `held`. A
binding failure before any target reservation leaves target `phase:not_reserved`;
it does not create a startup hold over ordinary actions. Failure after an owner
was issued holds that target too. A private scalar invocation counter detects
reducer reentry even when the returned root identity is unchanged.

The call site trusts the official Redux/enhancer initialization path. This does
not isolate arbitrary privileged JavaScript or prove that pending persistence
diffs have drained. The coordinator still needs window/operation binding,
readiness, acknowledged diff completion, main persistence reservation and verified
registration before any future safe release.

### Renderer fence checks

```powershell
$env:VORTEX_EXTENSION_ADMISSION_REPO = 'ABSOLUTE_OFFICIAL_GIT_CACHE'
$env:VORTEX_EXTENSION_ADMISSION_DEPS = 'ABSOLUTE_QUALIFIED_NODE_MODULES'
node --test tools/modding/vortex-agent/native-renderer-target-fence.test.mjs
```

All 24 cases ran without skips. The suite executes the pinned actual root reducer
functions with Redux/redux-act/batching, controlled extension reducers and utility
facades. It covers nested and empty batches, hydration/push, in-place target
writes, swallowed exceptions, ambiguous stores, inherited getters, malformed
prototypes, sticky failure and the shared traversal budget. Together with the
assembly/manager/marker suites, the run passed 65 cases; the seven original
source-experiment cases also passed separately. These remain source tests, not Electron/database
or native filesystem acceptance.

The subsequent passive store-binding layer passed 34 source-backed cases without
skips, including the original fence cases against the composed source. Tests use
actual Redux stores, including middleware enhancement, and check descriptor/proxy
refusal, duplicate binding, method/root drift and swallowed callback/reducer
reentry. An AST-extracted segment of the actual renderer entry runs app metadata,
bind and extension exposure in order; a false bind result does not stop exposure.
These are source/facade checks rather than an installed host observation.

Before passive store binding, the composed renderer passed the actual TypeScript and webpack targets
with the official compiler configuration and lockfile unchanged. All 13 renderer
inputs matched the actual TypeScript Program and new bundle source map: the ten
mod-management/transfer sources, this reducer, the acknowledged diff middleware
and unchanged state-diff control. Seven other persistence sources retained their
prior main/preload/shared Program/map baseline; those projects were not rebuilt
for this renderer-only change. This remains an isolated development build.

The composed store-binding renderer subsequently passed the actual TypeScript
and webpack targets with the same official configurations and lockfile. Fourteen
renderer inputs, including the actual startup entry and unchanged state-diff
control, matched the new Program and source map. Ten main/preload/shared inputs
retained their unchanged qualification baselines; those projects were not rebuilt.
This remains an isolated development build, with no installed-host acceptance.

The unmodified upstream `src/reducers/index.test.ts` could not import because the
qualified dependency tree lacks `winapi-bindings/build/Release/winapi`. Vitest ran
zero cases in that suite. No native mock, dependency install or weakened assertion
was introduced to turn this failure into a pass.

## Next implementation gates

Implement these boundaries before exposing an install endpoint:

1. Connect target admission before conflicting native side effects. The prepared
   main reservations cover their source-managed queue, backend and SQL scope;
   ordinary install/remove/refresh writers and the renderer still need a
   coordinated boundary.
2. Publish the verified payload through an actual no-replace owned primitive.
   Keep partial output held; discovery of a directory is not registration.
3. Register one exact new owner and verify every profile remains disabled. Use a
   bounded operation binding and coordinate renderer diffs with main persistence.
4. Obtain per-registration completion from the actual native backend. Test restart
   readback and lost replies; do not retry with new operation IDs.
5. Reconcile unfinished intents before discovery/cleanup can claim their output.
   Do not introduce an `installing` placeholder merely to reuse legacy cleanup.
6. Prove two sequential successful installs and release active exclusion without
   releasing the durable consumed-ID binding. Then connect prepare/apply/status/
   cancel and existing enable/deploy.

The prepared broad lifecycle patches remain independent work. They are not a
reason to bypass these gates or to add unrelated writers to the critical path.

## Local checks

Provide an existing official read-only Git cache and the already qualified
dependency tree. Tests never fetch or install their own inputs:

```powershell
$env:VORTEX_EXTENSION_ADMISSION_REPO = 'ABSOLUTE_OFFICIAL_GIT_CACHE'
$env:VORTEX_EXTENSION_ADMISSION_DEPS = 'ABSOLUTE_QUALIFIED_NODE_MODULES'
$env:VORTEX_NATIVE_PERSISTOR_SOURCE = 'ABSOLUTE_ORIGINAL_ReduxPersistorIPC.ts'
node --test tools/modding/vortex-agent/extension-admission-source-probe.test.mjs tools/modding/vortex-agent/native-persistence-ack-patch.test.mjs
```

With pinned inputs, all 20 cases ran without skips. The persistence cases execute
the original and patched class with controlled backend/transaction promises.
They cover blocked writes/commits, exact errors, queue ordering, detached inputs,
sparse operations, inherited keys, factory reuse and commit/rollback failures.
Missing inputs skip the source-dependent tests and do not establish acceptance.

For the combined acknowledgement, reservation and conflict query:

```powershell
$env:VORTEX_NATIVE_LEVEL_PERSIST_SOURCE = 'ABSOLUTE_ORIGINAL_LevelPersist.ts'
$env:VORTEX_NATIVE_DUCKDB_NODE_API = 'ABSOLUTE_QUALIFIED_DUCKDB_NODE_API_DIRECTORY'
node --test tools/modding/vortex-agent/native-persistence-ack-patch.test.mjs tools/modding/vortex-agent/native-persistence-reservation.test.mjs tools/modding/vortex-agent/native-new-mod-conflict-query.test.mjs
```

All 36 cases passed without skips. The six query cases use the existing DuckDB
node-api `1.5.1-r.1` against a private `:memory:` table. One combines the actual
patched persistor and LevelPersist classes: an earlier real transaction finishes
before the conflict query, which refuses the now-existing target and holds the
reservation. Its dirty-table notification hook is stubbed; the native
`level_pivot` extension and installed database are not tested.

The combined main-process TypeScript target, its seven prerequisite builds, all
46 upstream persistor/backend tests and `src/main/build.mjs` passed. Both exact
output sources were present in the 1,141-file TypeScript Program and the resulting
main source map. The official lock and compiler configuration were unchanged. The
initial main typecheck required the official local `generate:unleash` target to
produce its missing schema; no compiler options or declarations were weakened.

This qualifies the main source/bundle only, not a packaged application with its
native modules. None of these checks installs Vortex or proves the complete
new-mod path inside a running host.
