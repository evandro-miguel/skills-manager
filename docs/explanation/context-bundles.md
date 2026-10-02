# Context Bundles

`skill-sys context` gives agents a smaller prompt surface without losing the
routing information that makes a skill usable.

The command deliberately starts from the dispatcher file, then expands only when
needed:

- `quick`: one file, best for deciding whether a skill applies
- `standard`: dispatcher plus gotchas and reference indexes, best for most
  agent work
- `deep`: every Markdown file, best when implementing inside the skill itself

This mirrors the repository skill architecture: `SKILL.md` should route, while
long implementation details live under `references/`. Keeping the default tier
at `standard` preserves enough context for normal work while avoiding a full
skill dump.

## Examples

```bash
skill-sys context writing-skills --tier quick
skill-sys context writing-skills --tier standard --format json
skill-sys context writing-skills --tier deep > /tmp/writing-skills-context.md
```

The output includes an `approx_tokens` estimate. It is not a tokenizer-specific
count; it is a conservative planning number for choosing between tiers.
