# Agent workflow and skill routes

This repository owns the maintained tooling. Installed extensions, runtime
workspaces, source checkouts and private workflow backups have different roles.
Read the active checkout's instructions and check Git status before edits.
For an existing installation, preserve its runtime workspace, credentials,
receipts and unresolved-operation state when changing source entrypoints.

## Choose the task route

Use the matching installed skill when available. These names refer to workflow
skills, not extra authority or packages that must be installed to read this repo.
Without a matching skill, follow the linked maintained documentation and report
missing capabilities rather than inventing another implementation.

| Requested work | Skill | Maintained route |
| --- | --- | --- |
| Read Vortex profiles, mods, downloads, conflicts or dialogs | `vortex-nexus-api-audit` | Native curated MCP tools; bridge fallback; [adapter](../tools/modding/vortex-agent/README.md) |
| Prepare an installed mod update or cleanup | `vortex-nexus-api-audit` | [Lifecycle preflight](LIFECYCLE-PERFORMANCE.md): one bounded `read_mod_lifecycle` snapshot for exact installed IDs, all-profile usage, native requires matches and global archive references; metadata only |
| Find tracked archives for collection members | `vortex-nexus-api-audit`, then `vortex-mod-lifecycle` for effects | [Batch download lookup](COLLECTION-DOWNLOADS.md); exact Nexus pairs, compact candidates, no archive-integrity claim |
| Authorized download-only, enable or deploy | `vortex-mod-lifecycle` | Guarded adapter, stable request IDs, [reviewed plans](NO-RESTART-WORKFLOW.md) |
| Coordinate downloads or installed-mod activation | `vortex-mod-lifecycle` | `run_mod_plan` MCP / session CLI; batch exact installed IDs, one final deploy, reconcile before recovery; native installation remains a separate stage |
| Prepare a task-owned native install helper | `vortex-mod-lifecycle` | [Maintained code kit](NATIVE-HELPER-PREPARATION.md); offline preparation and code-contract verification before fresh binding/activation; completed helpers stay frozen |
| Bind one own-local package to the supported reviewed family | `vortex-mod-lifecycle` | [Offline binder](OWN-LOCAL-BINDER.md); exact archive/source/build pins, new inert output and separate native admission |
| Public Nexus search, metadata or requirements | `nexus-research` | [CLI wrapper](../tools/modding/nexus-cli/README.md); inspect JSON status/errors/pagination |
| Nexus upload preparation or authorized publication | `nexus-publication` | [Guarded publisher](../tools/modding/nexus-publish/README.md); offline by default |
| Release a collection revision | `nexus-collection-release`, `nexus-publication` | [Collection workflow](COLLECTION-RELEASES.md); owning collection's frozen plan and guard, early preflight, separate publication and post-release work |
| Original game-mod implementation | `nexus-mod-workflow`, then the matching engine skill | Follow the owning mod project's source/provenance handoff; this tools repo is not mod source |
| Build or restore the tools | `project-intake`, `verification-matrix` | [Restore](RESTORE.md), [configuration](CONFIGURATION.md), source/package pins and local checks |
| Dependency changes or a new tool | `dependency-gate` | Reuse verified inputs; review identity, lock impact and relevant local checks before installation |

For Cyberpunk implementation, the engine skill is `redengine-mod-development`.
Its installed-mod counterpart is `cyberpunk-mod-audit`. A project's clean-room
contract takes precedence over ordinary archive/source inspection; permission
to query metadata never authorizes restricted implementation sources.

## Preserve the requested boundary

- An audit or inspection stays read-only unless the user also requests repairs.
  Existing user delegation can authorize normal in-scope publication; explicit
  task limits, acceptance gates and artifact pins still control.
- Supported resident reads and managed operations reuse running Vortex. Do not
  restart the host, add a one-shot or manipulate its window for ordinary reads.
- Native package installation is deliberately absent from the public adapter.
  Do not add unrestricted dispatch or treat a different archive name as proof
  that Vortex cannot silently replace an existing mod.
- Start managed effects with fresh health/context/filesystem pins. A version
  label alone does not identify a loaded bundle. Host version, package SHA,
  client loading and model availability are separate observations.
- A lost response, attempt without completion or uncertain publication requires
  reconciliation of the original request/ledger. New IDs, another workspace or
  another client do not repair uncertainty. Never clear a marker just to retry.
- No game launch, credential export, profile switching, public message or upload
  is implied by tool availability. Never expose a bearer, account state or signed
  URL. Do not install dependencies merely to read documentation or lint a skill.

## Verify and hand off

Use the repository's local tests for changed paths and broader affected contracts.
Keep modeled tests, source integrity, native host loading, deployment byte/owner/
hardlink proof and gameplay acceptance separate. A fulfilled callback or
`diskDeploymentVerified:false` cannot establish disk deployment.

When delegation is authorized, give writers exclusive files and provide the
selected skill, owning checkout, runtime identity, allowed effects and acceptance
boundary. Have another agent resolve realistic scenarios using the final skill;
review the outcome instead of treating an agent's approval as evidence.

Keep current reports, source/compile/package proof, operation receipts and unique
rollback inputs. Cleanup needs exact targets and verified keepers/reconstruction
inputs; preserve history and unrelated work. Client/MCP reload, host restart and
source edits are distinct operations. Document an unavailable check honestly.
