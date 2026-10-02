import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ARCHITECTURE_OPENING_REVISION,
  type ArchitectureBoundaryManifest,
  type ArchitectureDependencyGraph,
} from "../scripts/modules/skill-sys/architecture-fitness.ts";
import {
  ArchitectureFitnessReportError,
  createArchitectureFitnessReport,
  serializeArchitectureFitnessReport,
  type ArchitectureFitnessReportV1,
  type ArchitectureFitnessReportV2,
  type ArchitectureFitnessReportV3,
  type ArchitectureFitnessReportV4,
} from "../scripts/modules/skill-sys/architecture-fitness-report.ts";

const REVISION = "846f5fe933ffd967b716bf798d0e6ab826ab98a2";
const A_PATH = "scripts/modules/a.ts";
const Z_PATH = "scripts/modules/Z.ts";
const UNICODE_PATH = "scripts/modules/é.ts";

const v1ClassificationForTypecheck: ArchitectureFitnessReportV1["classificationCounts"][number]["classification"] =
  "legacy-observed";
// @ts-expect-error Report V1 must reject classifications introduced by Manifest V3.
const invalidV1ClassificationForTypecheck: ArchitectureFitnessReportV1["classificationCounts"][number]["classification"] =
  "catalog-public-target";
const v2ClassificationForTypecheck: ArchitectureFitnessReportV2["classificationCounts"][number]["classification"] =
  "catalog-public-target";
const v3ClassificationForTypecheck: ArchitectureFitnessReportV3["classificationCounts"][number]["classification"] =
  "catalog-public-target";
const v4ClassificationForTypecheck: ArchitectureFitnessReportV4["classificationCounts"][number]["classification"] =
  "catalog-public-target";
void [
  v1ClassificationForTypecheck,
  invalidV1ClassificationForTypecheck,
  v2ClassificationForTypecheck,
  v3ClassificationForTypecheck,
  v4ClassificationForTypecheck,
];

const RETIRED_EXCEPTION = {
  id: "RETIRED-1",
  from: A_PATH,
  to: Z_PATH,
  forbiddenDependencyId: "legacy-to-interface",
  rationale: "Preserve characterized opening behavior.",
  compatibilityConsumer: "fixture consumer",
  owningRoadmapFeature: "F-03",
  creationRevision: ARCHITECTURE_OPENING_REVISION,
  reviewStatus: "retired" as const,
  validThroughManifestVersion: 2,
  openingRevision: ARCHITECTURE_OPENING_REVISION,
  owner: "F-03.03",
  retirementCondition: "Fixture retirement condition.",
  retirementTargetChild: "F-15.02",
  evidenceReference: "fixture evidence",
};

const GREEN_MANIFEST: ArchitectureBoundaryManifest = {
  schemaVersion: 2,
  openingRevision: ARCHITECTURE_OPENING_REVISION,
  rules: [
    {
      id: "modules",
      selector: { kind: "prefix", path: "scripts/modules/" },
      classification: "legacy-observed",
      owner: "F-03",
      visibility: "internal",
      effect: "pure",
      lifecycle: "active",
    },
  ],
  forbiddenDependencies: [
    {
      id: "legacy-to-interface",
      from: "legacy-observed",
      to: "interface-observed",
    },
  ],
  openingEdges: [{ from: A_PATH, to: Z_PATH }],
  exceptions: [RETIRED_EXCEPTION],
};

const GREEN_GRAPH: ArchitectureDependencyGraph = {
  files: [UNICODE_PATH, A_PATH, Z_PATH],
  edges: [],
  externalDependencies: [
    {
      from: A_PATH,
      specifier: "node:path",
      syntax: "static-import",
      typeOnly: false,
      line: 1,
      column: 1,
    },
  ],
};

const GREEN_MANIFEST_V3: ArchitectureBoundaryManifest = {
  ...clone(GREEN_MANIFEST),
  schemaVersion: 3,
  rules: [
    {
      id: "catalog",
      selector: { kind: "exact", path: A_PATH },
      classification: "catalog-public-target",
      owner: "Catalog",
      visibility: "public-in-engine",
      effect: "pure",
      lifecycle: "active",
    },
    {
      id: "application-port",
      selector: { kind: "exact", path: Z_PATH },
      classification: "application-catalog-read-port-target",
      owner: "Application",
      visibility: "internal",
      effect: "pure",
      lifecycle: "active",
    },
    {
      id: "modules",
      selector: { kind: "prefix", path: "scripts/modules/" },
      exclusions: [
        { kind: "exact", path: A_PATH },
        { kind: "exact", path: Z_PATH },
      ],
      classification: "legacy-observed",
      owner: "F-03",
      visibility: "internal",
      effect: "pure",
      lifecycle: "active",
    },
  ],
  exceptions: [
    {
      ...clone(RETIRED_EXCEPTION),
      validThroughManifestVersion: 3,
    },
  ],
};

const GREEN_MANIFEST_V4: ArchitectureBoundaryManifest = {
  ...clone(GREEN_MANIFEST_V3),
  schemaVersion: 4,
  exceptions: [
    {
      ...clone(RETIRED_EXCEPTION),
      validThroughManifestVersion: 4,
    },
  ],
};

const GREEN_MANIFEST_V5: ArchitectureBoundaryManifest = {
  ...clone(GREEN_MANIFEST_V4),
  schemaVersion: 5,
  exceptions: [
    {
      ...clone(RETIRED_EXCEPTION),
      validThroughManifestVersion: 5,
    },
  ],
};

function edge(
  from: string,
  to: string,
): ArchitectureDependencyGraph["edges"][number] {
  return {
    from,
    to,
    specifier: "./target.ts",
    syntax: "static-import",
    typeOnly: false,
    line: 1,
    column: 1,
  };
}

type DeepMutable<Value> =
  Value extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
      : Value;

function clone<Value>(value: Value): DeepMutable<Value> {
  return structuredClone(value) as DeepMutable<Value>;
}

function createGreenReport() {
  return createArchitectureFitnessReport({
    evaluatedRevision: REVISION,
    manifest: clone(GREEN_MANIFEST),
    graph: clone(GREEN_GRAPH),
  });
}

function createGreenReportV4() {
  return createArchitectureFitnessReport({
    evaluatedRevision: REVISION,
    manifest: clone(GREEN_MANIFEST_V4),
    graph: clone(GREEN_GRAPH),
  });
}

function createGreenReportV5() {
  return createArchitectureFitnessReport({
    evaluatedRevision: REVISION,
    manifest: clone(GREEN_MANIFEST_V5),
    graph: clone(GREEN_GRAPH),
  });
}

function canonicalizeForTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForTest);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalizeForTest((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function resealReport(
  mutate: (report: DeepMutable<ReturnType<typeof createGreenReport>>) => void,
) {
  const report = clone(createGreenReport());
  mutate(report);
  const { reportDigest: _oldDigest, ...payload } = report;
  report.reportDigest = createHash("sha256")
    .update(JSON.stringify(canonicalizeForTest(payload)), "utf8")
    .digest("hex");
  return report;
}

describe("F-03.03 package-internal architecture fitness report", () => {
  test("dispatches Manifest V3 to the exact Report V2 golden", () => {
    const report = createArchitectureFitnessReport({
      evaluatedRevision: REVISION,
      manifest: clone(GREEN_MANIFEST_V3),
      graph: clone(GREEN_GRAPH),
    });
    const serialized = serializeArchitectureFitnessReport(report);
    const golden = fs.readFileSync(
      path.join(__dirname, "fixtures", "architecture-fitness-report.v2.json"),
      "utf8",
    );

    expect(serialized).toBe(golden);
    expect(report).toMatchObject({
      schemaVersion: 2,
      cohortId: "F-03.03-report-v2",
      manifest: { schemaVersion: 3 },
      classificationCounts: [
        { classification: "application-catalog-read-port-target", count: 1 },
        { classification: "catalog-public-target", count: 1 },
        { classification: "legacy-observed", count: 1 },
      ],
    });
  });

  test("dispatches Manifest V4 to the exact Report V3 golden", () => {
    const report = createGreenReportV4();
    const serialized = serializeArchitectureFitnessReport(report);
    const golden = fs.readFileSync(
      path.join(__dirname, "fixtures", "architecture-fitness-report.v3.json"),
      "utf8",
    );

    expect(serialized).toBe(golden);
    expect(report).toMatchObject({
      schemaVersion: 3,
      cohortId: "F-03.03-report-v3",
      manifest: { schemaVersion: 4 },
    });
  });

  test("dispatches Manifest V5 to Report V4", () => {
    const report = createGreenReportV5();
    const fixture = fs.readFileSync(
      path.join(__dirname, "fixtures", "architecture-fitness-report.v4.json"),
      "utf8",
    );
    expect(serializeArchitectureFitnessReport(report)).toBe(fixture);
    expect(report).toMatchObject({
      schemaVersion: 4,
      cohortId: "F-03.03-report-v4",
      manifest: { schemaVersion: 5 },
    });
  });

  test("fails closed for crossed and unknown report/manifest identities", () => {
    const v1 = clone(createGreenReport()) as Record<string, unknown>;
    const v2 = clone(
      createArchitectureFitnessReport({
        evaluatedRevision: REVISION,
        manifest: clone(GREEN_MANIFEST_V3),
        graph: clone(GREEN_GRAPH),
      }),
    ) as Record<string, unknown>;
    const v3 = clone(createGreenReportV4()) as Record<string, unknown>;
    const crossed = [
      { ...v1, schemaVersion: 2 },
      { ...v1, cohortId: "F-03.03-report-v2" },
      { ...v2, schemaVersion: 1 },
      { ...v2, cohortId: "F-03.03-report-v1" },
      { ...v2, schemaVersion: 99 },
      { ...v3, schemaVersion: 2 },
      { ...v3, cohortId: "F-03.03-report-v2" },
    ];
    for (const report of crossed) {
      expect(() => serializeArchitectureFitnessReport(report)).toThrow(
        ArchitectureFitnessReportError,
      );
    }

    const v2VocabularyInV1 = clone(GREEN_MANIFEST);
    v2VocabularyInV1.rules[0]!.classification = "catalog-public-target";
    expect(() =>
      createArchitectureFitnessReport({
        evaluatedRevision: REVISION,
        manifest: v2VocabularyInV1,
        graph: clone(GREEN_GRAPH),
      }),
    ).toThrow(ArchitectureFitnessReportError);
  });

  test("retains the exact historical V1 fixture bytes", () => {
    const bytes = fs.readFileSync(
      path.join(__dirname, "fixtures", "architecture-fitness-report.v1.json"),
    );
    expect(bytes.byteLength).toBe(966);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "3cd8b1dbc56ebd14e08a4effcc3614159e67a1456d8183b86ba4a09715e9f408",
    );
    expect(serializeArchitectureFitnessReport(createGreenReport())).toBe(
      bytes.toString("utf8"),
    );
  });

  test("matches the versioned golden bytes and keeps raw inputs private", () => {
    const report = createGreenReport();
    const serialized = serializeArchitectureFitnessReport(report);
    const golden = fs.readFileSync(
      path.join(__dirname, "fixtures", "architecture-fitness-report.v1.json"),
      "utf8",
    );

    expect(serialized).toBe(golden);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.endsWith("\n\n")).toBe(false);
    expect(serialized).not.toContain("node:path");
    expect(serialized).not.toContain("Preserve characterized");
    expect(report).toMatchObject({
      schemaVersion: 1,
      cohortId: "F-03.03-report-v1",
      evaluatedRevision: REVISION,
      graph: {
        fileCount: 3,
        internalEdgeCount: 0,
        externalDependencyCount: 1,
      },
      classificationCounts: [
        { classification: "legacy-observed", count: 3 },
      ],
      outcome: { ok: true, findingCount: 0, cycleCount: 0 },
      findings: [],
      cycles: [],
      exceptions: {
        declaredIds: ["RETIRED-1"],
        usedIds: [],
        unusedAcceptedIds: [],
        retiredIds: ["RETIRED-1"],
      },
    });
  });

  test("normalizes semantically equivalent input permutations", () => {
    const firstManifest = clone(GREEN_MANIFEST);
    const secondManifest = clone(GREEN_MANIFEST);
    secondManifest.rules.reverse();
    secondManifest.forbiddenDependencies.reverse();
    secondManifest.openingEdges.reverse();
    secondManifest.exceptions.reverse();
    const secondGraph = clone(GREEN_GRAPH);
    secondGraph.files.reverse();
    secondGraph.externalDependencies?.reverse();

    const first = createArchitectureFitnessReport({
      evaluatedRevision: REVISION,
      manifest: firstManifest,
      graph: clone(GREEN_GRAPH),
    });
    const second = createArchitectureFitnessReport({
      evaluatedRevision: REVISION,
      manifest: secondManifest,
      graph: secondGraph,
    });

    expect(second).toEqual(first);
    expect(serializeArchitectureFitnessReport(second)).toBe(
      serializeArchitectureFitnessReport(first),
    );
  });

  test("derives red findings and cycles without exposing evaluator detail", () => {
    const redManifest: ArchitectureBoundaryManifest = {
      ...clone(GREEN_MANIFEST),
      forbiddenDependencies: [
        {
          id: "legacy-import-free",
          from: "legacy-observed",
          to: "*",
        },
      ],
      openingEdges: [],
      exceptions: [],
    };
    const redGraph: ArchitectureDependencyGraph = {
      files: [Z_PATH, A_PATH],
      edges: [edge(A_PATH, Z_PATH), edge(Z_PATH, A_PATH)],
    };
    const report = createArchitectureFitnessReport({
      evaluatedRevision: REVISION,
      manifest: redManifest,
      graph: redGraph,
    });
    const serialized = serializeArchitectureFitnessReport(report);

    expect(report.outcome).toEqual({
      ok: false,
      findingCount: 3,
      cycleCount: 1,
    });
    expect(report.findings).toEqual([
      { code: "CYCLE", path: Z_PATH },
      { code: "FORBIDDEN_DEPENDENCY", path: Z_PATH },
      { code: "FORBIDDEN_DEPENDENCY", path: A_PATH },
    ]);
    expect(report.cycles).toEqual([[Z_PATH, A_PATH]]);
    expect(serialized).not.toContain("legacy-import-free");
    expect(serialized).not.toContain("./target.ts");
    expect(serialized).not.toContain("detail");
  });

  test("preserves sanitized finding collisions deterministically", () => {
    const manifest: ArchitectureBoundaryManifest = {
      ...clone(GREEN_MANIFEST),
      forbiddenDependencies: [
        { id: "legacy-import-free", from: "legacy-observed", to: "*" },
      ],
      openingEdges: [],
      exceptions: [],
    };
    const firstGraph: ArchitectureDependencyGraph = {
      files: [UNICODE_PATH, A_PATH, Z_PATH],
      edges: [edge(A_PATH, UNICODE_PATH), edge(A_PATH, Z_PATH)],
    };
    const secondGraph: ArchitectureDependencyGraph = {
      ...clone(firstGraph),
      edges: [...firstGraph.edges].reverse(),
    };
    const first = createArchitectureFitnessReport({
      evaluatedRevision: REVISION,
      manifest,
      graph: firstGraph,
    });
    const second = createArchitectureFitnessReport({
      evaluatedRevision: REVISION,
      manifest: clone(manifest),
      graph: secondGraph,
    });

    expect(first.findings).toEqual([
      { code: "FORBIDDEN_DEPENDENCY", path: A_PATH },
      { code: "FORBIDDEN_DEPENDENCY", path: A_PATH },
    ]);
    expect(serializeArchitectureFitnessReport(second)).toBe(
      serializeArchitectureFitnessReport(first),
    );
  });

  test("changes identities when revision, manifest, or graph meaning changes", () => {
    const baseline = createGreenReport();
    const revision = createArchitectureFitnessReport({
      evaluatedRevision: "146f5fe933ffd967b716bf798d0e6ab826ab98a2",
      manifest: clone(GREEN_MANIFEST),
      graph: clone(GREEN_GRAPH),
    });
    const changedManifest = clone(GREEN_MANIFEST);
    changedManifest.rules[0]!.owner = "F-03.03";
    const manifest = createArchitectureFitnessReport({
      evaluatedRevision: REVISION,
      manifest: changedManifest,
      graph: clone(GREEN_GRAPH),
    });
    const changedGraph = clone(GREEN_GRAPH);
    changedGraph.externalDependencies![0]!.line = 2;
    const graph = createArchitectureFitnessReport({
      evaluatedRevision: REVISION,
      manifest: clone(GREEN_MANIFEST),
      graph: changedGraph,
    });

    expect(revision.reportDigest).not.toBe(baseline.reportDigest);
    expect(manifest.manifest.digest).not.toBe(baseline.manifest.digest);
    expect(manifest.reportDigest).not.toBe(baseline.reportDigest);
    expect(graph.graph.digest).not.toBe(baseline.graph.digest);
    expect(graph.reportDigest).not.toBe(baseline.reportDigest);
  });

  test("does not mutate inputs and returns detached frozen output", () => {
    const manifest = clone(GREEN_MANIFEST);
    const graph = clone(GREEN_GRAPH);
    const beforeManifest = clone(manifest);
    const beforeGraph = clone(graph);
    const report = createArchitectureFitnessReport({
      evaluatedRevision: REVISION,
      manifest,
      graph,
    });

    expect(manifest).toEqual(beforeManifest);
    expect(graph).toEqual(beforeGraph);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.graph)).toBe(true);
    expect(Object.isFrozen(report.classificationCounts)).toBe(true);
  });

  test("serializer rejects field tampering and a digest from another payload", () => {
    const report = createGreenReport();
    const tampered = clone(report);
    tampered.graph.fileCount += 1;
    expect(() => serializeArchitectureFitnessReport(tampered)).toThrow(
      ArchitectureFitnessReportError,
    );

    const other = createArchitectureFitnessReport({
      evaluatedRevision: "146f5fe933ffd967b716bf798d0e6ab826ab98a2",
      manifest: clone(GREEN_MANIFEST),
      graph: clone(GREEN_GRAPH),
    });
    const replaced = { ...clone(report), reportDigest: other.reportDigest };
    expect(() => serializeArchitectureFitnessReport(replaced)).toThrow(
      ArchitectureFitnessReportError,
    );
  });

  test("serializer rejects hostile paths even when the caller reseals the digest", () => {
    const resealed = resealReport((report) => {
      report.findings = [
        {
          code: "INVALID_PATH",
          path: "scripts/modules/token=redacted.ts",
        },
      ];
      report.outcome.ok = false;
      report.outcome.findingCount = 1;
    });

    expect(() => serializeArchitectureFitnessReport(resealed)).toThrow(
      ArchitectureFitnessReportError,
    );
  });

  test("serializer rejects C0, C1, and unpaired-surrogate text after resealing", () => {
    for (const hostilePath of [
      "scripts/modules/control\u0000.ts",
      "scripts/modules/control\u0085.ts",
      "scripts/modules/unpaired-\uD800.ts",
    ]) {
      const resealed = resealReport((report) => {
        report.findings = [{ code: "INVALID_PATH", path: hostilePath }];
        report.outcome.ok = false;
        report.outcome.findingCount = 1;
      });
      expect(() => serializeArchitectureFitnessReport(resealed)).toThrow(
        ArchitectureFitnessReportError,
      );
    }

    for (const hostileId of [
      "RETIRED\u0000",
      "RETIRED\u0085",
      "RETIRED-\uD800",
    ]) {
      const resealed = resealReport((report) => {
        report.exceptions.declaredIds = [hostileId];
        report.exceptions.retiredIds = [hostileId];
      });
      expect(() => serializeArchitectureFitnessReport(resealed)).toThrow(
        ArchitectureFitnessReportError,
      );
    }
  });

  test("serializer rejects resealed reports with impossible semantics", () => {
    const incompleteLedger = resealReport((report) => {
      report.exceptions.retiredIds = [];
    });
    const incompleteClassifications = resealReport((report) => {
      report.classificationCounts[0]!.count = 2;
    });
    const orphanCycleFinding = resealReport((report) => {
      report.findings = [{ code: "CYCLE", path: A_PATH }];
      report.outcome.ok = false;
      report.outcome.findingCount = 1;
    });

    for (const report of [
      incompleteLedger,
      incompleteClassifications,
      orphanCycleFinding,
    ]) {
      expect(() => serializeArchitectureFitnessReport(report)).toThrow(
        ArchitectureFitnessReportError,
      );
    }
  });

  test("fails closed for invalid revision, unknown fields, proxies, and accessors", () => {
    expect(() =>
      createArchitectureFitnessReport({
        evaluatedRevision: REVISION.toUpperCase(),
        manifest: clone(GREEN_MANIFEST),
        graph: clone(GREEN_GRAPH),
      }),
    ).toThrow(ArchitectureFitnessReportError);
    expect(() =>
      createArchitectureFitnessReport({
        evaluatedRevision: REVISION,
        manifest: clone(GREEN_MANIFEST),
        graph: clone(GREEN_GRAPH),
        status: true,
      }),
    ).toThrow(ArchitectureFitnessReportError);
    expect(() =>
      createArchitectureFitnessReport(
        new Proxy(
          {
            evaluatedRevision: REVISION,
            manifest: clone(GREEN_MANIFEST),
            graph: clone(GREEN_GRAPH),
          },
          {},
        ),
      ),
    ).toThrow(ArchitectureFitnessReportError);

    const accessorInput = {
      evaluatedRevision: REVISION,
      manifest: clone(GREEN_MANIFEST),
      graph: clone(GREEN_GRAPH),
    };
    Object.defineProperty(accessorInput.graph, "hidden", {
      enumerable: true,
      get: () => "secret",
    });
    expect(() => createArchitectureFitnessReport(accessorInput)).toThrow(
      ArchitectureFitnessReportError,
    );
  });

  test("rejects hostile proxies before caller-controlled property reads", () => {
    let creatorReads = 0;
    const creatorInput = new Proxy(
      {
        evaluatedRevision: REVISION,
        manifest: clone(GREEN_MANIFEST_V3),
        graph: clone(GREEN_GRAPH),
      },
      {
        get() {
          creatorReads += 1;
          throw new Error("caller trap");
        },
      },
    );
    expect(() => createArchitectureFitnessReport(creatorInput)).toThrow(
      ArchitectureFitnessReportError,
    );
    expect(creatorReads).toBe(0);

    let serializerReads = 0;
    const serializerInput = new Proxy(clone(createGreenReport()), {
      get() {
        serializerReads += 1;
        throw new Error("caller trap");
      },
    });
    expect(() => serializeArchitectureFitnessReport(serializerInput)).toThrow(
      ArchitectureFitnessReportError,
    );
    expect(serializerReads).toBe(0);
  });

  test("fails before digesting unsafe paths and hostile specifiers", () => {
    const unsafeGraph = clone(GREEN_GRAPH);
    unsafeGraph.files[0] = "../../private";
    expect(() =>
      createArchitectureFitnessReport({
        evaluatedRevision: REVISION,
        manifest: clone(GREEN_MANIFEST),
        graph: unsafeGraph,
      }),
    ).toThrow(ArchitectureFitnessReportError);

    const hostileGraph = clone(GREEN_GRAPH);
    hostileGraph.externalDependencies![0]!.specifier =
      "https://user:password@example.invalid/module.ts";
    expect(() =>
      createArchitectureFitnessReport({
        evaluatedRevision: REVISION,
        manifest: clone(GREEN_MANIFEST),
        graph: hostileGraph,
      }),
    ).toThrow(ArchitectureFitnessReportError);

    const absoluteSpecifierGraph = clone(GREEN_GRAPH);
    const absoluteModulePath = ["", "home", "private", "module.ts"].join("/");
    absoluteSpecifierGraph.externalDependencies![0]!.specifier = absoluteModulePath;
    expect(() =>
      createArchitectureFitnessReport({
        evaluatedRevision: REVISION,
        manifest: clone(GREEN_MANIFEST),
        graph: absoluteSpecifierGraph,
      }),
    ).toThrow(ArchitectureFitnessReportError);

    const privateModulePath = ["file:", "", "home", "fixture-user", "private.ts"].join("/");
    const privatePackagePath = ["pkg:", "", "home", "fixture-user", "private.ts"].join("/");
    const windowsUserPath = ["file:C:", "Users", "FixtureUser", "private.ts"].join("/");
    const credentialSpecifier = [["fixture-user", "fixture-password"].join(":"), "@example.invalid/module"].join("");
    const bearerToken = ["Bearer", ["eyJhbGci", "OiJIUzI1NiJ9", "payload", "signature"].join(".")].join(" ");
    const githubToken = ["ghp_", "0123456789abcdefghijklmnopqrstuvwxyz"].join("");
    const openAiToken = ["sk-proj-", "0123456789abcdefghijklmnopqrstuvwxyz"].join("");
    const awsToken = ["AKIA", "0123456789ABCDEF"].join("");
    for (const specifier of [
      "ssh://example.invalid/repository",
      "git+ssh://example.invalid/repository",
      "custom+transport://example.invalid/module",
      credentialSpecifier,
      privateModulePath,
      windowsUserPath,
      "ssh:host/private",
      "git+ssh:host/private",
      "http:example.invalid/private",
      "data:text/plain,private",
      privatePackagePath,
      "file:/tmp/private",
      bearerToken,
      githubToken,
      openAiToken,
      awsToken,
    ]) {
      const unsafeSpecifierGraph = clone(GREEN_GRAPH);
      unsafeSpecifierGraph.externalDependencies![0]!.specifier = specifier;
      expect(() =>
        createArchitectureFitnessReport({
          evaluatedRevision: REVISION,
          manifest: clone(GREEN_MANIFEST),
          graph: unsafeSpecifierGraph,
        }),
      ).toThrow(ArchitectureFitnessReportError);
    }

    for (const specifier of [
      "node:path",
      "node:fs/promises",
      "package-name",
      "@scope/package-name/subpath",
    ]) {
      const safeSpecifierGraph = clone(GREEN_GRAPH);
      safeSpecifierGraph.externalDependencies![0]!.specifier = specifier;
      expect(() =>
        createArchitectureFitnessReport({
          evaluatedRevision: REVISION,
          manifest: clone(GREEN_MANIFEST),
          graph: safeSpecifierGraph,
        }),
      ).not.toThrow();
    }
  });

  test("aborts without output for evaluator diagnostic pseudo-paths", () => {
    const staleManifest = clone(GREEN_MANIFEST);
    staleManifest.exceptions[0]!.reviewStatus = "accepted";

    expect(() =>
      createArchitectureFitnessReport({
        evaluatedRevision: REVISION,
        manifest: staleManifest,
        graph: clone(GREEN_GRAPH),
      }),
    ).toThrow(
      new ArchitectureFitnessReportError(
        "INVALID_REPORT_INPUT",
        "evaluator diagnostic is not a governed graph path",
      ),
    );
  });

  test("serializer independently rejects exotic and unknown report values", () => {
    const report = createGreenReport();
    expect(() =>
      serializeArchitectureFitnessReport(new Proxy(clone(report), {})),
    ).toThrow(ArchitectureFitnessReportError);
    expect(() =>
      serializeArchitectureFitnessReport({ ...clone(report), detail: "raw" }),
    ).toThrow(ArchitectureFitnessReportError);
  });

  test("rejects sparse arrays, nested proxies, and non-finite numbers", () => {
    const sparseGraph = clone(GREEN_GRAPH);
    sparseGraph.files = new Array(2);
    sparseGraph.files[1] = A_PATH;
    expect(() =>
      createArchitectureFitnessReport({
        evaluatedRevision: REVISION,
        manifest: clone(GREEN_MANIFEST),
        graph: sparseGraph,
      }),
    ).toThrow(ArchitectureFitnessReportError);

    const nestedProxyGraph = clone(GREEN_GRAPH);
    nestedProxyGraph.edges = new Proxy(nestedProxyGraph.edges, {});
    expect(() =>
      createArchitectureFitnessReport({
        evaluatedRevision: REVISION,
        manifest: clone(GREEN_MANIFEST),
        graph: nestedProxyGraph,
      }),
    ).toThrow(ArchitectureFitnessReportError);

    const infiniteGraph = clone(GREEN_GRAPH);
    infiniteGraph.externalDependencies![0]!.line = Number.POSITIVE_INFINITY;
    expect(() =>
      createArchitectureFitnessReport({
        evaluatedRevision: REVISION,
        manifest: clone(GREEN_MANIFEST),
        graph: infiniteGraph,
      }),
    ).toThrow(ArchitectureFitnessReportError);
  });
});
