# Skill Value Gate

The value gate is a pure, offline comparator for F-03.01 measured-eval
receipts. It produces a local `PASS` or `BLOCKED` decision; it never collects a
baseline, invokes a provider, writes evidence, contacts the network, or
authorizes a release.

```bash
bun scripts/commands/skill-sys.ts eval value-gate \
  --receipt <candidate-receipt.json> \
  --baseline <immutable-baseline.json> \
  --policy <comparison-policy.json> \
  --json
```

All three inputs must be separate regular JSON files. The policy binds the
source and fixture digests, selected case IDs, provider/model identity, metric
units, and an explicit policy version. The baseline embeds a distinct verified
receipt and repeats that policy version. Both receipts are accepted only by the
F-03.01 receipt parser, which requires `observed-run` provenance.

The policy has `value-gate-policy/v1` shape. It includes a binding and exact
`max_regression` tolerances for `pass_rate` (`ratio`), `duration` (`ms`), and
`token_overhead` (`tokens`). `pass_rate` may fall by at most its tolerance;
duration and token overhead may rise by at most theirs. Exact boundaries pass.

Malformed, missing, duplicate, unverified, fixture-only, mismatched, or
otherwise incomparable evidence is `BLOCKED`. Unknown policy shapes and unit
mismatches are also `BLOCKED`. Result output always contains
`release_authorized: false`.

Schemas:

- [`schema/value-gate-policy.schema.json`](../../schema/value-gate-policy.schema.json)
- [`schema/value-gate-results.schema.json`](../../schema/value-gate-results.schema.json)
- [`schema/value-gate-verdict.schema.json`](../../schema/value-gate-verdict.schema.json)

Release/CI integration and baseline governance remain intentionally deferred.
