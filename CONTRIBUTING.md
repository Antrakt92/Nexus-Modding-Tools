# Contributing to Vortex Nexus Modding MCP

[Overview](README.md) · [Setup](docs/GETTING-STARTED.md) · [Tool routes](docs/AGENT-WORKFLOW.md)

## Report a problem

Use the [bug report or feature request form](https://github.com/Antrakt92/vortex-nexus-modding-mcp/issues/new/choose).
Include the tool, version, exact command, reproduction steps and expected result.
Remove keys, bearer tokens, signed URLs, account state and private paths from
reports. Do not attach Vortex databases, mod archives or credential stores.
Report suspected vulnerabilities through [private security reporting](.github/SECURITY.md).

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

For native-helper preparation, settlement or physical proof changes, also run:

```powershell
node --test tools/modding/vortex-agent/prepare-native-helper.test.mjs tools/modding/vortex-agent/native-install-wait.test.cjs tools/modding/vortex-agent/physical-proof.test.cjs tools/modding/vortex-agent/install-settlement.test.cjs tools/modding/vortex-agent/payload-size-proof.test.cjs tools/modding/vortex-agent/local-import-readiness.test.cjs tools/modding/vortex-agent/tracked-nexus.test.mjs
```

Use the [helper preparation guide](docs/NATIVE-HELPER-PREPARATION.md) for fresh
bindings and the final `verify DIR --materialization` gate. Never retrofit an
attempted or completed helper, replay an uncertain import or clear its receipts.
Copied template tests are executable code: review them before running them.
The tracked-Nexus integration case needs the separately reviewed source-family
fixtures documented in [its guide](docs/TRACKED-NEXUS-HELPER-REVIEW.md).
Without those private fixtures that case is explicitly skipped; report the skip
and run the portable policy tests. Do not claim full integration from that run.

## Update the source inventory

After reviewing and staging the intended files:

```powershell
python -B scripts/update_manifest.py --write
python -B scripts/recovery.py verify
python -B scripts/update_manifest.py
```

Review the generated `recovery-manifest.json` and stage it with the source change.
The manifest pins the distributed source; it is not a publisher signature.
The generator rejects invalid UTF-8 in maintained text sources before pinning
them. Upstream snapshots retain their original bytes.

## Submit a change

Use a focused pull request against `main`, with a description of the behavior
and the checks you ran. Preserve licenses, dependency pins, stable operation IDs
and uncertain-operation recovery. Do not add unrestricted dispatch, generic mod
installation or game-launch operations. Store runtime output in ignored
`local-state/`; keep source changes separate from local installation state.

`main` is the integration and resting branch. Use short-lived branches for
review, delete completed remote/local branches after merge, and retain unfinished
work. Do not force-push or delete an unmerged branch until its changes have been
reviewed and either preserved or explicitly rejected.

Dependency updates need compatibility review, the relevant local suites and
regenerated source/provenance pins. A Dependabot PR alone does not satisfy these
checks. Dependabot checks weekly and opens version proposals, grouping minor
and patch updates; security updates use a separate GitHub limit. A pending
proposal branch is legitimate work, not clutter to delete merely to leave one
branch. See [maintenance](docs/MAINTENANCE.md) for compatibility decisions and
required build checks. Do not run hosted checks or native Vortex effects merely
to tidy the repository.

Release the full change range since the previous immutable tag. New capabilities
require a minor release; fixes and documentation alone require a patch. Keep the
suite version separate from the embedded adapter label and distinguish a source
release from installation into the running Vortex session.
