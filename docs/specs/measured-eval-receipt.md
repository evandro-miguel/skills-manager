# Measured Eval Receipt Spec

`skill-sys eval receipt` validates an already-collected measured-eval receipt.
It is a data-only boundary: acceptance validates supplied evidence shape and
bindings; it does not execute a model, trust a provider, or authorize release.

```bash
bun scripts/commands/skill-sys.ts eval receipt \
  --receipt <file> --source-digest <sha256> --fixture-digest <sha256> \
  --case-ids <id,id> --provider <id> --model <exact-model> --json
```

The receipt uses `measured-eval-receipt/v1` and must contain a bounded opaque
receipt ID, source and fixture digests, a unique case set, provider/model plus
executor/configuration identity, observed pass-rate/duration/token-overhead
metrics with `ratio`/`ms`/`tokens` units, UTC collection time, and observed-run
provenance. The parser rejects unknown keys, schema versions, metric units,
non-finite or out-of-range values, duplicate cases, digest/binding mismatches,
or unsupported provenance with stable sanitized reason codes.

The command reads at most 64 KiB from a regular non-symlink JSON receipt and
does not persist it. The caller supplies independently known immutable binding
values; this contract deliberately does not discover source state, environment,
credentials, providers, or network resources.
