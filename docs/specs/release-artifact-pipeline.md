# Release Artifact Pipeline

This is the as-built spec for the checksum, release artifact, channel, and
verification pipeline. The current public-alpha checkout has no checked-in
`releases/` tree, release artifacts, channel files, or release tags; the
release paths below are future or legacy outputs rather than current
public-alpha state.

Repository boundary: `universall-skill-sys` is the base/public-engine repo. Its
current public artifact surface is declared under `artifact-surfaces/` and does
not include real root `skills/`, `globals/core.json`, `SKILLS.json`, or
`SKILLS.md`. Those names are legacy/user-root release surfaces for
skillpack or user-root sources unless explicitly marked as a public fixture.

## Owned Surfaces

Primary commands:

- [scripts/commands/release-prepare.ts](../../scripts/commands/release-prepare.ts)
- [scripts/commands/release-verify.ts](../../scripts/commands/release-verify.ts)
- [scripts/commands/source-checksum.ts](../../scripts/commands/source-checksum.ts)

Primary modules:

- [scripts/modules/skillpool/artifact-surface.ts](../../scripts/modules/skillpool/artifact-surface.ts)
- [scripts/modules/skillpool/source.ts](../../scripts/modules/skillpool/source.ts)
- [scripts/modules/skillpool/release-artifacts.ts](../../scripts/modules/skillpool/release-artifacts.ts)
- [scripts/modules/skillpool/verify-artifacts.ts](../../scripts/modules/skillpool/verify-artifacts.ts)

Release data for legacy/user-root release flows or future public releases:

- `releases/checksums/`
- `releases/manifests/`
- `releases/boms/`
- `releases/channels/`

Schemas:

- [schema/artifact-surface.schema.json](../../schema/artifact-surface.schema.json)
- [schema/release-manifest.schema.json](../../schema/release-manifest.schema.json)
- [schema/skill-bom.schema.json](../../schema/skill-bom.schema.json)
- [schema/release-channel.schema.json](../../schema/release-channel.schema.json)

Current base staging workflow:

- [`.github/workflows/universall-skill-sys-ci.yml`](../../.github/workflows/universall-skill-sys-ci.yml)

The historical `release-artifacts.yml` signing workflow is not a current
base/public staging workflow and must not be reintroduced until the repository
owner explicitly approves publication.

## Source Checksum

`source-checksum` computes a deterministic source digest for a resolved
skillpool/skillpack layout.

For the current base/public-engine repo, the public artifact surface is not the
legacy root catalog surface. It is declared in:

- [`artifact-surfaces/engine-public.json`](../../artifact-surfaces/engine-public.json)
- [`artifact-surfaces/skillpack-public.json`](../../artifact-surfaces/skillpack-public.json)

The public-engine gates that consume those surfaces are:

```bash
bun run public:audit
bun run packlist
```

`source-checksum` remains the compatibility release checksum path for a
skillpack/private-overlay checkout that actually resolves a root `skills/`,
`adapters/`, and `profiles/` layout. In the base repo, which intentionally lacks
root `skills/`, it is not the current public artifact gate.

Current command for that compatibility path:

```bash
bun scripts/commands/source-checksum.ts --source .
```

Legacy/private-overlay source-checksum surfaces are named `artifact-surface.json`
when checked in, or fall back to the historical compatibility default. That
legacy/default surface includes:

- `skills` (real catalog content belongs in a User Skill Root, optionally versioned in a
  user-chosen repo, or another skillpack source, not in the base repo)
- `adapters`
- `profiles`
- `schema`
- `scripts/commands`
- `scripts/modules`
- `scripts/lib`
- `scripts/bin`
- `scripts/ops`
- `artifact-surface.json` (legacy/user-root registry name)
- `index.json`
- `package.json`
- `skill-lifecycle.json`
- `globals/core.json` (private-overlay/global-core compatibility)
- `SKILLS.json` (generated private-overlay inventory)
- `SKILLS.md` (generated private-overlay inventory)
- `bun.lock`

Current layout support:

- flat repository layout
- monorepo-root layout
- nested app layout

`denyUntrackedCriticalSurfaces` is enforced for known critical surfaces. In the
current base repo, `providers/` and `overlays/` are already public-engine
surfaces declared in `artifact-surfaces/engine-public.json`. In a
legacy/user-root source-checksum checkout, any critical directory that
exists but is omitted from the active legacy registry still fails closed.

## Sensitive Payload Gate

`release-prepare` runs the sensitive skill payload scan before package,
changelog, checksum, manifest, BOM, channel, commit, tag, or push writes. A
blocking finding stops release preparation before metadata is changed.

The scan currently covers selected skillpack/overlay payloads under `skills/**`
relative to the source being validated, reports source-relative paths, and does
not print matching secret values. In the base repo, the public synthetic fixture
is under `examples/minimal-skillpack/skills/`; root `skills/**` is not a current
first-party catalog surface.

## Release Manifest

`release-prepare` writes:

```text
releases/manifests/vX.Y.Z.json
```

The manifest contains:

- `$schema`
- `version`
- `release`
- `releaseDate`
- source layout metadata
- `sourceChecksum`
- directory digests
- file digests
- `contentSha256`

For the base/public-engine repo, the current public artifact directory surface is
loaded from `artifact-surfaces/engine-public.json` and includes:

- `adapters`
- `docs/explanation`
- `docs/map`
- `docs/reference`
- `docs/specs`
- `examples`
- `overlays`
- `profiles`
- `providers`
- `schema`
- `scripts/bin`
- `scripts/commands`
- `scripts/lib`
- `scripts/modules`
- `scripts/ops`

The current base/public-engine file surface from the same public artifact
surface includes:

- `.github/CODEOWNERS`
- `CONTRIBUTING.md`
- `README.md`
- `SECURITY.md`
- `artifact-surfaces/engine-public.json`
- `artifact-surfaces/skillpack-public.json`
- `bun.lock`
- `docs/compatibility-matrix.md`
- `docs/manifesto.md`
- `docs/on-demand-loading.md`
- `docs/roadmap.md`
- `docs/skill-lifecycle.md`
- `docs/windows-onboarding.md`
- `index.json`
- `package.json`
- `privacy-allowlist.public.json`
- `scripts/README.md`

Legacy/user-root release manifest generation may still use the
source-checksum compatibility surface. In that context only, the legacy surface
can include root `skills`, `globals/core.json`, `skill-lifecycle.json`,
`SKILLS.json`, and `SKILLS.md` from a user-chosen User Skill Root or another skillpack source. Those are not
current base/public-engine artifact contents.

## Skill BOM

`release-prepare` writes:

```text
releases/boms/vX.Y.Z.skill-bom.json
```

For skillpack or User Skill Root releases, the BOM contains:

- `$schema`
- `version`
- `release`
- `releaseDate`
- `sourceChecksum`
- `skillCount`
- per-skill path
- per-skill directory digest
- per-skill file count
- per-file digest
- `contentSha256`

Legacy/private-overlay BOMs existed for:

- `v0.3.0`
- `v0.3.1`

There is historical checksum evidence for `v0.2.0`, but no manifest/BOM for
`v0.2.0`. These historical release artifacts describe the original/private
catalog line, not a current root skill catalog in the base/public-engine repo.

## Release Channels

Release channel metadata lives under:

```text
releases/channels/<channel>.json
```

No channel file is checked in for the current public alpha. The historical
`stable`/`v0.3.1` pairing belongs to the legacy/private-overlay release line
and is future policy text here, not a current channel.

Channel metadata records:

- channel name
- release tag
- full commit SHA
- source SHA-256
- release manifest SHA-256
- Skill BOM SHA-256
- policy for consumers

Stable policy requires:

- no floating refs
- signed tag
- source checksum
- release manifest
- Skill BOM

Current limitation:

- `release-verify --channel` validates policy, hashes, and tag signature when a
  future or legacy channel file is supplied, but does not compare the channel
  `commit` field against the current `HEAD`

## Release Prepare

Current command:

```bash
bun scripts/commands/release-prepare.ts --version vX.Y.Z
```

Current behavior:

- normalizes `X.Y.Z` and `vX.Y.Z`
- blocks dirty repositories unless `--allow-dirty` is passed
- can update `package.json`
- can update `index.json`
- can update `CHANGELOG.md`
- can write `releases/checksums/vX.Y.Z.sha256`
- writes release manifest and Skill BOM
- can write a channel file from an already prepared release checkout
- can commit, tag, sign tag, and push when explicitly requested

Current option implications:

- `--push` implies `--commit` and `--tag`
- `--sign-tag` implies `--tag`
- `--channel` must not be combined with `--commit`, `--tag`, or `--push`
- `--no-checksum` skips only the `.sha256` file, not manifest/BOM generation

## Release Verify

Current command:

```bash
bun scripts/commands/release-verify.ts --source . --version vX.Y.Z
```

Current behavior:

- validates the release manifest exists
- validates the Skill BOM exists
- recomputes current source checksum
- rebuilds expected manifest/BOM content hashes
- compares manifest/BOM `contentSha256`
- compares manifest/BOM source checksum to the current source checksum
- verifies expected file hashes when policy provides them

## Origin Verification

Current command:

```bash
bun scripts/commands/skill-sys.ts verify-origin --source . --version vX.Y.Z
```

Current baseline checks:

- local Git ref resolves to a commit
- remote ref exists when `--repo <repo>` is provided and ref existence is
  required
- signed tag verification when `--require-signed-tag` is set
- source commit equality when `--source-commit` is provided or required
- source checksum equality when `--expected-source-sha256` is provided or
  required
- release manifest and Skill BOM hashes/content when release artifact policy is
  required

The command prints separate local integrity, origin, and provenance statuses.
Required Cosign bundle or GitHub attestation policy currently fails closed with
`UNSUPPORTED_PROVENANCE_POLICY`; this baseline does not assert workflow/OIDC
provenance.

Channel verification:

```bash
bun scripts/commands/release-verify.ts \
  --source . \
  --version vX.Y.Z \
  --channel stable
```

With `--channel`, current verification also checks:

- channel release tag
- channel policy
- source SHA-256
- release manifest SHA-256
- Skill BOM SHA-256
- signed tag when policy requires it

## Release Workflow

The current base/public staging workflow is:

```text
.github/workflows/universall-skill-sys-ci.yml
```

Current base workflow behavior:

- runs the staging validation gate for this GitHub-private base repo
- runs TypeScript typecheck
- runs schema contract checks
- runs the public/base test suite
- validates the synthetic skillpack fixture
- runs sensitive and privacy scans
- runs public artifact audit, packlist, and npm pack audit checks against
  `artifact-surfaces/engine-public.json`
- runs the repository visibility guard

Current package publication safety is fail-closed: `private: true` remains set,
license is `MIT`, and `prepublishOnly` runs `bun run validate:publish`.
`validate:publish` extends `validate:release` with fixture-backed projection
build and validation, release smoke, origin verification, registry-surface
validation, and a final npm pack audit. npm provenance, Sigstore/Cosign, and
GitHub attestation publication remain future gates, not active base/public
staging workflow behavior.

The historical tag-triggered `release-artifacts.yml` signing workflow remains a
legacy/user-root or future-publication reference only. It must not be
presented as current base/public staging behavior until the repository owner explicitly
approves publication and the release provenance surface is reintroduced.

## Tests

Representative tests:

- [tests/public-surface.test.ts](../../tests/public-surface.test.ts)
- [tests/package-governance.test.ts](../../tests/package-governance.test.ts)
- source checksum coverage is exercised through the release smoke gate in [tests/package-governance.test.ts](../../tests/package-governance.test.ts).
- [tests/install-hardening.test.ts](../../tests/install-hardening.test.ts)
- [tests/schema-contract.test.ts](../../tests/schema-contract.test.ts)

Coverage includes:

- release option parsing and implications
- changelog handling
- manifest and BOM generation
- release channel policy
- signed tag rejection when required
- symlink and hardlink refusal for channel writes
- source checksum layout handling
- artifact-surface lockstep across checksum, manifest, and BOM source checksum
- fail-closed detection for critical provider/projection surfaces
- runtime/cache directory exclusion where currently configured

## Current Non-Features

These are not implemented yet:

- required Cosign bundle verification in installer policy
- required GitHub attestation verification in installer policy
- projection digests in release manifest
- overlay digests in release manifest
- renderer version in release manifest
- commit-field enforcement against current `HEAD` in channel verification
