# Staging and download folder transfer

These prepared Vortex 2.9.1 patches address early promise settlement, destination
collisions and deletion of a partially transferred folder. They are part of the
[exact source assembly](NATIVE-SOURCE-ASSEMBLY.md); they do not change the installed
application or expose an install/remove endpoint.

## Prepared behavior

The transfer utility joins already-started stat, copy, directory and tag-removal
callbacks before returning its first failure. A failed walker or cancellation
stops new work while the existing callback tail settles. The synchronous walker
callback records each batch in one retained chain.

Copies use Node's exclusive destination creation; existing files and hardlink
collisions fail rather than being overwritten or counted as success. This does
not reserve path ancestors, reject every alias or prove physical file custody.
Cleanup logging cannot replace the original cleanup failure.

Staging and Downloads Settings capture selected paths and active context under
the shared lifecycle owner before normalization. They recheck that tuple across
awaited stages, join confirmation/reporting dialogs and preserve primary rejection.
These observations cannot prevent an independent writer from changing context
between checks or undo an already-started transfer.

On a copy failure or cancellation before transfer completion, both Settings
paths preserve the partial target and pending marker. A copy-complete transfer
whose source cleanup fails retains the existing policy: commit the new path and
clear the marker; the failed operation remains held without a rollback claim.
The staging and download interrupted-transfer warnings no longer offer automatic
whole-folder deletion. Reconciliation is required; no new cleanup or marker-reset
permission follows from these warnings.

## Remaining gates

The new Downloads Settings owner covers the global download pattern, without
appending an active-game directory. It refuses an existing transfer marker before
starting, checks dispatch readback, joins tag/elevation/dialog completion and
retains its own work promise across telemetry failures. Successful copy followed
by source-cleanup failure commits only the captured destination, clears the
marker and rejects conservatively.

Neither Settings owner establishes a durable renderer/main persistence
acknowledgement, an elevated child terminal or admission for background download
writers. The prepared [manager admission](NATIVE-MANAGER-EXCLUSION.md) rejects
unresolved persisted transfer markers; an issued owner remains invalid after
observed uncertainty, even if the marker disappears.

The runtime packet contains 30 patches for ten original sources. Its exact-file
inventory rejects extra files, including the separately pinned upstream test
adapter. Exact assembly and modeled callback regressions do not prove the full
renderer build, native filesystem completion, crash recovery or installation.
The installed application remains separate.

## Verification

The five source-backed suites cover joined tails, cancellation, collision refusal,
staging context/dispatch reentrancy, retained data/markers and read-only warnings.
They execute pinned source with test-owned filesystem/native facades. All 55
cases and 18 additional Downloads Settings cases passed for the preceding
29-patch graph, along with its then-current 14 graph checks and two test-adapter
checks. The current 30-patch graph passed all 15 graph checks and 13 additional
persisted-marker regressions; see [source qualification](NATIVE-SOURCE-ASSEMBLY.md).

The actual renderer TypeScript and webpack targets also passed. All ten source
hashes matched the actual Program and bundle source map, with the original
compiler settings and lockfile unchanged. The six upstream transfer tests passed
after the pinned fs-mock adapter supplied the copyFile API; every original test
byte outside that insertion, including assertions, was preserved. This is a
renderer development build qualification, not an installed-host check.
