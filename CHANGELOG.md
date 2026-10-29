# Changelog

## Unreleased

- Prepare and verify new inactive native helpers with the maintained code kit,
  rather than copying the legacy settlement observer into another operation.
- Reuse physical hashes across hardlink aliases with checked file generations;
  remove the supported template's duplicate `app.asar` hash and report proof counters.
- Record separate guard/read/sleep timing and the last operation on settlement failure.
- Reject nested custom/repository/collection Nexus identities in local import readiness.

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
