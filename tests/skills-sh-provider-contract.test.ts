import { describe, expect, test } from "bun:test";
import type { ExternalCatalogProvider } from "../scripts/modules/application/ports/external-catalog-provider.ts";
import { CatalogIntegrationError } from "../scripts/modules/integrations/skills-sh/errors.ts";
import {
  parseSkillsShReference,
} from "../scripts/modules/integrations/skills-sh/reference-parser.ts";
import { SkillsShApiClient } from "../scripts/modules/integrations/skills-sh/client.ts";
import {
  SKILLS_SH_PROVIDER_ID,
  skillsShReferenceToManifestHint,
  SkillsShCatalogProvider,
} from "../scripts/modules/integrations/skills-sh/provider.ts";
import { FakeCatalogProvider } from "./helpers/fake-catalog-provider.ts";

const context = {
  clock: () => new Date(0),
} as const;

describe("FakeCatalogProvider", () => {
  test("satisfies the ExternalCatalogProvider port contract", () => {
    const fake: ExternalCatalogProvider = new FakeCatalogProvider({
      id: "fake-a",
      candidates: [],
    });
    expect(fake.id).toBe("fake-a");
    expect(fake.capabilities).toEqual(["search"]);
  });

  test("returns configured candidates and records search calls", async () => {
    const provider = new FakeCatalogProvider({
      candidates: [
        {
          identity: {
            origin: "external",
            name: "alpha",
            canonicalId: "skills-sh:owner/repo/alpha",
          },
          display: { name: "alpha" },
          source: { provider: "fake" },
        },
      ],
    });
    const result = await provider.search({ query: "react", limit: 10 }, context);
    expect(result.candidates).toHaveLength(1);
    expect(provider.searchCalls).toEqual([{ query: "react", limit: 10 }]);
  });

  test("throws the configured failure", async () => {
    const provider = new FakeCatalogProvider({
      failure: new Error("boom"),
    });
    expect(provider.search({ query: "x", limit: 5 }, context)).rejects.toThrow(
      "boom",
    );
  });
});

describe("SkillsShCatalogProvider", () => {
  test("url-only transport advertises resolve-only capabilities", () => {
    const provider = new SkillsShCatalogProvider();
    expect(provider.id).toBe(SKILLS_SH_PROVIDER_ID);
    expect(provider.id).toBe("skills-sh");
    expect(provider.capabilities).toEqual(["resolve"]);
    // Audit-evidence surface arrives with PR7.
    const asProvider: ExternalCatalogProvider = provider;
    expect(asProvider.inspect).toBeUndefined();
  });

  test("url-only search fails closed with CATALOG_CAPABILITY_MISSING", async () => {
    const provider = new SkillsShCatalogProvider();
    try {
      await provider.search({ query: "react", limit: 5 }, context);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogIntegrationError);
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_CAPABILITY_MISSING",
      );
    }
  });

  test("official-v1 transport advertises search and delegates with credentials", async () => {
    const payload = {
      results: [
        {
          id: "vercel-labs/skills/find-skills",
          name: "find-skills",
          description: "Discover agent skills.",
          sourceType: "github",
          installs: 3842,
          curated: true,
          audits: [{ provider: "socket", status: "pass", summary: "clean" }],
        },
      ],
    };

    class StubHttp {
      readonly calls: Array<{ url: string; headers?: Record<string, string> }> = [];
      async request(request: {
        url: string;
        headers?: Record<string, string>;
      }) {
        this.calls.push(request);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          bodyText: JSON.stringify(payload),
        };
      }
    }

    const stub = new StubHttp();
    const provider = new SkillsShCatalogProvider({
      mode: "official-v1",
      http: stub as unknown as ConstructorParameters<
        typeof SkillsShApiClient
      >[0]["http"],
      tokenProvider: () => "tok-test",
    });
    expect(provider.capabilities).toEqual(["resolve", "search"]);

    const result = await provider.search({ query: "react native", limit: 10 }, context);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate?.identity.canonicalId).toBe(
      "skills-sh:vercel-labs/skills/find-skills",
    );
    expect(candidate?.evidence?.installs).toBe(3842);
    expect(candidate?.evidence?.curated).toBe(true);
    expect(candidate?.evidence?.audits?.[0]?.bindingState).toBe(
      "EXTERNAL_AUDIT_UNBOUND",
    );
  });

  test("resolves references to canonical GitHub source hints without network", async () => {
    const provider = new SkillsShCatalogProvider();
    const resolution = await provider.resolve(
      { providerId: "skills-sh", externalId: "vercel-labs/skills/find-skills" },
      context,
    );
    expect(resolution.sourceType).toBe("github");
    expect(resolution.canonicalSourceHint).toBe(
      "https://github.com/vercel-labs/skills.git",
    );
    expect(resolution.installable).toBe(true);
    expect(resolution.reasonCode).toBeUndefined();
  });

  test("rejects foreign provider references", async () => {
    const provider = new SkillsShCatalogProvider();
    try {
      await provider.resolve(
        { providerId: "other-catalog", externalId: "owner/repo" },
        context,
      );
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogIntegrationError);
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_CAPABILITY_MISSING",
      );
    }
  });

  test("resolves deep skill path hints and enforces the segment boundary", async () => {
    const provider = new SkillsShCatalogProvider();
    const deep = await provider.resolve(
      {
        providerId: "skills-sh",
        externalId: "owner/repo/docs/guides/setup/tool",
      },
      context,
    );
    expect(deep.canonicalSourceHint).toBe("https://github.com/owner/repo.git");

    const overDeep = Array.from({ length: 7 }, (_, index) => `s${index}`);
    try {
      await provider.resolve(
        { providerId: "skills-sh", externalId: `owner/repo/${overDeep.join("/")}` },
        context,
      );
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogIntegrationError);
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_SOURCE_UNRESOLVED",
      );
    }
  });

  test("propagates parser failures as catalog errors", async () => {
    const provider = new SkillsShCatalogProvider();
    try {
      await provider.resolve(
        { providerId: "skills-sh", externalId: "not-a-reference" },
        context,
      );
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogIntegrationError);
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_SOURCE_UNRESOLVED",
      );
    }
  });
});

describe("skillsShReferenceToManifestHint", () => {
  test("maps a reference onto skill-sys.sources.json source fields", () => {
    const parsed = parseSkillsShReference(
      "skills.sh:vercel-labs/skills/find-skills",
    );
    const hint = skillsShReferenceToManifestHint(parsed);
    expect(hint.source).toBe("https://github.com/vercel-labs/skills.git");
    expect(hint.skillPathHint).toEqual(["find-skills"]);
  });

  test("omits the hint when the reference has no skill path", () => {
    const parsed = parseSkillsShReference("skills.sh:owner/repo");
    const hint = skillsShReferenceToManifestHint(parsed);
    expect(hint.source).toBe("https://github.com/owner/repo.git");
    expect(Object.hasOwn(hint, "skillPathHint")).toBe(false);
  });
});
