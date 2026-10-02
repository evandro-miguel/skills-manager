# Security Scan v2 Spec

Security scan v2 is a static, offline scanner for skill sources. It complements
`scan-sensitive`, `scan-privacy`, and `semantic-audit` by comparing source files,
setup scripts, prompt-injection-shaped text, and `skill.meta.json` risk metadata.

## Command

```bash
skill-sys scan-security --source <dir> [--strict] [--json]
```

The command delegates to `scripts/commands/scan-security.ts`. The source must be
explicit; there is no implicit HOME or global skill root.

## Safety contract

- The scanner never executes, imports, installs, or evaluates skill code.
- It performs only filesystem reads under the explicit source root.
- Symlinked source roots are refused.
- Binary and oversized files emit `FILE_SKIPPED_BINARY` / `FILE_SKIPPED_OVERSIZE`
  WARN findings instead of being omitted. `--strict` treats those as blocking.
- Findings use relative paths only.
- Matched text is never echoed, so secret-shaped values are not printed.

## Finding shape

Findings conform to `schema/security-finding.schema.json`:

- `level`: `ERROR` or `WARN`
- `code`: stable machine category
- `path`: source-relative path
- `rule`: stable rule id
- `line`: optional one-based line number
- `message`: human-readable summary without matched secret values

`--strict` treats `WARN` findings as blocking. Without `--strict`, only `ERROR`
findings are blocking.

## Initial offline detections

- Network/exfiltration markers: `curl`, `wget`, `fetch(...)`, and `http(s)://`.
- Credential scraping markers: SSH/AWS/browser credential-store paths and
  secret-shaped `process.env` reads.
- Hidden setup scripts: `postinstall`, `preinstall.*`, `setup.*`, and shell
  scripts under skill directories.
- Prompt-injection phrases such as instruction override or system-prompt
  exfiltration attempts.
- Metadata inconsistencies between observed markers and `skill.meta.json` risk
  declarations: `executesShell`, `networkAccess`, and `credentialSensitive`.

## Deferred work

Docker/no-network sandbox execution belongs to PR13 runtime sandbox verification.
Source trust policy and install-time blocking for unknown script-enabled sources
require separate owner policy decisions and are not enabled by this slice.
