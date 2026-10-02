# Command, CI, And Guardrails

This is the as-built spec for the current command surface, workflow gates, and
repository guardrails.

## Owned Surfaces

Public command entrypoints:

- [scripts/commands/skill-sys.ts](../../scripts/commands/skill-sys.ts)
- [scripts/commands/skillpool.ts](../../scripts/commands/skillpool.ts)
- [scripts/bin/skill-sys](../../scripts/bin/skill-sys)
- [scripts/bin/skillpool](../../scripts/bin/skillpool)

Internal command metadata surfaces:

- [scripts/modules/skill-sys/command-spec.ts](../../scripts/modules/skill-sys/command-spec.ts)
- [scripts/modules/skill-sys/command-registry.ts](../../scripts/modules/skill-sys/command-registry.ts)

CI and guards:

- [.github/workflows/universall-skill-sys-ci.yml](../../.github/workflows/universall-skill-sys-ci.yml)
- [scripts/commands/skill-change-guard.ts](../../scripts/commands/skill-change-guard.ts)
- [scripts/commands/guard-repo-visibility.ts](../../scripts/commands/guard-repo-visibility.ts)
- [scripts/commands/markdown-link-guard.ts](../../scripts/commands/markdown-link-guard.ts)
- [scripts/commands/coverage-gate.ts](../../scripts/commands/coverage-gate.ts)
- [scripts/ops/link-lint.sh](../../scripts/ops/link-lint.sh)

Reference docs:

- [docs/reference/skill-sys-commands.md](../reference/skill-sys-commands.md)
- [docs/map/scripts-system.md](../map/scripts-system.md)

## Public Command Surface

The complete public command list and options are maintained in the
[command reference](../reference/skill-sys-commands.md) and the command registry
linked above. `skill-sys help` reports the active commands; `skillpool` retains
the compatibility backend. This spec describes the shared gates rather than
maintaining a second command inventory.

Active install and doctor hardening flags:

- `skillpool install --debug-state`
- `skillpool doctor --state-safety`
- `skill-sys add ... --debug-state`
- `skill-sys doctor --state-safety`

`skill-sys remove` is active as a planner plus `--apply`. Destructive apply
creates rollback-compatible backups and requires `--confirm-all` for broad
removal. See [Uninstall and Rollback](./uninstall-rollback.md).

## Package Scripts

Important package scripts:

```bash
bun run skill-sys
bun run skillpool
bun run schema:check
bun run validate:local
bun run validate:ci
bun run validate:release
bun run validate:publish
bun run validate
bun run validate:skillpack
bun run create:skillpack
bun run scan:sensitive
bun run scan:privacy
bun run public:audit
bun run packlist
bun run npm-pack-audit
bun run guard:repo-visibility
bun run typecheck
bun run coverage:check
bun run ci:checks
```

`ci:checks` currently composes:

```bash
bun run validate:release
```

`validate` is an alias for `validate:ci`. `validate:ci` runs the local gate plus
`docs:check`, public audit, packlist, and npm pack audit. `validate:publish`
adds the release visibility guard, fixture-backed projection build/validation,
release smoke, fixture-only origin verification, registry-surface validation, and a final npm
pack audit. Provenance and attestation enforcement remain fail-closed/future
publication gates, not active local verifier support. The `verify-origin` package
script checks the synthetic fixture with `--no-require-ref-exists`; it does not
verify a hosted release tag or the engine repository origin.

## CI Workflows

Current workflow:

- `universall-skill-sys-ci.yml`

`universall-skill-sys-ci.yml` currently covers the staging validation gate:

- TypeScript typecheck
- schema contract check
- public/base test suite
- synthetic skillpack validation
- sensitive and privacy scans
- public artifact audit, packlist, and npm pack audit checks
- repository visibility guard

Source-tree workflows such as `skills-change-guard.yml`, `skills-inventory.yml`,
and `release-artifacts.yml` are not current base/public staging workflows. Do
not reintroduce publication workflows until explicit maintainer approval.

## Skill Change Guard

The skill-change guard runs when skill files change.

Current command:

```bash
bun scripts/commands/skill-change-guard.ts --staged --fix --restage
```

Current guard behavior:

- applies Markdown fixes where configured
- runs strict Markdown linting on changed files
- runs local Markdown link guard
- runs universal contract validation
- runs `skillpool validate`
- can restage fixed files

## Markdown And Link Guards

Current command:

```bash
bash scripts/ops/link-lint.sh
```

The `md:lint` package script runs strict Markdown linting. `lint:docs:full`
combines it with `docs:check`; external link checks remain optional.

The local link guard checks:

- local file existence
- ambiguous directory links
- raw wikilinks

`link-lint.sh` can use `lychee` when available.

## Coverage Gate

Coverage can be checked locally through:

```bash
bun run coverage:check
```

Current thresholds:

- 80 percent functions
- 80 percent lines

Implementation:

- [scripts/commands/coverage-gate.ts](../../scripts/commands/coverage-gate.ts)

Representative test: [coverage-gate.test.ts](../../tests/coverage-gate.test.ts).

`coverage:check` runs through `validate:ci`, which `ci:checks` includes.

## Parser And Path Guardrails

Current command hardening includes:

- unknown CLI options fail in touched TypeScript command parsers
- missing option values fail
- help paths do not silently accept unrelated flags
- adapter, profile, app, and skill names reject traversal-style values
- install targets must stay inside the selected project root
- source, bootstrap lockfile, and publish workdir paths are guarded against
  symlink escapes

Representative tests:

- [tests/package-governance.test.ts](../../tests/package-governance.test.ts)
- [tests/repo-visibility-guard.test.ts](../../tests/repo-visibility-guard.test.ts)
- [tests/skillpack-contract.test.ts](../../tests/skillpack-contract.test.ts)

## Sensitive Skill Payload Scan

Current sensitive scanning includes:

- public `skill-sys scan-sensitive --source <dir>`
- `skillpool validate` source scan for `skills/**` under skillpack/private-overlay
  source roots or synthetic fixtures
- pre-copy install checks in `skillpool install`
- pre-copy checks in `sync-skills`
- pre-publish checks in `publish-skill`
- pre-release checks in `release-prepare`
- relative finding paths and redacted secret values

Representative tests:

- [tests/sensitive-scan.test.ts](../../tests/sensitive-scan.test.ts)
- [tests/skillpack-contract.test.ts](../../tests/skillpack-contract.test.ts)
- [tests/install-hardening.test.ts](../../tests/install-hardening.test.ts)

## Semantic Skill Gates

Available deterministic semantic commands include:

- `skill-sys eval triggers --provider <id>` for
  `skills/*/evals/triggers.json` relative to skillpack/private-overlay source
  roots or synthetic fixtures
- `skill-sys eval collisions` for collision fixture references
- `skill-sys semantic-audit --source <dir>` for broad activation capture,
  prompt-injection-shaped descriptions, and near-duplicate descriptions
- `skill-sys doctor --budget --provider <id>` for provider initial-listing
  budget estimates
- these commands are not currently exposed as package scripts
- `ci:checks` includes docs-check and coverage through `validate:ci`; the
  separate `validate:publish` gate adds projection build and validation

Representative tests:

- semantic eval command regression coverage is planned; current package governance coverage lives in [tests/package-governance.test.ts](../../tests/package-governance.test.ts).

## Current Non-Features

These are not active CI or guard checks yet:

- budget doctor in CI
- `doctor --all-scopes --provider all`
- hosted branch-protection enforcement of CODEOWNERS
- semantic eval commands and provider projection build/validation in `ci:checks`
