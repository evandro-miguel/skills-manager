# Security Policy

## Supported status

This policy covers the current GitHub-private staging phase and the planned
GitHub public alpha. Treat every release as experimental until the repository
owner explicitly completes the visibility decision and announces a stable
release policy. npm publication remains disabled independently.

## Reporting a vulnerability

Open a GitHub security advisory or contact the repository owner through GitHub.
Do not include secrets, tokens, browser session files, or exploit payloads in
issue reports.

## Security baseline

Required local gates before release work:

```bash
bun run validate
bun run scan:privacy
bun run public:audit
bun run packlist
```

Release hardening targets:

- immutable source commit and tag checks;
- source checksum;
- release manifest;
- Skill BOM;
- signed release artifacts;
- optional GitHub artifact attestations when repository eligibility allows it;
- npm provenance only after package publishing is intentionally enabled.
