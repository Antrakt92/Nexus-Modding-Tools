# Explicit extraction ownership

This prepares an internal job-bound extraction factory. It is not installed in
Vortex, connected to MCP or an alternative command for installing a mod. The
native executor, durable admission and filesystem ownership gates still apply.

The owner captures one immutable operation/job/request/lifetime binding and one
archive/destination tuple. `createChildOwner(binding, spec)` returns an opaque
frozen capability with `cancel()`, `seal()` and `read()`. The prepared
`Zip.createOwned(owner)` exposes only a frozen extraction-only adapter. Binding
labels cannot substitute for the capability, and an owned call never falls back
to an ordinary unowned Zip call.

The spec uses bounded ASCII Windows drive paths. These are lexical tuple checks,
not archive integrity, filesystem identity or empty-directory admission. Creating
an owner and reading its status do not scan the workspace.

## Fixed first family

The initial family has four total launch attempts, one physically active child
and no nested archive tuples. Retrying is permitted only after the previous
child and all its pipes have been observed closed. A wrapper result, delay,
timeout or PID disappearance cannot substitute for those observations.

An attempt is recorded before entering spawn and is never refunded. The exact
returned child is retained before attaching the
[child-resource observer](CHILD-TERMINAL-OBSERVER.md). A synchronous spawn throw
or uncertain attachment holds the owner; absence of a returned handle does not
manufacture closed resources.

The owned adapter refuses legacy function overloads and accepts only the exact
bound paths and one own data option `{ssc:false}`. Internal options use a new
null-prototype object, preventing the upstream switch serializer from reading
inherited keys. Raw switches, wildcards, output overrides and caller-selected
executables are not inputs. The reviewed package chooses the extractor binary.
The fixed argv includes `-y`: this is **not** a no-overwrite guarantee. Exclusive
empty destination ownership and safe retry cleanup remain separate prerequisites.

Password callbacks and prompting are outside this first family. Progress remains
a trusted internal callback; it is not arbitrary code accepted from MCP and does
not receive writable stdin or cancellation authority. Ordinary `new Zip()` and
its legacy methods retain their existing behavior.

## Cancel, seal and status

`cancel()` records cancellation and seals new launches synchronously. `seal()`
only forbids future launches. Neither method kills a process, cleans up a path,
releases file fences or proves an operation successful. Existing children remain
observed; zero exit does not erase cancellation or wrapper failure.

Every supported cancellation route must call the owner before requesting kill
or canceling a caller's promise. Canceling an arbitrary external Bluebird branch
does not automatically revoke the owner. A public callback or timeout must seal
the owner before invoking external code; its `finally` is not a terminal signal.

Owner reads are bounded over at most four actual child observations. They do not
scan a workspace or trust caller-provided event rows. A fresh factory or renderer
is not a replay solution: the future executor must mint exactly one owner after
its existing consumed-ID and durable admission gates. This component is not a
second job catalog or cross-generation deduplication ledger.

## Why context is explicit

The installed Bluebird 3.7.2 JavaScript was tested under local Node 24.20.0 with
two AsyncLocalStorage scopes. Callbacks registered under A and B both observed
A through the library's shared scheduler. This is a library mechanism experiment,
not a traced Vortex job. It is sufficient to reject ambient context as authority.
The owner is captured by the owned instance and every retry closure; no global
Bluebird setting is changed.

## Assembly and acceptance

The prepared factory patches target the exact pinned node-7z source after the
[error-close patch](NATIVE-EXTRACTOR-CLOSE-PATCH.md). Their manifest must bind
every upstream input/output and all required relative copies, including the
ownership module, observer and GPL terms. A partial package or a capability from
another module instance must refuse, never become a legacy invocation.
The native owner must come from the same packaged
`node-7z/util/owned-extractor-scope.cjs` instance used by `Zip.createOwned`;
an owner minted from a separate repository/build copy is not interchangeable.

### Verified component fixture — 31 October 2026

An additional isolated run used the actual installed `7z.exe`, the thirteen
reviewed SDK runtime files with the prepared patches, and pinned Bluebird 3.7.2
under Node 24.20.0. It extracted one own ZIP into a newly created empty test
directory: exit 0, no reported errors, the expected 28-byte file and matching
SHA-256. The owner recorded one child and closure of all three pipes.

The executable SHA-256 was
`fcd699098397e8981104c51afe32f4527cb6f02a5b64cbb6b2581f4749808e8c`;
the adjacent DLL, archive and source pins matched before and after the run.
This used in-memory module resolution, not a rebuilt Vortex package. Directory
identity was checked before/after; no exclusive directory reservation or archive
seal was established by this fixture. No managed Vortex or game path was accessed.

A separate [archive/temp custody fixture](ARCHIVE-TEMP-CUSTODY.md) subsequently
held the archive and temporary root throughout an actual SDK extraction and
passed the original root handle to the transfer library. It establishes the
normal path while the keeper survives; crash lifetime remains unproved.

Tests execute the actual composed SDK source with controlled Node child launches
in place of 7-Zip. The optional Bluebird fixture checks its independently pinned
runtime files. These checks do not establish full Vortex integration,
archive-byte admission, descendant termination or safe cleanup.
Native integration must use this owner for every attempted child. Its future
strict call site must refuse submodule instructions before `processSubmodule`;
the current host's fresh unowned `new Zip()` is not connected to this owner.

No installation, persistence or descendant guarantee is granted. The ordinary
MCP installation refusal remains in place until the complete native contract
passes isolated host acceptance.
