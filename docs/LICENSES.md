# Licenses and source provenance

The combined project and adapted Vortex component are distributed under
**GPL-3.0-only**, with the full license in [LICENSE](../LICENSE). They are not an
MIT-licensed replacement for the upstream Vortex MCP project.

| Component | Upstream | License and retained material |
| --- | --- | --- |
| Vortex MCP source and adapted component | [Alan Tse / vortex-mcp](https://github.com/alandtse/vortex-mcp) | GPL-3.0-only; [upstream license](../dependencies/vortex-mcp/LICENSE.md), source, accepted-file pins and local-change record |
| Prepared Vortex application source patches | [Nexus-Mods/Vortex, v2.9.1](https://github.com/Nexus-Mods/Vortex/tree/v2.9.1) | [Upstream GPL v3 license](https://github.com/Nexus-Mods/Vortex/blob/v2.9.1/LICENSE.md); exact commit, input, patch and output pins in each patch manifest; no application binary included |
| Official Nexus uploader | [Nexus-Mods/upload-action](https://github.com/Nexus-Mods/upload-action) | MIT; complete committed source recovered from the pinned bundle in `source-lock.json`, including its upstream license |
| Community Nexus CLI | [vadimtrifonov/nexusmods-cli](https://github.com/vadimtrifonov/nexusmods-cli) | MIT; exact source commit and executable asset pins retained; source bundle includes its upstream license |
| MCP core/server/Node runtime packages | Model Context Protocol maintainers | Apache-2.0; full terms and attribution retained in runtime notices |
| Hono, Node server adapter and Zod | Their respective maintainers | MIT; copyright and permission notices retained in runtime notices |
| pnpm build tool | pnpm contributors | MIT; bootstrap source, exact integrity and local-only use recorded in `PNPM-BOOTSTRAP.json` |

The adapter's runtime notices are in
[THIRD-PARTY-NOTICES.md](../dependencies/vortex-mcp/THIRD-PARTY-NOTICES.md).
Individual dependencies retain their own terms. Future distributed bundles must
carry the applicable licenses/notices as well as the adapter's GPL source offer;
installing dependencies locally does not relicense them.

`dependencies/vortex-mcp/UPSTREAM-PROVENANCE.json` identifies the original commit,
the accepted current files and deliberate changes. `LOCAL-CHANGES.md` explains
the dependency and implementation updates. The vendor README describes the
upstream project; its unrestricted tools are **not** the guarded adapter's API.

`source-lock.json` pins complete committed upstream recovery bundles. These
exclude local working-tree modifications, account state and credentials. The
root source manifest verifies the public project, while
`recovery/accepted-adapter/provenance.json` describes a historical native-tested
adapter source snapshot. These records serve different purposes.

No Nexus/Vortex application binaries, game files, third-party mod archives or
private instruction collection are included in the Git source tree. The project
does not grant rights to those separate products. This community tooling is not
an official Nexus Mods or Vortex release.
