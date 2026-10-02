# Source Lockfile

## Overview

The source lockfile (`skill-sys.sources.lock.json`) captures the resolved state of all declared third-party skill sources. It is the machine-generated companion to the human-authored manifest (`skill-sys.sources.json`).

## Purpose

- **Reproducibility**: Anyone checking out the repo at the same commit gets identical skill content.
- **Audit trail**: Every skill's provenance (source URL, requested ref, resolved commit) is recorded.
- **Offline verification**: The lock can be validated without network access using the core modules.

## Generation

The lock file is **machine-generated** and is never hand-edited. It is produced
by a dedicated first-resolver command:

```bash
skill-sys generate-lock
# alias: skill-sys lock
```

`skill-sys generate-lock` reads `skill-sys.sources.json`, resolves each declared
ref to a pinned 40-char commit via `git ls-remote`, materializes the checkout to
locate each `SKILL.md`, and writes the lock with deterministic key ordering. It
is a **separate command** from `skill-sys add`/`update`; those commands do
**not** generate the source lock. Use `--dry-run` to resolve and validate
without writing, and `--json` to emit the generated lock as JSON.

The core module `source-lock.ts` provides the primitives the generator builds on:

1. Validation of structure and types.
2. Deterministic JSON serialization (sorted keys).
3. Atomic-ish file write via the existing `writeJson` helper.

Commands that require a lock (notably `skill-sys update-check`) fail closed when
it is absent; generate one with `skill-sys generate-lock` first.

## Relationship to Manifest

| Aspect | Manifest (`sources.json`) | Lock (`sources.lock.json`) |
| --- | --- | --- |
| Author | Human | Machine |
| Content | Intent (what + where) | State (what + where + resolved to) |
| Mutability | User edits | Tool writes |
| Key extra fields | — | `resolvedCommit`, `manifestPath`, `resolvedAt` |

## Relationship to Legacy Lockfile

The legacy `.skills.lock.json` records install state (which skills are installed, in what mode, with what projections). The source lock records resolution state (which commits were fetched). They are orthogonal:

- A project can have a source lock without a legacy lock (sources declared but not yet installed).
- A project can have a legacy lock without a source lock (locally-created skills, no remote sources).
- No command silently merges or migrates between them.

## Schema

Defined in `schema/source-lock.schema.json`. Key constraints:

- `version` must be `1`.
- `generatedAt` is a required ISO-8601 timestamp.
- Each source entry requires: `name`, `source`, `ref`, `resolvedCommit` (40-char hex), `manifestPath`, `resolvedAt`.
- `skillPath` is optional (mirrors manifest).
- `additionalProperties: false` on both the top-level object and each source entry.
