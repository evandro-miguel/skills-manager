# Dev Mode Spec

Status: PR19 validator plus F-04.04 local execution seam.

Dev mode defines a local-only symlink workflow for people developing skills in a
repository. The PR19 MVP is a dry-run validator only: it reads a local JSON file,
validates that symlink use is explicitly marked as development-only, resolves the
referenced skills, and emits a plan with `would-link` actions. It never creates
symlinks, installs skills, mutates state, executes commands, opens the network,
or calls LLMs.

## Command

```bash
skill-sys dev-mode --source <dir> --config <file> [--json] [--strict]
```

- `--source` points at a local source with `skills/<name>/SKILL.md` entries.
- `--config` points at a dev-mode JSON config.
- `--json` emits `schema/dev-mode-result.schema.json` output.
- `--strict` treats warnings as blocking.

## Config Schema

Dev-mode config files use `schema/dev-mode.schema.json`.

```json
{
  "schemaVersion": 1,
  "name": "local-dev",
  "description": "Local skill development links.",
  "devOnly": true,
  "publicRelease": false,
  "installMode": "symlink",
  "allowSymlinks": true,
  "links": [
    { "skill": "example-skill", "target": ".agents/skills/example-skill" }
  ]
}
```

## Safety Boundary

This is not a public/release install mode. The validator fails closed unless the
config states all of the following:

- `devOnly: true`;
- `publicRelease: false`;
- `installMode: "symlink"`;
- `allowSymlinks: true`.

Targets must be project-relative and stay under one of these local development
prefixes:

- `.agents/skills/`
- `.skill-sys/dev-links/`

The validator rejects embedded catalogs (`skills`, `catalog`, `skillCatalog`) and
only emits dry-run `would-link` actions.

## Local Execution Seam

`applyDevModeLocal(input, { apply: true })` is an in-process, opt-in module API;
it is deliberately not wired to the CLI. Without `apply`, it returns a
non-mutating `PLANNED` result. The seam only creates directory symlinks from
`skills/<name>` into the approved project-local target prefixes and stores a
small receipt under `.skill-sys/dev-links/.receipts/`.

The optional `{ cleanup: true }` removes only a stale link whose receipt,
target, and resolved source all match. Existing files, directories, unowned or
mismatched symlinks, path escapes, symlinked parents, unsupported platforms,
and invalid plans return `BLOCKED` before mutation. It does not invoke a
provider, network, package manager, global location, or recursive deletion.

## Deferred Work

Future slices can add opt-in integration with team policy and project learnings.
