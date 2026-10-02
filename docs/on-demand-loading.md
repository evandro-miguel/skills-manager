# On-demand Loading (Maintenance Guide)

This document explains how on-demand skill loading works and how to safely
modify it.

## Scope

Feature entrypoint:

- `scripts/commands/ensure-skill.ts`

Wrappers:

- `scripts/bin/ensure-skill` (POSIX)
- `scripts/bin/windows/ensure-skill.ps1` (PowerShell)
- `scripts/bin/windows/ensure-skill.bat` (CMD)

Dependencies:

- `scripts/commands/skillpool.ts` (`install` subcommand)
- `adapters/*.json` (project labels; project targets resolve to `.agents/skills`)

## Runtime flow

1. Parse CLI arguments.
   - unknown options are rejected
   - missing option values fail fast
2. Resolve project directory.
3. Resolve app target:
   - explicit `--app`, or
   - `auto` using project markers:
     - `opencode` -> `.agents`, `.opencode`, or `.agent`
     - explicit labels such as `codex`, `claude-code`, and `antigravity` still
       install into `.agents/skills`
4. Reject the target if it resolves to user-level `~/.agents/skills`.
5. Check if `<target>/<skill>/SKILL.md` already exists.
6. If the requested skill is declared in a source-root `globals/core.json`
   (private-overlay/legacy compatibility), do not copy it into the project by
   default. It is managed through user-global sync.
7. If missing and project-local, execute:
   - `bun scripts/commands/skillpool.ts install --project ... --app ...`
     `--skills ...`
8. Re-check installation result and exit with success/failure.

## Source selection rules

Order:

1. If `--source` is provided, use it.
2. Else if `--repo` is provided, use repo mode (`--repo` + `--ref`).
3. Else default to local tool root (`.`).

Reason:

- local default is fast for developer workflows
- repo mode is explicit for remote/pinned installs

## Security controls

Supported flags in on-demand flow:

- `--verify-signed-tag`
- `--expected-source-sha256`
- `--allow-global-core-skills` for the rare case where a project intentionally
  maintains a local alternative to a global-core skill

These are forwarded to `skillpool install` and should be preferred in
production lock or pipeline environments.

Additional guardrails:

- app names and skill names must be safe identifiers (no path separators)
- adapter lookup rejects traversal-style labels
- project installs remain bounded to adapter target paths under project root
  through `skillpool` checks
- project installs refuse user-level `~/.agents/skills`, even if `--project`
  is accidentally set to the user's home directory
- the refusal is resolved-target only; do not expand it to block
  real `<repo>/.agents/skills` folders, including repos nested under `$HOME`
- global-core skills are skipped for project installs unless explicitly allowed
  as project-local alternatives

User-global skills must be synchronized through
`bun scripts/commands/sync-global-core.ts --source .`, which targets the
app-owned global folders declared in a source-root `globals/core.json` when that
private-overlay/legacy compatibility file is present.

## How to add a new app adapter

1. Add `adapters/<app>.json` with `targetPath` set to `.agents/skills` for
   project-local installs.
2. Add the app in `ensure-skill.ts`:
   - help text (`--app` list)
   - default fallback list (`args.apps`)
   - auto-detection markers in `detectApp()`
3. Validate with:
   - `bun run validate`
   - manual smoke install using `--app <new-app>`

## How to change auto-detection behavior

Main function:

- `detectApp(projectDir, candidates)` in `scripts/commands/ensure-skill.ts`

Guideline:

- keep deterministic order (`--apps`)
- avoid filesystem-expensive checks
- never infer from skill names; infer from project markers only
- keep project-local sync on `.agents/skills`; do not add project fan-out into
  `.codex/`, `.gemini/`, `.qwen/`, or `.claude/`

## Failure modes and troubleshooting

`Missing required argument: --skill`:

- pass `--skill <name>`

`Unknown app ... Missing adapter`:

- adapter file missing in `adapters/`

`Unknown option: --...`:

- flag typo or unsupported option; use `--help` for the current accepted flag set

`Invalid app '...': path separators are not allowed`:

- adapter/app label contains unsafe path segments and is rejected

`Skill is managed by global-core, not project-local`:

- run `bun scripts/commands/sync-global-core.ts --source .` for user-global
  folders instead of copying the skill into `.agents/skills`
- pass `--allow-global-core-skills` only when the project owns an intentional
  alternative version

`resolves to user-level .agents/skills`:

- do not use `~` or `$HOME` as the project directory for project installs
- rerun with a real repository path in `--project`
- keep using `<repo>/.agents/skills` for project-local skills; this error does
  not forbid project `.agents` folders
- use `sync-global-core` when the goal is Codex, Gemini CLI, Antigravity,
  Claude Code, Qwen, or OpenCode user-global sync

`Source skills failed universal contract check`:

- run `bun run validate` in source pool

`Install finished but skill entry was not found`:

- inspect `skillpool install` output for adapter path mismatch
- confirm adapter `targetPath` is `.agents/skills` and project root passed in
  `--project`

## Regression checklist (before merge)

1. `bun scripts/commands/ensure-skill.ts --help`
2. Temp project smoke:
   - create temp dir with one app marker (for example `.agent`)
   - run ensure for one existing skill
   - rerun ensure to confirm idempotent behavior
3. `bun run validate`
4. If `~/.config/opencode` changed, run:
   - `python3 ~/.config/opencode/scripts/opencode-audit.py`

## Design constraints

- Keep this command minimal: ensure/install one skill only.
- Do not duplicate install logic from `skillpool.ts`.
- Preserve cross-platform wrappers (`sh`, `ps1`, `bat`) for agent portability.
- Keep global-core skills in user-global folders by default, not in project
  `.agents/skills`.
