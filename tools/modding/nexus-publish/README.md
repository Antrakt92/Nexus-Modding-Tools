# Guarded Windows Nexus publication preparation

This runner executes the **unchanged official** `Nexus-Mods/upload-action` bundle.
Local dry-run and modeled publication are verified, including the 2026-10-02
repair contract below. Historical setup evidence recorded validation of the shared
Credential Manager key with Nexus and confirmation of Premium access;
`check-credential.py` verifies the publisher's own reader without an upload.
Current local checks do not revalidate credentials, Premium status or account access.
The original test-only acceptance did not include a live upload or target-ownership
check. The later dated transport section below records a separate completed upload;
neither historical result establishes current account or target access.

## Files and prerequisites

Defaults are independent of the current working directory. `NEXUS_WORKSPACE`
overrides the repository root with an absolute runtime workspace.
`NEXUS_CONTEXT_ROOT` overrides `<workspace>/local-state/upstream-sources`;
`NEXUS_UPLOAD_ACTION_ROOT` can point directly to an existing verified official
action checkout. `NEXUS_STATE_DIR` overrides the persistent publication ledger.
These variables select directories, not credentials. Importing the path helper
does not create directories or install tools.

- Runner: `tools/modding/nexus-publish/publish.py`
- Log-isolating Node launcher: `safe-action.mjs`
- Native-fetch boundary: `fetch-guard.mjs`
- Fresh built-in dispatcher initialization: `native-transport.mjs`
- Bounded standard-library XML validator: `completion-xml.py`
- Opt-in exact-target credential reader: `windows-credential.py`
- Inactive workflow template: `manual-release.workflow.yml`
- Manifest schema/example: `manifest.example.json`
- Upstream checkout: `<context-root>/nexus-upload-action`
- Persistent ignored receipts/locks: `<workspace>/local-state/nexus-publish-setup`

Python 3.11+ and **Node 24 with built-in Undici 7.18.2+ in the 7.x line** are required.
The runner itself uses only standard
libraries and the already bundled official action; no npm runtime install is
needed. Verification used Python 3.14.7, Node 24.13.0, npm 11.20.0.

Official source: <https://github.com/Nexus-Mods/upload-action>

2026-10-04 transport repair: live Nexus reservations use Cloudflare R2 with a
virtual-hosted bucket prefix. The guard permits the documented account endpoint
and one valid bucket label before its 32 lowercase hex account ID, exclusively
for exact Nexus-issued URL/method pairs. See [Cloudflare release notes, 2022-05-16](https://developers.cloudflare.com/r2/platform/release-notes/).
Custom domains, nested bucket labels, suffix tricks, redirects, storage credentials
and inconsistent plans remain refused. The virtual-hosted regression failed before
this correction and passes after it. All 43 Python and 20 Node checks pass.
Smart Vendor 0.3.3 completed through the unchanged official action, with independent
version readback. Two stopped unknown attempts were separately reviewed using exact
account/artifact identity, process termination, the OS operation lock and fresh complete
chain-version reads. Original records remain verbatim under reviewed-recoveries in
this same ledger; no force-reset mode was introduced. Task evidence is under
`local-state/smart-vendor-alcohol-033-20261004/`. Future unknowns still require the
recovery review below; this successful case does not authorize blind retries.
The safe launcher reports only enum stage/failure codes in addition to its original
ok/version_id projection. It continues discarding all raw upstream messages.

Pinned upstream revision verified on 2026-10-01:
`98532f7670c27cbecc78fae03fa3e278147827e2`.

The latest listed release in the 2026-10-01 inspection was `v1.0.0-beta.10` at
`c96019556046053aa26044b44396cd38929daf23`; **that is not this current-main pin**.
The package's internal version remains `0.0.1`. License: MIT, copyright
`2025 bengosneynexusmods`; license retained in the context checkout.

Verified bundle SHA256:
`9144bb1ed9877ccdae3be52b4d57ec6813c2c300351e109aa68d023ac34e69af`.
Bundle checking canonicalizes Git-for-Windows CRLF checkout conversion to LF
before hashing; ZIP hashing always checks exact bytes without normalization.

Locked manifest SHA256:
`ee2eb9db4fc0122812ba58842a734dff3afa8957179195414c75fca2a08baf28`.

## Manifest and ID contract

Make a task-owned JSON manifest based on the example. Its placeholders deliberately
do not pass preflight. Required fields:

| Field | Meaning |
|---|---|
| `game` | Nexus domain slug, e.g. the game's URL segment |
| `expected_user_id` | Approved uploader account ID, a positive decimal string; never an API key |
| `mod_page_id` | Game-scoped mod ID from `/GAME/mods/ID` |
| `mod_id` | Global **v3** mod ID; do not substitute the mod-page ID |
| `file_id` | Persistent **v3 mod-file ID** / update chain, from Advanced/Manage Files |
| `existing_file` | Must be the JSON boolean `true` |
| `archive` | Existing absolute regular `.zip` path |
| `version` | 1-50 ASCII characters matching `[a-zA-Z0-9.-]+`; not inferred from archive name |
| `sha256` | Expected 64-character lowercase SHA256 of the frozen ZIP |

The action cannot create the initial mod page or initial file. A traditional
game-scoped download file ID identifies a **version**, not necessarily the
persistent v3 file chain. Inspect the exact Advanced/Manage Files IDs before
preparing a real manifest.

Optional action fields: `display_name`, `description`, `category`,
`archive_existing_version`, `primary_mod_manager_download`,
`allow_mod_manager_download`, `show_requirements_pop_up`, `update_mod_version`,
`changelog`. JSON booleans are mandatory for boolean options. Category is limited
to `main`, `optional`, `miscellaneous`. `update` is a legacy/read category, not a
valid creation category. Effective display names must contain 1-50 characters
matching `[a-zA-Z0-9 _'().-]+`, including filename fallback. Supply a valid explicit
display name if the ZIP basename violates that rule. The runner supplies `false` for
archive-existing and update-mod-version; omitted other optional booleans remain
omitted, preserving upstream/server defaults. A changelog is additive, so replay
can duplicate its text. All unknown fields, credentials and API-base overrides
are rejected.

The pinned `@actions/core.getInput()` uses ECMAScript `String.trim()`. All supplied
text options/paths that would change under that trimming are rejected before any
key access or action execution (including padded/whitespace-only display names).
An absent or exactly empty `display_name` falls back to the archive basename;
an absent/empty category becomes `main`. Empty description/changelog remains
omitted by the action. Receipts record `effective_display_name` and
`effective_category`, and GET readback compares those effective values.

## Commands

Run from the repository root (absolute paths also work):

```powershell
# Default: offline archive/CRC/hash/metadata validation. No key access, action execution or network.
python tools/modding/nexus-publish/publish.py PATH/TO/manifest.json

# Future explicitly authorized publication only; hidden key prompt, no key in arguments/files.
python tools/modding/nexus-publish/publish.py PATH/TO/manifest.json --publish --credential prompt

# Alternative source for a FUTURE explicitly authorized upload; same CLI-owned store, no enumeration:
python tools/modding/nexus-publish/publish.py PATH/TO/manifest.json --publish --credential windows-cli

# GET-only reconciliation of an existing attempt/unknown receipt:
python tools/modding/nexus-publish/publish.py PATH/TO/manifest.json --reconcile --credential prompt

# If the action died without preserving its output ID, supply an independently established v3 version ID:
python tools/modding/nexus-publish/publish.py PATH/TO/manifest.json --reconcile --credential prompt --version-id VERSION_ID
```

Exit `0`: valid dry-run or verified publication metadata. Exit `2`: blocked or
unknown. Always examine `outcome`, `uploaded`, `metadata_verified`,
`artifact_verified`, `action_complete`; exit zero alone is not proof of upload.
`--action-dir` supports another checkout only if HEAD and bundle hash match the
same exact pin. `--state-dir` supports the future workflow's durable ledger;
**never change/delete the ledger to bypass an attempt**.
An explicit `--state-dir` must be absolute, so changing working directories cannot
silently select another ledger.

Dry-run validates the stated IDs' syntax and existing-file declaration offline;
it reports `account_verified`, `ownership_verified` and
`target_relationship_verified` as false. Before any upload, publish performs
GET-only account and uploader checks, then resolves
`GET /games/{game}/mods/{mod_page_id}`, checks its global `mod_id`, verifies
`file_id` membership in `GET /mods/{mod_id}/files`, checks
`GET /mod-files/{file_id}`, then requires a nonempty version list and refuses
an already-present version. These are experimental official v3 read endpoints;
missing/malformed responses block before any upload.

### Intended account and target uploader

`GET /v1/users/validate.json` returns a numeric `user_id` that must match the
manifest's approved `expected_user_id`. `GET /v1/games/{game}/mods/{mod_page_id}.json`
must identify that game/page and return the same numeric `user.member_id`.
Strings, booleans, missing IDs, another account and another uploader all block.
The account response includes a key and personal fields: the reader projects
**only `user_id`**; the mod response projects only page/domain/uploader ID. Raw
responses never enter stdout, errors, receipts or child environment.

Shape provenance: official `Nexus-Mods/node-nexus-api` commit
`da9b8eda8a3f381f04d87c7290595066ccbdbc5d`, `src/types.ts`
(`IValidateKeyResponse.user_id`, `IModInfo.user`, `IUser.member_id`), and the
official legacy route specification. This supports the actual uploader account;
team/collaborator authority requires a separately reviewed official permission
response and is currently refused. Successful relationship GETs never establish
ownership. There were no live account/ownership calls during this repair.

## Credentials and safe logs

Optional `windows-cli` mode shares the exact existing CLI credential contract:
<https://github.com/vadimtrifonov/nexusmods-cli/blob/494f061e9f277414c4df306826b4d92cd1e6b90c/src/NexusMods/Credentials.cs>.
The annotated `v1.1.1` tag object is `aaac868372b6cf7eecec3993cadd97b385e1679c`;
its peeled source commit is `494f061e9f277414c4df306826b4d92cd1e6b90c`.
`Credentials.Load()` reads **only** target `skill-nexus`, generic type `1`, flags
`0`, validates a nonempty/even UTF-16 byte count <=2560, and releases it with
`CredFree`. The Python reader follows that counted UTF-16 layout via `CredReadW`.
There is no enumeration, target override, write/delete, key-output command, Vortex
access or CLI subprocess. Configure the shared store through the CLI's hidden
`nexusmods auth set`; the existing prompt remains an alternative. Real stored
credentials were not read during repair; reader tests use synthetic allocated blobs.

For local future publication, the user can enter their Nexus API key in a hidden
interactive prompt; it remains process memory and is forwarded only as
`INPUT_API_KEY` to the action child. No terminal/stdin plaintext fallback. The
inactive GitHub template accepts `secrets.NEXUSMODS_API_KEY` in a configured
workflow; `github-secret` mode refuses ordinary local sessions.

Upstream `src/index.ts` includes API keys in debug request JSON and raw response
bodies in errors. Therefore the launcher **discards every upstream stdout/stderr
message**, parses only a bounded valid `version_id` output, and emits a fixed
JSON result. The parent never forwards child logs/exceptions. It allowlists child
environment fields and strips `NODE_OPTIONS`, API overrides, GitHub output files,
debug flags and unrelated secrets. GET errors and redirects are suppressed/refused.
Receipts contain allowlisted IDs, version, effective name/category, hash, size and booleans.
They additionally contain a random attempt token and the explicitly approved
account ID, never a raw account response. The parent passes the frozen file size
and its Python executable as `NEXUS_ARCHIVE_BYTES` / `NEXUS_PYTHON` in the sanitized
child environment; these are non-secret wrapper controls, not action inputs.

Before importing the unchanged bundle, `safe-action.mjs` installs a native-fetch
guard. Credential requests require the exact approved HTTPS origin
`https://api.nexusmods.com`, `/v3/` paths and the expected `apikey` header.
Transport always gets `redirect: 'error'` and `credentials: 'omit'`; every 3xx
response is also refused. This prevents native fetch forwarding a custom `apikey`
on cross-origin 302/307 redirects. Storage rejects API keys, authorization/cookie
headers, userinfo, non-HTTPS URLs, nondefault ports, localhost/IP/unknown hosts and
redirects. It allows only **exact URL/method pairs** from the authenticated
`POST /v3/uploads/multipart` response (`PUT` parts; `POST` completion).

The pinned official schema explicitly specifies Amazon S3 multipart behavior.
Approved provider scope includes AWS S3 REST endpoints documented at
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html>:
regional/global virtual-hosted and path-style endpoints, plus legacy `s3-REGION`
forms, all under `amazonaws.com`. The entire part/completion URL plan is validated
before the first storage request. No generic `*.amazonaws.com`, arbitrary CNAME,
or unreviewed S3-compatible-provider allowance exists. Reviewed Cloudflare R2 account
and single-label virtual-hosted endpoints are also supported as documented above.
Official action source does not pin the actual live upload provider/bucket. An API-issued destination outside this reviewed scope will fail
closed and require source/provider review, never a blind retry or broad allowlist.

The plan must have a positive integer part size <=64 MiB, <=10,000 unique part
URLs and exactly `ceil(frozenArchiveBytes / partSize)` parts. Part numbers must be
1..N in order; object, origin and upload ID must match the completion URL. Each
PUT is reserved before awaiting transport to prevent concurrent duplicates.
Its Buffer/view length and Content-Length must match the expected part size,
including the final short part. Completion is allowed exactly once, only after
all parts succeed and their sizes sum to the frozen size. Short file reads are
rejected before storage. There is no automatic part/completion retry.

The completion XML request must list exactly the confirmed part numbers/ETags.
A Python standard-library XML helper parses both request and response, with
3,000,000-byte request and 65,536-byte response limits, a ten-second parser
timeout, and DTD/entity declarations forbidden. HTTP 200 `<Error>`, embedded
errors, malformed/empty/wrong-namespace responses and missing Bucket/Key/ETag
success fields block before Nexus finalisation. The helper accepts stdin only,
inherits no Nexus key and emits no response text or URLs.

### Native transport provenance

Before importing the unchanged bundle, the launcher primes Node's lazy built-in
native fetch using a **local `data:` URI**, captures its dispatcher and freezes
that global identity. A preloaded unknown dispatcher is refused. Every guarded
request explicitly uses that dispatcher and verifies its identity remains the
same. This prevents the bundle's Undici 5.29.0 initialization from supplying the
native-fetch transport. Socket-free tests prove bundle import preserves the
built-in identity and that actual native fetch invokes it.

Node 24.13.0's built-in Undici 7.18.2 contains the decompression-chain fix but
predates the keep-alive response-queue fix. Every guarded request therefore uses
`Connection: close`, preventing reuse, alongside redirect refusal and omitted
credentials. This is a bounded mitigation, not a blanket runtime security
certification. Upstream bundled advisories remain present; the Actions HTTP
helper is not invoked by this action. No dependency or bundle changes were made.

## Attempt / done / unknown

- A nonblocking **OS-held target operation lock** coordinates BOTH publication and
  reconciliation from before credential/target checks through final ledger writes.
  Windows uses `msvcrt.locking`; POSIX uses `flock`. Stable `operation-locks/*.lck`
  inodes are never deleted/replaced. An OS process death releases that operation
  lock, but never implies an upload did not happen.
- A durable exclusive target marker and schema-2 `attempt` receipt precede action
  execution. Both carry the same random `attempt_id`; every update/removal checks
  exact ownership and complete receipt identity/schema. Atomic replacement is used
  for updates after fsync. Retain the operation-lock files as well as JSON ledgers.
- Windows sharing locks prevent ZIP writes/deletes while allowing the action to read it.
- `done` requires action success, a valid returned v3 version ID, and independent
  `GET /mod-file-versions/{id}` matching file chain, version, display name and category.
- Failure, timeout, cancellation or readback mismatch becomes `unknown`; a hard
  interruption may leave `attempt`. Both block retries. The target-wide lock also
  blocks bypassing uncertainty by changing the version string.
  `uploaded` is `null` for attempt/unknown, `false` for dry-run, and `true` only
  after metadata confirmation; unknown must never be interpreted as "not uploaded".
- Even `done` blocks another upload of the same target/version. A verified done
  unlocks the target for genuinely new versions while retaining the original receipt.
- GET-only reconciliation can confirm an independently identified version and
  clear that exact target lock after the action returned. It cannot clear an active
  operation. It does not re-upload or replay changelogs.
  `action_complete: false` remains false after partial-action reconciliation.
- If no version can be independently identified, or a lock exists without a valid
  matching receipt, stop for investigation. There is no force-retry/reset command.
- A hard interruption leaving `action_running: true` remains conservatively blocked,
  even after the OS lock releases: a child uploader could still exist. Establish
  uploader termination and exact version/account/artifact evidence independently;
  deliberate recovery requires separately reviewed ledger migration. The runner
  provides no unsafe automatic stopped-process assumption or migration/reset mode.
- A cancellation or exception before the action invocation returns also retains
  `action_running: true`. Releasing the parent's OS lock does not establish that
  its child uploader stopped. An invocation that returned before a readback
  interruption remains separately reconcilable using its durable version ID.
- Existing schema-1 receipts/markers remain effective retry blockers. Reconciliation
  refuses automatic migration or clearing because they lack account/attempt ownership
  evidence. Malformed, missing, mismatched or partially written records fail closed.

The ledger is local to the dedicated Windows runner. It cannot coordinate a
second computer or direct website uploads; serialize those operations separately.
Preserve the durable ledger across runner replacement, and freeze other publishers.
Stop old runner/reconciler versions before upgrading; they do not participate in
the new OS-lock/schema-2 protocol. Never run old and new ledger writers together.

## Remote artifact verification

The official v3 `ModFileVersion` response provides version metadata and a
`game_scoped_id`, **not a SHA256/MD5 or original archive bytes**. The runner
deliberately leaves `artifact_verified: false`, even for metadata-confirmed done.

Official readback routes and documentation:

- V3 spec: <https://api.nexusmods.com/openapi.yaml>
- V3 metadata: `GET /mod-file-versions/{version_id}`; versions:
  `GET /mod-files/{file_id}/versions`.
- Official legacy spec:
  <https://api.swaggerhub.com/apis/NexusMods/nexus-mods_public_api_params_in_form_data/1.0>
- Original file details/download route uses the v3 response's game-scoped version
  ID: `GET /v1/games/{game}/mods/{mod_page_id}/files/{game_scoped_id}.json` and
  `.../download_link.json`. The latter requires Premium or the website-issued
  key/expiry for non-Premium users. Never print/persist returned download URLs.
- Original-byte proof: independently download that exact published version through
  the approved Nexus/browser/managed integration and compare its SHA256 and size
  with the receipt. Reuse an existing independently downloaded archive if verified.
- Current v3 also advertises `POST /mod-file-versions/{id}/download-repacked`.
  It returns an expiring download URL for a **repacked** archive; repacked ZIP bytes
  are not proof of the original ZIP's SHA256. The runner does not call it.

No live artifact or version readback was attempted during this setup.

`metadata_verified` is deliberately limited to version ID, file-chain ID, version
text, effective display name and effective category, plus the preflight target
relationship. The official version response does **not** prove saved description,
archive-existing behavior, mod-manager download flags, requirements popup or
mod-level version update. Changelog completion is reported only through action
success, not an independent changelog readback. Those fields need separate
authorized API/UI acceptance; neither this flag nor `action_complete` is a full
metadata-field or remote-byte verification claim.

## Manual GitHub release template

`manual-release.workflow.yml` is kept here, outside `.github/workflows`. It is
manual-dispatch-only, defaults to dry-run, downloads two named **existing** GitHub
release assets (ZIP and manifest), binds the absolute local archive path, then
executes the safe runner over the exact pinned official bundle. Source is checked
out at the immutable SHA rather than running a direct `uses: Nexus-Mods/upload-action`
step, because direct upstream logs violate the requested safe-log contract.

For deliberate future adoption: copy the runner files to the chosen repository,
configure a trusted dedicated self-hosted Windows runner with Node 24, Python,
Git and `gh`, label it `nexus-publication`, configure the named environment and
secret, and set the repository variable `NEXUS_STATE_DIR` to a persistent absolute
directory outside both `RUNNER_TEMP` and `GITHUB_WORKSPACE`. Preserve that ledger
across jobs and upgrades. The inactive template rejects an absent or ephemeral
ledger rather than substituting a personal drive or temporary directory. This self-hosted design
is intentional: ephemeral runners/artifact-only receipts cannot reliably preserve
an attempt if the upload job is interrupted before artifact retention. Every action
reference is SHA-pinned; contents permission is read-only; publication jobs are
serialized without cancelling an in-flight upload. Do not enable this template
automatically in any mod repository.

## Verification and dependency review

Current repair verification (all fixture/state writes under
`local-state/nexus-publish-repair/`; no real credential/account/upload calls):

```powershell
python -B -m unittest discover -s tools/modding/nexus-publish/tests -p 'test_*.py' -v
node --test tools/modding/nexus-publish/tests/fetch-guard.test.mjs tools/modding/nexus-publish/tests/transport-repair.test.mjs tools/modding/nexus-publish/tests/native-transport.test.mjs
node tools/modding/nexus-publish/tests/check-workflow.mjs
node --check tools/modding/nexus-publish/safe-action.mjs
node --check tools/modding/nexus-publish/fetch-guard.mjs
node --check tools/modding/nexus-publish/native-transport.mjs
```

The tests include real concurrent processes, killed-runner marker survival,
normal post-action reconciliation, ownership tampering, atomic replacement failure,
malformed/legacy receipts, account mismatch, creation-schema boundaries and the
actual pinned bundle with wholly mocked upload networking. The committed
[integration audit](../../../docs/FULL-AUDIT-20261025.md) records the later repairs
and acceptance boundaries; the tests above are the executable contract. Historical
setup commands below are not instructions to install/rebuild again during a repair audit.

Commands executed locally:

```powershell
# Official checkout: locked, isolated node_modules; install scripts disabled.
# Run inside the chosen official checkout; this example does not install anything automatically.
npm ci --ignore-scripts --no-audit --no-fund --cache .npm-cache
npm run check
npm run build
npm audit --ignore-scripts
npm audit --omit=dev --ignore-scripts

# Nexus workspace:
python -m unittest discover -s tools/modding/nexus-publish/tests -p test_publish.py -v
node --check tools/modding/nexus-publish/safe-action.mjs
node --check tools/modding/nexus-publish/fetch-guard.mjs
node --test tools/modding/nexus-publish/tests/fetch-guard.test.mjs
node --check tools/modding/nexus-publish/tests/mock-network.mjs
node tools/modding/nexus-publish/tests/check-workflow.mjs
python local-state/nexus-publish-setup/make-fixture.py
python tools/modding/nexus-publish/publish.py local-state/nexus-publish-setup/synthetic-manifest.json
```

The official repository has **no automated test script/suite**. Its shell
`run-test-upload` invokes authenticated `gh act`; that was not run. Its documented
`local-action` runs TypeScript through `@github/local-action` with a `.env` file;
the guarded runner executes its production `dist/index.js` entrypoint directly
with environment-only input instead. There is no official dry-run mode; our
offline dry-run never executes the action.

Dependency identity reviewed: official Nexus repository/package, MIT;
`@actions/core` from actions/toolkit (MIT), `@github/local-action` from
github/local-action (MIT), Rollup/TypeScript official tooling. Locked install
added 464 packages in the context cache, with no lockfile changes. Lifecycle
markers were only `esbuild` (dev) and `fsevents` (optional macOS); all were disabled.
No package upgrades/audit fixes were applied.

**Historical upstream dependency snapshot (2026-10-01):** that audit reported 21 findings
(7 moderate, 14 high); the production-only audit reported 2 (1 moderate, 1 high)
through `@actions/http-client` / `undici`. Other affected locked tooling included
Rollup, serialize-javascript, YAML parsers and glob libraries. These audit results
are not a safety certification. Runtime uploads use explicitly selected built-in
Node fetch/dispatcher as described above. Bundled Actions-core HTTP code still
exists; its findings must not be called dev-only or silently resolved by a runtime update.
The dev dependencies are retained solely for trusted local verification.

Typecheck and build passed. Build reproduced the **exact tracked bundle**
(Git blob `1ccac3f4082d1c2cb4a40f7c6db33f47a3931eaf`); source-map-only path drift
remains in the disposable context checkout. Build emitted the existing
Actions-core/OIDC circular-dependency warning. Original raw setup/test logs remain
in private ignored local-state and are not required public setup inputs.
Use the committed [full audit](../../../docs/FULL-AUDIT-20261025.md) and
[regression suites](tests/) for subsequent repair evidence and verification scope.

## Recommended contract for the primary skill writer

Route publication preparation to this runner/manifest and record the source pin
and archive pin. Confirm each actual upload is covered by the task or existing
user release delegation; do not request the same permission again. Explicit task
limits and candidate acceptance gates still control.
Use default dry-run until global v3 mod/file IDs and credential source are approved.
Keep initial mod/file creation as a separate manual prerequisite. Distinguish local
validation, modeled action behavior, metadata-confirmed publication and independent
remote-byte verification. Retain the persistent ledger and prohibit blind retries,
including archive/hash/version or machine changes used to bypass uncertainty.
After partial changelog failure, reconcile the published version before any separately
authorized changelog repair. Never scrape Vortex/credential stores or allow raw
upstream logs/debug/authenticated URLs. Optional shared CLI reads use only the
source-pinned `skill-nexus` contract; no blanket credential-store access is authorized.
Keep transport redirect refusal, exact API origin, reviewed storage provider scope
and the distinction between effective fields verified and optional fields unverified.
