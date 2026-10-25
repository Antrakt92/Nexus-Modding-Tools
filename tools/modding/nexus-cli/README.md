# Nexus CLI installation

Stable shell entrypoint for the pinned community CLI.

The examples below run from the repository root. From elsewhere, invoke the
wrapper by its full path; it derives the workspace from its own location. Set
`NEXUS_WORKSPACE` to an absolute directory to keep runtime files elsewhere.
Installation uses `<workspace>/local-state/nexus-cli`; no personal drive is built in.

Pinned community tool: [vadimtrifonov/nexusmods-cli](https://github.com/vadimtrifonov/nexusmods-cli), MIT,
release 1.1.1, source commit `494f061e9f277414c4df306826b4d92cd1e6b90c`.
The Windows x64 distribution requires a separately installed .NET 10 runtime.
ZIP size 377388 bytes; GitHub release asset SHA256
`4790715ab94847757eb405c6442dae8dcc73c2f656ec43c367038b7b79c5812d`.
`install.py` downloads/reuses that exact asset, verifies hash and ZIP CRC, refuses
changed installed files, and writes the executable pin to
`<workspace>/local-state/nexus-cli/installation.json`. No global PATH change.
The installer rejects reparse points in output paths, including dangling links.
It checks all existing files and the receipt before extraction and unpacks the
same in-memory archive bytes whose size/hash passed verification.

To install or reuse the verified release, run this explicit installation command
from the repository root; it may download the pinned asset:

```powershell
python tools/modding/nexus-cli/install.py
```

Then check the installed version and run a public search:

```powershell
& "tools/modding/nexus-cli/nexusmods.ps1" --version
& "tools/modding/nexus-cli/nexusmods.ps1" search --game cyberpunk2077 --query "SPLAT" --field name-stemmed --limit 3
```

## Read the result, not just the exit code

Basic public research works without authentication. Inspect JSON `status`, `data`,
source-attributed `errors` and `meta`: both `complete` and `partial` exit 0;
`failed` exits 1. A partial response is not a complete audit. Preserve decimal IDs
and sizes as strings, and distinguish game-scoped IDs from global v3 IDs.

Use `--help` or `inspect --help` for the current command contract. Search uses
`--offset`/`--limit`; uploaded-file lists use `--file-offset`/`--file-limit`;
indexed contents use `--content-offset`/`--content-limit`. Compare returned counts
with reported totals before claiming full coverage. File-list options cannot be
combined with a selected `--file`; `--contents` needs that selected file.

Author-declared requirements and file-specific dependencies are separate evidence,
not compatibility proof. Selected-file dependencies may require existing Nexus
authentication; an unavailable section does not justify configuring a key for
ordinary anonymous metadata work. An empty contents index does not prove an
archive is empty. Managed downloads, installation and deployment use Vortex.

For future file-dependency queries or publication, configure a personal Nexus API key
once in an interactive terminal:

```powershell
& "tools/modding/nexus-cli/nexusmods.ps1" auth set
& "tools/modding/nexus-cli/nexusmods.ps1" auth status
```

`auth set` validates a hidden-input key and saves it in Windows Credential Manager.
Do not send the key in chat, command arguments, environment, or plaintext files.
The source-verified target `skill-nexus` is shared by the guarded publication runner's
`--credential windows-cli` mode. No Vortex credentials are extracted.
During initial inspection the target was absent. Historical setup evidence recorded
configuration and CLI/publisher validation of a Premium key. Anonymous and authenticated
live search/inspection/indexed-contents checks succeeded in that setup session; these
are not current account-access guarantees. The indexed query returned
109 entries for the selected public test file; only three were requested, not a full audit.

If terminal paste fails, copy only a newly generated key to the Windows clipboard,
then explicitly run:

```powershell
python "tools/modding/nexus-cli/credential_setup.py" --from-clipboard
```

This personal-use helper validates the key with Nexus before writing the same
source-verified Credential Manager target. It refuses redirects, outputs only status
and Premium boolean, and never writes the key to arguments/environment/files.
It does not read the clipboard unless explicitly invoked. After successful setup,
clear the key from the clipboard and revoke any key exposed in chat/logs.
