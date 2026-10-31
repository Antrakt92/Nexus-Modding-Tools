# Prototype build dependency review

Reviewed 31 October 2026 for this isolated process-only experiment. This is build
admission, not a general safety claim or production/native acceptance.

## Toolchain

Rust 1.99.1, commit `58cf8f9c35b355199727627d07ae34a4e2846d67`, is pinned in
`rust-toolchain.toml`. The maintained host used existing MSVC 14.44.35207 and
Windows SDK 10.0.26100.0; no Visual Studio/SDK installation was needed.

The official Rust stable manifest dated 15 October 2026 identified that compiler.
For the local experiment only, rustup 1.29.2 came from the official archived
`x86_64-pc-windows-msvc/rustup-init.exe`, SHA-256
`00f139da614dced87d3c3d4121c43eebdac3c1bf8a5ee86b9d80dfd71c8d70fd`.
The downloaded bytes matched its official checksum. That installer was unsigned:
HTTPS plus the publisher's checksum is not independent Authenticode evidence.

Toolchain homes were project-local, `--no-modify-path` was used and local rustup
self-update disabled. Builds used direct pinned compiler/cargo paths, explicit
linker/SDK paths and a separate ignored target directory. No toolchain install
or update is part of the runtime protocol.

## Crates

| Direct dependency | Exact version | Source | License |
| --- | --- | --- | --- |
| windows-sys | 0.61.2 | [Microsoft windows-rs](https://github.com/microsoft/windows-rs) | MIT OR Apache-2.0 |
| serde | 1.0.229 | [serde-rs/serde](https://github.com/serde-rs/serde) | MIT OR Apache-2.0 |
| serde_json | 1.0.154 | [serde-rs/json](https://github.com/serde-rs/json) | MIT OR Apache-2.0 |

Windows bindings enable only Foundation and Diagnostics/ToolHelp. Serde derive
is disabled; the two-field request uses a typed visitor with duplicate/unknown
field rejection. No custom JSON parser or manual Windows structure layout is used.

All 13 registry archive checksums matched `Cargo.lock` and the official crates.io
version records; none were yanked at review. The extracted source matched all
739 archived files. The selected build compiled eight dependency crates:
serde/core/json, itoa, memchr, zmij and windows-sys/link. Five proc-macro-related
packages appear in the lock through an unselected `cfg(any())`/derive edge; the
actual build did not compile that chain.

Selected build scripts were reviewed before build: cfg/private-module output
and compiler-version queries, no network actions. Inherited compiler wrappers
and build overrides were excluded from the reviewed build. An OSV query for all
13 exact registry versions returned no advisories at review; that is a dated
signal, not proof that no vulnerability exists.

`Cargo.lock` must remain committed. Fetch is explicit; tests/builds use
`--locked --offline`. Any dependency/features/toolchain change repeats this gate.
Before binary distribution, carry applicable complete license notices and source
offer, inspect actual PE dependencies and test the downloaded artifact on clean
Windows. A local developer build does not prove those distribution gates.
