/**
 * skills.sh catalog provider.
 *
 * Transports:
 * - `url-only` (default, offline): reference resolution only — a `skills.sh`
 *   reference becomes a canonical GitHub source hint feeding the existing
 *   Universall pipeline (`skill-sys.sources.json` → `generate-lock`).
 * - `official-v1` (opt-in): adds online search through the official API V1
 *   transport. Requires a hardened `RestrictedHttpClient`, an OIDC token from
 *   the environment (never persisted), and honors caching plus rate limits.
 *
 * Online metadata/curated/audit surfaces remain post-alpha capabilities and
 * are intentionally absent from the advertised set until implemented.
 */

import type {
  ExternalCatalogCapability,
  ExternalCatalogContext,
  ExternalCatalogProvider,
  ExternalCatalogReference,
  ExternalCatalogResolution,
  ExternalCatalogSearchRequest,
  ExternalCatalogSearchResult,
  ExternalEvidenceCache,
  RestrictedHttpClient,
} from "../../application/ports/external-catalog-provider.ts";
import { CatalogIntegrationError } from "./errors.ts";
import {
  SkillsShApiClient,
  type SkillsShApiEndpoints,
} from "./client.ts";
import {
  parseSkillsShExternalId,
  type SkillsShReference,
} from "./reference-parser.ts";

export const SKILLS_SH_PROVIDER_ID = "skills-sh";

export type SkillsShTransportConfig =
  | Readonly<{ mode: "url-only" }>
  | Readonly<{
      mode: "official-v1";
      http: RestrictedHttpClient;
      baseUrl?: string;
      tokenProvider?: () => string | undefined;
      endpoints?: Partial<SkillsShApiEndpoints>;
      cache?: ExternalEvidenceCache;
      cacheTtlSeconds?: number;
    }>;

export class SkillsShCatalogProvider implements ExternalCatalogProvider {
  readonly id = SKILLS_SH_PROVIDER_ID;
  readonly #config: SkillsShTransportConfig;

  constructor(config: SkillsShTransportConfig = { mode: "url-only" }) {
    if (config.mode === "official-v1" && !config.http) {
      throw new Error(
        "skills-sh official-v1 transport requires a RestrictedHttpClient",
      );
    }
    this.#config = config;
  }

  get capabilities(): readonly ExternalCatalogCapability[] {
    return this.#config.mode === "official-v1"
      ? ["resolve", "search"]
      : ["resolve"];
  }

  async resolve(
    reference: ExternalCatalogReference,
    _context: ExternalCatalogContext,
  ): Promise<ExternalCatalogResolution> {
    if (reference.providerId !== SKILLS_SH_PROVIDER_ID) {
      throw new CatalogIntegrationError(
        "CATALOG_CAPABILITY_MISSING",
        `Provider '${this.id}' cannot resolve references of provider '${reference.providerId}'`,
      );
    }

    const parsed = parseSkillsShExternalId(reference.externalId);

    return {
      reference,
      sourceType: "github",
      canonicalSourceHint: parsed.canonicalGitUrl,
      installable: true,
    };
  }

  async search(
    request: ExternalCatalogSearchRequest,
    context: ExternalCatalogContext,
  ): Promise<ExternalCatalogSearchResult> {
    const config = this.#config;
    if (config.mode !== "official-v1") {
      throw new CatalogIntegrationError(
        "CATALOG_CAPABILITY_MISSING",
        "online search requires the official-v1 transport (opt-in)",
      );
    }

    const client = new SkillsShApiClient({
      http: config.http,
      ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
      ...(config.tokenProvider !== undefined
        ? { tokenProvider: config.tokenProvider }
        : {}),
      ...(config.endpoints !== undefined ? { endpoints: config.endpoints } : {}),
      ...(config.cache !== undefined ? { cache: config.cache } : {}),
      ...(config.cacheTtlSeconds !== undefined
        ? { cacheTtlSeconds: config.cacheTtlSeconds }
        : {}),
    });

    return client.search(request.query, request.limit, context);
  }

  // `inspect` stays unimplemented until the audit-evidence slice (PR7):
  // direct callers get the documented contract instead of partial data.
}

/**
 * Maps a parsed reference onto the shape used to declare third-party sources
 * in `skill-sys.sources.json`. The Git ref is intentionally not guessed here;
 * callers choose the branch or tag and `generate-lock` pins the commit.
 */
export function skillsShReferenceToManifestHint(
  parsed: SkillsShReference,
): Readonly<{ source: string; skillPathHint?: readonly string[] }> {
  return {
    source: parsed.canonicalGitUrl,
    ...(parsed.skillPathHint ? { skillPathHint: parsed.skillPathHint } : {}),
  };
}
