# Source Provenance

## Overview

Source provenance tracks where each skill came from and how it was resolved. This enables reproducible installs and audit trails.

## Provenance Chain

The intended provenance chain is:

```text
skill-sys.sources.json (intent)
  → git clone/fetch
  → resolve ref to commit SHA
  → skill-sys.sources.lock.json (resolved state)
  → install/projection
  → .skills.lock.json (install state)
```

Each step adds information. The lock file is meant to capture the full resolution
chain from human intent to pinned commit.

### Current Status (partial chain)

The resolution half of the chain is now wired; install/projection remains a
separate flow. Today:

- The manifest and lock **formats** are defined, validated, and tested
  (`source-manifest.ts`, `source-lock.ts`).
- `skill-sys generate-lock` is the dedicated first-resolver: it resolves each
  declared ref to a pinned commit, materializes the checkout, and writes the
  source lock.
- `skill-sys update-check` reads both files to report remote drift, but never
  writes the lock.
- `skill-sys add`/`update` do **not** generate the source lock; resolution is a
  separate command, not an install side effect. Install/projection into the
  project tree (`.skills.lock.json`) is still a separate, not-yet-coupled flow.

Generate a lock with `skill-sys generate-lock` before running any command that
requires it.

## Provenance Fields in Lock Entries

| Field | Source | Description |
| --- | --- | --- |
| `source` | Manifest | Git URL the user declared |
| `ref` | Manifest | Git ref the user requested |
| `resolvedCommit` | Resolution | Exact commit SHA that ref pointed to |
| `skillPath` | Manifest | Skill directory within the repo |
| `manifestPath` | Resolution | Path to SKILL.md (always present in lock) |
| `resolvedAt` | Resolution | Timestamp of resolution |
| `generatedAt` | Lock file | Timestamp of lock file generation |

## Integrity Guarantees

1. **Deterministic output**: Given the same manifest + same remote state, the lock file is byte-identical.
2. **No network in core modules**: `source-manifest.ts` and `source-lock.ts` perform no I/O beyond local filesystem reads/writes. Network operations (git fetch, ref resolution) happen in command-layer code.
3. **Version pinning**: The lock records exact commit SHAs, not just branch names. This means a lock file always reproduces the same skill content.
4. **No silent mixing**: The source lock and legacy `.skills.lock.json` are separate files with distinct schemas. Commands never merge entries between them without explicit user action.

## File Naming Convention

- `skill-sys.sources.json` — human intent (the "manifest")
- `skill-sys.sources.lock.json` — resolved state (the "lock")
- `.skills.lock.json` — legacy install lockfile (unchanged)

The `skill-sys.sources.*` naming makes these files discoverable and distinguishes them from the legacy lockfile. Both new files are intended to be committed to version control.
