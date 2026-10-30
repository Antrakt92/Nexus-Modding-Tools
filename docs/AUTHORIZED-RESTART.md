# Authorized Vortex close and restart

Use this route when the user has authorized a restart and the operation needs
one, such as retiring a completed temporary helper or loading a verified adapter
upgrade. Routine resident reads, downloads, enablement and deployment do not need
a restart. This document adds guidance; the MCP has no shutdown endpoint and
health remains a read-only tool.

## Find the normal close route

`MainWindowHandle == 0` does not mean that Vortex has no windows or cannot close
normally. Windows can enumerate hidden top-level windows belonging to the exact
Vortex main process. A reviewed native helper can post ordinary `WM_CLOSE`
(`0x0010`) to those windows without mouse or keyboard automation. A successful
PostMessage reports that the request was queued, not that Vortex exited.

Multiple windows are not an automatic blocker. There is no universal requirement
for exactly one window or a particular class-name count. Record the current
window handles and their owning PID; scope every post to the freshly verified
main process and reject identity drift. Never broadcast to other processes.

Capture and compare process creation times using the same native representation.
CIM can truncate to microseconds while .NET retains 100-nanosecond ticks. Comparing
those values directly can falsely report PID reuse. If both are needed, pin and
recheck each separately; do not round timestamps or add a tolerance to admit drift.

The installed `vortex-mod-lifecycle` skill's `references/native-lifecycle.md`,
section **Hidden Vortex windows**, is the canonical agent procedure. On the
maintained Windows workspace, the inspected mechanism example is
`D:/Modding/Nexus/tools/modding/vortex-agent/native-fixture-close.ps1`.
That script deliberately accepts fixture identities and refuses ordinary Vortex.
It is an implementation reference, not a command to replay against the real
profile or weaken by removing its fixture checks.

For an ordinary authorized restart, prepare and inspect a separate task-owned
native helper with fresh fixed targets and a new receipt. Reuse the example's
EnumWindows / GetWindowThreadProcessId / PostMessage mechanism; bind it to the
ordinary host's actual identity instead of copying an old fixture PID or receipt.
The absence of a shutdown tool in MCP is not, by itself, a reason to ask the user
to close Vortex manually. Inspect the supported native route first.

## Bind the operation before posting

1. Confirm restart authorization and coordinate the lifecycle window with other
   active tasks. Retain current profile/game/root identities and protected-state
   evidence. Reconcile pending or unknown operations; a restart does not clear
   their receipts or interlocks.
2. Verify that the game is stopped and no install, download, deployment, collection
   batch or other competing operation is active. Check dialogs and pending changes
   through allowlisted current state. Preserve unrelated mods and profile flags.
3. Pin the main process PID **and generation/creation identity**, executable path,
   executable/package hashes and matching installed source contract. Distinguish
   the main process from renderer/helper processes. Recheck these immediately
   before the native close request; PID alone is reusable.
4. Check the updater's current staged/pending state through the inspected
   allowlisted route. Normal shutdown can install a staged application update.
   Restart authorization does not silently approve an application upgrade; hold
   an unexpected update for separate review.
5. Prepare a bounded task-owned attempt receipt before posting. Retain sanitized
   PID/generation, source/helper hashes, targeted window identities, posted counts,
   deadline and observed outcome. An existing attempt requires reconciliation,
   rather than blind replay with another PID or output directory.
6. Enumerate hidden top-level windows, check each target's PID again, and post
   ordinary WM_CLOSE only within the admitted scope. Use a bounded wait. If no
   target is found or the host refuses to exit, preserve the receipt and inspect
   the cause. Never fall through to force termination or an invented `--quit` flag.

The reviewed 2.9.1 source routes BrowserWindow close through the normal renderer
close notification and `window-all-closed` finalization: flush pending writes,
wait for renderer exit, close the database, then quit. That source evidence is
version-specific; verify current source parity before adapting a helper. Do not
replace the ordinary path with a direct `app.exit`, force-kill or arbitrary IPC
endpoint. An already admitted renderer helper may use its separately inspected
window-close IPC, but this document grants no generic dispatch capability.

## Verify exit, then restart

Verify **every Vortex process exited**, not only the original main PID or its
visible window. Check the bounded shutdown log interval for normal finalization
and reconcile errors. A vanished HWND, accepted message or timed-out wait is not
shutdown proof. Do not touch plugins while any relevant process remains.

After verified exit, perform only the authorized maintenance: for example, move
the exact completed temporary helper outside active plugins or install the
verified adapter package. Preserve the permanent adapter, credentials, profile,
receipts and unrelated files. Start the verified executable with the admitted
ordinary user-data/profile context; do not create a research profile or invoke
install/download flags as part of restart.

Read fresh health after startup and compare the actual loaded adapter/package,
active profile/game/root identities, dialogs and protected state. Installed bytes,
source tests and loaded runtime acceptance are separate observations. Confirm a
retired helper is no longer active. Never launch the game to validate this route.
