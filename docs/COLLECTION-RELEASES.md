# Collection release workflow

The permanent adapter supports inspection, download reuse, enable/disable and
deployment plans. It does not currently expose collection submission or profile
switching. A source release of this repository does not add those operations to
an installed host. Do not use generic dispatch, an arbitrary-code endpoint or a
UI fallback to fill the gap.

The owning collection project supplies its archive/recipe checks, exact baseline,
native update proof, user gameplay acceptance and guarded publication ledger.
The personal `nexus-collection-release` skill coordinates those existing gates;
the `nexus-publication` skill distinguishes collection publication from the
separate mod-file uploader. Skills do not authorize external effects.

## Prepare the path before the user's final test

Freeze the candidate and an upstream update cutoff. Keep public components and
local DEV work distinct. Check all prerequisites before reporting readiness:
the owning release guard, its actual child-process environment, original file
bindings, dedicated revision notes and the native operation's reviewed source.
The Cyberpunk source guard provides an offline preflight CLI and an API usable
inside a reviewed helper. It checks Python-child Git/Node execution and UTF-8,
then the unchanged offline preparation gates. Its own documentation is maintained
with that source, not copied here.

Supported operations reuse the running host through [session inspection and
plans](NO-RESTART-WORKFLOW.md). Native installation uses the existing
[helper preparer](NATIVE-HELPER-PREPARATION.md) or
[tracked-original batch route](TRACKED-NEXUS-HELPER-REVIEW.md). Prepare reusable
code while inert, then bind fresh task data once. Do not rebuild a new extension
for every observation. Unsupported template shapes require review before the
final user test, rather than exploratory native attempts during publication.

For the demonstrated rediscovery timestamps, use the narrowly source-bound
[settings comparison](TECHNICAL-SETTINGS.md). Full original snapshots remain
authoritative; the comparison projection must never be written back or used to
ignore other preferences. Source changes need fresh admission.

## Keep the critical path short

Finish all non-fresh preparation before the last current-state capture. Where
authorized, establish the draft and dedicated notes before that capture. Then
perform the required boundary validation, publish, independently read back the
revision and verify the original download. Existing freshness and uncertainty
guards remain binding. Do not bypass stale evidence with adjusted timestamps.

Do not rerun unchanged source suites solely to perform a later copy edit. Do not
replace a candidate after acceptance without affected verification. Record a
failed or uncertain effect before any recovery, retain its stable operation
identity, and reconcile instead of trying a fresh request.

Report publication and the remote-byte check separately from subsequent page
artwork, source bookkeeping and DEV restoration. Coordinate one owner of Vortex
and hand the window back after restoration and helper retirement. A pending image
upload should be reported as that specific remaining item.

The present additions prove offline preflight and comparison behavior. They do
not claim an upgraded resident adapter, a new collection API, a no-restart profile
switch or a measured end-to-end release time. Those changes need their own narrow
source-backed contracts and live acceptance during an agreed stopped-game window.
