# skills.sh Integration

Skills Manager is an optional governance layer for the open Agent
Skills ecosystem — not a competitor to it.

> Keep using the Agent Skills ecosystem. Add Skills Manager when you need
> reproducibility, governance, private skills, provider projections, and safe
> deployment.

skills.sh contributes public discovery: search, popularity, curation, and
partner audits. Skills Manager contributes what must be trustworthy: canonical
source resolution, immutable commit pinning, content digests, local security
scans, provider projections, transactional installs, drift detection, doctor,
and rollback.

## What Universall adds

- Private skills and User Skill Roots stay local.
- Every install resolves the canonical Git upstream directly and pins an
  immutable commit with its own content digest.
- Registry snapshots are never treated as artifact sources.
- External audit evidence is soft evidence; a local scan failure always wins.

## Current usage (P0, offline)

P0 ships reference resolution only — no network calls:

1. Discover a skill on skills.sh, for example `vercel-labs/skills/find-skills`.
2. Declare the canonical source in `skill-sys.sources.json` (choose the ref;
   `generate-lock` pins the commit):

```json
{
  "version": 1,
  "sources": [
    {
      "name": "find-skills",
      "source": "https://github.com/vercel-labs/skills.git",
      "ref": "main",
      "skillPath": "skills/find-skills"
    }
  ]
}
```

1. Run `skill-sys generate-lock`, then install as usual. The pipeline
   verifies the skill path and computes its own digest.

The reference parser (`skills.sh:<owner>/<repo>[/<path>]`) is available in
`scripts/modules/integrations/skills-sh/` for tooling that maps catalog
references onto these canonical declarations. See
[the provider contract](../specs/external-catalog-provider.md).

## Network transports

| Transport | Status | Notes |
| --- | --- | --- |
| URL-only reference parsing | **Default** | Offline; no search; transforms references into Git hints |
| Official API V1 | **Future provider transport (not exposed by `inspect-skill`)** | If enabled by a future governed command, search uses a hardened HTTPS client (HTTPS-only, host allowlist, redirect revalidation, timeouts, body caps); OIDC token comes from the environment only, never persisted in config, lock, state, or logs; 429/503 are retried once honoring bounded Retry-After; evidence cache lives outside projects |
| Legacy `/api/search` endpoint | Not implemented | Not part of any stability contract |
| Hosted proxy | Rejected | Adds cost, abuse surface, query logging, and token management |

The current `inspect-skill` command exposes no online search.
`--online`, `--strict`, and `--home` are deprecated and rejected. If a future
provider transport is exposed, it must require explicit opt-in and preserve
the fully offline default because queries can reveal what you are building.

## Privacy rules

Never sent to any external catalog, now or later:

- private skill names or descriptions
- profiles, Global Core membership, private queries
- local paths, client names, private repository names

Private skills live in User Skill Roots and enter public flows only through
explicit opt-in surfaces that exclude them by default.

## Freshness caveats

The upstream catalog has documented freshness issues: renamed/deleted skills
remaining indexed, stale audits attached to changed code, duplicate or
misattributed entries, and project-level lock handling gaps in the CLI. See
upstream reports (issues #1944, #1863, #451, #542) and the skills.sh terms.
This is exactly why Universall re-resolves every source from Git upstream and
never trusts catalog snapshots as installation material.

## Distribution through skills.sh

The agent-facing instructions ship as an installable skill:

```bash
npx skills add evandro-miguel/skills-manager --skill skill-sys
```

When the repository is publicly reachable, that gives your agent the operating
instructions. The engine itself is installed separately via Bun/npm once
release gates open. Already using
`skills`? Install nothing twice: let `skills` handle discovery and simple
installs, use `skill-sys` when you need pinned, audited, projected installs.

## Ownership boundary

If you installed skills with the `skills` CLI into `.agents/skills`,
Universall treats those targets as externally managed and read-only until you
explicitly adopt them (adoption tooling is planned; see
[External Install Ownership](../specs/external-install-ownership.md)).
One manager per target.
