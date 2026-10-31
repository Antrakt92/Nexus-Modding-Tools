# Process guard native experiment

This experiment measures one component before replacing it. It does not change
the resident Vortex adapter, process guard, native installation refusal or game
state. Default commands plan only; `--run` explicitly starts read-only process
enumeration. No process names are written to the report.

## Stages

1. Capture the current guard's exact PowerShell script and measure its full
   invocation. Keep startup observations, subprocess wall and complete iteration
   wall separate. The latter includes executable generation checks and parsing.
2. Define an independent bounded process-only request/reply contract.
3. Build and test the [separate Rust CLI](../tools/modding/native-process-probe/README.md),
   then compare alternating backend calls.
4. Review faults, packaging, native acceptance and rollout before any opt-in
   adapter integration. No current command selects a new guard backend.
5. Consider a separate observational file-inspector only after this experiment;
   held handles and archive seals require another lifetime contract.

The guard's synchronous check immediately before effects is intentional. A
promise-returning replacement cannot simply be passed to `stopped()`:
`assertContext()` and receipt verification do not await that return. Async
integration needs a new reviewed barrier and fresh live-state validation.

## PowerShell control

```powershell
node tools/modding/vortex-agent/process-probe-benchmark.mjs --samples 20
node tools/modding/vortex-agent/process-probe-benchmark.mjs --run --samples 20
```

The baseline captures the actual template literal without evaluating source.
Tests compare it to the production guard's encoded command. The batch control
changes only its successful `exit 0` to `return`, wrapping the body in a fixed
function. This separates repeated body execution from repeated interpreter
startup without introducing a production daemon.

Limits: 1–100 measured samples, two initial observations per mode, 10 seconds per
process, a cooperative 60-second benchmark budget and 1 MiB output. Synchronous
filesystem/admission calls cannot be interrupted by that budget; no further
process starts after an observed expiry. The p95 diagnostic
is omitted below 40 samples. One-shot and batch modes run in fixed order; this
control is not an alternating language benchmark or an installation speedup.

The report records source/script/executable hashes. Benchmark-only executable
hashing is separate from invocation costs; it can warm the file cache. No run is
described as a cold-disk observation. Batch body timing includes its existing
module import, enumeration and JSON serialization, not outer validation. Whole
batch timing includes startup, initial calls and outer parsing/validation.

### Local observation — 31 October 2026

One explicit 20-sample run on Windows x64 with Node 24.20.0 recorded a median
one-shot spawn wall of 289.94 ms and
a full iteration median of 290.38 ms. The first observed full iteration was
662.69 ms; the second was 297.38 ms. Repeated body execution within one interpreter
had a 24.96 ms median; the whole batch process took 1,371.94 ms.

This is one local control run, not a Rust result, renderer measurement or causal
startup subtraction. The body timings and one-shot timings include different
costs and must not be divided into a claimed speedup. No p95 is reported for
these 20 samples. Raw names stay in transient process output only.

## Independent native data contract

`process-probe-contract.cjs` accepts a request containing only `version:1` and a
32-character lowercase hexadecimal `requestId`. It accepts no paths, commands,
environment, PID or installer instructions.

The reply is closed: schema `native-process-snapshot/1`, that exact request ID,
backend `toolhelp32w`, name kind `executable-basename`, `complete:true`, count,
names and `effectsAllowed:false`. Bounds are 1 KiB request, 1 MiB reply, 65,536
entries and 260 UTF-16 code units per name. Duplicates and extensions are retained.
Malformed UTF-8/UTF-16, BOM, duplicate keys and control/path characters refuse.

This parser validates producer claims only. The launcher must separately verify
the admitted executable, deadline, exit zero, empty stderr and stdout EOF. A
parsed JSON document cannot establish that the helper exited or the game stopped.
Two sequential live snapshots can differ; tests must compare known controlled
processes and guard decisions rather than demand identical complete lists.

## Acceptance before integration

Require repeatable full-call improvement beyond measured variability, all
rejection/freshness cases retained, no unknown helper lifetime and no material
memory or startup regression. Fix numerical budgets from baseline evidence
before selecting a backend. Keep microbenchmarks, workflow latency and actual
renderer responsiveness separate.

A distributable executable needs raw binary pins and build/dependency provenance.
The existing plugin package accepts a closed file inventory; adding an EXE needs
an explicit package contract. Never amend frozen helpers or move an unresolved
operation to a different backend. Runtime credentials and receipts stay in the
existing workspace.
