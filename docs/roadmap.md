# Skill-Sys Roadmap

This roadmap tracks the next architecture wave for Skills Manager, whose engine
package retains the name `universall-skill-sys`.

The immediate milestone is the `0.4.0-alpha.0` GitHub source release: documented
local validation, projections, project installation, diagnostics and rollback.
Publication depends on the [release gates](./release-readiness.md), exact-candidate
review and the owner's publication decision. npm distribution, native-platform
validation and provider-runtime evidence are separate milestones. The broader
architecture backlog below is not a claim that all of it ships in this alpha.

The north star is to stop treating the project as a folder copier and turn it
into a release, verification, and provider projection system for operational
agent skills.

Current-state specs:

- [Manifesto](./manifesto.md)
- [Current System Specs](./specs/current-system.md)
- [Release Readiness Contract](./release-readiness.md)
- [Repository Boundaries](./specs/repository-boundaries.md)
- [Skill Catalog Contract](./specs/skill-catalog-contract.md)
- [Install, Sync, And Global Core](./specs/install-sync-global-core.md)
- [Release Artifact Pipeline](./specs/release-artifact-pipeline.md)
- [Command, CI, And Guardrails](./specs/command-ci-guardrails.md)

Future architecture specs:

- [Release Verification And Provider Projection Spec](./specs/release-verification-provider-projection.md)
- [Ecosystem Benchmark Roadmap](./specs/ecosystem-benchmark-roadmap.md)

Governed planning sources:

- the durable release verification and provider projection spec above;
- the ecosystem benchmark roadmap, which translates the comparative scan of
  Vercel `skills`, Vercel `agent-skills`, `gstack`, `gbrain`, and the Agent
  Skills specification into an ordered PR stack.

## Publication Policy

The owner-approved policy permits verified PUBLIC visibility only for
`evandro-miguel/skills-manager`; it does not establish hosted CI or provenance.
Other repositories retain the private default. npm remains disabled while
`package.json#private` is true. Product roadmap work remains separate from this
repository visibility decision.

## Roadmap Shape

This roadmap is intentionally implementation-facing. It keeps the sequence and
the issue backlog visible, while the spec owns field shapes, provider rules, and
contract details.

Priority rules:

- P0 closes public ship blockers: privacy, package surface, coherent public CLI,
  projection-backed install, docs truth, and release gates.
- P1 reaches minimum parity with the strongest comparables: universal source
  grammar, ephemeral `use`, explicit install modes, provider matrix v2,
  discovery, catalog, uninstall, deterministic lockfile, security scan v2,
  sandbox verification, evals, workflow chains, and routing.
- P2 adds team/dev mode and opt-in adapters: project learnings, memory adapters,
  browser runtime adapters, domain-skill generation, and update policy.
- P3 adds ecosystem scale: registry interop, registry trust score, and
  privacy-safe telemetry only if explicitly approved.

The ecosystem references above inform usability, catalog structure, workflow
composition and optional memory design. They are design inputs, not measured
claims of comparative security, performance or feature completeness.

## Now: P0 Hardening

Goal: make the existing install/release path safe enough to extend.

Repository split status on `2026-06-06`:

- `universall-skill-sys` is the base/public-engine surface; GitHub visibility
  remains PRIVATE until the repository owner explicitly approves publication.
- Private skills do not require a project-owned private mirror repo. Users keep
  private skills under a User Skill Root, defaulting to `SKILL_SYS_USER_ROOT` or
  `~/.skill-sys`, with layout `<userRoot>/skills/<skill>/SKILL.md`.
- If users want versioning, they choose the repository, remote, visibility, and
  branch policy for that User Skill Root; the engine does not prescribe it.
- Package separation status: this is the current monorepo public-engine package,
  not yet split into workspaces. Future packages remain roadmap items until a
  package-specific files/bin/exports contract, artifact surface, and docs gate
  land.

1. Make `.skills.state.json` privacy-safe.
   - Store relative targets and digests by default.
   - Add `schemaVersion: 2` and `mode: minimal`.
   - Allow absolute paths only behind `--debug-state`.
   - Add `doctor --state-safety`.
   - Status: implemented for the current direct-copy install path on
     `2026-05-18`.
2. Add a sensitive-file and secret scanner.
   - Block known credential filenames.
   - Scan skill trees before copy, release, publish, and sync.
   - Add `skill-sys scan-sensitive --source .`.
   - Status: implemented for current skill payload scan and write-path gates on
     `2026-05-18`.
3. Replace full clone fallback.
   - Use exact fetch and detached checkout.
   - Add explicit cache modes for ephemeral, reusable, and strict-release
     workflows.
   - Status: exact fetch, detached checkout, and commit-keyed source cache are
     implemented for current cache, quick-install, and publish paths on
     `2026-05-18`; reusable partial-clone and strict-release origin policy
     remain in later slices.
4. Add atomic install.
   - Copy into a temp transaction directory.
   - Verify digest before swap.
   - Keep a previous managed backup.
   - Write state last.
   - Status: staged copy, digest verification, target swap, backup marker,
     atomic state write, doctor partial-transaction detection, and the public
     rollback command are implemented; broader rollback edge-case
     reconciliation remains in later hardening.
5. Create an artifact surface registry.
   - Make checksum, release manifest, Skill BOM, and release verification use
     the same critical-surface definition.
   - Status: the pre-split `artifact-surface.json` registry, schema, and shared
     module were implemented on `2026-05-18`; in the base/public-engine repo the
     current public surfaces are explicit files under `artifact-surfaces/` such
     as `engine-public.json` and `skillpack-public.json`. Legacy/private-overlay
     source checksum, manifest, BOM source checksum, and release artifact
     verification continue to treat `artifact-surface.json` as a compatibility
     surface.
6. Add origin verification.
   - Verify tag/ref, commit, checksum, manifest, BOM, and optional Cosign/GitHub
     attestation policy.
   - Status: `skill-sys verify-origin` is implemented on `2026-05-18` for
     Git ref/commit, source checksum, release manifest, and Skill BOM checks.
     Required Cosign/GitHub attestation policy fails closed as unsupported until
     the provenance slice lands.
7. Add regression coverage for each gate.
   - state privacy fixtures
   - scanner denylist fixtures
   - cache exact-fetch fixtures
   - atomic install failure/rollback fixtures
   - artifact-surface parity fixtures

Current public package gate criteria:

```bash
bun run validate:local
bun run boundary:check
bun run validate:ci
bun run validate:release
bun run validate:publish
bun scripts/commands/skill-sys.ts scan-sensitive --source .
bun scripts/commands/skill-sys.ts verify-origin --source . --version vX.Y.Z
```

`metadata:audit`, `lifecycle:audit`, `doctor:all`, and `source:checksum` are
not active package scripts in this base/private-staging repo.

Implementation issues:

- A1, P0: make state file privacy-safe.
  Primary files: `scripts/modules/skillpool/install.ts`,
  `tests/skillpool-lifecycle.test.ts`.
  Status: implemented for v2 minimal state and explicit debug state.
- A2, P0: add state-safety doctor.
  Primary files: `scripts/modules/skillpool/doctor.ts`,
  `scripts/commands/skill-sys.ts`.
  Status: implemented for state schema, path privacy, and Git ignore checks.
- A3, P0: add sensitive scanner.
  Primary files: `scripts/lib/`, `scripts/commands/skill-sys.ts`, `tests/`.
  Status: implemented with `scripts/modules/skillpool/sensitive-scan.ts`,
  `scripts/commands/scan-sensitive.ts`, validate/install/sync/publish/release
  gates, and regression tests.
- A4, P0: replace clone fallback with exact fetch.
  Primary files: `scripts/modules/skillpool/cache.ts`,
  `scripts/commands/quick-install.ts`.
  Status: implemented for exact fetch, detached checkout, no full-clone
  fallback, and commit-keyed cache.
- A5, P0: add atomic install transaction.
  Primary files: `scripts/modules/skillpool/install.ts`,
  `scripts/lib/files.ts`.
  Status: implemented for staged install, digest verification, swap, backup,
  state write-last, and doctor partial detection.
- A6, P0: create canonical artifact surface registry.
  Primary files: `schema/`, `scripts/modules/`, `artifact-surfaces/`.
  Status: implemented with legacy/user-root `artifact-surface.json`
  compatibility plus base/public `artifact-surfaces/*.json`, shared
  source/release surface usage, and fail-closed critical surface coverage.

  Primary files: `scripts/commands/skill-sys.ts`,
  `scripts/modules/skillpool/verify-artifacts.ts`.
  Status: implemented as the local integrity/origin baseline; provenance
  policy requiring Cosign or GitHub attestations remains fail-closed and
  unsupported.

## Next: Provider Contract And Projection

Goal: make provider differences explicit without breaking the current install
model.

Current status on `2026-05-18`:

- B1 provider capability matrix is implemented under `providers/`.
- B2 optional `skill.meta.json` risk profile validation is implemented with
  safe defaults for skills without metadata.
- B3 `skill-sys build-projections` and `skill-sys validate-projections` are
  implemented as a generated-output pipeline. The `skillpool` backend can copy
  verified projection output with `--projection-dir`, and public `skill-sys`
  `add/install/update --projection-dir` forwards to that backend path
  (`update` pairs with `--install-mode projection` for a projection-aware
  reinstall).
- User-root projection input is opt-in with `--include-user` and optional
  `--user-root <dir>`. Defaults, public audit, packlist, release artifacts, and
  publication gates never include user roots.
- Named user roots, project-local config, visibility labels, and tag/provider
  defaults are planned next so users can select private/public/mixed roots by
  alias instead of repeatedly passing raw paths.

Planned root config slice:

1. Add config discovery.
   - Global config: `~/.config/skill-sys/config.toml`.
   - Project config: `<project>/.skill-sys/config.toml` or an equivalent
     project-local config path once the schema lands.
   - Precedence: CLI flags, project config, global config, env fallback,
     `~/.skill-sys` default.
2. Add named roots.
   - `name` for user-facing alias.
   - `path` for checked-out root with `skills/<skill>/SKILL.md`.
   - `visibility` as `private`, `public`, or `mixed`.
   - `tags` for selection/reporting.
   - `providers` for default projection set.
3. Add project-local private root support.
   - Allow real Git checkouts, submodules, or worktrees inside a project when
     excluded from public/package surfaces.
   - Keep symlinked skill payloads fail-closed; prefer config aliases over
     projecting through symlinks.
   - Add doctor checks that warn when a project-local private root is not ignored
     or is inside a public artifact surface.
4. Add private-root verification metadata.
   - Optional remote/ref/commit policy for user-chosen Git-versioned roots.
   - Never require a first-party private companion repo.
5. Add CLI ergonomics.
   - `skill-sys roots list`.
   - `skill-sys build-projections --include-user --root <name>`.
   - `skill-sys scan-sensitive --root <name>`.
   - `skill-sys doctor --roots --project <dir>`.

Provider projection slice:

1. Add provider capability matrix.
   - Codex, Claude Code, OpenCode, Gemini CLI, Qwen, and Antigravity.
   - Include path scopes, duplicate behavior, budget limits, permission
     semantics, and danger notes.
2. Add skill risk profiles.
   - Track shell execution, project/global writes, network, credential
     sensitivity, destructive behavior, and implicit invocation.
3. Add projection renderer.
   - Input: canonical skill plus provider matrix and optional overlay.
   - Output: validated provider projection with digest.
   - Keep identity projections for providers with no proven delta.
4. Add provider doctors.
   - Codex duplicate and budget checks.
   - Claude `allowed-tools` and deny-baseline checks.
   - OpenCode permission and agent-rendering recommendations.
5. Add projection-aware release metadata.
   - Include canonical digest.
   - Include provider projection digest.
   - Include overlay digest when overlays exist.
   - Include renderer version.
6. Keep global core small.
   - Add budget guard for global-core descriptions.
   - Require risk profile and evals before adding risky skills.
   - Block destructive or credential-sensitive skills from global core by
     default.

Exit criteria:

```bash
bun scripts/commands/skill-sys.ts build-projections \
  --providers codex,claude-code,opencode
bun scripts/commands/skill-sys.ts validate-projections --providers all
bun scripts/commands/skill-sys.ts doctor \
  --provider all \
  --duplicates \
  --budget \
  --permissions
```

Implementation issues:

- B1, P1: add provider capability matrix.
  Primary files: `providers/`, `scripts/modules/`.
- B2, P1: add canonical skill risk metadata.
  Primary files: skillpack/private-overlay source paths such as `skills/**`,
  `schema/`, and `scripts/commands/skill-metadata.ts`.
- B3, P1: add projection renderer.
  Primary files: `scripts/modules/`, `dist/` ignore policy.
- B4, P1: install only validated projections.
  Primary file: `scripts/modules/skillpool/install.ts`.
- B5, P1: add Codex duplicate and budget doctor.
  Status: implemented through `skill-sys doctor --provider codex
  --duplicates` and `skill-sys doctor --budget --provider codex`.
- B6, P1: add Claude permission audit.
  Status: implemented through `skill-sys doctor --provider claude-code
  --permissions`.
- B7, P1: add OpenCode agent and permission renderer path.
  Status: permission recommendation doctor is implemented; full agent renderer
  remains future work.
- B8, P1: add global-core budget audit.
  Primary files: user-root/legacy `globals/core.json` contracts and doctor
  modules.

## Current Baseline: Semantic Evals

Goal: treat skill text as an operational supply-chain surface.

Implemented baseline:

1. Trigger eval fixtures exist for the first priority generic skills:
   `agentic-orchestrator`, `code-discovery`, `docs-operations`,
   `markdownlint-skill`, `knowledge-base-skill`, and
   `repo-hygiene-organization`.
2. Fixtures include positive, negative, ambiguous, and collision prompts.
3. `skill-sys semantic-audit` checks broad capture, prompt-injection-shaped
   descriptions, and near-duplicate descriptions.
4. `skill-sys doctor --budget --provider <id>` estimates provider initial
   skill-list size and can scope to global core.

Remaining:

1. Add trigger eval fixtures for the rest of the top global-core skills.
2. Add required eval policy for risky skills.
   - risky skills need negative trigger cases
   - skills with side effects need manual-only expectations
   - collision tests decide preferred skill when two skills overlap

Exit criteria:

```bash
bun scripts/commands/skill-sys.ts eval triggers --provider codex
bun scripts/commands/skill-sys.ts eval triggers --provider claude-code
bun scripts/commands/skill-sys.ts eval collisions
bun scripts/commands/skill-sys.ts semantic-audit --source .
```

Implementation issues:

- C1, P2: add trigger eval schema.
  Status: implemented in `schema/triggers-eval.schema.json` and
  `scripts/modules/skillpool/semantic-evals.ts`.
- C2, P2: add eval runner.
  Status: implemented in `scripts/commands/eval.ts` and routed by
  `skill-sys`.
- C3, P2: add collision detection.
  Status: deterministic fixture validation implemented; model-backed collision
  scoring still pending.
- C4, P2: add semantic supply-chain audit.
  Status: implemented in `scripts/commands/semantic-audit.ts`.
- C5, P2: add budget doctor.
  Status: implemented in `scripts/commands/budget-doctor.ts` and routed via
  `skill-sys doctor --budget`.

## Current Baseline: Digest Sync And Rollback

Goal: make sync explainable, incremental, and reversible.

Implemented baseline:

1. Source Git fetch already uses exact commit-keyed cache.
2. `skill-sys sync --project <dir> --profile <name> --plan|--apply` syncs by
   skill directory digest, not mtime.
3. Repeated apply with unchanged digests is a no-op.
4. Stale removal only uses entries previously written by `.skills.state.json`
   with `managedBy: "skill-sys"`.
5. Add/update/remove operations use backup directories under
   `.agents/skills/.skill-sys-backup/`.
6. `sync --repair` cleans orphan `.skill-sys-tmp` directories.
7. `sync --plan --json` emits an explainable machine-readable plan.

Remaining:

1. Cache by artifact digest beyond the existing source commit cache.
2. Cache projections by provider and projection digest.
3. Report manual folders as explicit conflicts.
4. Rollback state reconciliation after restore is implemented for restored
   managed targets.
5. Promote moved-tag detection into sync planning when remote refs are used.

Exit criteria:

```bash
bun scripts/commands/skill-sys.ts sync --project <fixture> --profile core --plan
bun scripts/commands/skill-sys.ts sync --project <fixture> --profile core --apply
bun scripts/commands/skill-sys.ts sync --project <fixture> --profile core --apply
```

The second apply must be a no-op.

Implementation issues:

- D1, P2: add content-addressable source cache.
  Status: source commit cache is active; artifact-digest cache remains pending.
- D2, P2: add projection cache.
  Status: unchanged projections are reused by canonical digest and renderer
  version; content-addressable projection cache remains pending.
- D3, P2: add incremental sync by digest.
  Status: implemented in `scripts/commands/sync-plan.ts`.
- D4, P2: add safe stale removal.
  Status: implemented for state-managed skills only.
- D5, P2: add rollback support.
  Status: `skill-sys rollback` restores completed backup payloads and reconciles
  `.skills.state.json` digests for restored managed targets.
- D6, P2: add `sync --explain --json`.
  Status: implemented as `sync --plan --json` and `sync --explain --json`.

## Current Baseline: CI And Docs-As-Code

Goal: make the new guarantees hard to regress.

Implemented baseline:

1. `ci:checks` aliases `validate:release`.
2. `validate:release` runs `validate:ci` plus the repository visibility guard.
3. `validate:ci` runs local validation plus public audit, packlist, and npm pack
   audit checks.
4. `validate:local` runs typecheck, schema check, public/base tests, synthetic
   skillpack validation, and sensitive/privacy scans.
5. GitHub Actions CI runs `bun run ci:checks` with `GH_TOKEN` available.
6. `.github/CODEOWNERS` covers workflow, schema, provider, overlay, release,
   artifact-surface, and skillpool surfaces.

Remaining:

1. Validate workflow filter paths and lockfile examples.
2. Admit a measured value-gate baseline before enabling model-backed release
   enforcement.
3. Add provider duplicate/budget doctor to CI after duplicate doctor lands.
4. Capture hosted CI evidence after the public-history and visibility decisions
   are complete; local gates do not prove hosted enforcement.

Current public package gate criteria:

```bash
bun run validate:local
bun run validate:ci
bun run validate:release
bun run validate:publish
```

Active docs-as-code check:

```bash
bun scripts/commands/skill-sys.ts docs-check
```

Implementation issues:

- E1, P2: expand CI gates.
  Status: current public package gates cover typecheck, schema check, public/base
  tests, synthetic skillpack validation, sensitive/privacy scans, public audit,
  packlist, npm pack audit, dependency audit, docs-check, coverage, and
  repository visibility.
- E2, P2: add docs-as-code checker.
  Status: `docs:check` is an active package script and `validate:ci` gate.
- E3, P2: add workflow hardening checks.
  Status: baseline CODEOWNERS added; deeper workflow policy checks remain
  pending.
- E4, P3: add `doctor --all-scopes --provider all`.
  Primary surface: doctor modules.
- E5, P3: add redacted logs and explain JSON.
  Primary surface: command output modules.

## Next PR Stack

The older hardening issue list above is now mostly implemented or folded into
release-readiness. The next governed stack comes from the ecosystem benchmark
spec and should be executed in this order:

1. PR 01: clean public privacy surface.
   Status: mostly implemented on the readiness branch; keep gates strict.
2. PR 02: add release-readiness spec and docs truth table.
   Status: implemented as `docs/release-readiness.md`; continue adding docs
   truth checks instead of duplicating command truth by hand.
3. PR 03: add universal source grammar.
   Status: implemented for the currently documented source forms (local path,
   Git URL, `owner/repo` shorthand, and GitHub tree URLs). Expansion beyond
   those forms remains roadmap-only.
4. PR 04: finish projection-dir install/add/update decision path.
   Status: install/add are implemented, and `skill-sys update` now forwards
   `--projection-dir`/`--install-mode` through the projection reinstall path.
   Skill-specific update is implemented as `skill-sys update <skill>` forwarding
   `--skills` to `skillpool upgrade`; without `--ref`/`--repo` the lock identity
   is unchanged and only the named skill is refreshed.
5. PR 05: add `skill-sys use` ephemeral mode.
    Status: local inspection plus remote ephemeral use landed. `skill-sys use`
    accepts a local directory, `owner/repo`, `owner/repo#ref`, Git URLs, and
    GitHub tree URLs. Remote checkouts use an isolated temp directory, resolve
    missing refs through advertised `HEAD`, scan before emit, and do not write
    project or global roots. See [Ephemeral Use Spec](specs/ephemeral-use.md).
6. PR 06: add install modes: `projection`, `copy`, and `symlink`.
7. PR 07: expand provider matrix v2 and generated docs.
   Status: provider manifests now carry `displayName` and `detectionPaths`, and
   `scripts/commands/generate-provider-matrix.ts` writes/checks a deterministic,
   host-independent generated section into `docs/compatibility-matrix.md`
   (exposed as `skill-sys provider-matrix`).
8. PR 08: add advanced skill discovery and metadata flags.
   Status: the safe metadata-flags slice landed. Skills with truthy
   `metadata.internal`/`metadata.experimental` are now hidden from `list`
   (`scripts/commands/list-skills.ts`) and inventory
   (`scripts/commands/generate-skills-inventory.ts`) by default and revealed with
   `--include-internal`/`--include-experimental`; `skill-sys list`/`find` also
   forward those flags. Truthy: `true`, `1`, `yes`, `on`. Audit/eval surfaces
   intentionally still scan all skills (supply-chain safety).
   Multi-root/category-folder discovery and plugin manifests remain
   roadmap-only. See
   [Skill Discovery Spec](specs/skill-discovery.md).
9. PR 09: add skill cards and catalog generation.
   Status: the safe catalog slice landed. `skill-sys catalog` (alias
   `generate-catalog`) now generates/checks deterministic `skill-cards.json` and
   `skill-cards.md` under an explicit `--out-dir` from a `--source` skillpack.
   Root `SKILLS.*`/`skills/` writes remain forbidden in the base repo, and PR08
   internal/experimental visibility flags are respected. See
   [Skill Card Spec](specs/skill-card.md) and
   [Catalog Generation Spec](specs/catalog-generation.md).
10. PR 10: add complete remove/uninstall flow.
    Status: the planner and apply slices landed. `skill-sys remove` now supports
    plan-only previews with `--project`, `--skill` or explicit broad `--all`,
    and `--plan` or `--dry-run`, and destructive `--apply` with
    rollback-compatible backups, broad `--confirm-all`, and an immediate
    pre-`rm` digest recheck. See
    [Uninstall and Rollback Spec](specs/uninstall-rollback.md).
11. PR 11: add deterministic project lockfile v1.
    Status: `skill-sys generate-lock` (alias `lock`) now resolves the source
    manifest into a pinned `skill-sys.sources.lock.json`; it is a separate
    command from add/update, which still do not write the source lock.
12. PR 12: add security-scan-v2.
    Status: the first offline scanner slice landed. `skill-sys scan-security`
    now performs static read-only checks for network markers, credential-store
    access, hidden setup scripts, prompt-injection phrases, and risk metadata
    inconsistencies. Docker sandbox/runtime verification and source trust policy
    remain future work. See [Security Scan v2 Spec](specs/security-scan-v2.md)
    and [Skill Risk Taxonomy](specs/skill-risk-taxonomy.md).
13. PR 13: add sandbox runtime verification MVP.
    Status: the first safe slice landed as a plan-only verifier.
    `skill-sys verify-sandbox --source <dir> --plan|--dry-run` now emits a
    deterministic sandbox command-vector verdict and checks required controls
    without running Docker, containers, skills, scripts, or network calls. Actual
    runtime execution and source trust policy remain future work. See
    [Runtime Sandbox Verification Spec](specs/runtime-sandbox-verification.md).
14. PR 14: add skill eval harness.
    Status: the first offline fixture harness slice landed. `skill-sys eval
    harness` validates deterministic behavioral eval fixtures under
    `skills/*/evals/evals.json` without executing skill code or calling an LLM.
    Model-backed execution, actual pass-rate/duration/token measurement, and
    release-blocking regression gates remain future work (PR15 value gate). See
    [Skill Evals Spec](specs/skill-evals.md).
15. PR 15: add skill value gate.
    Status: the first offline value-gate slice landed. `skill-sys eval
    value-gate --source <dir> --results <file>` compares pre-recorded pass-rate,
    token-overhead, and duration metrics against eval fixture baselines without
    running skills, LLMs, tools, network, or containers. Model-backed metric
    generation and CI/release integration remain future work. See
    [Skill Value Gate Spec](specs/skill-value-gate.md).
16. PR 16: add workflow-chain spec and MVP.
    Status: the first offline workflow-chain slice landed. `skill-sys
    workflow-chain --source <dir> --workflow <file>` validates declarative chain
    JSON, resolves step skills against `skills/<name>/SKILL.md`, checks required
    gate references, and emits a dry-run plan without executing skills, gate
    commands, LLMs, tools, network, or containers. Routing integration and actual
    execution adapters remain future work. See
    [Workflow Chain Spec](specs/workflow-chain.md).
17. PR 17: add routing rules spec and route command.
    Status: the first offline routing slice landed. The command
    `skill-sys route --source <dir> --rules <file> --query <text>` validates
    declarative routing rules,
    resolves skill references, ranks deterministic trigger matches, and blocks
    risky skills unless the route is `manualOnly: true`. It never activates
    skills, calls an LLM, opens the network, executes tools, or writes output
    files. Semantic routing, route evals, and workflow-chain integration remain
    future work. See [Skill Routing Spec](specs/skill-routing.md).
18. PR 18: add team mode.
    Status: the first offline team-mode slice landed. `skill-sys team-mode
    --source <dir> --config <file>` validates a release-safe team config that
    stores shared policy and lockfile references rather than embedding a full
    catalog. It blocks symlink install mode, embedded catalogs, unsafe lockfile
    paths, and unsupported adapters without installing skills, creating
    symlinks, calling LLMs, opening the network, or writing files. Dev symlink
    workflow and team bootstrap/update adapters remain future work. See
    [Team Mode Spec](specs/team-mode.md).
19. PR 19: add dev mode symlink workflow.
    Status: the first offline dev-mode slice landed. `skill-sys dev-mode
    --source <dir> --config <file>` validates a local-only symlink development
    plan, requires explicit `devOnly: true` / `publicRelease: false` / symlink
    opt-in flags, resolves skill references, checks link targets stay under
    local development prefixes, and emits dry-run `would-link` actions. It does
    not create symlinks, install skills, write state, execute tools, call LLMs,
    or open the network. Applying dev links and stale-link cleanup remain future
    work. See [Dev Mode Spec](specs/dev-mode.md).
20. PR 20: add project learnings local/private.
    Status: the first offline project-learnings slice landed. `skill-sys
    project-learnings --source <dir> --learnings <file>` validates local/private
    operational notes, requires private/local visibility, blocks package-surface
    exposure, restricts storage to local/private path prefixes, and rejects
    secret-looking entry text. Validate mode does not write learnings, sync
    memory, call LLMs, open the network, or change package surfaces. Append and
    update write operations were delivered by governed F-05; redacted import
    and cross-command integration remain future work. See [Project Learnings
    Spec](specs/project-learnings.md).
21. PR 21: add memory adapter interface.
    Status: the first offline memory-adapter slice landed. `skill-sys
    memory-adapter --source <dir> --config <file>` validates local/private
    adapter declarations, requires explicit read/write trust-policy opt-ins,
    restricts config and adapter storage to local/private path prefixes, and
    rejects sensitive-memory policy or secret-looking config text. Validation
    does not call LLMs or open the network. Explicit JSONL read/write operations
    were delivered by governed F-05; SQLite/MCP execution and expanded
    trust-policy gates remain future work. See
    [Memory Adapter Spec](specs/memory-adapter.md).
22. PR 22: add registry interop/export.
    Status: the first offline registry-export slice landed. `skill-sys
    registry-export --source <dir>` validates the public registry surface and
    emits a deterministic interop bundle containing metadata, index, channel,
    advisory, and verified artifact digest data. `--output <file>` atomically
    writes the portable bundle while the result remains on stdout. It does not
    import external registries, resolve remote taps, open the network, execute
    skills, or call LLMs. Import adapters and remote trust resolution remain
    future work. See [Registry Interop Spec](specs/registry-interop.md).
23. PR 23: add registry trust score.
    Status: the first offline registry-trust slice landed. `skill-sys
    registry-trust --source <dir> --scorecard <file>` validates the public
    registry surface, reads a local pre-recorded trust scorecard, and emits a
    deterministic `PASS`, `CONCERNS`, or `BLOCKED` verdict with a 0-100 score.
    It does not generate evidence, write files, fetch remote registries, import
    skills, execute skill code, call LLMs, or publish telemetry. Scorecard
    generation, richer source trust, and signed provenance verification remain
    future work. See [Registry Trust Score Spec](specs/registry-trust-score.md).
24. PR 24: add telemetry policy only if explicit opt-in is approved.
    Status: the first offline telemetry-policy slice landed. `skill-sys
    telemetry-policy --source <dir> --config <file>` validates a local/private
    telemetry policy, keeps telemetry off by default, rejects package-surface
    exposure, forbids remote telemetry URLs, and blocks enabled collection unless
    explicit opt-in and approver fields are present. It does not collect
    telemetry, write files, read private user roots, execute skills, open the
    network, or call LLMs. See [Telemetry Policy Spec](specs/telemetry-policy.md).

## Non-Goals

- Do not add project-local provider fan-out into `.codex/`, `.claude/`,
  `.gemini/`, or `.qwen/`.
- Do not hand-edit generated provider projections.
- Do not add destructive stale removal before managed-root proof exists.
- Do not replace `sync-global-core` with a parallel sync stack unless the
  existing command cannot carry the provider-aware behavior.
- Do not treat Claude `allowed-tools` as a restriction.
- Do not make global core large to avoid provider budget work.
- Do not use mtime or "directory exists" as sync truth once digest sync exists.
- Do not start with workflow, memory, browser, registry, or telemetry work before
  public-surface, CLI, source grammar, provider, discovery, update/remove,
  security, and eval foundations are stable.
- Do not make telemetry default-on.
- Do not make symlink a public release install default.
- Do not install script-enabled skills from unknown sources without review and
  trust policy.
- Do not put project learnings, memory, browser state, or local roots in package
  surfaces.
- Do not make any Claude/Anthropic path the default provider; keep it
  compatibility-only unless the owner explicitly reverses that preference.
