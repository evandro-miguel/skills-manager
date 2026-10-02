# Catalog Generation Spec

Catalog generation turns a skillpack source into deterministic Markdown and JSON
skill-card artifacts.

## Command

```bash
skill-sys catalog --source <skillpack-root> --out-dir <dir> [--format markdown|json|both] [--check]
```

The public command delegates to `scripts/commands/generate-skill-catalog.ts`.
The backend script may also be called directly.

## Safety contract

- `--source` is required.
- `--out-dir` is required for writes and checks.
- The generator writes only these files under `--out-dir`:
  - `skill-cards.json`
  - `skill-cards.md`
- The generator never writes root `SKILLS.md`, root `SKILLS.json`, root
  `skills/`, or root `skill-lifecycle.json` in the base repository.
- Output content is deterministic: no generated dates, timestamps, absolute host
  paths, network results, or local runtime state.
- `--check` compares the existing files in `--out-dir` with freshly rendered
  output and exits non-zero on drift.

## Formats

- `--format json`: writes/checks `skill-cards.json` only.
- `--format markdown`: writes/checks `skill-cards.md` only.
- `--format both`: writes/checks both files. This is the default.

## Source filtering

Catalog generation uses the skill discovery visibility rules from
[Skill Discovery Spec](skill-discovery.md): internal and experimental skills are
hidden by default, with explicit include flags. Compatibility/deprecated/archived
skills remain excluded.

## Release boundary

Generated catalog artifacts are allowed for a user-chosen skillpack source or a
fixture output directory. They must not become root catalog files in the
public-engine base repository. Package/public-surface gates must continue to
fail closed for root `SKILLS.*` or root `skills/`.
