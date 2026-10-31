# Native process snapshot prototype

An isolated Windows x64/MSVC experiment, not an installed Vortex extension or
guard backend. It only enumerates one process snapshot. It accepts no commands,
paths, PID controls, credentials or Vortex operations. The private Cargo package
uses an unpublished placeholder version; it is not a suite release number.

The [experiment stages](../../../docs/PROCESS-PROBE-EXPERIMENT.md) and independent
[JavaScript contract](../vortex-agent/process-probe-contract.cjs) define the scope.
`effectsAllowed:false` is constant. No successful response proves game absence,
deployment or permission to mutate anything.

## Build

Use the pinned Rust 1.99.1 toolchain and rustfmt with existing MSVC/Windows SDK.
Review [dependency admission](DEPENDENCIES.md) before explicitly fetching crates.
No installer runs at application startup and end users must not need Rust.

From this directory, with the pinned compiler available in a developer shell:

```powershell
$env:CARGO_TARGET_DIR = 'F:/YourWorkspace/local-state/native-process-probe-target'
cargo fetch --locked
cargo fmt --check
cargo test --locked --offline
cargo build --release --locked --offline
```

Choose an actual local scratch path rather than the example. The compiler,
linker and SDK paths can be supplied process-locally; do not alter system PATH
to make a runtime adapter find this prototype. A missing toolchain must be
prepared explicitly, not downloaded by a production helper.

The executable is `release/vortex-native-process-probe.exe` below the chosen
target directory. Keep its raw SHA-256 separate from LF-normalized source pins.
No binary belongs in the Git source manifest. A future distribution needs its
own artifact, source/dependency notices and PE-import/clean-Windows acceptance.
The reviewed default MSVC build imports `VCRUNTIME140.dll` and Windows CRT APIs;
it has not been proved self-contained on a clean machine. Static CRT versus a
declared runtime prerequisite must be decided and tested before distribution.

## Protocol

Write one UTF-8 JSON request to stdin, then close stdin:

```json
{"version":1,"requestId":"0123456789abcdef0123456789abcdef"}
```

The response is one closed `native-process-snapshot/1` object with that ID,
backend `toolhelp32w`, `nameKind:"executable-basename"`, complete/count/names and
`effectsAllowed:false`. Toolhelp names already include any `.exe` extension;
they are neither amended nor deduplicated. Native OS handles close on return.

Limits match the independent contract: 1 KiB request, 1 MiB response, at most
65,536 names of 260 UTF-16 code units. Collection reserves 512 bytes for the
envelope and can conservatively refuse near the output limit before allocating
the complete census. It never truncates a successful list. Invalid UTF-8/UTF-16,
BOM, decoded duplicate fields, partial enumeration and extra arguments refuse.
Errors print only a fixed code to stderr and exit nonzero, without partial JSON.

The CLI waits for stdin EOF. Its launcher owns the deadline. Consume a response
only after exit zero, empty stderr and stdout EOF. A valid JSON prefix followed
by a hung process is not success. A snapshot is a past observation, not a held
file seal or an atomic guarantee against later process creation.

## Independent native verification

From the repository root, set the exact reviewed build and raw pin:

```powershell
$env:VORTEX_PROCESS_PROBE_BINARY = 'F:/YourWorkspace/local-state/native-process-probe-target/release/vortex-native-process-probe.exe'
$env:VORTEX_PROCESS_PROBE_SHA256 = (Get-FileHash -LiteralPath $env:VORTEX_PROCESS_PROBE_BINARY -Algorithm SHA256).Hash.ToLower()
node --test tools/modding/vortex-agent/process-probe-native.test.mjs
```

Calculate this pin only for your own reviewed build; calculating an unknown
download's hash does not authenticate it. The tests launch this read-only CLI,
check its snapshot through the independent JS parser, and reject malformed input.
Without both environment variables, native cases explicitly skip. Portable
contract tests do not establish native integration. No game starts in these tests.
