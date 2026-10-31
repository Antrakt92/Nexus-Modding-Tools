# Prepared removal and creation ownership

These paired source patches extend the [manager exclusion](NATIVE-MANAGER-EXCLUSION.md)
against Vortex v2.9.1, commit `c80326367cbe6d96621ad6cf4a5488ef49bac110`:

- `lifecycle-owner-bridge.patch` follows the manager patch and adds a fixed internal
  lifecycle producer API using the same renderer-class activity set and capacity.
- `lifecycle-handler-ownership.patch` updates the exact `eventHandlers.ts`; its
  manifest also requires that bridge. Apply each patch to its own pinned file.

They are not installed. No MCP installation/removal endpoint, new-mod registration,
release API or application upgrade is provided. Do not modify the installed app.

## Admission and completion

The public `onAddMod`, `onRemoveMods` and single-mod delegation keep their void and
callback interfaces. Their private bodies return the actual work promises. The
shared owner is acquired before Redux changes, flag changes, hooks or filesystem
calls; an exclusive owner refuses those effects. A refusal is delivered through
the existing callback/error channel rather than escaping into an event dispatcher.

Creation holds ownership through directory creation and callback observation.
Removal holds it through undeployment, file removals, completed-record updates,
callback observation and the final `did-remove-mods` hook. A callback can arrive
before this final hook; it is never a release permit.

The bridge releases only after successful tail settlement. Rejected tails and
unknown synchronous startup remain held; neither timeout nor callback can erase
that uncertainty. This is an internal ownership observation, not proof that native
or extension effects have stopped. No reset or failed-operation replay exists.

## Joined removal branches

The internal join helper waits for every already-started type/deactivation/removal
branch before propagating the first observed error. A synchronous factory failure
stops further scheduling and still joins earlier branches. Async activator
cancellation is awaited; a cancellation error cannot replace the primary error.

Partial removal now reports failure instead of unconditional callback success.
Successfully removed sibling records are still published after all branches join.
The old success-count batch condition could leave these records unflushed after
another mod failed. Each batch is removed from pending ownership before dispatch,
so an uncertain dispatch is not automatically repeated.

Callbacks deliver once. A throwing error callback or failed final hook cannot
replace an earlier operation error. Notification failures are observed without
creating an unhandled rejected tail. Cancelled operations retain normal notification
suppression; the ownership hold remains separate from notification policy.

## Remaining lifecycle gates

The [prepared deployment/purge/refresh stage](NATIVE-DEPLOYMENT-LIFECYCLE.md)
addresses the core queue, writer and refresh dependencies below. It remains
source preparation, with native/imported-helper acceptance still open.

This is not host-wide exclusion. General deployment, purge, refresh/profile changes,
Redux writers and asynchronous extension listeners still require integration.
The source audit identified these next dependencies:

- Deployment scheduling must own pending `schedule`/`runNow` intents as well as
  the actual writer. Debouncer callbacks precede its final reschedule handling;
  `wait()` is not proof that every future run has finished.
- Keep the deployment owner through post-lock `did-deploy` and `bake-settings`,
  not merely through the activation lock. Single-mod cancel work is still unjoined.
- Purge effect roots are also called outside purge events. Its parallel manifest
  and recovery writes require joins before ownership can be released.
- `onGameModeActivated` and `onPathsChanged` discard refresh/purge promise tails;
  incomplete-install cleanup also writes staging outside these handlers.

The audit uses pinned installed manager/event/index sources; the additional purge,
activation and Debouncer files were reviewed in the official pinned Git tree.
Installed parity for those additional files is not yet established. No native
acceptance or broader lifecycle guarantee follows from this preparation.

## Verification

```powershell
$env:VORTEX_NATIVE_INSTALL_MANAGER = 'C:/ReviewedSource/InstallManager.ts'
$env:VORTEX_NATIVE_EVENT_HANDLERS = 'C:/ReviewedSource/eventHandlers.ts'
node --test tools/modding/vortex-agent/native-lifecycle-handler-patch.test.mjs
```

Tests apply exact patches and execute the trusted classes/functions with own API,
filesystem and promise stubs. Original-source comparisons reproduce fail-fast
undeployment, false partial-removal success and missing record batches. They also
exercise delayed hooks/cancellation, callback failures, exclusive refusal and
uncertain batch dispatch. No native removal, game, staging or Vortex session runs.
The VM is a test mechanism, not a security sandbox. Full application build/typecheck
and installed renderer/event acceptance remain open.
