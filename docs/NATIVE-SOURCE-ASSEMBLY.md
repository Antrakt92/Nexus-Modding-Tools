# Assemble the reviewed Vortex source patches

`native-source-series.mjs` applies the fixed sequence of 61 reviewed patches to
24 original files from Vortex `v2.9.1`, commit
`c80326367cbe6d96621ad6cf4a5488ef49bac110`. It replaces manually composing separate
patch chains before compilation. It does not change an installed application or
make native installation available through MCP.

## Inputs and result

Import the function from `tools/modding/vortex-agent/native-source-series.mjs`.
Pass a plain or null-prototype object whose keys are exactly
`NATIVE_SOURCE_PATHS` and whose values are original `Buffer` or `Uint8Array`
bytes. Obtain those bytes from an independently verified official source export;
the function does not discover or read an application installation.

```js
import fs from 'node:fs';
import path from 'node:path';
import {
  assembleNativeSources, NATIVE_SOURCE_PATHS,
} from '../tools/modding/vortex-agent/native-source-series.mjs';

const originals = Object.fromEntries(NATIVE_SOURCE_PATHS.map(file => [
  file, fs.readFileSync(path.join(verifiedSourceRoot, file)),
]));
const {sources, receipt} = assembleNativeSources(originals);
```

The library copies all input bytes before reading its fixed patch packet. It
rejects accessors, proxies, extra keys, shared/resizable backing stores and
inputs exceeding 2 MiB per file or 8 MiB in total. Original, intermediate and
final source hashes, patch/manifest hashes and cross-file prerequisites must
match the pinned series. Patch application requires exact offsets and context;
it has no fuzzy matching or hash-refresh mode.

The fixed graph combines the 32-patch mod-management/transfer packet with the
29-patch persistence packet. The latter includes renderer target admission and
acknowledged diffs, main/preload/shared IPC, backend reservations and managed SQL
ownership. Both runtime packet directories have separate closed inventories;
test-only adapters are excluded. A cross-file companion must already have been
applied with its exact patch and intermediate output hashes. Later patches may
then advance that companion source to its pinned final output.

The result contains a frozen source map and deeply frozen receipt. Reading a
source property returns a fresh mutable byte copy; changing it cannot change
another read or the retained result. The library performs no output writes,
compiler invocation, registration, event dispatch or installation.

## Compilation remains a separate gate

An assembly receipt records `preparedOnly:true`. Its `nativeAdmission`,
`effectsAllowed`, `typecheckVerified`, `nativeAcceptanceVerified` and `installed`
fields remain false. An exact source hash is neither a successful typecheck nor
native runtime acceptance.

The series includes three compatibility repairs found by the full renderer
typecheck: accept Bluebird through `PromiseLike` in the private add-mod result
and purge-operation signatures, and convert an unknown deployment rejection with
the existing `unknownToError` helper before notifying its callback. The first two
changes affect only types. The last preserves the recorded original failure and
the callback's at-most-once behavior.

Use a complete isolated official workspace, its pinned package manager and frozen
dependency graph for compilation. Build the renderer's workspace prerequisites,
then run its actual TypeScript and webpack targets without changing compiler
options or substituting declaration stubs. Bind the check to all ten resulting
source hashes. Preserve baseline errors separately from errors introduced by the
patch series. Never use an installed Vortex directory as the build output.

Keep dependency materialization separate from execution. In pnpm 11,
`verifyDepsBeforeRun` can automatically invoke an install; explicit installation
flags do not automatically constrain a later invocation. Inherit reviewed pnpm
settings in nested build commands and fail on unexpected dependency drift. An
install with scripts disabled does not mean a later automatic install also has
scripts disabled. Retain any failed attempt and its reason before retrying.

For pnpm 11, general inherited settings use the `pnpm_config_` prefix. Keep
`pnpm_config_ignore_scripts=true` and
`pnpm_config_verify_deps_before_run=error` in nested build commands. The pinned
11.10.0 checker also fails when both hook lists are undefined after an
`--ignore-pnpmfile` install. If independently verified hook/config candidates are
absent, a normal explicit frozen install with scripts disabled lets pnpm record
its own empty hook list. Do not edit its state metadata or disable dependency
verification to conceal this failure.

The packet's file-generation checks detect observed changes. They do not lock
the complete workspace against another writer. Hashes identify the pinned
inputs; they are not signatures or protection from a process that can rewrite
the library itself.

## Local checks

```powershell
node --test tools/modding/vortex-agent/native-source-series.test.mjs
$env:VORTEX_NATIVE_SOURCE_ROOT = 'C:/Task/verified-original-source'
node --test tools/modding/vortex-agent/native-source-series.test.mjs
```

The first command covers portable input and packet checks. The second also
exercises exact original-source assembly and output isolation. The fixture root
must contain all 24 original files, not their patched replacements. Earlier
partial fixtures are incomplete for this graph and are refused.
Neither command proves compilation, host loading or a successful mod install.

## Renderer qualification — 31 October 2026

The original complete official workspace passed its dependency-aware renderer
typecheck and webpack build. Applying the first 17 patches exposed the three
type errors above. The complete 20-patch series then passed the same targets:

```text
pnpm exec nx run @vortex/renderer:typecheck --skip-nx-cache
pnpm exec nx run @vortex/renderer:build --skip-nx-cache
```

The check used Node 24.20.0, pnpm 11.10.0, TypeScript 6.0.3 and webpack 5.108.4.
The official lockfile and compiler configuration were unchanged. Both targets
built their seven prerequisite tasks. All six final source hashes matched both
the actual TypeScript Program and webpack's source-map contents. The adapter's
combined local suite passed 843 tests without failures or skips; the primitive
deployment rejection regression failed before its repair and passed afterward.

These are renderer compilation checks in an isolated source export, using the
upstream default development build. They do not qualify a signed application
package, native addon ABI, main-process startup, installed-host loading or mod
installation. No application was started or replaced. The official source
workspace's dependency audit also remains separate: its pinned graph reported
210 advisories, including six critical records, during this qualification.
Successful compilation does not resolve those advisories or establish runtime
safety. Source receipts therefore continue to leave native admission disabled.

The subsequent 21-patch series adds
[startup cleanup ownership](NATIVE-STARTUP-CLEANUP.md). It passed the same
dependency-aware TypeScript and webpack targets with unchanged official
configuration and lockfile. All six final source hashes again matched the actual
Program and webpack map contents. Its combined adapter suite passed 850 tests
without failures or skips. The installed archive still matches the six official
original sources; none of these prepared application changes is loaded there.

## Transfer packet — 31 October 2026

The 28-patch / ten-source graph adds joined staging transfer callbacks,
exclusive copy collision refusal, cleanup-error preservation, staging Settings
ownership/context checks and report-only interrupted-transfer warnings. The two
download warning/cleanup patches are included in the exact runtime packet. The
separately pinned upstream test adapter remains outside that packet.

The expanded graph passed the actual renderer TypeScript and webpack targets
with the original compiler configuration and lockfile unchanged. All ten final
source hashes matched both the TypeScript Program and webpack source-map content.
This qualifies the renderer source build; it does not qualify main/preload
rebuilds, installed loading or native installation.

The six upstream transfer tests passed with a separately pinned mock adapter for
Node's copyFile callback. The original mock lacked that export and two tests
failed before the adapter. All original bytes and assertions are preserved
outside its fs-mock insertion. The source-backed callback suites passed 55 tests;
two additional checks verify the test adapter's pins and insertion-only boundary.
The TypeScript wrapper could not print Unicode to its CP1252 console after
writing its successful compiler result; that failed wrapper attempt was retained.
No compiler configuration or expectation was relaxed. See
[transfer bounds](NATIVE-STAGING-TRANSFER.md).

## Downloads Settings owner — 31 October 2026

The 29-patch / ten-source graph adds whole-operation ownership to Downloads
Settings after the destination-cleanup safeguard. It captures the global download
pattern and resolved paths before normalization, checks context/marker readback,
and joins the returned transfer, tag, elevation and reporting tails. The original
telemetry wrapper is source-tested; diagnostic failures cannot release started
work early or replace its primary failure.

All 18 new source-backed cases passed, together with the previous 55 transfer
cases. The exact graph passed its 14 checks. The full renderer TypeScript and
webpack targets passed with unchanged compiler configuration/lock, and all ten
final source hashes matched the actual Program and bundle map. Only Downloads
Settings changed from the qualified 28-patch renderer. The unchanged upstream
transfer tests retain their separately recorded six-case acceptance.

This is source/build qualification. Native child completion, physical custody,
main persistence acknowledgement, background download writers and installation
remain separate gates. The installed Vortex application was not replaced.

## Persisted transfer admission — 31 October 2026

The 30-patch / ten-source graph checks persisted transfer markers in
every registered install manager before reserving native exclusion and when
checking an issued owner. An unresolved or unreadable marker refuses admission.
Uncertainty observed after reservation permanently invalidates that owner;
clearing a marker cannot revive it. Reentrant state reads also preserve this hold.
See [manager exclusion](NATIVE-MANAGER-EXCLUSION.md).

All 13 marker regressions, 13 existing manager tests and 15 source-graph checks
passed without skips. Independent review reproduced and verified the repair of
a nested state-read case that previously allowed its outer check to return.
The final source passed actual TypeScript and webpack targets with unchanged
compiler configuration and lockfile. All ten final sources matched both the
TypeScript Program and renderer source map. The earlier build of the defective
draft was retained as superseded, not used as final acceptance.

These checks qualify prepared renderer source only. They add no marker reset,
owner release, native dispatch, registration, filesystem custody or installation
permit. The installed Vortex application remains unchanged.

## Complete source recipe — 31 October 2026

The 49-patch / 22-source graph includes both runtime packets. Prerequisites may
cross source files within a packet: for example, event-handler ownership depends
on an earlier InstallManager bridge. Their exact patch hashes and application
order are checked separately from each source's input/output chain. Test adapters,
SQL data files and unchanged build-control sources are not patched runtime nodes.
The original ten-file fixture is retained as historical input; it must
not be silently mixed with already-patched sources to satisfy the larger graph.

Every final modified source is byte-identical to its previously qualified
Program input: 12 renderer, seven main, one preload and two shared sources.
Twenty appear in runtime source maps; the two shared type-only files do not.
The prior qualification also observes the unchanged renderer `stateDiff.ts`.
All 19 assembly tests passed with the 22 original files supplied, without skips.
They include independent exact patch application, legitimate cross-file
prerequisites, intermediate companion outputs, rejected missing/changed/additional
packet entries and a Git CRLF-to-LF roundtrip across both packets. The combined
assembly and managed SQL/source-intake suite passed 69 tests without skips.

This comparison binds the assembled bytes to the existing checks, not to a new
complete build. Those checks retain their original execution scope and dates;
the assembly receipt continues to report `typecheckVerified:false`.

Before packaging or host acceptance, build the selected complete candidate with
its actual native dependencies and qualify its startup and lifecycle behavior.
A deterministic source recipe does not establish native module compatibility,
registration, release or a successful installation.


## Passive store binding — 31 October 2026

The 51-patch / 23-source graph adds passive Redux store binding and its actual
renderer startup call. It reuses the prior runtime packets and fixed companion
checks. The source tests cover safe startup refusal, real enhanced Redux stores,
descriptor/root drift and reentry without a repeated collection traversal.
The combined store-binding, assembly and managed SQL/source-intake run passed
103 cases without failures or skips.

The composed renderer passed the actual TypeScript and webpack targets with all
eight compiler/build configuration and lockfile pins unchanged. Fourteen renderer
sources matched the new Program and runtime map, including the unchanged
state-diff control. Ten main/preload/shared inputs retain their separate unchanged
baselines. All 23 graph outputs match the qualified source tree. This is a
renderer development-build check; the main/preload/shared targets were not rerun
and no installed application was changed. See the [store-binding boundary](NATIVE-ADOPTION-BOUNDARY.md#renderer-target-fence).


## Main initialization readiness — 31 October 2026

The 52-patch / 23-source graph adds the production main readiness attempt after
query-owner binding. The current SQL fixture initializes through the actual
production entry. Exact predecessor controls reproduce late-init rebinding and
stale factory adoption; the repaired generation/captured-backend checks prevent
both. Passive observers settle on invalidation without canceling raw SQL work.

The combined source suite passed 122 cases without skips. The actual main
TypeScript target, direct build and 52 upstream unit cases passed with unchanged
compiler configuration and lockfile. Seven main inputs matched the new Program
and main runtime map. Seventeen renderer/preload/shared inputs retain their prior
unchanged baseline; those targets were not rebuilt. All 23 graph outputs matched
the qualified tree. No installed application was changed and no readiness result
grants queue, SQL, filesystem or installation authority. See the
[readiness contract](NATIVE-ADOPTION-BOUNDARY.md#main-initialization-readiness).


## Renderer and manager startup readiness — 31 October 2026

The 55-patch / 24-source recipe adds ExtensionManager's exact load-attempt
observation, the renderer producer call and the specific mod-management once
completion. Manager startup belongs to the lifecycle packet; the ExtensionManager
and renderer producer layers belong to persistence. Their fixed inventories now
contain 31 and 24 patch pairs respectively. No packet discovers optional scripts.

Nineteen new source-backed cases passed, including exact predecessor controls and
actual APIProxyHandler/Bluebird doOnce behavior; the combined run passed 141 cases
without skips. Controlled external dependencies and prototype fixtures do not
establish full ExtensionManager construction or native startup. The actual renderer
TypeScript and webpack targets passed with unchanged configurations/lockfile.
Fifteen renderer inputs matched the fresh Program/map; ten main/preload/shared
inputs retained unchanged baselines. All 24 graph outputs matched the qualified
tree. This adds no installed-host, global-idle, persistence-flush or installation
permit. See the [startup boundaries](NATIVE-ADOPTION-BOUNDARY.md#renderer-and-manager-startup-readiness).


## Source-bound core readiness observation — 31 October 2026

The 61-patch / 24-source recipe retains the actual static mod-management module
namespace from its existing loader result, adds gated access to its existing
manager and composes it with the fixed main/preload readiness observation. Packet
inventories contain 32 lifecycle and 29 persistence patch pairs. This adds no
second module load or publicly mutable extension-API authority.

The combined source suite passed 191 cases without skips. All four projects
passed their actual TypeScript and build targets, with 52 upstream Node tests
also passing. Fresh Programs contain all 25 selected inputs; new runtime maps
contain 23 (excluding the two shared type-only sources). Root independently
verified all 24 graph outputs, configuration/lock pins and six runtime output/map
hashes. Cold Electron/test adapters remained unchanged.

The source-level deadline counterexample is retained separately: a timer-only
renderer guard accepted after a 5010 ms event-loop stall. The repaired monotonic
guard rejects the late result while retaining one underlying logical operation.
These source/controlled-fixture checks do not qualify native IPC transport,
ExtensionManager construction or installed loading. Readiness replies keep all
native/installation authority false; see [observation scope](NATIVE-ADOPTION-BOUNDARY.md#core-readiness-observation).
