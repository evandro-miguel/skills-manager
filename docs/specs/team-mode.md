# Team Mode Spec

Status: PR18 first offline MVP.

Team mode lets a repository share deterministic Skill-Sys policy with a team
without vendoring or packaging the full skill catalog. The public command is a
validator: it reads a local JSON config, checks the release-safe policy
boundary, and emits a verdict. It never installs skills, creates symlinks,
executes commands, opens the network, calls LLMs, or writes files.

## Command

```bash
skill-sys team-mode --source <dir> --config <file> [--json] [--strict]
```

- `--source` is the project/source root used for relative-path validation.
- `--config` points at a team-mode JSON config file.
- `--json` emits `schema/team-mode-result.schema.json` output.
- `--strict` treats warnings as blocking.

## Config Schema

Team config files use `schema/team-mode.schema.json`.

The current validator predates direct input-schema enforcement. It defaults a
missing `installMode`, reports missing or invalid `sharedConfig` as a warning,
ignores some unknown fields, and retains duplicate adapter or profile values.
Those compatibility behaviors are characterized; the CommandSpec references
the result schema and does not claim that runtime input validation is generated
from this schema.

```json
{
  "schemaVersion": 1,
  "name": "default-team",
  "description": "Shared team Skill-Sys policy.",
  "lockfile": ".skills.lock.json",
  "installMode": "projection",
  "sharedConfig": true,
  "adapters": ["codex", "opencode"],
  "allowedProfiles": ["core"]
}
```

## Release-Safe Boundary

Team mode stores **config and lockfile references**, not a full skill catalog.
The validator blocks configs that include `skills`, `catalog`, or
`skillCatalog` fields.

Allowed install modes are:

- `projection` — preferred release-safe mode;
- `copy` — portable compatibility mode.

`symlink` is deliberately forbidden in team mode. Dev symlink workflows are a
separate PR19 concern and must stay out of public/release team config.

## Validation Rules

The MVP fails closed when:

- the JSON is malformed or not an object;
- `schemaVersion` is unsupported;
- `name` is not a safe identifier;
- `lockfile` is absolute, home-relative, or escapes the project;
- `installMode` is not `projection` or `copy`;
- `installMode` is `symlink`;
- a full skill catalog is embedded;
- adapters or profiles are malformed;
- adapters are not in the supported public adapter set.

It warns when `sharedConfig` is not explicit; `--strict` turns that warning into
a blocking verdict.

## Local Execution Seam

`applyTeamModeLocal` is an intentionally non-CLI-wired module API for a caller
that explicitly passes `{ apply: true }`. Without that opt-in it returns a
non-mutating `PLANNED` result. It first requires a `PASS` policy, then reads an
existing regular lockfile no larger than 64 KiB, rejects symlinked, outside-root,
or sensitive-looking input, and writes only to
`.skill-sys/team/<team>/team-lock.json` under the same project root.

In `projection` mode the artifact contains only deterministic policy metadata,
the relative lockfile path, byte count, and SHA-256 digest; it never emits the
lockfile contents. In `copy` mode it copies the bounded local lockfile bytes.
An identical artifact is `UNCHANGED`; any different existing artifact is
`BLOCKED`. A write failure rolls back only paths created by that invocation.
The seam has no provider, network, package-manager, global-path, or credential
operation.

## Deferred Work

Future slices can add:

- dev-mode symlink workflow (`PR19`);
- CLI exposure for the separately reviewed local execution seam;
- signed team policy files;
- cross-repo lockfile sharing guidance;
- richer profile and adapter policy negotiation.
