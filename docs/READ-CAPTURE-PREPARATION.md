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
