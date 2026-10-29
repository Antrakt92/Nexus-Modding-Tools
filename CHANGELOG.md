# Changelog

## Unreleased

- Preserve empty native versions as unknown in inventory reads, rather than
  failing the complete mod list. Keep identifier, URI and credential checks.
- Add offline source-pinned preparation and copy-map verification for batches of
  up to four tracked Nexus originals, plus a separate published-own single batch.
  Prepare fresh read-capture code separately; neither path authorizes activation.
- Include required scope data and maintained flag/settlement checks; remove the
  unused private-overlay policy from Nexus kits and preserve fresh preference
  values instead of requiring historical Move Your Way settings of two/two.
- Accept bounded native mod IDs containing spaces, punctuation and Unicode in
  installation settlement. Keep download-ID validation separate and compare all
  identities exactly; paths, control characters and unsafe object keys are rejected.
- Document the separate review route for tracked Nexus batches. The automated
  single-own-package preparer remains scoped; historical helpers are not replayed.

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

### Dependencies and verification

- HTTP build pins: Hono 4.13.14 and `@hono/node-server` 2.1.5; Vortex declarations 2.9.1.
- Latest full audit: 509 local tests, isolated package/wire proof, upstream
  typecheck/lint/format/build and source-integrity checks passed. Registry audits
  reported zero known advisories across 7 production/168 total entries.
- See the [29 October audit](docs/FULL-AUDIT-20261029.md) for exact scope and evidence.

### Current limits

- The permanent adapter refuses native mod installation/replacement. Reviewed
  one-shot installation remains a separate workflow.
- One local DEV record still makes full mod inventory reads return
  `OPERATIONAL_VALUE_NOT_CURATED`; combined inspection reports `partial`.
- Repeated helper hashing and synchronous process enumeration remain performance work.
- Publishing this source release does not install the new adapter into Vortex,
  reconnect clients, prove deployed bytes or establish gameplay acceptance.
