# Security Policy

## Supported versions

Skills Manager is a public alpha. Security fixes target the latest published
`0.4.0-alpha` release and `main`; older alpha snapshots are not maintained
separately. There is no stable release or long-term support policy yet.
[npm publication remains disabled](CONTRIBUTING.md).

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/evandro-miguel/skills-manager/security/advisories/new).
Include the affected version or commit, expected and observed behavior, impact,
and minimal reproduction steps using synthetic data.

Do not disclose vulnerabilities in public issues or pull requests before
coordinating with the maintainer. Never send real credentials, tokens, cookies,
browser session files, or personal skill contents. Use placeholders and a
minimal synthetic proof of concept instead.

## Response and coordinated disclosure

The maintainer reviews private reports on a best-effort basis; this alpha has
no guaranteed response or remediation timeline. Follow up in the same private
report if an acknowledgement is delayed. The maintainer will coordinate
validation, remediation, and disclosure timing there. A confirmed vulnerability
should receive a fix or documented mitigation before public disclosure where
practical, with affected versions and remediation described in a
[security advisory](https://github.com/evandro-miguel/skills-manager/security/advisories).

## Security baseline and limitations

Run `bun run validate:publish` before a release. This includes tests, privacy
and public-surface scans, dependency auditing, complete reachable-history
checks, and package validation. Hosted CodeQL and OpenSSF Scorecard provide
additional analysis; their successful execution is not a security guarantee.

Skills are untrusted content. Review their instructions and bundled scripts
before installation. Generated sandbox plans and provider projections do not
establish enforced runtime isolation. See the
[release readiness contract](docs/release-readiness.md) for remaining release
and platform evidence requirements.
