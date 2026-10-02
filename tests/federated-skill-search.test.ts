import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FEDERATED_SEARCH_LIMIT,
  federatedSkillSearch,
  MAX_FEDERATED_SEARCH_LIMIT,
  type FederatedLocalSkill,
} from "../scripts/modules/application/services/federated-skill-search.ts";
import type { FederatedSkillCandidate } from "../scripts/modules/application/ports/external-catalog-provider.ts";
import { CatalogIntegrationError } from "../scripts/modules/integrations/skills-sh/errors.ts";
import { FakeCatalogProvider } from "./helpers/fake-catalog-provider.ts";

const context = {
  clock: () => new Date(0),
} as const;

function local(name: string): FederatedLocalSkill {
  return { name, description: `${name} description`, tags: ["tag"] };
}

function externalCandidate(
  canonicalId: string,
  name = canonicalId,
): FederatedSkillCandidate {
  return {
    identity: { origin: "external", name, canonicalId },
    display: { name },
    source: { provider: "fake", externalId: canonicalId },
  };
}

describe("federatedSkillSearch", () => {
  test("returns local candidates first in caller order with no providers", async () => {
    const result = await federatedSkillSearch({
      localSkills: [local("alpha"), local("beta")],
      context,
    });
    expect(result.localCount).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.identity.canonicalId)).toEqual([
      "local:alpha",
      "local:beta",
    ]);
    expect(result.candidates[0]?.identity.origin).toBe("local");
    expect(result.candidates[0]?.source.provider).toBe("local");
    expect(result.candidates[0]?.display.description).toBe("alpha description");
  });

  test("merges provider results after locals and sorts each provider deterministically", async () => {
    const first = new FakeCatalogProvider({
      id: "first",
      candidates: [
        externalCandidate("first:zulu"),
        externalCandidate("first:alpha"),
      ],
    });
    const second = new FakeCatalogProvider({
      id: "second",
      candidates: [externalCandidate("second:mike")],
    });
    const result = await federatedSkillSearch({
      localSkills: [local("local-skill")],
      providers: [first, second],
      context,
      queries: ["react"],
    });
    expect(first.searchCalls).toEqual([{ query: "react", limit: 25 }]);
    expect(result.candidates.map((candidate) => candidate.identity.canonicalId)).toEqual([
      "local:local-skill",
      "first:alpha",
      "first:zulu",
      "second:mike",
    ]);
    expect(result.warnings).toEqual([]);
  });

  test("flags later duplicates without dropping them", async () => {
    const provider = new FakeCatalogProvider({
      candidates: [
        externalCandidate("dup:id"),
        externalCandidate("unique:id"),
        externalCandidate("dup:id"),
      ],
    });
    const result = await federatedSkillSearch({
      providers: [provider],
      context,
    });
    const dups = result.candidates.filter(
      (candidate) => candidate.identity.canonicalId === "dup:id",
    );
    expect(dups).toHaveLength(2);
    expect(dups[0]?.evidence?.duplicate).toBeUndefined();
    expect(dups[1]?.evidence?.duplicate).toBe(true);
    const unique = result.candidates.find(
      (candidate) => candidate.identity.canonicalId === "unique:id",
    );
    expect(unique?.evidence).toBeUndefined();
  });

  test("preserves existing evidence when flagging duplicates", async () => {
    const provider = new FakeCatalogProvider({
      candidates: [
        {
          identity: { origin: "external", name: "x", canonicalId: "x:id" },
          display: { name: "x" },
          source: { provider: "fake" },
          evidence: { installs: 42, curated: true },
        },
        {
          identity: { origin: "external", name: "y", canonicalId: "x:id" },
          display: { name: "y" },
          source: { provider: "fake" },
        },
      ],
    });
    const result = await federatedSkillSearch({
      providers: [provider],
      context,
    });
    const dups = result.candidates.filter((candidate) => candidate.identity.canonicalId === "x:id");
    expect(dups[0]?.evidence?.installs).toBe(42);
    expect(dups[0]?.evidence?.duplicate).toBeUndefined();
    expect(dups[1]?.evidence?.duplicate).toBe(true);
  });

  test("degrades provider failures to warnings and keeps other results", async () => {
    const failing = new FakeCatalogProvider({
      id: "skills-sh",
      failure: new CatalogIntegrationError("CATALOG_RATE_LIMITED", "slow down"),
    });
    const healthy = new FakeCatalogProvider({
      id: "healthy",
      candidates: [externalCandidate("healthy:one")],
    });
    const result = await federatedSkillSearch({
      localSkills: [local("keep")],
      providers: [failing, healthy],
      context,
    });
    expect(result.warnings).toEqual(["skills-sh: CATALOG_RATE_LIMITED"]);
    expect(result.candidates.map((candidate) => candidate.identity.canonicalId)).toEqual([
      "local:keep",
      "healthy:one",
    ]);
  });

  test("degrades generic provider failures to sanitized warnings", async () => {
    const failing = new FakeCatalogProvider({
      id: "noisy",
      failure: new Error("socket hang up\u001b[31mDANGER next"),
    });
    const result = await federatedSkillSearch({
      providers: [failing],
      context,
    });
    // Control characters collapse to spaces so warnings stay single-line.
    expect(result.warnings).toEqual(["noisy: socket hang up [31mDANGER next"]);
  });

  test("works with no locals and no providers", async () => {
    const result = await federatedSkillSearch({ context });
    expect(result.localCount).toBe(0);
    expect(result.candidates).toHaveLength(0);
    expect(result.warnings).toEqual([]);
  });

  test("skips providers that do not advertise the search capability", async () => {
    const resolverOnly = new FakeCatalogProvider({
      id: "resolver-only",
      capabilities: ["resolve"],
      candidates: [externalCandidate("never:seen")],
    });
    const result = await federatedSkillSearch({
      providers: [resolverOnly],
      context,
    });
    expect(resolverOnly.searchCalls).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
  });

  test("clamps the limit and applies it to providers and output", async () => {
    const provider = new FakeCatalogProvider({
      candidates: Array.from({ length: 12 }, (_, index) =>
        externalCandidate(`id:${String(index).padStart(2, "0")}`),
      ),
    });
    const result = await federatedSkillSearch({
      providers: [provider],
      context,
      limit: MAX_FEDERATED_SEARCH_LIMIT + 50,
    });
    expect(provider.searchCalls[0]?.limit).toBe(MAX_FEDERATED_SEARCH_LIMIT);
    // Output truncation uses the same clamped limit; the fixture has 12
    // candidates so all of them survive the cap.
    expect(result.candidates).toHaveLength(12);
  });

  test("flags duplicates across different providers", async () => {
    const first = new FakeCatalogProvider({
      id: "first",
      candidates: [externalCandidate("shared:id", "from-first")],
    });
    const second = new FakeCatalogProvider({
      id: "second",
      candidates: [externalCandidate("shared:id", "from-second")],
    });
    const result = await federatedSkillSearch({
      providers: [first, second],
      context,
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.display.name).toBe("from-first");
    expect(result.candidates[0]?.evidence?.duplicate).toBeUndefined();
    expect(result.candidates[1]?.display.name).toBe("from-second");
    expect(result.candidates[1]?.evidence?.duplicate).toBe(true);
  });

  test("truncates output when candidates exceed an explicit limit", async () => {
    const provider = new FakeCatalogProvider({
      candidates: Array.from({ length: 8 }, (_, index) =>
        externalCandidate(`id:${String(index).padStart(2, "0")}`),
      ),
    });
    const result = await federatedSkillSearch({
      providers: [provider],
      context,
      limit: 5,
    });
    expect(provider.searchCalls[0]?.limit).toBe(5);
    expect(result.candidates).toHaveLength(5);
  });

  test("clamps zero and non-finite limits", async () => {
    const zero = await federatedSkillSearch({
      localSkills: [local("only")],
      context,
      limit: 0,
    });
    expect(zero.candidates).toHaveLength(1);

    const negative = new FakeCatalogProvider({
      candidates: [externalCandidate("neg:one")],
    });
    const negResult = await federatedSkillSearch({
      providers: [negative],
      context,
      limit: -5,
    });
    expect(negative.searchCalls[0]?.limit).toBe(1);
    expect(negResult.candidates).toHaveLength(1);

    const infinite = new FakeCatalogProvider({});
    const infResult = await federatedSkillSearch({
      providers: [infinite],
      context,
      limit: Number.POSITIVE_INFINITY,
    });
    expect(infinite.searchCalls[0]?.limit).toBe(DEFAULT_FEDERATED_SEARCH_LIMIT);
    expect(infResult.candidates).toHaveLength(0);
  });

  test("joins multiple query terms into one provider query", async () => {
    const provider = new FakeCatalogProvider({});
    await federatedSkillSearch({
      providers: [provider],
      context,
      queries: ["  react ", "native", ""],
    });
    expect(provider.searchCalls).toEqual([{ query: "react native", limit: 25 }]);
  });
});
