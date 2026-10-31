# Prepared strict new-disabled selection patch

This patch prepares one internal selection branch against official Vortex
`v2.9.1`, commit `c80326367cbe6d96621ad6cf4a5488ef49bac110`, after the exact
[activity patch](NATIVE-ACTIVITY-PATCH.md). It is not installed. No MCP operation,
public native listener, executor or installation permission is added.

The [patch](../tools/modding/vortex-agent/native-patches/vortex-2.9.1/strict-selection.patch)
and its adjacent manifest pin the original source, ordered prerequisite, input,
output and patch bytes. Preserve the upstream GPL license and attribution. Never
apply the patch directly to the installed `app.asar`.

## Internal selection boundary

Only private `installTracked` gains an optional strict descriptor containing
`archiveId`, `md5`, `size`, `gameId`, `profileId` and `modId`. It copies and freezes
the six primitive fields. Only `undefined` selects legacy behavior; malformed
strict descriptors refuse. Public `install()` keeps its existing signature and
never passes this argument. An `info` property cannot activate the branch.

This descriptor is an internal projection for selection checks, not a replacement
for the [complete dispatch request](NATIVE-DISPATCH-CONTRACT.md). The future
executor must independently validate the full request, source/capability admission,
archive and payload proofs, lifetime, durable intent and native effect ownership.
Matching these six fields grants none of those facts.

The strict branch requires the exact own-local tracked download, game/profile
and basename-derived owner, disabled state, no dependency processing and no
automatic deployment. It rejects caller-selected installer/file lists, inherited
choices, patches, previous-provider and variant state. Ordinary download-to-reference
enrichment is skipped only for this branch; `unattended` must be exactly `true`.

Checks run before queueing, when queued work starts, before alternate game/site
or profile routes and before/after the awaited `will-install-mod` hook. Cached or
computed archive MD5/size must match the selected tuple. The metadata lookup must
be an actual empty array, and the derived owner must match exactly. The name-loop
and replacement prompt are bypassed rather than asked to choose a safe option.

After asynchronous quick-metadata filtering, provider keys `modId`, `fileId` and
`revisionId` refuse, including `0`, `null` and a present `undefined`. Legitimate
filename metadata need not be empty. Strict selection returns before previous
provider discovery, dependency-ignore, version choice, disable and removal.

Fresh metadata-only inventory checks inspect same-game owner/map-key/path aliases,
archive and MD5 sharing, and all same-game profile references. An absent mod record does
not make an old profile flag safe: enabled, disabled and unknown target entries
remain conflicts. A final synchronous check sits directly before `startInstallCB`.
No filesystem hashes or archive extraction are performed by these checks.
The metadata inventories are bounded to 10,000 mod records, 2,000 profiles and
50,000 total same-game profile-state entries. Exhaustion or malformed records
refuse instead of silently returning a partial conflict list.
Present MD5 metadata must be canonical lowercase hexadecimal; uppercase, malformed,
null and explicitly undefined values refuse rather than bypass duplicate checks.

## Verification and limits

```powershell
$env:VORTEX_NATIVE_INSTALL_MANAGER = 'C:/ReviewedSource/InstallManager.ts'
node --test tools/modding/vortex-agent/native-strict-selection-patch.test.mjs
```

Tests require the independently obtained exact original source. They apply the
ordered patch series in memory, strip TypeScript types and execute the trusted
class with owned API/state stubs. The selection chain is exercised with spies for
forbidden branches and unchanged legacy cases. No application constructor,
extractor, actual install, filesystem deletion or game runs. The VM is a unit-test
mechanism, not a security sandbox. Missing source is an explicit skip, not native
acceptance.

The complete application build/typecheck and isolated native acceptance have not
passed for this patch. `startInstallCB` can dispatch or reenter after the final
check. Later installer/type/instruction hooks, the second metadata filter and
failure cleanup are outside this selection guarantee. In particular, checking
that a name is absent does not reserve a directory or make cleanup safe.

Exclusive physical ownership, no-clobber publication/import, host-wide effect
serialization, extractor termination, payload verification and durable recovery
remain required. Cross-game archive consumers also remain part of the executor's
separate admission inventory. The manifest therefore keeps no-replacement, owner reservation,
native terminal and installation-permit guarantees false. Continue through the
[implementation stages](LOCAL-INSTALL-IMPLEMENTATION.md); ordinary MCP
installation remains refused.
