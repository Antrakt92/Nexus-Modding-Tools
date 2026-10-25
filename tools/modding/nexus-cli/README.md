# Nexus CLI installation

Stable shell entrypoint, from any working directory:

The examples below run from the repository root. From elsewhere, invoke the
wrapper by its full path; it derives the workspace from its own location. Set
`NEXUS_WORKSPACE` to an absolute directory to keep runtime files elsewhere.
Installation uses `<workspace>/local-state/nexus-cli`; no personal drive is built in.

```powershell
& "tools/modding/nexus-cli/nexusmods.ps1" --version
& "tools/modding/nexus-cli/nexusmods.ps1" search --game cyberpunk2077 --query "SPLAT" --field name-stemmed --limit 3
```

Installed community tool: [vadimtrifonov/nexusmods-cli](https://github.com/vadimtrifonov/nexusmods-cli), MIT,
release 1.1.1, source commit `494f061e9f277414c4df306826b4d92cd1e6b90c`.
Windows x64 distribution requires the already installed .NET 10 runtime.
ZIP size 377388 bytes; GitHub release asset SHA256
`4790715ab94847757eb405c6442dae8dcc73c2f656ec43c367038b7b79c5812d`.
`install.py` downloads/reuses that exact asset, verifies hash and ZIP CRC, refuses
changed installed files, and writes the executable pin to
`<workspace>/local-state/nexus-cli/installation.json`. No global PATH change.
The installer rejects reparse points in output paths, including dangling links.
It checks all existing files and the receipt before extraction and unpacks the
same in-memory archive bytes whose size/hash passed verification.

Basic research works without authentication. Check JSON `status` and `errors`:
partial results also exit 0. Details and pagination are in the shared `nexus-research` skill.
Managed downloads/install/deployment remain routed through Vortex.

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
