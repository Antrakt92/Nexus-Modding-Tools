# Changelog

Source-release history for [Vortex Nexus Modding MCP](https://github.com/Antrakt92/vortex-nexus-modding-mcp).
Dates are the original GitHub publication dates, in UTC. Each section describes
the code and verification available at that version; historical limitations are
not a statement about the latest release. The suite version is separate from the
embedded Vortex adapter's 1.0.4 label.

| Version | Published | Main changes |
| --- | --- | --- |
| [0.5.0](https://github.com/Antrakt92/vortex-nexus-modding-mcp/releases/tag/v0.5.0) | 2026-10-31 | Process-check benchmarks, experimental Rust CLI and native install contracts |
| [0.4.0](https://github.com/Antrakt92/vortex-nexus-modding-mcp/releases/tag/v0.4.0) | 2026-10-30 | Interrupted-plan status, local helper binding, file proofs and API-cache checks |
| [0.3.0](https://github.com/Antrakt92/vortex-nexus-modding-mcp/releases/tag/v0.3.0) | 2026-10-29 | Tracked Nexus batch helpers, inventory repair, payload checks and setup guides |
| [0.2.0](https://github.com/Antrakt92/vortex-nexus-modding-mcp/releases/tag/v0.2.0) | 2026-10-29 | Offline helper preparation, installation diagnostics and development dependencies |
| [0.1.0](https://github.com/Antrakt92/vortex-nexus-modding-mcp/releases/tag/v0.1.0) | 2026-10-29 | Combined inspection, collection download reuse and coordinated plans |
| [Recovery sources](https://github.com/Antrakt92/vortex-nexus-modding-mcp/releases/tag/recovery-sources-20261025) | 2026-10-25 | Pinned upstream Git bundles for source recovery |

## Unreleased

- Add an internal fixed extractor process owner with shared handle custody,
  sticky cancellation, bounded pipe polling and terminal-gated handoff. It is
  not connected to the MCP installation operation.
- Exercise controlled guardian loss with suspended and active extractor fixtures
  and a real intent journal. Owner loss requires reconciliation regardless of
  process exit code; source drift and replay remain refused in the fixture.
- Add opt-in Windows custody tests with a separate surviving custodian and a
  controlled caller crash. Document the observed early-release gap in child-only
  handle inheritance; SDK/Vortex integration and general recovery remain unproved.
- Add internal archive/temp custody and handoff through the original held
  directory handle. Windows tests and an actual 7z fixture cover the normal path;
  crash custody, no-clobber extraction and Vortex installation remain unproved.
- Prepare explicit job-owned extraction with a fixed archive/destination tuple,
  bounded launches and cancellation that blocks later attempts. Ownership stays
  attached to the instance across asynchronous callbacks. This is an uninstalled
  source integration; it does not enable native installation through MCP.
- Add an internal passive child-resource observer with status independent of
  caller promises. It waits for consistent child and pipe close observations;
  cancellation or a timeout cannot manufacture completion. Native installation
  and cleanup permissions remain unavailable.
- Prepare an extractor error-settlement patch that retains the first failure
  and waits for the exact child to close before rejecting, including stream
  errors and asynchronous cancel failures. Failed kill requests cannot report
  termination. The patch is uninstalled; cancellation classification and complete
  native installation acceptance remain separate gates.
- Add an internal Windows handle-owned transfer library: exclusive new targets,
  bounded hash-verified copying and retained partial output on failure. Native
  tests cover aliases, junctions and interrupted handle lifetimes. It is not
  connected to Vortex installation and grants no installation permission.
- Bound HTTP audit-server startup and preserve bind failures instead of waiting
  indefinitely for `listening`. Test-only cleanup closes the exact owned server;
  regression coverage includes occupied ports, deadlines and unfinished uploads.
- Prepare a Vortex transfer-worker join patch: after failure, stop new callbacks
  and wait for started mkdir/copy callbacks before returning the first error to
  cleanup. It preserves normal concurrency and leaves global dependency helpers
  unchanged; native termination and safe cleanup remain separate gates.
- Prepare a Vortex transfer patch that propagates failed copy fallbacks instead
  of reporting success. Source-derived tests preserve the self-copy exception
  and verify that rejection does not prove other transfers have stopped. The
  patch remains uninstalled; no-clobber and safe cleanup are separate gates.
- Prepare a private new-disabled Vortex selection patch that rejects provider,
  owner/path and all-profile conflicts before legacy replacement branches. Public
  installation remains unavailable; the patch is uninstalled and does not prove
  physical ownership, safe cleanup or complete native acceptance.
- Add an immutable full-request install-intent journal with exact digest-bound
  readback and process-exit/failure tests. It grants no native effects or replay;
  power-loss persistence and the durable executor remain unproved.
- Fix plan-journal root replacement races during reservation and reading. A
  moved operation directory cannot make a replacement root authoritative. Share
  the immutable record I/O between both journal schemas.
- Add an offline native-dispatch request model with complete-plan binding and a
  synchronous 1,024-operation consumed-ID registry. Both operation and job IDs
  prevent replay within the modeled lifetime; native dispatch, durable intents
  and installation permission remain unavailable.

## 0.5.0 — 2026-10-31

Adds process-check benchmarks, an isolated Rust CLI and source-tested native
installation contracts. This is a source release: the resident Vortex guard
still uses its existing backend. No Rust executable or Vortex application
update is included, and native archive installation through MCP remains unavailable.
Changes since [0.4.0](https://github.com/Antrakt92/vortex-nexus-modding-mcp/compare/v0.4.0...v0.5.0).

### Process diagnostics

- Add `process-probe-benchmark.mjs` and `process-probe-compare.mjs`. Both default
  to plan-only; explicit `--run` starts bounded read-only measurements. Reports
  retain initial observations and separate subprocess wall time, full-call
  validation and executable admission. Alternating comparisons omit raw process
  lists.
- Add a process-only Rust Toolhelp CLI with a closed request/reply format,
  exact request IDs and bounded UTF-8/UTF-16 validation. Partial enumeration,
  malformed output and unexpected arguments refuse.
- Add an explicit static-CRT build recipe and bounded AMD64 PE import inspection.
  Native tests can require the reviewed declared OS imports before launching
  the exact compiled artifact. Clean-Windows and distribution acceptance remain
  separate checks.
- In one local sequential 40-pair run, median full-call time was 296.86 ms for
  PowerShell and 49.96 ms for the static prototype. This measures one component,
  not complete installation or renderer responsiveness. See the
  [method and results](docs/PROCESS-PROBE-EXPERIMENT.md).

### Native installation preparation

- Add a pure tracked-install job model with bounded strict JSON, canonical plan
  identity and replayed callback, terminal and cleanup observations. It grants
  no native effects or installation permission.
- Include exact-source Vortex 2.9.1 patches for ordinary tracking collisions,
  one-shot callback delivery and separate per-invocation core-tail diagnostics.
  The callback patch preserves reentrant tracking replacements and isolates
  notification failures from destructive cleanup. The activity patch joins
  error cleanup even when error formatting throws. These patches are uninstalled;
  source-derived tests do not replace a complete Vortex build or native acceptance.
- Specify the future fixed new-disabled entrypoint, durable preallocated job ID,
  bounded one-shot consumption and uncertain-result recovery. The contract is
  documented but the native executor is not implemented.

### Maintenance and compatibility

- Rename the project to Vortex Nexus Modding MCP at
  `Antrakt92/vortex-nexus-modding-mcp`. Accept both repository URLs in existing
  packages and source recovery. Historical release names, hashes and recovery
  bundle pins remain unchanged.
- Document bounded post-task cleanup through the Recycle Bin, preserving active
  consumers, source, required fixtures and reconstruction inputs. No general
  MCP deletion operation is added.
- Validate Rust source and Cargo lockfile UTF-8 before pinning source inventories.
- Pin the optional prototype to Rust 1.99.1, windows-sys 0.61.2, serde 1.0.229 and
  serde_json 1.0.154. Its Cargo lockfile and dependency review are included.
  Existing JavaScript dependency versions are unchanged.

### Verification and upgrading

- Local verification passed 605 MCP/helper tests, 57 Python recovery/cache/version
  tests, 35 installer tests and six Rust tests, with no skipped tests. The native
  CLI and declared imports were checked against an independently parsed local
  build; this does not establish clean-machine or installed-Vortex acceptance.
- The suite version is 0.5.0; the embedded adapter label remains 1.0.4. Updating
  this source checkout does not activate Rust, apply native patches, restart
  Vortex or enable MCP installation/removal. Preserve the existing runtime
  workspace, credentials and operation receipts.

## 0.4.0 — 2026-10-30

This release adds status checks for interrupted plans, prepares own-local mod
archives for reviewed installation helpers, and adds optional background
source-file checks. Native installation and removal remain separate guarded
workflows; the MCP does not gain a general-purpose installer.
Changes since [0.3.0](https://github.com/Antrakt92/vortex-nexus-modding-mcp/compare/v0.3.0...v0.4.0).

### Added

- `inspect_mod_plan` and the `plan-status` CLI read saved plan IDs, step intents
  and operation receipts after a disconnect. Inspection does not replay a step,
  resume a plan or clear an unresolved operation.
- `read_mod_lifecycle` reads batches of 1–20 installed mod IDs, including usage
  across profiles, pending removal, incoming requirements and archive references
  across games. This endpoint requires a rebuilt host bundle.
- An offline binder checks an own-local ZIP's CRCs, payload, archive hash and
  source/build evidence before preparing an inactive helper for the supported
  template family. Preparation does not authorize installation or replacement.
- Optional `--source-proof-mode worker` shares pending source proofs and drains
  checks before final verification. The read-only worker supports standalone
  Node and the verified Vortex runtime's physical `original-fs` backend.
  Prepared kits remain inactive until their native admission checks pass.
- A pure own-install preflight checks a detached inventory/metadata model for
  one new mod installed disabled, with no existing provider. Its result withholds native
  effects; it is not proof of the native installer's final selection.
- A keeper records declared build inputs and verifies restoration into a separate
  directory. Unknown consumers or unproven native restoration still block
  retirement; this tool does not remove mods.
- API-cache inspection explains missing, stale or failed generation. Explicit
  generation checks input, tool and recipe pins and retains immutable receipts;
  an older reference is not used as a fallback.
- Source-bound technical-settings comparison admits only eight reviewed tool
  rediscovery timestamp leaves and preserves all other settings. Collection-release
  guidance distinguishes preparation, publication and post-release work. Collection
  submission and profile switching are not added to the MCP.

### Improved and fixed

- Decode fragmented MCP event streams incrementally, including CR-only line
  endings. In a synthetic 2 MiB response with 512-byte chunks, median decode time
  fell from 1,065.7 ms to 5.6 ms. This measures parsing, not live installation.
- Avoid unnecessary receipt reads after failed initial plan admission. Started
  reads still settle and successful plans retain their checks.
- Give the supported own-helper payload check an independent physical reader
  instead of clearing the entire collection cache. Its generated-helper test
  halved hashed bytes while retaining physical observations and rehashing the new
  payload. Live installation speed has not been measured.
- Preserve asynchronous guard results across generated lifecycle boundaries and
  recheck live context immediately before native commands.
- Accept reviewed helper configurations up to 8 MiB. Individual source modules
  retain the 1 MiB limit. Tracked Nexus helpers now admit reviewed batch sizes
  from one through four and reject duplicate download/native targets.
- Reject mismatched helper entrypoints, engines and reviewed package names,
  archive hashes or sizes before activation.
- Make failed source recovery retryable through a verified temporary checkout.
  Reject linked skill manifests, linked inventory outputs and invalid UTF-8 in
  maintained text; write the source inventory atomically.
- Allow `sync-provenance --package-root` for a verified package outside the runtime
  workspace without relaxing bundle, license, source or receipt checks.
- Add guarded retirement of exact obsolete Rusty-hook templates, preserving
  unknown hooks, configuration and recovery evidence.
- Bound HTTP audit waits and close server admission before test teardown.
  This repair changes the tests, not production request handling.
- Document native Vortex shutdown through owned hidden windows in agent guidance
  and MCP metadata, with process-identity checks and no force fallback.
- Remove the README banner and simplify setup, support and release wording.

### Dependencies and compatibility

- Update the local pnpm bootstrap from 9.15.0 to 10.34.9. The JavaScript dependency
  lockfile is unchanged; local verification invokes the selected tools directly.
- The optional standalone redscript CLI used for API-reference verification was
  updated locally from 0.5.31 to 0.5.32. It is not bundled in this source archive
  and does not replace installed SCC.
- The suite version is 0.4.0; the embedded adapter label remains 1.0.4. Installing
  a source release does not update an existing Vortex extension automatically.

### Verification and upgrading

- Follow [Get started](docs/GETTING-STARTED.md) to build from source. Preserve the
  existing runtime workspace, credentials and receipts when updating. Reconnect
  an existing MCP client to load changed client-side tools and descriptions.
- Exact production worker/coordinator components passed read-only probes inside
  Vortex 2.9.1. This does not establish generated-installer acceptance or an
  end-to-end installation speedup. The default `cached-sync` preparation stays
  unchanged; generic native installation and removal remain unavailable.
- 498 MCP/helper tests (including the separately retained pinned templates),
  54 Python recovery/cache/version tests and 33 installer tests passed locally,
  with no skipped tests. Source-integrity checks also passed.
  Tests, host activation, deployed-file verification and gameplay are separate
  evidence boundaries. No game is launched by these tools.

## 0.3.0 — 2026-10-29

This release adds tools for preparing installation scripts from tracked Nexus
downloads and fixes full mod-list reads when a mod has an empty version.
Changes since [0.2.0](https://github.com/Antrakt92/vortex-nexus-modding-mcp/compare/v0.2.0...v0.3.0).

### Added

- Prepare installation scripts for batches of up to four tracked Nexus mods.
  A published mod you maintain uses a separate one-mod batch.
- Prepare a read-only helper to collect the Vortex data needed by those scripts.
  Both tools support specific templates; the generated scripts need source,
  package and current-state checks before they can run.
- Setup and troubleshooting instructions, a documentation index, bug and feature
  request forms, a PR template and private vulnerability reporting.

### Fixed and changed

- Read the full mod list even when a mod's version is empty.
- Accept native mod IDs containing spaces, punctuation and Unicode. Download IDs
  keep their separate validation rules.
- Check installed files and their SHA-256 hashes while waiting for installation
  to finish. A delayed Vortex `modSize` value no longer causes a false timeout
  in newly prepared helpers.
- Reuse hashes for unchanged source files, including Vortex's `app.asar`.
  A changed file still stops the helper. The test covering ten repeated checks
  now performs one hash instead of ten; overall install time has not been measured.
- Preserve the captured Move Your Way settings rather than requiring the old
  two/two values. Remove an unused policy module from Nexus helper kits.
- Set `VERSION` to 0.3.0. Release 0.2.0 accidentally contained 0.1.0 in that file;
  a new test checks that the version and dated changelog entry agree.

### Dependencies and compatibility

- The adapter's package manifest and lockfile are unchanged from 0.2.0. This
  release adds helper and inventory behavior without another dependency upgrade.
- Existing supported helper templates remain the preparation boundary. Batch
  preparation does not add a general-purpose mod-installation API to the MCP.

### Testing and setup

- 271 MCP tests, 17 recovery/version tests and 28 installer tests passed.
  The maintainer's integration run also used local template fixtures that are
  not included in the download.
- After upgrading the Vortex extension, all 433 mod records could be read.
  File, hardlink, preference and operation-record comparisons passed.
  See [the test report](https://github.com/Antrakt92/vortex-nexus-modding-mcp/blob/v0.3.0/docs/AUDIT-20261029.md#subsequent-live-upgrade-and-acceptance--2026-10-29).
- Build the extension from source using [Get started](https://github.com/Antrakt92/vortex-nexus-modding-mcp/blob/main/docs/GETTING-STARTED.md).
  The MCP itself does not install mod archives. Existing installation scripts
  and operation records must be checked before retrying a failed operation.

## 0.2.0 — 2026-10-29

Reusable native-helper preparation, clearer installation diagnostics and an
updated development toolchain. This source release includes all changes since
[0.1.0](https://github.com/Antrakt92/vortex-nexus-modding-mcp/compare/v0.1.0...v0.2.0).
The embedded Vortex adapter label remains 1.0.4.

### Added

- **Offline native-helper preparation:** `prepare-native-helper.mjs` produces a
  held code kit for the reviewed single-package Cyberpunk template. Dry-run is
  the default; preparation does not approve or activate installation.
- **Complete module verification:** exact source/module hashes, a kit manifest
  and a final `verify DIR --materialization` gate detect missing dependencies,
  stale pins and incomplete or incorrect copy maps before native effects.
- **Physical proof counters:** report hash calls, cache hits and logical bytes
  hashed so subsequent installation investigations have concrete measurements.

### Improved

- Integrate the maintained settlement/import observers into newly prepared
  helpers instead of copying the legacy whole-record settlement observer.
- Reuse a physical hash across hardlink aliases only while the checked file
  generation matches; check file metadata again after hashing and bound the cache.
- Hash `app.asar` once through the retained source-pin loop instead of twice in
  the supported helper template.
- Report separate guard/read/sleep timing, waiting predicates and the last
  operation when installation settlement fails or reaches its deadline.

### Fixed

- Reject local-archive readiness when nested custom, repository or collection
  metadata contains a Nexus identity, including alternate ID names and containers.
- Stop the download regression suite from mistaking slow receipt fsync for a
  guard failure: replace its 150ms watchdog with a bounded test-runner timeout.
  Production timeouts and failure/interlock assertions are unchanged.
- Make lint/format checks inspect explicit reviewed files even when an isolated
  build sits below an ignored `local-state/` directory. Empty inventories fail;
  invalid-source and formatting probes confirm that files are actually checked.

### Dependencies

| Development dependency | Previous resolved version | New version |
| --- | --- | --- |
| TypeScript | 5.9.3 | 7.0.2 |
| Vite | 7.3.7 | 8.3.5 |
| oxfmt | 0.65.0 | 0.75.0 |
| oxlint | 1.80.0 | 1.90.0 |
| Node declarations | 22.20.1 | 24.19.2 |
| Tinypool override | 2.1.2 | 2.2.0 |

- Keep Redux 4.2.1 to satisfy Vortex API 2.9.1's exact peer requirement; use Node
  24 declarations for the selected Node 24 build/runtime major.
- Production MCP/Zod/HTTP dependencies and their resolved closure are unchanged.
- Retain original upstream attribution/licenses and refresh accepted source pins,
  the dependency lockfile and the recovery manifest.

### Documentation and maintenance

- Expand README and CONTRIBUTING with current workflows, local verification,
  source-inventory updates, branch lifecycle and release guidance.
- Document native-helper preparation, fresh binding and activation boundaries;
  attempted/completed helpers and uncertain-operation receipts stay frozen.
- List all seven published Cyberpunk mods and the Past the Night collection.
- Enable weekly Dependabot version proposals, group minor/patch updates and
  retain pending proposals for review. Record compatibility decisions for the
  earlier dependency PRs; completed branches are removed after integration.

### Verification and current limits

- **442 local tests passed:** 252 maintained adapter/client/package/wire tests,
  146 upstream/adapted safety tests, 16 recovery/bootstrap tests and 28 synthetic
  installer tests. Frozen-lockfile installation, typecheck, lint, formatting,
  builds and source-integrity checks passed.
- Registry audits on 29 October reported **zero known advisories** across
  7 production / 219 total entries. Lint retains one test-helper scoping warning;
  Vite retains its future native-config-loader warning. Neither is suppressed.
- The permanent MCP still refuses native installation/replacement. Reviewed
  helpers require fresh package, baseline, context and effect approval.
- Full native guard/poller costs and synchronous Windows process enumeration
  remain follow-ups. Real-install duration with this kit has not been measured.
- The known `OPERATIONAL_VALUE_NOT_CURATED` full-inventory limitation remains.
- Publishing this source release does not install or activate a Vortex package,
  restart Vortex, reconnect clients or establish gameplay acceptance.

See [helper preparation](docs/NATIVE-HELPER-PREPARATION.md),
[dependency verification](docs/DEPENDENCY-AUDIT.md#29-october-toolchain-refresh)
and [maintenance decisions](docs/MAINTENANCE.md) for detailed scope and evidence.

## 0.1.0 — 2026-10-29

First versioned source release. The earlier `recovery-sources-20261025` tag remains
the immutable host for upstream recovery bundles. The full change range since
that snapshot includes new capabilities and fixes, so this starts the suite's
SemVer series at 0.1.0. The embedded adapter label remains independently 1.0.4.

### Added

- Combined `inspect_session` MCP/CLI inspection, with optional conflicts and
  collection diagnostics, bounded concurrent reads and explicit partial coverage.
- `find_collection_downloads` for up to 100 exact Nexus mod/file pairs and compact
  tracked candidates, including duplicates and unknown identity counts.
- `run_mod_plan` through MCP and the session CLI: offline validation, pinned
  download-only steps, batched enable/disable changes and one optional final deploy.
- Reusable local-import and install-settlement observers for reviewed native helpers,
  with exact record/flag expectations and specific waiting diagnostics.
- Updated onboarding, workflow guides, audit records and links to maintained Nexus mods.

### Improved

- Overlap independent inspection/receipt reads while keeping changes serial.
- Reuse the game catalog within a synchronous inventory scan.
- Preserve stable request IDs, reconcile receipts and stop later plan steps on
  cancellation or connection closure after an invoked action settles.
- Keep legacy entrypoints bound to the existing runtime workspace and preserve
  credentials/receipts during supported maintenance and recovery.

### Fixed

- Invalid RPC IDs reaching direct dispatch; cancellation delayed at active queue capacity.
- Malformed diagnostics and contradictory structured/text responses accepted as valid.
- Archive checks returning success after record/file changes during hashing or receipt fsync.
- Import readiness using stale record identity after its final awaited guard,
  mutable expectations across awaits and synchronous guards overrunning deadlines.
- Settlement timers reset by unrelated catalog metadata.
- Empty recovery manifests and truncated native-preservation snapshots accepted as verified.
- Earlier integration, installer, source-recovery and publication-ledger defects documented
  in the [25 October audit](docs/FULL-AUDIT-20261025.md).

### Dependencies

Changes from the earlier `recovery-sources-20261025` snapshot:

| Dependency | Recovery snapshot | 0.1.0 | Scope |
| --- | --- | --- | --- |
| Hono | 4.13.13 | 4.13.14 | HTTP dependency override |
| `@hono/node-server` | 1.19.17 | 2.1.5 | Node HTTP transport override |
| `@nexusmods/vortex-api` | 2.9.0 | 2.9.1 | Build-time Vortex API declarations |

MCP server 2.4.0, MCP Node transport 2.1.2 and Zod 4.6.7 were already present in
the recovery snapshot. The declaration update does not install or upgrade the
Vortex application. See the [dependency audit](docs/DEPENDENCY-AUDIT.md) for the
earlier upstream-to-recovery changes, attribution and compatibility checks.

### Verification

- Latest full audit: 509 local tests, isolated package/wire proof, upstream
  typecheck/lint/format/build and source-integrity checks passed. Registry audits
  on 29 October 2026 reported zero known advisories across 7 production/168 total
  entries. These are dated audit results, not a current registry audit.
- See the [29 October audit](docs/FULL-AUDIT-20261029.md) for exact scope and evidence.

### Current limits

- The permanent adapter refuses native mod installation/replacement. Reviewed
  one-shot installation remains a separate workflow.
- One local DEV record still makes full mod inventory reads return
  `OPERATIONAL_VALUE_NOT_CURATED`; combined inspection reports `partial`.
- Repeated helper hashing and synchronous process enumeration remain performance work.
- Publishing this source release does not install the new adapter into Vortex,
  reconnect clients, prove deployed bytes or establish gameplay acceptance.

[Changes since the recovery snapshot](https://github.com/Antrakt92/vortex-nexus-modding-mcp/compare/recovery-sources-20261025...v0.1.0).

## Recovery sources — 2026-10-25

The `recovery-sources-20261025` release hosts immutable upstream Git bundles
referenced by `source-lock.json`, with exact sizes, hashes and source revisions.
It predates the suite's SemVer releases and is retained for restoring those
pinned sources. It is not a newer runtime or an alternative installation package.

The bundles contain committed source, without credentials, Vortex databases,
game files or mod downloads. See [source recovery](docs/RESTORE.md#2-recover-the-pinned-upstream-repositories).

## Downloads and upgrades

Versioned releases provide a source ZIP and `SHA256SUMS`. Verify the checksum and
follow [Get started](docs/GETTING-STARTED.md) or the full [restore guide](docs/RESTORE.md).
Preserve the existing runtime workspace, credentials and uncertain-operation
records when upgrading. Publishing a source release does not install an adapter,
restart Vortex or reconnect MCP clients. Native loading, deployed-file checks and
gameplay acceptance remain separate from source and model tests.
