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
It is separate from the fixed renderer source series. No existing caller or IPC
channel invokes it, and no installed application is changed by keeping this patch.

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

Other `DuckDBSingleton` connections and QueryRegistry execution remain separate
gates. In the pinned official source, QueryRegistry runs five setup CALLs during
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

This is a lifetime renderer hold, not an attestation of the native window/store,
a persistence transaction or a fence against arbitrary replacement reducers.
Multiple observed factories, repeated initialization and a discontinuous root
state chain refuse admission, including two stores reusing one reducer function.
The coordinator still needs to bind the actual host, flush older pending diffs,
reserve main persistence and verify registration before any future safe release.

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

The final composed renderer passed the actual TypeScript and webpack targets
with the official compiler configuration and lockfile unchanged. All 13 renderer
inputs matched the actual TypeScript Program and new bundle source map: the ten
mod-management/transfer sources, this reducer, the acknowledged diff middleware
and unchanged state-diff control. Seven other persistence sources retained their
prior main/preload/shared Program/map baseline; those projects were not rebuilt
for this renderer-only change. This remains an isolated development build.

The unmodified upstream `src/reducers/index.test.ts` could not import because the
qualified dependency tree lacks `winapi-bindings/build/Release/winapi`. Vitest ran
zero cases in that suite. No native mock, dependency install or weakened assertion
was introduced to turn this failure into a pass.

## Next implementation gates

Implement these boundaries before exposing an install endpoint:

1. Connect target admission before conflicting native side effects. The prepared
   main persistence reservation covers only its queue; relevant ordinary install/
   remove/refresh writers and the renderer still need a coordinated boundary.
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
