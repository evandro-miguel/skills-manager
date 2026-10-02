# Skill-Sys Command Reference

`skill-sys` is the public command surface for this repository. It keeps the old
`skillpool` command available as a compatibility backend, but new docs and
examples should prefer `skill-sys`.

Package status: the CLI currently ships from the current monorepo public-engine
package. The repository is not yet split into workspaces. Future packages may
split engine APIs, provider projection helpers, or registry surfaces only after
their package `files`/`bin`/`exports` boundaries and docs migration contracts are
made explicit.

## Public Commands

`skill-sys add <source>`
: Install skills from a local directory, Git URL, or `owner/repo` shorthand.
Backend: `skillpool install`. `--install-mode projection` is the release-safe
default and requires `--projection-dir <dir>`. `--install-mode copy` is an
explicit compatibility alias for the existing canonical raw copy path.
`--install-mode symlink` is rejected in the public/release CLI; symlink/team
install remains a future dev-only mode.

`skill-sys list`
: List skills from the local catalog. Use `--profile <name>` to restrict the
catalog to one project-local profile bundle. JSON output also carries the
selected profile metadata for each matched skill. Backend: `list-skills.ts`.

`skill-sys find <query>`
: Search skills by name, description, tag, category, stack term, or profile.
Backend: `list-skills.ts --query`.

### Metadata Visibility Flags

Skills may declare visibility gating under `metadata`:

```yaml
metadata:
  internal: true        # hidden from public discovery by default
  experimental: true    # hidden from public discovery by default
```

Truthy values are: boolean `true` and the strings `true`, `1`, `yes`, `on`.
Any other value (including `false`, `0`, `off`, or absence) leaves the skill
visible by default.

- `metadata.internal` skills are hidden from `list` and inventory output unless
  `--include-internal` is passed.
- `metadata.experimental` skills are hidden unless `--include-experimental` is
  passed.
- Compatibility/deprecated/archived filtering is independent and unchanged.

These flags are implemented on `skill-sys list` / `skill-sys find` and on the
backend discovery scripts:

```bash
skill-sys list --include-internal --include-experimental
skill-sys find router --include-experimental
bun scripts/commands/list-skills.ts --include-internal --include-experimental
bun scripts/commands/generate-skills-inventory.ts --include-internal
```

When internal/experimental skills are revealed, JSON output carries
`internal`/`experimental` booleans on each record and the text renderer tags
them `[internal]`/`[experimental]`. Inventory output records the default
exclusion in its `notes` block.

Scope note: `generate-skills-inventory.ts` (dedicated entry below) is a direct
backend script, not a `skill-sys` dispatcher command. Audit and eval surfaces
(`semantic-audit`, `eval`) intentionally scan **all** skills regardless of
these flags — see the discovery spec for the rationale.

`skill-sys use <source> --skill <name>`
: Render a skill from a local directory or a remote Git source without
installing it or writing project, global, lockfile, or state roots. Remote
forms include `owner/repo`, `owner/repo#ref`, Git URLs, and GitHub tree URLs.
Missing remote refs resolve through advertised `HEAD`, not a hardcoded `main`.
The checkout is an isolated temp directory that is deleted after the command
finishes. Default output is Markdown; use `--format json` or `--json` for
machine-readable output and `--agent <app>` to label the target agent. The
command scans the selected skill directory for sensitive content before emitting
any `SKILL.md` text and fails closed on findings.

`skill-sys update`
: Update a project lockfile ref and optionally reinstall, or refresh one
lock-declared skill from the current lock. Backend: `skillpool upgrade`.
`skill-sys update <skill> --project <dir>` forwards `--skills <skill>` and does
not rewrite `lock.repo`/`lock.ref`. Pass `--source <dir>` to resolve skills
declared only via a lock `profile`. `skill-sys update --project <dir> --ref
<ref>` keeps the full lock promotion path. Accepts `--install-mode projection`
(the release-safe default, requires `--projection-dir <dir>`) and
`--install-mode copy` (an explicit compatibility alias mapped to
`--legacy-raw-install`). `--install-mode symlink` is rejected in the
public/release CLI.

`skill-sys generate-lock`
: Resolve and pin declared third-party skill sources into
`skill-sys.sources.lock.json` (alias: `lock`). It is the dedicated first-resolver
that reads `skill-sys.sources.json`, resolves each declared ref to a pinned
40-char commit via `git ls-remote`, materializes the checkout to locate each
`SKILL.md`, and writes the source lock with deterministic key ordering. It is a
**separate command** from `add`/`update`; those commands do **not** generate the
source lock. Each source is validated as a safe remote Git repository (local
paths, `file://`, loopback/private hosts, and credential-bearing URLs are
rejected) and any declared `skillPath` is checked for traversal escapes before
any network step. Use `--dry-run` to resolve and validate without writing, and
`--json` to emit the generated lock as JSON to stdout. Options:
`--source <dir>`, `--manifest <path>`, `--lockfile <path>`, `--dry-run`,
`--json`. Backend: `generate-lock.ts`.

`skill-sys update-check`
: Report available updates for declared third-party skill sources. **Read-only**:
it never writes files and never applies updates. Reads
`skill-sys.sources.json` (manifest) and `skill-sys.sources.lock.json` (current
lock), resolves each declared ref against its remote via `git ls-remote`, and
prints the update report as JSON to stdout (schema:
`schema/update-report.schema.json`) with a short human-readable summary on
stderr. Requires an existing lock; generate one with `skill-sys generate-lock`
(the dedicated first-resolver — `add`/`update` do not write the source lock). The
default exit code is `0` even when updates are available; pass
`--strict` to exit non-zero on any `update-available` or `error` entry (for CI
notification pipelines). Options: `--source <dir>`, `--manifest <path>`,
`--lockfile <path>`, `--strict`, `--json`. Backend: `update-check.ts`.

`install-skills.ts`
: Simple bootstrap installer for a project skills lockfile: runs
`skillpool install` then `skillpool doctor` for the same project. Options:
`--project <dir>` (default: current directory), `--lockfile <file>` (default:
`.skills.lock.json`), `--source <dir>`, `--refresh-cache`, `--strict-hash`
(runs doctor with strict hash comparison), `--dry-run`. Used by
`bootstrap-skills.ts` and also shipped as a bin wrapper. Not a `skill-sys`
dispatcher command. Backend: `install-skills.ts`.

`bootstrap-skills.ts`
: Bootstrap a project with a `.skills.lock.json` and install its skills: write
the lockfile from `--repo`/`--ref`/`--apps`/`--profile`/`--skills` (refuses to
overwrite an existing lockfile without `--force`), then run `install-skills.ts`
(install + doctor). Options: `--repo <git-url-or-path>` (default: OpenCode
origin; fallback local path), `--project <dir>`, `--ref <tag|branch|sha>`
(default: `main`), `--lockfile <file>` (default: `.skills.lock.json`),
`--apps <csv>` (default: `opencode`; project installs target `.agents/skills`),
`--profile <name>` (default: `core`), `--skills <csv>`, `--source <dir>`,
`--force`, `--refresh-cache`, `--strict-hash`, `--dry-run`. Dispatched by
`skill-sys init` (alias: `init-project`). Backend: `bootstrap-skills.ts`.

`ensure-skill.ts`
: On-demand installer that ensures one skill is present for the selected app;
if the skill is already installed it exits without changes. Requires
`--skill <name>`. Options: `--project <dir>`, `--app <name|auto>` (default:
`auto`, detected from project markers), `--apps <csv>`, `--source <dir>`
(default: script parent), `--repo <git-url-or-path>`, `--ref <tag|branch|sha>`
(default: `main` when `--repo` is used), `--refresh-cache`,
`--verify-signed-tag`, `--expected-source-sha256 <hex>`, `--dry-run`,
`--allow-global-core-skills`. Global-core skills are refused unless the
`--allow-global-core-skills` override is passed. Also shipped as a bin
wrapper. Not a `skill-sys` dispatcher command. Backend: `ensure-skill.ts`.

`quick-install.ts`
: One-command installer: fetch the universal-skills repo into `--target`
(default: `~/.local/share/universal-skills`), run the universal contract
check, sync declared global-core skills, and optionally bootstrap a project.
Options: `--repo <git-url-or-path>` (required unless `--target` is already a
clone), `--ref <tag|branch|sha>` (default: `main`), `--target <dir>`,
`--sync-globals <csv>` (default: `opencode,codex,qwen,gemini-cli`),
`--no-global-sync`, `--project <dir>`, `--apps <csv>` (default: `opencode`),
`--profile <name>` (default: `core`), `--skills <csv>`,
`--verify-signed-tag`, `--expected-source-sha256 <hex>`. Dispatched by
`skill-sys setup` (alias: `quick-install`). Backend: `quick-install.ts`.

`upgrade-project.ts`
: Upgrade one project's skills lockfile ref and verify the result with a
strict-hash doctor. Requires `--project <dir>` and `--ref <tag|branch|sha>`
(or `--repo`). Runs `skillpool upgrade` followed by
`skillpool doctor --strict-hash` for the project. Options: `--ref <value>`,
`--repo <url|path>`, `--lockfile <file>`, `--source <dir>`,
`--refresh-cache`. Not a `skill-sys` dispatcher command. Backend:
`upgrade-project.ts`.

`smoke-adapters.ts`
: Smoke test for project adapter installs: create an OS temp project, run
`skillpool install --app <app> --profile core` for `opencode`, `codex`,
`claude-code`, and `antigravity`, then verify `writing-skills` lands under
`.agents/skills/` and the deprecated `.codex/skills`, `.claude/skills`, and
`.gemini/antigravity/skills` targets are not created. Prints `STATUS: PASS`
and deletes the temp project by default. Options: `--source <dir>` (default:
repo root), `--keep-temp`. Not a `skill-sys` dispatcher command. Backend:
`smoke-adapters.ts`.

`skill-sys doctor`
: Check installed skills for missing files or drift. Backend:
`skillpool doctor`. Use `--state-safety` to verify `.skills.state.json`
privacy and Git ignore safety. Use `--budget --provider <id>` to estimate the
provider initial skill-listing budget; this dispatches to `budget-doctor.ts`.

`provider-doctor.ts`
: Run provider-specific skill diagnostics: Codex duplicate skill names across
visible scopes, Claude `allowed-tools` without a project deny baseline, and
OpenCode risky-metadata permission review. `skill-sys doctor` dispatches here
when `--duplicates`, `--permissions`, or `--provider <id>` is passed. Prints
`STATUS: WARN` with `[LEVEL CODE]` findings or `STATUS: PASS`; findings do not
change the exit code. Options: `--source <dir>`, `--project <dir>`,
`--provider <id|all>`, `--duplicates`, `--permissions`, `--json`. Backend:
`provider-doctor.ts`.

`budget-doctor.ts`
: Estimate the provider initial skill-listing budget for a source root.
Reports `STATUS: WARN` with findings or `STATUS: PASS`, then prints provider,
scope (`all` or `global-core`), the provider budget and current char counts,
and suggested remediation when findings exist. `skill-sys doctor` dispatches
here when `--budget --provider <id>` is passed; `--max-budget <n>` maps to
the `--budget <chars>` override. Options: `--source <dir>` (default: `.`),
`--provider <id>` (default: `codex`), `--global-core` (limit the estimate to
`globals/core.json` skills), `--budget <chars>` (positive integer override),
`--json`. Not a `skill-sys` dispatcher command. Backend: `budget-doctor.ts`.

`skill-sys validate`
: Validate a source layout and lockfile references. Backend:
`skillpool validate`. This includes the sensitive skill payload scan.

`skill-sys scan-sensitive`
: Scan source `skills/**` payloads from skillpack or User Skill Root source roots
or synthetic fixtures for known credential filenames and secret-shaped content.
For a User Skill Root, pass the root with `--source <userRoot>`; the command
expects `<userRoot>/skills/**`. Backend: `scan-sensitive.ts`.

`skill-sys scan-privacy`
: Scan a source tree or selected artifact surface for personal names, local
paths, private workflow markers, agent runtime state, and company-data hints.
Supports `--surface <name|json>`, `--allowlist <json>`, `--policy <json>`,
`--strict`, and `--json`. Backend: `scan-privacy.ts`.

`skill-sys public-audit`
: Run the public surface privacy and sensitive-content audits together. It uses
the same artifact `--surface`, privacy `--allowlist` and private marker
`--policy` inputs as `scan-privacy`. Backend: `public-audit.ts`.

`skill-sys scan-security`
: Run the static offline security-scan-v2 over an explicit skill source with
`--source <dir>`. The scanner never executes skill code; it reports relative-path
findings for network/exfiltration markers, credential-store access, hidden setup
scripts, prompt-injection phrases, and `skill.meta.json` risk inconsistencies.
Use `--strict` to treat WARN findings as blocking and `--json` for machine
output. Backend: `scan-security.ts`.

`skill-sys verify-sandbox`
: Emit a plan-only runtime sandbox verification verdict for an explicit source:
`--source <dir>` plus `--plan` or `--dry-run`. The command never runs Docker or
skill code in this slice. It self-checks the planned sandbox command vector for
`--network none`, read-only root filesystem, `no-new-privileges`, `cap-drop ALL`,
explicit read-only mounts, and denied credential/auth paths. `--apply`, `--run`,
and `--execute` fail closed. Use `--json` for machine output. Backend:
in-process planner `scripts/modules/skillpool/sandbox-plan.ts`.

`skill-sys packlist`
: Emit the deterministic file list, byte count, and digest for a public artifact
surface. Use `--hashes` for per-file `sha256` values and `--json` for release
automation. Backend: `packlist.ts`.

`skill-sys npm-pack-audit`
: Compare `npm pack --dry-run --json --ignore-scripts` output with the selected
public artifact surface packlist (`--surface <name|json>`, default
`engine-public`). Prints `STATUS: BLOCKING`/`STATUS: PASS` with MISSING FROM NPM
and EXTRA IN NPM file lists and exits non-zero unless PASS. Alias: `pack-audit`.
Backend: `npm-pack-audit.ts`.

`skill-sys validate-registry-surface`
: Validate the static public registry surface: registry metadata/index/channel/
advisory version contracts, digest pins for channels and taps (floating refs
without `sha256` are rejected), and matching release channel documents with
`allowFloatingRef=false`. The initial alpha has no advertised channels. For a
nonempty channel map, `--source` must be the exact Git root and the local
version tag must resolve to the declared commit. This check does not verify
tag signatures or remote provenance. Prints `STATUS: PASS` with the validated file list;
failures exit non-zero with `ERROR: ...`. Alias: `registry-check`. Backend:
`validate-registry-surface.ts`.

`skill-sys verify-origin`
: Verify Git ref/commit, source checksum, release manifest, and Skill BOM for a
source checkout. Backend: `verify-origin.ts`. Cosign bundle and GitHub
attestation policy are fail-closed as unsupported in this local baseline.

`source-checksum.ts`
: Compute the deterministic source checksum used by release tooling. Resolves
the source layout (flat, monorepo-root, nested-app, or skillpack) and prints
the checksum, or `--json` output with `source`, `poolRoot`, and `checksum`.
Options: `--source <dir>` (default: `.`), `--json`. Invoked by
`release-prepare.ts` and `quick-install.ts`; `verify-origin.ts` uses the same
`computeSourceChecksum` module in-process. Not a `skill-sys` dispatcher
command. Backend: `source-checksum.ts`.

`release-prepare.ts`
: Prepare a release: update `package.json` (and `index.json` when present)
version, add a CHANGELOG entry, write `releases/checksums/vX.Y.Z.sha256`
unless `--no-checksum`, write the release manifest and skill BOM, and
optionally write `releases/channels/<name>.json` with `--channel <name>`.
Requires `--version <x.y.z|vx.y.z>` and a clean repo unless `--allow-dirty`.
`--commit` creates a release commit, `--tag` creates an annotated tag,
`--sign-tag` creates a signed tag (implies `--tag`), and `--push` pushes
(implies `--commit` + `--tag`). `--channel` must run after the release
commit/tag exists and must not be combined with `--commit`, `--tag`, or
`--push`. Options: `--version`, `--date <YYYY-MM-DD>` (default: today UTC),
`--no-checksum`, `--commit`, `--tag`, `--sign-tag`, `--channel <name>`,
`--surface <name|path>`, `--push`, `--allow-dirty`. Not a `skill-sys`
dispatcher command. Backend: `release-prepare.ts`.

`release-verify.ts`
: Verify release manifest and skill BOM artifacts against the current source.
Requires `--version <x.y.z|vx.y.z>` (alias: `--ref`). With
`--channel <name>`, also verifies `releases/channels/<name>.json` points at
the version, disables floating refs, requires release manifest and skill BOM
hashes to match, and enforces signed-tag verification for `stable`/`candidate`
when `policy.requireSignedTag` is true. Options: `--source <dir>` (default:
`.`), `--version`, `--channel <name>`. Not a `skill-sys` dispatcher command.
Backend: `release-verify.ts`.

`release-smoke.ts`
: End-to-end release smoke gate: copies the public minimal skillpack into an OS
temp directory, runs `release-prepare`, verifies the release artifacts, and runs
origin verification (source checksum, manifest, Skill BOM) before deleting the
temp directory by default. It never writes tracked `releases/` artifacts in the
checkout. Prints `STATUS: PASS` with the release tag and checksums; failures
exit non-zero. Options: `--keep-temp`, `--json`. Backend: `release-smoke.ts`.

`skill-sys build-projections`
: Render provider-specific projection output into `dist/`. Generated output can
be installed with `skill-sys add/install --projection-dir <dir>` after digest
verification; `skillpool install --projection-dir <dir>` remains the backend
compatibility path. Deprecated `skill.meta.json` lifecycle entries and sources marked `deprecated`, `archived`, `compatibility_only`, or `category: compatibility` in top-level or nested `metadata` frontmatter are excluded. Canonical source files remain available for rollback. Experimental skills and false lifecycle flags remain eligible. By default this renders only public/source skills. Use
`--include-user` to add local/private user-root skills, and `--user-root <dir>`
to override the default user root. Source symlinks fail closed. Non-clean
opt-out builds prune stale user-origin projection files when user roots are not
included; modified user projections are preserved and cause a non-zero failure. If a retained public projection becomes retired, rerun with `--clean` to replace the guarded output tree; a non-clean build fails instead of leaving stale content beside the new manifest. Pass `--projection-store-dir <dir>` to keep the content-addressable
projection cache inside a project-scoped release or CI scratch directory; the
default remains `~/.skillpool/projection-store` for interactive reuse. The
store must not overlap the projection output directory. Backend:
`build-projections.ts`.

`skill-sys validate-projections`
: Validate generated provider projection metadata, digests, and manual-only
provider controls, including recorded projection origins. Pass `--include-user`
and the same `--user-root <dir>` used for the build when validating projections
that contain user-origin skills; without `--include-user`, user-origin
directories are unexpected and validation fails closed. Backend:
`validate-projections.ts`.

`skill-sys workflow-chain`
: Validate and dry-run a declarative workflow file with `--source <dir>` and
`--workflow <file>`. The MVP resolves step skill references against
`skills/<name>/SKILL.md`, validates declared gate command vectors, and fails
closed when required gates are absent. It never executes steps, gate commands,
skill code, LLMs, tools, network calls, or containers. Use `--json` for
`schema/workflow-chain-verdict.schema.json` output and `--strict` to treat
warnings as blocking. Backend: `workflow-chain.ts`. See
[Workflow Chain Spec](../specs/workflow-chain.md). `--execute --adapter local-test`
is an explicit in-process fixture seam after a passing plan; it runs neither gate
commands nor skills. Missing or unsupported adapters block fail-closed.

`skill-sys route`
: Route a query to candidate skills with an explicit routing rules file:
`--source <dir> --rules <file> --query <text>`. The command is deterministic and
read-only: it validates rules, resolves skill references against
`skills/<name>/SKILL.md`, ranks trigger matches, and blocks risky skills unless
the route is marked `manualOnly: true`. It never activates skills, calls an LLM,
opens the network, executes tools, or writes output files. Use `--json` for
`schema/route-result.schema.json` output and `--strict` to treat warnings as
blocking. Backend: `route.ts`. See [Skill Routing Spec](../specs/skill-routing.md).
`--execute --adapter local-test` is a local in-process fixture seam after a
passing route result; it receives only a bounded sanitized candidate set and
never activates a skill. Missing, unsupported, invalid, non-deterministic, or
manual-only decisions block fail-closed.

`skill-sys team-mode`
: Validate a team-mode config with `--source <dir> --config <file>`. The command
is deterministic and read-only: it checks that team mode stores only shared
policy and lockfile references, rejects embedded catalogs, forbids symlink
install mode, and validates supported adapters/profiles. It never installs
skills, creates symlinks, executes tools, calls LLMs, opens the network, or
writes files. Use `--json` for `schema/team-mode-result.schema.json` output and
`--strict` to treat warnings as blocking. Backend: `team-mode.ts`. See
[Team Mode Spec](../specs/team-mode.md). Its registry metadata is derived from
the package-internal CommandSpec shared with the `team` alias. The CLI is
active; MCP remains unsupported.

`skill-sys dev-mode`
: Validate a local-only symlink development plan with `--source <dir> --config
<file>`. The command is deterministic and dry-run only: it requires
`devOnly: true`, `publicRelease: false`, `installMode: "symlink"`, and
`allowSymlinks: true`; resolves each skill; checks link targets stay under
`.agents/skills/` or `.skill-sys/dev-links/`; and emits `would-link` actions. It
never creates symlinks, installs skills, writes state, executes tools, calls
LLMs, or opens the network. Use `--json` for
`schema/dev-mode-result.schema.json` output and `--strict` to treat warnings as
blocking. Backend: `dev-mode.ts`. See [Dev Mode Spec](../specs/dev-mode.md).

`skill-sys project-learnings`
: Validate local/private project learnings with `--source <dir> --learnings
<file>`. The validate surface is deterministic and read-only: it requires
private/local visibility, blocks package-surface exposure, requires learnings
to live under local/private path prefixes, checks entries for malformed
ids/summaries and secret-looking text, and emits a verdict. Validate mode
never writes learnings, syncs memory, calls LLMs, opens the network, or changes
package surfaces. Use `--json` for `schema/project-learnings-result.schema.json`
output and `--strict` to treat warnings as blocking. Backend:
`project-learnings.ts`.
See [Project Learnings Spec](../specs/project-learnings.md). Its registry
metadata is derived from the validated internal `project.learnings.validate`
CommandSpec, the fourth migrated registry cohort. Alias: `learnings`. The CLI
remains active; MCP is unsupported. Append and update ship as write operations
via `skill-sys project-learnings append|update` with `--id <id> --summary
<text>` (plus `--source-entry <text>` for append and `--dry-run`), emitting
`schema/project-learnings-write-result.schema.json` output with `--json`; the
write surface is modeled by the internal `project.learnings.write` CommandSpec.

`skill-sys memory-adapter`
: Validate a local/private memory adapter interface with `--source <dir>
--config <file>`. The command is deterministic and read-only: it requires
private/local visibility, blocks package-surface exposure, requires adapter
config and storage paths to stay under local/private prefixes, requires explicit
read/write trust-policy opt-ins, and rejects sensitive memory policy or
secret-looking config text. Validate mode does not call LLMs, open the network,
or change package surfaces. Use `--json` for
`schema/memory-adapter-result.schema.json` output and `--strict` to treat
warnings as blocking. Backend: `memory-adapter.ts`. See
[Memory Adapter Spec](../specs/memory-adapter.md). Its registry metadata is
derived from the validated internal `memory.adapter.validate` CommandSpec, the
third migrated registry cohort. Alias: `memory`. The CLI remains active; MCP is
unsupported. An adapter declaration whose type is `mcp` is validated as inert
configuration data and does not activate a server, transport, or backend.
Read and write are explicit operations: `skill-sys memory-adapter read` returns
JSONL records only when `readOptIn` is enabled; `write` requires a read-write
JSONL adapter, `writeOptIn`, `--id <id>`, `--memory <text>`, and
`--source-entry <text>`. `--source` remains the project root; `--source-entry`
is persisted as record provenance. Use `--dry-run` to validate and render a
write without changing storage. Read and write emit
`schema/memory-adapter-read-result.schema.json` and
`schema/memory-adapter-write-result.schema.json`, respectively.

`skill-sys registry-export`
: Export the validated public registry surface as a deterministic interop bundle
with `--source <dir>`. The command first runs the existing registry surface
validation, then emits registry metadata, index, channels, advisories, and
declared artifact digests to stdout. `--output <file>` atomically writes the
portable bundle while preserving the result report on stdout. It never imports external
registries, resolves remote taps, opens the network, executes skills, or calls
LLMs. Use `--json` for `schema/registry-export-result.schema.json` output;
`--strict` is reserved for future warning-as-blocking checks. Alias:
`export-registry`. Backend: `registry-export.ts`. See
[Registry Interop Spec](../specs/registry-interop.md).

`skill-sys registry-import`
: Import a local `skill-sys-registry-export` bundle with
`--bundle <file> --output <dir>`.
The output directory must be empty or new. The adapter validates
canonical document digests, rejects remote taps and unsafe paths, and blocks
signed/provenance metadata that has no configured verification authority. It
never fetches a registry, executes skills, or treats `provenance: UNVERIFIED` as
trust. Use `--json` for
`schema/registry-import-result.schema.json` output; `--strict` is reserved for
future warning-as-blocking checks. Alias: `import-registry`. Backend:
`registry-import.ts`. See [Registry Interop Spec](../specs/registry-interop.md).

`skill-sys registry-trust`
: Score registry trust from a local scorecard and validated registry surface
with `--source <dir> --scorecard <file>`. The command first validates the public
registry fixture surface, then computes a deterministic 0-100 score from
pre-recorded local signals such as signed refs, digest pins, scans, sandbox,
evals, source trust, and docs completeness. It never generates evidence, writes
files, fetches remote registries, imports skills, executes skill code, calls
LLMs, or publishes telemetry. Use `--json` for
`schema/registry-trust-result.schema.json` output and `--strict` to promote
warnings to `BLOCKED`. Aliases: `registry-trust-score`, `trust-score`. Backend:
`registry-trust.ts`. Registry metadata is derived from the validated internal
`trust.registry.evaluate` CommandSpec, the fifth migrated cohort. The CLI is
active and MCP is unsupported. `PASS` and `CONCERNS` exit `0`; `BLOCKED` exits
`1`. Output can echo scorecard evidence and absolute local paths, so it must be
treated as potentially sensitive. See
[Registry Trust Score Spec](../specs/registry-trust-score.md).

`skill-sys inspect-skill --reference <ref>`
: Resolve a `skills.sh:<owner>/<repo>[/<path>]` catalog reference to a
canonical Git hint and a ready-to-paste `skill-sys.sources.json` fragment.
This command is offline-only: it never opens the network, performs provider
evidence lookups, or uses a cache. Options are `--reference <ref>`, `--json`,
and `--help`; legacy `--online`, `--strict`, and `--home <dir>` options are
deprecated and rejected. Backend: `inspect-skill.ts`. See
[skills.sh Integration](../integrations/skills-sh.md).

`skill-sys audit-installed`
: Read-only audit of skills installed by an external manager (currently
`--manager skills`). Scans a project lockfile/target, optional `--global`
user target, and optional `--verify-upstream` digest comparison. Options:
`--project <dir>`, `--lockfile <path>`, `--home <dir>`, `--strict`, `--json`.
Backend: `audit-installed.ts`. See
[External Install Ownership](../specs/external-install-ownership.md).

`skill-sys adopt-installed`
: Plan-only adoption of foreign-managed skills whose upstream digest matches
the installed tree. `--apply` is rejected until a governed ownership-state
spec lands. Options: `--project <dir>`, `--manager <id>`, `--lockfile <path>`,
`--home <dir>`, `--global`, `--json`. Backend: `adopt-installed.ts`. See
[External Install Ownership](../specs/external-install-ownership.md).

`skill-sys telemetry-policy`
: Validate a local telemetry policy with `--source <dir> --config <file>`
without collecting or sending telemetry. The command is read-only and offline:
it requires private/local visibility, blocks package-surface exposure, requires
config paths to stay under local/private prefixes, forbids remote telemetry URLs,
requires `localOnly: true`, and blocks enabled collection unless explicit opt-in
and approver fields are present. It never writes files, opens the network,
executes skills, reads private user roots, or calls LLMs. Use `--json` for
`schema/telemetry-policy-result.schema.json` output and `--strict` to promote
warnings to `BLOCKED`. Alias: `telemetry`. Backend: `telemetry-policy.ts`. See
[Telemetry Policy Spec](../specs/telemetry-policy.md).

  `bun scripts/commands/telemetry-policy.ts collect` is a separate, explicit local write
  operation. It requires an enabled policy with explicit opt-in and approver,
  a policy-approved `--skill`, caller-supplied safe `--event`, and `--output`
  under a local/private prefix. It appends deterministic metadata only; it does
  not send telemetry, create timestamps or identifiers, or run automatically.
  `--dry-run` does not write.

This is the first command whose existing registry metadata is projected from an
internal, runtime-validated CommandSpec. This cohort preserves the current CLI
behavior; MCP remains unsupported and no CLI/MCP parity is claimed.

`skill-sys eval triggers|collisions`
: Validate deterministic trigger fixtures under
`skills/*/evals/triggers.json` relative to a skillpack/private-overlay source
root or synthetic fixture. Backend: `eval.ts`.

`skill-sys eval harness`
: Validate deterministic behavioral eval fixtures under
`skills/*/evals/evals.json`. The harness is read-only and offline: it does not
execute skill code, call an LLM, open the network, or write outputs. Use `--json`
for `schema/eval-result.schema.json` output and `--strict` to treat warnings as
blocking. Backend: `eval-harness.ts`. See
[Skill Evals Spec](../specs/skill-evals.md).

`skill-sys eval value-gate`
: Compare a verified measured-eval receipt against immutable baseline evidence
and an explicit comparison policy. The command is offline and read-only: it
does not invoke models, fetch network data, create a baseline, or authorize
release. Supply `--receipt <file> --baseline <file> --policy <file>`; use
`--json` for `schema/value-gate-verdict.schema.json` output. Backend:
`value-gate.ts`. See
[Skill Value Gate Spec](../specs/skill-value-gate.md).

`skill-sys eval receipt`
: Validate a completed measured-eval receipt against caller-supplied source and
fixture SHA-256 digests, case IDs, provider, and exact model. This command is
read-only and offline: it reads one bounded JSON file and never invokes a
provider, reads credentials or environment configuration, measures metrics,
writes a receipt, or authorizes a release. Backend: `eval-receipt.ts`. See
[Measured Eval Receipt Spec](../specs/measured-eval-receipt.md).

`skill-sys semantic-audit`
: Audit skill descriptions for broad activation capture,
prompt-injection-shaped language, and near-duplicate descriptions. Backend:
`semantic-audit.ts`.

`doctor-all.ts --json`
: Run unified diagnostics and emit structured machine-readable status/checks
without human status prose. Backend: `doctor-all.ts`.

`skill-sys docs-check`
: Validate local Markdown links and bash command examples that reference
repository scripts or package scripts. Backend: `docs-check.ts`.

`markdown-link-guard.ts`
: Scan Markdown files for local links to non-existent paths, ambiguous
directory links (must point at explicit `README.md`/`SKILL.md`), and raw
`[[...]]` wikilinks outside code blocks or inline code. Takes positional
roots (default: `skills`). Options: `--include-codex` (adds
`$HOME/.codex/skills`), `--no-wikilinks`, `--help`. Prints findings as
`ERROR <code> <path>:<line>:<col> ...` and exits non-zero when issues are
found. Not a `skill-sys` dispatcher command. Backend:
`markdown-link-guard.ts`.

`markdown-strict-batch-fix.ts`
: Normalize Markdown files for strict linting: add missing fence languages,
expand compact tables, strip emphasis-only lines, and wrap prose to 80
columns. Takes explicit files, or scans the `skills/` tree by default. Prints
`Updated N Markdown file(s).` Not a `skill-sys` dispatcher command. Backend:
`markdown-strict-batch-fix.ts`.

`skill-change-guard.ts`
: Guard for changed skill files: detect changed files under `skills/` with
`--staged` (index) or `--base <git-ref> [--head <git-ref>]`, then run
`skill-metadata sync --staged --write` only when BOTH `--fix` and `--staged`
are set (a `--base ... --fix` run skips metadata sync), and
`markdown-strict-batch-fix.ts`
plus `markdownlint-cli2 --fix` when `--fix` is set (`--restage` re-adds fixed
files), lint the changed Markdown, run `check-skill.js` per changed skill
directory, `markdown-link-guard --no-wikilinks skills`,
`universal-contract --skills-root skills`, and `skillpool validate --source
.`. Prints `Skill change guard passed.` on success. Not a `skill-sys`
dispatcher command. Backend: `skill-change-guard.ts`.

`skill-sys provider-matrix`
: Generate or check the bounded provider capability matrix section in
`docs/compatibility-matrix.md` from `providers/*.json`. The generated section is
deterministic and host-independent: it contains no timestamp, absolute local
path, network result, or filesystem probe output. Use `--check` in CI to fail
when the checked-in matrix drifts from provider manifests. Options:
`--source <dir>`, `--output <path>`, `--check`. Alias:
`generate-provider-matrix`. Backend: `generate-provider-matrix.ts`.

`skill-sys create-skillpack <target>`
: Create a sanitized Skill-Sys skillpack scaffold at `<target>` with
`--visibility public|private`, `--providers <csv>`, `--profile <name>`, and
`--name <name>`. `--dry-run` prints the planned files without writing;
`--force` requires `--yes-i-understand-overwrite`. Prints
`STATUS: CREATED`/`STATUS: DRY-RUN` with the target and file list. Alias:
`skillpack-create`. Backend: `create-skillpack.ts`.

`skill-sys validate-skillpack`
: Validate a Skill-Sys skillpack manifest and local file contract with
`--source <dir>`. `--strict` treats WARN findings as blocking. Prints
`STATUS: PASS`, `STATUS: WARN`, or `STATUS: BLOCKING` with findings and exits
non-zero on blocking findings. Alias: `skillpack-validate`. Backend:
`validate-skillpack.ts`.

`skill-sys catalog`
: Generate or check deterministic Markdown/JSON skill cards from a skillpack
source into an explicit output directory. The command requires
`--source <skillpack-root>` and `--out-dir <dir>` and only writes
`skill-cards.json` / `skill-cards.md` under that output directory; it never
writes root `SKILLS.*` or root `skills/` files in this base repository. Use
`--format markdown|json|both` (default: `both`) and `--check` for drift checks.
The PR08 visibility flags (`--include-internal`, `--include-experimental`) are
supported. Alias: `generate-catalog`. Backend: `generate-skill-catalog.ts`.

`generate-skills-inventory.ts`
: Generate the repository skill inventory from checked-in `skills/`
`SKILL.md` files into `SKILLS.md` and `SKILLS.json` (schema version 1) in
repositories that contain a canonical `skills/` catalog. Deprecated,
archived, and compatibility-only skills are excluded; tier is computed from
line count and a `references/` folder; lifecycle redirects are sourced from
`skill-lifecycle.json`; skills with `metadata.internal` or
`metadata.experimental` are excluded by default. Options: `--include-internal`,
`--include-experimental`, `--help`. Not a `skill-sys` dispatcher command.
Backend: `generate-skills-inventory.ts`.

`skill-sys guard-repo-visibility`
: Fail closed unless the configured protected repository remains GitHub PRIVATE.
GitHub Actions provides `GH_TOKEN` and runs `ci:checks`, which delegates to
`validate:release` and this guard. The loud override
`--allow-public-after-explicit-user-approval` exists only for an explicit
maintainer-approved publication event and must never be wired into package
scripts or CI. Backend: `guard-repo-visibility.ts`.

`public-repository-audit.ts`
: Audit the tracked Git surface before public repository publication using
`git ls-files` plus reachable file contents, commit metadata, and annotated-tag
metadata. Forbidden roots include agent/config
trees (`.afol`, `.claude`, `.codex`, `.cursor`, `.gemini`, `.hermes`,
`.opencode`, `.qwen`), `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `RTK.md`, and
private `docs/` trees; `skills/` is allowed only for the public engine skill
root, and `skills/skill-sys/SKILL.md` is required. Prints `STATUS: BLOCKING`
with FORBIDDEN/HISTORICAL/MISSING lines when forbidden tracked or historical
paths remain; history remediation is never executed from this checkout.
Options: `--source <dir>`, `--json`. Backend: `public-repository-audit.ts`.

`coverage-gate.ts`
: Run `bun test --coverage` and enforce minimum line/function thresholds
(defaults: `--threshold-lines 80`, `--threshold-funcs 80`). The default run
parses Bun's TEXT coverage summary from the test output; the LCOV report at
`<coverage-dir>/lcov.info` is only read when `--no-run-tests` is passed (to
validate an existing report without running tests). Prints
`Coverage summary: lines X%, funcs Y%` then `STATUS: PASS` or `STATUS: FAIL`
with threshold errors and exits non-zero on failure. Options:
`--threshold-lines <n>`, `--threshold-funcs <n>`, `--coverage-dir <dir>`,
`--lcov-file <path>`, `--no-run-tests`. Backend: `coverage-gate.ts`.

`security-tool-status.ts`
: Report local availability of `codeql` or `scorecard` as a status check, not a
passing validation gate. Prints `STATUS: AVAILABLE` with the resolved path and
version, or `STATUS: UNAVAILABLE` (to stderr) pointing at the hosted GitHub
workflow and exits non-zero. The hosted workflow remains authoritative for
repository security scanning. Backend: `security-tool-status.ts`.

`normalize-skill-frontmatter.ts`
: Normalize `SKILL.md` frontmatter under `<root>/<skill>/` (default `skills`):
fill `name`/`description`, add `metadata.tags`/`triggers`/`version`/
`updated_at`/`target_provider`, normalize `compatible_providers`, and remove
legacy metadata keys. Writes in place by default; `--dry-run` only reports.
Prints `updated: <path>` lines and a `done: updated=N skipped=N total=M`
summary. Backend: `normalize-skill-frontmatter.ts`.

`skill-metadata.ts`
: Audit or sync skill metadata in `SKILL.md` frontmatter. Subcommands:
`audit` (validate metadata and detect pending git drift) and
`sync --all|--staged` (backfill every root `SKILL.md` or refresh changed skill
directories; dry-run unless `--write`). `--staged` syncs directories changed
in the git index; `--all` backfills everything. Options: `--skills-root <dir>`
(default: `./skills`), `--write`, `--strict` (audit: treat warnings as
blocking), `--default-provider <id>` (default: `universal`). Audit prints
`STATUS: PASS` or `STATUS: BLOCKING`/`STATUS: CONCERNS` with error/warning
counts and exits non-zero on errors; sync prints `updated:`/`unchanged:`/
`error:` lines and a `done: mode=...` summary. Not a `skill-sys` dispatcher
command. Backend: `skill-metadata.ts`.

`universal-contract.ts`
: Cross-platform `SKILL.md` contract checker/fixer. Requires YAML frontmatter
with `name` and `description`; allowed top-level keys are `name`,
`description`, `metadata`, `license`, and `allowed-tools`; CSV metadata fields
(`tags`, `triggers`, `references`, `compatible_providers`) must be CSV strings
(arrays/list syntax rejected); root skills require `metadata.version`,
`metadata.updated_at`, and `metadata.target_provider`. `--fix` auto-converts
CSV array/list syntax. Options: `--skills-root <dir>` (default: `./skills`),
`--only-with-skill-md`, `--fix`. Prints `STATUS: PASS` or `STATUS: BLOCKING`
and exits non-zero on findings. Not a `skill-sys` dispatcher command. Backend:
`universal-contract.ts`.

`skill-lifecycle.ts`
: Maintain the skill lifecycle changelog (`skill-lifecycle.json`) for removed,
archived, merged, renamed, and deprecated skills. Subcommands: `audit`
(validate the file: version, UTC `updated_at`, kebab-case names, required
`reason`/`agent_action`, replacement graph integrity, and repo-relative
references), `lookup <skill>` (show raw redirects/actions for a missing skill),
`resolve <skill>` (follow inactive replacements to one active skill or a
terminal removed/archived entry), and `record` (append an event; dry-run unless
`--write`). `resolve --json` emits the `skill-lifecycle-resolution/v1` contract;
resolution rejects missing or ambiguous nodes, self-replacements, and cycles.
Options: `--file <path>` (default: `./skill-lifecycle.json`),
`--skills-root <dir>` (default: `./skills`), `--json`, `--write`,
`--skill <name>`, `--event <event>`, `--date <YYYY-MM-DD>`, `--replacement
<csv>`, `--reason <text>`, `--agent-action <text>`, `--reference <path>`,
`--archive-path <path>`. Audit prints `STATUS: PASS` or `STATUS: BLOCKING`/
`STATUS: CONCERNS` and exits non-zero on errors. Not a `skill-sys` dispatcher
command. Backend: `skill-lifecycle.ts`.

`universal-skills-root.ts`
: Resolve the universal-skills root used by automation from
`UNIVERSAL_SKILLS_ROOT`, the repo root, or `apps/universal-skills` candidates
(a valid root has `skills/`, `scripts/`, and `README.md`). Default prints the
root; `--skills-dir`, `--tests-dir`, `--script <name>`, and `--path <relpath>`
print resolved paths. Backend: `universal-skills-root.ts`.

`skill-sys context <skill>`
: Emit a token-aware bundle for one skill. Backend: native `skill-sys`.

`skill-sys sync --project <dir> --profile <name> --plan|--apply`
: Build or apply a digest-based project sync plan using profile skills and a
shared project-local adapter target. Backend: `sync-plan.ts`. Legacy
`sync-skills` and `sync-global-core` flags remain supported through the same
command.

`sync-skills.ts`
: Sync skills from a source skills directory into a destination directory.
Validates the source with the universal contract (unless
`--no-contract-check`), runs a sensitive-content scan per skill, copies each
skill directory, and when the parent of `--from` has `skill-lifecycle.json`
copies it to `<to>/.skill-lifecycle.json` so installed agents can resolve
removed skills. `--delete` removes destination skills that do not exist in the
source; `--dry-run` prints actions without writing. Prints a `Done.` summary
with copied/skipped/removed counts. Dispatched by `skill-sys sync` when no
project/plan/apply/explain/repair or global-core flags are passed. Options:
`--from <dir>` (default: `./skills`), `--to <dir>` (default: `./skills`),
`--skills <csv>`, `--delete`, `--dry-run`, `--no-contract-check`. Not a
`skill-sys` dispatcher command. Backend: `sync-skills.ts`.

`sync-global-core.ts`
: Sync the declared global core skill set into user-global agent folders.
Reads the global core manifest (`globals/core.json` under `--source` by
default), validates the source skills with the universal contract (unless
`--no-contract-check`), and runs `sync-skills.ts` per selected app into the
app's resolved user-global target. `--delete-extra` removes destination
skills not declared in global core. The command records a digest-backed
`.global-core-managed.json` ledger per target. `--delete-skill <csv>` removes
only named skills that are absent from the manifest, ledger-owned in every
selected target, and unchanged since that ledger was written; unrelated
undeclared ledger entries are preserved. `--delete-extra` and `--delete-skill`
are mutually exclusive. `--dry-run` prints exact planned removals without
writing. Prints `STATUS: PASS` on success. Dispatched by
`skill-sys sync --global-core` or `--globals`. Options: `--source <dir>`
(default: repository root), `--manifest <file>` (default: `globals/core.json`),
`--apps <csv>` (default: manifest `defaultApps`), `--delete-extra`,
`--delete-skill <csv>`, `--no-contract-check`, `--dry-run`. Not a `skill-sys`
dispatcher command.
Backend: `sync-global-core.ts`.

`publish-skill.ts`
: Publish one improved skill from a project back to the central skills Git
repo. Requires `--app <app-name>` (opencode | codex | claude-code |
antigravity) and `--skill <skill-name>`. Default behavior is safe: fetch the
repo into a workdir under `~/.skillpool/publish/` (or `$SKILLPOOL_HOME/publish`),
copy the skill, run the sensitive-content scan, and list the changed files
(via `git status --porcelain`, not a full diff) without committing. `--commit` creates the commit, `--push` pushes to
`origin/<branch>` (implies `--commit`), and `--dry-run` skips
fetch/copy/commit/push. Options: `--repo <git-url-or-path>` (default: OpenCode
origin; fallback local path), `--project <dir>`, `--branch <name>` (default:
`main`), `--workdir <dir>`, `--message <text>`. Also shipped as a bin wrapper.
Not a `skill-sys` dispatcher command. Backend: `publish-skill.ts`.

`skill-sys rollback`
: Restore skills from a completed `.skill-sys-backup/<install-id>` payload.
Backend: `rollback.ts`.

`skill-sys remove`
: Plan or apply a safe uninstall of skill-sys-managed entries from a project
state file. Pass `--project <dir>` plus either `--skill <name>` or explicit
broad `--all`, and one of `--plan`, `--dry-run`, or `--apply`. `--apply` creates
rollback-compatible backups before deleting, requires `--confirm-all` for broad
removal, supports `--force` only to override digest/missing checks (never the
immediate pre-`rm` TOCTOU recheck), and writes `.skills.state.json` last. Use
`--json` for machine output. Backend: in-process
`scripts/modules/skillpool/remove.ts`.

Compatibility commands remain available: `install`, `upgrade`, `setup`, and
`init`. `setup` dispatches to `quick-install.ts` and `init` dispatches to
`bootstrap-skills.ts` (entries above). They are useful during migration, but
should not become the primary surface in new docs.

## Planned Command Surface

The release/provider projection roadmap tracks planned commands that are not
active yet:

- full rollback reconciliation for edge cases outside completed managed backup
  restores

Do not document these as available user commands until their implementations
land. For implemented behavior, see
[Current System Specs](../specs/current-system.md). For planned work, see
[Skill-Sys Roadmap](../roadmap.md) and the
[release/provider projection spec](../specs/release-verification-provider-projection.md).

## Pack And Locality Language

- `profile`: the canonical install manifest under `profiles/*.json`.
- `stack pack`: the repo-facing label for a project-local profile bundle such as
  `frontend` or `docs`.
- `foundation profile`: the stable project-local baseline in `profiles/core.json`.
- `project-only`: a skill that lives only in a target repo's `.agents/skills`
  tree. It is outside the shared universal catalog and is not installed or
  removed by `skill-sys`.

Examples:

```bash
skill-sys list --profile frontend
skill-sys list --profile docs --json
skill-sys find react --profile frontend
skill-sys find docs --stack documentation
```

## Source Grammar

`skill-sys add` accepts one positional source:

```bash
# local directory
skill-sys add ./local-skillpack --project .

# explicit local skill directory under a project
skill-sys add ./skills/foo --project .

# Git SSH URL (including ref override)
skill-sys add git@gitlab.com:org/repo.git --project . --ref v1.0.0

# Git HTTPS URL (including ref override)
skill-sys add https://github.com/org/repo --project . --ref v1.0.0

# GitHub tree URL with skills/ delimiter and slash-containing ref
skill-sys add https://github.com/org/repo/tree/release/skill/v1/skills/foo --project .

# GitLab tree URL with skills/ delimiter and slash-containing ref
skill-sys add https://gitlab.com/org/repo/-/tree/release/skill/v1/skills/foo --project .
```

Classification rules:

- `./...` or existing local path -> forwarded as `--source <path>`
- `owner/repo` -> expanded to `https://github.com/owner/repo.git`
- Git URLs and SSH specs (`git@...`, `https://...`) -> forwarded as `--repo <repo>`
- `#ref` suffix -> forwarded as `--ref <ref>` unless `--ref` is already passed
- GitHub tree URL with explicit `skills/` path segment ->
  `https://github.com/<org>/<repo>/tree/<ref>/skills/<...>`
  forwards `--repo <repo>`, `--ref <ref>` and `--skill-path <...>`
  after safe-path validation.
- GitLab tree URLs use `https://gitlab.com/<namespace>/<repo>/-/tree/<ref>/skills/<...>`
  and resolve identically after safe-path validation.
- `ref` may contain `/` and must be preserved when parsing tree URLs, e.g.
  `https://github.com/org/repo/tree/release/skill/v1/skills/foo`.
- `skills/` (plural) is the only accepted in-path delimiter.
- singular `skill/` is allowed only inside the ref component and is never treated as
a path delimiter.

Fail-closed examples:

```bash
# path traversal or parent escapes
skill-sys add ../etc/passwd --project .

# user-home source roots are not accepted as project-local add sources
skill-sys add ~/.skill-sys --project .
skill-sys add $HOME/.skill-sys --project .

# credentialed URLs are rejected
skill-sys add https://user:pass@github.com/org/repo.git --project .

# tree URL without skills/ delimiter is rejected
skill-sys add https://github.com/org/repo/tree/main/my/dir --project .

# tree path traversal through skill path is rejected
skill-sys add https://github.com/org/repo/tree/main/skills/../foo --project .

# ambiguous trees with multiple skills/ segments are rejected
skill-sys add https://github.com/org/repo/tree/main/skills/a/skills/b --project .
```

## Common Options

| Option | Meaning |
| --- | --- |
| `--project <dir>` | Target project directory. |
| `--skill <name>` | Single skill selector; forwarded as `--skills <name>`. |
| `--agent <app>` | Public alias for `--app <app>`. |
| `--dry-run` | Preview when the backend supports it. |
| `--debug-state` | For `add/install`, write debug state with local paths. |
| `--projection-dir <dir>` | For `add/install/update`, forward provider projection output to `skillpool install`/`skillpool upgrade`. On `update`, pair with `--install-mode projection` for a projection-aware reinstall. |
| `--install-mode <projection\|copy\|symlink>` | For `add/install/update`, choose explicit install semantics. `projection` is release-safe, `copy` maps to the legacy raw install compatibility path, and `symlink` is rejected in public/release install. |
| `--json` | Machine-readable output for supported commands. |
| `--no-install` | For `update`, only edit lockfile metadata. |
| `--state-safety` | For `doctor`, validate state privacy and ignore rules. |
| `--budget` | For `doctor`, run provider listing budget checks. |
| `--provider <id>` | Provider lens for eval, budget, and projections. |
| `--include-user` | Include user-root skills for projection input. |
| `--include-internal` | Reveal skills with `metadata.internal` set for `skill-sys list`/`find` and backend list/inventory scripts. Hidden by default. |
| `--include-experimental` | Reveal skills with `metadata.experimental` set for `skill-sys list`/`find` and backend list/inventory scripts. Hidden by default. |
| `--user-root <dir>` | Override the user root for opt-in commands. |

## User Skill Roots

User skill roots let users keep private skills outside this repository and
outside any project-owned private mirror repo. A user root may be an unversioned
local directory or a checkout of any repository the user chooses.

- Default root: `SKILL_SYS_USER_ROOT` when set, otherwise `~/.skill-sys`.
- Expected layout: `<userRoot>/skills/<skill>/SKILL.md`.
- Projection opt-in: `skill-sys build-projections --include-user`.
- Root override: `skill-sys build-projections --include-user --user-root <dir>`.
- User-origin validation must opt in with the same root:

  ```bash
  skill-sys build-projections \
    --include-user \
    --user-root ~/.skill-sys \
    --providers all
  skill-sys validate-projections \
    --include-user \
    --user-root ~/.skill-sys \
    --providers all
  ```

- Without `--include-user`, user-origin projection directories are unexpected and
  `validate-projections` fails closed.
- Non-clean opt-out builds prune stale user-origin projections instead of
  preserving private outputs after user roots are omitted.
- Source symlinks fail closed for projection input.
- Metadata: user skills are recorded with `origin: "user"` and
  `canonicalPath: "user:skills/<skill>"`; public/source skills use
  `origin: "public"`.
- Duplicate names across public/source skills and user skills fail closed.

### Named Roots And Project Config

Future tool config may let users define root aliases instead of passing raw paths
every time. This is intended for ergonomics, not for changing public/private
boundaries.

Example conceptual config:

```toml
[[roots]]
name = "personal"
path = "~/.skill-sys"
visibility = "private"
tags = ["private", "daily"]
providers = ["codex", "opencode"]

[[roots]]
name = "project-private"
path = "./.skill-sys/private-skills"
visibility = "private"
tags = ["project"]
providers = ["codex"]
```

Planned CLI shape (not implemented yet; current commands still use
`--user-root <dir>` or `--source <userRoot>`):

```bash
skill-sys build-projections --include-user --root personal --providers codex
skill-sys scan-sensitive --root project-private
skill-sys roots list --project .
```

Global config applies across projects; project config may add local roots or
rename/tag roots for local convenience. A project-local root may be a real Git
checkout, submodule, or worktree inside the project as long as the project public
surface excludes it. Symlinked skill payloads still fail closed; prefer a named
config root over projecting through symlinked `skills/<skill>` entries.

User roots are user-owned/private. Defaults, public audit, packlist, release
checksums, release manifests, Skill BOMs, channels, publication gates, and npm
package artifacts must never include user roots or their user-chosen remotes.

## Release Artifact Policy

`skill-sys install` and `skill-sys add` still accept the compatibility checksum
gate through the backend:

```bash
skill-sys add git@github.com:org/skills.git \
  --project . \
  --ref v1.4.0 \
  --verify-signed-tag \
  --expected-source-sha256 <sha256>
```

For release-grade installs, prefer lockfile policy generated from the release
artifacts:

```json
{
  "policy": {
    "releaseTag": "v1.4.0",
    "requireReleaseManifest": true,
    "expectedReleaseManifestSha256": "<manifest-sha256>",
    "requireSkillBom": true,
    "expectedSkillBomSha256": "<skill-bom-sha256>"
  }
}
```

The release source checksum, manifest directory/file digests, Skill BOM source
checksum, and verification rebuild all use the configured artifact surface. For
legacy/user-root sources this may be `artifact-surface.json`; for the
base/public-engine repo the checked surfaces live under `artifact-surfaces/`.
Critical future provider/projection surfaces must be added to the relevant
registry before they are accepted by release tooling.

`release-prepare` writes the artifact files under:

- `releases/checksums/vX.Y.Z.sha256`
- `releases/manifests/vX.Y.Z.json`
- `releases/boms/vX.Y.Z.skill-bom.json`
- `releases/channels/<channel>.json` when `--channel <channel>` is run from an
  already prepared release checkout

Verify committed release manifest/BOM artifacts before signing or consuming
them:

```bash
bun scripts/commands/release-verify.ts --source . --version vX.Y.Z
```

Verify a release channel before promoting it to agent update flows:

```bash
bun scripts/commands/release-verify.ts \
  --source . \
  --version vX.Y.Z \
  --channel stable
```

Channel metadata records the immutable release tag, full commit SHA, source
checksum, release manifest checksum, skill BOM checksum, and the policy required
by stable consumers. The stable channel must disable floating refs, require a
signed tag, require source checksum verification, and require release manifest
plus skill BOM verification. `release-verify --channel` enforces signed-tag
verification for `stable` and `candidate` channels whenever
`policy.requireSignedTag` is true. Run channel promotion after the release
commit/tag exists; do not combine `--channel` with `--commit`, `--tag`, or
`--push`.

Verify source/release origin policy before consuming a release checkout:

```bash
bun scripts/commands/skill-sys.ts verify-origin \
  --source . \
  --version vX.Y.Z \
  --source-commit <full-sha> \
  --expected-source-sha256 <source-sha256> \
  --expected-release-manifest-sha256 <manifest-sha256> \
  --expected-skill-bom-sha256 <skill-bom-sha256> \
  --require-source-commit \
  --require-source-checksum \
  --require-release-manifest \
  --require-skill-bom
```

This baseline prints separate `LOCAL_INTEGRITY`, `ORIGIN`, and `PROVENANCE`
status lines. Required Cosign bundles or GitHub attestations currently fail
with `UNSUPPORTED_PROVENANCE_POLICY`; they are not treated as warnings.

Generate and verify release artifacts from a clean checkout or disposable
worktree. Runtime files ignored by git, including `__pycache__`, `.venv`, and
local caches, are excluded from release checksums and skill BOMs so local
execution noise cannot poison the published contract.

In a future/publication or user-root release workflow approved by the
maintainer,
a pushed `vX.Y.Z` tag may run `.github/workflows/release-artifacts.yml` to sign
committed files and upload the files plus `.sigstore.json` bundles to a GitHub
Release. The base/public-engine staging repo must not treat this as an active
publication path before explicit approval. GitHub/SLSA provenance attestations
are created only when GitHub Artifact Attestations are available for the
repository.

Consumer verification:

```bash
CERT_ID="https://github.com/OWNER/REPO/.github/workflows/release-artifacts.yml@refs/tags/vX.Y.Z"
cosign verify-blob vX.Y.Z.skill-bom.json \
  --bundle vX.Y.Z.skill-bom.json.sigstore.json \
  --certificate-identity "$CERT_ID" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

```bash
gh attestation verify vX.Y.Z.skill-bom.json \
  -R OWNER/REPO \
  --signer-workflow OWNER/REPO/.github/workflows/release-artifacts.yml \
  --source-ref refs/tags/vX.Y.Z
```

Repeat the same checks for `vX.Y.Z.sha256`, `vX.Y.Z.json`, and
`vX.Y.Z.skill-bom.json` using each file's matching `.sigstore.json` bundle.
Run `gh attestation verify` only for releases where the workflow created
GitHub attestations.

## Context Bundles

`skill-sys context <skill>` emits only the files needed for an agent prompt:

```bash
skill-sys context writing-skills --tier quick
skill-sys context writing-skills --tier standard --format json
skill-sys context writing-skills --tier deep
```

Tiers:

`quick`
: `SKILL.md` only.

`standard`
: `SKILL.md`, `gotchas.md`, and direct `references/**/README.md` files.

`deep`
: Every Markdown file under the skill directory.

The bundle includes `approx_tokens`, calculated as a conservative character/4
estimate. Use it to choose the smallest tier that still preserves the needed
context.
