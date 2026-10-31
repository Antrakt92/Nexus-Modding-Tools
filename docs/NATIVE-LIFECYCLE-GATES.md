# Native lifecycle admission gates

This records the source review of Vortex 2.9.1 on 30 October 2026. It is a
contract for further work, not permission to run an installer or removal event.
The public adapter still refuses installation; no general install/remove endpoint
is enabled. Offline binding, a client journal and a file hash do not establish
native admission.

## Reviewed source

The installed `resources/app.asar` matched SHA-256
`ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a`.
The following renderer source-map entries identify the reviewed implementation.
Numbers are source-map indexes, not API versions. Recheck the installed package,
source parity and loaded extensions before using this review for an operation.

| Entry | SHA-256 |
| --- | --- |
| 575 `InstallManager.ts` | `577d56a8728052069f850face9bb57437dbf2886bd41409fe6a66cfefc08ed33` |
| 585 `eventHandlers.ts` | `c45773ac110808acb3a3bf79bdcb1b3cab1ef498c6ddfdf7c29f11abb60733eb` |
| 588 `index.ts` | `d895c7614a692242e1921fa0d9fba1a52743bcd9aed5b1bcac9a539d393b2400` |
| 592 `modIdManager.ts` | `24c237ab98a442ff1091e5e85c043b4ec56a42b96185dbee7727ad645b762a05` |
| 622 `filterModInfo.ts` | `8c6ecba83fb524c7bb0a38f7fb9be8f61eb065fabe14e6f203c42abc096f6f50` |
| 628 `metaLookupMatch.ts` | `4993742e685aecf51fecd04805f17d1ec821adc06f300243dc9b12ed8eab6925` |
| 643 `testModReference.ts` | `c25f9c1c5468920c75dc9681da2530865d0a94f9d0863f2060a0eba0b8a56a52` |
| 3 `IPCDownloadAdapter.ts` | `81de583c8f3252edc6c500f5524447c450a47b5700eab71503f65eb46fc5bb6f` |
| 984 `util/fs.ts` | `c4afbd9cf138639239bb9ff8f64f4785a50b3c23e5e6885eed2d58617b98f85b` |

This is host/tooling source evidence. It neither requires nor permits reading
restricted mod implementations.

A fresh read on 31 October 2026 confirmed the same installed archive hash and
unchanged file generation before/after inspection. All six files used by the
[prepared source series](NATIVE-SOURCE-ASSEMBLY.md), including deployment,
activation-store and mod-activation sources, matched their official original
hashes. None matched the prepared patched outputs. This closes original-source
identity for that observation; it does not show the prepared code is loaded.

## Why a new owner ID is insufficient

The native installer derives its base name from the trimmed archive basename
without its extension, then masks invalid platform filename characters. In the
reviewed implementation, metadata does not determine that name. Native collision
detection nevertheless checks both existing record `.id` values and records
sharing the download's `archiveId` (575:1450–1530, 4768–4783).

After name selection, attribute extractors produce a quick metadata projection.
A defined `fileId` or `revisionId` can select an older provider: a matching
`newestFileId` wins first; the fallback uses Nexus mod ID and logical filename.
A different destination name therefore does not exclude replacement
(575:1558–1580, 4785–4819).

Before asking which version to install, Vortex checks incoming `requires` rules.
Its Ignore action removes and re-adds those rules with `ignored:true`; a remembered
batch action can take that path without another dialog. Version choice can then
silently choose replacement when there is one profile. Replacement may remove
the previous provider and inherit its enabled state. Name-conflict handling also
has remembered-choice and unattended dependency branches; creating a variant can
disable existing providers in the target profile (575:1590–1699, 4821–4946,
4948–5350). Waiting for a visible prompt is not a safety boundary.

`start-install-download` normalizes its options in 588. Its handler in 585 derives
the auto-deploy allowance from **`allowAutoEnable !== false`**; a separate
`allowAutoDeploy:false` field alone does not disable that path. A finished download
is checked for accessibility after a delay. That check does not prove its SHA,
payload, intended installer or absence of replacements.

## First supported install family

`evaluateOwnInstall(archiveBuffer, snapshot)` in
`tools/modding/vortex-agent/own-install-preflight.mjs` is the offline foundation
for one own-local package with one new provider, installed disabled. It verifies
the archive bytes/CRC/payload and evaluates a detached bounded JSON projection.
Its exact schema and synthetic examples are in `own-install-preflight.test.mjs`.
The result contains `modelAccepted`, specific rejection reasons and
`effectsAllowed:false`; it never returns an invocation permit or install readiness.
Source/build evidence and inventory completeness remain caller assertions.

Its detached input must identify the package/archive proof, supported host and
extractor contract, complete relevant inventory, context/root identities and
native metadata projection. Reject unknown fields, sparse arrays, inconsistent
map-key/record IDs, incomplete inventories and exhausted scan/output limits.
The narrow family requires all of these conditions:

- The exact archive SHA/size, ZIP structure/CRC, payload paths/hashes, source and
  build evidence agree. No interactive installer, override instructions, choices,
  patches, file list, collection revision or variant route is admitted implicitly.
- One finished tracked download has the reviewed basename, MD5, size and exactly
  the target game. Its installed marker is absent. Reuse its download ID; importing
  the same tracked archive again is not part of this contract.
- The derived owner is absent from mod records and staging, including its
  `.installing` directory, Windows case aliases and conflicting installation-path
  aliases. No installed provider shares its archive ID or exact archive MD5.
  Disabled, incomplete and pending-removal records are not free names.
- The actual filtered quick metadata has no `modId`, `fileId` or `revisionId`.
  A defined zero is not equivalent to absence. The selected lookup result and
  extractor ordering must match the admitted source contract. Unexpected metadata,
  rules, previous-provider information or unknown extractor behavior holds the
  operation. Do not erase IDs to make it qualify as own-local.
- With no previous provider, native `testModReference(undefined, reference)` is
  false, so the reviewed previous-provider dependency branch is not entered.
  Preserve all existing rules and profiles anyway; retain an incoming-rule
  inventory, including ignored rules, for before/after comparison.
- The exact native options disable auto-enable and target the reviewed profile.
  Automation, collections, dialogs, tools and competing install/deploy activity
  must be absent. A source-admitted exclusive listener consumes one permit for
  the exact download/options and refuses other native install entrypoints.

The model accepts only an explicitly named `defined-native-provider-ids/1`
`quickIdProjection`, not the complete native quick metadata object. The complete
object normally contains filenames. The capture must preserve every defined
provider ID, including zero/null; its correspondence to the real quick object
is not verified by this detached evaluator. Empty metadata lookup rows are the
only supported selection. Unknown metadata and other selection routes are held.

Matching an offline model is not proof that the loaded extractor/installer set
still follows it. Fresh source admission and native acceptance remain required.
Verify the disabled installed record, exact payload, preserved rules/profiles,
protected files and deployment state independently after the callback.

Eleven regressions exercise name/record/path aliases, shared archive references, exact
MD5 duplicates, pending records, metadata precedence, defined zero IDs, revision
IDs, previous-version matching, remembered choices, and all profile counts. A
rejected case produces no invocation permit or recommended replacement.

## Fresh checks and effect ownership

Future native integration needs one shared durable exclusion/interlock boundary
for lifecycle effects, not a separate client lock for each chat. Bind the exact
request, operation, package, provider IDs, source pins and context before sending.
Existing attempt/unknown completion blocks further effects across clients and
new request IDs. PID age, timeout or missing heartbeat cannot release ownership.
Neither the current client journal nor a prepend listener alone implements that
host-wide durable boundary.

After asynchronous proof work, re-read the current profile, roots, process state,
interlocks, native activity and relevant records immediately before invocation.
Do not let a cached file result authorize a stale API snapshot. Serialize checks
across foreground work and the poller; sharing an older check from a different
phase is not a fresh check. Cancellation stops later effects while preserving
reconciliation of an already invoked operation.

The [file-proof worker](FILE-PROOF-WORKER.md) has passed exact-host Electron
component acceptance, including the physical `original-fs` backend. Held helper
integration is separately tested; this does not admit a native installer or
prove its termination. See [local installation implementation](LOCAL-INSTALL-IMPLEMENTATION.md)
for the remaining owner/reservation/terminal gates. Native installer acceptance
still requires a coordinated window. Returning a guard Promise from callbacks
is necessary. At direct call sites, preserve synchronous execution when the
guard returns synchronously; await thenables and recheck live context afterward.
Otherwise a newly introduced microtask gap can separate final verification from
the receipt's state snapshot.

## Removal and archive retirement

Native removal is destructive. In 585:768–923, Vortex disables selected IDs in
the last active profile **before** `will-remove-mods`, then undeploys and removes
staging. `fs.removeAsync` uses rimraf in 984; this is permanent deletion, not
Windows Recycle Bin. A pre-remove hook is too late to prevent the initial flag
change. Backups do not change these semantics or supply deletion authority.

The batch handler catches individual removal errors and may still call its
callback with `null`. Partial success can also leave record updates unflushed;
`did-remove-mods` is awaited in a later `finally`. Callback success therefore does
not establish terminal disk/record cleanup. A future runner must invoke one
explicit ID at a time, inspect its terminal state and stop on any disagreement.
Do not retry a batch or describe attempted restoration as automatic rollback.

Before any removal, the frozen evidence must close these relationships:

- Every profile for the game, including pending-removal profiles and unknown
  enabled flags; every incoming rule and dependent, using the native matcher
  without its optional reference-cache mutation argument.
- The selected map-key owner, installation path, staging aliases, deployed
  manifest owners, protected patches, all hardlink identities and shared physical
  files. A directory name or missing flag does not establish exclusive ownership.
- Every game referencing the archive ID, all download/path aliases, collection
  and build consumers, source/evidence pins and active tasks. A bounded inventory
  must report unknowns; no known consumer is not proof of no external consumer.
- A retained keeper with exact reconstruction inputs and an isolated restore
  result for the promised scope. Source alone may omit compiled native inputs,
  preferences, installer choices or rollback bytes. The Stage 5 retention
  foundation does not itself prove restoration through Vortex.

Archive deletion is a separate operation. In source 3:733–765, running downloads
are canceled and may acknowledge before poll cleanup. Non-running downloads use
forced file removal and then remove checkpoint/record state. This is also not a
Recycle Bin route. Preserve authoritative downloads/keepers and unresolved
operation evidence. Where the user's policy requires recycling, these permanent
native handlers remain inadmissible without a separately agreed deletion policy.

## Work that does not need live native effects

Pure admission models, synthetic branch/partial-failure tests, keeper/consumer
graphs, isolated restore fixtures and held-template await propagation can proceed
without starting the game or restarting Vortex. Native worker acceptance,
no-replacement installation, terminal removal readback and actual keeper restore
remain separate gates. Update the [implementation checklist](LIFECYCLE-IMPLEMENTATION.md)
with evidence for each gate rather than treating this document as completion.
