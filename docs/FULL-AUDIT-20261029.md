# Full tooling audit — 29 October 2026

The primary and three independent agents reviewed the maintained client/adapter,
native guards/receipts, import/settlement observers, build/package/install,
recovery, Nexus CLI and publication transport/ledger. The primary reviewed the
changes and ran combined verification. This is an engineering audit, not formal
security certification, gameplay proof or a guarantee that every defect is known.

## Confirmed repairs

| Surface | Reproduced failure | Repair |
| --- | --- | --- |
| Archive verification | A tracked download changed path/state/Nexus identity or file during hashing or completion fsync, yet reported `archiveSha256Verified:true`. | Pin the record projection; hash one descriptor; compare path, dev/ino, size and nanosecond timestamps. Recheck context/record/file after pending-receipt fsync before publication. Cover fresh/reuse and preserve uncertain fresh interlocks. |
| Import readiness | The final awaited guard changed the download to failed/removed/retargeted, yet readiness was returned. Mutable expectation/row references could also retarget the hash or ID across awaits. | Copy allowlisted expectations and primitive ID; re-read the unique finished record after the final guard, including scope and ambiguous additions. No reimport as recovery. |
| RPC validation | Invalid IDs were rejected for plans, but direct reads/mutations could reach transport with an invalid ID. | Validate IDs before every dispatch. This was a protocol defect, not a demonstrated bypass of native auth/context/receipt guards. |
| Cancellation | At pending capacity, stdio stopped reading cancellation and a model plan proceeded to its next action. | Distinguish active handlers from queued stdout; accept control notifications while handlers are active; fail closed on ordinary overflow and await invoked settlement. |
| Recovery integrity | Empty inventories returned `integrity_verified:true`; schema/row validation was incomplete. | Require exact supported schema/algorithm, nonempty inventory, exact row fields and lowercase SHA-256; reject a reparse manifest path. |
| Native fixture preservation | A 501-mod list was truncated to 500; changing the omitted record still gave `ordinaryUnchanged:true`. | Runner and independent verifier refuse lists at the 500-record cap, plus malformed/duplicate IDs. Empty/under-cap snapshots remain supported. |

Regression scenarios were exercised before their repairs. Independent follow-up
review of the import diff found no additional confirmed defect within its trusted
guard/read/proof/receipt-adapter contract. Archive proof describes a checked
boundary, not indefinite immutability against arbitrary external changes.
Receipts still report `diskDeploymentVerified:false`; MCP native installation
remains refused, and create-new-only installation is not established.

## Cancellation and overload

The stdio default remains `maxPending=100`. While a full queue has an active
handler, control notifications remain readable. An extra ordinary request closes
the channel with `MCP request capacity exceeded`, without dispatch or an unbounded
second queue. Cleanup cancels later plan steps and waits for invoked operations.
A queue filled only by blocked stdout retains its prior backpressure. Cancellation
does not roll back an invoked native write.

## Performance and coordination

- The synchronous PowerShell process reader took 797/622/609ms in three read-only
  measurements; a zero-delay timer was delayed by 798/622/609ms. Download waiting
  repeats a full check each poll. A future asynchronous fresh reader for polling
  should preserve the immediate synchronous pre-effect gate and context checks
  after awaits. Do not cache the absence of a game process.
- A proposed built-in replacement was tested, not adopted: three diagnostic
  `tasklist /FO CSV /NH` calls took 5715/5702/6100ms with roughly 900 processes.
  These small, separately timed samples are not a general Windows benchmark.
- Task-owned installation still needs consolidation: duplicate `app.asar`
  hashing, expensive repeated guards, preparation work and helper restart cycles.
  See the [incident and settlement analysis](../tools/modding/vortex-agent/install-settlement.md).
  The reusable observer must be copied/pinned into the next reviewed helper;
  frozen helpers are unchanged. Model timing does not prove live installation speed.
- A neighboring installation stopped correctly on `SOURCE_CHANGED` when this
  audit changed `guard.cjs`. Shared runtime sources were frozen; their hashes
  and diff scope were handed over with explicit user authorization. No host or
  adapter restart occurred. Coordinate source maintenance before another helper
  pins shared files; reconcile its stopped phase and preserve the existing archive.

## Remaining findings and limits

- Fresh live inspection remains `partial`: `list_mods` reports
  `OPERATIONAL_VALUE_NOT_CURATED` for the previously isolated local DEV record.
  The invalid field is unconfirmed. A narrow field/type-only diagnostic remains
  needed; do not normalize metadata, hide the record or weaken serialization
  based on a guessed cause.
- The CLI wrapper checks EXE presence but not the installation receipt/hash on
  every invocation. Runtime provenance checking could detect accidental binary
  drift. No auth bypass was demonstrated; hashing cannot defeat an actor who can
  replace both binary and local receipt.
- OpenCode discovery initially returned 0/2 skills and failed. Later native queries
  returned 27 and all four targeted runs passed. All 12 canonical owners, six
  aliases, YAML and links passed. Delayed indexing is plausible, but not proven;
  any bounded readiness retry needs a verified native contract.
- Recovery checks listed manifest content, not an independent signature or
  completeness proof for an otherwise valid authoritative manifest. Registry
  results are dated advisory evidence, not proof against unknown vulnerabilities.

## Verification

Independent suites passed; focused reruns are not counted again:

| Gate | Result |
| --- | --- |
| Adapter/client/source suites, excluding package/wire | 228 Node tests |
| New isolated package provenance and built SDK HTTP/MCP wire | 2 Node tests |
| Publisher transport/repair/fetch guard | 20 Node tests |
| Recovery/bootstrap | 16 Python tests |
| Synthetic adapter installer/rollback | 28 Python tests |
| Nexus CLI | 12 Python tests |
| Publication runner/ledger | 45 Python tests |
| Pinned upstream | 144 tests; typecheck, lint, format check and build |
| Shared skill checker | 14 Node tests; full trees and four warmed native discovery runs |

Commands: `node --test --test-concurrency=1` on adapter `tests.mjs` and all adapter
`*.test.mjs`/`*.test.cjs` (package/wire separately against the fresh build);
`python -B -m unittest discover -s tests -v`;
`python -B tools/modding/vortex-agent/install.test.py`;
Python discovery on `tools/modding/nexus-cli` and `tools/modding/nexus-publish/tests`;
Node tests in `tools/modding/nexus-publish/tests`;
`python -B scripts/recovery.py verify` and `python -B scripts/update_manifest.py`.

Publisher tests initially failed on a missing default uploader checkout. The
supported process-local `NEXUS_UPLOAD_ACTION_ROOT` selected the existing pinned
checkout and all tests passed; no global config changed. Fresh registry audits
reported zero advisories across 7 production/168 total dependency entries.
Upstream source pins passed. No hosted CI or real upload ran.

The new isolated adapter used frozen-lockfile offline store reuse with scripts
disabled: 81 packages reused, zero downloaded. Patch/compile/package gates passed
with the existing live runtime workspace embedded, without host installation.
Package SHA-256:
`8300605559172dc3918370b01345eed8a00b539c3e6c36cc966ca568389fb367`.

The installed Vortex executable is 2.9.1. Its unchanged adapter remains protocol
`vortex-agent/1`, extension label 1.0.4, bundle SHA-256
`4d7862bad1f4faa5517edc97b51f0d6cd0f1a426f2ba9ddb28354aa33f8d4243`.
The historical target 2.7.2.0 is not the installed host version. Source publication,
client reconnection and native adapter activation are separate observations.

Raw proofs, logs, registry audits and the isolated build remain in ignored
`local-state/full-audit-20261029/`. This audit performed no game launch, profile
switch, real acquisition/install/deploy or public upload. The neighboring chat
owns its separately authorized installation.
