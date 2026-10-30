# Keeper and isolated restore

`keeper.mjs` verifies a finite catalog of declared own artifacts and retains exact
copies. Verification is read-only by default. It does not discover every caller,
prove ownership or licensing, delete files, run retained scripts, or install mods.

The 30 October checkpoint passed 14 synthetic regressions and an actual isolated
copy/restore of seven own package/evidence artifacts. Original bytes were
unchanged. External consumers and native preference/profile restoration remained
explicit unknowns; no retirement actions were granted.

The caller supplies an absolute manifest path and its previously recorded SHA-256.
Inputs may be ordinary files in the source or runtime workspace. Keeper and restore
outputs must be new directories beneath this source checkout's ignored
`local-state/`; no CLI option changes that boundary. Output parents must exist.
Symlinks, junctions, duplicate paths and physical aliases are refused. Artifact IDs
are unique ignoring ASCII case; copied names use an `artifact-` prefix so DOS
device names cannot become output filenames. Input/output path components also
refuse alternate streams, device names, Windows metacharacters and trailing
dots/spaces. UNC and device-namespace paths are outside this first scope.

## Manifest

The UTF-8 JSON document has this shape (hashes and byte counts below are placeholders):

```json
{
  "schema": "keeper-plan/1",
  "artifacts": [
    {
      "id": "build",
      "kind": "build-receipt",
      "path": "D:/Modding/Nexus/local-state/own-build/result.json",
      "bytes": 123,
      "sha256": "PREVIOUSLY_RECORDED_SHA256"
    },
    {
      "id": "package",
      "kind": "own-zip",
      "path": "D:/Modding/Nexus/local-state/own-build/Own-LOCAL.zip",
      "bytes": 456,
      "sha256": "PREVIOUSLY_RECORDED_SHA256",
      "payload": {
        "r6/scripts/Own/Example.reds": "PREVIOUSLY_RECORDED_PAYLOAD_SHA256"
      }
    }
  ],
  "consumers": [
    {
      "id": "current-own-build",
      "evidenceArtifactId": "build",
      "inputs": [],
      "currentOutputs": ["package"],
      "rollback": ["package"]
    }
  ],
  "unknownConsumers": []
}
```

Supported kinds are `own-zip`, `build-receipt`, `source-manifest` and `own-source`.
An archive requires an exact nonempty payload path/SHA-256 map. A consumer's evidence
must reference a retained build receipt or source manifest. Every artifact must be
referenced by a consumer role or evidence. Unknown fields, duplicate IDs, duplicate
references within a role, missing references and orphan artifacts are refused.
Several consumers or roles may legitimately share one artifact.

Limits are 128 artifacts, 128 consumers, 64 MiB per file, 256 MiB total catalog bytes
and a 1 MiB manifest. The aggregate uncompressed archive payload is also bounded to
256 MiB. ZIP validation uses the maintained own-package inspector, including its
CRC, supported compression and path restrictions; unsupported ZIP features fail
closed. Manifest JSON uses the shared duplicate-key-aware parser.

The catalog records caller assertions. A build receipt's retained bytes do not
prove the build passed, its source is independent, or all external consumers have
been found. Nonempty `unknownConsumers` blocks retirement planning. Even an empty
list leaves `retirementRequiresOwnerReview: true` and `retireActions: []`.

## Commands

Run from the source checkout, with real absolute paths and recorded hashes:

```powershell
node tools/modding/vortex-agent/keeper.mjs --manifest ABSOLUTE_PLAN --manifest-sha256 PLAN_SHA256
node tools/modding/vortex-agent/keeper.mjs --mode create --manifest ABSOLUTE_PLAN --manifest-sha256 PLAN_SHA256 --output ABSOLUTE_NEW_LOCAL_STATE_KEEPER
node tools/modding/vortex-agent/keeper.mjs --mode inspect --keeper ABSOLUTE_KEEPER --proof-sha256 RECORDED_PROOF_SHA256
node tools/modding/vortex-agent/keeper.mjs --mode restore --keeper ABSOLUTE_KEEPER --proof-sha256 RECORDED_PROOF_SHA256 --output ABSOLUTE_NEW_LOCAL_STATE_RESTORE
```

Creation and restore publication currently require Windows. Read-only verification
is portable. Production writes on other platforms fail before reserving an
attempt, because directory rename there can replace an existing empty target.

Creation copies bytes into artifact-ID filenames, retains the original manifest
unchanged, writes an exact copy map and returns the proof file's SHA-256. Preserve
that hash separately; a self-consistent rewritten receipt is not trusted without
the original proof pin. Input paths inside retained documents are historical data
and are never followed during restore.

Restore verifies the retained manifest, map, proof, complete copied-file set,
archive CRC and payload, then copies the catalog into another new isolated folder.
The original source files need not still exist. It never restores to original
paths or rewrites old receipts to make them look fresh. A restored archive passing
these checks is not native installation, deployment, settings or gameplay proof.

Each write uses exclusive file creation, fsync and exact-byte readback. Input
files and ordinary ancestor identities are sampled before and after the operation.
A permanent sibling reservation binds the requested target, random nonce, manifest
and copy-map hashes before copying. A new unpredictable private directory holds
the packet until all bytes and directory identities have been checked. The proof
is written last, then the complete directory is published with a Windows
no-overwrite rename. Source observations and the complete published packet are
checked again before success is returned.

A failure preserves the reservation and any partial private directory; a failure
before private-directory creation can leave the reservation alone. The same target
cannot be retried even when its final directory is absent. No foreign directory
is removed. Creating into an existing directory is refused. There is no cleanup,
overwrite, automatic retry or deletion mode.

These checks detect observed changes; they cannot prevent another writer changing
files after the last observation. File fsync does not promise hardware power-loss
survival or a globally atomic directory transaction. A partial or changed packet
fails verification. No live Vortex or game operation is part of this tool.
