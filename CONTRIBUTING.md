# Contributing

Skills Manager is an alpha project for portable AI-agent skills. Its source
repository is `evandro-miguel/skills-manager`. The package remains `private: true`, and any
repository visibility or npm publication change requires separate owner
approval. Keep changes small, reviewable, and backed by tests.

## Local setup

Use Bun 1.3.14 or later and the committed `bun.lock`. CI pins Bun 1.3.14;
Node.js and npm alone cannot execute the CLI.

```bash
bun install --frozen-lockfile
bun run validate
```

`validate` runs `validate:ci`, the local quality and packaging checks.
`ci:checks` also verifies complete Git history and repository visibility, so a
local PASS does not establish hosted release readiness. See the
[release readiness contract](docs/release-readiness.md) for those gates.

The normal test suite includes property-based fuzzing of source references,
embedded credentials, private network addresses, and Git refs using fast-check.
Each property runs 1,000 generated cases. To replay a failure, use its reported
seed and shrink path and select the failing test:

```bash
FUZZ_SEED=123 FUZZ_PATH='0:1' bun test tests/source-fuzz.test.ts -t 'failing test name'
```

Use the actual values from the failure report. Keep a minimized regression
example when fixing a discovered bug.

Markdown checks use `markdownlint-cli` with the unchanged `/config` rules from
`strict-no-wrap.markdownlint-cli2.jsonc`. The CLI2 runner was removed because its
`braces` dependency has no patched release for GHSA-vfj7-8cjw-p6xm. The `js-yaml`
override keeps the lint runner on patched version 5.4.1 for GHSA-r3ph-w7gj-g6xm;
remove that override when the runner's own dependency range includes the fix.

## Branch workflow

`main` is the only branch published in this repository. Open contribution pull
requests from a fork against `main`; keep temporary development branches local
or in the contributor's fork. The public remote has no `dev` or `main_dev`
branch. Merge reviewed changes only after successful CI, preserve shared history,
and keep personal skill roots outside this repository.

A public fork's own `main` push may fail the repository-visibility guard because
the publication exception is specific to this repository. Pull request checks
run in the upstream repository context; use `bun run validate` for local checks.

Maintainer updates can use immutable `ci-*` tags to run `quality-gates` before
advancing protected `main`, without publishing a development branch. These tags
are validation candidates, not releases. After committing and validating locally:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
candidate="ci-$(git rev-parse HEAD)"
git tag "$candidate" HEAD
git push origin "refs/tags/$candidate"
gh run list --workflow universall-skill-sys-ci.yml --commit "$(git rev-parse HEAD)"
```

Wait for the candidate's `quality-gates` run to succeed. Confirm its `headSha`
matches `git rev-parse HEAD` with `gh run view RUN_ID --json headSha,conclusion`.
Then push that same commit using `git push origin HEAD:refs/heads/main`.
If `main` advanced meanwhile, integrate it locally and validate a new candidate;
never force-push or move an existing tag. Branch protection requires the GitHub
Actions check even for administrators, but does not require a second human
approver. Contributor pull requests still use forks.

Automatic dependency-update PRs are disabled to preserve the main-only branch
policy. Maintainers must review dependency updates manually; `bun audit` runs in
the quality gates but does not update dependencies.

## Change rules

- Do not add host-specific paths, browser session files, tokens, workbench logs,
  or personal operating routines.
- The only shipped root skill is `skills/skill-sys/**`. Use `examples/` for
  synthetic fixtures and User Skill Roots (`SKILL_SYS_USER_ROOT` or
  `~/.skill-sys`) for user-local private skills.
- Do not require or recommend a project-owned private mirror repository just to
  store personal skills; users may keep their User Skill Root unversioned or
  version it in any repository they choose. Treat `universall-skill-sys-pvt` as
  migration-only legacy state.
- Keep planned commands documented as planned, not as available.
- Update schemas and tests together when changing public contracts.
- Compare artifact surfaces by path, not only by count.

## Pull request checklist

- [ ] `bun run validate` passes.
- [ ] Public artifact surface remains explicit.
- [ ] No sensitive files or secret-shaped values are added.
- [ ] Docs accurately distinguish implemented behavior from roadmap items.
