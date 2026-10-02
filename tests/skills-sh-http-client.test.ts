import { describe, expect, test } from "bun:test";
import { CatalogIntegrationError } from "../scripts/modules/integrations/skills-sh/errors.ts";
import {
  FetchRestrictedHttpClient,
  type FetchLike,
} from "../scripts/modules/integrations/skills-sh/http-client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientWith(
  fetchImpl: FetchLike,
  overrides: Partial<ConstructorParameters<typeof FetchRestrictedHttpClient>[0]> = {},
): FetchRestrictedHttpClient {
  return new FetchRestrictedHttpClient({
    allowedHosts: ["skills.sh", "mirror.example.test"],
    fetchImpl,
    ...overrides,
  });
}

describe("FetchRestrictedHttpClient", () => {
  const okFetch: FetchLike = async () => jsonResponse({ ok: true });

  test("enforces HTTPS-only transport", async () => {
    const client = clientWith(okFetch);
    expect(client.request({ url: "http://skills.sh/api" })).rejects.toThrow(
      "HTTPS is required",
    );
  });

  test("enforces the exact host allowlist", async () => {
    const client = clientWith(okFetch);
    expect(
      client.request({ url: "https://evil.example.test/api" }),
    ).rejects.toThrow("not allowlisted");
  });

  test("rejects credentials and explicit ports in URLs", async () => {
    const client = clientWith(okFetch);
    expect(
      client.request({ url: "https://user:pass@skills.sh/api" }),
    ).rejects.toThrow("credentials");
    expect(client.request({ url: "https://skills.sh:8443/api" })).rejects.toThrow(
      "ports",
    );
  });

  test("allows GET only", async () => {
    const client = clientWith(okFetch);
    expect(
      client.request({ url: "https://skills.sh/api", method: "POST" as never }),
    ).rejects.toThrow("GET");
  });

  test("returns status, flattened headers, and body text", async () => {
    const client = clientWith(okFetch);
    const response = await client.request({ url: "https://skills.sh/api" });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.bodyText).toBe('{"ok":true}');
  });

  test("times out hung requests as CATALOG_UNAVAILABLE", async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("no signal"));
          return;
        }
        signal.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    const client = clientWith(hanging, { timeoutMs: 1000 });
    try {
      await client.request({ url: "https://skills.sh/slow" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogIntegrationError);
      expect((error as CatalogIntegrationError).code).toBe("CATALOG_UNAVAILABLE");
      expect((error as CatalogIntegrationError).message).toContain("timed out");
    }
  });

  test("caps responses declaring oversized content-length", async () => {
    const hugeHeaders: FetchLike = async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(10 * 1024 * 1024) },
      });
    const client = clientWith(hugeHeaders);
    try {
      await client.request({ url: "https://skills.sh/big" });
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_RESPONSE_INVALID",
      );
    }
  });

  test("caps streamed bodies that exceed maxBodyBytes mid-read", async () => {
    let streamed: ReadableStream<Uint8Array> | undefined;
    const streamOnce: FetchLike = async () => {
      streamed ??= new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("a".repeat(64)));
        },
      });
      return new Response(streamed, { status: 200 });
    };
    const client = clientWith(streamOnce, { maxBodyBytes: 32 });
    try {
      await client.request({ url: "https://skills.sh/stream" });
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_RESPONSE_INVALID",
      );
      expect((error as CatalogIntegrationError).message).toContain("exceeds limit");
    }
  });

  test("follows same-host redirects with revalidation", async () => {
    const calls: string[] = [];
    const scripted: FetchLike = async (input) => {
      calls.push(input);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "/api/v2/search?q=x" },
        });
      }
      return jsonResponse({ moved: true });
    };
    const client = clientWith(scripted);
    const response = await client.request({
      url: "https://skills.sh/api/v1/search?q=x",
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe("https://skills.sh/api/v2/search?q=x");
  });

  test("strips Authorization when redirecting across allowlisted hosts", async () => {
    const seenHeaders: Array<Record<string, string> | undefined> = [];
    const scripted: FetchLike = async (input, init) => {
      seenHeaders.push(init?.headers);
      if (seenHeaders.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://mirror.example.test/api" },
        });
      }
      return jsonResponse({ ok: true });
    };
    const client = clientWith(scripted);
    await client.request({
      url: "https://skills.sh/api",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(seenHeaders[0]?.authorization).toBe("Bearer secret-token");
    expect(seenHeaders[1]?.authorization).toBeUndefined();
  });

  test("keeps Authorization on same-host redirects", async () => {
    const seenHeaders: Array<Record<string, string> | undefined> = [];
    const scripted: FetchLike = async (input, init) => {
      seenHeaders.push(init?.headers);
      if (seenHeaders.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "/api/v2/search?q=x" },
        });
      }
      return jsonResponse({ ok: true });
    };
    const client = clientWith(scripted);
    await client.request({
      url: "https://skills.sh/api/v1/search",
      headers: { authorization: "Bearer keep-me" },
    });
    expect(seenHeaders[1]?.authorization).toBe("Bearer keep-me");
  });

  test("refuses redirects to non-allowlisted hosts", async () => {
    const scripted: FetchLike = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.test/catch" },
      });
    const client = clientWith(scripted);
    expect(
      client.request({ url: "https://skills.sh/api", headers: {} }),
    ).rejects.toThrow("not allowlisted");
  });

  test("fails closed after too many redirect hops", async () => {
    const loop: FetchLike = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "/next-hop" },
      });
    const client = clientWith(loop, { maxRedirects: 1 });
    try {
      await client.request({ url: "https://skills.sh/start" });
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_RESPONSE_INVALID",
      );
      expect((error as CatalogIntegrationError).message).toContain(
        "too many redirects",
      );
    }
  });
});
