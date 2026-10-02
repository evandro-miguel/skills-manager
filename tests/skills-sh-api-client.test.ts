import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  RestrictedHttpRequest,
  RestrictedHttpResponse,
} from "../scripts/modules/application/ports/external-catalog-provider.ts";
import { SkillsShApiClient } from "../scripts/modules/integrations/skills-sh/client.ts";
import { CatalogIntegrationError } from "../scripts/modules/integrations/skills-sh/errors.ts";
import { FileExternalEvidenceCache } from "../scripts/modules/integrations/skills-sh/evidence-cache.ts";

type ScriptedStep = RestrictedHttpResponse | Error;

class ScriptedHttp {
  readonly calls: RestrictedHttpRequest[] = [];
  readonly #steps: ScriptedStep[];

  constructor(steps: ScriptedStep[]) {
    this.#steps = [...steps];
  }

  async request(request: RestrictedHttpRequest): Promise<RestrictedHttpResponse> {
    this.calls.push(request);
    const step = this.#steps.shift();
    if (step instanceof Error) throw step;
    if (!step) throw new Error("script exhausted");
    return step;
  }
}

function httpOk(bodyText: string): RestrictedHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    bodyText,
  };
}

const SEARCH_PAYLOAD = JSON.stringify({
  results: [
    {
      id: "vercel-labs/skills/find-skills",
      name: "find-skills",
      description: "Discover agent skills.",
      sourceType: "github",
      installs: 3842,
      curated: true,
      tags: [" discovery ", "catalog"],
      audits: [{ provider: "socket", status: "pass", summary: "clean" }],
    },
    {
      id: "someone/else/dup-skill",
      sourceType: "well-known",
      duplicate: true,
    },
    { broken: true },
    {
      id: "owner/repo/weird-source",
      sourceType: "ftp",
    },
  ],
});

function makeClient(
  steps: ScriptedStep[],
  options: Partial<ConstructorParameters<typeof SkillsShApiClient>[0]> = {},
): { client: SkillsShApiClient; http: ScriptedHttp; sleeps: number[] } {
  const http = new ScriptedHttp(steps);
  const sleeps: number[] = [];
  const client = new SkillsShApiClient({
    http,
    tokenProvider: () => "tok-test",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date("2026-08-22T00:00:00Z"),
    ...options,
  });
  return { client, http, sleeps };
}

describe("SkillsShApiClient", () => {
  test("empty-string tokens fail closed like missing ones", async () => {
    const { client, http } = makeClient([], { tokenProvider: () => "" });
    try {
      await client.search("react", 10);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_AUTH_REQUIRED",
      );
    }
    expect(http.calls).toHaveLength(0);
  });

  test("non-numeric Retry-After falls back to the bounded default", async () => {
    const { client, sleeps } = makeClient([
      { status: 429, headers: { "retry-after": "soon-ish" }, bodyText: "" },
      httpOk(SEARCH_PAYLOAD),
    ]);
    const result = await client.search("react", 10);
    expect(result.candidates).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  test("audit digests are sanitized and length-capped", async () => {
    const payload = JSON.stringify({
      results: [
        {
          id: "o/r/digest-skill",
          sourceType: "github",
          audits: [
            {
              provider: "socket",
              status: "pass",
              contentDigest: "a\u0000b\n c ".padEnd(500, "x"),
            },
          ],
        },
      ],
    });
    const { client } = makeClient([httpOk(payload)]);
    const result = await client.search("digest", 10);
    const digest = result.candidates[0]?.evidence?.audits?.[0]?.contentDigest;
    expect(digest).toBeDefined();
    expect(digest).not.toMatch(/[\u0000-\u001f]/);
    expect(digest?.length).toBeLessThanOrEqual(400);
  });

  test("requires a token before touching the network", async () => {
    const { client, http } = makeClient([], {
      tokenProvider: () => undefined,
    });
    try {
      await client.search("react", 10);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_AUTH_REQUIRED",
      );
      expect((error as CatalogIntegrationError).message).toContain(
        "VERCEL_OIDC_TOKEN",
      );
    }
    expect(http.calls).toHaveLength(0);
  });

  test("blank queries short-circuit to an empty result without network", async () => {
    const { client, http } = makeClient([]);
    const result = await client.search("   \u0007 ", 10);
    expect(result.candidates).toEqual([]);
    expect(http.calls).toHaveLength(0);
  });

  test("validates, sanitizes, and maps search results", async () => {
    const { client, http } = makeClient([httpOk(SEARCH_PAYLOAD)]);
    const result = await client.search("react native", 25);

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe(
      "https://skills.sh/api/v1/search?q=react%20native&limit=25",
    );
    expect(http.calls[0]?.headers?.authorization).toBe("Bearer tok-test");

    expect(result.candidates).toHaveLength(2); // malformed + unsupported skipped
    const first = result.candidates[0];
    expect(first?.identity.canonicalId).toBe(
      "skills-sh:vercel-labs/skills/find-skills",
    );
    expect(first?.identity.origin).toBe("external");
    expect(first?.display.description).toBe("Discover agent skills.");
    // Control characters stripped and whitespace collapsed in tags.
    expect(first?.display.tags).toEqual(["discovery", "catalog"]);
    expect(first?.evidence?.installs).toBe(3842);
    expect(first?.evidence?.curated).toBe(true);
    expect(first?.evidence?.audits?.[0]?.bindingState).toBe(
      "EXTERNAL_AUDIT_UNBOUND",
    );

    const second = result.candidates[1];
    expect(second?.source.sourceType).toBe("well-known");
    expect(second?.evidence?.duplicate).toBe(true);
  });

  test("caches successful searches and serves subsequent calls offline", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-cache-"));
    const cache = new FileExternalEvidenceCache({
      dir: cacheDir,
      ttlSeconds: 3600,
      now: () => 1_000_000,
    });
    const { client, http } = makeClient([httpOk(SEARCH_PAYLOAD)], { cache });

    await client.search("react", 10);
    const second = await client.search("react", 10);

    expect(http.calls).toHaveLength(1);
    expect(second.candidates).toHaveLength(2);
  });

  test("expired cache entries fall back to the network", async () => {
    let clock = 1_000_000;
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-cache-"));
    const cache = new FileExternalEvidenceCache({
      dir: cacheDir,
      ttlSeconds: 60,
      now: () => clock,
    });
    const first = makeClient([httpOk(SEARCH_PAYLOAD)], {
      cache,
      cacheTtlSeconds: 60,
    });
    await first.client.search("react", 10);

    clock += 61_000;
    const second = makeClient([httpOk(SEARCH_PAYLOAD)], {
      cache,
      cacheTtlSeconds: 60,
    });
    await second.client.search("react", 10);
    expect(second.http.calls).toHaveLength(1);
  });

  test("corrupt cache entries degrade to network misses", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-cache-"));
    const cache = new FileExternalEvidenceCache({ dir: cacheDir });
    await cache.set("k", '"valid"');
    const [storedFile] = fs.readdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, storedFile ?? ""), "{not json");
    expect(await cache.get("k")).toBeNull();
  });

  test("maps 401 to CATALOG_AUTH_REQUIRED without retrying", async () => {
    const { client, http, sleeps } = makeClient([
      { status: 401, headers: {}, bodyText: "" },
    ]);
    try {
      await client.search("react", 10);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_AUTH_REQUIRED",
      );
    }
    expect(http.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("retries 429 once honoring bounded Retry-After, then succeeds", async () => {
    const { client, http, sleeps } = makeClient([
      { status: 429, headers: { "retry-after": "3" }, bodyText: "" },
      httpOk(SEARCH_PAYLOAD),
    ]);
    const result = await client.search("react", 10);
    expect(result.candidates).toHaveLength(2);
    expect(http.calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  test("exhausted retries on 429 map to CATALOG_RATE_LIMITED", async () => {
    const { client, sleeps } = makeClient([
      { status: 429, headers: {}, bodyText: "" },
      { status: 429, headers: {}, bodyText: "" },
    ]);
    try {
      await client.search("react", 10);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_RATE_LIMITED",
      );
    }
    expect(sleeps).toEqual([1000]); // default bounded retry-after
  });

  test("503 is retryable and exhausts into CATALOG_UNAVAILABLE", async () => {
    const { client, http } = makeClient([
      { status: 503, headers: {}, bodyText: "" },
      { status: 503, headers: {}, bodyText: "" },
    ]);
    try {
      await client.search("react", 10);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_UNAVAILABLE",
      );
    }
    expect(http.calls).toHaveLength(2);
  });

  test("unexpected statuses fail immediately without retry", async () => {
    const { client, http, sleeps } = makeClient([
      { status: 500, headers: {}, bodyText: "boom" },
    ]);
    try {
      await client.search("react", 10);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_UNAVAILABLE",
      );
      expect((error as CatalogIntegrationError).message).toContain("500");
    }
    expect(http.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("invalid JSON payloads surface as CATALOG_RESPONSE_INVALID", async () => {
    const { client } = makeClient([httpOk("{ nope")]);
    try {
      await client.search("react", 10);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_RESPONSE_INVALID",
      );
    }
  });

  test("truncates oversized result sets to the requested limit", async () => {
    const many = {
      results: Array.from({ length: 30 }, (_, index) => ({
        id: `o/r/skill-${index}`,
        sourceType: "github",
      })),
    };
    const { client } = makeClient([httpOk(JSON.stringify(many))]);
    const result = await client.search("react", 5);
    expect(result.candidates).toHaveLength(5);
  });
});
