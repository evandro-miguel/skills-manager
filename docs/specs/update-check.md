# Update Check

## Overview

`skill-sys update-check` reports available updates for declared third-party skill
sources. It is **check-only and read-only** — it never writes files and never
applies updates. It compares an existing resolved lock against the current remote
state of each declared ref.

## Prerequisites

`update-check` requires two files to already exist on disk:

1. `skill-sys.sources.json` — the human-authored manifest (intent).
2. `skill-sys.sources.lock.json` — a previously resolved lock (state).

If either file is missing, the command fails closed with a clear error. A lock
must be present before `update-check` can run; generate one with
`skill-sys generate-lock` (alias `lock`), the dedicated first-resolver. Lock
generation is a **separate command** — `skill-sys add`/`update` do **not** write
the source lock.

## Behavior

1. Reads `skill-sys.sources.json` (manifest) and `skill-sys.sources.lock.json`
   (current lock).
2. Validates both files and rejects duplicate skill names in the manifest.
3. For each declared source, resolves the declared `ref` against its remote via
   `git ls-remote --exit-code` to obtain the current commit. A pinned 40-char
   commit SHA is treated as-is (it cannot drift) and needs no network lookup.
4. Compares the locked commit against the latest resolved commit per source.
5. Outputs an update report (JSON to stdout, human-readable summary to stderr).
6. **Default exit code is 0** even when updates are available, making it
   CI-friendly.
7. Use `--strict` to exit non-zero when any entry is `update-available` or
   `error` (for CI notification pipelines).

This command never modifies the manifest, the lock, or any installed skill
state. It is safe to run repeatedly and from untrusted checkouts.

## Update Report Schema

Defined in `schema/update-report.schema.json`. Shape:

```json
{
  "checkedAt": "2026-06-09T12:00:00.000Z",
  "entries": [
    {
      "name": "example-skill",
      "status": "update-available",
      "currentRef": "v1.0.0",
      "currentCommit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "latestRef": "v1.1.0",
      "latestCommit": "f3e4d5c6b7a8f3e4d5c6b7a8f3e4d5c6b7a8f3e4"
    },
    {
      "name": "stable-skill",
      "status": "up-to-date",
      "currentRef": "v1.0.0",
      "currentCommit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "latestRef": "v1.0.0",
      "latestCommit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
    }
  ]
}
```

### Entry Statuses

- **up-to-date**: The locked commit matches the latest resolved commit for the
  declared ref. `currentRef`, `currentCommit`, `latestRef`, and `latestCommit`
  are present.
- **update-available**: The declared ref now resolves to a different commit, or
  the manifest declares a source that has no corresponding lock entry.
  `currentRef`/`currentCommit` are present only when a lock entry exists.
- **error**: The check could not complete (network failure, auth issue, etc.).
  Includes an `error` message field, and preserves `currentRef`/`currentCommit`
  from the lock entry when one exists.

## Design Decisions

- **No auto-apply, no writes**: Updates are never applied by this command.
  Applying changes remains an explicit, separate user action. This prevents
  supply-chain surprise and keeps the command safe to run in read-only contexts.
- **Requires an existing lock**: This is a drift-check, not a first resolver. It
  does not create the lock; generate one first with `skill-sys generate-lock`.
- **Exit 0 by default**: A CI pipeline should not fail just because updates
  exist. Use `--strict` to invert this for notification pipelines.
- **Network required for non-pinned refs**: The check requires live remote
  access to resolve branches/tags. Offline runs (or auth failures) produce
  `error` entries for the affected sources. A pinned full commit SHA needs no
  network and cannot drift.

## Relationship To Existing Commands

- `skill-sys update-check` is the **only** command that reads
  `skill-sys.sources.lock.json` to report remote drift; it does not modify it.
- `skill-sys generate-lock` (alias `lock`) is the first-resolver that writes
  `skill-sys.sources.lock.json` from the manifest. It is a separate command;
  `update-check` consumes its output without modifying it.
- `skill-sys update` operates on the legacy project install lockfile
  (`.skills.lock.json`) via the `skillpool upgrade` backend. It does **not**
  generate or modify `skill-sys.sources.lock.json`; that remains the job of
  `skill-sys generate-lock`.
- `skill-sys doctor` checks for local drift (installed files vs. the legacy
  install lock) but does not check remote refs or the source lock.

## Current Status And Roadmap

- **Active**: `update-check` is implemented, registered as a public command, and
  tested. It reads manifests and locks via `source-manifest.ts` /
  `source-lock.ts`.
- **Active**: `skill-sys generate-lock` (alias `lock`) is the implemented
  first-resolver that writes `skill-sys.sources.lock.json` from a manifest. Run
  it first to produce the lock that `update-check` consumes.
- **Not coupled**: `add`/`update` still do **not** generate the source lock; lock
  generation is a separate, explicit command by design.
