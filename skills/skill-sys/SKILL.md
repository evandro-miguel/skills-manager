---
name: skill-sys
description: Use when an agent needs to discover, inspect, install, validate, update, or troubleshoot portable skills with the Skill-Sys CLI.
metadata:
  category: agentic
  tags: "skill-sys, skillpool, agent-skills, portable-skills, cli"
  triggers: "skill-sys, skillpool, find skill, install skill, update skill, validate skillpack, inspect skill context, agent skills"
  references: "commands, privacy, installation, diagnostics"
  version: "1.0.0"
  updated_at: "2026-08-13T00:00:00Z"
  target_provider: universal
  tier: 1
---

# Skill-Sys

Use `skill-sys` as the public front door. Discover the live command surface
before constructing a workflow:

```bash
skill-sys --help
skill-sys doctor --help
```

## Agent Workflow

1. Locate or inspect skills with `skill-sys find`, `list`, or `context`.
2. Preview mutations with `--dry-run` or the command's plan mode.
3. Keep project installs under the target repository's `.agents/skills`.
4. Use JSON output when another tool must consume exact fields.
5. Run the relevant doctor or validation command after mutation.

Consult `docs/reference/skill-sys-commands.md` for the current command and
recovery contracts. Do not guess flags from older `skillpool` examples.

## Safety Boundary

- Never copy secrets, credentials, user-private skill roots, AFOL state, agent
  harness files, or host-specific configuration into a public skillpack.
- Treat `skills/` in a selected source as catalog content, not as permission to
  publish a user's private catalog.
- Keep source locks, checksums, and origin verification intact.
- Stop before publication, global installation, or destructive cleanup unless
  the user explicitly requested that action.
