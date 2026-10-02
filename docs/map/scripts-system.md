# Scripts System Map

This map captures the current root `scripts/` system after the incremental
refactor waves toward standardized, testable helpers and TypeScript 6.x script
internals.

## Scope

- In scope: root `scripts/` CLIs, wrappers, and shared helper modules.
- Out of scope for this pass: the legacy/private-overlay
  `skills/writing-skills/scripts/` contract path, except where existing tests
  reference root script behavior.

## Entrypoints

- Package scripts call `scripts/commands/skill-sys.ts` as the primary
  public CLI. `scripts/commands/skillpool.ts` remains available with
  `scripts/commands/universal-contract.ts`, `scripts/commands/doctor-all.ts`,
  `scripts/commands/smoke-adapters.ts`, and documentation linters.
- POSIX wrappers such as `scripts/bin/skill-sys`, `scripts/bin/skillpool`,
  `scripts/bin/ensure-skill`, and `scripts/bin/sync-skills` exec the matching
  official script file through Bun.
- PowerShell and Batch wrappers exist for portable on-demand installation and
  bootstrapping workflows.

## Folder Layout

- `scripts/commands/*.ts`: public Bun CLI implementations for repository
  management commands.
- `scripts/bin/*`: POSIX user-facing launchers that exec the matching command
  implementation.
- `scripts/bin/windows/*.{ps1,bat}`: Windows PowerShell and CMD launchers.
- `scripts/ops/*.sh`: operational shell scripts for hooks, cron, branch
  protection, link linting, and global sync helpers.
- `scripts/lib/*.ts`: shared low-level helper modules used by multiple commands.
- `scripts/modules/skill-sys/*.ts`: public CLI registry and small skill-sys
  helpers.
- `scripts/modules/skillpool/*.ts`: private `skillpool` implementation modules.
- `scripts/modules/global-core.ts` and
  `scripts/modules/skill-metadata-lib.ts`: private shared domain modules.
- root `scripts/*` files: official TypeScript entrypoints and helpers.

## Hotspots

- `scripts/commands/skill-sys.ts` is now the primary public CLI shell and
  command simplification layer.
- `scripts/commands/guard-repo-visibility.ts` is the fail-closed GitHub
  visibility guard for the base/public-engine repo; `validate:release` and
  `ci:checks` call it without the publication override.
- `scripts/commands/skillpool.ts` remains the compatibility backend for
  existing automation.
- `skillpool` command behavior is split across typed modules for install,
  doctor, upgrade, source layout validation, cache handling, checksum
  verification, lifecycle copy, and adapter/profile resolution. These internal
  modules live under `scripts/modules/skillpool/` so the root keeps only the
  public `scripts/commands/skillpool.ts` entrypoint.
- `scripts/commands/skill-metadata.ts`,
  `scripts/commands/skill-lifecycle.ts`, and
  `scripts/commands/universal-contract.ts` are official command surfaces. This
  base repo currently validates nearby behavior through package governance,
  registry surface, schema, boundary, and skillpack-contract tests rather than
  through the retired `tests/skills/scripts/` overlay suite.
- `scripts/commands/sync-skills.ts`, `scripts/commands/doctor-all.ts`,
  `scripts/commands/source-checksum.ts`, and
  `scripts/commands/ensure-skill.ts` repeated small filesystem, command-runner,
  CSV, hash, and skill-directory helpers before this refactor.
- `scripts/modules/global-core.ts`, `scripts/commands/sync-global-core.ts`,
  `scripts/commands/smoke-adapters.ts`, `scripts/commands/install-skills.ts`,
  and `scripts/commands/upgrade-project.ts` were a second low-risk cleanup
  wave for small JSON, argument, and command-runner reuse.
- `scripts/commands/quick-install.ts`, `scripts/commands/bootstrap-skills.ts`,
  `scripts/commands/publish-skill.ts`, and
  `scripts/commands/release-prepare.ts` now expose import-safe entrypoints and
  testable helper functions; `scripts/commands/release-verify.ts` exposes the
  release manifest/BOM verification gate used before CI signing. High-risk
  operations remain explicit and guarded by CLI flags and dry-run semantics.
- The next scripts-system roadmap is to harden install/release as a verified
  transaction before adding provider projections. Planned surfaces include
  semantic evals and explainable digest sync.
  State-safety doctor checks, sensitive skill payload scanning, exact depth-1
  fetch with commit-keyed source cache, and staged install swaps with
  partial-transaction doctor detection are now active gates. The shared
  legacy/private-overlay `artifact-surface.json` compatibility registry and the
  base repo's explicit `artifact-surfaces/*.json` public surfaces now feed source
  checksum, release manifest, Skill BOM source checksum, and release artifact
  verification. `verify-origin` now covers local Git ref/commit, source
  checksum, manifest, and Skill BOM checks while failing closed for unsupported
  provenance policy. Provider matrix, projection build/validation, semantic
  eval, semantic audit, and budget doctor commands are available command
  surfaces, but the current public package `ci:checks` gate does not run them.
  See
  `docs/specs/current-system.md`, `docs/roadmap.md`, and
  `docs/specs/release-verification-provider-projection.md`.
- Parser hardening is now standardized across touched TypeScript CLIs:
  unknown options fail, missing values fail, and help paths do not silently
  accept unrelated flags.
- Path safety guardrails are enforced in command and module boundaries:
  adapter/profile/app/skill names reject traversal-style values, and install
  targets are constrained to remain inside the selected project root.
- `scripts/commands/skill-change-guard.ts`,
  `scripts/commands/markdown-link-guard.ts`, and
  `scripts/commands/markdown-strict-batch-fix.ts` are the official guard and
  Markdown maintenance paths.

## Standard Helpers

- Official helper modules are TypeScript (`scripts/lib/*.ts`).
- `scripts/lib/args.ts`: small CLI argument helpers that do not own full command
  parsing.
- `scripts/lib/command.ts`: Bun process execution with consistent capture and
  failure formatting.
- `scripts/lib/date.ts`: UTC date helper for release and lifecycle surfaces.
- `scripts/lib/files.ts`: JSON, directory copy, recursive listing, file hashing,
  and directory digest helpers with shared skip rules.
- `scripts/lib/git.ts`: default repository/remote detection with injectable
  runners for testability.
- `scripts/lib/skill-dirs.ts`: skill directory listing, removal, copying, and
  lifecycle ledger placement.

## Refactor Boundaries

- Keep public CLI flags, command behavior, and generated outputs stable.
- Prefer extracting proven repetition over introducing a CLI framework.
- Keep low-risk script migrations and `skillpool` helper modules in typed
  slices rather than broad rewrites.
- Keep cross-platform wrappers under `scripts/bin/`; test them with smoke/static
  checks rather than replacing them.
- Keep side-effect-heavy git/release flows (`clone`, `pull`, `commit`, `tag`,
  `push`) covered by dry-run and injected-runner tests before any future
  behavior change.

## Verification

- Current checked-in tests live at `tests/*.test.ts`; there is no checked-in
  `tests/skills/scripts/` tree in this base repo.
- Relevant current coverage includes `tests/registry-surface.test.ts`,
  `tests/package-governance.test.ts`, `tests/skillpack-contract.test.ts`,
  `tests/install-hardening.test.ts`, `tests/projection-gate.test.ts`,
  `tests/cache-integrity.test.ts`, and the scan/public-surface tests.
- `package.json#scripts.validate:publish` extends `validate:release` with
  projection build/validation, release smoke, origin verification, registry
  surface validation, and a final npm pack audit.
- Final verification for current public package changes should include targeted
  tests for touched command surfaces, `bun test`, `bun run validate:ci`,
  `bun run validate:release` when GitHub visibility checks are available, and
  smoke checks for touched CLIs.
- `source-checksum` must keep its historical ignore policy: ignore `.git`, but
  include runtime-looking directories such as `.venv` in the digest.
