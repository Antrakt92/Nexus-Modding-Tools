# Full integration audit — 25 October 2026

The audit covered maintained Vortex adapter/bridge code, operation receipts,
concurrency, installer/build/recovery tools, the Nexus CLI wrapper/installer,
publication runner and transport, client diagnostics, dependency checks and
documentation. Three agents reviewed separate areas; the primary reviewed the
changes, publication paths and native verification. Confirmed defects were
reproduced with regressions before correction. No dependency version changed.

## Confirmed findings and repairs

| Area | Reproduced failure | Final behavior |
| --- | --- | --- |
| HTTP and stdio input | Invalid UTF-8 was silently replaced before parsing, changing request strings | Reject malformed input; accept valid Unicode across byte boundaries and recover at the next stdio line |
| Installer rollback | A concurrent foreign target could be moved during recovery; an interrupt after swapping skipped rollback | Track the staged directory's filesystem identity, preserve foreign directories, recover an interrupted owned swap |
| Metadata synchronization | Another runtime workspace or source drift during metadata staging could be accepted | Validate workspace and recheck source/provenance immediately before replacement |
| Build artifacts | Workspace junctions and adapted-source links redirected writes | Reject linked output ancestry, adapted input destinations and existing output/package trees before writes |
| Source recovery | Bundle names could escape the archive directory; an empty nested directory could inherit an enclosing Git repository's identity | Validate one safe bundle filename and the exact checkout root, commit and tracked state |
| Skill restore | A file occupying a later destination's parent caused failure after earlier writes | Detect non-directory ancestors during the complete preflight |
| Build-tool bootstrap | A relative destination could escape the vendor root | Validate the retained destination with the shared safe-path parser |
| CLI installation | Junctions or dangling links redirected extraction; late file/receipt conflicts left partial new files | Check ancestry and every existing output/receipt before writes; extract the exact in-memory bytes whose hash passed |
| Publication lifecycle | Interrupting invocation marked a potentially live uploader as stopped, permitting reconciliation | Retain the running/uncertain marker if invocation does not return; block reconciliation pending independent termination review |
| Publication ledger | Relative ledger paths selected different locks/receipts from different working directories | Require an absolute persistent ledger in dry-run, publication and reconciliation |
| Local tool entrypoints | Configured legacy bridge, publisher and CLI installer retained separate implementations and missed maintained fixes | Private forwarding shims preserve the original runtime/uploader defaults and load maintained code |

The formatter also found a layout mismatch in the local provenance metadata.
Only its JSON formatting was corrected; parsed values, source pins and package
versions remain unchanged. This repaired the existing formatting gate.

These are bounded correctness and preservation findings. The report does not
claim a formal security certification or proof that undiscovered defects do not
exist. No additional confirmed defect remained in the reviewed scope at closure.

## Local verification

| Check | Result |
| --- | --- |
| Adapter, bridge, session, process, path, package and wire tests | 134 passed |
| Synthetic installer tests | 28 passed |
| Recovery/bootstrap tests, including an actual offline Git-bundle roundtrip | 14 passed |
| CLI credential/portable-install tests | 12 passed |
| Publication Python tests | 45 passed |
| Publication transport Node tests | 20 passed |
| Pinned upstream tests | 144 passed |
| Local legacy-bridge forwarding tests | 3 passed |
| Local publisher/CLI entrypoint forwarding tests | 3 passed |
| Client discovery/inventory tests | 13 Node and 2 Python passed |
| Upstream typecheck, lint, formatting, build | Passed |
| Manual workflow contract | Passed; dispatch-only, dry-run default and durable ledger retained |
| Dependency registry audits | Zero reported findings across 7 production / 168 total entries at check time |
| Strict skill trees and native discovery | Passed twice in each of two workspaces |
| Native OpenCode MCP connection | Connected |

The suites contain 418 passing tests in total, with no skips in these runs.
The legacy publisher entrypoint also passed its existing 28-test compatibility
replay; that replay is not added to the primary total above.
Tests were run locally; no hosted workflow was dispatched and no package was
installed. Publication tests use the existing pinned upstream checkout selected
by `NEXUS_UPLOAD_ACTION_ROOT`; initial failures caused by the absent default
checkout were resolved by selecting that verified context, without changing tests.

Commands were the repository-documented `node --test` adapter/path/wire suites,
`python -B tools/modding/vortex-agent/install.test.py`, root and CLI/publication
`unittest discover` suites, the three publication transport suites, and
`check-workflow.mjs`. The existing pinned pnpm ran upstream `typecheck`, `lint`,
`format:check`, `test`, `build`, `audit --prod --json` and `audit --json`.

## Fresh native acceptance

An isolated Vortex 2.9 fixture loaded the exact compiled package with separate
user data, credentials, port, synthetic game directory and archive. It completed
native import/install, authenticated enable/deploy/disable/restore, then exited
cleanly. Independent post-shutdown verification confirmed manifest ownership,
hardlink identity, original-file hash and identity restoration, archive
size/SHA-256/CRC, four durable completions and absence of unresolved operations.
The ordinary Vortex process, health, profiles, mod inventory and deployment
manifest remained unchanged during that fixture.

The ordinary adapter was then upgraded through normal Vortex shutdown with
explicit old/new hashes and the original runtime workspace. The old bundle,
operation receipts and rollback evidence were retained. New bundle SHA-256:

`4d7862bad1f4faa5517edc97b51f0d6cd0f1a426f2ba9ddb28354aa33f8d4243`

Fresh authenticated malformed-input testing returned HTTP 400 from the loaded
HTTP parser. Health and all projected fields of 269 installed mods and 273
downloads matched before/after by ID. All 70 explicitly protected files,
including the deployment manifest, matched size and SHA-256. No dialogs or
external changes were pending. Existing DPAPI authentication still works.

## Limits and retained evidence

No real mod was installed, enabled, disabled or redeployed in the ordinary
profile. No game was launched, Nexus upload/download was performed or credential
changed. The isolated native fixture does not establish gameplay compatibility.
Real Nexus reuse was skipped because the synthetic archive has no legitimate
Nexus identity; none was fabricated.

Already running MCP processes retain their loaded bridge until client/MCP reload;
new processes and the direct bridge use maintained fixes immediately. Native
installation remains deliberately absent from the public adapter.

An abrupt OS/process kill still requires inspection of retained locks, receipts
and backup directories; there is no automatic stale-lock reset. Publication
interruptions conservatively require independent uploader termination evidence.
The optional upstream tool-document generator still expects an unauthenticated
server and is not an acceptance gate for the guarded endpoint. The personal
Python skill validator lacks PyYAML on this host; strict existing Node YAML/tree
checks and native discovery passed instead, without installing lint dependencies.

Detailed test logs, source/package pins, native receipts and before/after
snapshots remain local. Public source and this report contain no credentials,
Vortex database or game/mod payloads. Unique rollback inputs and the latest
native acceptance evidence are retained.
