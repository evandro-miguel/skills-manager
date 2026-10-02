# Ecosystem Benchmark Roadmap

This spec turns the comparative roadmap from the 2026-06-08 strategy review into
an implementation contract for `universall-skill-sys`.

The project should not compete by being only another skill folder installer. Its
position is:

- simple discovery and CLI UX comparable to Vercel `skills`;
- catalog quality comparable to Vercel `agent-skills`;
- operational workflow strength comparable to `gstack`;
- optional persistent-context adapters inspired by `gbrain`;
- stronger privacy, auditability, provider projection, and release gates than
  the comparable systems.

## Benchmarks

### Vercel `skills`

Benchmark for CLI UX, source grammar, discovery, install modes, and broad agent
support.

Adopt or exceed:

- multiple source formats;
- global and project installs;
- `list`, `find`, `remove`, `update`, and `init` style lifecycle commands;
- use-without-install workflows;
- provider matrix metadata that centralizes agent names, install paths, and
  detection.

Do not copy blindly:

- telemetry should remain explicit opt-in for this project;
- projection-backed install remains the safer default over raw copy/symlink.

### Vercel `agent-skills`

Benchmark for catalog shape.

Adopt or exceed:

- skill cards with `useWhen`, categories, examples, risk, and provider support;
- generated skillpack README/catalog output;
- search over use cases, tags, and descriptions.

### `gstack`

Benchmark for operational workflows.

Adopt or exceed:

- declarative workflow chains such as plan, review, QA, ship, docs, and retro;
- routing rules that make common user intents map to skills;
- project-local learnings as private-by-default operational memory.

Keep out of core until separately approved:

- browser daemons;
- host-specific slash-command bundles;
- project learnings that leak into public package surfaces.

### `gbrain`

Benchmark for persistent context, synthesis, permissions, and scoped memory.

Adopt as an adapter pattern only:

- memory reads/writes are opt-in;
- each skill declares whether it can use memory;
- memory trust policy is explicit;
- core engine does not store sensitive memory.

### Agent Skills specification

Baseline compatibility contract:

- `SKILL.md` is the canonical entrypoint;
- optional `scripts/`, `references/`, and `assets/` directories remain supported;
- frontmatter and progressive disclosure are validated;
- extensions must not break import/export of standard Agent Skills.

## Priority Model

P0 closes ship blockers and public-surface contradictions. P0 work is required
before publication or npm prerelease.

P1 adds minimum parity with the strongest comparable systems: source grammar,
ephemeral use, install modes, provider matrix v2, discovery, catalog, uninstall,
lockfile, security scan v2, sandbox verification, evals, workflow chains, and
routing.

P2 adds team/dev modes and opt-in adapters: project learnings, memory adapters,
browser runtime adapters, and domain-skill generation.

P3 adds ecosystem scale: registry interop, registry trust score, and privacy-safe
telemetry.

Correct order:

1. Privacy and safe publication.
2. Coherent public CLI.
3. Source grammar and use without install.
4. Strong provider matrix.
5. Discovery and catalog.
6. Remove/update/lockfile robustness.
7. Security scan v2.
8. Evals and value gate.
9. Workflow chains.
10. Team/dev mode.
11. Memory and browser as adapters.
12. Registry and ecosystem.

## P0 Ship Blockers

### Privacy/public-surface hardening

Status: mostly implemented in the current readiness branch.

Required specs:

```text
docs/specs/public-privacy-surface.md
docs/specs/privacy-policy-contract.md
docs/specs/public-allowlist-policy.md
```

Acceptance:

```bash
bun run scan:privacy
bun run public:audit
bun run npm-pack-audit
```

### Projection-backed public install

Status: implemented for public `skill-sys add/install/update --projection-dir`.
`update --projection-dir` forwards through the projection-aware reinstall path
(`--install-mode projection`). `skill-sys update <skill>` refreshes one
lock-declared skill without rewriting lock identity unless `--ref`/`--repo` is
also passed.

Required spec:

```text
docs/specs/install-modes.md
```

Acceptance:

```bash
bun run build-projections
bun run validate-projections
bun scripts/commands/skill-sys.ts install \
  --source examples/minimal-skillpack \
  --project /tmp/skill-sys-demo \
  --app codex \
  --projection-dir dist/projection-smoke
```

### Documentation truth source

Status: implemented as `docs/release-readiness.md`; the roadmap should continue
to separate built, partial, planned, and deprecated surfaces.

Acceptance:

```bash
bun run docs:check
bun run validate:publish
```

## P1 Parity Roadmap

### Universal source grammar

Required spec:

```text
docs/specs/source-grammar.md
```

Target forms:

```text
skill-sys add owner/repo
skill-sys add owner/repo#ref
skill-sys add https://github.com/org/repo
skill-sys add https://github.com/org/repo/tree/main/skills/foo
skill-sys add git@gitlab.com:org/repo.git
skill-sys add ./local-skillpack
skill-sys add ./skills/foo
```

Acceptance:

- source parser has path traversal tests;
- direct skill path becomes a safe virtual skillpack;
- ref, commit, and digest verification remain possible.

### Ephemeral `skill-sys use`

Required spec:

```text
docs/specs/ephemeral-use.md
```

Implemented as [Ephemeral Use Spec](./ephemeral-use.md).

Target commands:

```bash
skill-sys use owner/repo --skill skill-name
skill-sys use ./local-skillpack --skill skill-name --format markdown
skill-sys use ./local-skillpack --skill skill-name --agent codex
skill-sys use ./local-skillpack --skill skill-name --json
```

Acceptance:

- does not write to project or global roots;
- uses isolated temporary directories;
- runs sensitive scan before emitting prompt material;
- supports JSON output for automation.

### Explicit install modes

Required spec:

```text
docs/specs/install-modes.md
```

Model:

```text
projection = default safe mode
copy       = portable compatibility mode
symlink    = dev/team mode only, never public-release default
```

Acceptance:

- symlink is blocked in release/public install;
- copy records source digest;
- projection records canonical and projection digests.

### Provider matrix v2

Required spec/schema:

```text
docs/specs/provider-matrix.md
schema/provider.schema.json
```

The provider record should include display name, project paths, global paths,
detection paths, and capability booleans for permissions, allowed tools,
implicit invocation, manual-only behavior, and subagents.

Acceptance:

- `doctor --provider all` validates real paths where detectable;
- matrix docs are generated from provider JSON;
- Antigravity, Gemini CLI, Qwen, Codex, OpenCode, and Claude Code compatibility
  paths remain verified by tests.

### Discovery and catalog

Required specs:

```text
docs/specs/skill-discovery.md
docs/specs/skill-card.md
docs/specs/catalog-generation.md
```

Acceptance:

- discovery supports root, `skills/`, category folders, `.agents/skills/`, and
  plugin manifests;
- `metadata.internal` is hidden by default;
- `metadata.experimental` requires an explicit flag;
- catalog build/check/render can emit Markdown and JSON skill cards.

### Remove, update, and deterministic lockfile

Required specs/schemas:

```text
docs/specs/uninstall-rollback.md
docs/specs/project-lockfile.md
schema/project-lockfile.schema.json
```

Acceptance:

- remove handles projection/copy/symlink managed installs;
- broad removals require dry-run/confirmation;
- lockfile is timestamp-free, sorted, deterministic, and merge-friendly;
- reinstall/update uses `skillPath` and digest metadata.

### Security scan v2 and sandbox verification

Required specs/schemas:

```text
docs/specs/security-scan-v2.md
docs/specs/skill-risk-taxonomy.md
schema/security-finding.schema.json
docs/specs/runtime-sandbox-verification.md
docs/specs/source-trust-policy.md
```

Acceptance:

- scan compares `SKILL.md` intent, scripts behavior, repository context, and
  allowed-tools/risk metadata;
- deep scan detects suspicious network exfiltration, credential scraping,
  hidden setup scripts, and prompt-injection patterns;
- sandbox verification can run scripts in Docker without network and without
  access to HOME, SSH, browser state, or tokens;
- unknown sources cannot install script-enabled skills without review.

### Skill eval harness and value gate

Required specs/schemas:

```text
docs/specs/skill-evals.md
schema/skill-evals.schema.json
schema/eval-result.schema.json
docs/specs/skill-value-gate.md
```

Acceptance:

- evals compare with-skill and without-skill runs;
- tracked metrics include pass rate, duration, and token overhead;
- new skills can be flagged when they show no measurable value;
- release can block skills that regress against baseline.

### Workflow chains and routing

Required specs/schemas:

```text
docs/specs/workflow-chain.md
schema/workflow-chain.schema.json
docs/specs/skill-routing.md
schema/routing-rules.schema.json
```

Acceptance:

- workflows are declarative and dry-runnable;
- every workflow step references an existing skill;
- required gates fail closed when absent;
- routing is testable and never auto-activates dangerous skills.

## P2 Adapter Roadmap

Required specs:

```text
docs/specs/team-mode.md
docs/specs/dev-mode.md
docs/specs/update-policy.md
docs/specs/project-learnings.md
docs/specs/memory-adapter.md
docs/specs/memory-trust-policy.md
docs/specs/browser-skill-runtime.md
docs/specs/daemon-security-model.md
docs/specs/domain-skills.md
```

Rules:

- team mode stores lockfile/config, not the full catalog;
- dev symlinks are marked and fail public audits if packaged;
- auto-update is throttled, offline-safe, and never applies majors without
  confirmation;
- project learnings are local/private by default;
- memory and browser are adapters, not core dependencies;
- generated domain skills require review before publication.

## P3 Ecosystem Roadmap

Required specs:

```text
docs/specs/registry-interop.md
docs/specs/registry-trust-score.md
docs/specs/telemetry-policy.md
```

Acceptance:

- Agent Skills import/export remains compatible with the public specification;
- registry trust score uses signed refs/digests, scans, sandbox verification,
  eval pass rate, token overhead, maintainer/source trust, and docs completeness;
- telemetry is off by default, explicit opt-in, and never includes private
  source names, local paths, or skill content.

## PR Sequence

```text
PR 01 — Clean public privacy surface
PR 02 — Add release-readiness spec + docs truth table
PR 03 — Add universal source grammar
PR 04 — Add projection-dir to skill-sys install/add/update decision path
PR 05 — Add skill-sys use ephemeral mode
PR 06 — Add install modes: projection/copy/symlink
PR 07 — Expand provider matrix + generated docs
PR 08 — Add advanced skill discovery + metadata flags
PR 09 — Add skill cards + catalog generation
PR 10 — Add remove/uninstall complete flow
PR 11 — Add deterministic project lockfile v1
PR 12 — Add security-scan-v2
PR 13 — Add sandbox runtime verification MVP
PR 14 — Add skill eval harness
PR 15 — Add skill value gate
PR 16 — Add workflow-chain spec + MVP
PR 17 — Add routing rules spec + route command
PR 18 — Add team mode
PR 19 — Add dev mode symlink workflow
PR 20 — Add project learnings local/private
PR 21 — Add memory adapter interface
PR 22 — Add registry interop/export
PR 23 — Add registry trust score
PR 24 — Add telemetry policy only if explicit opt-in is approved
```

The PR list above is the authoritative sequencing plan. Some implementation
spec files landed under narrower names than the initial planning labels; use
`docs/roadmap.md` and `docs/reference/skill-sys-commands.md` for the current
implemented command/spec mapping.

## Non-Goals Until Later Approval

- Do not start with workflow, memory, or browser features before public-surface,
  CLI, source grammar, provider, discovery, update/remove, security, and eval
  foundations are stable.
- Do not make telemetry default-on.
- Do not treat symlink as a public release install default.
- Do not install script-enabled skills from unknown sources without review.
- Do not put project learnings, memory, browser state, or local roots in package
  surfaces.
- Do not make any Claude/Anthropic path the default provider; keep it
  compatibility-only unless the owner explicitly reverses that preference.
