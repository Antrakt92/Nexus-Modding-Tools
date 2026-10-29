# Contributing to Nexus Modding Tools

[Overview](README.md) · [Setup](docs/RESTORE.md) · [Tool routes](docs/AGENT-WORKFLOW.md)

## Report a problem

Use [GitHub Issues](https://github.com/Antrakt92/Nexus-Modding-Tools/issues).
Include the tool, version, exact command, reproduction steps and expected result.
Remove keys, bearer tokens, signed URLs, account state and private paths from
reports. Do not attach Vortex databases, mod archives or credential stores.

## Run local checks

Run commands from the repository root:

```powershell
python -B scripts/recovery.py verify
python -B -m unittest discover -s tests -v
node --test tools/modding/vortex-agent/session.test.mjs
```

The maintained tool READMEs list additional suites. Tests and source-integrity
checks do not establish native Vortex loading, deployed file ownership or game
behavior. Report those observations separately when they are relevant.

## Update the source inventory

After reviewing and staging the intended files:

```powershell
python -B scripts/update_manifest.py --write
python -B scripts/recovery.py verify
python -B scripts/update_manifest.py
```

Review the generated `recovery-manifest.json` and stage it with the source change.
The manifest pins the distributed source; it is not a publisher signature.

## Submit a change

Use a focused pull request against `main`, with a description of the behavior
and the checks you ran. Preserve licenses, dependency pins, stable operation IDs
and uncertain-operation recovery. Do not add unrestricted dispatch, generic mod
installation or game-launch operations. Store runtime output in ignored
`local-state/`; keep source changes separate from local installation state.
