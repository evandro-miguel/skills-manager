# Project Learnings Spec

Status: PR20 first offline MVP.

Project learnings are local/private operational notes for a specific repository:
small facts like validation conventions, local workflow quirks, or decisions that
help future agents work in the project. They are not package content, registry
metadata, telemetry, or cross-project memory.

The `validate` surface is read-only. It reads a local JSON file, checks that it
is private/local, verifies it lives under an allowed local/private path,
rejects secret-looking text, and emits a verdict. Validate mode never writes
learnings, syncs them, opens the network, calls LLMs, or adds them to package
surfaces. Append and update are separate write operations (see
[Write Operations](#write-operations)).

## Command

```bash
skill-sys project-learnings --source <dir> --learnings <file> [--json] [--strict]
```

- `--source` is the project/source root.
- `--learnings` points at a project learnings JSON file.
- `--json` emits `schema/project-learnings-result.schema.json` output.
- `--strict` treats warnings as blocking.

## Write Operations

Append and update are write operations on the local/private learnings file:

```bash
skill-sys project-learnings append --source <dir> --learnings <file> --id <id> --summary <text> --source-entry <text> [--dry-run]
skill-sys project-learnings update --source <dir> --learnings <file> --id <id> --summary <text> [--dry-run]
```

- `--id` is the entry identifier and `--summary` the entry summary text.
- `--source-entry` is the entry source/origin; required for `append` only.
- `--dry-run` prints what would be written without writing.
- Writes are atomic, stay under the local/private storage boundary, and emit
  `schema/project-learnings-write-result.schema.json` output with `--json`.

## Storage Boundary

Project learnings must stay under a local/private project path:

- `.skill-sys/`
- `.agents/local/`
- `.agents/private/`
- `.private/skill-sys/`

They must not be referenced by package surfaces, registry surfaces, or public
artifacts. The validator blocks `packageSurface: true` and public visibility.

## Schema

Project learnings use `schema/project-learnings.schema.json`.

```json
{
  "schemaVersion": 1,
  "name": "local-learnings",
  "visibility": "private",
  "packageSurface": false,
  "entries": [
    {
      "id": "use-bun",
      "summary": "Use Bun scripts for local validation.",
      "source": "local",
      "tags": ["workflow"]
    }
  ]
}
```

Allowed visibility values are `private` and `local` only.

The internal command registry metadata is derived from the validated
`project.learnings.validate` (read) and `project.learnings.write` (write)
CommandSpecs. Their CLI surfaces are active and their MCP surfaces are
explicitly unsupported. This metadata migration does not change the standalone
parser, facade dispatcher, application handlers, result schemas, or exit
behavior.

## Validation Rules

The current validator blocks when:

- the JSON is malformed or not an object;
- `schemaVersion` is unsupported;
- `name` or entry ids are unsafe;
- visibility is public/world/anything except private/local;
- `packageSurface` is true;
- the learnings file is outside the local/private path allowlist;
- an entry is not an object, has an unsafe id, duplicates an id, or has a
  missing/empty summary;
- secret-looking text appears in any entry.

Empty entries produce a warning; `--strict` turns that warning into a blocking
verdict. The runtime is intentionally characterized as broader than the input
schema: unknown root/entry fields are ignored structurally but entry values
still participate in the sensitive-text scan; missing or non-boolean
`packageSurface` becomes false; missing or non-array `entries` warns; and entry
`source` plus tag shape, empty values, and duplicates are not validated.
Non-object entries are skipped, while object entries with invalid fields or
duplicate ids still contribute to the result count.

The legacy finding contract can echo an observed entry id, including a
sensitive-looking or duplicate id, in machine output and duplicate-id text. It
does not return entry summaries, sources, tags, or bodies. Callers must treat
findings as potentially sensitive; this behavior is characterized here and is
not a claim of redacted output.

## Deferred Work

Future slices can add:

- redacted import from local agent logs;
- private-only doctor checks that prove package surfaces exclude learnings.
