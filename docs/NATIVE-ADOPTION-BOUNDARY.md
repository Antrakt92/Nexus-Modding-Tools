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

## Next implementation gates

Implement these boundaries before exposing an install endpoint:

1. Reserve the target before conflicting native side effects. Admission must cover
   relevant ordinary install/remove/refresh writers and main-origin persistence,
   rather than relying on renderer action vetoes.
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

The main-process TypeScript target, its seven prerequisite builds, all 15 upstream
persistor tests and `src/main/build.mjs` passed with the patch. The exact output
source was present in the 1,141-file TypeScript Program and the resulting main
source map. The official lock and compiler configuration were unchanged. The
initial main typecheck required the official local `generate:unleash` target to
produce its missing schema; no compiler options or declarations were weakened.

This qualifies the main source/bundle only, not a packaged application with its
native modules. None of these checks installs Vortex or proves the complete
new-mod path inside a running host.
