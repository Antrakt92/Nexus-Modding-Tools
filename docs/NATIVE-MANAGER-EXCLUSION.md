# Prepared install-manager exclusion

The exact-source `manager-exclusion.patch` follows `transfer-join.patch` against
Vortex v2.9.1, commit `c80326367cbe6d96621ad6cf4a5488ef49bac110`.
Its adjacent manifest pins original source, prerequisites, patch and output.
It is not installed and does not enable archive installation through MCP.
Never apply it directly to the installed application.

## Shared ownership

Managers created from the same loaded class share a random renderer-generation
nonce, a bounded set of legacy activity owners and one opaque exclusive owner.
The manager registry holds at most 32 instances and active legacy ownership at
most 4,096 calls. Neither has a timeout, automatic eviction or reset API.

`reserveNativeInstallExclusion()` synchronously checks legacy owners and pending,
active, native-core, dependency and optional-download state in every registered
manager, then publishes a new opaque owner without an await or callback. It does
not use the debug idle counter or `waitForIdle()`: the latter can resolve during
an active collection. The owner is checked by object identity and owning manager;
a serialized copy or an owner from another loaded class cannot pass.

The reservation is permanent in this preparation. There is no release API, new
native event, worker dispatch, registration or success result. It cannot yet be
used as a recurring installation interface. Binding the exact consumed request,
durable intent and terminal/custody proof is required before adding dispatch or
release. Renderer reload destroys in-memory ownership and is not reconciliation.

`getNativeInstallExclusion()` returns detached diagnostics with
`effectsAllowed:false` and `globalIdleVerified:false`; it exposes no owner.

## Persisted transfer markers

The final `native-transfer-marker-admission.patch` also reads each registered
manager's persisted transfer state before reservation and during owner checks.
A defined marker, including `false` or `null`, refuses admission. Missing optional
transaction/transfer records are allowed; malformed containers, accessors, hidden
or symbol entries, proxies and failed state reads are held. Plain records from
another realm and null-prototype records remain supported.

A refusal before reservation creates no owner and permits a later fresh check.
Once an owner has been issued, observed uncertainty permanently invalidates it
for the loaded class. Removing a marker cannot restore it. State getters may
reenter these checks: the outer check reads the sticky hold again after the
getter returns, and reservation rechecks ownership before publishing its owner.
Wrong-owner checks fail before invoking state getters.

This is a renderer-state observation, not a lease against other writers or proof
of persisted disk state. It writes no marker, clears no interlock and adds no
release, reset, recovery or native dispatch API.

## Existing manager routes

Ordinary installation reserves legacy ownership before queue admission and keeps
it through the existing observed core tail, mandatory cleanup and fallback.
An early callback, debug-map deletion or limiter queue clearing does not release
that ownership. An abandoned queue promise stays held.

Small delegating methods protect simulation, dependency/recommendation entrypoints,
the direct constructor dependency event, download/phase queueing, rule/session
updates, metadata-size work and phase/deployment promise scheduling. The original
method bodies and arguments remain in private delegates. Synchronous calls keep
ownership through their return; returned promises keep it through settlement.
A synchronous exception retains ownership because started work may have no
joinable tail. This conservative hold requires later reconciliation.

The dependency pipeline's public start method remains void, but internally returns
and observes the actual limiter chain. Clearing old pending/active maps cannot
make this still-running chain disappear. Orchestration is not put inside the
ordinary installation limiter, which would deadlock nested installs.

An unsolicited download-completion event does not enter guarded manager work or
throw into the event dispatcher while exclusion is held. Existing dependency
state prevents reservation in the first place. No delayed replay queue is added;
this handling does not cancel the upstream download itself.

## What remains outside this boundary

This covers the reviewed installation manager, not all lifecycle effects.
The [paired lifecycle handler patches](NATIVE-LIFECYCLE-HANDLERS.md) prepare
shared admission for `onRemoveMods` and `onAddMod/create-mod`.
The [deployment/purge/refresh additions](NATIVE-DEPLOYMENT-LIFECYCLE.md) prepare
shared ownership for their known core routes. Arbitrary Redux writes, extension
hooks and other extensions still need independent admission. A permanent class
reservation does not reserve staging directories or prove file ownership.

The next integration must bind original request/job/packet/lifetime to the durable
journal, extend exclusion to those competing effects, admit only new disabled
registration and retain exclusion through worker closure plus registration
verification. A worker's successful release alone cannot prove registration.
No-replacement, native terminal, global idle and installation-permit manifest
claims remain false.

## Local verification

```powershell
$env:VORTEX_NATIVE_INSTALL_MANAGER = 'C:/ReviewedSource/InstallManager.ts'
node --test tools/modding/vortex-agent/native-manager-exclusion-patch.test.mjs
```

The suite applies the entire pinned patch series, strips TypeScript and executes
the trusted class with own API/promise stubs. It exercises real guarded methods,
constructor listeners, core/callback/cleanup tails, queue clearing, argument
forwarding, metadata completion and competing manager ownership. The preceding
archive pipeline is substituted in core-tail tests; no archive extraction or
native installation runs. This VM is a test tool, not a security sandbox.

Without the exact source, integration tests explicitly skip. The final composed
renderer passed the actual upstream typecheck and webpack build; see
[source qualification](NATIVE-SOURCE-ASSEMBLY.md). Installed renderer
acceptance and live event/UX behavior remain unverified. Unit tests do not turn
the source preparation into a loaded capability.
