import { describe, expect, test } from "bun:test";
import {
  ARCHITECTURE_OPENING_REVISION,
  evaluateArchitectureFitness,
  parseArchitectureBoundaryManifest,
  type ArchitectureBoundaryManifest,
  type ArchitectureDependencyGraph,
} from "../scripts/modules/skill-sys/architecture-fitness.ts";

const REVISION = ARCHITECTURE_OPENING_REVISION;

const BASE_MANIFEST: ArchitectureBoundaryManifest = {
  schemaVersion: 2,
  openingRevision: REVISION,
  rules: [
    {
      id: "contract",
      selector: { kind: "exact", path: "scripts/modules/contract.ts" },
      classification: "contract-leaf",
      owner: "F-02",
      visibility: "public-in-engine",
      effect: "pure",
      lifecycle: "active",
    },
    {
      id: "legacy",
      selector: { kind: "prefix", path: "scripts/modules/" },
      exclusions: [{ kind: "exact", path: "scripts/modules/contract.ts" }],
      classification: "legacy-observed",
      owner: "F-03",
      visibility: "internal",
      effect: "mixed",
      lifecycle: "observed",
    },
    {
      id: "commands",
      selector: { kind: "prefix", path: "scripts/commands/" },
      classification: "interface-observed",
      owner: "F-04",
      visibility: "interface",
      effect: "imperative",
      lifecycle: "observed",
    },
  ],
  forbiddenDependencies: [
    { id: "contract-leaf", from: "contract-leaf", to: "*" },
    { id: "legacy-to-command", from: "legacy-observed", to: "interface-observed" },
  ],
  openingEdges: [
    { from: "scripts/modules/legacy.ts", to: "scripts/commands/main.ts" },
  ],
  exceptions: [
    {
      id: "OPENING-1",
      from: "scripts/modules/legacy.ts",
      to: "scripts/commands/main.ts",
      forbiddenDependencyId: "legacy-to-command",
      rationale: "Preserve the characterized opening edge.",
      compatibilityConsumer: "opening fixture",
      owningRoadmapFeature: "F-03",
      creationRevision: REVISION,
      reviewStatus: "accepted",
      validThroughManifestVersion: 2,
      openingRevision: REVISION,
      owner: "F-03",
      retirementCondition: "Remove the command dependency under F-15.",
      retirementTargetChild: "F-15.02",
      evidenceReference: "fixture opening graph",
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

const BASE_GRAPH: ArchitectureDependencyGraph = {
  files: [
    "scripts/commands/main.ts",
    "scripts/modules/contract.ts",
    "scripts/modules/legacy.ts",
  ],
  edges: [edge("scripts/modules/legacy.ts", "scripts/commands/main.ts")],
};

const PLANNING_PATH = "scripts/modules/planning.ts";
const FACADE_PATH = "scripts/modules/facade.ts";
const LAUNCHER_PATH = "scripts/bin/skill-sys.ts";
const INBOUND_PATHS = {
  "interface-observed": "scripts/commands/main.ts",
  "legacy-observed": "scripts/modules/legacy.ts",
  "legacy-compatibility": "scripts/modules/compatibility.ts",
  "legacy-support": "scripts/modules/support.ts",
  "application-target": "scripts/modules/application.ts",
  "adapter-target": "scripts/modules/adapter.ts",
  "source-public-target": "scripts/modules/source-public.ts",
  "source-internal-target": "scripts/modules/source-internal.ts",
  "contract-leaf": "scripts/modules/contract.ts",
} as const;

const PLANNING_MANIFEST: ArchitectureBoundaryManifest = {
  ...BASE_MANIFEST,
  rules: [
    ...BASE_MANIFEST.rules.map((rule) =>
      rule.id === "legacy"
        ? {
            ...rule,
            exclusions: [
              ...(rule.exclusions ?? []),
              ...Object.entries(INBOUND_PATHS)
                .filter(
                  ([classification]) =>
                    !["interface-observed", "legacy-observed", "contract-leaf"].includes(
                      classification,
                    ),
                )
                .map(([, path]) => path)
                .map((path) => ({ kind: "exact" as const, path })),
              { kind: "exact" as const, path: PLANNING_PATH },
              { kind: "exact" as const, path: FACADE_PATH },
            ],
          }
        : rule,
    ),
    {
      id: "planning",
      selector: { kind: "exact", path: PLANNING_PATH },
      classification: "planning-public-target",
      owner: "Planning",
      visibility: "public-in-engine",
      effect: "pure",
      lifecycle: "active",
    },
    {
      id: "remove-facade",
      selector: { kind: "exact", path: FACADE_PATH },
      classification: "remove-compatibility-facade",
      owner: "F-15",
      visibility: "compatibility",
      effect: "mixed",
      lifecycle: "observed",
    },
    {
      id: "launcher",
      selector: { kind: "exact", path: LAUNCHER_PATH },
      classification: "interface-observed",
      owner: "F-04",
      visibility: "interface",
      effect: "imperative",
      lifecycle: "observed",
    },
    ...Object.entries(INBOUND_PATHS)
      .filter(([classification]) =>
        !["interface-observed", "legacy-observed", "contract-leaf"].includes(classification),
      )
      .map(([classification, path]) => ({
        id: `fixture-${classification}`,
        selector: { kind: "exact" as const, path },
        classification: classification as
          | "legacy-compatibility"
          | "legacy-support"
          | "application-target"
          | "adapter-target"
          | "source-public-target"
          | "source-internal-target",
        owner: "fixture",
        visibility: "internal",
        effect: "pure",
        lifecycle: "active",
      })),
  ],
  forbiddenDependencies: [
    ...BASE_MANIFEST.forbiddenDependencies,
    {
      id: "planning-import-free",
      from: "planning-public-target",
      to: "*",
    },
    ...Object.keys(INBOUND_PATHS).map((classification) => ({
      id: `${classification}-to-planning`,
      from: classification as keyof typeof INBOUND_PATHS,
      to: "planning-public-target" as const,
    })),
  ],
};

const PLANNING_FILES = [
  ...BASE_GRAPH.files,
  PLANNING_PATH,
  FACADE_PATH,
  LAUNCHER_PATH,
  ...Object.values(INBOUND_PATHS),
].filter((path, index, paths) => paths.indexOf(path) === index);

describe("F-03.01 architecture fitness core", () => {
  test("dispatches Manifest V2/V3/V4/V5 vocabularies without cross-version leakage", () => {
    const v3 = {
      ...structuredClone(BASE_MANIFEST),
      schemaVersion: 3,
      rules: [
        ...BASE_MANIFEST.rules,
        {
          id: "catalog",
          selector: {
            kind: "exact",
            path: "scripts/modules/catalog/query-skills.ts",
          },
          classification: "catalog-public-target",
          owner: "Catalog",
          visibility: "public-in-engine",
          effect: "pure",
          lifecycle: "active",
        },
      ],
      exceptions: BASE_MANIFEST.exceptions.map((exception) => ({
        ...exception,
        validThroughManifestVersion: 3,
      })),
    } satisfies ArchitectureBoundaryManifest;
    expect(parseArchitectureBoundaryManifest(v3).ok).toBe(true);

    const crossed = {
      ...structuredClone(v3),
      schemaVersion: 2,
      exceptions: v3.exceptions.map((exception) => ({
        ...exception,
        validThroughManifestVersion: 2,
      })),
    } satisfies ArchitectureBoundaryManifest;
    expect(parseArchitectureBoundaryManifest(crossed).ok).toBe(false);

    const v4 = {
      ...structuredClone(v3),
      schemaVersion: 4,
      rules: [
        ...v3.rules,
        {
          id: "source",
          selector: {
            kind: "exact" as const,
            path: "scripts/modules/source/propose-source-registration.ts",
          },
          classification: "source-public-target" as const,
          owner: "Source / F-05.01",
          visibility: "public-in-engine",
          effect: "pure",
          lifecycle: "active",
        },
      ],
      exceptions: v3.exceptions.map((exception) => ({
        ...exception,
        validThroughManifestVersion: 4,
      })),
    } satisfies ArchitectureBoundaryManifest;
    expect(parseArchitectureBoundaryManifest(v4).ok).toBe(true);
    const v5 = {
      ...structuredClone(v4),
      schemaVersion: 5,
      rules: v4.rules.map((rule) =>
        rule.id === "source"
          ? { ...rule, owner: "Source / F-05" }
          : rule,
      ),
      exceptions: v4.exceptions.map((exception) => ({
        ...exception,
        validThroughManifestVersion: 5,
      })),
    } satisfies ArchitectureBoundaryManifest;
    expect(parseArchitectureBoundaryManifest(v5).ok).toBe(true);
    expect(
      parseArchitectureBoundaryManifest({
        ...structuredClone(BASE_MANIFEST),
        schemaVersion: 6,
      }).ok,
    ).toBe(false);
  });

  test("admits the future Interface -> F-04 Application -> Catalog API/read-port direction only", () => {
    const interfacePath = "scripts/commands/catalog.ts";
    const launcherPath = "scripts/bin/skill-sys";
    const applicationPath = "scripts/modules/application/catalog-handler.ts";
    const catalogPath = "scripts/modules/catalog/query-skills.ts";
    const portPath =
      "scripts/modules/application/ports/catalog-skills-reader.ts";
    const manifest: ArchitectureBoundaryManifest = {
      schemaVersion: 3,
      openingRevision: REVISION,
      rules: [
        {
          id: "interface",
          selector: { kind: "exact", path: interfacePath },
          classification: "interface-observed",
          owner: "F-04",
          visibility: "interface",
          effect: "imperative",
          lifecycle: "active",
        },
        {
          id: "launcher",
          selector: { kind: "exact", path: launcherPath },
          classification: "interface-observed",
          owner: "F-04",
          visibility: "interface",
          effect: "imperative",
          lifecycle: "active",
        },
        {
          id: "application",
          selector: { kind: "exact", path: applicationPath },
          classification: "application-target",
          owner: "Application",
          visibility: "internal",
          effect: "pure",
          lifecycle: "planned",
        },
        {
          id: "catalog",
          selector: { kind: "exact", path: catalogPath },
          classification: "catalog-public-target",
          owner: "Catalog",
          visibility: "public-in-engine",
          effect: "pure",
          lifecycle: "active",
        },
        {
          id: "application-port",
          selector: { kind: "exact", path: portPath },
          classification: "application-catalog-read-port-target",
          owner: "Application",
          visibility: "internal",
          effect: "pure",
          lifecycle: "active",
        },
      ],
      forbiddenDependencies: [
        {
          id: "interface-cannot-bypass-application-to-catalog",
          from: "interface-observed",
          to: "catalog-public-target",
        },
        {
          id: "interface-cannot-bypass-application-to-port",
          from: "interface-observed",
          to: "application-catalog-read-port-target",
        },
      ],
      openingEdges: [],
      exceptions: [],
    };
    const futureGraph: ArchitectureDependencyGraph = {
      files: [interfacePath, applicationPath, catalogPath, portPath],
      edges: [
        edge(interfacePath, applicationPath),
        edge(applicationPath, catalogPath),
        edge(applicationPath, portPath),
        { ...edge(portPath, catalogPath), typeOnly: true },
      ],
    };

    expect(evaluateArchitectureFitness(manifest, futureGraph)).toMatchObject({
      ok: true,
      findings: [],
      cycles: [],
    });

    for (const bypassTarget of [catalogPath, portPath]) {
      const bypass = evaluateArchitectureFitness(manifest, {
        files: [...futureGraph.files, launcherPath],
        edges: [...futureGraph.edges, edge(launcherPath, bypassTarget)],
      });
      expect(bypass.findings).toContainEqual({
        code: "FORBIDDEN_DEPENDENCY",
        path: launcherPath,
        detail: expect.stringContaining(`:${bypassTarget}`),
      });
    }
  });

  test("rejects the retired v1 manifest format", () => {
    const parsed = parseArchitectureBoundaryManifest({
      ...BASE_MANIFEST,
      schemaVersion: 1,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.findings).toEqual([
        {
          code: "INVALID_MANIFEST",
          path: "manifest",
          detail: "invalid runtime structure",
        },
      ]);
    }
  });

  test("accepts the exact opening debt through its reviewed version-bound exception", () => {
    const result = evaluateArchitectureFitness(BASE_MANIFEST, BASE_GRAPH);

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.cycles).toEqual([]);
    expect(result.usedExceptionIds).toEqual(["OPENING-1"]);
    expect(result.classifications).toEqual([
      {
        path: "scripts/commands/main.ts",
        ruleId: "commands",
        classification: "interface-observed",
      },
      {
        path: "scripts/modules/contract.ts",
        ruleId: "contract",
        classification: "contract-leaf",
      },
      {
        path: "scripts/modules/legacy.ts",
        ruleId: "legacy",
        classification: "legacy-observed",
      },
    ]);
  });

  test("allows only the exact remove facade to consume the Planning entrypoint", () => {
    const result = evaluateArchitectureFitness(PLANNING_MANIFEST, {
      files: PLANNING_FILES,
      edges: [...BASE_GRAPH.edges, edge(FACADE_PATH, PLANNING_PATH)],
    });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.cycles).toEqual([]);
    expect(result.usedExceptionIds).toEqual(["OPENING-1"]);
  });

  test("rejects every governed non-facade inbound dependency on Planning", () => {
    for (const [classification, from] of Object.entries(INBOUND_PATHS)) {
      const result = evaluateArchitectureFitness(PLANNING_MANIFEST, {
        files: PLANNING_FILES,
        edges: [...BASE_GRAPH.edges, edge(from, PLANNING_PATH)],
      });

      expect(
        result.findings,
        `${classification} must not import Planning`,
      ).toContainEqual({
        code: "FORBIDDEN_DEPENDENCY",
        path: from,
        detail: `${classification}-to-planning:${PLANNING_PATH}`,
      });
    }

    const launcherResult = evaluateArchitectureFitness(PLANNING_MANIFEST, {
      files: PLANNING_FILES,
      edges: [...BASE_GRAPH.edges, edge(LAUNCHER_PATH, PLANNING_PATH)],
    });
    expect(launcherResult.findings).toContainEqual({
      code: "FORBIDDEN_DEPENDENCY",
      path: LAUNCHER_PATH,
      detail: `interface-observed-to-planning:${PLANNING_PATH}`,
    });
  });

  test("rejects a hypothetical Planning internal path until a later schema governs it", () => {
    const internalPath = "scripts/modules/planning/internal.ts";
    const manifest = {
      ...PLANNING_MANIFEST,
      rules: PLANNING_MANIFEST.rules.map((rule) =>
        rule.id === "legacy"
          ? {
              ...rule,
              exclusions: [
                ...(rule.exclusions ?? []),
                { kind: "exact" as const, path: internalPath },
              ],
            }
          : rule,
      ),
    };
    const result = evaluateArchitectureFitness(manifest, {
      files: [...PLANNING_FILES, internalPath],
      edges: [...BASE_GRAPH.edges, edge(FACADE_PATH, internalPath)],
    });

    expect(result.findings).toContainEqual({
      code: "UNCLASSIFIED_PATH",
      path: internalPath,
      detail: "no boundary rule",
    });
  });

  test("keeps Planning import-free for internal and external dependencies", () => {
    const result = evaluateArchitectureFitness(PLANNING_MANIFEST, {
      files: PLANNING_FILES,
      edges: [...BASE_GRAPH.edges, edge(PLANNING_PATH, "scripts/modules/contract.ts")],
      externalDependencies: [
        {
          from: PLANNING_PATH,
          specifier: "node:fs",
          syntax: "static-import",
          typeOnly: false,
          line: 1,
          column: 1,
        },
      ],
    });

    expect(result.findings).toContainEqual({
      code: "FORBIDDEN_DEPENDENCY",
      path: PLANNING_PATH,
      detail: `planning-import-free:scripts/modules/contract.ts`,
    });
    expect(result.findings).toContainEqual({
      code: "FORBIDDEN_DEPENDENCY",
      path: PLANNING_PATH,
      detail: "planning-import-free:external:node:fs",
    });
    expect(result.usedExceptionIds).toEqual(["OPENING-1"]);
  });

  test("rejects new debt and an outgoing contract-leaf edge", () => {
    const graph = {
      ...BASE_GRAPH,
      files: [...BASE_GRAPH.files, "scripts/modules/new.ts"],
      edges: [
        ...BASE_GRAPH.edges,
        edge("scripts/modules/new.ts", "scripts/commands/main.ts"),
        edge("scripts/modules/contract.ts", "scripts/modules/new.ts"),
      ],
    };
    const result = evaluateArchitectureFitness(BASE_MANIFEST, graph);

    expect(result.ok).toBe(false);
    expect(result.findings.map((item) => item.code)).toEqual([
      "FORBIDDEN_DEPENDENCY",
      "FORBIDDEN_DEPENDENCY",
    ]);
  });

  test("fails closed for an expired, retired, or non-opening exception", () => {
    for (const [exception, expectedCode] of [
      [
        { ...BASE_MANIFEST.exceptions[0]!, validThroughManifestVersion: 0 },
        "INVALID_EXCEPTION",
      ],
      [
        { ...BASE_MANIFEST.exceptions[0]!, reviewStatus: "retired" as const },
        "FORBIDDEN_DEPENDENCY",
      ],
      [
        {
          ...BASE_MANIFEST.exceptions[0]!,
          from: "scripts/modules/new.ts",
        },
        "INVALID_EXCEPTION",
      ],
    ] as const) {
      const manifest = { ...BASE_MANIFEST, exceptions: [exception] };
      const result = evaluateArchitectureFitness(manifest, BASE_GRAPH);
      expect(result.ok).toBe(false);
      expect(result.findings.some((item) => item.code === expectedCode)).toBe(true);
    }
  });

  test("applies wildcard leaf prohibitions to external dependencies", () => {
    const result = evaluateArchitectureFitness(BASE_MANIFEST, {
      ...BASE_GRAPH,
      externalDependencies: [
        {
          from: "scripts/modules/contract.ts",
          specifier: "node:fs",
          syntax: "static-import",
          typeOnly: false,
          line: 1,
          column: 1,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({
      code: "FORBIDDEN_DEPENDENCY",
      path: "scripts/modules/contract.ts",
      detail: "contract-leaf:external:node:fs",
    });
  });

  test("rejects ambiguous, unclassified, duplicate, and outside-graph paths", () => {
    const manifest: ArchitectureBoundaryManifest = {
      ...BASE_MANIFEST,
      rules: [
        ...BASE_MANIFEST.rules,
        {
          ...BASE_MANIFEST.rules[1]!,
          id: "overlap",
          exclusions: [],
        },
      ],
    };
    const graph: ArchitectureDependencyGraph = {
      files: [
        ...BASE_GRAPH.files,
        "scripts/modules/legacy.ts",
        "scripts/unknown.ts",
      ],
      edges: [
        ...BASE_GRAPH.edges,
        edge("scripts/modules/missing.ts", "scripts/commands/main.ts"),
      ],
    };
    const result = evaluateArchitectureFitness(manifest, graph);

    expect(result.ok).toBe(false);
    expect(new Set(result.findings.map((item) => item.code))).toEqual(
      new Set([
        "AMBIGUOUS_CLASSIFICATION",
        "DUPLICATE_PATH",
        "EDGE_OUTSIDE_GRAPH",
        "STALE_EXCEPTION",
        "UNCLASSIFIED_PATH",
      ]),
    );
  });

  test("detects direct, transitive, re-export-shaped, and self cycles deterministically", () => {
    const manifest: ArchitectureBoundaryManifest = {
      ...BASE_MANIFEST,
      openingEdges: [],
      exceptions: [],
    };
    const files = [
      "scripts/modules/a.ts",
      "scripts/modules/b.ts",
      "scripts/modules/c.ts",
      "scripts/modules/self.ts",
    ];
    const graph: ArchitectureDependencyGraph = {
      files,
      edges: [
        edge(files[0]!, files[1]!),
        { ...edge(files[1]!, files[2]!), syntax: "re-export" },
        edge(files[2]!, files[0]!),
        edge(files[3]!, files[3]!),
      ],
    };

    const first = evaluateArchitectureFitness(manifest, graph);
    const second = evaluateArchitectureFitness(manifest, {
      files: [...files].reverse(),
      edges: [...graph.edges].reverse(),
    });
    expect(first.cycles).toEqual([
      ["scripts/modules/a.ts", "scripts/modules/b.ts", "scripts/modules/c.ts"],
      ["scripts/modules/self.ts"],
    ]);
    expect(first).toEqual(second);
    expect(first.findings.filter((item) => item.code === "CYCLE")).toHaveLength(2);
  });

  test("requires a removed opening edge exception to be retired", () => {
    const stale = evaluateArchitectureFitness(BASE_MANIFEST, {
      ...BASE_GRAPH,
      edges: [],
    });
    expect(stale.ok).toBe(false);
    expect(stale.findings).toEqual([
      {
        code: "STALE_EXCEPTION",
        path: "manifest.exceptions.OPENING-1",
        detail: "accepted exception is unused",
      },
    ]);

    const retired = evaluateArchitectureFitness(
      {
        ...BASE_MANIFEST,
        exceptions: [
          {
            ...BASE_MANIFEST.exceptions[0]!,
            reviewStatus: "retired",
          },
        ],
      },
      { ...BASE_GRAPH, edges: [] },
    );
    expect(retired.ok).toBe(true);
    expect(retired.findings).toEqual([]);
  });

  test("rejects duplicate suppressions and an arbitrary opening revision", () => {
    const duplicate = evaluateArchitectureFitness(
      {
        ...BASE_MANIFEST,
        exceptions: [
          BASE_MANIFEST.exceptions[0]!,
          { ...BASE_MANIFEST.exceptions[0]!, id: "OPENING-2" },
        ],
      },
      BASE_GRAPH,
    );
    expect(duplicate.ok).toBe(false);
    expect(duplicate.findings.some((item) => item.code === "DUPLICATE_ID")).toBe(true);
    expect(
      duplicate.findings.some((item) => item.code === "FORBIDDEN_DEPENDENCY"),
    ).toBe(true);

    const wrongRevision = evaluateArchitectureFitness(
      {
        ...BASE_MANIFEST,
        openingRevision: "b".repeat(40),
        exceptions: [
          {
            ...BASE_MANIFEST.exceptions[0]!,
            openingRevision: "b".repeat(40),
            creationRevision: "b".repeat(40),
          },
        ],
      },
      BASE_GRAPH,
    );
    expect(wrongRevision.ok).toBe(false);
    expect(wrongRevision.findings).toContainEqual({
      code: "INVALID_MANIFEST",
      path: "manifest.openingRevision",
      detail: "must equal the governed opening revision",
    });
  });

  test("rejects malformed runtime structures without throwing", () => {
    for (const [manifest, graph, code] of [
      [{}, BASE_GRAPH, "INVALID_MANIFEST"],
      [{ ...BASE_MANIFEST, rules: "rules" }, BASE_GRAPH, "INVALID_MANIFEST"],
      [BASE_MANIFEST, {}, "INVALID_GRAPH"],
      [
        BASE_MANIFEST,
        {
          ...BASE_GRAPH,
          files: [...BASE_GRAPH.files, "C:/escape.ts"],
        },
        "INVALID_GRAPH",
      ],
      [
        BASE_MANIFEST,
        {
          ...BASE_GRAPH,
          externalDependencies: [
            {
              from: "scripts/modules/contract.ts",
              specifier: "node:fs\ninjected",
              syntax: "static-import",
              typeOnly: false,
              line: 1,
              column: 1,
            },
          ],
        },
        "INVALID_GRAPH",
      ],
    ] as const) {
      const result = evaluateArchitectureFitness(manifest, graph);
      expect(result.ok).toBe(false);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.code).toBe(code);
    }
  });
});
