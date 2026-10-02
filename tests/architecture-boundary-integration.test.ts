import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import architectureManifestJson from "../scripts/modules/skill-sys/architecture-boundaries.v5.json";
import {
  evaluateArchitectureFitness,
  parseArchitectureBoundaryManifest,
  type ArchitectureBoundaryManifest,
} from "../scripts/modules/skill-sys/architecture-fitness.ts";
import {
  createArchitectureFitnessReport,
  serializeArchitectureFitnessReport,
} from "../scripts/modules/skill-sys/architecture-fitness-report.ts";
import {
  ArchitectureGraphScanError,
  findArchitectureCycles,
  scanArchitectureGraph,
  type ArchitectureGraphEdge,
} from "./helpers/architecture-graph.ts";

const repoRoot = path.resolve(__dirname, "..");
const openingRevision = "6d0a2728ea39da64b09177edc71ae364fdcb1325";
const compatibilityOpeningRevision =
  "8955aac2025c32c3ea95fe49a00e020897f5d947";
const determinismFixtureRevision =
  "1111111111111111111111111111111111111111";
const postCommitEvidenceFlag =
  "F03_ARCHITECTURE_FITNESS_POST_COMMIT_EVIDENCE";
const evidenceInputPaths = [
  "package.json",
  "scripts/bin",
  "scripts/commands",
  "scripts/lib",
  "scripts/modules",
  "tests/architecture-boundary-integration.test.ts",
  "tests/helpers/architecture-graph.ts",
] as const;
const parsedArchitectureManifest =
  parseArchitectureBoundaryManifest(architectureManifestJson);
if (!parsedArchitectureManifest.ok) {
  throw new Error(
    `Invalid architecture boundary manifest: ${JSON.stringify(parsedArchitectureManifest.findings)}`,
  );
}
const architectureManifest = parsedArchitectureManifest.value;
const temporaryRoots: string[] = [];
const expectedOpeningExceptions = [
  {
    id: "F03-OPENING-001",
    from: "scripts/modules/skillpool/registry-export.ts",
    to: "scripts/commands/validate-registry-surface.ts",
    forbiddenDependencyId: "legacy-compatibility-to-interface",
    rationale:
      "Preserve characterized registry export behavior while the command-owned validator is moved behind a component public API.",
    compatibilityConsumer:
      "F-15 registry export characterization and current registry export command",
    owningRoadmapFeature: "F-03",
    creationRevision: openingRevision,
    reviewStatus: "accepted",
    validThroughManifestVersion: 5,
    openingRevision,
    owner: "F-03 seam owner; retirement evidence owner F-15",
    retirementCondition:
      "F-15 characterization proves registry export parity after command dependency removal.",
    retirementTargetChild: "F-15.02",
    evidenceReference: `F-03.01 opening graph at ${openingRevision}`,
  },
  {
    id: "F03-OPENING-002",
    from: "scripts/modules/skillpool/registry-trust.ts",
    to: "scripts/commands/validate-registry-surface.ts",
    forbiddenDependencyId: "legacy-compatibility-to-interface",
    rationale:
      "Preserve characterized registry trust behavior while the command-owned validator is moved behind a component public API.",
    compatibilityConsumer:
      "F-15 registry trust characterization and current registry trust command",
    owningRoadmapFeature: "F-03",
    creationRevision: openingRevision,
    reviewStatus: "accepted",
    validThroughManifestVersion: 5,
    openingRevision,
    owner: "F-03 seam owner; retirement evidence owner F-15",
    retirementCondition:
      "F-15 characterization proves registry trust parity after command dependency removal.",
    retirementTargetChild: "F-15.02",
    evidenceReference: `F-03.01 opening graph at ${openingRevision}`,
  },
  {
    id: "F03-OPENING-003",
    from: "scripts/modules/skillpool/skillpack.ts",
    to: "scripts/commands/universal-contract.ts",
    forbiddenDependencyId: "legacy-compatibility-to-interface",
    rationale:
      "Preserve characterized skillpack validation while the command-owned universal contract is moved behind a component public API.",
    compatibilityConsumer:
      "F-15 skillpack characterization and current skillpack validation paths",
    owningRoadmapFeature: "F-03",
    creationRevision: openingRevision,
    reviewStatus: "accepted",
    validThroughManifestVersion: 5,
    openingRevision,
    owner: "F-03 seam owner; retirement evidence owner F-15",
    retirementCondition:
      "F-15 characterization proves skillpack validation parity after command dependency removal.",
    retirementTargetChild: "F-15.02",
    evidenceReference: `F-03.01 opening graph at ${openingRevision}`,
  },
] as const;

function createFixture(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-graph-"));
  temporaryRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, "utf8");
  }
  return root;
}

function edgeKey(edge: ArchitectureGraphEdge): string {
  return `${edge.from} -> ${edge.to}`;
}

function reportGraph(graph: ReturnType<typeof scanArchitectureGraph>) {
  return {
    files: graph.files,
    edges: graph.edges,
    externalDependencies: graph.externalDependencies,
  };
}

function runGit(args: readonly string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: repoRoot,
    env: process.env,
  });
}

function gitStdout(args: readonly string[], purpose: string): string {
  const result = runGit(args);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to ${purpose}`);
  }
  return result.stdout?.toString().trim() ?? "";
}

function assertGitDiffClean(
  args: readonly string[],
  dirtyMessage: string,
): void {
  const result = runGit(args);
  if (result.exitCode === 1) {
    throw new Error(dirtyMessage);
  }
  if (result.exitCode !== 0) {
    throw new Error("Unable to verify Git cleanliness");
  }
}

function resolveCleanPostCommitRevision(): string {
  const revision = gitStdout(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "resolve the post-commit evidence revision",
  );
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("Post-commit evidence requires a full lowercase commit");
  }

  assertGitDiffClean(
    ["diff", "--cached", "--quiet", "--"],
    "Post-commit evidence requires a clean index",
  );
  assertGitDiffClean(
    ["diff", "--quiet", "--", ...evidenceInputPaths],
    "Post-commit evidence requires clean governed working-tree inputs",
  );
  assertGitDiffClean(
    ["diff", "--quiet", revision, "--", ...evidenceInputPaths],
    "Post-commit evidence inputs do not match the resolved revision",
  );

  const untracked = [
    gitStdout(
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        ...evidenceInputPaths,
      ],
      "inspect untracked governed inputs",
    ),
    gitStdout(
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        ...evidenceInputPaths,
      ],
      "inspect ignored governed inputs",
    ),
  ].filter((value) => value !== "");
  if (untracked.length > 0) {
    throw new Error(
      "Post-commit evidence requires no untracked or ignored governed inputs",
    );
  }
  return revision;
}

function readCurrentArchitectureManifest() {
  const manifestPath = path.join(
    repoRoot,
    "scripts",
    "modules",
    "skill-sys",
    "architecture-boundaries.v5.json",
  );
  const parsed = parseArchitectureBoundaryManifest(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  );
  if (!parsed.ok) {
    throw new Error("Post-commit evidence requires a valid current manifest");
  }
  return parsed.value;
}

function assertSameCleanPostCommitRevision(expectedRevision: string): void {
  const finalRevision = resolveCleanPostCommitRevision();
  if (finalRevision !== expectedRevision) {
    throw new Error("Post-commit evidence revision changed during evaluation");
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("architecture graph AST scanner", () => {
  test("captures every governed literal dependency form without treating text as an edge", () => {
    const fixtureRoot = createFixture({
      "scripts/commands/main.ts": [
        'import type { A } from "../modules/type-a.ts";',
        'import { value } from "../modules/value.ts";',
        'export { type B } from "../modules/type-b.ts";',
        'export * from "../modules/exported.ts";',
        'import legacy = require("../lib/legacy.ts");',
        'const required = require("../lib/required.ts");',
        'const lazy = () => import("../modules/dynamic.ts", { with: { type: "json" } });',
        'import path from "node:path";',
        '// require("../modules/comment-only.ts");',
        'const ordinary = "import(\\"../modules/string-only.ts\\")";',
        "void [value, legacy, required, lazy, path, ordinary];",
      ].join("\n"),
      "scripts/lib/legacy.ts": "export = { legacy: true };\n",
      "scripts/lib/required.ts": "export const required = true;\n",
      "scripts/modules/dynamic.ts": "export const dynamic = true;\n",
      "scripts/modules/exported.ts": "export const exported = true;\n",
      "scripts/modules/type-a.ts": "export type A = string;\n",
      "scripts/modules/type-b.ts": "export type B = string;\n",
      "scripts/modules/value.ts": "export const value = true;\n",
      "scripts/bin/skill-sys": "#!/usr/bin/env sh\n",
    });

    const graph = scanArchitectureGraph({ repoRoot: fixtureRoot });

    expect(graph.edges.map((edge) => edge.syntax).sort()).toEqual([
      "commonjs-require",
      "dynamic-import",
      "import-equals",
      "re-export",
      "re-export",
      "static-import",
      "static-import",
    ]);
    expect(
      graph.edges
        .filter((edge) => edge.typeOnly)
        .map((edge) => edge.to)
        .sort(),
    ).toEqual(["scripts/modules/type-a.ts", "scripts/modules/type-b.ts"]);
    expect(graph.edges.map((edge) => edge.to)).not.toContain(
      "scripts/modules/comment-only.ts",
    );
    expect(graph.edges.map((edge) => edge.to)).not.toContain(
      "scripts/modules/string-only.ts",
    );
    expect(graph.externalDependencies).toEqual([
      {
        from: "scripts/commands/main.ts",
        specifier: "node:path",
        syntax: "static-import",
        typeOnly: false,
        line: 8,
        column: 18,
      },
    ]);
    expect(graph.launcherFiles).toEqual(["scripts/bin/skill-sys"]);
    expect(graph.files).not.toContain("scripts/bin/skill-sys");
  });

  test("fails closed for computed dependency forms", () => {
    const fixtureRoot = createFixture({
      "scripts/modules/computed.ts": [
        'const target = "./target.ts";',
        "const first = require(target);",
        "const second = import(target);",
        "void [first, second];",
      ].join("\n"),
      "scripts/modules/target.ts": "export const target = true;\n",
    });

    try {
      scanArchitectureGraph({ repoRoot: fixtureRoot });
      throw new Error("Expected computed dependency forms to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchitectureGraphScanError);
      const scanError = error as ArchitectureGraphScanError;
      expect(scanError.issues.map((issue) => [issue.code, issue.syntax])).toEqual([
        ["COMPUTED_SPECIFIER", "commonjs-require"],
        ["COMPUTED_SPECIFIER", "dynamic-import"],
      ]);
    }
  });

  test("fails closed for unresolved and outside-universe relative imports", () => {
    const fixtureRoot = createFixture({
      "outside.ts": "export const outside = true;\n",
      "scripts/modules/main.ts": [
        'import "../../outside.ts";',
        'import "./missing.ts";',
      ].join("\n"),
    });

    try {
      scanArchitectureGraph({ repoRoot: fixtureRoot });
      throw new Error("Expected invalid relative imports to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchitectureGraphScanError);
      const scanError = error as ArchitectureGraphScanError;
      expect(scanError.issues.map((issue) => issue.code).sort()).toEqual([
        "TARGET_OUTSIDE_UNIVERSE",
        "UNRESOLVED_RELATIVE_IMPORT",
      ]);
    }
  });

  test("resolves extensionless indexes and deterministic local package imports", () => {
    const fixtureRoot = createFixture({
      "package.json": JSON.stringify({
        imports: {
          "#exact": "./scripts/modules/exact.ts",
          "#feature/*": "./scripts/modules/features/*.ts",
        },
      }),
      "scripts/commands/main.ts": [
        'import "../modules/indexed";',
        'import "#exact";',
        'import "#feature/value";',
      ].join("\n"),
      "scripts/modules/exact.ts": "export const exact = true;\n",
      "scripts/modules/features/value.ts": "export const value = true;\n",
      "scripts/modules/indexed/index.ts": "export const indexed = true;\n",
    });

    const graph = scanArchitectureGraph({ repoRoot: fixtureRoot });
    expect(graph.edges.map((edge) => edge.to)).toEqual([
      "scripts/modules/exact.ts",
      "scripts/modules/features/value.ts",
      "scripts/modules/indexed/index.ts",
    ]);
    expect(graph.externalDependencies).toEqual([]);
  });

  test("substitutes every package target wildcard without replacement-string expansion", () => {
    const fixtureRoot = createFixture({
      "package.json": JSON.stringify({
        imports: { "#repeat/*": "./scripts/modules/repeated/*/*.ts" },
      }),
      "scripts/commands/main.ts": 'import "#repeat/value";\nimport "#repeat/dollar$&";\n',
      "scripts/modules/repeated/value/value.ts": "export const value = true;\n",
      "scripts/modules/repeated/dollar$&/dollar$&.ts": "export const literal = true;\n",
    });

    const graph = scanArchitectureGraph({ repoRoot: fixtureRoot });
    expect(graph.edges.map((edge) => edge.to)).toEqual([
      "scripts/modules/repeated/dollar$&/dollar$&.ts",
      "scripts/modules/repeated/value/value.ts",
    ]);
  });

  test("fails closed for unresolved and unsafe package imports", () => {
    const fixtureRoot = createFixture({
      "package.json": JSON.stringify({
        imports: {
          "#missing": "./scripts/modules/missing.ts",
          "#unsafe": "../outside.ts",
        },
      }),
      "scripts/modules/main.ts": [
        'import "#missing";',
        'import "#undeclared";',
        'import "#unsafe";',
      ].join("\n"),
    });

    try {
      scanArchitectureGraph({ repoRoot: fixtureRoot });
      throw new Error("Expected invalid package imports to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchitectureGraphScanError);
      const scanError = error as ArchitectureGraphScanError;
      expect(scanError.issues.map((issue) => [issue.code, issue.specifier])).toEqual([
        ["UNRESOLVED_PACKAGE_IMPORT", "#missing"],
        ["UNRESOLVED_PACKAGE_IMPORT", "#undeclared"],
        ["UNSAFE_PACKAGE_IMPORT_TARGET", "#unsafe"],
      ]);
    }
  });

  test("fails closed when a governed TypeScript file cannot be parsed", () => {
    const fixtureRoot = createFixture({
      "scripts/modules/malformed.ts": 'import { value from "./value.ts";\n',
      "scripts/modules/value.ts": "export const value = true;\n",
    });

    try {
      scanArchitectureGraph({ repoRoot: fixtureRoot });
      throw new Error("Expected malformed TypeScript to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchitectureGraphScanError);
      const scanError = error as ArchitectureGraphScanError;
      expect(scanError.issues.map((issue) => issue.code)).toEqual([
        "SOURCE_PARSE_FAILED",
      ]);
    }
  });

  test("fails closed for symlinks in governed and launcher paths", () => {
    const fixtureRoot = createFixture({
      "outside.ts": "export const outside = true;\n",
      "scripts/modules/main.ts": "export const main = true;\n",
      "scripts/bin/skill-sys": "#!/usr/bin/env sh\n",
    });
    fs.symlinkSync(
      path.join(fixtureRoot, "outside.ts"),
      path.join(fixtureRoot, "scripts", "modules", "linked.ts"),
    );
    fs.symlinkSync(
      path.join(fixtureRoot, "scripts", "bin", "skill-sys"),
      path.join(fixtureRoot, "scripts", "bin", "linked-launcher"),
    );

    try {
      scanArchitectureGraph({ repoRoot: fixtureRoot });
      throw new Error("Expected governed symlinks to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ArchitectureGraphScanError);
      const scanError = error as ArchitectureGraphScanError;
      expect(scanError.issues.map((issue) => [issue.code, issue.from])).toEqual([
        ["SYMLINK_PATH", "scripts/bin/linked-launcher"],
        ["SYMLINK_PATH", "scripts/modules/linked.ts"],
      ]);
    }
  });

  test("ignores locally shadowed require calls without hiding CommonJS require", () => {
    const fixtureRoot = createFixture({
      "scripts/modules/global.ts": [
        'const loaded = require("./target.ts");',
        "void loaded;",
      ].join("\n"),
      "scripts/modules/named-class.ts": [
        "const Named = class require {",
        '  static value = require("./not-a-module.ts");',
        "};",
        "void Named;",
      ].join("\n"),
      "scripts/modules/method.ts": [
        "const object = {",
        "  require() {",
        '    return require("./target.ts");',
        "  },",
        "};",
        "void object;",
      ].join("\n"),
      "scripts/modules/shadowed.ts": [
        "function local(require: (value: string) => string) {",
        '  return require("./not-a-module.ts");',
        "}",
        "void local;",
      ].join("\n"),
      "scripts/modules/target.ts": "export const target = true;\n",
    });

    const graph = scanArchitectureGraph({ repoRoot: fixtureRoot });
    expect(graph.edges.map(edgeKey)).toEqual([
      "scripts/modules/global.ts -> scripts/modules/target.ts",
      "scripts/modules/method.ts -> scripts/modules/target.ts",
    ]);
    expect(
      graph.edges.some((edge) => edge.from === "scripts/modules/named-class.ts"),
    ).toBe(false);
  });

  test("uses ordinal ASCII ordering and reports every excluded path class", () => {
    const fixtureRoot = createFixture({
      "scripts/modules/Z.ts": "export const upper = true;\n",
      "scripts/modules/a.ts": "export const lower = true;\n",
      "scripts/modules/é.ts": "export const accented = true;\n",
    });

    const graph = scanArchitectureGraph({ repoRoot: fixtureRoot });
    expect(graph.files).toEqual([
      "scripts/modules/Z.ts",
      "scripts/modules/a.ts",
      "scripts/modules/é.ts",
    ]);
    expect(graph.exclusions).toEqual([
      { pathPrefix: ".cache/", reason: "cache" },
      { pathPrefix: "dist/", reason: "generated-output" },
      { pathPrefix: "fixtures/", reason: "fixture" },
      { pathPrefix: "node_modules/", reason: "dependency" },
      { pathPrefix: "tests/", reason: "test-evidence" },
    ]);
  });

  test("detects direct, transitive, and self cycles deterministically", () => {
    const fixtureRoot = createFixture({
      "scripts/modules/a.ts": 'export * from "./b.ts";\n',
      "scripts/modules/b.ts": 'import "./a.ts";\n',
      "scripts/modules/self.ts": 'export * from "./self.ts";\n',
      "scripts/modules/standalone.ts": "export const standalone = true;\n",
    });

    const graph = scanArchitectureGraph({ repoRoot: fixtureRoot });
    expect(findArchitectureCycles(graph)).toEqual([
      ["scripts/modules/a.ts", "scripts/modules/b.ts"],
      ["scripts/modules/self.ts"],
    ]);
    expect(findArchitectureCycles(graph)).toEqual(findArchitectureCycles(graph));
  });
});

describe("opening public-engine architecture graph", () => {
  test("migrates Manifest V4 to V5 with only the governed deltas", () => {
    const historicalFixturePath = path.join(
      repoRoot,
      "tests/fixtures/architecture-boundaries.v4-opening.json",
    );
    const rawHistoricalBytes = fs.readFileSync(historicalFixturePath);
    expect(createHash("sha256").update(rawHistoricalBytes).digest("hex")).toBe(
      "5b66159ba6c73a8c26238a07f250876a8ef001235624dc953fb2e377afa171c5",
    );
    const historicalBytes = Buffer.from(rawHistoricalBytes).toString("utf8");
    const historical = JSON.parse(historicalBytes) as ArchitectureBoundaryManifest;
    const current = architectureManifest;
    const normalizedCurrentRules = current.rules.map((rule) =>
      rule.id === "source-public-target"
        ? { ...rule, owner: "Source / F-05.01" }
        : rule,
    );
    const normalizedCurrentExceptions = current.exceptions.map((exception) => ({
      ...exception,
      validThroughManifestVersion: 4,
    }));

    expect(current.schemaVersion).toBe(5);
    expect(current.openingRevision).toBe(historical.openingRevision);
    expect(current.openingEdges).toEqual(historical.openingEdges);
    expect(current.forbiddenDependencies).toEqual(
      historical.forbiddenDependencies,
    );
    expect(normalizedCurrentRules).toEqual([...historical.rules]);
    expect(
      current.rules
        .filter((rule) => rule.id === "source-public-target")
        .map((rule) => ({
          id: rule.id,
          selector: rule.selector,
          classification: rule.classification,
          owner: rule.owner,
          visibility: rule.visibility,
          effect: rule.effect,
          lifecycle: rule.lifecycle,
        })),
    ).toEqual([
      {
        id: "source-public-target",
        selector: {
          kind: "exact",
          path: "scripts/modules/source/propose-source-registration.ts",
        },
        classification: "source-public-target",
        owner: "Source / F-05",
        visibility: "public-in-engine",
        effect: "pure",
        lifecycle: "active",
      },
    ]);
    expect(normalizedCurrentExceptions).toEqual([...historical.exceptions]);
    expect(
      current.exceptions.map((exception) => ({
        id: exception.id,
        validThroughManifestVersion: exception.validThroughManifestVersion,
      })),
    ).toEqual([
      { id: "F03-OPENING-001", validThroughManifestVersion: 5 },
      { id: "F03-OPENING-002", validThroughManifestVersion: 5 },
      { id: "F03-OPENING-003", validThroughManifestVersion: 5 },
    ]);
  });

  test("is deterministic, acyclic, and retains the exact opening dependency debt", () => {
    const first = scanArchitectureGraph({ repoRoot });
    const second = scanArchitectureGraph({ repoRoot });

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(findArchitectureCycles(first)).toEqual([]);
    expect(first.files).toContain(
      "scripts/modules/skill-sys/typed-content-identity.ts",
    );
    expect(first.files).toContain(
      "scripts/modules/source/propose-source-registration.ts",
    );
    expect(
      first.edges
        .filter(
          (edge) =>
            edge.from === "scripts/modules/source/propose-source-registration.ts",
        )
        .map((edge) => ({
          from: edge.from,
          to: edge.to,
          syntax: edge.syntax,
          typeOnly: edge.typeOnly,
        })),
    ).toEqual([
      {
        from: "scripts/modules/source/propose-source-registration.ts",
        to: "scripts/modules/skill-sys/typed-content-identity.ts",
        syntax: "static-import",
        typeOnly: false,
      },
    ]);
    expect(first.launcherFiles).toContain("scripts/bin/skill-sys");
    expect(first.launcherFiles).toContain("scripts/bin/skillpool");
    expect(first.files.some((file) => file.startsWith("scripts/bin/"))).toBe(false);

    const moduleToCommandEdges = first.edges
      .filter(
        (edge) =>
          edge.from.startsWith("scripts/modules/") &&
          edge.to.startsWith("scripts/commands/"),
      )
      .map(edgeKey);
    expect(moduleToCommandEdges).toEqual([
      "scripts/modules/skillpool/registry-export.ts -> scripts/commands/validate-registry-surface.ts",
      "scripts/modules/skillpool/registry-trust.ts -> scripts/commands/validate-registry-surface.ts",
      "scripts/modules/skillpool/skillpack.ts -> scripts/commands/universal-contract.ts",
    ]);

    expect(first.edges.map(edgeKey)).toContain(
      "scripts/commands/generate-lock.ts -> scripts/commands/skill-sys.ts",
    );
    expect(first.edges.map(edgeKey)).toContain(
      "scripts/modules/skillpool/remove.ts -> scripts/modules/skill-sys/remove-planning.ts",
    );

    const fitness = evaluateArchitectureFitness(architectureManifest, {
      files: first.files,
      edges: first.edges,
      externalDependencies: first.externalDependencies,
    });
    const firstReport = createArchitectureFitnessReport({
      evaluatedRevision: determinismFixtureRevision,
      manifest: architectureManifest,
      graph: reportGraph(first),
    });
    const secondReport = createArchitectureFitnessReport({
      evaluatedRevision: determinismFixtureRevision,
      manifest: architectureManifest,
      graph: reportGraph(second),
    });
    const firstSerializedReport =
      serializeArchitectureFitnessReport(firstReport);
    const secondSerializedReport =
      serializeArchitectureFitnessReport(secondReport);
    expect(firstSerializedReport).toBe(secondSerializedReport);
    expect(firstReport.evaluatedRevision).toBe(determinismFixtureRevision);
    expect(firstReport.schemaVersion).toBe(4);
    expect(firstReport.cohortId).toBe("F-03.03-report-v4");
    expect(firstReport.manifest.schemaVersion).toBe(5);
    expect(firstSerializedReport).not.toContain(repoRoot);
    expect(firstSerializedReport).not.toContain(os.homedir());
    expect(architectureManifest.schemaVersion).toBe(5);
    expect(architectureManifest.openingRevision).toBe(openingRevision);
    expect(architectureManifest.openingEdges).toEqual([
      {
        from: "scripts/modules/skillpool/registry-export.ts",
        to: "scripts/commands/validate-registry-surface.ts",
      },
      {
        from: "scripts/modules/skillpool/registry-trust.ts",
        to: "scripts/commands/validate-registry-surface.ts",
      },
      {
        from: "scripts/modules/skillpool/skillpack.ts",
        to: "scripts/commands/universal-contract.ts",
      },
    ]);
    expect(architectureManifest.exceptions).toHaveLength(3);
    expect(architectureManifest.exceptions).toEqual(expectedOpeningExceptions);
    expect(
      architectureManifest.exceptions.map((exception) => ({
        id: exception.id,
        from: exception.from,
        to: exception.to,
        creationRevision: exception.creationRevision,
        openingRevision: exception.openingRevision,
        validThroughManifestVersion: exception.validThroughManifestVersion,
      })),
    ).toEqual([
      {
        id: "F03-OPENING-001",
        from: "scripts/modules/skillpool/registry-export.ts",
        to: "scripts/commands/validate-registry-surface.ts",
        creationRevision: openingRevision,
        openingRevision,
        validThroughManifestVersion: 5,
      },
      {
        id: "F03-OPENING-002",
        from: "scripts/modules/skillpool/registry-trust.ts",
        to: "scripts/commands/validate-registry-surface.ts",
        creationRevision: openingRevision,
        openingRevision,
        validThroughManifestVersion: 5,
      },
      {
        id: "F03-OPENING-003",
        from: "scripts/modules/skillpool/skillpack.ts",
        to: "scripts/commands/universal-contract.ts",
        creationRevision: openingRevision,
        openingRevision,
        validThroughManifestVersion: 5,
      },
    ]);
    expect(fitness.ok).toBe(true);
    expect(fitness.findings).toEqual([]);
    expect(fitness.cycles).toEqual([]);
    expect(fitness.usedExceptionIds).toEqual([
      "F03-OPENING-001",
      "F03-OPENING-002",
      "F03-OPENING-003",
    ]);
    expect(fitness.classifications).toHaveLength(first.files.length);
    expect(
      fitness.classifications.find(
        (classification) =>
          classification.path ===
          "scripts/modules/skill-sys/typed-content-identity.ts",
      ),
    ).toEqual({
      path: "scripts/modules/skill-sys/typed-content-identity.ts",
      ruleId: "typed-content-contract-leaf",
      classification: "contract-leaf",
    });
    expect(
      fitness.classifications.find(
        (classification) =>
          classification.path ===
          "scripts/modules/skill-sys/command-spec.ts",
      ),
    ).toEqual({
      path: "scripts/modules/skill-sys/command-spec.ts",
      ruleId: "command-spec-registry",
      classification: "legacy-observed",
    });
    expect(
      fitness.classifications.find(
        (classification) =>
          classification.path ===
          "scripts/modules/skill-sys/remove-planning.ts",
      ),
    ).toEqual({
      path: "scripts/modules/skill-sys/remove-planning.ts",
      ruleId: "remove-planning-public-target",
      classification: "planning-public-target",
    });
    expect(
      fitness.classifications.find(
        (classification) =>
          classification.path === "scripts/modules/skillpool/remove.ts",
      ),
    ).toEqual({
      path: "scripts/modules/skillpool/remove.ts",
      ruleId: "remove-compatibility-facade",
      classification: "remove-compatibility-facade",
    });
    expect(
      first.edges.filter(
        (edge) =>
          edge.from === "scripts/modules/skill-sys/remove-planning.ts",
      ),
    ).toEqual([]);
    expect(
      first.externalDependencies.filter(
        (dependency) =>
          dependency.from === "scripts/modules/skill-sys/remove-planning.ts",
      ),
    ).toEqual([]);
    expect(
      first.externalDependencies.filter(
        (dependency) =>
          dependency.from ===
          "scripts/modules/skill-sys/typed-content-identity.ts",
      ),
    ).toEqual([]);
    expect(
      first.edges.filter(
        (edge) => edge.from === "scripts/modules/skill-sys/command-spec.ts",
      ),
    ).toEqual([]);
    expect(
      first.externalDependencies.filter(
        (dependency) =>
          dependency.from === "scripts/modules/skill-sys/command-spec.ts",
      ).map((dependency) => dependency.specifier),
    ).toEqual([
      "node:util",
    ]);
  });

  const postCommitEvidenceTest =
    process.env[postCommitEvidenceFlag] === "1" ? test : test.skip;
  postCommitEvidenceTest(
    "binds a sanitized deterministic report to clean post-commit inputs",
    () => {
      const evaluatedRevision = resolveCleanPostCommitRevision();
      const currentManifest = readCurrentArchitectureManifest();
      const first = scanArchitectureGraph({ repoRoot });
      const second = scanArchitectureGraph({ repoRoot });
      const firstReport = createArchitectureFitnessReport({
        evaluatedRevision,
        manifest: currentManifest,
        graph: reportGraph(first),
      });
      const secondReport = createArchitectureFitnessReport({
        evaluatedRevision,
        manifest: currentManifest,
        graph: reportGraph(second),
      });
      const serialized =
        serializeArchitectureFitnessReport(firstReport);
      expect(serialized).toBe(
        serializeArchitectureFitnessReport(secondReport),
      );
      expect(firstReport.evaluatedRevision).toBe(evaluatedRevision);
      expect(serialized).not.toContain(repoRoot);
      expect(serialized).not.toContain(os.homedir());
      assertSameCleanPostCommitRevision(evaluatedRevision);
      process.stdout.write(serialized);
    },
  );
});
