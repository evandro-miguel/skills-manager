# Provider Matrix Spec

The provider matrix records provider capability metadata in checked-in JSON and
renders the user-facing compatibility table from that source of truth.

## Source of truth

Provider capability manifests live in `providers/*.json` and conform to
`schema/provider.schema.json`.

Each first-party provider manifest must declare:

- `provider`: stable provider id, matching `index.json` app ids.
- `displayName`: human-readable provider label.
- `skillPaths`: provider skill roots by scope (`project`, `user`, `global` when
  applicable). Project paths stay shared at `.agents/skills`; do not fan out
  project installs into provider-specific folders.
- `detectionPaths`: paths that can be used by diagnostics or docs to describe
  where a provider may be detected. These are declarative strings only; the
  matrix generator must not probe the host filesystem.
- `supports`: capability booleans modeled by the provider schema.
- `dangerNotes`: operator-facing caveats for unsafe assumptions or manual-only
  behavior.

Embedded or third-party skillpack provider files may be older and omit v2
metadata while the loader remains backward-compatible. Public engine provider
manifests are held to the stricter v2 contract by tests.

## Generated docs

`skill-sys provider-matrix` delegates to
`scripts/commands/generate-provider-matrix.ts`.

The command reads provider manifests from a source root and writes a bounded
section in `docs/compatibility-matrix.md` between these markers:

```text
<!-- BEGIN GENERATED PROVIDER MATRIX -->
<!-- END GENERATED PROVIDER MATRIX -->
```

The generated section must be deterministic and host-independent:

- no timestamps;
- no absolute local host paths;
- no network calls;
- no filesystem probes beyond reading `<source>/providers/*.json`;
- stable provider order and support-flag order.

`--check` verifies the checked-in section is in sync and exits non-zero on drift.

## Validation

PR07-style changes must run:

```bash
bun test tests/provider-matrix-docs.test.ts tests/parser-provider-consistency.test.ts tests/schema-contract.test.ts
bun scripts/commands/generate-provider-matrix.ts --check
bun scripts/commands/skill-sys.ts docs-check
```

Full release-readiness gates continue to run `bun run validate:ci` before a
slice is committed.
