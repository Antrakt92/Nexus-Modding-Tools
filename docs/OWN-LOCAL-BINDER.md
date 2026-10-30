# Own-local helper binding

This offline binder supports only the exact `ci-own-local-20261029` reference
family pinned in its source. It retargets one disabled own-local package and
uses the maintained helper constructor. It does not admit a new host or native
installer and does not grant permission to activate its output.

Run `tools/modding/vortex-agent/own-helper-binder.mjs` with `--reference`,
`--plan`, `--plan-sha256` and `--output`. All paths must be absolute ordinary
paths. The SHA is of the plan's original bytes, including its formatting.
Default execution validates in memory; Windows `--apply` publishes a new held
directory under the checkout's ignored `local-state`. Its parent must exist.
An existing destination, changed input or attempted reference is refused.

`--source-proof-mode worker` opts into the held asynchronous source-proof kit;
the default remains `cached-sync`. It does not change the package plan or grant
activation. See the [worker-mode binding gates](NATIVE-HELPER-PREPARATION.md#held-worker-mode).

## Plan contract

The plan is a JSON object with exactly these fields:

| Field | Value |
| --- | --- |
| `schema` | `own-local-helper-plan/1` |
| `family` | `ci-own-local-20261029` |
| `gameId` | `cyberpunk2077` |
| `targetProfileId` | The reviewed family's `ptndev1016` profile |
| `expectedHostVersion` | `2.9.1` |
| `sourceHostSHA256` | The family's pinned application SHA, not a version label |
| `package` | Exact package tuple below |
| `provenance` | `projectId`, 40-character `sourceCommit`, `sourceManifest`, `buildReceipt` |

`package` contains exactly `key`, `archive`, `fileName`, `expectedModId`, `bytes`,
`sha256`, `md5`, `expectedUncompressedBytes` and `payload`. `archive` names the
existing ZIP; its basename must equal `fileName`. `payload` maps every installed
relative file path to its SHA-256. Identity, byte counts and the entire payload
are checked against the archive rather than accepted from the plan.
For this native route, `expectedModId` must equal the trimmed ZIP filename
without `.zip`; a different requested owner is rejected before preparation.

Every evidence reference has exactly `path` and `sha256`. The primary source
manifest has `schemaVersion:1`, `variantKind:"script-core"` and `payloadSHA256`.
The build receipt has exactly these fields:

| Field | Contract |
| --- | --- |
| `schema` | `own-local-build-evidence/1` |
| `projectId`, `sourceCommit`, `sourceManifestSHA256` | Agree with plan provenance |
| `package` | The complete plan package excluding only `archive` |
| `retainedPayload` | Zero to four `{manifest, paths}` components; each pinned manifest has `payloadSHA256` |
| `evidence` | One to sixteen pinned original JSON evidence references |

The primary manifest and explicitly selected retained paths must cover the
package exactly once, with matching hashes. A component may select files from a
larger retained release manifest; its unrelated files are not imported. Missing,
overlapping or changed retained paths fail validation. Evidence pins establish
which inputs were used; they do not independently prove lawful provenance,
successful compilation or native acceptance. Those remain review gates.

JSON formatting and field order can vary; duplicate decoded keys are refused.
ZIP support is bounded to ordinary stored/deflated ASCII paths. Encrypted,
multipart, ZIP64, self-extracting and described entries are refused, as are
unsafe Windows paths, aliases, file/directory collisions, links, FOMOD and Vortex
override instructions. All ZIP extra fields are refused, including alternate
names and timestamps. Limits are 64 MiB for the archive or one member, 256 MiB
total unpacked bytes, 4,096 entries and 8 MiB per JSON evidence input.
CRCs and per-file hashes are checked without extraction.
This narrow scope is deliberate; refusal does not mean an archive is corrupt.

## Review the held result

`BINDER-PROOF.json` records input and output pins and missing native bindings.
`reviewed.prepared.json` is constructed from an allowlist, with no inherited
approvals, baseline or runtime context. The package remains disabled and has no
old enabled providers. There is no active `reviewed.json`, READY, host script or
effect approval. The copy map deliberately leaves unavailable materialized
files unpinned; it is not an activation-ready copy map.

Run the generated `test-package-scope.cjs` only as an offline code test. It
exercises the real engine through a pre-import hold with zero native effects;
it does not exercise Vortex's installer. Code-kit verification, fresh source/
session admission, independent deployment proof and user gameplay are separate.
Never reuse or repin an attempted helper. See
[native preparation](NATIVE-HELPER-PREPARATION.md) and the
[implementation checklist](LIFECYCLE-IMPLEMENTATION.md).
