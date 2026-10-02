# Workflow Chain Spec

Status: PR16 first offline MVP.

Workflow chains describe multi-step skill workflows as data. The PR16 MVP is a
validator and dry-run planner only: it never runs steps, commands, skills, LLMs,
tools, network calls, or containers.

## Command

```bash
skill-sys workflow-chain --source <dir> --workflow <file> [--json] [--strict] [--execute --adapter local-test]
```

- `--source` points at a skill source with `skills/<name>/SKILL.md` entries.
- `--workflow` points at a workflow-chain JSON file.
- `--json` emits `schema/workflow-chain-verdict.schema.json` output.
- `--strict` treats warnings as blocking.
- `--execute --adapter local-test` invokes the versioned in-process test adapter only after a passing plan. It receives gate IDs and validated step metadata in declared order, never gate commands, prompts, or skill content. Any other adapter name, omitted adapter, invalid adapter response, or denied gate blocks deterministically.

## Workflow Schema

Workflow files use `schema/workflow-chain.schema.json`.

```json
{
  "schemaVersion": 1,
  "name": "release-readiness",
  "description": "Plan release readiness steps.",
  "gates": [
    { "id": "validate", "command": ["bun", "run", "validate:local"] }
  ],
  "steps": [
    {
      "id": "review",
      "skill": "example-skill",
      "prompt": "Review release readiness.",
      "requiredGates": ["validate"]
    }
  ]
}
```

## MVP Checks

The planner fails closed for:

- missing or malformed workflow JSON;
- unsupported `schemaVersion`;
- missing workflow name;
- invalid or duplicate gate ids;
- invalid or empty gate command vectors;
- missing, invalid, duplicate, or unsafe step ids;
- step skill names with path separators or unsafe names;
- steps that reference skills absent from `skills/<name>/SKILL.md`;
- unsupported step kinds (only `skill` is supported when `kind` is provided);
- required gates that are not declared in top-level `gates`.

The planner warns when a step has no `requiredGates`. `--strict` promotes those
warnings to a blocking verdict.

## Safety Boundary

Gate commands are command vectors for humans/CI to inspect later. The default and
dry-run paths record and validate them without execution. The opt-in `local-test`
adapter is an in-process fixture seam: it does not execute gate commands, skills,
tools, LLMs, network calls, containers, or arbitrary workflow text. No production
adapter is available through this command.

## Deferred Work

Future slices can add:

- richer step dependency ordering;
- reusable chain libraries;
- route-rule integration (PR17);
- optional CI wiring after explicit policy review;
- execution adapters only behind separate dry-run/approval gates.
