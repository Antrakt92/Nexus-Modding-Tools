# Maintenance and next release

## Branches and dependency proposals

`main` is the integration and resting branch. Review work on short-lived branches
and remove completed branches. Pending dependency proposals are legitimate work:
do not close them merely to reduce the branch count. Dependabot checks weekly,
keeps up to five version PRs open and groups minor/patch updates. Security updates
have their own limit. The earlier zero limit was reversed because version
notifications are required; no repository security setting was disabled.

The four earlier PRs remain closed with their original diffs retained. The
29 October dependency refresh applies newer compatible versions directly:

| Earlier proposal | Current decision |
| --- | --- |
| [#11](https://github.com/Antrakt92/Nexus-Modding-Tools/pull/11): oxfmt 0.74.0 / oxlint 1.89.0 | Superseded by tested oxfmt 0.75.0 / oxlint 1.90.0. |
| [#12](https://github.com/Antrakt92/Nexus-Modding-Tools/pull/12): Redux 5.0.1 | Not adopted: Vortex API 2.9.1 declares the exact peer Redux 4.2.1. Keep that contract until the host API supports a migration. |
| [#13](https://github.com/Antrakt92/Nexus-Modding-Tools/pull/13): Vite 8.3.5 | Adopted with typecheck, test, lint, format and build verification. |
| [#14](https://github.com/Antrakt92/Nexus-Modding-Tools/pull/14): Node declarations 26.6.5 | Use current Node 24 declarations 24.19.2 for the Node 24 build/runtime; newer API declarations do not upgrade the runtime. |

TypeScript advances from 5.9.3 to 7.0.2. Tinypool advances from 2.1.2 to 2.2.0,
matching the formatter's current direct requirement. Production MCP, Zod and HTTP
packages were already current in the registry check and remain unchanged.
See [the dependency audit](DEPENDENCY-AUDIT.md#29-october-toolchain-refresh) for
verification and limitations.

Before adopting any proposal, recheck current registry/advisory evidence, inspect
the complete lock diff, and run the dependency audit's typecheck, lint, formatting,
tests, build and registry audits. Update accepted upstream-file/provenance pins
and the root recovery manifest; then run guarded-adapter package/wire checks.
Native host acceptance remains separate and must use a coordinated window.
The [dependency audit](DEPENDENCY-AUDIT.md) is dated evidence, not a current
security clearance for either the existing or proposed versions.

## Changes since 0.1.0

The baseline is immutable tag `v0.1.0` at
`2822e326675f44b09146e77bb69449d2154b5082`. Review the complete range with
`git log v0.1.0..main` and `git diff v0.1.0..main`.

- New offline native-helper preparation and verification for the supported held
  single-package Cyberpunk template, including exact final copy-map checks.
- Maintained settlement observer integration with guard/read/sleep timing and
  explicit waiting predicates, replacing the legacy whole-record quiet check.
- Generation-checked hash reuse across hardlink aliases and removal of the
  supported template's duplicate `app.asar` hash, with proof counters.
- Rejection of nested Nexus identities during local-archive readiness checks.
- More reliable receipt-I/O tests, expanded README/contributor guidance, the full
  published Cyberpunk project list and dependency/branch housekeeping.

These include a new user capability, so the next ordinary SemVer release is
**0.2.0**, subject to checking that the version remains unused at publication.
There is no identified incompatible public API/schema migration in this range.
This assessment does not create a tag, rename historical artifacts or publish a
release. The embedded adapter's 1.0.4 label is independent.

## Release readiness

The helper workflow has focused regressions, a generated actual-template test
run and independent forward/copy-map checks; exact evidence and limitations are
in [the preparation guide](NATIVE-HELPER-PREPARATION.md). Before packaging, verify
the final merged source inventory, rerun affected checks if content changed,
build an archive from the selected immutable commit and verify the uploaded
archive/checksums independently. Review licenses and source-lock inclusion.

A source release can deliver the new offline workflow without activating it in
Vortex. Real-install duration has not been measured with this kit, full native
guard/poller costs remain, and the known full-inventory read limitation is still
recorded in the audit. Do not advertise a proven installation speedup or a fixed
live inventory read. No new native install, restart or game launch is a release
side effect.
