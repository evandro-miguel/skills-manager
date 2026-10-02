# Skill Lifecycle Changelog

Use `skill-lifecycle.json` to record what happened when a skill leaves the
active catalog. This is separate from release `CHANGELOG.md`: it exists so
agents can resolve missing legacy skill names.

## Required Entry

Each entry records:

- `skill`: missing or legacy skill name.
- `event`: `archived`, `removed`, `merged`, `renamed`, or `deprecated`.
- `date`: event date as `YYYY-MM-DD`.
- `replacements`: the next skill name(s) in the replacement graph. They may be
  inactive when they have their own lifecycle entry; resolution follows the
  graph to one active skill or a terminal `removed`/`archived` entry.
- `reason`: why the old skill left the active catalog.
- `agent_action`: concrete fallback instruction for agents.
- `references`: optional repo-relative docs that explain the decision.

## Commands

```bash
bun scripts/commands/skill-lifecycle.ts audit --skills-root skills  # from a skillpack or User Skill Root source root
bun scripts/commands/skill-lifecycle.ts lookup browser-automation
bun scripts/commands/skill-lifecycle.ts resolve browser-automation --json
bun scripts/commands/skill-lifecycle.ts record \
  --skill old-skill \
  --event merged \
  --replacement new-skill \
  --reason "Merged into the canonical new-skill surface." \
  --agent-action "Use new-skill for this workflow." \
  --reference CHANGELOG.md \
  --write
```

Run `bun run validate` after lifecycle changes. `skillpool install` and
`sync-skills` also copy the lifecycle ledger to target skill directories as
`.skill-lifecycle.json`, so missing-skill guidance can travel with installed
skills. `resolve` emits `schema_version: "skill-lifecycle-resolution/v1"`
with the requested skill, terminal event/skill, and traversed path. Audit and
resolution fail closed for missing or ambiguous nodes, self-replacements, and
cycles; existing `lookup --json` remains the raw entry-array format.
