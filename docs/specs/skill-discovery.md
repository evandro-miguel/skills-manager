# Skill Discovery Spec

Status: partial. This spec records the **metadata visibility flag contract**
that has landed (PR08 safe slice) and the **remaining discovery gaps** that are
still roadmap-only.

## Metadata Visibility Flag Contract

Skills declare visibility gating inside the `metadata` block of `SKILL.md`:

```yaml
---
name: my-skill
description: Use when ...
metadata:
  internal: true
  experimental: true
---
```

### Truthy rule

A flag is considered set when its value is **truthy**:

- the boolean `true`
- the case-insensitive strings `true`, `1`, `yes`, `on`

Any other value (including `false`, `0`, `off`, an empty string, or absence of
the key) leaves the skill visible by default. This truthy set is shared with the
existing compatibility/deprecated/archived detection.

### Visibility behavior

| Surface | `metadata.internal` | `metadata.experimental` |
| --- | --- | --- |
| `list-skills.ts` / `skill-sys list` (default) | hidden | hidden |
| `--include-internal` | shown | hidden |
| `--include-experimental` | hidden | shown |
| both flags | shown | shown |
| `generate-skills-inventory.ts` (default) | excluded | excluded |
| `generate-skills-inventory.ts --include-*` | included | included |
| `semantic-audit.ts` | always scanned | always scanned |
| `eval.ts` (triggers/collisions) | always scanned | always scanned |

- When revealed, list JSON records carry `internal`/`experimental` booleans and
  the text renderer tags rows `[internal]`/`[experimental]`.
- Inventory output records the default exclusion in its `notes` array.
- Compatibility/deprecated/archived filtering is **independent** of these flags
  and keeps its existing behavior.

### Why audits are not filtered

`semantic-audit` and `eval` scan for supply-chain risks: prompt-injection-shaped
descriptions, scope capture, near-duplicate descriptions, and trigger fixture
correctness. Hiding `internal`/`experimental` skills from these scans would let
risks slip through. Discovery surfaces (list, inventory) hide flagged skills for
catalog cleanliness; audit/eval surfaces intentionally review **every** skill
regardless of flags. This is a deliberate, documented decision — not an
oversight.

## Implemented Scope (PR08 slice)

- `scripts/commands/list-skills.ts`: `--include-internal`,
  `--include-experimental`; `SkillRecord.internal`/`.experimental`; default
  hide filter; JSON/text transparency.
- `scripts/commands/generate-skills-inventory.ts`:
  `--include-internal`/`--include-experimental`; `isHiddenByMetadataFlags`
  helper; default exclusion with a console skip notice and an inventory note.
- `scripts/commands/skill-sys.ts`: forwards `--include-internal` and
  `--include-experimental` to `list-skills.ts` for `skill-sys list` and
  `skill-sys find`.
- Tests in `tests/semantic-evals.test.ts` cover the truthy rule, default
  hiding, flag reveal, `parseArgs` acceptance, and JSON transparency for both
  list and inventory. `tests/parser-provider-consistency.test.ts` covers the
  public dispatcher boundary.

## F-09 Local Discovery

`discover-skills.ts` is a local-only, deterministic discovery command. It
accepts one or more `--root <dir>` options and recursively discovers direct
and category-folder `SKILL.md` files. It does not fetch, install, or resolve
external sources. Roots, path components, manifests, and discovered files must
not be symlinks; duplicate skill names fail closed.

Plugin roots can be declared in a JSON manifest beside the plugin layout:

```json
{"schemaVersion":1,"roots":["skills"],"plugins":["plugins/acme/skills"]}
```

All entries are relative to the manifest directory and reject absolute,
parent-traversal, dot, and backslash paths. `roots` and `plugins` are merged,
then output is sorted by name and path.

```bash
bun scripts/commands/discover-skills.ts --root skills --root .agents/skills --json
bun scripts/commands/discover-skills.ts --plugin-manifest plugins.json --json
```

## Remaining Discovery Gap

1. **Provider doctor / budget doctor.** Budget estimation
   (`budget-doctor.ts`) currently counts all skills. Whether internal/
   experimental skills should count toward provider listing budgets is a
   follow-up decision, not part of this slice.
