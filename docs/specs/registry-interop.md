# Registry Interop Spec

Status: PR22 first offline MVP.

Registry interop makes the public Skill-Sys registry surface consumable by
external tooling through deterministic offline export and local bundle import.
The import adapter accepts only a previously materialized bundle, validates its
canonical document digests, and writes a new registry directory. It does not
select a trust authority or treat structural validity as signed provenance.

The export command reads the already-published static registry fixtures, runs
the existing registry surface validation, and emits a single deterministic
interop bundle to stdout. The import command consumes that bundle locally and
writes only validated registry JSON files. Neither command resolves remote
taps, imports third-party skills, opens the network, executes skill code, or
calls LLMs.

## Command

```bash
skill-sys registry-export --source <dir> [--output <file>] [--json] [--strict]
skill-sys registry-import --bundle <file> --output <dir> [--json] [--strict]
```

- `--source` is the repository/source root.
- `--output` writes only the portable bundle to the selected file with atomic
  replacement semantics. The result report remains on stdout.
- `--json` emits `schema/registry-export-result.schema.json` output.
- `--strict` is reserved for future warning-as-blocking checks; the first MVP
  has no warning class.

## Export Bundle

The emitted bundle uses `schema/registry-export-bundle.schema.json` and contains:

- registry metadata from `registry/metadata.json`;
- registry index from `registry/index.json`;
- each channel document referenced by the index;
- advisory/security status from `registry/advisories/security-status.json`;
- an artifact list with safe relative paths, artifact kind, and verified SHA-256
  digest for every exported registry file.

The bundle format string is:

```text
skill-sys-registry-export
```

This is intentionally a Skill-Sys interop envelope, not a claim that every
external Agent Skills registry behavior is implemented. The local import
adapter is a structural/digest boundary only; its result reports
`provenance: UNVERIFIED` and must not be used as a trust or execution decision.

## Local Import

```bash
skill-sys registry-import --bundle <file> --output <dir> [--json] [--strict]
```

The bundle must use `skill-sys-registry-export`, contain matching metadata,
index, channel, and advisory documents, and carry the canonical SHA-256 digest
for every document. The output directory must be empty (or not yet exist), so
the adapter cannot overwrite an existing registry in place. Writes are local,
deterministic JSON files under `registry/` and do not fetch or execute content.

The adapter fails closed when a bundle contains remote taps, unsafe paths,
digest drift, or signed/provenance/authority fields that cannot be verified by
an explicitly configured authority. No authority is invented from a URL,
signature-shaped field, digest, or local parse.

## Validation Rules

Before export, the command delegates to the existing registry surface validator.
The export fails closed when:

- required registry files are missing;
- metadata/index/channel/advisory files are malformed;
- any digest pointer mismatches the file content;
- channel policy allows floating refs;
- registry taps or channels use mutable refs without digest pins.

Before import, the adapter validates the bundle envelope, local base URL,
channel/advisory shape, pointer-to-document digest bindings, and canonical
JSON digests. Remote taps and unverifiable provenance are blocking findings.

The export command then re-reads only the validated public fixture files and
emits them in stable JSON key order.

## Non-Goals

The offline interop surface does not:

- fetch remote taps or resolve remote URLs;
- execute skills or package installs;
- calculate registry trust score;
- publish telemetry;
- include private skills, local memory, browser state, or user roots.

## Deferred Work

Future slices can add:

- remote tap resolution behind source-trust and sandbox gates;
- registry trust score inputs;
- signed bundle/provenance checks;
