# Find reusable collection downloads

Use the bridge's read-only `find_collection_downloads` tool before preparing
downloads or native installation for a batch of collection members. Supply the
expected active game and exact Nexus mod/file pairs, rather than archive names.
It makes one bounded download-inventory read, checks context before and after,
and returns only the candidates for the requested files. It does not call Nexus,
open archives, import files, install, enable, deploy or change Vortex state.

## Request

```json
{
  "gameId": "cyberpunk2077",
  "files": [
    {"nexusModId": 123, "nexusFileId": 456},
    {"nexusModId": 234, "nexusFileId": 567}
  ]
}
```

The numbers above are examples. Use exact file IDs established by the project's
public-metadata workflow. Both IDs must be positive safe integers. The request
accepts 1–100 pairs, rejects unknown fields, and collapses duplicate pairs while
reporting `requestedCount` and `uniqueCount` separately. It never switches games
or profiles to make a request fit. A wrong active game stops before inventory.

With the existing runtime workspace selected, the equivalent bridge CLI is:

```powershell
node tools/modding/vortex-agent/bridge.mjs --call find_collection_downloads '{"gameId":"cyberpunk2077","files":[{"nexusModId":123,"nexusFileId":456}]}'
```

Use the established absolute bridge entrypoint from another working directory.
The local tool needs no extension upgrade or Vortex restart. Existing MCP clients
need to reload their bridge process to discover it; the CLI loads current code.

## Interpret the compact result

`status: "ok"` means the requested reads and validation completed. It does not
mean the collection is ready. Every result has `metadataOnly: true`,
`archiveIntegrityVerified: false`, `snapshotAtomic: false` and a 500-entry
inventory limit. Each requested file contains:

| Field | Meaning |
| --- | --- |
| `availability` | `finished`, `active`, `paused`, `failed`, `not_observed` or `unknown` |
| `candidates` | Downloads with a verified, unambiguous matching game/mod/file identity |
| `duplicateCandidates` | More than one verified candidate; `null` when uniqueness is not established by a complete observation |

Finished candidates take priority over active, then paused, then failed ones.
The complete candidate list retains every observed matching state; no candidate
is selected or removed automatically. Each candidate exposes only download ID,
state, size and optional `installedModId`. That installed-mod association is
tracking metadata, not proof of current installation, enabling or deployment.

`not_observed` means no verified pair appeared in the observed inventory. It is
not proof that the file is absent from disk or safe to download again. Downloads
without verified Nexus identities are counted in `unverifiedIdentityCount` and
are never guessed into a requested pair; local-only packages can contribute to
this count. Use the native lifecycle's exact archive/identity checks before
effects. A finished state does not prove file size, SHA-256 or ZIP CRC on disk.

A capped/failed read or malformed row returns `partial` and an MCP error, with
explicit per-read errors. Unseen requested files become `unknown` when the read
is incomplete. Observed positive candidates can remain visible after a cap, but
their uniqueness cannot be established. A context-check failure discards all
candidate associations rather than presenting data from an uncertain profile.

Results are current observations, not an atomic transaction or a saved plan.
Later operations must repeat their own context, identity and archive guards.
The existing `download_nexus` reuse/ambiguity guards and native install workflow
remain the authority for authorized effects; this helper grants no extra scope.

## Work avoided and verification limits

For up to 100 pairs, the MCP tool uses three underlying curated reads regardless
of batch size: health, downloads, health. MCP initialization is additional once
per bridge session; the CLI also performs its ordinary preliminary health check.
One index joins the bounded inventory to all unique requests, rather than making
one native inventory query per requested file or sending every unrelated row
back to the agent. The general session inspector and this tool share their
context/error/cap handling in `session.mjs`.

The native download projection and acquisition-matching scan also reuse one
fresh Nexus game-catalogue read per synchronous scan. Unrelated mod/file pairs
are filtered before resolving numeric game metadata in the matching scan. No
cache survives an operation: later reads and final effect preflights reload the
catalogue. A failed catalogue read remains ambiguous for that scan and can
recover on the next one. Domain-only records need no catalogue read.

The regression fixture reduced catalogue reads from 100 to one for 100 numeric
game records, while retaining duplicate and ambiguity refusals. This is an
operation-count result, not a measured whole-workflow speedup. The native
optimizations require a separately verified host-extension upgrade; the new
bridge-local batch tool already works with the existing curated host reads.

Local checks:

```powershell
node --test tools/modding/vortex-agent/catalog-snapshot.test.mjs tools/modding/vortex-agent/collection-downloads.test.mjs tools/modding/vortex-agent/inspection-client.test.mjs tools/modding/vortex-agent/session.test.mjs
```

The broader adapter/receipt/process suites and compiled-artifact wire check
remain required for native producer changes. Metadata matching, archive checks,
native installation, disk deployment and gameplay acceptance are separate gates.
