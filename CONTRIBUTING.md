# Contributing

Skills Manager is an alpha project for portable AI-agent skills. The planned
GitHub destination is `evandro-miguel/skills-manager`; its hosted state is not
verified for this candidate. The package remains `private: true`, and any
repository visibility or npm publication change requires separate owner
approval. Keep changes small, reviewable, and backed by tests.

## Local setup

```bash
bun install --frozen-lockfile
bun run validate
```

## Branch workflow

`main` holds reviewed, validated alpha snapshots. `dev` integrates development
work; short-lived topic branches target `dev`. Promote `dev` to `main` through
a pull request after review and successful CI. Preserve shared history and
keep personal skill roots outside this repository.

## Change rules

- Do not add host-specific paths, browser session files, tokens, workbench logs,
  or personal operating routines.
- Do not add root `skills/` content; use `examples/` for synthetic fixtures and
  User Skill Roots (`SKILL_SYS_USER_ROOT` or `~/.skill-sys`) for user-local
  private skills.
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
