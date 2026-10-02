/**
 * Parser for skills.sh catalog references.
 *
 * Accepted input forms:
 * - `skills.sh:<owner>/<repo>`
 * - `skills.sh:<owner>/<repo>/<skill-path-hint...>`
 * - `https://skills.sh/<owner>/<repo>[/<skill-path-hint...>]`
 *
 * The parser produces a canonical Git source hint only. It performs no network
 * I/O and never treats the skills.sh snapshot as an artifact source. The
 * remaining skill path inside the upstream repository is a *hint*: the
 * existing resolution pipeline relocates the actual `SKILL.md` and pins the
 * immutable commit itself.
 */

import { CatalogIntegrationError } from "./errors.ts";

export const SKILLS_SH_HOST = "skills.sh";
export const SKILLS_SH_REFERENCE_PREFIX = "skills.sh:";

const HTTPS_PREFIX = "https://";
const HOST_PATTERN = /^skills\.sh$/;
/** GitHub owner/repository naming rules, kept conservative on purpose. */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_REFERENCE_LENGTH = 300;
const MAX_SEGMENT_COUNT = 8;

export type SkillsShSourceHost = "github";

export type SkillsShReference = Readonly<{
  owner: string;
  repo: string;
  /** Path segments after the repository, as written in the reference. */
  skillPathHint?: readonly string[];
  /** Only GitHub sources are resolvable by the immutable resolver in alpha. */
  sourceType: SkillsShSourceHost;
  canonicalGitUrl: string;
  externalId: string;
}>;

function unresolved(message: string, input: string): CatalogIntegrationError {
  return new CatalogIntegrationError(
    "CATALOG_SOURCE_UNRESOLVED",
    `${message}: ${JSON.stringify(input)}`,
  );
}

function assertSegment(segment: string, input: string): string {
  if (
    segment === "." ||
    segment === ".." ||
    !SEGMENT_PATTERN.test(segment)
  ) {
    throw unresolved(
      `Invalid '${segment}' path segment in skills.sh reference`,
      input,
    );
  }
  return segment;
}

type ParsedPathSegments = Readonly<{
  owner: string;
  repo: string;
  hint: readonly string[];
}>;

function parsePathSegments(rawPath: string, input: string): ParsedPathSegments {
  // Trailing separators are cosmetic; interior empty segments are not.
  const normalized = rawPath.replace(/\/+$/, "");
  const segments = normalized.split("/").map((segment) => segment.trim());

  if (segments.some((segment) => segment.length === 0)) {
    throw unresolved("Empty path segment in skills.sh reference", input);
  }

  if (segments.length < 2 || segments.length > MAX_SEGMENT_COUNT) {
    throw unresolved(
      "skills.sh reference must be <owner>/<repo>[/<skill-path...>]",
      input,
    );
  }

  const owner = assertSegment(segments[0] as string, input);
  const repo = assertSegment(segments[1] as string, input);
  const hint = segments.slice(2).map((segment) => assertSegment(segment, input));

  return { owner, repo, hint };
}

function buildReference(rawPath: string, input: string): SkillsShReference {
  const { owner, repo, hint } = parsePathSegments(rawPath, input);

  return {
    owner,
    repo,
    ...(hint.length > 0 ? { skillPathHint: Object.freeze([...hint]) } : {}),
    sourceType: "github",
    canonicalGitUrl: `https://github.com/${owner}/${repo}.git`,
    externalId: [owner, repo, ...hint].join("/"),
  };
}

function isHttpsCatalogUrl(input: string): boolean {
  return input.startsWith(`${HTTPS_PREFIX}${SKILLS_SH_HOST}/`);
}

function parseHttpsCatalogUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw unresolved("Malformed https skills.sh URL", input);
  }

  if (!HOST_PATTERN.test(url.hostname)) {
    throw unresolved("Unexpected host in skills.sh URL", input);
  }
  if (url.username || url.password) {
    throw unresolved("Credentials are not allowed in skills.sh URLs", input);
  }
  if (url.port) {
    throw unresolved("Ports are not allowed in skills.sh URLs", input);
  }
  if (url.search) {
    throw unresolved("Query strings are not allowed in skills.sh URLs", input);
  }
  if (url.hash) {
    throw unresolved("Fragments are not allowed in skills.sh URLs", input);
  }

  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

/**
 * Parses a user-facing skills.sh reference carrying the catalog host or
 * prefix. Rejects everything else.
 */
export function parseSkillsShReference(input: string): SkillsShReference {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw unresolved("skills.sh reference must be a non-empty string", String(input));
  }

  const trimmed = input.trim();
  if (trimmed.length > MAX_REFERENCE_LENGTH) {
    throw unresolved("skills.sh reference exceeds maximum length", trimmed);
  }

  if (trimmed.startsWith(SKILLS_SH_REFERENCE_PREFIX)) {
    return buildReference(trimmed.slice(SKILLS_SH_REFERENCE_PREFIX.length), trimmed);
  }

  if (isHttpsCatalogUrl(trimmed)) {
    return buildReference(parseHttpsCatalogUrl(trimmed), trimmed);
  }

  throw unresolved(
    `Expected '${SKILLS_SH_REFERENCE_PREFIX}<owner>/<repo>' or 'https://${SKILLS_SH_HOST}/<owner>/<repo>'`,
    trimmed,
  );
}

/**
 * Parses the provider-scoped external id stored in an
 * `ExternalCatalogReference` (without the `skills-sh` provider id).
 * Accepts the bare `<owner>/<repo>[/<skill-path...]>` form and tolerates the
 * full prefixed or URL forms so callers never need to pre-normalize.
 */
export function parseSkillsShExternalId(externalId: string): SkillsShReference {
  if (typeof externalId !== "string" || externalId.trim().length === 0) {
    throw unresolved("skills.sh external id must be a non-empty string", String(externalId));
  }

  const trimmed = externalId.trim();
  if (trimmed.startsWith(SKILLS_SH_REFERENCE_PREFIX) || isHttpsCatalogUrl(trimmed)) {
    // Delegate with the original input; parseSkillsShReference owns trimming.
    return parseSkillsShReference(externalId);
  }

  if (trimmed.length > MAX_REFERENCE_LENGTH) {
    throw unresolved("skills.sh external id exceeds maximum length", trimmed);
  }
  if (trimmed.includes("://") || trimmed.includes("@")) {
    throw unresolved(
      `Expected '<owner>/<repo>[/<skill-path...>]' without scheme or credentials`,
      trimmed,
    );
  }

  return buildReference(trimmed, trimmed);
}
