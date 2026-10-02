/**
 * Skills.sh official-v1 API client (opt-in transport).
 *
 * Token handling: credentials come exclusively from a provider callback
 * (default: `process.env.VERCEL_OIDC_TOKEN`). They are never persisted into
 * config, locks, state, or logs, and never appear in error messages; the
 * hardened HTTP transport additionally strips Authorization on any host
 * change during redirects.
 *
 * Resilience: only 429 and 503 are retried (one retry), honoring a bounded
 * `Retry-After`; every other non-200 fails immediately.
 *
 * Evidence caching: successful searches may be cached through an
 * `ExternalEvidenceCache` living outside projects (TTL-bounded). The cache is
 * disposable by design — misses simply hit the network again.
 */

import { createHash } from "node:crypto";

import type {
  ExternalCatalogContext,
  ExternalCatalogSearchResult,
  ExternalEvidenceCache,
  RestrictedHttpClient,
} from "../../application/ports/external-catalog-provider.ts";
import { CatalogIntegrationError } from "./errors.ts";
import {
  MAX_QUERY_LENGTH,
  MAX_SEARCH_RESULTS,
  validateSearchResponse,
} from "./response-validation.ts";

export const DEFAULT_SKILLS_SH_BASE_URL = "https://skills.sh";
export const DEFAULT_SEARCH_CACHE_TTL_SECONDS = 21600;
const MAX_RETRY_ATTEMPTS = 2;
const RETRYABLE_STATUSES = new Set([429, 503]);
const DEFAULT_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 5;

/**
 * Endpoint paths are configurable on purpose: the upstream API surface has
 * drifted before. Defaults reflect the documented v1 shape at authoring time.
 */
export type SkillsShApiEndpoints = Readonly<{ search: string }>;

export const DEFAULT_SKILLS_SH_ENDPOINTS: SkillsShApiEndpoints = {
  search: "/api/v1/search",
};

export function defaultSkillsShTokenProvider(): string | undefined {
  return process.env["VERCEL_OIDC_TOKEN"];
}

function sanitizeQuery(raw: string): string {
  return raw
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

function parseRetryAfterSeconds(
  headers: Record<string, string>,
): number | undefined {
  const raw = headers["retry-after"];
  if (raw === undefined) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

type CachedSearchPayload = {
  candidates: ExternalCatalogSearchResult["candidates"];
  warnings?: readonly string[];
};

export type SkillsShApiClientOptions = Readonly<{
  http: RestrictedHttpClient;
  baseUrl?: string;
  tokenProvider?: () => string | undefined;
  endpoints?: Partial<SkillsShApiEndpoints>;
  cache?: ExternalEvidenceCache;
  cacheTtlSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}>;

export class SkillsShApiClient {
  readonly #http: RestrictedHttpClient;
  readonly #baseUrl: string;
  readonly #endpoints: SkillsShApiEndpoints;
  readonly #tokenProvider: () => string | undefined;
  readonly #cache: ExternalEvidenceCache | undefined;
  readonly #cacheTtlSeconds: number | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;

  constructor(options: SkillsShApiClientOptions) {
    this.#http = options.http;
    this.#baseUrl = options.baseUrl ?? DEFAULT_SKILLS_SH_BASE_URL;
    this.#endpoints = { ...DEFAULT_SKILLS_SH_ENDPOINTS, ...(options.endpoints ?? {}) };
    this.#tokenProvider =
      options.tokenProvider ?? defaultSkillsShTokenProvider;
    this.#cache = options.cache;
    this.#cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_SEARCH_CACHE_TTL_SECONDS;
    this.#sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.#now = options.now ?? (() => new Date());
  }

  async search(
    query: string,
    limit: number,
    context?: Pick<ExternalCatalogContext, "cache">,
  ): Promise<ExternalCatalogSearchResult> {
    const sanitizedQuery = sanitizeQuery(query);
    if (sanitizedQuery.length === 0) {
      return { candidates: [] };
    }
    const effectiveLimit = Math.max(
      1,
      Math.min(Math.floor(limit) || 10, MAX_SEARCH_RESULTS),
    );

    const token = this.#tokenProvider();
    if (!token) {
      throw new CatalogIntegrationError(
        "CATALOG_AUTH_REQUIRED",
        "skills.sh official-v1 requires VERCEL_OIDC_TOKEN in the environment",
      );
    }

    const cache = context?.cache ?? this.#cache;
    const cacheKey = `search:v1:${createHash("sha256")
      .update(`${sanitizedQuery}\u0000${effectiveLimit}`)
      .digest("hex")}`;

    if (cache) {
      const cached = await cache.get(cacheKey);
      if (cached !== null) {
        try {
          const payload = JSON.parse(cached) as CachedSearchPayload;
          if (Array.isArray(payload.candidates)) {
            return {
              candidates: payload.candidates,
              ...(Array.isArray(payload.warnings)
                ? { warnings: payload.warnings }
                : {}),
            };
          }
        } catch {
          // Corrupt evidence is disposable; fall through to the network.
        }
      }
    }

    const url =
      `${this.#baseUrl}${this.#endpoints.search}` +
      `?q=${encodeURIComponent(sanitizedQuery)}&limit=${effectiveLimit}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };

    let lastStatus = 0;
    let lastRetryAfter: number | undefined;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
      const response = await this.#http.request({ url, headers });
      lastStatus = response.status;

      if (response.status === 200) {
        const validated = validateSearchResponse(response.bodyText, {
          limit: effectiveLimit,
          fetchedAt: this.#now().toISOString(),
        });

        if (cache && validated.candidates.length > 0) {
          const payload: CachedSearchPayload = {
            candidates: validated.candidates,
            warnings: validated.warnings,
          };
          await cache.set(cacheKey, JSON.stringify(payload), this.#cacheTtlSeconds);
        }

        return {
          candidates: validated.candidates,
          ...(validated.warnings.length > 0 ? { warnings: validated.warnings } : {}),
        };
      }

      lastRetryAfter = parseRetryAfterSeconds(response.headers);

      if (
        RETRYABLE_STATUSES.has(response.status) &&
        attempt < MAX_RETRY_ATTEMPTS
      ) {
        await this.#sleep(
          (lastRetryAfter ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000,
        );
        continue;
      }
      break;
    }

    if (lastStatus === 401) {
      throw new CatalogIntegrationError(
        "CATALOG_AUTH_REQUIRED",
        "provider rejected credentials; refresh VERCEL_OIDC_TOKEN and retry",
      );
    }
    if (lastStatus === 429) {
      throw new CatalogIntegrationError(
        "CATALOG_RATE_LIMITED",
        "provider rate limit reached after retry" +
          (lastRetryAfter !== undefined ? ` (retry-after ${lastRetryAfter}s)` : ""),
      );
    }
    throw new CatalogIntegrationError(
      "CATALOG_UNAVAILABLE",
      `unexpected provider status ${lastStatus}`,
    );
  }
}
