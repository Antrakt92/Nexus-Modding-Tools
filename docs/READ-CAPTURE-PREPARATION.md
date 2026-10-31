# Prepare a zero-package native read capture

`prepare-read-capture.mjs` prepares one pinned read-only Cyberpunk/Vortex 2.9.1
source family for profile `ptndev1016`. It does not install or activate an
extension, capture current state, grant an install permit or approve a restart.
The permanent adapter remains separate.

The reference may be a completed historical capture. Only six explicitly pinned
code files are read: its entry, capture body, empty-package scope, native selectors,
identity projection and source-admission reader. Old configs, receipts, approvals,
baselines, host scripts and plugin metadata are neither read nor copied.

The generated family always has `packages: []`. Its scope rejects any package;
the package lookup loop cannot run. This route performs no `lookupModMeta` calls
when separately bound and executed in that supported scope. It captures complete
native state digests and protected inventories; it does not prove an install.

## Offline preparation

Use absolute paths. Output must be a new directory below this checkout's ignored
`local-state/`, with an existing ordinary parent. Reparse ancestors and active
Vortex plugin paths are refused. Game/staging/download destinations outside that
source scratch scope cannot be selected.

```powershell
node tools/modding/vortex-agent/prepare-read-capture.mjs --reference 'C:/Task/reviewed-code-reference' --timestamp-policy 'C:/Task/pinned/tool-timestamps.cjs' --output 'C:/Tools/local-state/new-read-capture'
# Review the plan, then add --apply to write the held kit.
node tools/modding/vortex-agent/prepare-read-capture.mjs verify 'C:/Tools/local-state/new-read-capture'
```

The timestamp policy has its own fixed source hash. If `--timestamp-policy` is
omitted, only `tool-timestamps.cjs` inside the supplied reference is considered.
There is no fallback to a historical task path. The original capture's absolute
timestamp import becomes a local runtime module. The optional diagnostic for a
historical Collection Patches DEV owner is removed; it is not a current baseline.

Newly generated capture code also replaces the historical path-only hash reader.
It compares the opened descriptor with the sampled path, checks descriptor and
path generations after streaming, includes link count in the cache key and reads
at most the initial file size plus one byte. Existing attempted kits remain
unchanged; use a new output directory for this generated code.

At the initial and final checkpoints, the capture reads actual native roots and
`util.getGame(gameId).getModPaths(gamePath)`. The map must exactly match the independently reviewed
`expectedDeploymentTargets` binding. The default type and reviewed type aliases
may point only at the same canonical game root; other target roots refuse.
Root and native-temp identities, ordinary ancestry, source admission and native
state are checked again before returning the result. These sequential observations
are not an atomic snapshot or a filesystem lease.
The bound config must supply an independently sampled `expectedNativeTempId` in
the same Node `dev:ino` domain as the current root bindings. A matching temp path
alone is insufficient. The held kit leaves this identity null.

The independent disk baseline must now include `preferenceDiscovery` with schema
`read-capture-preference-discovery/1`: the two fixed game-relative CET/mods and
red4ext/plugins roots, extensions `['.db','.ini','.json','.sqlite3']`, and sorted,
unique canonical absolute file paths. Canonical paths use forward slashes and
lowercase. The capture derives those roots itself and rejects arbitrary scan
roots. It scans them at the beginning and end, checks directory/file generations
and rejects additions, removals or reparses. Discovery is limited to 50,000 entries,
20,000 directories, 10,000 matching preference files and depth 32 across the two
roots. Directory entries are consumed with bounded `opendirSync` iteration.
The baseline's separate settings pins must also retain explicitly reviewed paths
outside those roots. Old preference paths can be reviewed inputs; old preference
values, hashes or approvals cannot become current evidence by copying them.

Dry-run writes nothing. Apply exclusively creates the output and writes new
files, with the kit manifest last. Any partial output remains in place for
inspection: no overwrite, automatic retry, deletion or atomic/durable publication
claim. Verification reconstructs the supported code from independent family pins
and checks the complete file set, runtime modules, held config and copy map.
A self-consistent edited manifest cannot admit different code or packages.

## The result remains held

`reviewed.prepared.json` is created afresh. Health/context, source pins/admission,
disk baseline, manifest path, native temp, process guard, reviewed peers and plugin
path remain null. Activation is held and no actual baseline is bound.

`COPY-MAP.prepared.json` lists every runtime file. `info.json` and `reviewed.json`
are explicit unbound pointers with null hashes. There is no READY file, host,
materializer, effect approval or activation writer. `verify` confirms held code
integrity only; bound materialization is not supported by this preparer.

Fresh source review, loaded-extension comparison, exclusive native window,
independent physical/deployment/preferences baseline and externally reviewed host
materialization are still required before a separately authorized capture.
Current curated MCP reads can establish context and operational metadata without
restarting Vortex; they do not replace those additional native/disk observations.

Historical consumers may still require old source paths or admission documents.
Preserve them until their callers have been migrated. Do not repair a missing
historical receipt by generating another file at that old path or changing an
attempted helper's pins.

## Verification

```powershell
node --test --test-timeout=15000 tools/modding/vortex-agent/prepare-read-capture.test.mjs
```

Set `VORTEX_OWN_READ_CAPTURE_REFERENCE` and
`VORTEX_READ_CAPTURE_TIMESTAMP_POLICY` to the exact reviewed private inputs to run
the real-family cases. Without them those cases explicitly skip. Tests execute
the generated held entry and module graph with native effects forbidden; they do
not load a live Vortex extension. Test-created scratch and partial kits remain
under ignored `local-state/` for owned cleanup/reconciliation.

Every discovered preference must have one unique settings hash row with a valid absolute path, filesystem identity, byte count, link count and SHA-256. A discovery path without its protected hash row is refused.

The fresh preference-discovery proof includes `excludedLogLinks` (an array of at most three rows). Only `red4ext/plugins/ArchiveXL/ArchiveXL.log`, `Codeware/Codeware.log` and `TweakXL/TweakXL.log` may be excluded. Each observed leaf must match its independently reviewed node identity, size, link count, nanosecond timestamps and link-text SHA-256; every pin must appear once in each scan. The capture reads link text without following its target and checks the leaves again after discovery and at the final checkpoint. Unknown links and preference-file links still refuse capture. `fileAttributes` pins are independent root-reviewed Windows metadata: Node validates the admitted REPARSE/no-DIRECTORY flags but does not claim to resample these Win32 flags.

A fresh independently reviewed `expectedDeploymentTargets` binding is required; held kits leave it null. At most 32 exact native mod-type IDs (including the default empty ID) may alias the canonical game root. Initial and final native maps must have exactly the reviewed keys and every path must resolve lexically to that same root. Other target roots remain unsupported. The capture includes the admitted `reviewedDeploymentTargets` map; no managed file is read through an additional target path.

A missing review, unsupported map or changed key set first writes `TARGET-MAP-DIAGNOSTIC.json` once (`wx`) in the bound control directory, then refuses capture. It contains bounded safe IDs, value kinds and root-equality flags; invalid keys, URI strings, outside-root path strings and arbitrary values are not serialized. This marker blocks subsequent entry replay even if writing the usual failure receipt is interrupted. No current native map or runtime acceptance is implied by preparing a kit.
