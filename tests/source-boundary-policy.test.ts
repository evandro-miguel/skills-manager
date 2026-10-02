import { describe, expect, test } from "bun:test";
import path from "node:path";
import manifestJson from "../scripts/modules/skill-sys/architecture-boundaries.v5.json";
import {
  parseArchitectureBoundaryManifest,
  type ArchitectureDependencyGraph,
} from "../scripts/modules/skill-sys/architecture-fitness.ts";
import { scanArchitectureGraph } from "./helpers/architecture-graph.ts";

const repoRoot = path.resolve(__dirname, "..");
const SOURCE_PATH = "scripts/modules/source/propose-source-registration.ts";
const TYPED_CONTENT_PATH =
  "scripts/modules/skill-sys/typed-content-identity.ts";
const LEGACY_PATH = "scripts/modules/legacy.ts";
const COMMAND_PATH = "scripts/commands/source.ts";

function edge(
  from: string,
  to: string,
  overrides: Partial<ArchitectureDependencyGraph["edges"][number]> = {},
): ArchitectureDependencyGraph["edges"][number] {
  return {
    from,
    to,
    specifier: "./target.ts",
    syntax: "static-import",
    typeOnly: false,
    line: 1,
    column: 1,
    ...overrides,
  };
}

function graph(
  edges: readonly ArchitectureDependencyGraph["edges"][number][],
  externalDependencies: ArchitectureDependencyGraph["externalDependencies"] = [],
): ArchitectureDependencyGraph {
  return {
    files: [SOURCE_PATH, TYPED_CONTENT_PATH, LEGACY_PATH, COMMAND_PATH],
    edges,
    externalDependencies,
  };
}

function sourceBoundaryViolations(
  candidateGraph: ArchitectureDependencyGraph,
): string[] {
  if (!candidateGraph.files.includes(SOURCE_PATH)) return [];
  const outgoing = candidateGraph.edges.filter((edge) => edge.from === SOURCE_PATH);
  const incoming = candidateGraph.edges.filter((edge) => edge.to === SOURCE_PATH);
  const external = (candidateGraph.externalDependencies ?? []).filter(
    (dependency) => dependency.from === SOURCE_PATH,
  );
  const allowedOutgoing =
    outgoing.length === 1 &&
    outgoing[0]!.to === TYPED_CONTENT_PATH &&
    outgoing[0]!.syntax === "static-import" &&
    outgoing[0]!.typeOnly === false;
  const violations: string[] = [];
  if (!allowedOutgoing) {
    violations.push("must import only typed-content-identity at runtime");
  }
  if (incoming.length !== 0) violations.push("must have no production consumers");
  if (external.length !== 0) violations.push("must have no external dependencies");
  return violations;
}

describe("source-boundary-policy", () => {
  test("keeps the active Source target exact and excluded from the legacy prefix", () => {
    const parsed = parseArchitectureBoundaryManifest(manifestJson);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(
      parsed.value.rules.find((rule) => rule.id === "source-public-target"),
    ).toMatchObject({
      selector: { kind: "exact", path: SOURCE_PATH },
      classification: "source-public-target",
      owner: "Source / F-05",
      visibility: "public-in-engine",
      effect: "pure",
      lifecycle: "active",
    });
    expect(
      parsed.value.rules
        .find((rule) => rule.id === "legacy-modules-observed")
        ?.exclusions,
    ).toContainEqual({ kind: "exact", path: SOURCE_PATH });
  });

  test("keeps the gate dormant before F-05 and activates it from the real graph later", () => {
    const currentGraph = scanArchitectureGraph({ repoRoot });
    const sourceExists = currentGraph.files.includes(SOURCE_PATH);
    expect(sourceBoundaryViolations(currentGraph)).toEqual([]);
    if (!sourceExists) {
      expect(currentGraph.edges.some((edge) => edge.from === SOURCE_PATH)).toBe(false);
      expect(currentGraph.edges.some((edge) => edge.to === SOURCE_PATH)).toBe(false);
    }
  });

  test("allows exactly one runtime import of the F-02.02 contract leaf", () => {
    expect(
      sourceBoundaryViolations(graph([edge(SOURCE_PATH, TYPED_CONTENT_PATH)])),
    ).toEqual([]);
  });

  test("rejects other internal targets, import forms, external dependencies, and consumers", () => {
    const cases: readonly [string, ArchitectureDependencyGraph, string][] = [
      [
        "legacy target",
        graph([edge(SOURCE_PATH, LEGACY_PATH)]),
        "must import only typed-content-identity at runtime",
      ],
      [
        "re-export",
        graph([
          edge(SOURCE_PATH, TYPED_CONTENT_PATH, { syntax: "re-export" }),
        ]),
        "must import only typed-content-identity at runtime",
      ],
      [
        "type-only import",
        graph([edge(SOURCE_PATH, TYPED_CONTENT_PATH, { typeOnly: true })]),
        "must import only typed-content-identity at runtime",
      ],
      [
        "CommonJS require",
        graph([
          edge(SOURCE_PATH, TYPED_CONTENT_PATH, {
            syntax: "commonjs-require",
          }),
        ]),
        "must import only typed-content-identity at runtime",
      ],
      [
        "dynamic import",
        graph([
          edge(SOURCE_PATH, TYPED_CONTENT_PATH, { syntax: "dynamic-import" }),
        ]),
        "must import only typed-content-identity at runtime",
      ],
      [
        "duplicate dependency",
        graph([
          edge(SOURCE_PATH, TYPED_CONTENT_PATH),
          edge(SOURCE_PATH, TYPED_CONTENT_PATH, { line: 2 }),
        ]),
        "must import only typed-content-identity at runtime",
      ],
      [
        "external dependency",
        graph([edge(SOURCE_PATH, TYPED_CONTENT_PATH)], [
          {
            from: SOURCE_PATH,
            specifier: "node:fs",
            syntax: "static-import",
            typeOnly: false,
            line: 1,
            column: 1,
          },
        ]),
        "must have no external dependencies",
      ],
      [
        "production consumer",
        graph([
          edge(SOURCE_PATH, TYPED_CONTENT_PATH),
          edge(COMMAND_PATH, SOURCE_PATH),
        ]),
        "must have no production consumers",
      ],
    ];

    for (const [label, candidateGraph, violation] of cases) {
      expect(sourceBoundaryViolations(candidateGraph), label).toContain(violation);
    }
  });
});
