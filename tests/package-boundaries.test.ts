import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const packageJson = require("../package.json") as {
  files?: string[];
  exports?: Record<string, string | Record<string, string>>;
  bin?: Record<string, string>;
  scripts: Record<string, string>;
};
const engineSurface = require("../artifact-surfaces/engine-public.json") as {
  requiredDirectories?: string[];
  requiredFiles?: string[];
  forbiddenInArtifactPaths?: string[];
  forbiddenInSourcePaths?: string[];
};

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function normalizedPackageSurfaceValues(): string[] {
  const values: string[] = [];
  for (const file of packageJson.files ?? []) values.push(file);
  for (const [name, target] of Object.entries(packageJson.bin ?? {})) values.push(name, target);
  for (const [name, target] of Object.entries(packageJson.exports ?? {})) {
    values.push(name);
    if (typeof target === "string") {
      values.push(target);
    } else {
      values.push(...Object.values(target));
    }
  }
  return values.map((value) => value.replace(/^\.\//, "").replace(/\/$/, ""));
}

describe("package boundary contracts", () => {
  test("package files/bin/exports expose only declared public-engine surfaces", () => {
    const forbiddenFragments = [
      ".hermes",
      "plans",
      "dist",
      "tmp",
      "universall-skill-sys-pvt",
      "SKILLS.json",
      "SKILLS.md",
      "globals/core.json",
      "artifact-surface.json",
      "releases",
      "private-overlay",
    ];

    const surfaceValues = normalizedPackageSurfaceValues();
    expect(surfaceValues).toContain("skills/skill-sys");
    expect(surfaceValues.filter((value) => value === "skills" || value.startsWith("skills/"))).toEqual([
      "skills/skill-sys",
    ]);
    expect(surfaceValues).toContain("artifact-surfaces/engine-public.json");
    expect(packageJson.bin).toEqual({
      "skill-sys": "scripts/bin/skill-sys",
      skillpool: "scripts/bin/skillpool",
    });
    expect(packageJson.exports ?? {}).toEqual({});

    for (const value of surfaceValues) {
      for (const forbidden of forbiddenFragments) {
        expect(value).not.toContain(forbidden);
      }
    }
  });

  test("package file allowlist aligns with the engine-public artifact surface", () => {
    const expectedFiles = new Set([
      ...(engineSurface.requiredDirectories ?? []).map((entry) => `${entry}/`),
      ...(engineSurface.requiredFiles ?? []).filter((entry) => entry !== "package.json"),
    ]);
    expectedFiles.add("docs/compatibility-matrix.md");
    expectedFiles.add("docs/explanation/");
    expectedFiles.add("docs/integrations/");
    expectedFiles.add("docs/map/scripts-system.md");
    expectedFiles.add("docs/reference/");
    expectedFiles.add("docs/specs/");

    expect(new Set(packageJson.files ?? [])).toEqual(expectedFiles);
  });

  test("boundary docs state current monorepo package status and future packages without claiming a split", () => {
    const docs = [
      readRepoFile("README.md"),
      readRepoFile("docs/specs/repository-boundaries.md"),
      readRepoFile("docs/roadmap.md"),
      readRepoFile("docs/reference/skill-sys-commands.md"),
    ].join("\n---\n");

    expect(docs).toContain("current monorepo public-engine package");
    expect(docs).toContain("future packages");
    expect(docs).toContain("not yet split into workspaces");
    expect(docs).not.toContain("workspace package `@universall-skill-sys/engine`");
  });

  test("migration docs preserve user-owned root architecture and user-chosen versioning", () => {
    const migration = readRepoFile("docs/migration/from-private-universal-skills.md");

    expect(migration).toContain("Engine plus user-owned-root architecture");
    expect(migration).toContain("`universall-skill-sys` — base/public-engine repository");
    expect(migration).toContain("user skill root — private skills outside the engine repo");
    expect(migration).toContain("Public/private alignment note: keep private skill content in User Skill Roots");
    expect(migration).toContain("Users may create or choose their own private/public/internal Git");
    expect(migration).toContain("User projection metadata uses");
    expect(migration).not.toContain("required home for personal/private skills");
  });

  test("release and publish gates run the boundary docs test", () => {
    expect(packageJson.scripts["architecture:check"]).toBe(
      "bun test --timeout 30000 tests/architecture-fitness.test.ts tests/architecture-fitness-report.test.ts tests/architecture-boundary-integration.test.ts tests/catalog-boundary-policy.test.ts tests/source-boundary-policy.test.ts",
    );
    expect(packageJson.scripts["boundary:check"]).toBe(
      "bun run architecture:check && bun test tests/package-boundaries.test.ts tests/catalog-boundary-policy.test.ts",
    );
    expect(packageJson.scripts.test).toContain("tests/package-boundaries.test.ts");
    expect(packageJson.scripts.test).toContain("tests/architecture-fitness-report.test.ts");
    expect(packageJson.scripts.test).toContain(
      "tests/catalog-query-shell-parity.test.ts",
    );
    expect(packageJson.scripts["validate:local"]).toContain("bun run boundary:check");
    expect(packageJson.scripts["validate:publish"]).toContain("bun run validate:release");
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          "scripts/modules/skill-sys/architecture-boundaries.v5.json",
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          "scripts/modules/skill-sys/architecture-boundaries.v4.json",
        ),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          "scripts/modules/skill-sys/architecture-boundaries.v2.json",
        ),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          "scripts/modules/skill-sys/architecture-boundaries.v1.json",
        ),
      ),
    ).toBe(false);
  });
});
