/**
 * Strict response validation for the skills.sh API V1 search surface.
 *
 * The registry snapshot is never trusted as an artifact source: payloads are
 * parsed defensively, string fields are sanitized (control characters
 * stripped, whitespace collapsed, length capped), malformed entries are
 * skipped into warnings instead of failing the whole response, and only the
 * documented evidence fields are carried into `FederatedSkillCandidate`.
 */

import type {
  ExternalAuditEvidence,
  ExternalAuditStatus,
  FederatedSkillCandidate,
} from "../../application/ports/external-catalog-provider.ts";
import { CatalogIntegrationError } from "./errors.ts";

export const MAX_QUERY_LENGTH = 200;
export const MAX_SEARCH_RESULTS = 100;

const MAX_TEXT_FIELD_LENGTH = 400;

const AUDIT_STATUSES = new Set<ExternalAuditStatus>(["pass", "warn", "fail"]);
const SOURCE_TYPES = new Set(["github", "well-known"]);

function invalid(message: string): CatalogIntegrationError {
  return new CatalogIntegrationError("CATALOG_RESPONSE_INVALID", message);
}

function sanitizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_TEXT_FIELD_LENGTH);
}

function sanitizeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value
    .map((item) => sanitizeText(item))
    .filter((item): item is string => item !== undefined)
    .slice(0, 12);
  return tags.length > 0 ? Object.freeze(tags) : undefined;
}

function sanitizeOptionalInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

function parseAudits(value: unknown, warnings: string[]): readonly ExternalAuditEvidence[] {
  if (!Array.isArray(value)) return [];
  const audits: ExternalAuditEvidence[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "object" || item === null) {
      warnings.push(`audits[${index}]: not an object`);
      return;
    }
    const record = item as Record<string, unknown>;
    const provider = sanitizeText(record.provider);
    const status = sanitizeText(record.status) as ExternalAuditStatus | undefined;
    if (!provider || !status || !AUDIT_STATUSES.has(status)) {
      warnings.push(`audits[${index}]: provider/status missing or invalid`);
      return;
    }
    const commitSha =
      typeof record.commitSha === "string" && /^[a-f0-9]{40}$/i.test(record.commitSha)
        ? record.commitSha.toLowerCase()
        : undefined;
    const contentDigest = sanitizeText(record.contentDigest);
    const summary = sanitizeText(record.summary);
    const riskLevel = sanitizeText(record.riskLevel);
    const auditedAt = sanitizeText(record.auditedAt);
    audits.push({
      provider,
      status,
      ...(summary !== undefined ? { summary } : {}),
      ...(riskLevel !== undefined ? { riskLevel } : {}),
      ...(auditedAt !== undefined ? { auditedAt } : {}),
      ...(commitSha !== undefined ? { commitSha } : {}),
      ...(contentDigest !== undefined ? { contentDigest } : {}),
      bindingState: commitSha !== undefined || contentDigest !== undefined
        ? "EXTERNAL_AUDIT_BOUND"
        : "EXTERNAL_AUDIT_UNBOUND",
    });
  });
  return audits;
}

function candidateFromEntry(
  entry: Record<string, unknown>,
  index: number,
  warnings: string[],
  fetchedAt: string,
): FederatedSkillCandidate | undefined {
  const externalId = sanitizeText(entry.id) ?? sanitizeText(entry.slug);
  if (!externalId || !externalId.includes("/")) {
    warnings.push(`results[${index}]: missing usable id`);
    return undefined;
  }

  const sourceType = sanitizeText(entry.sourceType);
  if (!sourceType || !SOURCE_TYPES.has(sourceType)) {
    warnings.push(`results[${index}]: unsupported sourceType`);
    return undefined;
  }

  const displayName = sanitizeText(entry.name) ?? externalId.split("/").pop() ?? externalId;
  const description = sanitizeText(entry.description);
  const tags = sanitizeStringArray(entry.tags);

  const audits = parseAudits(entry.audits, warnings);
  const installs = sanitizeOptionalInt(entry.installs);

  return {
    identity: {
      origin: "external",
      name: displayName,
      canonicalId: `skills-sh:${externalId}`,
    },
    display: {
      name: displayName,
      ...(description !== undefined ? { description } : {}),
      ...(tags !== undefined ? { tags } : {}),
    },
    source: {
      provider: "skills-sh",
      externalId,
      ...(sourceType === "github" || sourceType === "well-known"
        ? { sourceType: sourceType as "github" | "well-known" }
        : {}),
    },
    evidence: {
      ...(installs !== undefined ? { installs } : {}),
      ...(entry.curated === true ? { curated: true } : {}),
      ...(entry.duplicate === true ? { duplicate: true } : {}),
      ...(audits.length > 0 ? { audits } : {}),
      fetchedAt,
    },
  };
}

export type ValidatedSearchResult = Readonly<{
  candidates: readonly FederatedSkillCandidate[];
  warnings: readonly string[];
}>;

export function validateSearchResponse(
  bodyText: string,
  options: Readonly<{ limit: number; fetchedAt: string }>,
): ValidatedSearchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw invalid("search response is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("search response root must be an object");
  }

  const container = (parsed as Record<string, unknown>)["results"];
  if (!Array.isArray(container)) {
    throw invalid("search response must contain a 'results' array");
  }

  const limit = Math.max(1, Math.min(Math.floor(options.limit), MAX_SEARCH_RESULTS));
  const warnings: string[] = [];
  const candidates: FederatedSkillCandidate[] = [];

  for (const [index, item] of container.entries()) {
    if (candidates.length >= limit) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      warnings.push(`results[${index}]: not an object`);
      continue;
    }
    const candidate = candidateFromEntry(
      item as Record<string, unknown>,
      index,
      warnings,
      options.fetchedAt,
    );
    if (candidate) candidates.push(candidate);
  }

  return { candidates, warnings };
}
