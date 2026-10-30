# Clean up completed local work

After a verified release or completed task, clean up its confirmed temporary
output before reporting completion. Record retained, recycled and held items in
the existing task ledger; do not create another full backup or report tree.
Scheduled maintenance can catch missed cleanup using the same checks. The MCP
does not expose a general file-deletion or mod-removal operation.

## Choose candidates from evidence

Start with known task outputs: temporary archive extractions, disposable test
payloads, and extra download copies used to verify a published release. Preserve
the current release archive, corresponding source/build recipe, publication
proof and needed rollback inputs. A cache is eligible only when its retained
inputs and exact reconstruction procedure have been verified.

Check active tasks, imports, build recipes, fixtures, manifests, knowledge/evidence
pins and unresolved attempts before classifying a candidate. Use directory dates
only to prioritize inspection. Neither age, a temporary-looking name nor an equal
content hash proves a file is redundant.

**Never deduplicate source files by deleting a copy at a required path.** Relative
imports, license packaging, pinned helper templates and integration fixtures can
depend on separate files with identical bytes. Preserve Git-tracked files in every
worktree, source inputs, helper templates and test fixtures. If a fixture must be
migrated, update and verify its consumers in a separate reviewed change before
retiring the old input. A keeper copy alone does not migrate those consumers.

Installed mods, staging, game files, Vortex downloads/plugins, toolchains,
credentials, saves and unrelated dirty work are outside automatic scratch cleanup.
Use their owning lifecycle for separately authorized retirement. Do not close a
running host merely to make scheduled cleanup possible.

## Apply a finite recycle plan

1. Identify the completed owning task and inspect fresh Git status and active
   consumers. Skip unresolved or concurrently changing work.
2. List exact absolute targets, sizes, hashes/file generations, and verified
   retained keepers or reconstruction inputs. Restrict targets to the task's
   declared scratch roots. Do not use a recursive wildcard delete.
3. Resolve each target and its ancestors without following symlinks, junctions
   or other reparse points. Reject escapes, physical aliases to protected files,
   extra directory entries or changed target generations.
4. Persist and flush a per-target intent before the native operation, binding its
   task/attempt identity, exact target generation and retained inputs. An intent
   without a result blocks fresh attempts until reconciled, even if another file
   later appears at the same path. Recheck admission immediately before moving
   the exact target to Windows Recycle Bin through the supported native operation.
   Record the result or uncertainty without overwriting the original intent.
   Stop on uncertainty. Never fall back to permanent deletion or empty the Bin.
5. Verify retained inputs, evidence and Git state after the move. Record actual
   recycled paths/counts/bytes and held reasons in the existing ledger. Recycled
   bytes are not a measurement of newly available disk space.

## Scheduled checks

A local scheduled agent should inspect newly completed tasks and changed scratch
directories rather than hash the entire workspace every day. Retain one small
state file with the last check, processed release/task identities, completed
recycle actions and unresolved candidates. An interrupted recycle attempt needs
reconciliation before another action.

Remain quiet when there is no new actionable result. Report completed cleanup,
material errors or a new blocker once; do not repeat unchanged held candidates.
Automatic cleanup is a best-effort maintenance pass, not an exclusive lock on
other agents. Without fresh consumer/ownership evidence, leave the file in place.
