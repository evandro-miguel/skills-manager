# Current System Specs

This folder separates the system that is already built from the next
release/provider projection roadmap.

The current base/public-engine repository is a Bun/TypeScript engine and
skillpack contract with:

- CLI commands, validators, schemas, adapters, providers, and projection tooling
- a universal `SKILL.md` contract for skillpacks and overlays
- metadata and lifecycle audits that operate on an explicit skill root
- generated machine and human inventories as compatibility output for
  skillpacks/private overlays
- user-owned private skill roots for projection input only
- project-local install through profiles and lockfiles
- private-overlay compatibility for user-global sync manifests such as
  `globals/core.json`
- release checksums, release manifests, Skill BOMs, and channel metadata for
  skillpack or User Skill Root sources
- public artifact-surface definitions under `artifact-surfaces/`
- CI, guard, and documentation validation commands

Repository boundary: `universall-skill-sys` is the base/public-engine repo, but
its GitHub visibility remains PRIVATE until the repository owner explicitly
approves publication. The engine repo remains the public artifact source.
Private skills do not need a project-owned private mirror repository: users may
keep them under
a User Skill Root outside the repo, optionally versioned in any repository they
choose. Root `skills/`, `SKILLS.json`, `SKILLS.md`,
`skill-lifecycle.json`, `globals/core.json`, and `artifact-surface.json`
references in this spec set are contract/compatibility, user-local, or
user-root/legacy references unless explicitly tied to a public fixture.

Future projection work is tracked separately in
[Release Verification And Provider Projection Spec](./release-verification-provider-projection.md).

## Current Snapshot

The base/public-engine repo currently has no real first-party root catalog.
The public fixture is synthetic and lives at
[`examples/minimal-skillpack/skills/`](../../examples/minimal-skillpack/skills/).

The historical private catalog snapshot from the original/private overlay reported:

- legacy `totalSkills: 156`
- legacy `generatedAt: 2026-05-18`
- legacy `lifecycleRedirects: 25`

Those values describe legacy migration evidence only. They are not a current
inventory for `universall-skill-sys`, and `universall-skill-sys-pvt` is not the
recommended private skill home for new workflows.

## User Skill Roots

User skill roots are user-owned source roots outside this repository. They
replace the need to create a project-owned private mirror repo just to keep
personal skills. A user root may be an unversioned local directory or a Git
checkout from any repository the user chooses.

Resolution:

- default root: `SKILL_SYS_USER_ROOT` when set, otherwise `~/.skill-sys`
- layout: `<userRoot>/skills/<skill>/SKILL.md`
- command override: `--user-root <dir>` on commands that explicitly opt in to
  user skills

Policy:

- user roots are never part of the base/public-engine artifact surface
- user-root versioning remotes, hosting, visibility, and branch policy are chosen
  by the user and are not engine architecture
- defaults, public audit, packlist, release checksums, release manifests, Skill
  BOMs, and publication gates must not include user roots
- projection input includes user skills only when `--include-user` is passed
- a duplicate skill name across public/base skills and user skills is an error;
  projection must fail instead of merging or shadowing
- user skills are local/private and are not shipped, packed, or released

Identity metadata:

- public/base skills use `origin: "public"`
- user-root skills use `origin: "user"`
- user canonical paths use `user:skills/<skill>`
- projection manifests record origins so downstream validation can distinguish
  public artifacts from local/private user inputs

## Current Specs

- [Skill Catalog Contract](./skill-catalog-contract.md)
  describes the active skillpack/overlay `SKILL.md` contract, metadata tooling,
  lifecycle ledger compatibility, inventory generation, and catalog guards.
- [Install, Sync, And Global Core](./install-sync-global-core.md)
  describes current project installs, lockfiles, adapters, on-demand loading,
  global-core sync, doctor behavior, and install limitations.
- [Release Readiness Contract](../release-readiness.md)
  describes the private-staging publication contract, gates, npm package
  contents, forbidden contents, and roadmap-only release features.
- [Release Artifact Pipeline](./release-artifact-pipeline.md)
  describes current source checksums, artifact-surface registry, release
  manifests, Skill BOMs, channels, signing workflow, and verification behavior.
- [Ephemeral Use](./ephemeral-use.md)
  describes local and remote read-only skill preview, isolated temporary
  checkout, scan-before-emit, and the no-write guarantee.
- [Command, CI, And Guardrails](./command-ci-guardrails.md)
  describes the current command surface, CI workflow split, skill-change guard,
  Markdown/link guards, and coverage gates.

## Built Versus Planned

Already built:

- `skill-sys add|list|find|update|doctor|validate|scan-sensitive`
- `skill-sys use` local and remote ephemeral preview (isolated temp fetch)
- `skill-sys update <skill>` scoped refresh from the current lock
- `skill-sys remove` planner plus `--apply` with rollback-compatible backups
- `skill-sys verify-origin|build-projections|validate-projections|eval`
- `skill-sys semantic-audit|docs-check|context|sync|rollback`
- compatibility `skill-sys install|upgrade|setup|init`
- `skillpool install|upgrade|doctor|validate`
- `skillpool doctor --state-safety`
- `ensure-skill` on-demand install
- `quick-install` bootstrap/sync pipeline
- `sync-global-core` and `sync-skills`
- `skill-sys sync --project <dir> --profile <name> --plan|--apply` for
  digest-based project sync with state-backed safe stale removal
- `skill-sys rollback` for restoring completed `.skill-sys-backup` payloads
- exact depth-1 source fetch with commit-keyed cache for Git sources
- staged install swap with digest verification, backup marker, and state
  write-last behavior
- `artifact-surfaces/engine-public.json` consumed by public artifact audit and
  packlist gates
- legacy/user-root `artifact-surface.json` compatibility consumed by
  source checksum, release manifest, Skill BOM source checksum, and release
  artifact verification for skillpack or User Skill Root sources
- `verify-origin` baseline for Git ref/commit, source checksum, manifest, and
  Skill BOM checks, with unsupported provenance policy failing closed
- provider capability matrix under `providers/`
- optional `skill.meta.json` risk profiles with safe defaults
- provider projection build/validation into ignored `dist/`
- provider projections can opt in to user-local private skills with
  `--include-user` and optional `--user-root <dir>`; default projection and
  release/public gates exclude user roots
- deterministic `skill-sys eval triggers|collisions` for skillpack/overlay
  contract fixtures shaped as `skills/*/evals/triggers.json`
- offline `skill-sys eval harness`, `skill-sys eval receipt`, and
  `skill-sys eval value-gate` for deterministic fixtures, caller-supplied
  measured receipts, and pre-recorded value comparisons; these surfaces do not
  run providers, create baselines, or authorize releases
- offline `skill-sys verify-sandbox` plan-only verification with exact mount
  containment and fail-closed execution flags
- offline `skill-sys workflow-chain`, `skill-sys route`, `skill-sys team-mode`,
  and `skill-sys dev-mode` validators/planners, plus bounded local opt-in
  workflow/routing fixture adapters and in-process team/dev apply seams; the
  team/dev CLI surfaces remain validation/plan-only
- local/private `skill-sys project-learnings append|update` and
  `skill-sys memory-adapter read|write` operations; memory read/write require
  explicit opt-ins, while learnings remain path/private-bound. Both support
  atomic local writes and dry-run output
- local `skill-sys registry-export` (including atomic bundle output),
  `skill-sys registry-import` (offline structural/digest import with
  `UNVERIFIED` provenance), and `skill-sys registry-trust` scorecard
  evaluation; remote trust authorities and taps remain unsupported
- `skill-sys telemetry-policy` policy validation plus the separate explicit
  local collector `bun scripts/commands/telemetry-policy.ts collect`; collection
  is opt-in, approver-gated, deterministic, and never remote
- deterministic source grammar and discovery expansion: local/Git,
  GitHub-tree, and GitLab-tree forms; multi-root/category and plugin-manifest
  discovery through `bun scripts/commands/discover-skills.ts`
- `skill-sys semantic-audit` for prompt-injection-shaped descriptions, broad
  activation capture, and near-duplicate descriptions
- `skill-sys doctor --budget --provider <id>` for provider initial-listing
  budget estimates, including global-core scope warnings
- `skill-sys docs-check` for Markdown local links and command example script
  references
- `release-prepare`, `release-verify`, and `source-checksum`
- `universal-contract`, `skill-metadata`, `skill-lifecycle`
- generated `SKILLS.json` and `SKILLS.md` as compatibility/private-overlay
  inventory outputs, not as current root inventory files in the base repo

Planned, not built yet:

- full rollback reconciliation for edge cases outside completed managed backup
  restores
- provider-backed sandbox execution and source-trust authority; model-backed eval
  execution, baseline governance, and CI/release value-gate enforcement;
  provider/model-backed routing and external execution adapters; hosted/remote
  memory backends; remote registry/tap and signed-trust resolution; and remote
  or automatic telemetry remain intentionally deferred behind explicit future
  approval

Planned commands are intentionally documented in roadmap/spec files only. They
must not be represented as available user commands until implementation lands.

## Baseline Validation

Use these commands to verify the current built system:

```bash
bun run validate:local
bun run validate:ci
bun run validate:release
bun run ci:checks
bun scripts/commands/skill-sys.ts doctor --state-safety --project .
bun scripts/commands/skill-sys.ts doctor --budget --provider codex --global-core
bun scripts/commands/skill-sys.ts scan-sensitive --source .
bun scripts/commands/skill-sys.ts eval triggers --provider codex
bun scripts/commands/skill-sys.ts eval collisions
bun scripts/commands/skill-sys.ts semantic-audit --source .
bun scripts/commands/source-checksum.ts --source .
bun scripts/commands/release-verify.ts --source . --version v0.3.1
```

`doctor:all`, `source:checksum`, and `release:verify` are not current package
scripts in this engine repo; use the direct command forms above unless package
scripts are added later.

Documentation-specific checks for this spec set:

```bash
bun x markdownlint-cli2 docs/specs/*.md docs/roadmap.md
bun scripts/commands/markdown-link-guard.ts docs
git diff --check
```
