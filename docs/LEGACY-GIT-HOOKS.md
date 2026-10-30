# Retire the known Rusty-hook templates

The coordination workspace had 19 active Rusty-hook 0.11.2 entrypoints and two
shell helpers. Ordinary checkout, merge or commit could trigger `cargo install`;
the only configured check was `cargo test`, although this workspace has no root
Cargo project. This is separate from the maintained tools repository's checks.

`tools/modding/retire-rusty-hooks.py` handles only that exact byte-pinned template
set. The default command is a read-only plan:

```powershell
python -B tools/modding/retire-rusty-hooks.py --repository ABSOLUTE_REPOSITORY
```

Before applying, stop other Git work in that repository and inspect effective
`git config --show-origin --get core.hooksPath`. It must be unset. The tool checks
local config but does not execute Git or resolve global/environment/conditional
configuration. Its plan is not proof that those other configuration layers agree.
Linked worktrees and reparse paths are outside this tool's supported layout.

Explicit `--apply` reserves a permanent attempt record in `.git`, copies every
original into a new inactive backup directory and verifies the copies before
retiring exact admitted leaves. It publishes a minimal `pre-commit` that runs
`git diff --cached --check`, with no installs, compiler, decompiler or native
operations. Unknown hooks, sample files and `.rusty-hook.toml` are preserved.
Task-specific tests still run in the authoritative source project.

Each leaf transition is checked; the whole multi-file migration is not atomic.
Failure can leave partial active hooks. The attempt and backups remain for
inspection, and another apply is refused. Do not delete the record to retry.
The retained originals permit a separately reviewed manual restoration; no
automatic rollback overwrites concurrent hook changes.
