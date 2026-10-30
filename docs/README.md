# Documentation

## Use the tools

- [Get started](GETTING-STARTED.md): requirements, installation, MCP connection and troubleshooting.
- [Build and recovery](RESTORE.md): pinned inputs, local credentials, packaging and installation.
- [Configuration](CONFIGURATION.md): workspaces, local stores and client settings.
- [Running-session workflows](NO-RESTART-WORKFLOW.md): inspection and reviewed download/enable/deploy plans.
- [Collection downloads](COLLECTION-DOWNLOADS.md): exact Nexus IDs and tracked-download reuse.
- [Collection releases](COLLECTION-RELEASES.md): early preflight, frozen candidates and separate publication/post-release boundaries.
- [Lifecycle performance](LIFECYCLE-PERFORMANCE.md): early update/removal diagnostics, measured verification improvements and remaining native workflow gates.
- [Support](../SUPPORT.md) and [contributing](../CONTRIBUTING.md).

## Component references

- [Vortex adapter](../tools/modding/vortex-agent/README.md).
- [Community Nexus CLI](../tools/modding/nexus-cli/README.md).
- [Publication runner](../tools/modding/nexus-publish/README.md).
- [Native helper preparation](NATIVE-HELPER-PREPARATION.md) and [tracked Nexus batches](TRACKED-NEXUS-HELPER-REVIEW.md): prepare installation scripts for the supported templates, then check their source, packages and current Vortex state.
- [Technical settings comparison](TECHNICAL-SETTINGS.md): source-bound handling of known discovery timestamp changes while retaining strict preference comparisons.
- [Agent workflow](AGENT-WORKFLOW.md), [licenses](LICENSES.md) and [maintenance](MAINTENANCE.md).

## Verification records

Each report lists what was checked and what still needs testing.

- [30 October tooling and performance audit](TOOLING-AUDIT-20261030.md).
- [29 October full source audit](FULL-AUDIT-20261029.md).
- [29 October follow-up and live upgrade](AUDIT-20261029.md).
- [Dependency pins and checks](DEPENDENCY-AUDIT.md).
- [25 October full audit](FULL-AUDIT-20261025.md) and [native integration evidence](AUDIT-20261025.md).

`recovery/accepted-adapter/` preserves a historical source snapshot. Build current
code from the maintained source. Runtime receipts, credentials and game/mod
payloads are excluded from the public repository.
