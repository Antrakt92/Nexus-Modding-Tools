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
`onRemoveMods`, `onAddMod/create-mod`, general deployment, Redux writes, extension
hooks and other extensions require their own shared admission. A permanent class
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

Without the exact source, integration tests explicitly skip. Full upstream
build/typecheck, installed renderer acceptance and live event/UX behavior remain
unverified. Unit tests do not turn the source preparation into a loaded capability.
