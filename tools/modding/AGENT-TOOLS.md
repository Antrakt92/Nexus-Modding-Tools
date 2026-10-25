# Tool routing

Start with the repository's `AGENTS.md`, [restoration](../../docs/RESTORE.md)
and [configuration](../../docs/CONFIGURATION.md). Tool availability does not
authorize a publication, installation or other external effect.

| Work | Entry point | Boundary |
| --- | --- | --- |
| Public Nexus metadata | `nexus-cli/nexusmods.ps1` | Check status/errors/pagination; partial JSON results may exit 0 |
| Running Vortex inspection | `vortex-agent/session.mjs inspect` | Curated authenticated reads, no restart |
| Reviewed enable/deploy queue | `vortex-agent/session.mjs plan FILE` | Offline by default; `--apply` is explicit and receipts must verify |
| Nexus download-only acquisition | Existing adapter `download_nexus` | Exact file/context pins; no automatic installation |
| New local/native installation | Separate reviewed workflow | Generic adapter installation remains refused |
| Nexus release preparation/upload | `nexus-publish/publish.py` | Offline default; explicit publication and persistent uncertainty ledger |

All paths above are relative to this directory. Runtime paths derive from the
repository or explicit absolute environment overrides; no personal agent home
or game directory is required. Credentials remain in local Windows stores.

Native host, local package, deployment disk and gameplay checks establish
different facts. Promise resolution or a unit test is not a gameplay result.
Never add generic dispatch or bypass an uncertain-operation interlock.
