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

## Branch workflow

`main` is the only branch published in this repository. Open contribution pull
requests from a fork against `main`; keep temporary development branches local
or in the contributor's fork. The public remote has no `dev` or `main_dev`
branch. Merge reviewed changes only after successful CI, preserve shared history,
and keep personal skill roots outside this repository.

A public fork's own `main` push may fail the repository-visibility guard because
the publication exception is specific to this repository. Pull request checks
run in the upstream repository context; use `bun run validate` for local checks.

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
