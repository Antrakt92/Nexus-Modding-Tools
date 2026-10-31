# Assemble the reviewed Vortex source patches

`native-source-series.mjs` applies the fixed sequence of 20 reviewed patches to
six original files from Vortex `v2.9.1`, commit
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
options or substituting declaration stubs. Bind the check to all six resulting
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
must still contain the six original files, not their patched replacements.
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
