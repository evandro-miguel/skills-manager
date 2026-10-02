# External Catalog Provider Contract

Defines how optional external skill catalogs (currently skills.sh) plug into
the Universall engine without becoming source or install authorities.
Governed by [ADR-0001](adr-0001-skills-sh-optional-catalog.md).

## Port

`scripts/modules/application/ports/external-catalog-provider.ts`

```ts
type ExternalCatalogCapability =
  | "search" | "resolve" | "metadata" | "audit" | "curated";

interface ExternalCatalogProvider {
  readonly id: string;
  readonly capabilities: readonly ExternalCatalogCapability[];
  search?(request, context): Promise<ExternalCatalogSearchResult>;
  resolve(reference, context): Promise<ExternalCatalogResolution>;
  inspect?(reference, context): Promise<ExternalCatalogEvidenceReport>;
}
```

Providers receive no filesystem access. The context exposes only:

| Member | Type | Notes |
| --- | --- | --- |
| `http` | `RestrictedHttpClient?` | HTTPS-only, exact-host allowlist, redirect revalidation, short timeouts, response size limits. Not implemented in P0. |
| `cache` | `ExternalEvidenceCache?` | Provider-scoped evidence cache; must live outside projects. Not implemented in P0. |
| `clock` | `() => Date` | Injected; no ambient time in providers. |
| `signal` | `AbortSignal?` | Cancellation. |

## Federated candidate envelope

`FederatedSkillCandidate` is deliberately separate from the local
`CatalogSkillRecord`: external candidates have no local path, profile,
projection, verified digest, installed state, or local trust yet.

```ts
{
  identity: { origin: "local"|"user"|"external", name, canonicalId },
  display:  { name, description?, tags? },
  source:   { provider, externalId?, canonicalSourceHint?, sourceType? },
  evidence?: { installs?, curated?, duplicate?, audits?, fetchedAt? }
}
```

## External audit evidence

Audits are soft evidence. An audit may be marked
`EXTERNAL_AUDIT_BOUND` only when it carries an exact `commitSha` or
`contentDigest`; timestamp-only audits stay `EXTERNAL_AUDIT_UNBOUND`. An
external PASS never overrides a failing local scan, and popularity is never a
trust score.

## Layer separation

| Layer | File/state | Mutability |
| --- | --- | --- |
| Intent manifest | `skill-sys.sources.json` | Human-authored, versioned |
| Source lock | `skill-sys.sources.lock.json` | Resolved commits + paths + digests only |
| External evidence | `<user-root>/cache/catalog/<provider>/` (for example `~/.skill-sys/cache/catalog/skills-sh/`) | Mutable, disposable, never authoritative |
| Projection manifest | per-provider output | Derived from locked sources |
| Install state | install records/rollback | What was actually deployed |

Catalog metadata (installs, trending, curated flags) must never enter the
source lock: identity of an installed source does not change when evidence
changes or a catalog entry disappears.

## skills.sh integration (P0)

Files:

- `scripts/modules/integrations/skills-sh/errors.ts` — error codes
- `scripts/modules/integrations/skills-sh/reference-parser.ts` — reference parsing
- `scripts/modules/integrations/skills-sh/provider.ts` — provider (url-only default; official-v1 opt-in)
- `scripts/modules/integrations/skills-sh/http-client.ts` — hardened `RestrictedHttpClient`
- `scripts/modules/integrations/skills-sh/client.ts` — API V1 client (retry, Retry-After, caching)
- `scripts/modules/integrations/skills-sh/response-validation.ts` — strict payload validation
- `scripts/modules/integrations/skills-sh/evidence-cache.ts` — TTL-bounded evidence cache

Accepted references: `skills.sh:<owner>/<repo>[/<path...>]`,
`https://skills.sh/<owner>/<repo>[/<path...>]`, and bare
`<owner>/<repo>[/<path...>]` as the provider-scoped external id. Parsing is
offline and produces a canonical GitHub URL hint; the Git ref is chosen by
the caller and pinned to an immutable commit by `generate-lock`.

### Error codes

| Code | Meaning |
| --- | --- |
| `CATALOG_AUTH_REQUIRED` | Transport requires credentials, but none were provided |
| `CATALOG_RATE_LIMITED` | Provider rate limit hit; respect `Retry-After` |
| `CATALOG_UNAVAILABLE` | Provider unreachable or timed out |
| `CATALOG_RESPONSE_INVALID` | Response failed strict validation |
| `CATALOG_RESULT_STALE` | Evidence older than the configured TTL |
| `CATALOG_SOURCE_UNRESOLVED` | Reference malformed or upstream unresolvable |
| `CATALOG_SOURCE_TYPE_UNSUPPORTED` | Source type without a safe resolver yet (e.g. well-known) |
| `CATALOG_CAPABILITY_MISSING` | Provider lacks the requested capability |

Integration failures degrade to warnings in federated search and must never
break offline local commands (`validate`, `doctor`, `sync`, `rollback`,
local `find`).

### Capability scope

| Capability | url-only (default) | official-v1 (opt-in) |
| --- | --- | --- |
| `resolve` | yes (offline hints) | yes |
| `search` | no (fails closed) | yes — sanitized query, result caps, 429/503 retry once with bounded Retry-After |
| `curated` / `metadata` / `audit` | no | post-alpha (PR7) |

The HTTP transport enforces HTTPS-only, exact-host allowlists, credential
rejection, manual redirect revalidation (Authorization stripped on host
change), bounded timeouts, and response size caps. The OIDC token is sourced
from the environment per call and is never persisted or logged.

## Federated search service

`scripts/modules/application/services/federated-skill-search.ts`

Guarantees: local candidates first in caller-provided order (the service
takes materialized data and stays decoupled from catalog internals); each
provider's results sorted by canonical id before merging; later duplicates
flagged `evidence.duplicate = true`; provider failures become warnings;
output truncated to the clamped limit (default 25, max 100).
