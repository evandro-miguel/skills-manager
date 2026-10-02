/**
 * Federated skill search across caller-supplied local candidates and optional
 * external catalog providers.
 *
 * The service is deliberately decoupled from the local catalog module and its
 * read port: callers (future CLI wiring) materialize local candidates as
 * plain data. Guarantees:
 * - Local candidates come first, in the order provided by the caller.
 * - Provider results are sorted by canonical id before merging so output is
 *   deterministic regardless of provider-internal ordering.
 * - A failing provider degrades to a warning; federated search never throws
 *   because an external catalog is unavailable.
 * - Duplicate canonical ids are kept and flagged with
 *   `evidence.duplicate = true`; the first occurrence wins its position.
 *   Dedup applies to provider results against everything seen so far
 *   (including locals); locals themselves are trusted as caller-provided.
 */

import type {
  ExternalCatalogContext,
  ExternalCatalogProvider,
  FederatedSkillCandidate,
} from "../ports/external-catalog-provider.ts";

export const DEFAULT_FEDERATED_SEARCH_LIMIT = 25;
export const MAX_FEDERATED_SEARCH_LIMIT = 100;

/**
 * Minimal local candidate shape. Adapters map richer local records onto this
 * at the call site; the service stays independent of catalog internals.
 */
export type FederatedLocalSkill = Readonly<{
  name: string;
  description?: string;
  tags?: readonly string[];
}>;

export type FederatedSearchInput = Readonly<{
  /** Local candidates already materialized by the caller (offline catalog). */
  localSkills?: readonly FederatedLocalSkill[];
  providers?: readonly ExternalCatalogProvider[];
  context: ExternalCatalogContext;
  /** Search terms forwarded to providers that advertise `search`. */
  queries?: readonly string[];
  limit?: number;
}>;

export type FederatedSearchResult = Readonly<{
  candidates: readonly FederatedSkillCandidate[];
  warnings: readonly string[];
  localCount: number;
}>;

const MAX_WARNING_LENGTH = 160;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_FEDERATED_SEARCH_LIMIT;
  }
  const rounded = Math.floor(limit);
  if (rounded < 1) return 1;
  return Math.min(rounded, MAX_FEDERATED_SEARCH_LIMIT);
}

function toWarning(providerId: string, source: unknown): string {
  let detail: string;
  if (typeof source === "string") {
    detail = source;
  } else {
    const code =
      typeof source === "object" &&
      source !== null &&
      "code" in source &&
      typeof (source as { code?: unknown }).code === "string"
        ? (source as { code: string }).code
        : undefined;
    detail =
      code ?? (source instanceof Error ? source.message : String(source));
  }
  // Replace control characters (ANSI escapes, newlines) with spaces and
  // collapse whitespace runs so warnings stay single-line and readable.
  const sanitized = detail
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_WARNING_LENGTH);
  return `${providerId}: ${sanitized}`;
}

function localSkillToCandidate(skill: FederatedLocalSkill): FederatedSkillCandidate {
  return {
    identity: {
      origin: "local",
      name: skill.name,
      canonicalId: `local:${skill.name}`,
    },
    display: {
      name: skill.name,
      ...(skill.description !== undefined ? { description: skill.description } : {}),
      ...(skill.tags !== undefined ? { tags: skill.tags } : {}),
    },
    source: { provider: "local" },
  };
}

function sortByCanonicalId(
  candidates: readonly FederatedSkillCandidate[],
): FederatedSkillCandidate[] {
  return [...candidates].sort((left, right) =>
    left.identity.canonicalId < right.identity.canonicalId ? -1 : left.identity.canonicalId > right.identity.canonicalId ? 1 : 0,
  );
}

function markDuplicate(
  candidate: FederatedSkillCandidate,
): FederatedSkillCandidate {
  const evidence = candidate.evidence;
  const mergedEvidence = Object.freeze(
    evidence ? { ...evidence, duplicate: true } : { duplicate: true },
  );
  return Object.freeze({
    identity: candidate.identity,
    display: candidate.display,
    source: candidate.source,
    evidence: mergedEvidence,
  });
}

export async function federatedSkillSearch(
  input: FederatedSearchInput,
): Promise<FederatedSearchResult> {
  const limit = clampLimit(input.limit);
  const providers = input.providers ?? [];
  const queries = input.queries ?? [];
  const query = queries.map((term) => term.trim()).filter(Boolean).join(" ");
  const warnings: string[] = [];

  const candidates: FederatedSkillCandidate[] = [];
  const seen = new Set<string>();

  let localCount = 0;
  for (const skill of input.localSkills ?? []) {
    const candidate = localSkillToCandidate(skill);
    candidates.push(candidate);
    seen.add(candidate.identity.canonicalId);
    localCount += 1;
  }

  for (const provider of providers) {
    if (!provider.capabilities.includes("search")) continue;
    if (provider.search === undefined) continue;
    try {
      const result = await provider.search({ query, limit }, input.context);
      for (const warning of result.warnings ?? []) {
        warnings.push(toWarning(provider.id, new Error(warning)));
      }
      for (const candidate of sortByCanonicalId(result.candidates)) {
        if (seen.has(candidate.identity.canonicalId)) {
          candidates.push(markDuplicate(candidate));
          continue;
        }
        candidates.push(candidate);
        seen.add(candidate.identity.canonicalId);
      }
    } catch (error) {
      warnings.push(toWarning(provider.id, error));
    }
  }

  return {
    candidates: candidates.slice(0, limit),
    warnings,
    localCount,
  };
}
