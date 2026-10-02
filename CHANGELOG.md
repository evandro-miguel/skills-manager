# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Added optional skills.sh catalog integration: `inspect-skill`,
  `audit-installed`, and plan-only `adopt-installed`, plus
  [docs/integrations/skills-sh.md](docs/integrations/skills-sh.md).
- Added the dependency vulnerability audit to the CI and release validation gates.

### Fixed

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
