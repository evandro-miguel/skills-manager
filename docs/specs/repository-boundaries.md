# Repository Boundaries Spec

This spec defines the boundary between the base/public-engine Universall
Skill-Sys repository and user-owned User Skill Roots.

"Public engine" is an architectural role. The `universall-skill-sys` GitHub
repository must remain PRIVATE during staging and must not become GitHub-public
until the repository owner explicitly approves publication.

## Engine And User-Owned Root Invariant

The default architecture is one base engine plus user-owned roots:

- `universall-skill-sys` — base/public-engine repository, GitHub-private during
  staging.
- User Skill Roots — user-owned roots resolved from `--user-root <dir>`, then
  `SKILL_SYS_USER_ROOT`, then `~/.skill-sys`; expected layout is
  `<userRoot>/skills/<skill>/SKILL.md`.

Do not require or recommend a project-owned private mirror repository just to
keep personal skills. Keep user-local private skills in a User Skill Root. If the
user wants version control, the user chooses the repository, remote, visibility,
and branch policy; the engine only consumes the checked-out filesystem path.
`universall-skill-sys-pvt` is deprecated migration-only state, not the default or
required private skill home.

## Repositories

## Package Boundary Status

The current package is one current monorepo public-engine package rooted at this
repository. It is not yet split into workspaces. The package boundary is enforced
by `package.json#files`, `package.json#bin`, absent `package.json#exports` until
intentional public APIs exist, and the `artifact-surfaces/engine-public.json`
surface.

Future packages may separate engine APIs, provider projection tooling, registry
metadata, or skillpack authoring helpers, but those future packages are not
present today and must not be documented as already split. Any future package
must define its own public files, binaries, exports, artifact surface, and
boundary tests before publication.

### `universall-skill-sys`

Role: base/public-engine repository. GitHub visibility remains PRIVATE until
the repository owner explicitly approves publication.

Allowed surfaces:

- CLI commands and launchers under `scripts/`;
- schemas under `schema/`;
- provider metadata under `providers/`;
- adapters under `adapters/`;
- public artifact-surface policy under `artifact-surfaces/`;
- synthetic fixtures under `examples/`;
- public documentation under `docs/`.

Forbidden surfaces:

- root `skills/`;
- generated private catalog inventory such as `SKILLS.json` or `SKILLS.md`;
- private global-core manifests;
- private profiles;
- runtime state, workbench logs, browser auth state, tokens, or secrets.

### User Skill Roots

Role: local/private source roots for personal skills outside this repository and
outside public artifact surfaces.

Allowed user-root surfaces:

- private `skills/<skill>/SKILL.md` payloads;
- private support files under each skill directory;
- local-only metadata needed by explicit opt-in commands.

Projection commands include these roots only with `--include-user`; validators
must be passed `--include-user` and the same `--user-root <dir>` to accept
user-origin projection directories.

#### User root placement and versioning

A User Skill Root may be:

- an unversioned local directory such as `~/.skill-sys`;
- a standalone private Git checkout chosen by the user;
- a private Git checkout, Git submodule, or Git worktree placed inside a project
  directory, as long as the public engine and project artifact surfaces exclude
  it;
- a project-local `.skill-sys/` directory when the project deliberately owns a
  private skill root for that project.

The engine consumes the checked-out filesystem path; it does not prescribe the
remote, branch policy, hosting provider, or repository visibility. Project-local
private roots must be listed in that project's ignore/public-surface policy
before they are used for private skills.

Symlink note: projection input currently fails closed on symlinked source
entries. If a user wants a convenient project-local pointer to a private skill
repository, prefer configuring that path as a named root in tool config, or use a
real Git checkout/submodule/worktree directory. A symlink may exist as local
operator convenience only if the consuming command resolves it to an explicit
root before projection and still applies the normal anti-symlink checks to the
skill payload.

#### Tool config for named roots and visibility policy

Tool config may define named skill roots globally and per project. The config is
user-owned state, not public engine content. It should let the user attach:

- a stable local alias/name for the root;
- the root path;
- default visibility: `private`, `public`, or `mixed`;
- optional tags used for selection and reporting;
- optional default provider or provider projection set;
- optional Git metadata such as expected remote/ref when the user wants local
  verification.

Global config applies across projects. Project config may add project-local roots
or override display names and tags, but it must not silently downgrade a root
from `private` to `public`. Any command that includes non-public roots must be
explicitly opt-in and must label generated projections with `origin: "user"`.

### Deprecated legacy overlay: `universall-skill-sys-pvt`

Role: deprecated migration-only state from the earlier two-repo design. Do not
use it as the recommended private skill home for new workflows.

Private skills should move to User Skill Roots. If a user wants those roots
versioned, the user chooses any repository and remote policy; that repository is
not a first-party companion repo for this engine and must not enter the engine's
package, release, or public audit surfaces.

Still forbidden in any private/user-owned skill source:

- real credentials;
- `.env` files with values;
- SSH keys, API keys, cookies, browser sessions, and auth state;
- generated cache directories or runtime logs that do not belong in Git.

## Synchronization Contract

Base/public-engine work does not sync private user roots. The engine publishes
commands and contracts; users decide whether and how to version their roots.

Allowed flow:

1. land generic engine changes in `universall-skill-sys`;
2. validate `universall-skill-sys`;
3. users update their own User Skill Roots if they want to consume new contracts;
4. user-root content never flows back into the public/base engine unless the user
   intentionally extracts a sanitized public/community skillpack.

Private skill work stays private:

1. change private skills in a User Skill Root;
2. run private validation and sensitive scans;
3. if the root is Git-versioned, push only to the user-chosen remote;
4. do not open public PRs with private skill content.

## Guardrail Requirements

The base/public-engine repository must fail closed when private surfaces enter
the public artifact. At minimum, public gates must cover:

```bash
bun run scan:privacy
bun run public:audit
bun run packlist
```

The public artifact surface must list private-only paths in
`forbiddenInArtifactPaths` or `forbiddenInSourcePaths` depending on whether the
path is forbidden in the shipped artifact or forbidden in the source tree.

The engine working tree may contain ignored AFOL state, agent manifests, local
skills, and harness files. They remain local and must not be tracked in the
public Git repository or enter an npm artifact. This includes `.afol/**`,
`AGENTS.md`, local agent instructions, workbench evidence, lessons, and
provider-specific development tooling. Historical implementation plans,
staging plans, and private-overlay maps stay local as development provenance.

The sole public agentic exception is `skills/skill-sys/**`. It contains the
portable agent-facing instructions required to operate the shipped CLI. The
tracked-repository audit fails closed for every `.agents` descendant, every
other root skill, and known local agentic roots. Adding another public skill
requires an explicit artifact-surface change and the full release validation
flow.

The same boundary applies to every path reachable from Git history. Deleting a
file only from the current tree does not make an existing repository safe to
open. `audit:public-repository` reports history leaks as class counts with a
small sample and a remediation line. Publish GitHub from a sanitized new
repository, or perform a separately authorized history rewrite that is not
executed in this checkout, then re-run the audit against the final refs.

User roots and any user-chosen repositories must run sensitive-data checks even
though privacy markers are expected to exist there.

## Naming Rules

Use these names consistently:

- `universall-skill-sys` for the base/public engine;
- User Skill Root for user-owned private skills (`SKILL_SYS_USER_ROOT` or
  `~/.skill-sys` by default);
- user-chosen repository for any optional Git versioning of a User Skill Root;
- `universall-skill-sys-pvt` only when referring to deprecated migration-only
  state.

Do not introduce a private mirror repository requirement for user-local private
skills; the default private home is the User Skill Root, optionally versioned
wherever the user chooses.
