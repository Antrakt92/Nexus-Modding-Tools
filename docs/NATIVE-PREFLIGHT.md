# Read native preflight observations

Adapter 1.1.0 adds `read_native_preflight`. It reads the active context, native
deployment-target table, actual application version and updater state. It does
not install mods, change settings, check for updates or restart Vortex.

```powershell
node tools/modding/vortex-agent/bridge.mjs --call read_native_preflight '{}'
```

The MCP input is exactly `{}`. Extra fields are refused. The permanent extension
must contain the new tool; source edits or a provenance-only sync do not load it.
After one verified adapter upgrade, these reads need no temporary extension or
host restart. A client with an older tool list can use the bridge command and
refresh its MCP discovery separately.

## Returned observations

- `context`: active game/profile, canonical game/staging/download paths and their
  filesystem identities, using the same Node `dev:ino` format as health.
- `appVersion`: `{available:true,value:...}` from the application's native getter.
  The static `health.targetVortexVersion` field is not a live version observation.
- `deploymentTargets`: up to 32 `{typeId,path,sameAsDefault}` entries. The default
  type ID is the empty string. Preserve aliases: ENB and DInput can name the same
  game directory even when no installed mod uses those types. Equal paths do not
  establish ownership, source admission or permission to install.
- `updater`: `{available:true,state,sequence}` from its native status getter.
  Only the fixed state and sequence are returned; messages, release notes, URLs,
  release payloads and history are omitted.

The fixed native calls are `window.api.app.getVersion()` and
`window.api.updater.getStatus()`. Each has a two-second wait budget and an explicit
deadline check. Late rejection is observed; the tool never retries a getter.
JavaScript event-loop blocking can delay timer delivery, so this is not a
hard real-time guarantee.

Context and the complete canonical target table are sampled again after awaits.
Drift refuses the entire observation. A missing, rejected, malformed or timed-out
getter produces `{available:false,code:...}` and overall `status:"partial"`.
Missing updater data never becomes `idle`; missing version data never becomes the
static health label. Unsafe target tables refuse rather than silently omit rows.

## Limits

`status:"ok"` means the requested metadata was available and matched the final
samples. It does not mean a lifecycle operation is approved. In particular, an
observed `staged` updater needs review before a separately authorized shutdown.
The response always states:

```json
{
  "snapshotAtomic": false,
  "nativeEffects": false,
  "shutdownPermit": false,
  "sourceAdmissionVerified": false
}
```

These are point-in-time observations, without a queue lease or ownership lock.
The tool does not hash payloads or inspect arbitrary target directories. A native
capture still needs fresh source, physical baseline, process/root/temp identity
and independently reviewed exact target bindings. See the
[capture contract](READ-CAPTURE-PREPARATION.md) and
[authorized restart procedure](AUTHORIZED-RESTART.md).

## Local verification

Run the producer and serialization tests, then the built HTTP/stdio wire tests
and package-provenance checks. The wire fixture supplies its own native window;
only a call through the installed Vortex adapter establishes runtime availability.
Test coverage includes foreign-realm plain objects, hostile descriptors/proxies,
all updater states, withheld private fields, timeouts and context/map drift.
