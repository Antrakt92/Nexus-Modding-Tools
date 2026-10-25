# Dependency audit — 25 October 2026

This audit covers the source dependency used to build the guarded Vortex adapter.
It does not establish that every dependency in the installed Vortex application
is patched, or that the new adapter has passed native host acceptance.

## Source and changes

`dependencies/vortex-mcp` contains the tracked text source from Alan Tse's
GPL-3.0-only commit `d10277b8858ad6d411765aa93131219f4a24533e`, obtained with
`git archive`. It contains no upstream Git database, node_modules or generated
bundle. `UPSTREAM-PROVENANCE.json` records original and accepted current files.

| Component               | Previous lock                          | Current lock |
| ----------------------- | -------------------------------------- | ------------ |
| MCP server/core         | 2.0.0                                  | 2.4.0        |
| MCP Node transport      | 2.0.0                                  | 2.1.2        |
| Zod                     | 4.5.4                                  | 4.6.7        |
| Hono                    | 4.13.5                                 | 4.13.13      |
| Vortex API declarations | 2.6.2                                  | 2.9.0        |
| Vitest                  | 3.2.6                                  | 5.0.5        |
| Vite                    | 7.3.6                                  | 7.3.7        |
| tsup                    | 8.5.1                                  | 9.0.0        |
| Tinypool                | 2.1.0 in formatter, plus old test tree | 2.1.2        |

Official registry metadata and package identities/licenses were checked before
installation. The original MCP packages were MIT; the updated packages are
Apache-2.0. Their notices are retained separately from the upstream GPL license.
No global package install, global PATH change or install script was used.

The initial SDK upgrade exposed the upstream shared-server lifetime defect:
nine HTTP tests failed with `ALREADY_CONNECTED`. Giving each request its own
server and transport repaired the defect; the same 144 tests then passed.

The build's Vortex API package only supplies declarations. Automatic installation
of that package's UI/legacy UUID peer tree is disabled locally. This does not
replace Vortex's real runtime dependencies or suppress peer warnings. Typecheck,
tests and builds pass with the declared runtime packages and development tools;
the existing `skipLibCheck` setting was not weakened or changed.

## Verification

From `dependencies/vortex-mcp`, using Node 24.20.0 and the locally verified pnpm:

```powershell
node .tooling/pnpm-9.15.0/bin/pnpm.cjs install --ignore-scripts --frozen-lockfile --store-dir .tooling/pnpm-store
node .tooling/pnpm-9.15.0/bin/pnpm.cjs run typecheck
node .tooling/pnpm-9.15.0/bin/pnpm.cjs run test
node .tooling/pnpm-9.15.0/bin/pnpm.cjs run lint
node .tooling/pnpm-9.15.0/bin/pnpm.cjs run format:check
node .tooling/pnpm-9.15.0/bin/pnpm.cjs run build
node .tooling/pnpm-9.15.0/bin/pnpm.cjs audit --prod --json
node .tooling/pnpm-9.15.0/bin/pnpm.cjs audit --json
```

The final production audit reports **zero findings** across seven dependency
entries. The full audit reports **zero findings** across 168 entries. These are
point-in-time registry results, not a guarantee against unknown vulnerabilities.
Raw JSON and command logs remain local under the ignored `.tooling/` directory.
All 144 upstream tests, typecheck, lint, formatting and build must remain green.
The maintained guarded adapter's own tests and native fixture are separate gates.

The optional upstream `docs:tools:check` generator is blocked by the existing
guarded adapter's HTTP 401 response. That generator expects the unrestricted
upstream server in unauthenticated mode. Authentication was not disabled and no
live adapter configuration was changed to satisfy that unrelated documentation
generator. It is not part of the upstream five-command `ci` script.

The installed Vortex 2.9.0 application manifest records Electron 44.2.0; the
official Electron release maps that to Node 24.20.0. This satisfies the SDK's
Node 20+ minimum. Native execution must still confirm the actual host behavior.
[Electron 44.2.0 release](https://releases.electronjs.org/release/v44.2.0)

## Advisory provenance

- [MCP server connection isolation](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-jm63-cq47-j5jp)
- [MCP validation memory exhaustion](https://github.com/advisories/GHSA-46jr-4wx8-v453)
- [MCP bearer audience handling](https://github.com/advisories/GHSA-rvq5-wwqv-78pq)
- [Zod oversized constrained collections](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
- [Tinypool worker options](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3)
- [Tinypool run options](https://github.com/advisories/GHSA-85c8-ppgw-ccpr)

The prior adapter already had local authentication, ingress bounds and per-request
server ownership. Dependency matches alone did not prove those specific attacks
were reachable. Updating the dependencies removes the known vulnerable versions
without replacing those independent safety controls.
