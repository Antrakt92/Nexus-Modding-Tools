# Pristine API reference cache

`tools/modding/decompile_pristine.py` inspects the CDPR API reference cache
without generating source by default. It reads the fixed `r6/cache/final.redscripts`
input, the selected workspace's pinned redscript CLI manifest and the exact
cache receipt. It never searches older caches for a substitute.

```powershell
python -B tools/modding/decompile_pristine.py --workspace ABSOLUTE_RUNTIME_WORKSPACE --game ABSOLUTE_GAME_ROOT --status
```

An independently established input pin can be supplied with
`--expected-sha256 PREVIOUSLY_VERIFIED_PRISTINE_SHA256`. Without that pin, observed
current bytes do not become a pristine baseline and no cache is admitted for
reference use. Do not hash unknown current bytes and pass that value back as
proof of their origin. `.modded`, installed mod scripts and restricted inventory
implementations are not substitute inputs.

## Status and failure evidence

Status creates no cache directory, lock or log and starts no subprocess. Its JSON
distinguishes missing input/tool pins, changed files, a busy writer, missing cache,
incomplete or failed attempts, invalid receipts and reusable output. Errors are
fixed reason codes; raw logs and generated source are not printed. A source or
receipt path is returned only after the full admission checks pass.

Readiness requires matching full input and tool hashes, a valid receipt, exact
nonempty output size/hash, a successful exit and stable ordinary filesystem
identities. Short directory names are only legacy locators. Invalid metadata,
pending records, replaced paths or a writer lock block reuse; they are not cache
misses that authorize regeneration.

Before the CLI update, the failed slot contained only a log reporting that the tool
could not load the script cache and fill its buffer. That identifies a decoder
failure, not its root cause or proof that the input is pristine/corrupt. The
older reference uses a different input hash and has no matching acceptance
receipt. Those historical slots remain preserved and are not used as the new reference.

## Explicit generation

Generation needs `--generate`, the independently established input pin and the
manifest-pinned executable. The executable and command shape are fixed by this
workflow; the CLI has no arbitrary-command option. Source/tool stability,
required declarations and diagnostics are checked again before acceptance.
The receipt reports `requiredTypesVerified:true` and `coverageVerified:false`:
the two declaration checks do not prove complete API coverage. Resolve input
provenance and tool compatibility before generation.

New attempts use a full semantic cache key and an exclusive immutable slot.
The intent precedes the tool call, each attempt keeps its own log/output and the
acceptance receipt is published last. Existing failure or partial evidence for
the same input/tool cannot be bypassed by using the new directory layout. There
is no automatic retry, stale-lock takeover, overwrite or cleanup. A timeout or
failure preserves evidence for investigation.
The fixed live input/tool paths are checked before and after invocation; this
is not execution against copied input/executable snapshots. Output is rehashed
on reuse. Hardware power-loss survival is not guaranteed; missing or damaged
output is held on the next inspection.

The installed compatibility wrapper keeps the existing runtime workspace and
translates the older explicit `--game` plus `--expected-sha256` invocation to
generation. Add `--status` for the read-only route. New callers should use the
maintained interface and its explicit mode rather than depend on that legacy
translation. A successful cache is API evidence for its exact input/tool, not
gameplay or mod compatibility proof.

## 30 October verification

The portable CLI was updated from 0.5.31 to **0.5.32**, whose
[official release](https://github.com/jac3km4/redscript/releases/tag/v0.5.32)
adds Cyberpunk 2.5 bundle support. Its parser change addresses the extra table
header behind the old `failed to fill whole buffer` error. The standalone
Windows asset's bytes matched the
[official release digest](https://api.github.com/repos/jac3km4/redscript/releases/tags/v0.5.32).
The executable is unsigned; no Authenticode or signed-tag claim is made.

The current input matched the expected size/SHA-1 in its installed Steam depot
manifest, selected through the installed app/build/depot metadata. File/ancestor
generations were stable. This is local Steam metadata agreement; the parser
does not authenticate Valve's signature. The helper still requires an explicit
input pin rather than inferring provenance from its filename or observed hash.

Generation then passed in one observed 844 ms helper run and produced
22,728,153 bytes. Required declarations, strict UTF-8, diagnostics, full hashes
and the acceptance receipt passed. Read-only status and the legacy command
reused the same output without invoking the tool or changing accepted files.
The previous failed log and provenance remain intact. After consumer migration,
the old CLI executable was moved to the Windows Recycle Bin. Installed SCC, game files,
Vortex and the running profile were not changed.

Twenty synthetic cache regressions and the three existing wrapper lock tests
passed. The [dependency audit](DEPENDENCY-AUDIT.md#30-october-standalone-redscript-cli)
records the wider dependency refresh and its limits. This verification establishes
a usable exact-input API reference, not complete API coverage or gameplay proof.
