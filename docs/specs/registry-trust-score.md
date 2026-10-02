# Registry Trust Score Spec

Status: PR23 first offline MVP.

Registry trust score gives release and registry consumers a deterministic local
verdict over pre-recorded trust evidence. It combines the already-validated
registry publication surface with a local scorecard JSON file. The command never
fetches remote registries, imports skills, executes skill code, writes files,
opens the network, calls LLMs, or measures live telemetry.

## Command

```bash
skill-sys registry-trust --source <dir> --scorecard <file> [--json] [--strict]
```

Aliases:

```text
registry-trust-score
trust-score
```

- `--source` is the repository/source root.
- `--scorecard` is a local JSON file with pre-recorded trust signals.
- `--json` emits `schema/registry-trust-result.schema.json` output.
- `--strict` promotes warning-only `CONCERNS` results to `BLOCKED`.

The registry entry is derived from the validated internal
`trust.registry.evaluate` CommandSpec. Its CLI surface is active and its MCP
surface is explicitly unsupported. This metadata migration does not change the
standalone parser, facade dispatcher, application handler, schemas, or observed
exit behavior: `PASS`, `CONCERNS`, and `BLOCKED` all currently exit with code
`0`; thrown errors exit with code `1`.

## Scorecard

The scorecard uses `schema/registry-trust-scorecard.schema.json`:

```json
{
  "schemaVersion": 1,
  "name": "release-trust",
  "thresholds": { "minScore": 80 },
  "signals": [
    {
      "id": "signed-ref",
      "category": "signed-ref",
      "status": "pass",
      "weight": 20,
      "evidence": "release policy requires signed tags"
    }
  ]
}
```

Signal categories are intentionally bounded:

- `signed-ref`
- `digest`
- `scan`
- `sandbox`
- `eval`
- `source-trust`
- `docs`

Each signal has a deterministic status:

- `pass` earns full signal weight;
- `warn` earns half signal weight and produces a warning finding;
- `fail` earns no weight and produces an error finding.

The final score is a rounded integer from 0 to 100:

```text
round(earnedWeight / totalWeight * 100)
```

## Verdicts

- `PASS`: score is at or above `thresholds.minScore` and there are no findings.
- `CONCERNS`: only warning findings exist and `--strict` is not set.
- `BLOCKED`: an error finding exists, the score is below threshold, or `--strict`
  is set with warnings.

## Validation Rules

Before scoring, the command runs the registry surface validator over `--source`.
This fails closed for missing registry files, malformed registry JSON, digest
mismatches, and unsupported floating refs.

Then the scorecard is parsed locally. The command rejects:

- missing `--source` or `--scorecard`;
- symlinked scorecards;
- unsafe scorecard names or signal IDs;
- invalid categories, statuses, weights, or thresholds;
- empty evidence strings.

Findings are sorted by level, code, signal, and message for deterministic output.

The runtime is intentionally characterized as broader than the scorecard
schema. Unknown fields at the root, threshold, and signal levels are ignored;
scorecard names, signal ids, and evidence are trimmed before validation; and a
zero-total-weight score is `0`. Duplicate signal ids are currently accepted.
The schema remains the declared interchange contract and rejects unknown fields
and raw identifiers with surrounding whitespace.

The legacy output is not redacted. JSON output includes every normalized signal
and its `evidence`; warning and failure findings also interpolate the evidence
in text and JSON messages. Both output formats include absolute source and
scorecard paths. Scorecards and evidence must therefore be treated as
potentially sensitive and must not be published without an explicit privacy
review.

The final scorecard path is rejected when it is a symlink. The observed legacy
filesystem behavior still follows a symlinked source, a symlink in a scorecard
ancestor, and symlinked registry-surface or digest-pointer files. These are
compatibility observations, not a general safety guarantee.

## Non-Goals

The PR23 MVP does not:

- generate trust evidence;
- run scans, sandbox plans, or evals;
- verify signatures against a remote key service;
- fetch remote taps or registries;
- import external skills;
- publish telemetry;
- persist scores to disk.

## Deferred Work

Future slices can add:

- signed bundle/provenance verification inputs;
- a deterministic scorecard generator from existing local gate outputs;
- optional output files with explicit atomic-write semantics;
- remote registry import after source-trust and sandbox gates exist;
- richer maintainer/source trust models.
