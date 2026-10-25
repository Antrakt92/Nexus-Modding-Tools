# Stable, working-directory-independent entrypoint; credentials stay in Credential Manager.
$ErrorActionPreference = 'Stop'
$workspace = if ($env:NEXUS_WORKSPACE) { $env:NEXUS_WORKSPACE } else { [System.IO.Path]::Combine($PSScriptRoot, '../../..') }
if ($workspace -notmatch '^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)') { throw 'NEXUS_WORKSPACE must be an absolute path.' }
$workspace = [System.IO.Path]::GetFullPath($workspace)
$exe = [System.IO.Path]::Combine($workspace, 'local-state/nexus-cli/1.1.1/nexusmods.exe')
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw 'Nexus CLI is missing. Inspect tools/modding/nexus-cli/README.md and installation.json.'
}
& $exe @args
exit $LASTEXITCODE
