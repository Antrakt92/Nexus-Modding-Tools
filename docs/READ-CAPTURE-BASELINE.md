# External disk baseline for a read capture

`capture-disk-baseline.mjs` reads the current hardlink deployment manifest and
protected preference files for Cyberpunk/profile `ptndev1016`. It writes no game,
staging or download files, does not contact Vortex, and grants no source admission
or installation authority. Native context/freshness review remains external.

Input is strict duplicate-free JSON, pinned by its exact raw SHA-256:

```json
{
  "schema": "read-capture-disk-input/1",
  "observedAtUTC": "2026-10-31T12:00:00.000Z",
  "health": {
    "gameId": "cyberpunk2077",
    "profileId": "ptndev1016",
    "gamePath": "F:/Games/Cyberpunk 2077",
    "stagingPath": "F:/Vortex Mods/cyberpunk2077",
    "downloadPath": "D:/Downloads/cyberpunk2077",
    "filesystemIds": {
      "gamePath": "1:100",
      "stagingPath": "1:200",
      "downloadPath": "2:300"
    }
  },
  "manifestSHA256": "REPLACE_WITH_64_LOWERCASE_HEX",
  "preferenceCandidates": ["F:/Games/Cyberpunk 2077/own-preference.json"]
}
```

Paths/IDs are placeholders. Input must be no more than 120 seconds old at the
start, with no future timestamp. This check does not prove that the caller read
native context. Long hashing does not require that age to remain below 120
seconds at completion. The roots must still match their filesystem identities
and metadata at the final checkpoint. IDs use Node `dev:ino`, not native Win32
128-bit file identity.

Required explicit candidates must exist. They may be inside the supplied game
or staging roots, or exactly these two paths relative to this process's
`LOCALAPPDATA`: `CD Projekt Red/Cyberpunk 2077/UserSettings.json` and
`CleanInventory/sorting-v1.txt`. Other AppData paths are refused. There is no
AppData scan and no download-content scan.

The CLI additionally discovers `.db`, `.ini`, `.json`, `.sqlite3` files recursively
below only `bin/x64/plugins/cyber_engine_tweaks/mods` and `red4ext/plugins` in the
game root. Both discovery roots must exist. Explicit candidates outside those
trees remain included. Except for the closed log-link pins below, reparse entries, unsafe Windows path components,
duplicate aliases and unsupported custom deployment targets fail closed.
The current manifest must explicitly name `cyberpunk2077`; older manifests with
an absent game ID are outside this first scope. Each file's default target must
be absent or the empty string. Null, boolean, numeric and structured targets are
refused rather than treated as the default.

```powershell
node tools/modding/vortex-agent/capture-disk-baseline.mjs --input 'C:/Tools/local-state/current-input.json' --input-sha256 REVIEWED_RAW_SHA
# Metadata-only plan: no output, no full payload hash pass.
node tools/modding/vortex-agent/capture-disk-baseline.mjs --input 'C:/Tools/local-state/current-input.json' --input-sha256 REVIEWED_RAW_SHA --output 'C:/Tools/local-state/new-baseline' --apply
```

Apply requires a new output directory inside this checkout's ignored
`local-state/`, with an existing ordinary parent. It writes only
`ROOT-DISK-BEFORE.json`. Existing or partial outputs remain held: no overwrite,
automatic retry, deletion, rollback or power-loss durability claim.

The full pass uses a checkpoint-local maintained physical reader with generation
and link-count cache keys. Its hash adapter streams bounded chunks from an FD,
compares FD/path identity and generation before/after, and checks ancestors.
Hardlink aliases share hashes while each named path is checked. The manifest,
all protected leaf generations, roots and discovery directory generations/file
sets are checked again before publication and after writing the ledger. This is
a sampled read proof, not an OS ownership lock or an atomic filesystem snapshot.

Output uses `root-current-physical-ledger/1` with `manifestSHA256`, deployment
`records[{game,stage,nodeId,bytes,links,sha256}]` and
`settings[{path,nodeId,bytes,links,sha256}]`; bytes are numbers. It adds
`preferenceDiscovery` with schema `read-capture-preference-discovery/1`, the two
fixed absolute roots, extensions `['.db','.ini','.json','.sqlite3']`, and sorted
unique canonical absolute file paths (forward slashes, lowercase). The consuming
native capture must derive those roots independently and repeat that discovery;
old baselines lacking this proof do not establish new preference coverage.

Input and output contain paths/hashes/metadata, never preference contents.
`nativeContextVerified`, `sourceAdmissionVerified` and `effectsAllowed` remain
false. Review the source-input pin and current native state separately before
binding a [read capture](READ-CAPTURE-PREPARATION.md).

Limits are explicit in the module: 50,000 manifest pairs, 4,096 explicit
candidates, 10,000 settings, 20,000 directories/50,000 scanned entries, depth
32, 16 GiB per file and 128 GiB of unique protected file bytes. Hash chunks are
1 MiB. Plan counts exclude content hashing; reported physical-reader metrics
describe only the apply checkpoint, not every metadata/input/manifest cost.

Run `node --test --test-timeout=15000 tools/modding/vortex-agent/capture-disk-baseline.test.mjs`.
Tests use their own ignored scratch and preserve partial/race evidence; they do
not inspect or modify a real game, Vortex staging, user preferences or downloads.


Optional `excludedLogLinks` admits at most three independently reviewed leaf
symlinks, only at game-root paths `red4ext/plugins/ArchiveXL/ArchiveXL.log`,
`red4ext/plugins/Codeware/Codeware.log`, and
`red4ext/plugins/TweakXL/TweakXL.log`. Omission means an empty list; null does
not. Each row has exactly these fields:

```json
{"path":"ABSOLUTE_REVIEWED_LOG_PATH","nodeId":"1:200","bytes":"100","links":"1","mtimeNs":"123","ctimeNs":"123","linkTextSHA256":"64_LOWERCASE_HEX","fileAttributes":1056}
```

All four size/link/time values are canonical decimal strings; link count must
be exactly `1`. The caller must independently inspect native Windows attributes:
`ReparsePoint` (`0x400`) must be present and `Directory` (`0x10`) absent. Node's
lstat does not expose that native attribute word; this producer validates the
reviewed attribute claim and independently checks the actual symlink's Node
identity, size, link count, nanosecond times and SHA-256 of `readlink` UTF-8 bytes.
It never follows or opens the target. No target string is emitted. The initial
and final discovery must each encounter every pin exactly once, with parent,
directory inventory and link generations stable. Missing, retargeted, extra,
configuration-file or unpinned links refuse the checkpoint. These are sampled
checks, not locks or native-context admission.

Output `preferenceDiscovery.excludedLogLinks` is always an array, even when
empty, sorted by canonical path and containing the validated detached pin rows.
The native capture consumer must repeat the same closed checks and discovery;
these exclusions never reduce protected JSON/configuration or explicit candidate
coverage. `nativeContextVerified` remains false.
