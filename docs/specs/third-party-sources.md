# Third-Party Sources

## Overview

Third-party skill sources allow projects to declare external Git repositories as skill providers. This replaces ad-hoc manual copying with a versioned, reproducible dependency graph.

## File Pair

| File | Purpose | Versioned |
| --- | --- | --- |
| `skill-sys.sources.json` | Human intent — what to fetch and from where | Yes (committed to VCS) |
| `skill-sys.sources.lock.json` | Resolved state — exact commits and paths | Yes (committed to VCS) |

## Coexistence with Legacy Lock

`skill-sys.sources.lock.json` coexists with the legacy `.skills.lock.json`. They serve different purposes:

- **`.skills.lock.json`**: project-local install lockfile (installs, projections, policy).
- **`skill-sys.sources.lock.json`**: source resolution lock (remote git refs → pinned commits).

The tooling never silently mixes entries between the two files. Commands that read one file do not implicitly mutate the other.

## Manifest: `skill-sys.sources.json`

Human-authored declaration of sources.

```json
{
  "version": 1,
  "sources": [
    {
      "name": "example-skill",
      "source": "https://github.com/example/skills.git",
      "ref": "v1.0.0",
      "skillPath": "skills/example-skill"
    }
  ]
}
```

### Fields

- **version** (integer, required): Schema version. Must be `1`.
- **sources** (array, required, min 1): List of source entries.
  - **name** (string, required): Unique skill identifier within the manifest.
  - **source** (string, required): Git URL of the remote repository.
  - **ref** (string, required): Git ref — branch, tag, or commit SHA.
  - **skillPath** (string, optional): Directory within the repo containing the skill. Defaults to repo root.

### Constraints

- `additionalProperties: false` — unknown keys are rejected.
- Duplicate `name` values are blocked by default (see duplicate detection).
- Remote git refs must be explicit in the MVP (no "latest" shortcuts).

## Lock: `skill-sys.sources.lock.json`

Machine-generated resolved state. **Never hand-edited.** It is produced by
`skill-sys generate-lock` (alias `lock`), the dedicated first-resolver that
reads the manifest, resolves each declared ref to a pinned commit, materializes
the checkout, and writes the lock. Generation is a **separate command**;
`skill-sys add`/`update` do **not** write the source lock. Read-only commands
that need a lock (notably `skill-sys update-check`) fail closed when it is
absent — generate one with `skill-sys generate-lock` first.

```json
{
  "version": 1,
  "generatedAt": "2026-06-09T12:00:00.000Z",
  "sources": [
    {
      "name": "example-skill",
      "source": "https://github.com/example/skills.git",
      "ref": "v1.0.0",
      "resolvedCommit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "skillPath": "skills/example-skill",
      "manifestPath": "skills/example-skill/SKILL.md",
      "resolvedAt": "2026-06-09T12:00:00.000Z"
    }
  ]
}
```

### Additional Lock Fields

- **resolvedCommit** (string, required): 40-char hex SHA-1 that `ref` resolved to.
- **manifestPath** (string, required): Relative path to the `SKILL.md` file inside the repo.
- **resolvedAt** (string, required): ISO-8601 timestamp of resolution.
- **skillPath** (string, optional): Directory path — carried over from manifest if present.

### Key Distinctions

- `skillPath` is a **directory** containing the skill files.
- `manifestPath` points to the `SKILL.md` file within that directory.
- Both paths are relative to the source repository root.

## Duplicate Skill Detection

Duplicate `name` entries in the manifest are detected by `findDuplicateSkills()`. When duplicates are found, the tooling rejects the manifest unless explicitly overridden. This prevents accidental skill shadowing from multiple sources.

## JSON Schemas

- `schema/source-manifest.schema.json`
- `schema/source-lock.schema.json`

Both use `additionalProperties: false` and `$id` in the `https://skill-sys.dev/schema/` namespace.
