/**
 * Hardened HTTP transport implementing the `RestrictedHttpClient` port.
 *
 * Guarantees (docs/specs/external-catalog-provider.md):
 * - HTTPS-only, exact-host allowlist (lowercase hostnames).
 * - No credentials or explicit ports in URLs.
 * - Redirects are followed manually and revalidated against the same rules;
 *   the Authorization header is stripped on any host change.
 * - Per-request timeout enforced via abort.
 * - Response bodies are size-capped while streaming; oversized payloads fail
 *   closed instead of being truncated silently.
 *
 * Configuration mistakes throw plain errors (caller bug); runtime network
 * failures surface as `CATALOG_UNAVAILABLE`; policy violations on responses
 * surface as `CATALOG_RESPONSE_INVALID`.
 */

import type {
  RestrictedHttpClient,
  RestrictedHttpRequest,
  RestrictedHttpResponse,
} from "../../application/ports/external-catalog-provider.ts";
import { CatalogIntegrationError } from "./errors.ts";

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    redirect?: "manual";
    signal?: AbortSignal;
  },
) => Promise<Response>;

export type FetchRestrictedHttpClientOptions = Readonly<{
  /** Exact allowed hostnames (lowercase). */
  allowedHosts: readonly string[];
  /** Default per-request timeout in ms (clamped to 1000..10000). */
  timeoutMs?: number;
  /** Maximum response body size in bytes (default 256 KiB). */
  maxBodyBytes?: number;
  /** Maximum redirect hops (default 2). */
  maxRedirects?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
}>;

const DEFAULT_TIMEOUT_MS = 4000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_REDIRECTS = 2;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function clampTimeout(ms: number | undefined): number {
  const value = ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function assertAllowedUrl(
  rawUrl: string,
  allowedHosts?: ReadonlySet<string>,
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`restricted http client: malformed URL '${rawUrl}'`);
  }
  if (url.protocol !== "https:") {
    throw new Error("restricted http client: HTTPS is required");
  }
  if (
    allowedHosts !== undefined &&
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw new Error(
      `restricted http client: host '${url.hostname}' is not allowlisted`,
    );
  }
  if (url.username || url.password) {
    throw new Error("restricted http client: credentials are not allowed");
  }
  if (url.port && url.port !== "443") {
    throw new Error("restricted http client: explicit ports are not allowed");
  }
  return url;
}

function flattenHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value;
  });
  return output;
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maxBytes
  ) {
    throw new CatalogIntegrationError(
      "CATALOG_RESPONSE_INVALID",
      `response body exceeds limit (${declaredLength} > ${maxBytes} bytes)`,
    );
  }

  if (!response.body) {
    return "";
  }

  const decoder = new TextDecoder();
  let received = 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          void reader.cancel().catch(() => {});
          throw new CatalogIntegrationError(
            "CATALOG_RESPONSE_INVALID",
            `response body exceeds limit (> ${maxBytes} bytes)`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(merged);
}

export class FetchRestrictedHttpClient implements RestrictedHttpClient {
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #timeoutMs: number;
  readonly #maxBodyBytes: number;
  readonly #maxRedirects: number;
  readonly #fetchImpl: FetchLike;

  constructor(options: FetchRestrictedHttpClientOptions) {
    this.#allowedHosts = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
    this.#timeoutMs = clampTimeout(options.timeoutMs);
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.#maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(request: RestrictedHttpRequest): Promise<RestrictedHttpResponse> {
    if (request.method !== undefined && request.method !== "GET") {
      throw new Error("restricted http client: only GET requests are allowed");
    }
    const startUrl = assertAllowedUrl(request.url, this.#allowedHosts);

    let currentUrl = startUrl;
    let headers: Record<string, string> = { ...(request.headers ?? {}) };

    for (let hop = 0; ; hop += 1) {
      const timeoutMs = clampTimeout(request.timeoutMs ?? this.#timeoutMs);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("timeout")),
        timeoutMs,
      );

      let response: Response;
      try {
        response = await this.#fetchImpl(currentUrl.toString(), {
          method: "GET",
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const aborted =
          controller.signal.aborted ||
          (error instanceof Error && error.name === "AbortError");
        const reason = aborted
          ? `request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
        throw new CatalogIntegrationError(
          "CATALOG_UNAVAILABLE",
          `request to '${currentUrl.host}${currentUrl.pathname}' failed: ${reason}`,
        );
      }
      clearTimeout(timer);

      if (!REDIRECT_STATUSES.has(response.status)) {
        const bodyText = await readBodyCapped(response, this.#maxBodyBytes);
        return {
          status: response.status,
          headers: flattenHeaders(response.headers),
          bodyText,
        };
      }

      if (hop >= this.#maxRedirects) {
        throw new CatalogIntegrationError(
          "CATALOG_RESPONSE_INVALID",
          `too many redirects (>${this.#maxRedirects})`,
        );
      }

      const location = response.headers.get("location");
      if (!location) {
        throw new CatalogIntegrationError(
          "CATALOG_RESPONSE_INVALID",
          `redirect status ${response.status} without Location header`,
        );
      }

      const nextUrl = assertAllowedUrl(
        new URL(location, currentUrl).toString(),
        this.#allowedHosts,
      );
      if (nextUrl.host !== currentUrl.host) {
        // Never forward Authorization across hosts, even between allowlisted ones.
        headers = { ...headers };
        delete headers.authorization;
      }
      currentUrl = nextUrl;
    }
  }
}
