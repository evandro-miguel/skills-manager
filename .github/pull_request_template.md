## Summary

- What changed:
- Why:
- Risk level: `low` / `medium` / `high`

## Universal Skills Checklist

- [ ] `bun run validate:local` passes for local typecheck, schema, tests, skillpack, and scan gates.
- [ ] `bun run validate:ci` passes before review for public audit, packlist, and npm pack audit coverage.
- [ ] `bun run validate:release` passes for release-affecting changes and CI-equivalent repo visibility coverage.
- [ ] If skillpack fixture files changed, `bun run validate:skillpack` and relevant sync/drift checks were run.
- [ ] App impact reviewed:
- [ ] `opencode`
- [ ] `codex`
- [ ] `claude-code`
- [ ] `antigravity`

## Release/Versioning

- [ ] `CHANGELOG.md` updated when behavior/contract changed.
- [ ] Version/tag plan defined (if release-affecting change).

## Notes for Maintainers

- Branch protection for `universall-skill-sys` should require passing `universall-skill-sys-ci` before merge into `main`.
