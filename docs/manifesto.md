# Universall Skill-Sys Manifesto

> **Status: baseline document.** Last substantive review: 2026-06-08. Principles here remain
> the guiding vision; for current scope, delivery state, and roadmap see
> [docs/roadmap.md](roadmap.md) and [docs/release-readiness.md](release-readiness.md).

Universall Skill-Sys exists to make agent skills portable, auditable, and safe to
install across agent runtimes without mixing public engine code with private
operator knowledge.

## North Star

The base/public-engine repository (`universall-skill-sys`) is the engine, not
the personal catalog. "Public engine" describes the sanitized architecture, not
current GitHub visibility; the GitHub repository remains PRIVATE until the repository owner
explicitly approves publication.

A healthy Skill-Sys release lets a user answer four questions before installing
anything:

1. What files are in the artifact?
2. Which skills or profiles will be installed?
3. Which provider-specific projection will be used?
4. Which privacy, sensitive-data, and provenance gates passed?

## Repository And User-Root Boundary

The base boundary is the public engine plus user-owned skill roots:

- `universall-skill-sys` — base/public-engine repository, GitHub-private during
  staging.
- User Skill Roots — user-owned roots resolved from `--user-root <dir>`, then
  `SKILL_SYS_USER_ROOT`, then `~/.skill-sys`; expected layout is
  `<userRoot>/skills/<skill>/SKILL.md`.

No project-owned private mirror repository is required just to keep personal
skills. Keep those skills in a User Skill Root by default. If the user wants
versioning, the user chooses the repository, remote, visibility, and hosting
provider for that root; the engine only consumes the checked-out filesystem path.
`universall-skill-sys-pvt` is deprecated as a required private overlay and is
migration-only legacy state.

## Public Engine Principles

The base/public-engine repository may contain:

- CLI commands and launchers;
- schemas and validators;
- artifact-surface definitions;
- privacy and sensitive-data scanners;
- provider matrices and projection tooling;
- synthetic examples;
- public roadmap, manifesto, specs, security policy, and contribution docs.

The base/public-engine repository must not contain:

- real personal skills;
- host-specific paths or operational routines;
- auth state, browser state, secrets, tokens, or local logs;
- private profiles or private global-core manifests;
- root `skills/`, `SKILLS.json`, or `SKILLS.md` generated from a private catalog.

## User-Local Private Skill Principles

Private skills are user-owned by default. A User Skill Root may contain private
skills without adding them to the base repository or to a project-owned private
mirror repo. The root may be a plain directory or any Git checkout the user
chooses, but it must still keep credential hygiene strict.

User-root workflows should:

- resolve user skills only through explicit opt-in commands such as
  `build-projections --include-user` and `validate-projections --include-user`;
- keep user roots out of defaults, public audit, packlist, release checksums,
  release manifests, Skill BOMs, channel metadata, publication gates, and npm
  package artifacts;
- record user-origin projections as `origin: "user"` with canonical paths like
  `user:skills/<skill>`;
- fail closed on duplicate names across public/source and user roots instead of
  merging or shadowing;
- keep private skills, private profiles, and private global-core manifests out of
  the base/public-engine repository;
- do not couple user skill versioning to this engine repo; if a user versions a
  root in Git, treat that remote as user policy, not engine architecture.

## Release Discipline

A public release or GitHub-public visibility change is not ready until the repository owner
explicitly approves publication and these checks pass from a clean checkout:

```bash
bun run validate
bun run public:audit
bun run packlist
```

The package surface must be defined by `package.json#files` and the declared
artifact surface. If those surfaces disagree, the release is blocked.

`docs/release-readiness.md` is the staging contract for what must be true before
any public visibility change or npm publication. Until that contract is met,
this repository is private staging for the public engine, not a public release.

## Documentation Discipline

Every repository must keep the operating intent visible through:

- `README.md` for quick orientation;
- `docs/manifesto.md` for principles;
- `docs/release-readiness.md` for staging/publication readiness;
- `docs/roadmap.md` for sequencing;
- `docs/specs/` for durable contracts;
- `SECURITY.md` for reporting and gate expectations;
- `CONTRIBUTING.md` for change rules.
