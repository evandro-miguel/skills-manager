# Compatibility Matrix

This matrix defines what is universal across apps and what is
adapter-specific.

## Two install surfaces

- `profiles/*.json` define project-local installs via lockfile.
- In repo-facing language, project-local `stack packs` are profile-based bundles.
- `globals/core.json` defines the replicated user-global core set for
  compatibility sources; user-local private skills live in User Skill Roots by
  default. If the user versions that root, the repository is user-chosen and
  outside this engine's release surface.
- These two layers are intentionally separate: project `core` is not the same
  thing as global core.

## Curation Terms

- `foundation profile`: the stable project-local baseline in `profiles/core.json`.
- `stack pack`: a project-local profile whose purpose is stack-oriented curation.
  Today that means the profile manifests marked with `"curation": "stack-pack"`
  such as `profiles/frontend.json` and `profiles/docs.json`.
- `global core`: the user-global replicated set in a source-root
  `globals/core.json` (private-overlay/legacy compatibility).
- `project-only`: a skill directory that exists only inside a target project's
  `.agents/skills` tree. It is project-owned, outside the shared universal
  catalog, and must not be treated as a deletion candidate during drift review.

The intent is to keep one installation model:

- profiles drive project-local installs
- global core drives user-global sync
- project-only remains a local runtime concern, not a new catalog/install layer

## Roadmap Boundary

The next architecture wave adds release verification and provider projection
without changing the current project-local target rule. The canonical plan is:

- [Current System Specs](./specs/current-system.md)
- [Skill-Sys Roadmap](./roadmap.md)
- [Release Verification And Provider Projection Spec](./specs/release-verification-provider-projection.md)

Provider projection means canonical skills are rendered into validated
provider-specific outputs when a provider needs a different activation,
permission, budget, or metadata shape. It does not mean project installs fan out
into provider folders. Until a new spec explicitly changes this, project-local
installs keep using shared `.agents/skills`.

## Source Serialization Candidates

`schema/source-manifest-v2.schema.json` and `schema/source-lock-v2.schema.json` are inactive schema-resource candidates. Their packaged presence and pure structural validators do not register, admit, persist, select, trust, verify, activate, or make a Source usable at runtime.

The Source v1 schemas and parsers remain byte-stable migration inputs. No v1-to-v2 compatibility classification, migration procedure, persisted-state transition, or runtime selection claim is active in this candidate slice.

## Universal Contract (All Apps)

The following rules are mandatory for all skills in `skills/<skill-name>/`
relative to a skillpack or User Skill Root source root or synthetic fixture:

- `SKILL.md` must exist.
- `SKILL.md` frontmatter requires:
  - `name`
  - `description`
  - `metadata`
- `metadata` requires:
  - `version` as semver `x.y.z`
  - `updated_at` as a UTC ISO timestamp
  - `target_provider` as a supported provider id
- Allowed top-level keys:
  - `name`
  - `description`
  - `metadata`
  - `license`
  - `allowed-tools`
- `name` must be kebab-case and match folder name.
- `description` must be single-line (no YAML multiline syntax).
- `metadata.tags`, `metadata.triggers`, `metadata.references`, and optional
  `metadata.compatible_providers` must be CSV strings.

Validator:

```bash
# Run from a skillpack or User Skill Root source root.
bun scripts/commands/universal-contract.ts --skills-root skills
```

## Adapter-Specific Paths

| App | Adapter | Target path (relative to project) |
| --- | --- | --- |
| OpenCode | `adapters/opencode.json` | `.agents/skills` |
| Codex | `adapters/codex.json` | `.agents/skills` |
| Claude Code | `adapters/claude-code.json` | `.agents/skills` |
| Antigravity | `adapters/antigravity.json` | `.agents/skills` |

Project-local installs intentionally use one shared `.agents/skills` target.
Do not fan out project skills into `.codex/`, `.gemini/`, `.qwen/`, or
`.claude/` folders; those app-specific folders are reserved for user-global
sync where applicable.

In this table, `.agents/skills` always means `<repo>/.agents/skills`. It never
means the user-level `~/.agents/skills` directory. Installers reject
`~/.agents/skills` as a project-local target because that path creates a second
global skills surface and causes duplicate loading in apps such as Codex.
This is a resolved-target rule: lexical aliases or symlinks that resolve to
`$HOME/.agents/skills` are rejected. It must not be interpreted as a ban on
project-owned `.agents/skills` folders, including projects located under
`$HOME`.

Project-local `.agents/skills` may also contain project-only skills that do not
come from this repository. Those directories are valid local extensions and are
not part of the universal drift/delete path.

## Global Core Targets

A source-root `globals/core.json` maps the replicated core set into user-global
folders for skillpack/user-root compatibility sources.

| App | Global target |
| --- | --- |
| OpenCode | `~/.config/opencode/skills` |
| Codex | `~/.codex/skills` |
| Qwen | `~/.qwen/skills` |
| Gemini CLI | `~/.gemini/skills` |
| Claude Code | `~/.claude/skills` |
| Antigravity | `~/.gemini/skills` |

Qwen and Gemini CLI do not have project adapters in this repository; they are
global-core targets only. For OpenCode, Codex, Claude Code, and Antigravity
project-local skill availability, keep the shared `.agents/skills` tree as the
project source of truth.

There is no supported user-global `~/.agents/skills` target. Use
`sync-global-core` for global app folders and `skillpool install` for real
project directories only.

## Operational Expectations

- Project adapters must pass smoke install checks against `.agents/skills` in CI.
- Global drift checks should compare only the manifest-selected core skills,
  not the full canonical catalog.
- Lockfile installs must use `repo + ref` pinning.
- Stable agent update channels must point at an immutable release tag and exact
  commit, not a floating branch. Channel metadata must record source checksum,
  release manifest checksum, skill BOM checksum, and a policy with
  `allowFloatingRef: false`, `requireSignedTag: true`, and
  `requireSourceChecksum: true`.
- Lockfile policy may enforce:
  - `minPoolVersion`
  - `requireRefExists`
  - `requireSignedTag`
  - `expectedSourceSha256`
  - `releaseTag`
  - `requireReleaseManifest`
  - `expectedReleaseManifestSha256`
  - `requireSkillBom`
  - `expectedSkillBomSha256`
- Release tags may run `.github/workflows/release-artifacts.yml` only in a
  future/publication or staging release workflow after the repository owner
  explicitly approves that release posture. The base/public-engine staging repo must not
  publish GitHub Release assets by default.
- Release CI must run `scripts/commands/release-verify.ts` before signing so
  the committed manifest and skill BOM match the checked-out source tree.
- Drift checks should use strict hash mode where possible.

## Known Differences Outside Skill Contract

- Some app runtimes have built-in system skills that are not part of this repository.
- Discovery/loading behavior may differ by app, but file contract and content
  validation remain universal.

<!-- BEGIN GENERATED PROVIDER MATRIX -->
<!-- Generated by scripts/commands/generate-provider-matrix.ts. Do not edit by hand. -->

## Provider Capability Matrix

| Provider | Display name | Project skills | User skills | Global skills |
| --- | --- | --- | --- | --- |
| `opencode` | OpenCode | `.agents/skills` | `~/.config/opencode/skills` | — |
| `codex` | Codex | `.agents/skills` | `~/.codex/skills` | — |
| `claude-code` | Claude Code | `.agents/skills` | `~/.claude/skills` | — |
| `antigravity` | Antigravity | `.agents/skills` | `~/.gemini/skills` | — |
| `qwen` | Qwen | `.agents/skills` | `~/.qwen/skills` | — |
| `gemini-cli` | Gemini CLI | `.agents/skills` | `~/.gemini/skills` | — |

### Detection paths

| Provider | Project | User | Global |
| --- | --- | --- | --- |
| `opencode` | `.opencode` | `~/.config/opencode` | — |
| `codex` | `.codex` | `~/.codex` | — |
| `claude-code` | `.claude` | `~/.claude` | — |
| `antigravity` | `.gemini` | `~/.gemini` | — |
| `qwen` | `.qwen` | `~/.qwen` | — |
| `gemini-cli` | `.gemini` | `~/.gemini` | — |

### Support flags

| Provider | description | skillMd | implicitInvocationPolicy | allowedTools | permissions | agentMode | subagents | disableModelInvocation | userInvocable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `opencode` | yes | yes | no | no | yes | yes | yes | no | no |
| `codex` | yes | yes | yes | no | no | no | no | no | no |
| `claude-code` | yes | yes | no | yes | no | no | no | yes | yes |
| `antigravity` | yes | yes | no | no | no | no | no | no | no |
| `qwen` | yes | yes | no | no | no | no | no | no | no |
| `gemini-cli` | yes | yes | no | no | no | no | no | no | no |

### Danger notes

#### opencode

- OpenCode permissions should use ask or deny for shell/edit/network risk.
- Some canonical skills may map better to agents than raw skill folders.

#### codex

- Implicit invocation depends on description quality.
- Duplicate skill names can create selection ambiguity.
- Dangerous projections should disable implicit invocation through provider policy.

#### claude-code

- allowed-tools grants permission and is not a deny baseline.
- Side-effectful skills should use disable-model-invocation.
- Project skills depend on workspace trust.

#### antigravity

- Antigravity currently shares the Gemini CLI user skill path in this baseline.
- Current local project install remains shared .agents/skills.
- Provider-specific permission semantics are not enforced by this baseline.

#### qwen

- Current local project install remains shared .agents/skills.
- Provider-specific permission semantics are not enforced by this baseline.

#### gemini-cli

- Current local project install remains shared .agents/skills.
- Provider-specific permission semantics are not enforced by this baseline.
<!-- END GENERATED PROVIDER MATRIX -->
