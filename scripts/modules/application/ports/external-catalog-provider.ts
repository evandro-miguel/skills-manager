/**
 * Port contract for optional external skill catalogs (for example skills.sh).
 *
 * External catalogs are discovery and reputation surfaces only. They are never
 * a source authority and never an install authority: every installation must
 * resolve to a canonical upstream source that the existing Universall pipeline
 * pins to an immutable commit, digests, scans locally, projects, and installs
 * transactionally.
 *
 * Providers never receive filesystem access. They receive an explicit context
 * with an optional restricted HTTP client, an optional evidence cache, a clock,
 * and an abort signal. Providers never write locks, never mutate project
 * state, and never install files.
 */

export type ExternalCatalogCapability =
  | "search"
  | "resolve"
  | "metadata"
  | "audit"
  | "curated";

export type ExternalCatalogSourceType = "github" | "well-known";

export type ExternalAuditStatus = "pass" | "warn" | "fail";

/**
 * An external audit is BOUND only when it can be tied to an exact commit or
 * content digest. Audits that carry only a timestamp stay UNBOUND and are soft
 * evidence: they can never override a failing local scan.
 */
export type ExternalAuditBindingState =
  | "EXTERNAL_AUDIT_BOUND"
  | "EXTERNAL_AUDIT_UNBOUND";

export type ExternalAuditEvidence = Readonly<{
  provider: string;
  status: ExternalAuditStatus;
  summary?: string;
  riskLevel?: string;
  auditedAt?: string;
  commitSha?: string;
  contentDigest?: string;
  bindingState: ExternalAuditBindingState;
}>;

export type FederatedSkillOrigin = "local" | "user" | "external";

export type FederatedSkillIdentity = Readonly<{
  origin: FederatedSkillOrigin;
  name: string;
  canonicalId: string;
}>;

export type FederatedSkillDisplay = Readonly<{
  name: string;
  description?: string;
  tags?: readonly string[];
}>;

/**
 * `provider` uses the fixed ids "local" and "user-root" for local origins and
 * the catalog provider id (for example "skills-sh") for external origins.
 */
export type FederatedSkillSource = Readonly<{
  provider: string;
  externalId?: string;
  canonicalSourceHint?: string;
  sourceType?: ExternalCatalogSourceType;
}>;

export type FederatedSkillEvidence = Readonly<{
  installs?: number;
  curated?: boolean;
  duplicate?: boolean;
  audits?: readonly ExternalAuditEvidence[];
  fetchedAt?: string;
}>;

/**
 * Federated search envelope. Deliberately separate from the local
 * `CatalogSkillRecord`: external candidates have no local path, profile,
 * projection, verified digest, or trust state yet.
 */
export type FederatedSkillCandidate = Readonly<{
  identity: FederatedSkillIdentity;
  display: FederatedSkillDisplay;
  source: FederatedSkillSource;
  evidence?: FederatedSkillEvidence;
}>;

export type ExternalCatalogReference = Readonly<{
  providerId: string;
  externalId: string;
}>;

export type ExternalCatalogSearchRequest = Readonly<{
  query: string;
  limit: number;
}>;

export type ExternalCatalogSearchResult = Readonly<{
  candidates: readonly FederatedSkillCandidate[];
  /** Provider-side degradation notes (skipped malformed entries etc.). */
  warnings?: readonly string[];
}>;

export type ExternalCatalogResolution = Readonly<{
  reference: ExternalCatalogReference;
  sourceType: ExternalCatalogSourceType;
  /** Canonical upstream source hint, for example a Git repository URL. */
  canonicalSourceHint?: string;
  /** False while a source type has no safe immutable resolver yet. */
  installable: boolean;
  /** Machine-readable reason when `installable` is false. */
  reasonCode?: string;
}>;

export type ExternalCatalogEvidenceReport = Readonly<{
  reference: ExternalCatalogReference;
  audits: readonly ExternalAuditEvidence[];
  fetchedAt?: string;
}>;

export type RestrictedHttpRequest = Readonly<{
  url: string;
  method?: "GET";
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}>;

export type RestrictedHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  bodyText: string;
}>;

/**
 * Minimal HTTP surface exposed to providers. Concrete implementations must
 * enforce HTTPS-only transport, exact-host allowlists, redirect revalidation,
 * short timeouts, and response size limits.
 */
export interface RestrictedHttpClient {
  request(request: RestrictedHttpRequest): Promise<RestrictedHttpResponse>;
}

/** Provider-scoped evidence cache. Implementations must store outside projects. */
export interface ExternalEvidenceCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

export type ExternalCatalogContext = Readonly<{
  http?: RestrictedHttpClient;
  cache?: ExternalEvidenceCache;
  clock: () => Date;
  signal?: AbortSignal;
}>;

export interface ExternalCatalogProvider {
  readonly id: string;
  readonly capabilities: readonly ExternalCatalogCapability[];

  search?(
    request: ExternalCatalogSearchRequest,
    context: ExternalCatalogContext,
  ): Promise<ExternalCatalogSearchResult>;

  resolve(
    reference: ExternalCatalogReference,
    context: ExternalCatalogContext,
  ): Promise<ExternalCatalogResolution>;

  inspect?(
    reference: ExternalCatalogReference,
    context: ExternalCatalogContext,
  ): Promise<ExternalCatalogEvidenceReport>;
}
