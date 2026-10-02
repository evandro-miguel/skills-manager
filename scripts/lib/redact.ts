#!/usr/bin/env bun
/**
 * Redaction helpers for rendered diagnostics only.
 *
 * Every function here exists exclusively for human-facing error/report text.
 * Values used for equality checks, hashing, spawning, persistence, or
 * lockfile content must never pass through these helpers: they deliberately
 * destroy information (credentials) so that rendering untrusted-ish values
 * stays safe. The argv masking mirrors scripts/lib/command.ts so wrapper
 * failure headers look identical to runCommand's own frozen header.
 */

/**
 * Query parameter names whose value is treated as secret-bearing when
 * rendering URLs. Deliberately conservative-but-familiar: token, secret,
 * password, api_key, authorization-like names, plus bare `key` (commonly an
 * API key parameter).
 */
const CREDENTIAL_QUERY_PARAM_PATTERN =
  /^(?:x[-_])?(?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|password|passwd|pwd|private[-_]?key|credentials?|authorization|bearer|cookie|key)$/i;

/**
 * Scheme URLs (`https://`, `ssh://`, ...). Kept as a prefix match instead of
 * `new URL()` so odd remotes render deterministically without throwing.
 */
const SCHEME_URL_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]+:\/\/)(.*)$/s;

/**
 * scp-like Git syntax (`git@host:path`). Shape matches the remote detection
 * pattern used by bootstrap-skills.
 */
const SCP_LIKE_PATTERN = /^([^/@\s]+)@([^:/\s]+):/;

/**
 * Conservative vocabulary of option/variable names whose adjacent value is
 * treated as secret-bearing in rendered error messages. Kept in sync with
 * scripts/lib/command.ts so both headers redact identically.
 */
const SECRET_ARGV_NAME_PATTERN =
  /(?:^|[^a-z0-9])(token|secret|password|passwd|pwd|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|private[-_]?key|credentials?|authorization|bearer|cookie)(?:[^a-z0-9]|$)/i;

const SECRET_ENV_ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const SECRET_LONG_FLAG_WITH_VALUE_PATTERN = /^(--[^\s=]+)=(.*)$/s;
const SECRET_LONG_FLAG_PATTERN = /^--([^=]+)$/;

function isSecretArgvName(name: string): boolean {
  return SECRET_ARGV_NAME_PATTERN.test(name);
}

function redactQueryParams(query: string): string {
  if (!query) {
    return query;
  }
  return query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) {
        return pair;
      }
      const name = pair.slice(0, eq);
      if (isCredentialQueryParamName(name)) {
        return `${name}=[REDACTED]`;
      }
      return pair;
    })
    .join("&");
}

/**
 * Credential query params must be recognized even when their names are
 * percent-encoded (`%74oken`, `%61ccess%5Ftoken`, double-encoded variants).
 * The raw name is tested first, then a bounded decode loop covers nested
 * encodings; malformed encodings fall back to the raw-name test only. The
 * original encoded spelling is preserved in the rendered output.
 */
function isCredentialQueryParamName(name: string): boolean {
  if (CREDENTIAL_QUERY_PARAM_PATTERN.test(name)) {
    return true;
  }
  let current = name.replace(/\+/g, "%20");
  for (let round = 0; round < 3 && current.includes("%"); round += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return false;
    }
    if (CREDENTIAL_QUERY_PARAM_PATTERN.test(decoded)) {
      return true;
    }
    if (decoded === current) {
      return false;
    }
    current = decoded;
  }
  return false;
}

/**
 * Render a repo/source value for diagnostics. Scheme URLs get their userinfo
 * replaced and recognized credential query params masked (including
 * percent-encoded names) while preserving scheme/host/path/query-key context.
 * The entire fragment is dropped: fragments can carry `token=...`-style
 * credential assignments that URL normalization never strips, and remote
 * diagnostics never need them. scp-like remotes get their userinfo replaced;
 * local paths, refs, and hashes pass through untouched. Never throws; input
 * is never mutated.
 */
function redactRemoteForDiagnostics(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value);

  const schemeMatch = SCHEME_URL_PATTERN.exec(raw);
  if (schemeMatch) {
    let rest = schemeMatch[2]!;
    // Authority ends at the first "/", "?", or "#" after the scheme.
    const authorityEnd = rest.search(/[/?#]/);
    let authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    const tail = authorityEnd === -1 ? "" : rest.slice(authorityEnd);
    const atIndex = authority.lastIndexOf("@");
    if (atIndex !== -1) {
      authority = `[REDACTED]@${authority.slice(atIndex + 1)}`;
    }
    rest = authority + tail;
    // Drop the whole fragment before query handling so no fragment content —
    // including credential assignments — can reach rendered diagnostics.
    const fragmentIndex = rest.indexOf("#");
    if (fragmentIndex !== -1) {
      rest = rest.slice(0, fragmentIndex);
    }
    const queryIndex = rest.indexOf("?");
    if (queryIndex !== -1) {
      const head = rest.slice(0, queryIndex);
      return `${schemeMatch[1]}${head}?${redactQueryParams(rest.slice(queryIndex + 1))}`;
    }
    return `${schemeMatch[1]}${rest}`;
  }

  if (SCP_LIKE_PATTERN.test(raw)) {
    return raw.replace(SCP_LIKE_PATTERN, "[REDACTED]@$2:");
  }

  // Local path, ref, hash, or anything unrecognized: rendered as-is.
  return raw;
}

/**
 * Render argv for error messages with secret-bearing values replaced by
 * [REDACTED]. Covers `--flag value`, `--flag=value`, secret-ish `ENV=value`
 * elements, and credential-bearing remotes passed as arguments. The spawned
 * argv itself is never modified.
 */
function redactArgvForDiagnostics(args: readonly unknown[]): string[] {
  const source = args.map((arg) => (typeof arg === "string" ? arg : String(arg)));
  const rendered: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const arg = source[index]!;
    const envAssignment = SECRET_ENV_ASSIGNMENT_PATTERN.exec(arg);
    if (envAssignment && isSecretArgvName(envAssignment[1]!)) {
      rendered.push(`${envAssignment[1]}=[REDACTED]`);
      continue;
    }
    const flagWithValue = SECRET_LONG_FLAG_WITH_VALUE_PATTERN.exec(arg);
    if (flagWithValue && isSecretArgvName(flagWithValue[1]!)) {
      rendered.push(`${flagWithValue[1]}=[REDACTED]`);
      continue;
    }
    const bareFlag = SECRET_LONG_FLAG_PATTERN.exec(arg);
    if (bareFlag && isSecretArgvName(bareFlag[1]!)) {
      rendered.push(arg);
      const next = source[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        rendered.push("[REDACTED]");
        index += 1;
      }
      continue;
    }
    rendered.push(redactRemoteForDiagnostics(arg));
  }
  return rendered;
}

/**
 * Frozen child-failure header shared by wrapper helpers that spawn children
 * under allowFailure and build their own errors. Format mirrors runCommand's
 * thrown header (`Command failed (<code>): <redacted argv>`) minus captured
 * output, which must never reach wrapper-thrown messages.
 */
function childFailureMessage(args: readonly unknown[], exitCode: number): string {
  return `Command failed (${exitCode}): ${redactArgvForDiagnostics(args).join(" ")}`;
}

export {
  CREDENTIAL_QUERY_PARAM_PATTERN,
  childFailureMessage,
  isCredentialQueryParamName,
  redactArgvForDiagnostics,
  redactRemoteForDiagnostics,
};
