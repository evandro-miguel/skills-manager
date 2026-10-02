import { describe, expect, test } from "bun:test";
import { CatalogIntegrationError } from "../scripts/modules/integrations/skills-sh/errors.ts";
import {
  parseSkillsShExternalId,
  parseSkillsShReference,
} from "../scripts/modules/integrations/skills-sh/reference-parser.ts";

describe("parseSkillsShReference", () => {
  test("parses the prefixed owner/repo form", () => {
    const parsed = parseSkillsShReference("skills.sh:vercel-labs/skills");
    expect(parsed.owner).toBe("vercel-labs");
    expect(parsed.repo).toBe("skills");
    expect(parsed.skillPathHint).toBeUndefined();
    expect(parsed.sourceType).toBe("github");
    expect(parsed.canonicalGitUrl).toBe(
      "https://github.com/vercel-labs/skills.git",
    );
    expect(parsed.externalId).toBe("vercel-labs/skills");
  });

  test("parses the prefixed form with a skill path hint", () => {
    const parsed = parseSkillsShReference(
      "skills.sh:vercel-labs/skills/find-skills",
    );
    expect(parsed.repo).toBe("skills");
    expect(parsed.skillPathHint).toEqual(["find-skills"]);
    expect(parsed.canonicalGitUrl).toBe(
      "https://github.com/vercel-labs/skills.git",
    );
    expect(parsed.externalId).toBe("vercel-labs/skills/find-skills");
  });

  test("preserves deep skill path hints in order", () => {
    const parsed = parseSkillsShReference("skills.sh:owner/repo/a/b/c");
    expect(parsed.skillPathHint).toEqual(["a", "b", "c"]);
    expect(parsed.externalId).toBe("owner/repo/a/b/c");
  });

  test("parses the https catalog URL form", () => {
    const parsed = parseSkillsShReference(
      "https://skills.sh/anthropics/skills/frontend-design",
    );
    expect(parsed.owner).toBe("anthropics");
    expect(parsed.repo).toBe("skills");
    expect(parsed.skillPathHint).toEqual(["frontend-design"]);
    expect(parsed.canonicalGitUrl).toBe(
      "https://github.com/anthropics/skills.git",
    );
    expect(parsed.externalId).toBe("anthropics/skills/frontend-design");
  });

  test("trims surrounding whitespace and trailing slashes", () => {
    const prefixed = parseSkillsShReference("  skills.sh:owner/repo/  ");
    expect(prefixed.owner).toBe("owner");
    expect(prefixed.repo).toBe("repo");
    expect(prefixed.skillPathHint).toBeUndefined();

    const url = parseSkillsShReference("https://skills.sh/owner/repo/");
    expect(url.externalId).toBe("owner/repo");
  });

  test("rejects malformed references", () => {
    const malformed = [
      "",
      "   ",
      "skills.sh:",
      "skills.sh:owner",
      "skills.sh:/repo",
      "skills.sh:owner/",
      "skills.sh:owner//repo",
      "skills.sh:../repo",
      "skills.sh:owner/../repo",
      "skills.sh:./repo",
      "skills.sh:o wner/repo",
      "skills.sh:owner/re po",
      "skills.sh:owner$/repo",
    ];
    for (const input of malformed) {
      try {
        parseSkillsShReference(input);
        throw new Error(`expected rejection for ${JSON.stringify(input)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CatalogIntegrationError);
        expect((error as CatalogIntegrationError).code).toBe(
          "CATALOG_SOURCE_UNRESOLVED",
        );
      }
    }
  });

  test("rejects references over the maximum length", () => {
    const long = `skills.sh:${"o".repeat(300)}/r`;
    try {
      parseSkillsShReference(long);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogIntegrationError);
      expect((error as CatalogIntegrationError).message).toContain(
        "maximum length",
      );
    }
  });

  test("rejects references with too many path segments", () => {
    const nineSegments = Array.from({ length: 9 }, (_, index) => `s${index}`);
    const long = `skills.sh:${nineSegments.join("/")}`;
    try {
      parseSkillsShReference(long);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogIntegrationError);
      expect((error as CatalogIntegrationError).message).toContain(
        "<owner>/<repo>",
      );
    }
  });

  test("rejects non-https and foreign-host URL forms", () => {
    for (const input of [
      "http://skills.sh/owner/repo",
      "https://example.com/owner/repo",
      "https://skills.sh.evil.test/owner/repo",
      "git@github.com:owner/repo.git",
      "github:owner/repo",
    ]) {
      try {
        parseSkillsShReference(input);
        throw new Error(`expected rejection for ${input}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CatalogIntegrationError);
        expect((error as CatalogIntegrationError).code).toBe(
          "CATALOG_SOURCE_UNRESOLVED",
        );
      }
    }
  });

  test("rejects credentials, ports, query strings, and fragments in URLs", () => {
    for (const input of [
      "https://user@skills.sh/owner/repo",
      "https://user:pass@skills.sh/owner/repo",
      "https://skills.sh:8080/owner/repo",
      "https://skills.sh/owner/repo?ref=main",
      "https://skills.sh/owner/repo#fragment",
    ]) {
      try {
        parseSkillsShReference(input);
        throw new Error(`expected rejection for ${input}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CatalogIntegrationError);
        expect((error as CatalogIntegrationError).code).toBe(
          "CATALOG_SOURCE_UNRESOLVED",
        );
      }
    }
  });

  test("rejects percent-encoded path segments", () => {
    expect(() =>
      parseSkillsShReference("https://skills.sh/ow%20ner/repo"),
    ).toThrow(CatalogIntegrationError);
  });

  test("rejects uppercase scheme/host and punycode homograph hosts", () => {
    for (const input of [
      "HTTPS://SKILLS.SH/owner/repo",
      "https://SKILLS.SH/owner/repo",
      "https://xn--sklls-fqa.sh/owner/repo",
      "https://skills.sh.evil.test/owner/repo",
    ]) {
      try {
        parseSkillsShReference(input);
        throw new Error(`expected rejection for ${input}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CatalogIntegrationError);
        expect((error as CatalogIntegrationError).code).toBe(
          "CATALOG_SOURCE_UNRESOLVED",
        );
      }
    }
  });
});

describe("parseSkillsShExternalId", () => {
  test("parses the bare owner/repo form without any prefix", () => {
    const parsed = parseSkillsShExternalId("vercel-labs/skills/find-skills");
    expect(parsed.owner).toBe("vercel-labs");
    expect(parsed.repo).toBe("skills");
    expect(parsed.skillPathHint).toEqual(["find-skills"]);
    expect(parsed.canonicalGitUrl).toBe(
      "https://github.com/vercel-labs/skills.git",
    );
  });

  test("tolerates full prefixed and URL forms", () => {
    expect(parseSkillsShExternalId("skills.sh:owner/repo").repo).toBe("repo");
    expect(
      parseSkillsShExternalId("https://skills.sh/owner/repo/skill").skillPathHint,
    ).toEqual(["skill"]);
  });

  test("rejects schemes, credentials, empty segments, and dot segments", () => {
    for (const input of [
      "git@github.com:owner/repo",
      "owner//repo",
      "owner/../repo",
      "owner",
      "",
      "https://example.com/owner/repo",
    ]) {
      try {
        parseSkillsShExternalId(input);
        throw new Error(`expected rejection for ${JSON.stringify(input)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CatalogIntegrationError);
        expect((error as CatalogIntegrationError).code).toBe(
          "CATALOG_SOURCE_UNRESOLVED",
        );
      }
    }
  });
});
