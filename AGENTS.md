# Nexus Modding Tools

Windows tooling for Nexus research/publication and guarded Vortex automation.
The repository is a source and recovery project, not a mod collection or account
backup. Read README.md, docs/RESTORE.md and docs/LICENSES.md before release work.

- Preserve unrelated work. Inspect status before edits and publication; stage
  specific files. Run checks locally; do not dispatch hosted CI without a request.
- Never commit keys, cookies, DPAPI blobs, account/config exports, Vortex databases,
  game/mod archives, crash dumps, runtime receipts or node_modules. Configuration
  examples contain placeholders only. Review the complete staged tree before push.
- The adapted Vortex component is GPL-3.0-only. Preserve upstream licenses and
  exact source/dependency pins; do not describe the complete project as MIT.
- Never launch games, force-close Vortex or alter game/staging files directly.
  Resident reads/download-only/enable/deploy do not require a restart. Native
  installation remains refused by the adapter until a no-replacement contract is
  proved. Do not add generic dispatch, arbitrary task code or unsafe install APIs.
- Keep credentials local to the operating-system credential store. A restored
  computer must initialize its own local bearer and Nexus authentication.
- Check dependencies before changes; prefer pinned verified upstream inputs.
  Keep public output portable and defaults dry-run/offline. Restoration must not
  overwrite unrelated existing files or configure clients without an explicit flag.
- Match runtime verification to the affected layer. Unit tests do not prove live
  Vortex installation or game behavior. Keep pending live checks explicit.
