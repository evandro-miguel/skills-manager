# Skill Card Spec

Skill cards are deterministic summaries generated from a skillpack source. They
are intended for catalog browsing and agent routing context, not for installing
or mutating skills.

## Source

A card is built from:

- `skills/<skill>/SKILL.md` frontmatter;
- optional `skills/<skill>/skill.meta.json` risk metadata.

The generator must read only the requested `--source` skillpack root and write
only to the requested `--out-dir`.

## Shape

The JSON card shape is modeled by `schema/skill-card.schema.json` and includes:

- `name`
- `description`
- `useWhen`
- `category`
- `tags`
- `triggers`
- `targetProvider`
- `providerSupport`
- `risk`
- `examples`
- `sourcePath`

`useWhen` is optional source metadata. When `metadata.useWhen` is absent, the
card falls back to the skill description. `examples` is reserved for future
structured sourcing and is currently emitted as an empty array.

## Visibility

Catalog generation follows the PR08 discovery visibility contract:

- skills with truthy `metadata.internal` are excluded by default;
- skills with truthy `metadata.experimental` are excluded by default;
- `--include-internal` and `--include-experimental` reveal those skills;
- deprecated, archived, and compatibility-only skills remain excluded.

Audit and eval surfaces still scan every skill regardless of these flags.

## Determinism and privacy

Generated card content must not include timestamps, absolute host paths, network
results, credentials, HOME paths, or runtime state. `sourcePath` is always
relative to the skillpack source root, such as `skills/example/SKILL.md`.
