import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type {
  CatalogSelectedProfileRecord,
  CatalogSkillRecord,
} from "../scripts/modules/catalog/query-skills.ts";
import type {
  CatalogSkillsReadFailure,
  CatalogSkillsReader,
  CatalogSkillsReadResult,
} from "../scripts/modules/application/ports/catalog-skills-reader.ts";

const repoRoot = path.resolve(__dirname, "..");
const readerPath = path.join(
  repoRoot,
  "scripts/modules/application/ports/catalog-skills-reader.ts",
);

function compileTimeContract(
  skills: readonly CatalogSkillRecord[],
  selectedProfiles: readonly CatalogSelectedProfileRecord[],
): void {
  const successReader = {
    read: () => ({
      ok: true,
      skills,
      selectedProfiles,
    }),
  } satisfies CatalogSkillsReader;

  const failure: CatalogSkillsReadFailure = {
    code: "CATALOG_SKILLS_READ_FAILED",
  };
  const failureReader = {
    read: () => ({ ok: false, error: failure }),
  } satisfies CatalogSkillsReader;

  const successResult: CatalogSkillsReadResult = successReader.read();
  const failureResult: CatalogSkillsReadResult = failureReader.read();

  const asynchronousReader: CatalogSkillsReader = {
    // @ts-expect-error the read port is synchronous
    read: async () => ({ ok: true, skills, selectedProfiles }),
  };

  const missingProfilesReader: CatalogSkillsReader = {
    // @ts-expect-error a successful read must include selected-profile data
    read: () => ({ ok: true, skills }),
  };

  const transportShapedReader: CatalogSkillsReader = {
    // @ts-expect-error the read port accepts no transport input
    read: (_input: { readonly query: string }) => ({
      ok: true,
      skills,
      selectedProfiles,
    }),
  };

  void [
    successResult,
    failureResult,
    asynchronousReader,
    missingProfilesReader,
    transportShapedReader,
  ];
}

describe("Application Catalog skills read port", () => {
  test("is a no-argument synchronous discriminated read contract", () => {
    expect(compileTimeContract).toBeFunction();
  });

  test("has exactly one type-only internal dependency and no runtime declarations", () => {
    const source = fs.readFileSync(readerPath, "utf8");
    const imports = source.match(/import[\s\S]*?from\s+"[^"]+";/gu) ?? [];

    expect(imports).toEqual([
      [
        "import type {",
        "  CatalogSelectedProfileRecord,",
        "  CatalogSkillRecord,",
        '} from "../../catalog/query-skills.ts";',
      ].join("\n"),
    ]);
    expect(source).not.toMatch(
      /\b(?:const|let|var|function|class|enum|namespace)\b/u,
    );
  });

  test("erases completely from the runtime module", async () => {
    const runtimeModule = await import(
      "../scripts/modules/application/ports/catalog-skills-reader.ts"
    );

    expect(Object.keys(runtimeModule)).toEqual([]);
  });
});
