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

Staging Settings captures the selected paths and active context under the shared
lifecycle owner before normalization. It rechecks that tuple across awaited
stages, joins confirmation/reporting dialogs and preserves primary rejection.
These observations cannot prevent an independent writer from changing context
between checks or undo an already-started transfer.

On a copy failure or cancellation before transfer completion, both Settings
paths preserve the partial target and pending marker. A copy-complete transfer
whose source cleanup fails retains the existing policy: commit the new path and
clear the marker; this is not rollback. The staging and download interrupted-transfer warnings no
longer offer an automatic whole-folder deletion. Reconciliation is required; no
new cleanup or marker-reset permission follows from these warnings.

## Remaining gates

The download cleanup patch does not add whole-operation ownership to Downloads
Settings. Its normalization/apply tail and mutable selected path still require a
separate captured-context/ownership change. Neither Settings patch establishes a
durable renderer/main persistence acknowledgement. Native admission must also
reject unresolved transfer markers.

The runtime packet contains 28 patches for ten original sources. Its exact-file
inventory rejects extra files, including the separately pinned upstream test
adapter. Exact assembly and modeled callback regressions do not prove the full
renderer build, native filesystem completion, crash recovery or installation.
The installed application remains separate.

## Verification

The five source-backed suites cover joined tails, cancellation, collision refusal,
staging context/dispatch reentrancy, retained data/markers and read-only warnings.
They execute pinned source with test-owned filesystem/native facades. All 55
cases passed, along with 14 graph checks and two test-adapter checks.

The actual renderer TypeScript and webpack targets also passed. All ten source
hashes matched the actual Program and bundle source map, with the original
compiler settings and lockfile unchanged. The six upstream transfer tests passed
after the pinned fs-mock adapter supplied the copyFile API; every original test
byte outside that insertion, including assertions, was preserved. This is a
renderer development build qualification, not an installed-host check.
