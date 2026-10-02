# Telemetry Policy Spec

Status: PR24 first offline MVP.

Telemetry policy defines opt-in gates for local telemetry work. Validation reads
a local/private JSON policy and emits a verdict; it never collects telemetry,
sends telemetry, opens the network, writes files, executes skills, reads private
user roots, or calls LLMs. Collection is a separate, explicitly invoked local
operation.

## Command

```bash
skill-sys telemetry-policy --source <dir> --config <file> [--json] [--strict]
bun scripts/commands/telemetry-policy.ts collect --source <dir> --config <file> \
  --output <private-jsonl-file> --event <name> --skill <name> [--dry-run] [--json]
```

Alias: `telemetry`.

- `--source` is the repository/source root.
- `--config` is a local policy JSON file under a local/private prefix.
- `--json` emits `schema/telemetry-policy-result.schema.json` output.
- `--strict` promotes warning-only `CONCERNS` to `BLOCKED`.
- `collect` requires a policy with `collection.enabled`, `explicitOptIn`, and
  non-empty `approvedBy`; it accepts only a caller-supplied event and an
  allowed skill and writes to a local/private path.
- `collect --dry-run` renders the exact line without creating or changing the
  output. Persisted events have no generated IDs, timestamps, host data, or
  arbitrary payload fields.

## Policy Shape

The policy uses `schema/telemetry-policy.schema.json`:

```json
{
  "schemaVersion": 1,
  "name": "local-telemetry-policy",
  "visibility": "private",
  "packageSurface": false,
  "collection": { "enabled": false, "explicitOptIn": false, "approvedBy": "" },
  "transports": { "remoteUrls": [], "localOnly": true },
  "allowedSkills": ["registry-trust"]
}
```

## Validation Rules

The validator is fail-closed:

- `schemaVersion` must be `1`.
- `visibility` must be `private` or `local`.
- `packageSurface` must be `false`.
- config paths must stay under `.skill-sys/`, `.agents/local/`,
  `.agents/private/`, or `.private/skill-sys/`.
- `collection.enabled: true` requires `explicitOptIn: true` and non-empty
  `approvedBy`.
- remote telemetry URLs are forbidden in this offline MVP.
- `transports.localOnly` must be `true`.
- policies should declare at least one allowed skill.
- symlinked configs and secret-looking config text are rejected.

## Verdicts

- `PASS`: no findings.
- `CONCERNS`: warning findings only and `--strict` is not set.
- `BLOCKED`: any error finding, or warnings with `--strict`.

## Non-Goals

The validator does not:

- send events to local or remote sinks;
- add telemetry defaults;
- persist telemetry state;
- inspect private user roots or skill content;
- generate policy files.

The collector does not run automatically, inspect private roots, send events,
or accept arbitrary payloads. It writes only when explicitly invoked and all
policy gates pass.
