# Release Verification And Provider Projection Spec

This spec promotes the May 18, 2026 architecture analysis into the durable
project target for the next `skill-sys` architecture wave. The detailed session
record remains outside the public package surface.

## Problem

`universall-skill-sys` already has a strong base/public-engine surface: Bun CLI
commands, adapters, profiles, global core, lockfiles, source checksums, release
manifests, Skill BOMs, validation, doctor checks, release workflows, and guards.
Its GitHub visibility remains PRIVATE during staging until the repository owner explicitly
approves publication.

The remaining risk is that skills are operational capability packages, not
passive text files. A `description` affects automatic selection, `SKILL.md`
changes agent behavior, bundled scripts may run, and each provider interprets
activation, tools, scope, and permissions differently.

The current implementation still has folder-copy behavior in important places:

- `skillpool install` can install verified provider projection output when
  `--projection-dir` is supplied; canonical raw copies remain available only via
  the explicit `--legacy-raw-install` compatibility flag.
- default `.skills.state.json` no longer records local absolute paths.
- source cache now uses exact depth-1 fetch and commit-keyed reuse, but reusable
  partial-clone mode is not built yet.
- copy/install/release surfaces now have a sensitive-file scanner.
- install now stages payloads, verifies digests, swaps targets, keeps completed
  backups, and writes state last.
- provider metadata is validated but does not yet drive projections.

## Architecture Principle

The product model is:

```text
Canonical skill intent
  -> universal contract
  -> release and origin verification
  -> provider capability matrix
  -> provider projection
  -> atomic install
  -> doctor, rollback, and audit
```

The canonical skill remains the source of truth. Provider outputs are derived
artifacts. They should not become hand-edited sources.

## Terminology

Canonical skill:

- The source under `skills/<name>/` inside a skillpack/public source or an
  explicitly enabled user-local root.
- User-local skills live outside the repo at `<userRoot>/skills/<name>/`, where
  `<userRoot>` resolves from `--user-root <dir>`, then `SKILL_SYS_USER_ROOT`,
  then `~/.skill-sys`.
- In `universall-skill-sys`, root `skills/<name>/` is only a contract shape; the
  public fixture lives under `examples/minimal-skillpack/skills/`.
- It expresses intent, workflow, references, scripts, assets, metadata, risk,
  and evals.

Skill origin:

- `public`: a skill from the base/public artifact source or a public skillpack
  source selected by the command.
- `user`: a local/private skill from the user skill root. User origins are never
  shipped, packed, released, or included by default.

User canonical path:

- User-root skills use `user:skills/<skill>` in projection metadata.
- Public/base skills continue to use repo-relative canonical paths such as
  `skills/<skill>` or fixture/source-relative equivalents.

Universal contract:

- The provider-neutral validation subset that every active skill must satisfy.

Provider capability matrix:

- A checked-in description of provider paths, activation rules, duplicate
  behavior, budget constraints, and permission semantics.

Projection:

- A generated provider-specific output produced from the canonical skill,
  optional overlay, provider capability matrix, and renderer version.

Overlay:

- A minimal provider-specific delta. It is not a second source of truth and is
  only allowed after the provider matrix proves a real provider delta.

Managed install:

- A target tree entry that has state evidence proving `skill-sys` owns the
  installed copy and can safely update or remove it.

Projection manifest:

- `build-projections` writes `projection-manifest.json` at the projection output
  root.
- The manifest records schema version, renderer version, provider list,
  projection count, per-projection metadata, origin summary, and cache counters
  for cached vs rebuilt projection records.
- Each projection record includes `origin: "public" | "user"`. User-origin
  records use `canonicalPath: "user:skills/<skill>"`.
- `validate-projections` fails closed when the manifest is missing or diverges
  from the per-skill `projection.meta.json` records.

Current constraints:

- Project-local installs keep using one shared `.agents/skills` target.
- Project adapters must not fan out into `.codex/`, `.claude/`, `.gemini/`, or
  `.qwen/` directories.
- User roots are outside all public artifact surfaces. Defaults, public audit,
  packlist, release checksums, release manifests, Skill BOMs, channel metadata,
  and publication gates must not traverse or package user roots.
- Projection commands may include user roots only with `--include-user`; without
  that flag, user-local skills do not exist for projection, validation, release,
  or audit purposes.
- Duplicate skill names across public/base and user origins fail closed. Do not
  merge, shadow, or prefer one origin implicitly.
- `globals/core.json` remains a user-root/legacy compatibility manifest
  for app-specific user-global sync; the base/public-engine repo does not ship a
  private global-core manifest.
- OpenCode global skills target `~/.config/opencode/skills`.
- Global-core skills stay out of project installs by default unless explicitly
  allowed.
- Destructive delete/prune behavior requires managed-root evidence first.

## Target Guarantees

Origin:

- The installer can prove the repo, ref, commit, release tag, release manifest,
  Skill BOM, and optional provenance identity.

Integrity:

- Source checksum, release manifest, Skill BOM, artifact surface, and projection
  digests are computed from one shared definition of critical surfaces.

Compatibility:

- Provider-specific activation, path, duplicate, budget, and permission
  semantics are explicit in a provider capability matrix.

Security:

- Sensitive files and known secret patterns fail validation before copy,
  release, publish, or sync.
- Risky skills can be marked manual-only or permission-restricted per provider.
- Semantic trigger/collision checks catch overly broad or adversarial skill
  descriptions.

Reproducibility:

- Install is staged, verified, swapped atomically, and state is written last.
- Repeated syncs compare digests and can explain no-op/update/remove decisions.
- Rollback can restore the previous managed install.

## Scope

In scope:

- state privacy and state safety doctor checks
- sensitive file and secret scanner
- exact fetch/cache behavior
- atomic install transaction
- shared artifact surface registry
- release origin verification
- provider capability matrix
- projection build/validation
- provider-specific doctors
- semantic trigger/collision evals
- digest sync, explain output, and rollback
- docs-as-code checks for command and path drift

Out of scope for the first implementation block:

- project-local provider fan-out
- hand-edited generated provider outputs
- destructive stale removal without managed-root proof
- model-backed trigger evals before deterministic fixtures exist
- OpenCode agent rendering before a risk profile proves it is needed

## Artifact Surface Registry

Use declared surfaces so checksum, release manifests, Skill BOM source
checksums, verification, public artifact audit, and later doctor checks do not
drift.

Current base/public-engine surface files:

```text
artifact-surfaces/engine-public.json
artifact-surfaces/skillpack-public.json
schema/artifact-surface.schema.json
scripts/modules/skillpool/public-surface.ts
scripts/modules/skillpool/privacy-scan.ts
```

Current base/public-engine surface:

```json
{
  "version": 1,
  "requiredDirectories": [
    "adapters",
    "docs/explanation",
    "docs/map",
    "docs/reference",
    "docs/specs",
    "examples",
    "overlays",
    "profiles",
    "providers",
    "schema",
    "scripts/bin",
    "scripts/commands",
    "scripts/lib",
    "scripts/modules",
    "scripts/ops"
  ],
  "requiredFiles": [
    ".github/CODEOWNERS",
    "CONTRIBUTING.md",
    "README.md",
    "SECURITY.md",
    "artifact-surfaces/engine-public.json",
    "artifact-surfaces/skillpack-public.json",
    "bun.lock",
    "docs/compatibility-matrix.md",
    "docs/manifesto.md",
    "docs/on-demand-loading.md",
    "docs/roadmap.md",
    "docs/skill-lifecycle.md",
    "docs/windows-onboarding.md",
    "index.json",
    "package.json",
    "privacy-allowlist.public.json",
    "scripts/README.md"
  ],
  "forbiddenInArtifactPaths": [
    ".agents",
    ".arq",
    "provider-map-directories",
    "artifact-surface.json",
    "globals/core.json",
    "logs",
    "releases",
    "skill-lifecycle.json",
    "skills",
    "SKILLS.json",
    "SKILLS.md",
    "tmp"
  ],
  "denyUntrackedCriticalSurfaces": true
}
```

The source-checksum compatibility surface is still named `artifact-surface.json`
when a skillpack or user-chosen source checks it in. That source surface may
include root `skills`, `globals/core.json`, `SKILLS.json`, and `SKILLS.md` for a
User Skill Root or another skillpack source. Those paths are forbidden from the
current base/public-engine artifact above.

Provider projection surfaces in the base repo:

- `providers`
- `overlays`
- projection renderer modules
- projection schemas

Current implementation status:

- `artifact-surfaces/engine-public.json` and
  `artifact-surfaces/skillpack-public.json` exist for the base/public-engine
  gates.
- `public-audit`, `scan-privacy --surface engine-public`, and `packlist` consume
  the public artifact surfaces.
- `source-checksum`, release manifest generation, Skill BOM source checksums,
  and release artifact verification retain the legacy/user-root
  `artifact-surface.json` compatibility path for skillpack sources.
- `providers/` and `overlays/` are registered public-engine surfaces; `dist/`
  remains generated and ignored.

The registry must continue to reject critical new directories that are not
represented in the relevant public or private-overlay artifact surface.

## Sensitive Scanner

The scanner must run before copying, releasing, publishing, or syncing skill
content.

Filename denylist:

```text
.env
.env.*
*.pem
*.key
id_rsa
id_ed25519
auth state JSON files
provider auth state JSON files
oauth state JSON files
2fa state JSON files
personal auth JSON files
*.kdbx
*.p12
*.pfx
*.sqlite
*.db
```

Content patterns:

```text
ghp_
github_pat_
AKIA
ASIA
xoxb-
sk-
AIza
-----BEGIN .*PRIVATE KEY-----
```

The scanner should support an explicit fixture allowlist only for test data, not
for real skill content.

## Cache And Fetch Strategy

The default source-fetch path does not clone the full repository after a shallow
fetch failure. It initializes a local repository, fetches the selected ref with
depth 1, checks out a detached ref, and fails closed if exact fetch cannot
resolve the requested ref.

Modes:

`fast-ephemeral`
: Initialize an empty repo, fetch the exact ref with `--depth 1`, then checkout
detached.

`reusable`
: Planned mode. Use partial clone with `--filter=blob:none` and cache by
resolved commit.

`strict-release`
: Planned mode. Fetch an exact tag or commit, verify signed tag and release
artifacts, then expose the source to install.

Cache keys:

- source repo identity
- resolved full commit
- source checksum
- release manifest digest
- Skill BOM digest
- projection digest when projection exists

## Atomic Install Transaction

Install must become:

```text
resolve source
verify origin
build install plan
build or select provider projection
validate projection
copy to temp transaction dir
verify temp digest
swap atomically
write state last
```

Directory policy:

```text
.agents/skills/.skill-sys-tmp/<install-id>/
.agents/skills/.skill-sys-backup/<previous-id>/
.agents/skills/<skill>/
```

Rules:

- Never remove the old skill before the new copy validates.
- Never write state before the target swap succeeds.
- Keep enough backup state for one rollback.
- `doctor` must detect orphan temp dirs, missing state, and partial installs.
- `sync --repair` may clean orphan temp dirs only after validating they are
  `skill-sys` transaction directories.

## Provider Rules

Codex:

- Keep `.agents/skills` as the project-local target.
- Detect duplicate skill names across repository, user, admin, and system
  surfaces.
- Estimate initial skill-list budget and recommend manual-only or description
  trimming when needed.
- Use `agents/openai.yaml` only as a generated projection artifact when a risk
  profile requires invocation policy or provider metadata.

Claude Code:

- Treat `allowed-tools` as permission grant, not a restriction.
- Generate or warn about deny-baseline settings when a skill grants broad
  permissions.
- Use `disable-model-invocation: true` for side-effectful workflows.
- Account for enterprise, personal, project, and plugin precedence in doctor
  checks.

OpenCode:

- Keep skill folder sync for current global-core behavior.
- For high-risk or review-only workflows, allow later projection to OpenCode
  agent Markdown with explicit `permission` defaults.
- Do not force every skill into an agent; the provider matrix decides.

Gemini CLI, Qwen, and Antigravity:

- Keep them as global-core targets unless a concrete project-local contract is
  added and validated.
- Gemini CLI and Antigravity intentionally share the current `~/.gemini/skills`
  user-skill path in the baseline provider matrix; Antigravity-specific behavior
  must stay documented as compatibility until a separate contract is proven.
- Qwen uses `~/.qwen/skills` for user-global skill sync.
- These providers do not currently enforce generated permission files; manual-only
  projection metadata still records shell, network, destructive,
  credential-sensitive, and invocation risk so downstream doctors can fail closed
  when provider controls are added.

## Provider Capability Matrix

Example shape:

```json
{
  "provider": "claude-code",
  "skillPaths": {
    "personal": "~/.claude/skills",
    "project": ".claude/skills"
  },
  "supports": {
    "description": true,
    "whenToUse": true,
    "disableModelInvocation": true,
    "userInvocable": true,
    "allowedTools": true,
    "dynamicContext": true,
    "arguments": true,
    "skillOverrides": true
  },
  "dangerNotes": [
    "allowed-tools grants permission but does not restrict other tools",
    "project skills require workspace trust",
    "skills with side effects should use disable-model-invocation"
  ]
}
```

Codex matrix requirements:

- project target: `.agents/skills`
- global target: `~/.codex/skills`
- implicit selection field: `description`
- duplicate behavior: show duplicate names without merging
- budget behavior: initial list can omit or shorten skills when too large

Claude matrix requirements:

- model enterprise, personal, project, and plugin scopes separately
- record scope precedence
- record command-name precedence risk
- treat `allowed-tools` as grant-only

OpenCode matrix requirements:

- represent `primary`, `subagent`, and `all` modes
- represent `read`, `edit`, `bash`, `task`, `webfetch`, `websearch`,
  `external_directory`, and `skill` permission defaults
- allow skill-to-agent projection for high-risk or review-only workflows

## Risk Profile

Every skill should eventually have a risk profile. The first rollout can cover
global core and newly changed skills.

```json
{
  "risk": {
    "readsFiles": true,
    "writesProject": false,
    "writesGlobal": false,
    "executesShell": false,
    "networkAccess": false,
    "externalDirectory": false,
    "credentialSensitive": false,
    "destructive": false
  },
  "invocation": {
    "implicitAllowed": true,
    "manualOnly": false
  }
}
```

Policy:

- If `destructive`, `writesGlobal`, `credentialSensitive`, or `executesShell`
  is true, implicit invocation is denied until an explicit exception exists.
- Codex projection should emit or reference provider policy that disables
  implicit invocation when supported.
- Claude projection should use `disable-model-invocation: true` for side-effect
  workflows.
- OpenCode projection should default risky permissions to `ask` or `deny`.
- Global core blocks risky skills by default.

## Projection Manifest

Release manifests must eventually include provider projection digests.

```json
{
  "release": "v0.4.0",
  "sourceChecksum": "<sha256>",
  "contractVersion": "2.0",
  "skills": [
    {
      "name": "writing-skills",
      "canonicalDigest": "sha256:<hex>",
      "providers": {
        "codex": {
          "projectionDigest": "sha256:<hex>",
          "rendererVersion": "1"
        },
        "claude-code": {
          "projectionDigest": "sha256:<hex>",
          "rendererVersion": "1"
        }
      }
    }
  ]
}
```

Projection validation must fail if:

- output references a file outside the projection root
- overlay paths traverse outside the skill root
- overlay contains symlinks
- renderer would remove files without an explicit remove policy
- provider output violates the provider matrix
- projection digest does not match the release manifest

## State Format Direction

Default state mode is `minimal`.

```json
{
  "schemaVersion": 2,
  "mode": "minimal",
  "updatedAt": "2026-05-18T00:00:00.000Z",
  "source": {
    "repo": "<user-chosen-skill-repo-url>",
    "ref": "v0.4.0",
    "commit": "<full-sha>",
    "releaseTag": "v0.4.0",
    "sourceChecksum": "<sha256>",
    "manifestSha256": "<sha256>",
    "skillBomSha256": "<sha256>"
  },
  "installed": [
    {
      "app": "codex",
      "skill": "writing-skills",
      "target": ".agents/skills/writing-skills",
      "canonicalDigest": "sha256:<hex>",
      "projectionDigest": "sha256:<hex>"
    }
  ]
}
```

Absolute local paths are allowed only in debug mode behind an explicit
`--debug-state` flag. The example uses a private source identity only as legacy
state-format evidence; user-root skills should instead record `origin: "user"`
and `canonicalPath: "user:skills/<skill>"`. Base-engine-only installs can point
to `universall-skill-sys` when they consume only public engine artifacts or
synthetic fixtures.

## Origin Policy

Lockfile policy should distinguish integrity, origin, and provenance. The
provenance workflow names in this section are future/publication examples or
user-root release-policy examples only. The base/public-engine staging repo
must not publish GitHub Release assets or require public-release provenance until
the repository owner explicitly approves that release posture.

```json
{
  "policy": {
    "requireRefExists": true,
    "requireSignedTag": true,
    "requireSourceCommit": true,
    "sourceCommit": "<full-sha>",
    "requireReleaseManifest": true,
    "expectedReleaseManifestSha256": "<sha256>",
    "requireSkillBom": true,
    "expectedSkillBomSha256": "<sha256>",
    "requireCosignBundles": true,
    "cosign": {
      "certificateIdentity": "https://github.com/OWNER/REPO/.github/workflows/release-artifacts.yml@refs/tags/vX.Y.Z",
      "certificateOidcIssuer": "https://token.actions.githubusercontent.com"
    },
    "requireGithubAttestation": true,
    "githubAttestation": {
      "repository": "OWNER/REPO",
      "sourceRef": "refs/tags/vX.Y.Z",
      "signerWorkflow": "OWNER/REPO/.github/workflows/release-artifacts.yml"
    }
  }
}
```

`verify-origin` checks:

1. ref exists
2. tag is signed when required
3. tag commit matches lockfile/source policy
4. source checksum matches
5. release manifest matches
6. Skill BOM matches
7. required Cosign bundle policy fails closed as unsupported in the current
   local baseline
8. required GitHub attestation policy fails closed as unsupported in the current
   local baseline

Future provenance work must add:

- Cosign bundle verification
- GitHub attestation verification
- workflow identity matching

## Commands To Add Or Extend

Already active from this roadmap:

- `skill-sys verify-origin --source . --version vX.Y.Z`
- `skill-sys scan-sensitive --source .`
- `skill-sys doctor --state-safety --project <dir>`
- `skill-sys build-projections --providers codex,claude-code,opencode`
- `skill-sys validate-projections --providers all`

Provider phase:

- `skill-sys build-projections --providers codex,claude-code,opencode`
- `skill-sys validate-projections --providers all`
- `skill-sys doctor --provider all --duplicates --budget --permissions`

Semantic phase:

- `skill-sys eval triggers --provider codex`
- `skill-sys eval collisions`
- `skill-sys semantic-audit --source .`
- `skill-sys doctor --budget --provider codex --global-core`

Sync phase:

- `skill-sys sync --project <dir> --profile core --plan --json`
- `skill-sys sync --project <dir> --profile core --apply`

The deterministic baseline is implemented for fixture validation, semantic
description heuristics, and provider budget estimates. Model-backed trigger
scoring and mandatory risky-skill eval policies remain roadmap work.

## Semantic Evals

Each important skill should have trigger evals.

```json
{
  "positive": [
    {
      "prompt": "Revise esse PR e encontre riscos de segurança",
      "expectedSkill": "code-review-expert"
    }
  ],
  "negative": [
    {
      "prompt": "Escreva um post para Instagram",
      "mustNotTrigger": "code-review-expert"
    }
  ],
  "ambiguous": [
    {
      "prompt": "Dá uma olhada nisso",
      "expected": "no_implicit_trigger"
    }
  ],
  "collision": [
    {
      "prompt": "Crie uma skill nova para TypeScript",
      "allowed": ["writing-skills", "typescript-skill"],
      "preferred": "writing-skills"
    }
  ]
}
```

Semantic audit must flag:

- descriptions that say "always use this skill"
- descriptions that capture broad unrelated work
- prompt-injection style instructions inside skill text
- near-duplicate descriptions
- missing negative evals for risky skills
- skills with side effects that still allow implicit invocation

## Docs-As-Code

The docs checker should validate:

- cited repo paths exist
- bash command examples point to real scripts or documented planned commands
- workflow paths and filters point to real files
- lockfile examples validate against schema
- removed command names are not presented as active
- planned commands are clearly marked as planned

Docs-as-code should run after command implementations exist. Until then,
planned commands may appear only in roadmap/spec sections that mark them as
planned.

## Acceptance Gates

Current public package P0 hardening gates are:

```bash
bun run validate:local
bun run validate:ci
bun run validate:release
bun run validate:publish
bun scripts/commands/skill-sys.ts scan-sensitive --source .
bun scripts/commands/skill-sys.ts verify-origin --source . --version vX.Y.Z
```

`metadata:audit`, `lifecycle:audit`, `doctor:all`, and `source:checksum` are
legacy/user-root or future package-script names, not active scripts in the
current public package.

Provider projection is complete when these pass:

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

Digest sync is complete when the second identical apply is a no-op:

```bash
bun scripts/commands/skill-sys.ts sync --project <fixture> --profile core --plan
bun scripts/commands/skill-sys.ts sync --project <fixture> --profile core --apply
bun scripts/commands/skill-sys.ts sync --project <fixture> --profile core --apply
```

## Evidence

Local evidence:

- `scripts/modules/skillpool/install.ts`
- `scripts/modules/skillpool/cache.ts`
- `scripts/lib/files.ts`
- `scripts/modules/skillpool/source.ts`
- `scripts/modules/skillpool/artifact-surface.ts`
- `scripts/modules/skillpool/release-artifacts.ts`
- `.github/workflows/release-artifacts.yml`
- `docs/compatibility-matrix.md`

Historical evidence for this spec was captured during the private-repo design
phase. Public/staging copies should cite sanitized ADRs or issue links instead
of local workbench paths.

## Issue Backlog Mapping

The roadmap's first issue package maps directly to this spec:

- state privacy and state-safety doctor: State Format Direction
- sensitive scanner: Sensitive Scanner
- clone fallback replacement: Cache And Fetch Strategy
- atomic install: Atomic Install Transaction
- artifact surface registry: Artifact Surface Registry
- origin verification: Origin Policy
- provider matrix and renderer: Provider Rules and Provider Capability Matrix
- risk metadata: Risk Profile
- projection release metadata: Projection Manifest
- semantic evals and collision detection: Semantic Evals
- docs checker: Docs-As-Code
