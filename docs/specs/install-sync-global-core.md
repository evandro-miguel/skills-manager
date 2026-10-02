# Install, Sync, And Global Core

This is the as-built spec for the current install and sync system.

Boundary note: `globals/core.json` and `artifact-surface.json` are
legacy/private-overlay compatibility surfaces in this spec set. The
base/public-engine repository does not carry real global-core or root skill
catalog content; those private skills and globals live in User Skill Roots,
optionally versioned in any repository chosen by the user.

## Owned Surfaces

Primary implementation surfaces:

- [scripts/commands/skillpool.ts](../../scripts/commands/skillpool.ts)
- [scripts/modules/skillpool/install.ts](../../scripts/modules/skillpool/install.ts)
- [scripts/modules/skillpool/doctor.ts](../../scripts/modules/skillpool/doctor.ts)
- [scripts/modules/skillpool/upgrade.ts](../../scripts/modules/skillpool/upgrade.ts)
- [scripts/modules/skillpool/validate.ts](../../scripts/modules/skillpool/validate.ts)
- [scripts/modules/skillpool/cache.ts](../../scripts/modules/skillpool/cache.ts)
- [scripts/modules/skillpool/entry.ts](../../scripts/modules/skillpool/entry.ts)
- [scripts/commands/ensure-skill.ts](../../scripts/commands/ensure-skill.ts)
- [scripts/commands/quick-install.ts](../../scripts/commands/quick-install.ts)
- [scripts/commands/sync-global-core.ts](../../scripts/commands/sync-global-core.ts)
- [scripts/commands/sync-skills.ts](../../scripts/commands/sync-skills.ts)
- [scripts/modules/global-core.ts](../../scripts/modules/global-core.ts)
- [scripts/modules/home-agents-guard.ts](../../scripts/modules/home-agents-guard.ts)

Configuration surfaces:

- `adapters/`
- `profiles/`
- `globals/core.json` (compatibility global-core contract; real values live in User Skill Roots or user-chosen sources)
- [schema/lockfile.schema.json](../../schema/lockfile.schema.json)
- lockfile shape documented below

## Project Install Model

Project-local installs use one shared target:

```text
<project>/.agents/skills
```

Adapters preserve the app label for reporting and compatibility, but current
project installs do not fan out into app-specific project folders such as:

- `.codex/skills`
- `.claude/skills`
- `.gemini/skills`
- `.qwen/skills`

This is intentional current behavior. Provider projection work must preserve
this boundary until a later spec explicitly changes it.

## Lockfile Install

`skillpool install` accepts a lockfile mode and a direct CLI mode.

Current lockfile shape:

```json
{
  "repo": "git@github.com:org/skills.git",
  "ref": "v1.0.0",
  "policy": {
    "requireRefExists": true,
    "requireSignedTag": false,
    "expectedSourceSha256": "<sha256>"
  },
  "installs": [
    { "app": "codex", "profile": "core" }
  ]
}
```

The runtime validator also accepts `policy.allowGlobalCoreProjectSkills`, and
`schema/lockfile.schema.json` models it as an optional boolean so lockfile
schema checks and install-time policy validation agree.

Install validation currently runs before copy:

- source layout resolution
- universal contract validation
- metadata audit
- lifecycle audit
- lockfile shape validation
- minimum pool version check when configured
- ref existence check when configured
- signed tag check when configured
- source commit check when `requireSourceCommit` and `sourceCommit` are
  configured
- source checksum check when configured, using the legacy/private-overlay
  `artifact-surface.json` compatibility contract or the base repo's explicit
  `artifact-surfaces/*.json` public surfaces
- release artifact policy check when configured, rebuilding manifest/BOM from
  the same artifact surface
- fail-closed rejection for required Cosign/GitHub attestation policy because
  install does not yet verify provenance bundles locally

## Direct Install

Direct install routes through `skill-sys add` or compatibility
`skillpool install`.

Examples:

```bash
bun scripts/commands/skill-sys.ts add git@github.com:org/skills.git \
  --project /path/to/project \
  --agent codex \
  --profile core \
  --ref v1.0.0
```

```bash
bun scripts/commands/skillpool.ts install \
  --project /path/to/project \
  --app codex \
  --profile core \
  --repo git@github.com:org/skills.git \
  --ref v1.0.0
```

## Current Copy Semantics

`skillpool install` requires an explicit provider projection source by default.
Pass `--projection-dir <dir>` to install generated provider output after
verifying `projection.meta.json`, canonical digest, projection digest, and any
lockfile `expectedProjectionDigests` policy. Canonical raw skill directory copy
is still available only through the explicit `--legacy-raw-install`
compatibility flag.

Current copy behavior:

- `copyDirectory` rejects symlinked source directories.
- `copyDirectory` rejects symlinked entries inside skill directories.
- skipped entry names include `.git`, `.venv`, `node_modules`, `__pycache__`,
  `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.next`, `dist`, and `build`.
- the installer writes `.skill-lifecycle.json` into the target when the source
  lifecycle ledger exists.
- project-global-core skills are skipped by default unless explicitly allowed.

Current state file:

```text
<project>/.skills.state.json
```

Install copies are staged in `.skill-sys-tmp/<install-id>`, verified by digest,
and then swapped into place. Existing managed targets are moved under
`.skill-sys-backup/<install-id>` as a one-version rollback payload before the
new target is renamed into place. State is written last with an atomic file
replace.

Default state uses schema v2 minimal mode:

- `schemaVersion: 2`
- `mode: "minimal"`
- `updatedAt`
- source repo/ref/checksum metadata
- relative installed targets
- per-skill digests
- relative lifecycle target paths

Minimal state must not contain local absolute paths.

Debug state can be written only with `--debug-state`. In debug mode, the file
also includes a `debug` block with local source path, policy, absolute install
paths, and lifecycle copy details for troubleshooting.

Current rollback command:

- `skill-sys rollback --project <dir> --install-id latest` restores the latest
  completed backup under the selected target
- `--dry-run` prints planned restore actions without writing
- the command restores from completed backup payloads and reconciles managed
  target state digests for restored skills
- debug state intentionally contains local absolute paths and must not be used
  as the default mode

## Doctor

`skillpool doctor` compares the lockfile install plan against the target.

Current checks include:

- target missing
- skill missing
- extra skills
- strict hash drift when requested
- orphan `.skill-sys-tmp` transaction directories
- pending `.skill-sys-backup` directories without a completion marker

Commands:

```bash
bun scripts/commands/skill-sys.ts doctor --project /path/to/project
bun scripts/commands/skill-sys.ts doctor --project /path/to/project --strict-hash
bun scripts/commands/skill-sys.ts doctor --project /path/to/project --state-safety
bun scripts/commands/skillpool.ts doctor --project /path/to/project
```

`doctor --state-safety` checks:

- `.skills.state.json` is ignored by a repo-owned `.gitignore` rule when the
  project is a Git worktree
- state JSON parses
- `schemaVersion` is `2`
- `mode` is `minimal` or `debug`
- minimal mode does not contain local absolute paths
- path-like fields do not escape the project with `..`
- path-like fields do not point into the user's home directory

Current limitation:

- provider duplicate/scope/budget doctors are not implemented

## Sensitive Payload Gate

`skillpool install` scans each selected source skill before any skill directory
is copied. The scan blocks known credential filenames and secret-shaped
content, reports paths relative to the source, and does not print secret
values.

`sync-skills` applies the same scan to selected source skill directories before
copying into a target skill root. This protects global-core sync and lower-level
skill folder synchronization from copying environment files, key material,
browser session state files, local databases, or matching token-shaped content.

Commands:

```bash
bun scripts/commands/skill-sys.ts scan-sensitive --source .
bun scripts/commands/sync-skills.ts --from ./skills --to /target/skills --dry-run
```

## Upgrade

`skillpool upgrade` updates the lockfile ref and can reinstall.

Current behavior:

- updates repo/ref metadata
- can refresh cache
- can invoke install after lockfile update

Commands:

```bash
bun scripts/commands/skill-sys.ts update --project /path/to/project --ref v1.1.0
bun scripts/commands/skillpool.ts upgrade --project /path/to/project --ref v1.1.0
```

## On-Demand Skill Install

`ensure-skill` installs one skill into a project when it is missing.

Current behavior:

- supports app auto-detection from project markers
- rejects unsafe app and skill names
- rejects user-level `~/.agents/skills`
- short-circuits if the skill is already installed
- blocks global-core skills by default
- delegates final installation to `skillpool install`

Command:

```bash
bun scripts/commands/ensure-skill.ts \
  --project /path/to/project \
  --skill writing-skills \
  --app auto
```

## Global Core Sync

`globals/core.json` defines the user-global core skills for a
user-chosen source such as a User Skill Root; the base repo documents the
contract but does not carry real private global-core sets.

Current behavior:

- resolves default apps from a source-root `globals/core.json` when present
  (private-overlay/legacy compatibility)
- supports app selection with `--apps`
- validates target paths against allowlisted app roots
- rejects symlinked target parents
- replaces a symlinked target root with a real directory when not in dry-run
- calls `sync-skills` to copy the declared global-core skills
- supports `--dry-run`
- removes extras only when `--delete-extra` is passed
- records a digest-backed `.global-core-managed.json` ledger per target
- supports `--delete-skill <csv>` for named, unchanged ledger-owned skills
  absent from the manifest; other undeclared ledger entries are preserved
- rejects `--delete-extra` together with `--delete-skill`
- targeted dry-runs print exact removals and write nothing

Command:

```bash
bun scripts/commands/sync-global-core.ts --source . --apps codex,opencode
```

Current global-core targets include app-owned user-global skill folders such as
`~/.codex/skills` and `~/.config/opencode/skills`. The legacy user-global
`~/.agents/skills` surface is intentionally blocked.

## Sync Skills

`sync-skills` is the lower-level copy helper used by global-core sync and other
maintenance flows.

Current behavior:

- validates source contract by default
- copies selected skills from source to target
- copies `.skill-lifecycle.json`
- skips missing `SKILL.md` directories
- supports `--dry-run`
- supports destructive extra removal only with `--delete`

For private skills, the source is a User Skill Root. That root may be a plain
local directory or any Git checkout chosen by the user.

Command:

```bash
bun scripts/commands/sync-skills.ts \
  --from /path/to/user-skill-root/skills \
  --to /target/skills \
  --skills writing-skills,code-discovery
```

## Quick Install

`quick-install` is a bootstrap pipeline, not a generic single-skill installer.

Current behavior:

- fetches or updates the selected Skill-Sys source with an exact ref and
  detached checkout; use `universall-skill-sys` for base/engine release flows
  and user-chosen repositories only for user-owned private skill roots
- can verify a signed tag
- can verify source checksum
- can run source validation
- can sync global core
- can optionally bootstrap a project

Current limitation:

- reusable partial-clone mode is not implemented yet
- strict release origin/provenance verification is not implemented yet

## Current Non-Features

These are not implemented yet:

- full rollback reconciliation for edge cases outside completed managed backup
  restores
- projection cache and artifact-digest cache
- manual folder conflict reporting during sync

## Current Digest Sync

`skill-sys sync --project <dir> --profile <name> --plan|--apply` is the current
project sync path for profile-based installs. It uses skill directory digests,
writes `.skills.state.json` last, and only removes stale skills that previous
state marked with `managedBy: "skill-sys"`.

Useful commands:

```bash
bun scripts/commands/skill-sys.ts sync --project . --profile core --plan
bun scripts/commands/skill-sys.ts sync --project . --profile core --apply
bun scripts/commands/skill-sys.ts sync --project . --profile core --repair
```
