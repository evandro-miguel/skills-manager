# Memory Adapter Spec

Status: F-05 local/private JSONL read/write slice.

Memory adapters are optional local/private bridges between Skill-Sys project
state and external memory systems. They are adapter interfaces, not core memory
stores, telemetry, registry metadata, or package content.

Validation remains deterministic and read-only for the adapter declaration. The
F-05 implementation also provides explicit JSONL read/write operations: reads
return validated records only with `readOptIn`, and writes require a read-write
JSONL adapter plus `writeOptIn`. Storage stays local/private, writes are atomic
and advisory-lock protected, and sensitive config or record text is rejected.
The implementation does not call LLMs, open the network, or add memory config
to package surfaces.

## Command

```bash
skill-sys memory-adapter --source <dir> --config <file> [--json] [--strict]
skill-sys memory-adapter read --source <dir> --config <file> [--json]
skill-sys memory-adapter write --source <dir> --config <file> --id <id> \
  --memory <text> --source-entry <text> [--dry-run] [--json]
```

- `--source` is the project/source root.
- `--config` points at a memory adapter JSON config.
- `--json` emits `schema/memory-adapter-result.schema.json` output.
- `--strict` treats validation warnings as blocking.
- `--source` is the project/source root; `--source-entry` is persisted record
  provenance for writes.
- `read` emits `schema/memory-adapter-read-result.schema.json` and returns an
  empty result when the JSONL storage file does not exist.
- `write` emits `schema/memory-adapter-write-result.schema.json`; `--dry-run`
  renders the record without changing storage.

## Storage Boundary

Memory adapter config and local adapter storage must stay under local/private
project paths:

- `.skill-sys/`
- `.agents/local/`
- `.agents/private/`
- `.private/skill-sys/`

They must not be referenced by package surfaces, registry surfaces, public
artifacts, generated catalogs, or release artifacts. The validator blocks
`packageSurface: true` and public visibility.

## Schema

Memory adapters use `schema/memory-adapter.schema.json`.

```json
{
  "schemaVersion": 1,
  "name": "local-memory",
  "visibility": "private",
  "packageSurface": false,
  "adapter": {
    "type": "jsonl",
    "mode": "read-only",
    "path": ".skill-sys/memory/local.jsonl"
  },
  "trustPolicy": {
    "readOptIn": true,
    "writeOptIn": false,
    "allowSensitiveMemory": false
  },
  "allowedSkills": ["code-discovery"]
}
```

Allowed visibility values are `private` and `local` only. Allowed adapter types
are `jsonl`, `sqlite`, and `mcp`; F-05 I/O supports JSONL only. In particular,
`"type": "mcp"` is inert validated configuration data: this command does not
expose an MCP transport or call an MCP server.

The internal command registry metadata is derived from the validated
`memory.adapter.validate`, `memory.adapter.read`, and `memory.adapter.write`
CommandSpecs. Their CLI surfaces are active and their MCP surfaces are
explicitly unsupported.

## Validation Rules

The declaration and I/O surfaces fail closed when:

- the JSON is malformed or not an object;
- `schemaVersion` is unsupported;
- `name` or `allowedSkills` entries are unsafe;
- visibility is public/world/anything except private/local;
- `packageSurface` is true;
- the config file is outside the local/private path allowlist;
- `adapter.type`, `adapter.mode`, or `adapter.path` is malformed;
- `adapter.path` is outside the local/private path allowlist;
- read access is not explicitly opted in;
- read-write adapters do not explicitly opt in to writes;
- sensitive memory is allowed;
- secret-looking text appears anywhere in the config.

Empty `allowedSkills` produces a warning; `--strict` turns that warning into a
blocking verdict.

## Deferred Work

Future slices can add:

- memory trust-policy spec expansion;
- per-skill metadata declarations for memory access;
- private-only doctor checks that prove package surfaces exclude memory config;
- SQLite/MCP/runtime adapter execution with sandbox and source-trust gates.
