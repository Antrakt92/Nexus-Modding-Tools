# Faster mod lifecycle work

The slow part of the current install workflow is preparation and repeated
verification around native helpers. Enable/disable and a single deployment
already use the running adapter. Installing or removing a package still needs a
separately reviewed native route; neither operation is added by this work.

## Check the intended mods before preparing a helper

The source adapter now exposes `read_mod_lifecycle` for 1–20 exact installed mod
IDs. It uses one Vortex state snapshot and performs no filesystem scan, hash,
download, dispatch, profile switch or helper activation.

```powershell
node tools/modding/vortex-agent/bridge.mjs --call read_mod_lifecycle '{"gameId":"cyberpunk2077","modIds":["EXACT_INSTALLED_MOD_ID"]}'
```

For an update, inspect the old provider's installed ID. For removal, inspect the
candidate IDs together. The result includes:

- enabled/reference flags in every profile for that game, including profiles
  pending removal; malformed flags remain `null` with an unknown counter;
- incoming `requires` matches through Vortex's native matcher, including
  repository/file references and ignored rules;
- references to each archive ID from mod records across all games.

This avoids starting a helper just to discover a known old provider, an enabled
copy in another profile or a collection's exact-file requirement. The older
`find_mod_dependents` matches only explicit ID references and is not equivalent.
The new read does not decide whether the new download satisfies each dependency.

No raw state, comments, account data or full rule references are returned. Limits
are explicit; missing native matching or an oversized scan fails rather than
returning a truncated success. `effectsAllowed`, `installationSupported`,
`removalSupported` and `diskDeploymentVerified` remain false. Empty results do
not prove a package or archive is safe to remove: staging aliases, deployed owners,
preferences, archive integrity and retained build inputs still need separate
checks.

The new read requires the new resident extension bundle. Reloading just the
bridge cannot add it to an older host. Build/package checks do not establish
native loading. On the maintained workspace, the 30 October upgrade was verified
through the actual running reader: ten profiles, 344 game mods and 506 rules,
with unknown profile flags reported as zero. Before/after session values and the
deployment manifest matched; this does not establish gameplay or removal safety.
Coordinate any host upgrade; do not restart Vortex during another chat's install
or a user's game test.

## Avoid repeated work without losing freshness

For new single-own helpers prepared by `prepare-native-helper.mjs`, the final
new-payload proof uses an independent physical reader. Every payload file is
fully hashed again. Its metrics are recorded as `freshPayloadProof` in the payload
receipt. The shared collection/source cache is no longer cleared by that local
checkpoint. Subsequent guards still enumerate paths, check metadata, identities
and links, and rehash changed generations.

This does not change `physical-proof.cjs` or the tracked Nexus installer's final
full-checkpoint cache clear. Completed helpers remain frozen; prepare a new kit
and bind it freshly. [Preparation contract](NATIVE-HELPER-PREPARATION.md).

Plan admission now stops scheduling further receipt reads after an initial
blocking error. Up to four already-started reads settle before the client returns.
Successful plans still preflight every request ID and retain fresh context,
immediate receipt checks and terminal acknowledgement checks before later steps.
Ordinary inspections still collect all requested diagnostic results.

For larger collections, use the existing exact-pair download join for up to 100
Nexus pairs, batch enable/disable IDs and deploy once. Do not ask for every mod's
rules individually or deploy after each change.

## Evidence and limits — 30 October 2026

Two historical single-own installation receipts recorded 60 / 68 guard calls,
43.586 / 60.384 seconds in guards, and about 20.6 GB hashed in each operation.
Warm guards cost approximately 0.5–0.64 seconds. Those receipts identify a real
bottleneck; they are not a before/after measurement of this change.

Another historical Family receipt recorded 95 guards taking 126.575 seconds,
with eight warm samples of 1.145–1.255 seconds. Its physical reader recorded
1,297,000 observations but only 5,511 hashes: about 99.575% were cache hits.
Moving source hashing off-thread therefore leaves substantial metadata,
directory-inventory and synchronous process-enumeration work. These receipts
have different workloads and code checkpoints; they are not a controlled timing
comparison. Source-only offloading must not be described as eliminating the
whole install bottleneck.

The generated-helper benchmark used the same 512 protected 8 KiB files and two
4 KiB payload files: cold guard, independent payload proof, then full guard.
After two warmups, five alternating samples had these results:

| Measure | Before | After |
| --- | ---: | ---: |
| SHA-256 file reads | 1,028 | 516 |
| Bytes hashed | 8,404,992 | 4,210,688 |
| Physical observations | 1,028 | 1,028 |
| Median phase time | 342.69 ms | 183.21 ms |

The payload was fully rehashed; protected/source mutations still caused a fresh
hash and rejection. A separate synthetic plan with 100 steps plus deployment and
an already-used first request ID reduced receipt reads from 101 to 4, with zero
effects. Artificial delayed-read medians were 403.94 / 15.49 ms; these are not live
Vortex timings. No end-to-end live install/delete speedup is claimed.

A synthetic metadata check with 500 mods, 13 profiles and 20 selected IDs returned
identical per-mod details with one batch state read instead of 20 individual state
reads. This reduces agent requests and repeated inventory traversal; it does not
skip the native matcher for any target.

Verification: 307 maintained tests passed with a freshly compiled adapter and
the real pinned tracked-template fixtures, with no skips. This includes the new
read through the actual compiled HTTP/SDK transport, bounded output, exact ID
serialization and refusal of extra arguments. All 21 recovery/bootstrap tests
passed. Independent follow-up review ran 64 focused tests covering mutations,
fresh payload metrics, plan admission and the new reader. No host acceptance was
performed on the running Vortex session.

## Next architectural boundary

A resident typed lifecycle worker could remove repeated helper activation and
retirement, but it must own a narrow reviewed contract rather than arbitrary
events or task code. Its next implementation gates are:

1. Early metadata preflight, followed by fresh disk/source/package admission.
   Immutable source proofs may be reused only while their physical generations
   and host identity remain unchanged.
2. A frozen operation plan with explicit old/new provider IDs, all-profile usage,
   incoming rules, archive SHA/CRC, staged payload, preferences and deployed owners.
3. One durable attempt/interlock per native effect and exact post-effect readback.
   Lost callbacks stop the queue for reconciliation, never a new request-ID retry.
4. For deletion, one ID at a time with a verified retained archive/payload keeper.
   The installed Vortex removal route permanently deletes files and can disable a
   mod before its pre-remove hook. Callback success is not terminal disk proof.
   Download deletion remains a separate operation with all-game archive closure.

There is no approved general install/remove worker yet. In particular, the
current native installer can prompt to ignore dependencies before offering
side-by-side installation; continuing changes collection rules. Removing the
helper guard would not make that route safe.

The internal [handle-owned transfer library](OWNED-FILE-TRANSFER.md) now provides
bounded new-only copying with retained parent/file handles and verified bytes.
It addresses one filesystem primitive; it does not yet replace the native
installer, establish extractor exit or measure a complete install speedup.

Build retention also needs an explicit consumer manifest: each canonical recipe
should name the exact source/variant archives and hashes it consumes, its current
output and any rollback keeper. Cleanup must preserve those referenced inputs.
An old filename or DEV suffix does not prove an archive is redundant. A reference
cache likewise needs a matching hash, completion receipt and expected outputs
before reuse; an incomplete attempt is held, not an accepted source or permission
to retry. The [API cache helper](PRISTINE-API-CACHE.md) now implements that status
and reconstruction boundary. The [keeper](KEEPER-RETENTION.md) retains declared
consumer artifacts and proves an isolated byte/archive restore. It grants no
deletion actions and does not establish native installation or exhaustive consumers.
