# Local dependency changes

Based on Alan Tse's GPL-3.0-only source at
`d10277b8858ad6d411765aa93131219f4a24533e`. Original source hashes and accepted
local hashes are recorded in `UPSTREAM-PROVENANCE.json`.

The guarded adapter builds from this source dependency. Its maintained entry
point remains `tools/modding/vortex-agent/extension.cjs`; the unrestricted upstream
extension is not the installed product.

- Runtime dependencies are pinned to MCP server/core 2.4.0, MCP Node transport
  2.1.2 and Zod 4.6.7. Hono 4.13.13 is a compatible transitive override because
  the previous lock retained a vulnerable older version.
- Vitest 5.0.5, Vite 7.3.7 and tsup 9.0.0 replace development versions with known
  advisories. The Vortex API declarations now match host 2.9.0. Tinypool 2.1.2 is
  a compatible patch override for the formatter's worker dependency.
- The vendored upstream HTTP server now creates a separate MCP server for each
  request, alongside its transport. The patched SDK rejected the old shared
  server with `ALREADY_CONNECTED`; nine existing tests failed before this repair
  and all 144 pass afterward. No test expectations were relaxed.
- `.npmrc` contains only `auto-install-peers=false`. The Vortex API package is an
  external host interface used for declarations here; installing its unrelated
  React/UI/legacy UUID peer tree in this isolated build is unnecessary. Type
  checks, all tests and builds pass without it. The missing host-peer warnings
  remain visible. Runtime MCP/Zod/Hono dependencies are installed normally;
  the real Vortex application supplies its own API and host libraries.
- Build tools require Node 24.11 or later in the 24.x line, or Node 26+. The
  plugin's compilation target remains Node 20; runtime SDK packages declare
  Node 20+. Native host verification remains separate from these build checks.
- pnpm 9.15.0 is bootstrapped locally using the official tarball and verified
  SHA-512 metadata in `PNPM-BOOTSTRAP.json`. Its files, node_modules, build outputs
  and audit logs remain ignored. Package install scripts are disabled.

`LICENSE.md` preserves GPL-3.0-only for the upstream work. Runtime dependency
licenses are retained in `THIRD-PARTY-NOTICES.md`, including the newer MCP
packages' Apache-2.0 terms. This tree is not relicensed as MIT.
