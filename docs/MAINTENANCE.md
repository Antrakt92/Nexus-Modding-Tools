# Maintenance and next release

## Branches and dependency proposals

`main` is the integration and resting branch. Review work on short-lived branches
and remove them after completion. Routine Dependabot version PRs are paused with
`open-pull-requests-limit: 0`; security updates have a separate limit, so a security
PR may still create a branch. This does not enable or disable repository security
settings. See [GitHub's option reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#open-pull-requests-limit).

The following version proposals were reviewed for repository cleanup on
29 October 2026 and deferred, not merged. Their package and lockfile diffs remain
available in the closed PRs. No dependency version was changed by this cleanup.

| Proposal | Decision and required follow-up |
| --- | --- |
| [#11](https://github.com/Antrakt92/Nexus-Modding-Tools/pull/11): oxfmt 0.65.0 to 0.74.0, oxlint 1.80.0 to 1.89.0 | Development-tool update; review formatter/linter behavior, native binding packages and resulting source changes in an isolated build. |
| [#12](https://github.com/Antrakt92/Nexus-Modding-Tools/pull/12): Redux 4.2.1 to 5.0.1 | Major update to the declaration/build dependency tree; check the Vortex API peer contract and type compatibility before adoption. |
| [#13](https://github.com/Antrakt92/Nexus-Modding-Tools/pull/13): Vite 7.3.7 to 8.3.5 | Major build-tool update with substantial lockfile churn; validate bundler/test compatibility rather than merging it as housekeeping. |
| [#14](https://github.com/Antrakt92/Nexus-Modding-Tools/pull/14): Node declarations 22.20.1 to 26.6.5 | Reconcile declared APIs with supported host/runtime versions; newer declarations alone do not provide newer runtime APIs. |

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
