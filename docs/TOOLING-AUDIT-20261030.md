# Tooling and performance audit — 30 October 2026

This pass covered the local package-manager bootstrap, MCP bridge and session
workflow, native helper preparation, source recovery, manifest generation and
publication runner. Three agents reviewed separate areas; a second pass reviewed
the fixes and realistic failure paths. All effects were isolated or mocked.

## Repairs

| Area | Confirmed problem | Change |
| --- | --- | --- |
| Build tool | pnpm 9 is unsupported and matches known advisories | Pin pnpm 10.34.9; verify its registry signature, archive hash and inventory |
| Build command | Nested `pnpm` calls selected a global executable | Invoke the local compiler, checks, tests and bundler directly |
| Bootstrap | Version, registry URLs and destination could disagree | Reject inconsistent metadata before network access or writes |
| MCP stream | Each chunk rescanned the entire growing event; CR-only lines failed | Parse new chunks incrementally, retaining strict UTF-8 and response bounds |
| Native helper | Retargeted entry/config could retain an old engine package guard | Check the actual entrypoint, engine and configuration package pins before preparation and after binding |
| Source recovery | A failed Git fetch/checkout left the final path occupied | Verify a temporary checkout before renaming it to the destination |
| Skill recovery | A linked snapshot manifest was followed | Reject reparse paths before reading the manifest |
| Source manifest | Linked output could overwrite an unrelated file; writes were non-atomic | Reject linked paths and replace the manifest only after a complete flushed temporary write |

Existing tracked Nexus batch-size and large-configuration repairs remain in the
unreleased change set; they were made before this pass.

## Performance evidence

The bridge benchmark used the same successful JSON-RPC result in an in-memory
SSE response: 2,097,205 bytes, 512-byte chunks, Node 24.20.0, one warmup and five
sequential samples per version. It used a synthetic credential and no network.
Medians were **1,065.7 ms before / 5.60 ms after**. The regression checks the large
decoded payload, split Unicode, CR/LF/CRLF boundaries and invalid input. A second
review checked 68 additional two-chunk boundaries and reader cancellation.

The single-helper verifier reuses bytes already read for its scope checks:
36 to 35 reads, 146,562 to 135,958 bytes on the same inert real template. Nine
alternating samples after two warmups had medians of 10.395 and 10.142 ms.
This is an I/O reduction, not evidence of a meaningful install-time improvement.

Neither benchmark measures Vortex installation, archive extraction, deployment,
host restart or game startup. Context, receipt, filesystem and payload checks
were retained. No cache was added to skip freshness checks.

## Verification

- 289 maintained Node tests, including the compiled adapter package and wire
  checks and both real pinned tracked-template fixtures: passed, no skips.
- 144 upstream tests, typecheck, lint, formatting and build: passed. The existing
  test-helper lint warning and future Vite configuration warning remain visible.
- 21 recovery/bootstrap/metadata tests and 28 synthetic installer tests: passed.
- Publication runner: 45 Python and 20 Node tests passed with its pinned official
  action checkout, mock network and synthetic keys. No new defect was confirmed.
- The dependency lockfile is byte-identical; registry audits reported zero known
  advisories across 7 production / 219 total entries at the time of this pass.
- Regressions reproduced the repaired failures before the fixes. The actual
  Family helper template also passed inert preparation and package admission.

The new build and package are local verification artifacts. They have not replaced
the running Vortex extension. Client bridge changes apply to new processes;
already running MCP clients need a reload to use them. Native installation and
safe removal remain separately reviewed operations; no new endpoint was added.
No game launch, native helper activation, live mod change, hosted CI run or
public mod/collection upload was performed.
