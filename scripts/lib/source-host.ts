#!/usr/bin/env bun
/**
 * Canonical remote-source host safety, shared by ingestion classification
 * (`normalizeSourceSpec` in scripts/commands/skill-sys.ts) and the foreign-lock
 * upstream verifier. The parsing/validation bodies here are the single source
 * of truth: consumers must import them instead of re-implementing weaker host
 * parsing.
 */

import {
  isCredentialQueryParamName,
  redactRemoteForDiagnostics,
} from "./redact.ts";

export function isRemoteSpec(value: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@|[A-Za-z0-9_.-]+@[^:]+:)/.test(value) || value.endsWith(".git");
}

export function assertNoUnsafeHomeRefs(raw: string): void {
  if (raw.startsWith("~") || /(?:^|[^A-Za-z0-9_])\$HOME(?:[^A-Za-z0-9_]|$)/.test(raw)) {
    throw new Error("Source must not use shell-style home expansion");
  }
}

export function assertNoCredentialedHttpSource(raw: string): void {
  const protocolMatch = raw.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (!protocolMatch) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Cannot classify source '${raw}'. Use a local path, Git URL, or owner/repo shorthand.`);
  }

  const isSsh = parsed.protocol === "ssh:";

  if (isSsh) {
    // ssh:// allows usernames (e.g. git@, deploy@) but never passwords/tokens
    if (parsed.password) {
      throw new Error("Source must not include URL credential information");
    }
  } else {
    // http/https: reject any username or password
    if (parsed.username || parsed.password) {
      throw new Error("Source must not include URL credential information");
    }
  }

  for (const name of parsed.searchParams.keys()) {
    if (isCredentialQueryParamName(name)) {
      throw new Error("Source must not include URL credential information");
    }
  }
}

const ALLOWED_REMOTE_SCHEMES = new Set(["https:", "http:", "ssh:"]);

/**
 * Parse an IPv4-mapped IPv6 host like "::ffff:127.0.0.1" or "::ffff:a:b:c:d"
 * into its embedded IPv4 dotted-decimal, or return null if not IPv4-mapped.
 */
function extractIPv4Mapped(host: string): string | null {
  // Normalise: strip brackets, lowercase
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const m = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const candidate = m?.[1];
  return candidate === undefined ? null : candidate;
}

/**
 * Check if a single IPv4 octet-group is private/loopback/link-local.
 * Returns an error string if matched, or null if the address appears public.
 */
function classifyIPv4Private(a: number, b: number): string | null {
  if (a === 127) return "loopback"; // 127.0.0.0/8
  if (a === 10) return "private"; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
  if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
  if (a === 169 && b === 254) return "link-local"; // 169.254.0.0/16
  return null;
}

function assertNoNumericHostEncoding(raw: string): void {
  const rawHostMatch = raw.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?(\[[^\]]+\]|[^/:?#]+)/i);
  const rawHost = rawHostMatch?.[1]?.toLowerCase();
  if (!rawHost) {
    return;
  }

  if (/^0x[0-9a-f]+$/i.test(rawHost) || /^\d{8,}$/.test(rawHost) || /^0x[0-9a-f]*\./i.test(rawHost)) {
    throw new Error("Source URL must not use numeric host encodings");
  }
}

function classifyIPv4MappedHextets(hextets: number[]): string | null {
  const isMapped =
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff;
  if (!isMapped) {
    return null;
  }

  const a = ((hextets[6] ?? 0) >> 8) & 0xff;
  const b = (hextets[6] ?? 0) & 0xff;
  return classifyIPv4Private(a, b);
}

/**
 * Parse a full IPv6 address string (without brackets) into 8 hextet integers.
 * Handles :: expansion. Returns null if not a valid IPv6.
 */
function parseIPv6(raw: string): number[] | null {
  const h = raw.toLowerCase();
  let halves: string[];
  if (h.includes("::")) {
    halves = h.split("::");
    if (halves.length !== 2) return null;
  } else {
    halves = [h, ""];
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const total = left.length + right.length;
  if (total > 8) return null;
  const fill = 8 - total;
  const hextets: number[] = [];
  for (const s of left) {
    const v = parseInt(s || "0", 16);
    if (isNaN(v) || v < 0 || v > 0xffff) return null;
    hextets.push(v);
  }
  for (let i = 0; i < fill; i++) hextets.push(0);
  for (const s of right) {
    const v = parseInt(s || "0", 16);
    if (isNaN(v) || v < 0 || v > 0xffff) return null;
    hextets.push(v);
  }
  return hextets.length === 8 ? hextets : null;
}

/**
 * Validate a host string (a URL hostname or an SSH scp-like host) for safe use
 * as a remote source host. Rejects loopback/private/link-local addresses and
 * numeric host encodings. `rawHost` may include surrounding brackets for IPv6
 * literals and any casing; both are normalised internally.
 */
function assertSafeHost(rawHost: string): void {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");

  // Loopback (including IPv6 ::1)
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new Error("Source URL must not target loopback/private hosts");
  }

  // Short-form IPv4 (e.g. 127.1) and groups with leading zeros (e.g.
  // 0177.0.0.1): resolvers may reinterpret these as addresses other than
  // their literal decimal appearance. Only canonical 4-group dotted-decimal
  // without leading zeros may continue to range classification below.
  const dottedGroups = host.split(".");
  if (
    dottedGroups.length >= 2 &&
    dottedGroups.length <= 4 &&
    dottedGroups.every((group) => /^\d+$/.test(group))
  ) {
    const hasLeadingZeroGroup = dottedGroups.some(
      (group) => group.length > 1 && group.startsWith("0"),
    );
    if (dottedGroups.length !== 4 || hasLeadingZeroGroup) {
      throw new Error("Source URL must not use numeric host encodings");
    }
  }

  // IPv4 private / link-local ranges (standard dotted-decimal)
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (classifyIPv4Private(a, b)) {
      throw new Error("Source URL must not target loopback/private hosts");
    }
    return;
  }

  // IPv4-mapped IPv6 addresses: ::ffff:x.x.x.x — extract and check the IPv4 part
  const mappedV4 = extractIPv4Mapped(host);
  if (mappedV4) {
    const m = mappedV4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (classifyIPv4Private(a, b)) {
        throw new Error("Source URL must not target loopback/private hosts");
      }
    }
    return;
  }

  // IPv6 literal: check IPv4-mapped private, ::1, fc00::/7, fe80::/10
  const hextets = parseIPv6(host);
  if (hextets) {
    if (classifyIPv4MappedHextets(hextets)) {
      throw new Error("Source URL must not target loopback/private hosts");
    }
    const firstHextet = hextets[0] ?? 0;
    // fc00::/7 — first 7 bits are 1111110
    if ((firstHextet & 0xfe00) === 0xfc00) {
      throw new Error("Source URL must not target loopback/private hosts");
    }
    // fe80::/10 — first 10 bits are 1111111010
    if ((firstHextet & 0xffc0) === 0xfe80) {
      throw new Error("Source URL must not target loopback/private hosts");
    }
    return;
  }

  // Numeric host encoding bypass rejection:
  // Fail-closed for hosts that look like hex/integer IPv4 but aren't dotted-decimal.
  // Patterns: 0x7f000001, 2130706433, 0x7f.0.0.1
  if (/^0x[0-9a-f]+$/i.test(host)) {
    throw new Error("Source URL must not use numeric host encodings");
  }
  if (/^\d{8,}$/.test(host)) {
    throw new Error("Source URL must not use numeric host encodings");
  }
  if (/^0x[0-9a-f]*\./i.test(host)) {
    throw new Error("Source URL must not use numeric host encodings");
  }
}

/**
 * Validate the host of an SSH scp-like remote ("[user@]host:path"), which is not
 * a parseable URL. Extracts the host portion and applies the same host-safety
 * checks as scheme:// URLs so private/loopback targets cannot bypass filtering.
 * Accepts bracketed IPv6 literals (e.g. git@[::1]:org/repo.git).
 */
function assertSafeScpLikeHost(raw: string): void {
  const m = raw.match(/^(?:[A-Za-z0-9_.-]+@)?(\[[^\]]+\]|[^:@/#?]+):/);
  const rawHost = m?.[1];
  if (rawHost === undefined) {
    return;
  }
  assertSafeHost(rawHost);
}

/**
 * Validate a remote URL for safe use as a source spec.
 * Rejects:
 *  - Unsupported schemes (file:, ftp:, data:, etc.)
 *  - Private/loopback/link-local hosts (localhost, 127/8, ::1, 10/8, 172.16/12, 192.168/16, 169.254/16)
 *  - IPv6 private ranges: IPv4-mapped private, fc00::/7 ULA, fe80::/10 link-local
 *  - Numeric host encodings that bypass IPv4 checks (0x, decimal-only, hex-dotted)
 *  - SSH scp-like forms (git@host:path, user@host:path) with unsafe hosts
 */
export function assertSafeRemoteUrl(raw: string): void {
  const protocolMatch = raw.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (!protocolMatch) {
    // SSH scp-like form like git@github.com:org/repo.git — not a parseable URL,
    // but still validate its host against the same private/loopback rules.
    assertSafeScpLikeHost(raw);
    return;
  }

  assertNoNumericHostEncoding(raw);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Cannot classify source '${raw}'. Use a local path, Git URL, or owner/repo shorthand.`);
  }

  if (!ALLOWED_REMOTE_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Unsupported source URL scheme '${parsed.protocol}'. Use https://, http://, or ssh://.`);
  }

  assertSafeHost(parsed.hostname);
}

/**
 * HTTPS-only remote gate for the upstream verifier's default git
 * materializer. Composes the exact canonical ingestion gates above — home-ref
 * rejection, credential/userinfo rejection, numeric-host-encoding rejection,
 * and loopback/private/link-local host safety — then narrows to `https://`
 * `.git` remotes only. Local paths, file://, ssh://, scp-like remotes, and
 * every non-HTTPS scheme fail closed before any clone or filesystem access.
 * Rendered messages always pass through diagnostics redaction.
 */
export function assertHttpsGitSourceUrl(raw: string): void {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("source url must be a non-empty https:// git url");
  }

  assertNoUnsafeHomeRefs(trimmed);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Covers local paths, scp-like remotes (git@host:path), file paths, and
    // any other non-URL source shape this verifier refuses by design.
    throw new Error(`invalid source url '${redactRemoteForDiagnostics(trimmed)}'`);
  }

  if (url.protocol !== "https:") {
    throw new Error("only https git sources are verifiable");
  }

  try {
    // Same canonical credential gate used by ingestion for https sources:
    // any embedded username/password (including percent-encoded usernames)
    // is rejected before any network activity.
    assertNoCredentialedHttpSource(trimmed);
  } catch {
    throw new Error(
      `https source url must not embed userinfo credentials: ${redactRemoteForDiagnostics(trimmed)}`,
    );
  }

  // Canonical numeric/encoded host bypass rejection (same parser as ingestion).
  assertNoNumericHostEncoding(trimmed);

  if (url.hostname === "") {
    throw new Error(`invalid source url '${redactRemoteForDiagnostics(trimmed)}'`);
  }

  // Canonical host safety: loopback/private/link-local and encoding bypasses.
  assertSafeHost(url.hostname);

  if (!url.pathname.endsWith(".git")) {
    throw new Error("source url must point at a .git repository");
  }
}
