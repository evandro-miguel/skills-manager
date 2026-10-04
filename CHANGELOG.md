# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Security

- Limit CodeQL and Scorecard write permissions to their analysis jobs and remove unused Scorecard OIDC access.
- Add 5,000 generated source-boundary cases to CI, covering credentials, private networks, catalog references, and Git refs.
- Replace the Markdown lint runner to remove vulnerable `braces` (GHSA-vfj7-8cjw-p6xm), preserving the existing rules. Pin its `js-yaml` dependency to patched version 5.4.1 (GHSA-r3ph-w7gj-g6xm).
- Document private vulnerability reporting, alpha support, and coordinated disclosure.
- Add candidate-tag CI so maintainers can update protected `main` without publishing development branches. Require passing GitHub Actions checks and block force pushes and branch deletion, including for administrators.

## [0.4.0-alpha.0] - 2026-10-02

Skills Manager's first public GitHub source alpha. The package
name remains `universall-skill-sys`; `skill-sys` is the public CLI and
`skillpool` remains compatible. npm publication remains disabled.

The alpha provides skillpack validation, provider projection generation and
validation, selected project installation, state diagnostics, and rollback of
completed managed backups. It includes synthetic examples and the `skill-sys`
operator skill. Private user catalogs remain outside the public repository and
package; user-root projection input requires explicit opt-in.

Bun 1.3.14 or later is required. The documented local journeys were exercised on
Linux/WSL. Native Windows, native macOS and live provider discovery are not
verified. Projection checks establish file contracts rather than provider
execution. Hosted validation is recorded against the release commit; signed
release provenance is not claimed. See the [release contract](docs/release-readiness.md)
for the full scope and [README demo](README.md#try-the-synthetic-demo) for a local trial.

### Added

- Added optional skills.sh catalog integration: `inspect-skill`,
  `audit-installed`, and plan-only `adopt-installed`, plus
  [docs/integrations/skills-sh.md](docs/integrations/skills-sh.md).
- Added the dependency vulnerability audit to the CI and release validation gates.

### Fixed

- Historical privacy auditing includes unnamed blobs reachable only through Git tags.
- Repository visibility allows the owner-approved public destination and no longer honors the implicit `SKILL_SYS_LOCAL_VALIDATE` fallback.
- Provider projections omit deprecated, archived, and compatibility-only skill sources while preserving their canonical files. Clean rebuilds remove retired cached projections; non-clean builds reject stale retired public output and preserve modified user projections.
- Public `skill-sys inspect-skill --online` is accepted by the dispatcher.
- Local `skill-sys use --skill` rejects path traversal and symlink escapes.
- Source hosts reject short-form and octal IPv4 encodings such as `127.1`.
- Sensitive, privacy, and security scanners emit findings for oversize and
  binary skips instead of failing open. Sensitive-scan callers (install, sync,
  use, publish, release) still fail closed on any finding, including skip
  WARNs.
- `skill-sys registry-trust` exits `1` on `BLOCKED`; channel artifact digests
  must be pairwise distinct.
- `skill-sys doctor --strict-hash` reports content drift as ERROR.
- Added inactive Source manifest and lock v2 schema candidates with pure structural validators.
- Added `skill-sys remove --apply` with rollback-compatible backups, a `remove-ledger.json` restore ledger, and rollback state re-merge for removed skill entries.
- Added remote `skill-sys use` for `owner/repo`, Git URLs, `#ref`, and GitHub tree URLs via isolated temp fetch.
- Added `skill-sys update <skill>` to refresh one lock-declared skill without rewriting lock identity.

### Compatibility

- Preserved Source v1 schemas and parsers unchanged as migration inputs; v2 has no active runtime consumer, selection, persistence, admission, or compatibility claim.
