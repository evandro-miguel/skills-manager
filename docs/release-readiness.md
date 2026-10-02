# Release Readiness Contract

This document defines release checks for the Skills Manager source alpha.
The engine and package retain the internal name `universall-skill-sys`.

Release scope: **GitHub source alpha** at `evandro-miguel/skills-manager`.
Hosted readiness is established for each release by its exact-commit Actions
results and public clone rehearsal. The package is `private: true`,
version `0.4.0-alpha.0`, and license `MIT`, so npm publication remains disabled.

No local checkout, tag, tarball, or validation run proves hosted release
readiness. Release claims require the checks below on the exact candidate and
separate owner approval for repository visibility and npm publication.

## What The Project Does

`universall-skill-sys` provides the reusable Skill-Sys engine:

- CLI commands for skillpack creation, validation, install planning, audits,
  provider projections, release artifact checks, and diagnostics.
- Schemas and validators for skillpacks, metadata, lockfiles, release artifacts,
  provider matrices, registry surfaces, and public artifact boundaries.
- Synthetic examples for testing the public skillpack contract.
- Privacy, sensitive-content, packlist, npm-pack, and repository-visibility gates
  for proving that a publishable surface is safe.
- Compatibility paths for existing `skillpool` workflows while new docs prefer
  the `skill-sys` command surface.

## What The Project Does Not Do

The base engine does not:

- contain real personal/private root `skills/` catalog content;
- prescribe, host, package, publish, or version a user's private skill root;
- include secrets, credentials, browser state, local logs, runtime state, or
  private global-core manifests in the public artifact surface;
- enable npm publication while `package.json` has `private: true`;
- switch GitHub visibility to public without explicit owner approval;
- import private source history, governance, or personal tooling into the
  standalone public repository;
- claim release provenance, public npm provenance, Cosign publication, or GitHub
  attestation enforcement is active before the provenance gates land.

## Public Commands

The public command surface is `skill-sys`. The exhaustive command and option
reference is [Skill-Sys Command Reference](./reference/skill-sys-commands.md);
the release-relevant subset includes the core install/sync/release gates and
the offline/local validators below:

- `skill-sys add <source>`
- `skill-sys list`
- `skill-sys find <query>`
- `skill-sys update`
- `skill-sys update <skill>`
- `skill-sys use <source> --skill <name>`
- `skill-sys update-check`
- `skill-sys generate-lock` (alias: `lock`)
- `skill-sys doctor`
- `skill-sys validate`
- `skill-sys scan-sensitive`
- `skill-sys scan-privacy`
- `skill-sys public-audit`
- `skill-sys packlist`
- `skill-sys verify-origin`
- `skill-sys build-projections`
- `skill-sys validate-projections`
- `skill-sys eval triggers|collisions`
- `skill-sys eval receipt`
- `skill-sys semantic-audit`
- `skill-sys scan-security`
- `skill-sys verify-sandbox`
- `skill-sys eval harness`
- `skill-sys eval value-gate`
- `skill-sys workflow-chain`
- `skill-sys route`
- `skill-sys team-mode`
- `skill-sys dev-mode`
- `skill-sys project-learnings`
- `skill-sys memory-adapter`
- `skill-sys registry-export`
- `skill-sys registry-trust`
- `skill-sys inspect-skill --reference <ref>`
- `skill-sys audit-installed`
- `skill-sys adopt-installed`
- `skill-sys telemetry-policy`
- `skill-sys docs-check`
- `skill-sys guard-repo-visibility`
- `skill-sys context <skill>`
- `skill-sys sync --project <dir> --profile <name> --plan|--apply`
- `skill-sys remove --project <dir> --skill <name> --plan|--dry-run|--apply`
- `skill-sys rollback`

Use `docs/reference/skill-sys-commands.md` as the authoritative exhaustive
command list and option reference. If a command is not listed there as
implemented, treat it as roadmap-only.

## Delivered Local And Offline Slices

The following roadmap slices are implemented in this checkout, but their
explicit boundaries remain part of the release contract:

- **F-02:** `skill-sys verify-sandbox --source <dir> --plan|--dry-run` emits a
  deterministic, self-checked sandbox command vector. It never runs Docker or
  skill code; `--apply`, `--run`, and `--execute` fail closed.
- **F-03:** `skill-sys eval harness` validates deterministic fixtures;
  `skill-sys eval receipt` validates caller-supplied measured receipts; and
  `skill-sys eval value-gate` compares a verified receipt with caller-supplied
  baseline and policy files. These commands do not run providers, create
  baselines, or authorize a release; value-gate output always reports
  `release_authorized: false`.
- **F-04:** workflow and routing expose only the explicit in-process
  `--execute --adapter local-test` fixture seam. Team and dev modules also have
  explicit local apply/cleanup APIs (`applyTeamModeLocal` and
  `applyDevModeLocal`), while their CLI commands remain validator/plan-only.
  No provider, network, skill execution, package install, global path, or host
  mutation is reachable through these slices.
- **F-05:** project learnings support local/private `append` and `update`; the
  JSONL memory adapter supports explicit `read` and `write` operations. Writes
  to memory require the documented read/write opt-ins; both surfaces preserve
  source-entry provenance where applicable, use atomic local writes with
  locking, and support `--dry-run`.
- **F-06:** `registry-export` can atomically write a deterministic local bundle;
  `registry-import` validates a local bundle and writes only to a new local
  output directory with `UNVERIFIED` provenance; `registry-trust` scores a
  caller-supplied local scorecard. Remote taps, signed provenance, and trust
  authorities are not part of this slice.
- **F-07:** `skill-sys telemetry-policy` validates the local policy. The
  separate explicit command `bun scripts/commands/telemetry-policy.ts collect`
  appends deterministic local JSONL only when the policy is enabled and has
  explicit opt-in, an approver, an allowed skill, and a safe local output path.
  It never sends telemetry and does not generate timestamps or identifiers.
- **F-09:** current source grammar covers local/Git, GitHub-tree, and
  GitLab-tree forms. `bun scripts/commands/discover-skills.ts` provides
  deterministic multi-root/category and plugin-manifest discovery; `skill-sys
  list|find` retain the internal/experimental visibility controls.

These local checks and adapters do not establish hosted/provider trust, runtime
execution safety, measured-model baselines, or release authorization.

## Legacy And Compatibility Commands

These commands remain for migration and backend compatibility, but new external
docs should not make them the primary user path:

- `skillpool install|upgrade|doctor|validate`
- compatibility `skill-sys install|upgrade|setup|init`
- lower-level helpers such as `sync-global-core`, `sync-skills`,
  `quick-install`, and `ensure-skill`

Projection-backed copy exists in the `skillpool` backend through an explicit
`--projection-dir <dir>` path. Public `skill-sys add/install --projection-dir`
forwards to that backend path; `skill-sys update --projection-dir` forwards the
same projection reinstall path through `skillpool upgrade`. `skillpool` remains
the compatibility/backend surface rather than the recommended external
entrypoint.

## Roadmap-Only Features

Do not describe these as available or release-authorizing user features until
their remaining implementation, authority, docs, and gates land:

- npm publication or changing `private: true` to `false`.
- License selection is resolved as MIT; npm publication and visibility changes
  remain gated.
- Public release provenance publication with npm provenance, Cosign bundles, or
  GitHub artifact attestations.
- Source backends beyond the current local/Git/GitHub-tree/GitLab-tree grammar,
  and richer provider budget/doctor policy beyond the current deterministic
  local checks.
- Broader remote/no-install `skill-sys use` workflows beyond the current
  isolated temp-fetch path (no persistent cache policy, no agent runtime
  injection). Local and remote Git sources already render read-only.
- CLI exposure of the team/dev local apply seams, and any provider/global
  symlink or install mode. Public/release installs support `projection` as the
  default and explicit `copy` mode only; the team-mode validator remains
  release-safe and the dev-mode CLI remains dry-run only.
- Source-level uninstall workflows and any uninstall paths beyond the
  skill-sys-managed project removal and rollback backup flow.
- Provider/model-backed routing, automatic skill activation, workflow-chain
  integration beyond the `local-test` seam, and any external execution adapter.
- Runtime sandbox execution and source-trust policy enforcement. The current
  sandbox surface is plan-only; approved runtime image provenance, admission,
  non-root/resource/cleanup controls, and a trust authority are still absent.
- Model-backed eval execution, independently governed measured baselines, and
  CI/release value-gate enforcement. Receipt and value-gate commands validate
  supplied evidence only and never authorize a release.
- Hosted or remote memory backends (including SQLite/MCP/runtime adapter
  execution), browser runtime adapters, and cloud memory synchronization.
- Remote registry import/tap resolution and signed or remote trust verification.
  Local export/import and local scorecard evaluation remain the available
  offline slice.
- Remote, default-on, or automatic telemetry. The local collector is explicit,
  policy-gated, and never sends data.
- Named user roots such as `--root personal` and `skill-sys roots list`.
- Package/workspace splits beyond the current monorepo package.
- Full rollback reconciliation for edge cases outside completed managed backup
  restores.
- Provider doctors or renderers not listed as implemented in the command
  reference and current-system spec.

## Privacy Audit Scope

Privacy checks use configured markers and known secret patterns. They are not a
proof that arbitrary text contains no personal or proprietary information. The
built-in email marker covers two common personal-email domains; custom-domain
addresses and names need an explicit content review. Windows PowerShell and
batch wrappers are included in current-tree content scanning. Historical
content auditing also covers reachable commit and annotated-tag metadata.
Use a public noreply Git identity for the public candidate and review metadata
before the first push. Preserve rejected source histories privately.

## Required Gates Before Publication

The owner-approved guard policy permits verified PUBLIC visibility only for
`evandro-miguel/skills-manager`. This policy approval does not prove that the
repository exists, that hosted CI passed, or that npm publication is enabled.
Unknown or contradictory visibility observations still block; other repositories
retain the private default. Normal CI and package scripts use no publication
override. The `SKILL_SYS_LOCAL_VALIDATE` environment fallback is removed;
`--local-ok` remains diagnostic-only and cannot establish publication readiness.

Pushing a `v*` tag runs validation only. The npm job is restricted to an
explicit `workflow_dispatch` with `publish_npm=true` on a `v*` tag, and the
package remains non-publishable while `package.json#private` is `true`. GitHub
visibility and npm publication are separate owner decisions.

Before GitHub visibility changes or npm publication, run from a clean checkout:

```bash
bun install --frozen-lockfile
bun run audit:public-repository
bun run validate:publish
bun run scan:privacy
bun run public:audit
bun run npm-pack-audit
bun run scan:dependencies
git diff --check
```

The package projection smoke gate uses the project-scoped
`.tmp/projection-store` cache. Release validation must not depend on or mutate a
user-global `~/.skillpool` cache.

The tracked repository must exclude AFOL, `AGENTS.md`, local harness/runtime
state, and personal agentic tooling. The only public agentic exception is the
portable `skills/skill-sys/**` skill shipped for agents operating the CLI.
`bun run audit:public-repository` also scans every reachable Git object and
fails closed when forbidden paths remain only in history. The report is
bounded: it prints class counts plus a small sample, not every historical
path. Removing a path from the current tree is insufficient. This candidate
starts from an independent root containing only the reviewed public export.
Keep the private source lineage outside this repository and rerun the complete
history audit after changes and against the final public remote. A failed
history audit blocks publication even when the current package is clean.

A final release rehearsal must also verify a clean clone and a temporary
project. For the lockfile-free public fixture, build projections inside that
project and select the app and skill explicitly:

```bash
PROJECT=/path/to/project

bun scripts/commands/skill-sys.ts build-projections \
  --source examples/minimal-skillpack \
  --providers all \
  --out-dir "$PROJECT/.skill-sys/projections" \
  --projection-store-dir "$PROJECT/.tmp/projection-store" \
  --clean

bun scripts/commands/skill-sys.ts install \
  --source examples/minimal-skillpack \
  --project "$PROJECT" \
  --projection-dir .skill-sys/projections \
  --agent codex \
  --skill example-skill

bun scripts/commands/skill-sys.ts doctor \
  --project "$PROJECT" \
  --state-safety

# Reinstall once to create a completed prior backup for rollback.
bun scripts/commands/skill-sys.ts install \
  --source examples/minimal-skillpack \
  --project "$PROJECT" \
  --projection-dir .skill-sys/projections \
  --agent codex \
  --skill example-skill

bun scripts/commands/rollback.ts --project "$PROJECT" --target .agents/skills

bun scripts/commands/skill-sys.ts doctor \
  --project "$PROJECT" \
  --state-safety
```

Omitting `--agent` falls back to lockfile mode and fails when
`.skills.lock.json` is absent; `--agent codex` alone fails when the source
resolves zero skills. The second install creates the completed backup under
`<project>/.agents/skills/.skill-sys-backup/`. Full `doctor` additionally
requires a bootstrapped `.skills.lock.json`; rollback after only the first
install is an expected no-op because no prior managed state exists yet. Finish
the rehearsal with manual tarball inspection.

The publication decision also requires explicit owner approval for:

- GitHub visibility change;
- package privacy change;
- npm publication;
- license/publication model;
- dist-tag selection. The intended prerelease tag is `next`, not `latest`.

## npm Package Contents

The npm package is controlled by `package.json#files`, `package.json#bin`, and
the checked artifact surfaces under `artifact-surfaces/`. The current package is
a single monorepo engine package, not a workspace split.

Allowed package contents are limited to engine and public-contract surfaces such
as:

- CLI launchers, commands, libraries, and modules under `scripts/`;
- schemas under `schema/`;
- provider matrices under `providers/`;
- adapters, profiles, registry contracts, and public artifact surfaces;
- synthetic examples under `examples/`;
- public documentation selected by `package.json#files`;
- public privacy policy and allowlist files used by the release gates;
- top-level governance docs such as `README.md`, `SECURITY.md`, and
  `CONTRIBUTING.md`.

Package contents must match the declared files list and artifact surface. If npm
pack output, `package.json#files`, and artifact-surface checks disagree, the
release is blocked.

## Forbidden Package Contents

The package must never include:

- real personal/private `skills/` catalogs;
- User Skill Roots or user-root Git remotes;
- private profiles, private global-core manifests, or private overlay state;
- `.env`, tokens, keys, auth state, browser profiles, local databases, or logs;
- generated provider projections from `dist/`;
- local caches, workbench state, debug state, backups, or temporary install
  transaction directories;
- sibling/private repositories or host-specific operational routines;
- publication-only provenance artifacts before the provenance workflow is
  explicitly approved and active.

## Staging Rule

Until every required gate passes and the owner approves publication, call this
repository a **private staging repository for the public engine**. Do not call it
a public release, and do not claim publication is enabled today.
