# Skill Catalog Contract

This is the as-built spec for the skillpack/overlay catalog contract and
tooling.

Repository boundary: `universall-skill-sys` is the base/public-engine repo and
does not carry real private root `skills/` catalogs. User-local private skills
live in User Skill Roots by default; if users want versioning, they choose any
repository for that root. In this base repo, root `skills/`, `SKILLS.json`, and
`SKILLS.md` references are contract, compatibility, or user-root/skillpack
references unless they point to the synthetic public fixture under
`examples/minimal-skillpack/`.

## Owned Surfaces

Primary contract surfaces for a skillpack or private overlay:

- `skills/` inside the skillpack/overlay source root
- `skill-lifecycle.json` when a skillpack/overlay maintains a lifecycle ledger
- `SKILLS.json` and `SKILLS.md` when inventory generation is enabled for that
  skillpack/overlay

Public base fixture:

- [`examples/minimal-skillpack/skills/`](../../examples/minimal-skillpack/skills/)

The base/public-engine repo must not treat root `skills/`, `SKILLS.json`, or
`SKILLS.md` as an active first-party catalog.

Primary implementation surfaces:

- [scripts/modules/skill-metadata-lib.ts](../../scripts/modules/skill-metadata-lib.ts)
- [scripts/commands/universal-contract.ts](../../scripts/commands/universal-contract.ts)
- [scripts/commands/skill-metadata.ts](../../scripts/commands/skill-metadata.ts)
- [scripts/commands/skill-lifecycle.ts](../../scripts/commands/skill-lifecycle.ts)
- [scripts/commands/generate-skills-inventory.ts](../../scripts/commands/generate-skills-inventory.ts)
- [scripts/modules/skillpool/validate.ts](../../scripts/modules/skillpool/validate.ts)

Schemas:

- [schema/skill-lifecycle.schema.json](../../schema/skill-lifecycle.schema.json)
- [schema/skill-bom.schema.json](../../schema/skill-bom.schema.json)

## Skill Directory Contract

Each active skillpack/overlay skill lives at this contract path relative to its
skillpack or overlay source root:

```text
skills/<skill>/SKILL.md
```

In the base/public-engine repo this is a shape contract, not evidence of real
first-party root skills. The public fixture uses:

```text
examples/minimal-skillpack/skills/example-skill/SKILL.md
```

The contract requires:

- `SKILL.md` exists.
- top-level `name` exists.
- top-level `description` exists and is non-empty.
- top-level `metadata` exists.
- `name` is kebab-case.
- `name` matches the skill folder name.
- `description` is a single-line scalar.
- allowed top-level keys are `name`, `description`, `metadata`, `license`, and
  `allowed-tools`.

Required metadata:

- `metadata.version` is semver `x.y.z`.
- `metadata.updated_at` is a valid UTC ISO timestamp.
- `metadata.target_provider` is one supported provider id.

CSV metadata fields:

- `metadata.tags`
- `metadata.triggers`
- `metadata.references`
- `metadata.compatible_providers`

These fields must be CSV strings when present. Array/list syntax is rejected by
the universal contract.

Provider metadata behavior:

- `metadata.target_provider` is normalized against the provider id list in
  `skill-metadata-lib`.
- `metadata.compatible_providers` must not include `universal`.
- `metadata.compatible_providers` must not repeat `metadata.target_provider`.
- duplicate or invalid compatible provider ids fail validation.

Legacy metadata keys are rejected by strict validation.

## User-Facing Root Config Contract

Skill frontmatter describes the skill itself. Tool config describes how a given
user wants to expose, name, group, and project that skill source. This separation
keeps private user policy out of public skill content while still making common
workflows easy.

A future config surface may exist globally and per project:

```text
~/.config/skill-sys/config.toml
<project>/.skill-sys/config.toml
```

Equivalent JSON/YAML/TOML forms are acceptable if the schema is explicit. Config
records should support:

- `name`: user-facing alias for the root, e.g. `personal`, `work`, `client-a`;
- `path`: checked-out filesystem root containing `skills/<skill>/SKILL.md`;
- `visibility`: `private`, `public`, or `mixed`;
- `tags`: user-chosen labels for filtering and reporting;
- `providers`: default provider projection set for that root;
- `git.remote`, `git.ref`, and optional expected commit/tag policy for roots the
  user chooses to version;
- `includeByDefault`: allowed only for explicitly private/local commands, never
  for public package, release, or publication surfaces.

Example shape:

```toml
[[roots]]
name = "personal"
path = "~/.skill-sys"
visibility = "private"
tags = ["private", "daily", "personal"]
providers = ["codex", "opencode"]

[[projects.roots]]
name = "project-private"
path = "./.skill-sys/private-skills"
visibility = "private"
tags = ["project", "private"]
providers = ["codex"]
```

Config precedence is explicit:

1. CLI flags such as `--user-root <dir>` or future `--root <name>`;
2. project config for the current project;
3. global config;
4. environment fallback such as `SKILL_SYS_USER_ROOT`;
5. default `~/.skill-sys`.

Project config may add roots or rename/tag roots for local ergonomics, but it
must not silently downgrade a root's visibility from `private` to `public`.
Public/release commands must ignore non-public roots unless the command is a
private audit or private projection command with explicit opt-in.

Provider metadata remains on the skill. User-facing aliases, visibility, tags,
and versioning policy live in config because they are local user choices, not
portable skill identity.

## Metadata Automation

`skill-metadata` supports:

- `audit`
- `sync --all --write`
- `sync --staged --write`

The automation can:

- validate metadata shape and provider ids
- compare changed skill directories against Git history
- require version bumps for changed skill directories
- require refreshed `metadata.updated_at`
- backfill metadata from prior Git state where possible
- run in strict mode for CI and guard workflows

Current direct command forms for a skillpack/private-overlay checkout that has a
root `skills/` directory:

```bash
bun scripts/commands/skill-metadata.ts audit --skills-root skills --strict
bun scripts/commands/skill-metadata.ts sync --all --write --skills-root skills
bun scripts/commands/skill-metadata.ts sync --staged --write --skills-root skills
```

For the public fixture in the base repo, use
`--skills-root examples/minimal-skillpack/skills` or the package-level
`bun run validate:skillpack` gate instead of implying root `skills/` exists.

## Lifecycle Ledger

When a skillpack/private overlay maintains lifecycle history, the ledger is
versioned at the skillpack/overlay root as:

```text
skill-lifecycle.json
```

Lifecycle events are used for:

- removed skills
- archived skills
- merged skills
- renamed skills
- replacement guidance for agents
- generated redirect tables in `SKILLS.json` and `SKILLS.md` for
  skillpack/private-overlay inventories

Supported direct command forms for a skillpack/private-overlay checkout:

```bash
bun scripts/commands/skill-lifecycle.ts audit --skills-root skills
bun scripts/commands/skill-lifecycle.ts lookup <skill>
bun scripts/commands/skill-lifecycle.ts resolve <skill> [--json]
bun scripts/commands/skill-lifecycle.ts record ... --write
```

`resolve --json` emits the versioned `skill-lifecycle-resolution/v1` terminal
result and follows inactive replacement entries to one active or terminal
removed/archived node. Graph cycles, self-replacements, missing nodes, and
ambiguous nodes fail closed.

The root public package does not currently define `lifecycle:*` package scripts.

## Inventory Generation

The generated inventory command reads active skill frontmatter and lifecycle
redirects from a selected skillpack/overlay source, then writes compatibility
inventory files for that source:

- `SKILLS.json`
- `SKILLS.md`

In `universall-skill-sys`, these names describe the contract/output shape only;
they are not active root inventory files. User Skill Roots or other user-chosen
skillpack sources may carry generated inventories for private skills, but those
sources are not part of this engine's release/publication surface. The public
base fixture is
[`examples/minimal-skillpack/skills/`](../../examples/minimal-skillpack/skills/).

The generator skips deprecated, archived, and compatibility-only catalog
entries.

Current command:

```bash
bun scripts/commands/generate-skills-inventory.ts
```

Legacy/private-overlay inventory snapshot:

- generated at `2026-05-18`
- `156` active skills
- `25` lifecycle redirects

This snapshot is historical migration evidence for the private overlay/original
catalog, not a current root catalog in the base/public-engine repo.

## Validation Contract

In the base/public-engine repo, `bun run validate:release` is the release-level
public staging gate because it adds repository visibility guard coverage.
`bun run validate` is an alias for `validate:ci` and does not run the visibility
guard. The current gate levels include typecheck, schema check, the public test
set, synthetic skillpack validation, sensitive and privacy scans, public artifact
audit, packlist, and npm pack audit.

The public skillpack contract fixture is validated through:

```bash
bun run validate:skillpack
bun scripts/commands/skill-sys.ts validate-skillpack \
  --source examples/minimal-skillpack \
  --strict
```

For a private overlay or external skillpack that actually has a root `skills/`
directory, the underlying contract commands remain shaped as:

```bash
bun scripts/commands/universal-contract.ts --skills-root skills
bun scripts/commands/skillpool.ts validate --source .
```

`skillpool validate`, when run against a skillpack/private-overlay source,
composes:

- source layout validation
- adapter validation
- profile validation
- universal contract validation
- metadata audit
- lifecycle audit
- lockfile policy validation where lockfiles are referenced

## Tests And Guards

Representative tests:

- skill metadata command coverage is planned for the next semantic/doctor slice.
- [tests/skillpack-contract.test.ts](../../tests/skillpack-contract.test.ts)
- universal-contract helper coverage is represented through [tests/skillpack-contract.test.ts](../../tests/skillpack-contract.test.ts).
- private-overlay skill metadata tests are out of scope for this public base repo.
- private-overlay skill lifecycle tests are out of scope for this public base repo.
- [tests/skillpack-contract.test.ts](../../tests/skillpack-contract.test.ts)

Current guard command:

```bash
bun scripts/commands/skill-change-guard.ts --staged --fix --restage
```

The guard chains Markdown fixes, Markdown linting, link checks, universal
contract validation, and `skillpool validate`.

## Current Risk Metadata

`skill.meta.json` is an optional per-skill file. When absent, tooling uses a
safe default risk profile with no side effects and implicit invocation allowed.
When present, it is validated by `skillpool validate` and consumed by projection
builders.

Risky flags such as `executesShell`, `writesGlobal`, `credentialSensitive`, or
`destructive` make generated provider projections manual-only where the
provider has a supported control.

## Current Trigger Eval Fixtures

Trigger eval fixtures are optional but active for skillpack/overlay catalogs.
When present, they live at the contract path
`skills/<skill>/evals/triggers.json` relative to the skillpack/overlay source
root, may reference `schema/triggers-eval.schema.json`, and are validated by:

```bash
bun scripts/commands/skill-sys.ts eval triggers --provider codex
bun scripts/commands/skill-sys.ts eval collisions
```

Supported case groups are `positive`, `negative`, `ambiguous`, and `collision`.
The baseline validator checks fixture shape, skill references, ambiguous
expectations, and collision references. It does not call a model.

## Current Non-Features

These are not implemented in the current catalog contract:

- required risk profiles for every skill
- required trigger eval files for every skill
- model-backed semantic collision scoring

Those belong to the next architecture wave; projection-backed install is tracked in the install/projection specs, not as a catalog-contract non-feature.
