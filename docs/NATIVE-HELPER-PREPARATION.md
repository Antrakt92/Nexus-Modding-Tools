# Prepare the next reviewed native helper

Native installation is still outside the permanent MCP adapter. This offline
preparer upgrades the known held, single-package Cyberpunk helper template; it
does not add an install endpoint, approve replacement or activate a plugin.
Other games/types/template shapes require their own reviewed preparation.
For already tracked Nexus originals, follow the separate
[batch helper review route](TRACKED-NEXUS-HELPER-REVIEW.md). Do not change this
preparer's single-package/local-only admission merely to accept a Nexus batch.

Earlier helpers continued to copy a legacy settlement observer after a fixed
observer was available. New preparations must use the maintained code kit and
pass its code-contract check before materialization/activation. Keep completed
helpers and receipts unchanged. Source/hash drift requires reconciliation, not
repinning an attempted operation or replaying an import.

## Prepare while the template is still inert

Review the template first and obtain the exact SHA-256 of `index.prepared.js`.
Input requires `reviewed.prepared.json` with activation held, no effects,
no actual baseline bound and one disabled package. Materialized configs,
attempt/failed/completed markers, source/module drift, unsupported code shapes,
reparse paths and active Vortex plugin paths are refused. No dependency install
is required. Output must be a new absolute directory outside the input; its
parent must already exist. Known game/staging/download roots are refused.

```powershell
node tools/modding/vortex-agent/prepare-native-helper.mjs --source 'C:/Task/inactive-template' --source-sha256 REVIEWED_SHA256 --output 'C:/Task/current-template'
# The same command with --apply writes the reviewed plan's held code kit.
node tools/modding/vortex-agent/prepare-native-helper.mjs --source 'C:/Task/inactive-template' --source-sha256 REVIEWED_SHA256 --output 'C:/Task/current-template' --apply
node tools/modding/vortex-agent/prepare-native-helper.mjs verify 'C:/Task/current-template'
```

The result is **inert code and tests**: copied pinned runtime modules, a modified
entrypoint, held config, regressions and `HELPER-KIT.json`. Existing plugin metadata
is retained as a review input if present. Native startup/cleanup scripts, fresh plugin metadata,
archives, baselines and effect approvals remain with the task's reviewed binder.
The preparer clears stale health/plugin-path bindings; it retains the package as
a preparation input, not permission to install that package. No `reviewed.json`
is created. Source approval must include the changed engine integration, modules
and their new pins; a passing code check is not an activation approval.

When binding the new task, use the kit's entrypoint and **all** module pins, not
an old fixed list of modules. Carry `HELPER-KIT.json` unchanged into the final
inactive prepared directory. Rebind fresh package/source admission, baseline,
health/profile/root/filesystem identities, plugin metadata and root approval.
Build `READY.prepared.json.filesToCopy` from all kit module pins, alongside the
three standard mappings (`index.prepared.js` to `index.js`, `info.prepared.json`
to `info.json`, `reviewed.json` to itself). Reusing an old fixed copy list can omit
new dependencies. Keep `HELPER-KIT.json` in the control directory; it is not an
extra plugin mapping. The existing host/freeze guards still require that exact
copy map. A null reviewed-config hash is allowed only because the root materializer
creates and pins that file before copy. Then run the final mapping gate:

```powershell
node tools/modding/vortex-agent/prepare-native-helper.mjs verify 'C:/Task/final-inactive-helper' --materialization
```

This is required before materialization/activation, in addition to code-only
verification of the initial kit. If the binder
changes runtime source or omits a module, stop and review a new kit rather than
silently replacing its expected hashes. Keep the existing no-replay receipts,
metadata/replacement admission, exclusive native install hooks and disk checks.

## Changes applied to the supported template

- `settlement.cjs` becomes the maintained compatibility entry. The call pins the
  exact callback download ID, expected mod/staging ID, empty native mod type,
  expected payload size and flags, plus a synchronous durable diagnostic writer.
  Missing identity/writer inputs fail before acceptance. The empty type is
  deliberate for this reviewed template family, not inferred from live state.
- `install-settlement.cjs` ignores unrelated metadata churn and reports waiting
  predicates, sampled quiet time and separate guard/read/sleep timing. A failed
  adapter deadline retains its last operation and counters, even before a sample.
- Newly prepared helpers use explicit `verified-payload` size observation:
  every sample validates the fresh staged file set and SHA-256 map before
  summing its physical bytes with `payload-size-proof.cjs`. Native `modSize`
  is reported separately and does not block that mode: Vortex calculates it
  asynchronously after installation and can swallow calculation errors.
  Identity, installed state, flags, quiet-window and protected-state checks remain.
  The observer's default metadata mode remains strict for existing callers;
  never change an attempted helper or reinterpret its failed receipt as success.
- `physical-proof.cjs` shares a hash across hardlink aliases with the same
  dev/ino/size/mtime/ctime/nlink generation, while independently checking every
  leaf/path observation. Metadata is checked after hashing before caching.
  Counters report hashes, cache hits and logical bytes hashed. Ancestry/root
  containment remains the caller's existing guard responsibility.
- The explicit `app.asar` check verifies its required source pin and native
  constant; the retained source-pin loop uses the generation-checked physical
  reader. Repeated guards still sample file metadata and reject changes, while
  an unchanged source generation is hashed once per cache lifetime.

The physical cache replaces the old helper-lifetime path cache. It belongs only
to that reviewed helper/checkpoint, is bounded and can be cleared by the caller.
Do not reuse it as proof across unrelated clients or deployments. This keeps the
existing generation-based cache policy and strengthens post-hash race detection;
it does not establish immutable bytes against arbitrary external writers.

Full protected-state checks and the serial poller remain. Removing/relocating
those checks or changing native process enumeration needs a separately verified
guard contract. No installed adapter change, restart or live-install speedup is
implied by preparing this code.

## Verification

```powershell
node --test tools/modding/vortex-agent/prepare-native-helper.test.mjs tools/modding/vortex-agent/native-install-wait.test.cjs tools/modding/vortex-agent/physical-proof.test.cjs tools/modding/vortex-agent/install-settlement.test.cjs
```

Regressions cover pinned module copying, old/attempted helper rejection, inert
output, source drift, held configuration, hardlink reuse, same-size mutation,
replacement/link-count races, mandatory archive/type pins, metadata churn and
diagnostic timing. A new reviewed live installation remains a separate gate
after gameplay ends and its window is coordinated.

### 29 October verification record

The full maintained source suite passed 248 tests; the final additional strict
manifest/copy-map regressions passed with the focused preparer suite. All 30
tests of a generated copy of the actual held Context DEV template passed,
including the task's metadata/identity and inert-entrypoint regressions. Recovery
and synthetic installer suites passed 16/28 tests. The old 150ms test watchdog
mistook real receipt fsync latency for download failure; those tests now retain
their functional assertions with a 5s runner hang limit. Production timeouts are
unchanged. Source/kit pins, local links, 14 skill-checker tests and all four
warmed native discovery runs passed. The standalone Python skill validator was
unavailable because PyYAML was absent in both selected interpreters; no package
was installed to lint. The existing full-tree YAML/owner/link checker passed.

Artifacts are retained under ignored `local-state/native-helper-workflow-20261029/`.
The generated template remains held; no ordinary-session installation, game
launch, adapter upgrade or restart was performed. Remaining full guard/poller
work and Windows process enumeration have not been optimized by this change.
