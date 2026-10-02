# Scripts Layout

Skill-Sys management scripts are organized by role:

- `commands/`: Bun + TypeScript 6.x command implementations.
- `bin/`: POSIX launchers for user-facing commands.
- `bin/windows/`: PowerShell and CMD launchers.
- `ops/`: operational shell scripts for hooks, cron, branch protection, link
  linting, and global sync helpers.
- `lib/`: shared low-level TypeScript helpers.
- `modules/`: internal domain modules used by commands.

`commands/skill-sys.ts` is the primary public CLI surface.
`commands/skillpool.ts` remains the compatibility backend for install, update,
doctor, and validate.

Keep new management-system code out of the root `scripts/` directory. The only
remaining root files are TypeScript entrypoints and helpers.

## Operational Helper Scope

The packaged CLI launchers need Bun on `PATH`. Operational helpers are separate
maintainer tools; they are not required for the synthetic demo or project-local
installation. Review a helper and its target before invoking it.

`install-git-hooks.sh` configures a local checkout only when `.githooks` is
present; the public export does not ship hooks, so it exits without changing Git
configuration. Git-pull and global-sync wrappers require a suitable source
checkout and can write provider skills into user directories. The public engine
contains no personal global-core catalog. Use the project-local projection and
install commands from the README for the packaged alpha journey.
