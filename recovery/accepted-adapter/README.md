# Historical accepted adapter source

These are the exact maintained source files associated with the earlier
native-tested adapter package. Their SHA-256 values match `provenance.json`.
The runtime executable bundle and credentials are not included here.

This is a comparison/recovery reference, **not the current portable build source**.
It deliberately preserves the original absolute paths and historical source
target instead of rewriting evidence. Do not run its installer/build entrypoints
on another machine or overlay it onto the maintained tooling automatically.

Build the current adapter from `tools/modding/vortex-agent` using the documented
portable workflow. The accepted snapshot exposed 15 client tools and kept
installation disabled; the maintained source adds a narrow read-only
collection-health observation. Current source tests and native-host verification
must be assessed separately from this earlier acceptance.

The upstream and adapted code remain covered by the repository's GPL-3.0-only
license. No Vortex database, live operation receipt, account export, bearer or
game/mod payload is part of this snapshot.
