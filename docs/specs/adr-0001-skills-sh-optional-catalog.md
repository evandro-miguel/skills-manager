# ADR-0001: skills.sh as an optional external catalog

## Status

Accepted

## Date

2026-08-21

## Context

The Agent Skills ecosystem (`skills.sh` and its `skills` CLI) provides public
skill discovery, search, popularity signals, curation, and partner audits.
Its registry has known freshness problems: renamed or deleted skills can keep
appearing, audits can outlive the code they describe, and the catalog API is
provided without availability or accuracy guarantees.

Universall Skill-Sys already owns the parts that must be trustworthy:
canonical source resolution, immutable commit pinning, content digests, local
security scans, provider projections, transactional installation, drift
detection, doctor, and rollback. Its catalog today is local, synchronous, and
deterministic.

Two integration postures are possible: treat skills.sh as a competing
replacement, or treat it as an optional upstream discovery surface feeding
the existing Universall pipeline.

## Decision

1. **skills.sh is an optional external catalog.** It is a discovery and
   reputation reference, nothing more.
2. **It is not a source authority.** Installations never trust registry
   snapshots as artifacts. Every install resolves the canonical upstream Git
   source, pins an immutable commit, relocates `SKILL.md`, and computes its
   own content digest.
3. **It is not an install authority.** Universall owns installation,
   projection, verification, and rollback for anything it manages.
4. **The integration cannot bypass local policy.** External PASS evidence can
   never override a failing local scan; external audit data is soft evidence.
5. **Local by default.** Catalog, validation, doctor, sync, rollback, and
   local find work fully offline. Network access requires explicit opt-in
   (`--online` / `--catalog`), which arrives with the API V1 transport after
   the first public alpha.
6. **One manager per target.** A skill target directory is owned by exactly
   one manager at a time (`skill-sys`, `external:skills-cli`, or explicitly
   adopted). Two managers must never rewrite the same target.
7. **External evidence stays separate from source identity.** Popularity,
   curation, duplicate flags, and audits live in disposable evidence caches —
   never inside `skill-sys.sources.lock.json`.

## Consequences

- The P0 slice is offline by construction: reference parsing
  (`skills.sh:owner/repo/skill`) plus canonical GitHub resolution through the
  existing pipeline. No HTTP client ships in P0.
- Federated search merges local results first and degrades external provider
  failures to warnings; an unavailable skills.sh cannot break local commands.
- Adoption of CLI-managed installs (`audit-installed`, `adopt`) is planned
  work, gated behind explicit user approval before ownership transfer.
- Distribution through the skills.sh ecosystem is complementary: installing
  the `skill-sys` agent-facing instructions via `npx skills` does not replace
  engine installation via Bun/npm.

## Scope references

| Phase | Content | Where |
| --- | --- | --- |
| P0 | Provider port, skills.sh reference parser, GitHub-only canonical hints, federated search service, docs | This repository |
| P1 | Official API V1 client (OIDC opt-in), inspect/audit evidence, adoption plan/apply | Planned |
| P2 | Pack import, well-known resolver, CI action, long-tail deploy bridges | Planned |

See `docs/specs/external-catalog-provider.md` for the contract and
`docs/specs/external-install-ownership.md` for ownership rules.
