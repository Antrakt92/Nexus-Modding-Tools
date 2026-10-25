param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference = 'Stop'
$workspace = if ($env:NEXUS_WORKSPACE) { $env:NEXUS_WORKSPACE } else { Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent }
if ($workspace -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))') { throw 'NEXUS_WORKSPACE requires an absolute path' }
$base = [IO.Path]::GetFullPath((Join-Path $workspace 'local-state/vortex-agent-native-fixture')).TrimEnd('\') + '\'
$full = [IO.Path]::GetFullPath($Root)
if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'Outside fixture scope' }
$file = Join-Path $full 'graceful-close-recovery.json'
if (Test-Path -LiteralPath $file) { throw 'Existing recovery receipt; inspect before another attempt' }
$record = Get-Content -LiteralPath (Join-Path $full 'process.json') -Raw | ConvertFrom-Json
$p = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
if (-not $p -or $p.Name -ne 'Vortex.exe' -or -not $p.CommandLine.Contains((Join-Path $full 'userdata'))) { throw 'Fixture process identity mismatch' }
if ($record.ordinaryPids -contains $p.ProcessId) { throw 'Ordinary PID refused' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FixtureWindowClose {
  public delegate bool EnumProc(IntPtr handle, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr handle, uint msg, IntPtr w, IntPtr l);
  public static int Close(uint target) {
    int count = 0;
    EnumWindows((h, unused) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid == target && PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero)) count++; return true; }, IntPtr.Zero);
    return count;
  }
}
'@
$count = [FixtureWindowClose]::Close($record.pid)
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ((Get-Process -Id $record.pid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
$closed = -not [bool](Get-Process -Id $record.pid -ErrorAction SilentlyContinue)
$result = @{fixturePid=$record.pid;windowsPosted=$count;gracefulClosed=$closed;ordinaryPidsAlive=@($record.ordinaryPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue });at=[DateTime]::UtcNow.ToString('o')}
$result | ConvertTo-Json | Set-Content -LiteralPath $file
$result | ConvertTo-Json -Compress
if (-not $closed) { throw 'Fixture did not close; no force termination attempted' }
