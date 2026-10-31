# Documentation

## Use the tools

- [Get started](GETTING-STARTED.md): requirements, installation, MCP connection and troubleshooting.
- [Build and recovery](RESTORE.md): pinned inputs, local credentials, packaging and installation.
- [Configuration](CONFIGURATION.md): workspaces, local stores and client settings.
- [Running-session workflows](NO-RESTART-WORKFLOW.md): inspection and reviewed download/enable/deploy plans.
- [Authorized restart](AUTHORIZED-RESTART.md): native close for hidden Vortex windows, verified exit and maintenance readback.
- [Collection downloads](COLLECTION-DOWNLOADS.md): exact Nexus IDs and tracked-download reuse.
- [Collection releases](COLLECTION-RELEASES.md): early preflight, frozen candidates and separate publication/post-release boundaries.
- [Local cleanup](LOCAL-CLEANUP.md): post-release scratch retirement, required-input protection and bounded scheduled maintenance through Recycle Bin.
- [Lifecycle performance](LIFECYCLE-PERFORMANCE.md): early update/removal diagnostics, measured verification improvements and remaining native workflow gates.
- [Support](../SUPPORT.md) and [contributing](../CONTRIBUTING.md).

## Component references

- [Vortex adapter](../tools/modding/vortex-agent/README.md).
- [Community Nexus CLI](../tools/modding/nexus-cli/README.md).
- [Publication runner](../tools/modding/nexus-publish/README.md).
- [Pristine API cache](PRISTINE-API-CACHE.md): read-only status, exact reference pins and explicit generation.
- [Legacy Git hooks](LEGACY-GIT-HOOKS.md): retire the exact obsolete templates while preserving backups and unrelated hooks.
- [Native helper preparation](NATIVE-HELPER-PREPARATION.md) and [tracked Nexus batches](TRACKED-NEXUS-HELPER-REVIEW.md): prepare installation scripts for the supported templates, then check their source, packages and current Vortex state.
- [Own-local binder](OWN-LOCAL-BINDER.md): bind the supported reviewed template to one package without inheriting live approvals.
- [Native lifecycle gates](NATIVE-LIFECYCLE-GATES.md): offline install preflight and source-reviewed replacement/removal limits.
- [Keeper and retention](KEEPER-RETENTION.md): pinned consumer catalogs, retained copies and isolated restore without deletion.
- [File-proof worker](FILE-PROOF-WORKER.md): standalone foundation; native guard integration is pending.
- [Technical settings comparison](TECHNICAL-SETTINGS.md): source-bound handling of known discovery timestamp changes while retaining strict preference comparisons.
- [Agent workflow](AGENT-WORKFLOW.md), [licenses](LICENSES.md) and [maintenance](MAINTENANCE.md).

## Verification records

Each report lists what was checked and what still needs testing.

- [30 October tooling and performance audit](TOOLING-AUDIT-20261030.md).
- [Lifecycle implementation](LIFECYCLE-IMPLEMENTATION.md): verified stages and remaining native/provenance gates.
- [Local installation continuation](LOCAL-INSTALL-IMPLEMENTATION.md): bounded job model, native ownership/terminal prerequisites and separate new-ZIP contracts.
- [Prepared callback patch](NATIVE-CALLBACK-PATCH.md): one-shot completion, synchronous event ordering and exact tracking cleanup; source tests only.
- [Prepared activity patch](NATIVE-ACTIVITY-PATCH.md): separate per-invocation core-tail observations and joined error cleanup; native acceptance pending.
- [Next native dispatch contract](NATIVE-DISPATCH-CONTRACT.md): fixed new-disabled entrypoint, preallocated job ID, one-shot consumption and uncertain-result recovery; not implemented.
- [Process guard native experiment](PROCESS-PROBE-EXPERIMENT.md): bounded PowerShell baseline and independent process-only contract before any Rust backend integration.
- [29 October full source audit](FULL-AUDIT-20261029.md).
- [29 October follow-up and live upgrade](AUDIT-20261029.md).
- [Dependency pins and checks](DEPENDENCY-AUDIT.md).
- [25 October full audit](FULL-AUDIT-20261025.md) and [native integration evidence](AUDIT-20261025.md).

`recovery/accepted-adapter/` preserves a historical source snapshot. Build current
code from the maintained source. Runtime receipts, credentials and game/mod
payloads are excluded from the public repository.
