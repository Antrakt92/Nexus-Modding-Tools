# Local import readiness helper

`local-import-readiness.cjs` is a library for reviewed, task-specific native
one-shots. It is not exposed by the permanent adapter, does not add installation
or generic event dispatch, and has no direct filesystem/network/Vortex access.

Vortex2.9.0's native import callback waits for metadata lookup after registering
the archive as a finished download. A finished tracked archive can therefore
precede that callback. `silent=true` hides notifications; it does not bypass
metadata. Source pin: app.asar SHA256
`1faeab9820c3a7314cd2a2c3e4adfa855ea5980c2f849a1174ed5ed76b49ed85`,
renderer.js `postImport` near byte1070466, `did-import-downloads` near1080249,
metadata queue module62767 near1116502. Recheck source after host updates.

The caller injects a single native `importOnce`, allowlisted `readDownloads`,
independent `getFileProof`, strict `assertOperationalState` and a synchronous
durable `record` writer. The expected game, exact basename, root, bytes, SHA256
and pre-import download ID set are pinned. A unique finished newly tracked
archive can become ready while its metadata callback remains pending.

`getFileProof` must prove ordinary-file status, reject reparse traversal in every
path component and return `{path, regularFile:true, reparse:false, bytes, sha256}`.
The helper compares this to the pinned path/bytes/hash and rechecks the record
after awaited proof. It cannot independently establish filesystem identities.
The operational guard must preserve active profile, canonical roots/filesystem
identities, existing download identity, mod operational fields, flags, manifests,
protected file hashes and staging/game hardlinks. This module deliberately adds
no broad catalog-metadata exception or account/global setting changes.

The result includes `callbackObservation`, a promise that always resolves to a
bounded status projection after recording the callback outcome. Keep observing
it until settlement, including after readiness. Rejections and mismatching late
IDs are reconciliation failures, not permission to replay or clear an interlock.
After an error, the attached handler still records any late callback; the caller
must retain the one-shot/receipt owner until it settles or explicitly reconcile
the native operation. Readiness proves archive/record state at that instant;
later metadata failure can still change native state. Guard again before every
subsequent effect. The helper never installs the returned download itself.

Adapter awaits use the shared deadline (up to120 seconds); synchronous blocking
code cannot be interrupted by a JavaScript timer. Supply bounded local readers.
Existing matching archives require a separate reuse route and do not invoke
import. A failed/restarted helper must reconcile existing attempt receipts before
calling this function; per-invocation single-import behavior is not a durable
cross-process replay barrier.

Run offline regressions with:

```powershell
node --test D:/Modding/Nexus/tools/modding/vortex-agent/local-import-readiness.test.cjs
```

These tests model native state and I/O. They do not establish live Vortex import,
installation, native callback completion, managed deployment or gameplay proof.
