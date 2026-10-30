# Changelog

Source-release history for [Nexus Modding Tools](https://github.com/Antrakt92/Nexus-Modding-Tools).
Dates are the original GitHub publication dates, in UTC. Each section describes
the code and verification available at that version; historical limitations are
not a statement about the latest release. The suite version is separate from the
embedded Vortex adapter's 1.0.4 label.

| Version | Published | Main changes |
| --- | --- | --- |
| [0.3.0](https://github.com/Antrakt92/Nexus-Modding-Tools/releases/tag/v0.3.0) | 2026-10-29 | Tracked Nexus batch helpers, inventory repair, payload checks and setup guides |
| [0.2.0](https://github.com/Antrakt92/Nexus-Modding-Tools/releases/tag/v0.2.0) | 2026-10-29 | Offline helper preparation, installation diagnostics and development dependencies |
| [0.1.0](https://github.com/Antrakt92/Nexus-Modding-Tools/releases/tag/v0.1.0) | 2026-10-29 | Combined inspection, collection download reuse and coordinated plans |
| [Recovery sources](https://github.com/Antrakt92/Nexus-Modding-Tools/releases/tag/recovery-sources-20261025) | 2026-10-25 | Pinned upstream Git bundles for source recovery |

## Unreleased

Fixes made on 30 October 2026:

- Allow reviewed installer and capture configurations up to 8 MiB, including
  copy-map verification. Large protected-file inventories could exceed the old
  1 MiB limit. Source modules and other kit inputs retain their 1 MiB limit.
- Fix generated tracked Nexus installers rejecting one-, three- and four-mod
  batches because startup still required exactly two packages. Baseline checks
  now use the reviewed batch size and reject duplicate downloads and native
  targets through the same scope policy as the reviewed plan.
- Add a regression that executes the generated baseline admission code for
  batch sizes one through four, including missing, extra and changed packages.

Documentation changes since 0.3.0, made on 29 October 2026:

- Remove the README banner and simplify setup, support and release wording.
- Center the project title, navigation and badges in the README.
- Add the dated release index, exact initial dependency updates and clearer
  release boundaries to this changelog; align the GitHub release descriptions.

These changes do not replace the source archives already published for 0.3.0.

## 0.3.0 — 2026-10-29

This release adds tools for preparing installation scripts from tracked Nexus
downloads and fixes full mod-list reads when a mod has an empty version.
Changes since [0.2.0](https://github.com/Antrakt92/Nexus-Modding-Tools/compare/v0.2.0...v0.3.0).

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
  See [the test report](https://github.com/Antrakt92/Nexus-Modding-Tools/blob/v0.3.0/docs/AUDIT-20261029.md#subsequent-live-upgrade-and-acceptance--2026-10-29).
- Build the extension from source using [Get started](https://github.com/Antrakt92/Nexus-Modding-Tools/blob/main/docs/GETTING-STARTED.md).
  The MCP itself does not install mod archives. Existing installation scripts
  and operation records must be checked before retrying a failed operation.

## 0.2.0 — 2026-10-29

Reusable native-helper preparation, clearer installation diagnostics and an
updated development toolchain. This source release includes all changes since
[0.1.0](https://github.com/Antrakt92/Nexus-Modding-Tools/compare/v0.1.0...v0.2.0).
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

[Changes since the recovery snapshot](https://github.com/Antrakt92/Nexus-Modding-Tools/compare/recovery-sources-20261025...v0.1.0).

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
