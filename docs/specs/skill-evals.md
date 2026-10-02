# Skill Evals Spec

`skill-sys eval harness` is the first safe PR14 slice for skill evaluation. It
validates deterministic eval fixtures without running a model, executing skill
code, opening the network, or writing to project/global skill roots.

## Command

```bash
bun scripts/commands/skill-sys.ts eval harness --source <dir> [--skill <name>] [--json] [--strict]
```

Options:

- `--source <dir>`: required source root containing `skills/`.
- `--skill <name>`: optional single-skill filter.
- `--json`: emit a machine-readable result matching
  `schema/eval-result.schema.json`.
- `--strict`: treat warnings as blocking.

## Fixture Location

The harness scans:

```text
skills/<skill-name>/evals/evals.json
```

Each fixture must match `schema/skill-evals.schema.json` and use
`schemaVersion: 1`.

## Fixture Shape

A fixture contains behavioral cases plus optional references and baselines:

```json
{
  "$schema": "https://skill-sys.dev/schema/skill-evals.schema.json",
  "schemaVersion": 1,
  "references": { "skills": ["example-skill"], "tools": ["file-read"] },
  "baselines": { "minCases": 1, "maxCases": 10 },
  "cases": [
    {
      "id": "example-positive",
      "category": "positive",
      "prompt": "Use example-skill.",
      "assertions": [
        { "kind": "contains", "target": "output", "value": "example-skill" }
      ]
    }
  ]
}
```

Supported assertion kinds are `contains`, `not-contains`, `regex`,
`matches-regex`, `required-tool`, `forbidden-tool`, and `max-output-chars`.
The MVP validates fixture structure and regex syntax only; it does not evaluate
model output yet.

## Safety Contract

The harness is read-only and deterministic:

- no LLM calls;
- no network;
- no skill/script execution;
- no Docker/container execution;
- no writes to source, project, home, or global skill roots;
- symlinked source roots or fixture files fail closed;
- output is timestamp-free and deterministic.

## Findings

Stable finding codes include:

- `EVAL_FIXTURES_MISSING`
- `EVAL_SKILLS_DIR_MISSING`
- `EVAL_SKILL_MANIFEST_MISSING`
- `EVAL_FIXTURE_SYMLINK`
- `EVAL_FIXTURE_INVALID_JSON`
- `EVAL_FIXTURE_INVALID_SHAPE`
- `EVAL_FIXTURE_UNKNOWN_KEY`
- `EVAL_CASE_DUPLICATE_ID`
- `EVAL_ASSERTION_INVALID_REGEX`
- `EVAL_REFERENCE_UNKNOWN_SKILL`
- `EVAL_REFERENCE_UNKNOWN_TOOL`
- `EVAL_BASELINE_MIN_CASES`
- `EVAL_BASELINE_MAX_CASES`

`ERROR` findings block. `WARN` findings block only with `--strict`.

## Deferred Work

PR14 intentionally does not run with-skill/without-skill model executions. PR15
adds a deterministic [skill value gate](skill-value-gate.md) that compares
pre-recorded metrics against these baselines without measuring or executing
anything. Future work can add a separate model-backed runner to produce recorded
pass rate, duration, token overhead, and regression deltas.
