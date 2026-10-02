import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  type JsonSchemaDocument,
  validateAgainstSubset,
} from "./helpers/json-schema-subset.ts";

const repoRoot = path.resolve(__dirname, "..");
const schemaRoot = path.join(repoRoot, "schema");
const staleSchemaTerms = [
  "example.com",
  "legacy-owner.invalid",
  "universal-skills",
  "@legacy-owner",
] as const;

function schemaFiles(): string[] {
  return fs
    .readdirSync(schemaRoot)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(schemaRoot, entry));
}

function relativePath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function parseSchema(filePath: string): JsonSchemaDocument {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonSchemaDocument;
}

function schemaIdFor(filePath: string): string {
  const schema = parseSchema(filePath);
  if (typeof schema.$id !== "string") {
    throw new Error(`${relativePath(filePath)} must define a string $id`);
  }
  return schema.$id;
}

function expectValid(schema: JsonSchemaDocument, value: unknown): void {
  expect(validateAgainstSubset(schema, value)).toEqual([]);
}

function expectInvalid(schema: JsonSchemaDocument, value: unknown): void {
  expect(validateAgainstSubset(schema, value).length).toBeGreaterThan(0);
}

describe("schema contract", () => {
  test("parses every schema JSON file", () => {
    const files = schemaFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const filePath of files) {
      expect(() => parseSchema(filePath)).not.toThrow();
    }
  });

  test("uses the neutral public schema id namespace", () => {
    for (const filePath of schemaFiles()) {
      expect(schemaIdFor(filePath)).toBe(`https://skill-sys.dev/schema/${path.basename(filePath)}`);
    }
  });

  test("rejects stale public schema text terms", () => {
    for (const filePath of schemaFiles()) {
      const text = fs.readFileSync(filePath, "utf8");
      for (const term of staleSchemaTerms) {
        expect(text.includes(term)).toBe(false);
      }
    }
  });

  test("schema subset validator enforces exact oneOf matches and Unicode code-point lengths", () => {
    expectValid({ oneOf: [{ const: "a" }, { const: "b" }] }, "a");
    expectInvalid({ oneOf: [{ const: "a" }, { const: "b" }] }, "c");
    expectInvalid({ oneOf: [{ const: "a" }, { const: "a" }] }, "a");
    expectValid({ type: "string", maxLength: 256 }, "😀".repeat(256));
    expectInvalid({ type: "string", maxLength: 256 }, "😀".repeat(257));
  });

  test("schema subset validator treats only own object properties as fields", () => {
    const exactObjectSchema: JsonSchemaDocument = {
      type: "object",
      required: ["safe"],
      properties: { safe: { type: "string" } },
      additionalProperties: false,
    };

    for (const key of ["__proto__", "constructor", "toString"]) {
      const candidate = JSON.parse(`{"${key}":{}}`) as unknown;
      expectInvalid(exactObjectSchema, candidate);
      expect(validateAgainstSubset(exactObjectSchema, candidate)).toContain("missing safe");
      expect(validateAgainstSubset(exactObjectSchema, candidate)).toContain(
        `unexpected ${key}`,
      );
    }
  });

  test("release manifest schema allows implemented source layout kinds", () => {
    const schema = parseSchema(path.join(schemaRoot, "release-manifest.schema.json"));
    const sourceLayout = schema.properties?.sourceLayout as {
      properties?: Record<string, unknown>;
    } | undefined;
    const kind = sourceLayout?.properties?.kind as { enum?: unknown[] } | undefined;

    expect(kind?.enum).toEqual(["flat", "monorepo-root", "nested-app", "skillpack"]);
  });

  test("lockfile schema exposes implemented projection digest policy fields", () => {
    const schema = parseSchema(path.join(schemaRoot, "lockfile.schema.json"));
    const policy = schema.properties?.policy as {
      properties?: Record<string, unknown>;
    } | undefined;
    const policyProperties = policy?.properties ?? {};
    expect(policyProperties).toHaveProperty("requireProjectionDigests");
    expect(policyProperties).toHaveProperty("expectedProjectionDigests");
    expect(policyProperties).toHaveProperty("allowGlobalCoreProjectSkills");

    const allowGlobalCoreProjectSkills = policyProperties.allowGlobalCoreProjectSkills as { type?: unknown };
    expect(allowGlobalCoreProjectSkills.type).toBe("boolean");

    const expectedProjectionDigests = policyProperties.expectedProjectionDigests as {
      items?: { required?: unknown[]; properties?: Record<string, unknown> };
    };
    expect(expectedProjectionDigests.items?.required).toEqual([
      "provider",
      "skill",
      "canonicalDigest",
      "projectionDigest",
      "rendererVersion",
    ]);
    expect(expectedProjectionDigests.items?.properties).toHaveProperty("projectionPath");

    const installs = schema.properties?.installs as {
      items?: { properties?: Record<string, unknown> };
    };
    const installMode = installs.items?.properties?.installMode as { enum?: unknown[] } | undefined;
    expect(installMode?.enum).toEqual(["projection", "copy"]);
  });

  test("lockfile install schema accepts projection/copy modes and rejects invalid or symlink modes", () => {
    const schema = parseSchema(path.join(schemaRoot, "lockfile.schema.json"));
    const installEntry = (schema.properties?.installs as JsonSchemaDocument).items as JsonSchemaDocument;

    expectValid(installEntry, { app: "codex", skills: ["example-skill"], installMode: "projection" });
    expectValid(installEntry, { app: "codex", skills: ["example-skill"], installMode: "copy" });
    expectValid(installEntry, { app: "codex", skills: ["example-skill"] });
    expectInvalid(installEntry, { app: "codex", skills: ["example-skill"], installMode: "symlink" });
    expectInvalid(installEntry, { app: "codex", skills: ["example-skill"], installMode: "raw" });
    expectInvalid(installEntry, { app: "codex", skills: ["example-skill"], installMode: true });
  });

  test("lockfile policy schema rejects unknown keys and wrong runtime policy types", () => {
    const schema = parseSchema(path.join(schemaRoot, "lockfile.schema.json"));
    const policy = schema.properties?.policy as JsonSchemaDocument;

    expectValid(policy, {
      allowGlobalCoreProjectSkills: true,
      requireProjectionDigests: true,
      expectedProjectionDigests: [
        {
          provider: "codex",
          skill: "example-skill",
          canonicalDigest: "a".repeat(64),
          projectionDigest: "b".repeat(64),
          rendererVersion: 1,
          projectionPath: "codex/example-skill",
        },
      ],
    });
    expectInvalid(policy, { allowGlobalCoreProjectSkills: "yes" });
    expectInvalid(policy, { unsupportedRuntimePolicy: true });
    expectInvalid(policy, {
      expectedProjectionDigests: [
        {
          provider: "codex",
          skill: "example-skill",
          canonicalDigest: "a".repeat(64),
          projectionDigest: "b".repeat(64),
          rendererVersion: "1",
        },
      ],
    });
  });

  test("lockfile schema models the optional sourceLock evidence binding", () => {
    const schema = parseSchema(path.join(schemaRoot, "lockfile.schema.json"));
    const sourceLock = schema.properties?.sourceLock as JsonSchemaDocument;

    expect(sourceLock.required).toEqual(["path", "sha256", "entryName"]);
    expect(sourceLock.additionalProperties).toBe(false);
    const properties = sourceLock.properties ?? {};
    expect((properties.sha256 as { pattern?: string }).pattern).toBe("^[A-Fa-f0-9]{64}$");

    const base = {
      repo: "https://example.invalid/skills.git",
      ref: "v1.2.3",
      installs: [{ app: "codex", skills: ["example-skill"] }],
      policy: {},
    };
    expectValid(schema, {
      ...base,
      sourceLock: { path: "evidence/sources.lock.json", sha256: "a".repeat(64), entryName: "example-skill" },
    });
    expectValid(schema, base);
    expectInvalid(schema, {
      ...base,
      sourceLock: { path: "evidence/sources.lock.json", sha256: "a".repeat(64) },
    });
    expectInvalid(schema, {
      ...base,
      sourceLock: { path: "evidence/sources.lock.json", sha256: "not-a-hash", entryName: "example-skill" },
    });
    expectInvalid(schema, {
      ...base,
      sourceLock: { path: "evidence/sources.lock.json", sha256: "a".repeat(64), entryName: "example-skill", extra: true },
    });
  });

  test("projection schemas model runtime metadata and reject extra or wrong-type fields", () => {
    const projectionMetaSchema = parseSchema(path.join(schemaRoot, "projection-meta.schema.json"));
    const projectionManifestSchema = parseSchema(path.join(schemaRoot, "projection-manifest.schema.json"));
    const projectionRecord = {
      provider: "codex",
      skill: "example-skill",
      origin: "public",
      canonicalPath: "skills/example-skill",
      projectionPath: "codex/example-skill",
      canonicalDigest: "a".repeat(64),
      projectionDigest: "b".repeat(64),
      rendererVersion: 1,
      manualOnly: true,
      risk: {
        readsFiles: false,
        writesProject: false,
        writesGlobal: false,
        executesShell: false,
        networkAccess: false,
        externalDirectory: false,
        credentialSensitive: false,
        destructive: false,
        browserAuthState: false,
        repoMutation: false,
      },
    };

    expectValid(projectionMetaSchema, projectionRecord);
    expectInvalid(projectionMetaSchema, { ...projectionRecord, manualOnly: "true" });
    expectInvalid(projectionMetaSchema, { ...projectionRecord, extraRuntimeField: true });
    expectInvalid(projectionMetaSchema, {
      ...projectionRecord,
      risk: { ...projectionRecord.risk, credentialSensitive: "no" },
    });

    expectValid(projectionManifestSchema, {
      schemaVersion: 1,
      rendererVersion: 1,
      providers: ["codex"],
      origins: ["public"],
      projectionCount: 1,
      generatedAt: "2026-06-08T00:00:00.000Z",
      projections: [projectionRecord],
      cache: { cachedCount: 0, rebuiltCount: 1, storeHitCount: 0 },
    });
    expectInvalid(projectionManifestSchema, {
      schemaVersion: 2,
      rendererVersion: 1,
      providers: ["codex"],
      origins: ["public"],
      projectionCount: 1,
      generatedAt: "2026-06-08T00:00:00.000Z",
      projections: [projectionRecord],
      cache: { cachedCount: 0, rebuiltCount: 1, storeHitCount: 0 },
    });
    expectInvalid(projectionManifestSchema, {
      schemaVersion: 1,
      rendererVersion: 1,
      providers: ["codex"],
      origins: ["private"],
      projectionCount: 1,
      generatedAt: "2026-06-08T00:00:00.000Z",
      projections: [projectionRecord],
      cache: { cachedCount: 0, rebuiltCount: 1, storeHitCount: 0 },
    });
    // Every emitted v1 manifest includes storeHitCount; omitting it is invalid.
    expectInvalid(projectionManifestSchema, {
      schemaVersion: 1,
      rendererVersion: 1,
      providers: ["codex"],
      origins: ["public"],
      projectionCount: 1,
      generatedAt: "2026-06-08T00:00:00.000Z",
      projections: [projectionRecord],
      cache: { cachedCount: 0, rebuiltCount: 1 },
    });
    expectInvalid(projectionManifestSchema, {
      schemaVersion: 1,
      rendererVersion: 1,
      providers: ["codex"],
      origins: ["public"],
      projectionCount: 1,
      generatedAt: "2026-06-08T00:00:00.000Z",
      projections: [projectionRecord],
      cache: { cachedCount: 0, rebuiltCount: 1, storeHitCount: -1 },
    });
  });

  test("skill eval schemas model fixture and result shapes", () => {
    const fixtureSchema = parseSchema(path.join(schemaRoot, "skill-evals.schema.json"));
    const resultSchema = parseSchema(path.join(schemaRoot, "eval-result.schema.json"));

    expectValid(fixtureSchema, {
      schemaVersion: 1,
      references: { skills: ["example-skill"], tools: ["file-read"] },
      baselines: { minCases: 1, maxCases: 10, passRate: 1, maxTokenOverhead: 100, maxDurationMs: 1000 },
      cases: [
        {
          id: "case-1",
          category: "positive",
          prompt: "Use the skill.",
          assertions: [{ kind: "regex", pattern: "example", target: "output" }],
        },
      ],
    });
    expectInvalid(fixtureSchema, { schemaVersion: 1, cases: [], extraField: true });
    expectInvalid(fixtureSchema, { schemaVersion: 1, cases: [{ id: "case-1", category: "bad", prompt: "x" }] });

    expectValid(resultSchema, {
      schemaVersion: 1,
      command: "eval-harness",
      status: "PASS",
      source: "/tmp/source",
      strict: false,
      skillCount: 1,
      fixtureCount: 1,
      caseCount: 1,
      findings: [],
    });
    expectInvalid(resultSchema, {
      schemaVersion: 1,
      command: "eval-harness",
      status: "PASS",
      source: "/tmp/source",
      strict: false,
      skillCount: 1,
      fixtureCount: 1,
      caseCount: 1,
      findings: [],
      extraField: true,
    });
  });

  test("value gate schemas model immutable evidence, policy, and local verdicts", () => {
    const baselineSchema = parseSchema(path.join(schemaRoot, "value-gate-results.schema.json"));
    const policySchema = parseSchema(path.join(schemaRoot, "value-gate-policy.schema.json"));
    const verdictSchema = parseSchema(path.join(schemaRoot, "value-gate-verdict.schema.json"));

    expectValid(baselineSchema, {
      schema_version: "value-gate-baseline/v1", baseline_id: "baseline-01", policy_version: "policy-v-01", receipt: {},
    });
    expectInvalid(baselineSchema, { schema_version: "value-gate-baseline/v1", baseline_id: "baseline-01", policy_version: "policy-v-01", receipt: {}, extra: true });
    expectValid(policySchema, {
      schema_version: "value-gate-policy/v1", policy_id: "policy-id-01", policy_version: "policy-v-01",
      binding: { sourceDigest: "a".repeat(64), fixtureDigest: "b".repeat(64), caseIds: ["case-01"], provider: "offline", model: "test-model" },
      tolerances: { pass_rate: { unit: "ratio", max_regression: 0 }, duration: { unit: "ms", max_regression: 1 }, token_overhead: { unit: "tokens", max_regression: 1 } },
    });
    expectInvalid(policySchema, { schema_version: "value-gate-policy/v1", policy_id: "policy-id-01", policy_version: "policy-v-01", binding: {}, tolerances: {} });

    expectValid(verdictSchema, {
      schema_version: "value-gate-verdict/v2",
      command: "value-gate",
      status: "PASS",
      receipt: "/tmp/receipt.json", baseline: "/tmp/baseline.json", policy: "/tmp/policy.json",
      compared_metrics: ["pass_rate", "duration", "token_overhead"],
      findings: [],
      release_authorized: false,
    });
    expectInvalid(verdictSchema, {
      schema_version: "value-gate-verdict/v2",
      command: "value-gate",
      status: "PASS",
      receipt: "/tmp/receipt.json", baseline: "/tmp/baseline.json", policy: "/tmp/policy.json",
      compared_metrics: [],
      findings: [],
      release_authorized: false,
      extraField: true,
    });
  });

  test("workflow chain schemas model declarative chains and verdicts", () => {
    const chainSchema = parseSchema(path.join(schemaRoot, "workflow-chain.schema.json"));
    const verdictSchema = parseSchema(path.join(schemaRoot, "workflow-chain-verdict.schema.json"));

    expectValid(chainSchema, {
      schemaVersion: 1,
      name: "release-readiness",
      description: "Plan release readiness.",
      gates: [{ id: "validate", command: ["bun", "run", "validate:local"] }],
      steps: [{ id: "review", skill: "example-skill", prompt: "Review.", requiredGates: ["validate"] }],
    });
    expectInvalid(chainSchema, { schemaVersion: 1, name: "bad", steps: [{ id: "../bad", skill: "example" }] });
    expectInvalid(chainSchema, { schemaVersion: 1, name: "bad", steps: [{ id: "one", skill: "example", extraField: true }] });

    expectValid(verdictSchema, {
      schemaVersion: 1,
      command: "workflow-chain",
      status: "PASS",
      source: "/tmp/source",
      workflow: "/tmp/source/workflow-chain.json",
      strict: false,
      workflowName: "release-readiness",
      stepCount: 1,
      gateCount: 1,
      plan: {
        gates: [{ id: "validate", command: ["bun", "run", "validate:local"] }],
        steps: [{ id: "review", skill: "example-skill", requiredGates: ["validate"] }],
      },
      findings: [],
    });
    expectInvalid(verdictSchema, {
      schemaVersion: 1,
      command: "workflow-chain",
      status: "PASS",
      source: "/tmp/source",
      workflow: "/tmp/source/workflow-chain.json",
      strict: false,
      workflowName: "release-readiness",
      stepCount: 1,
      gateCount: 1,
      plan: { gates: [], steps: [] },
      findings: [],
      extraField: true,
    });
  });

  test("routing schemas model rule files and route results", () => {
    const rulesSchema = parseSchema(path.join(schemaRoot, "routing-rules.schema.json"));
    const resultSchema = parseSchema(path.join(schemaRoot, "route-result.schema.json"));

    expectValid(rulesSchema, {
      schemaVersion: 1,
      name: "default",
      description: "Route common intents.",
      rules: [{ id: "docs", skill: "docs-skill", triggers: ["docs", "documentation"], priority: 5, manualOnly: false }],
    });
    expectInvalid(rulesSchema, { schemaVersion: 1, name: "bad", rules: [{ id: "../bad", skill: "docs", triggers: ["docs"] }] });
    expectInvalid(rulesSchema, { schemaVersion: 1, name: "bad", rules: [{ id: "docs", skill: "docs", triggers: ["docs"], extraField: true }] });

    expectValid(resultSchema, {
      schemaVersion: 1,
      command: "route",
      status: "PASS",
      source: "/tmp/source",
      rules: "/tmp/source/routing-rules.json",
      query: "write docs",
      strict: false,
      rulesName: "default",
      ruleCount: 1,
      candidateCount: 1,
      candidates: [{ rule: "docs", skill: "docs-skill", score: 6, matchedTriggers: ["docs"], manualOnly: false }],
      findings: [],
    });
    expectInvalid(resultSchema, {
      schemaVersion: 1,
      command: "route",
      status: "PASS",
      source: "/tmp/source",
      rules: "/tmp/source/routing-rules.json",
      query: "write docs",
      strict: false,
      rulesName: "default",
      ruleCount: 1,
      candidateCount: 1,
      candidates: [],
      findings: [],
      extraField: true,
    });
  });

  test("team mode schemas model config and validation result", () => {
    const configSchema = parseSchema(path.join(schemaRoot, "team-mode.schema.json"));
    const resultSchema = parseSchema(path.join(schemaRoot, "team-mode-result.schema.json"));

    expectValid(configSchema, {
      schemaVersion: 1,
      name: "default-team",
      description: "Shared policy.",
      lockfile: ".skills.lock.json",
      installMode: "projection",
      sharedConfig: true,
      adapters: ["codex", "opencode"],
      allowedProfiles: ["core"],
    });
    expectInvalid(configSchema, { schemaVersion: 1, name: "default-team", lockfile: ".skills.lock.json", installMode: "symlink", sharedConfig: true });
    expectInvalid(configSchema, { schemaVersion: 1, name: "default-team", lockfile: ".skills.lock.json", installMode: "projection", sharedConfig: true, skills: [] });

    expectValid(resultSchema, {
      schemaVersion: 1,
      command: "team-mode",
      status: "PASS",
      source: "/tmp/source",
      config: "/tmp/source/skill-sys.team.json",
      strict: false,
      teamName: "default-team",
      policy: {
        lockfile: ".skills.lock.json",
        installMode: "projection",
        sharedConfig: true,
        adapters: ["codex"],
        allowedProfiles: ["core"],
      },
      findings: [],
    });
    expectInvalid(resultSchema, {
      schemaVersion: 1,
      command: "team-mode",
      status: "PASS",
      source: "/tmp/source",
      config: "/tmp/source/skill-sys.team.json",
      strict: false,
      teamName: "default-team",
      policy: {
        lockfile: ".skills.lock.json",
        installMode: "projection",
        sharedConfig: true,
        adapters: [],
        allowedProfiles: [],
      },
      findings: [],
      extraField: true,
    });
  });

  test("dev mode schemas model local symlink configs and dry-run results", () => {
    const configSchema = parseSchema(path.join(schemaRoot, "dev-mode.schema.json"));
    const resultSchema = parseSchema(path.join(schemaRoot, "dev-mode-result.schema.json"));

    expectValid(configSchema, {
      schemaVersion: 1,
      name: "local-dev",
      description: "Local dev links.",
      devOnly: true,
      publicRelease: false,
      installMode: "symlink",
      allowSymlinks: true,
      links: [{ skill: "example-skill", target: ".agents/skills/example-skill" }],
    });
    expectInvalid(configSchema, { schemaVersion: 1, name: "local-dev", devOnly: false, publicRelease: false, installMode: "symlink", allowSymlinks: true, links: [] });
    expectInvalid(configSchema, { schemaVersion: 1, name: "local-dev", devOnly: true, publicRelease: true, installMode: "symlink", allowSymlinks: true, links: [] });

    expectValid(resultSchema, {
      schemaVersion: 1,
      command: "dev-mode",
      status: "PASS",
      source: "/tmp/source",
      config: "/tmp/source/skill-sys.dev.json",
      strict: false,
      devName: "local-dev",
      plan: {
        installMode: "symlink",
        devOnly: true,
        publicRelease: false,
        links: [{ skill: "example-skill", source: "skills/example-skill/SKILL.md", target: ".agents/skills/example-skill", action: "would-link" }],
      },
      findings: [],
    });
    expectInvalid(resultSchema, {
      schemaVersion: 1,
      command: "dev-mode",
      status: "PASS",
      source: "/tmp/source",
      config: "/tmp/source/skill-sys.dev.json",
      strict: false,
      devName: "local-dev",
      plan: { installMode: "symlink", devOnly: true, publicRelease: false, links: [] },
      findings: [],
      extraField: true,
    });
  });

  test("project learnings schemas model private local learnings and verdicts", () => {
    const learningsSchema = parseSchema(path.join(schemaRoot, "project-learnings.schema.json"));
    const resultSchema = parseSchema(path.join(schemaRoot, "project-learnings-result.schema.json"));

    expectValid(learningsSchema, {
      schemaVersion: 1,
      name: "local-learnings",
      description: "Local project notes.",
      visibility: "private",
      packageSurface: false,
      entries: [{ id: "use-bun", summary: "Use Bun scripts.", source: "local", tags: ["workflow"] }],
    });
    expectInvalid(learningsSchema, { schemaVersion: 1, name: "local-learnings", visibility: "public", packageSurface: false, entries: [] });
    expectInvalid(learningsSchema, { schemaVersion: 1, name: "local-learnings", visibility: "private", packageSurface: true, entries: [] });

    expectValid(resultSchema, {
      schemaVersion: 1,
      command: "project-learnings",
      status: "PASS",
      source: "/tmp/source",
      learnings: "/tmp/source/.skill-sys/project-learnings.json",
      strict: false,
      learningsName: "local-learnings",
      entryCount: 1,
      policy: { visibility: "private", packageSurface: false, localOnly: true },
      findings: [],
    });
    expectInvalid(resultSchema, {
      schemaVersion: 1,
      command: "project-learnings",
      status: "PASS",
      source: "/tmp/source",
      learnings: "/tmp/source/.skill-sys/project-learnings.json",
      strict: false,
      learningsName: "local-learnings",
      entryCount: 1,
      policy: { visibility: "private", packageSurface: false, localOnly: true },
      findings: [],
      extraField: true,
    });
  });

  test("project learnings write result schema models written, blocked, and dry-run outputs", () => {
    const writeResultSchema = parseSchema(path.join(schemaRoot, "project-learnings-write-result.schema.json"));
    const written = {
      schemaVersion: 1,
      command: "project-learnings",
      operation: "append",
      status: "written",
      written: true,
      source: "/tmp/source",
      learnings: "/tmp/source/.skill-sys/project-learnings.json",
      path: ".skill-sys/project-learnings.json",
      name: "local-learnings",
      id: "use-docs",
      entryCount: 2,
      dryRun: false,
      findings: [],
      output: "",
    };

    expectValid(writeResultSchema, written);

    expectValid(writeResultSchema, {
      ...written,
      operation: "update",
      status: "blocked",
      written: false,
      entryCount: 0,
      findings: [
        {
          level: "ERROR",
          code: "PROJECT_LEARNINGS_LOCKED",
          path: ".skill-sys/project-learnings.json",
          message: "learnings file is locked by another writer; retry",
        },
      ],
    });

    expectValid(writeResultSchema, {
      ...written,
      status: "dry-run",
      written: false,
      dryRun: true,
    });

    expectInvalid(writeResultSchema, { ...written, operation: "delete" });
    expectInvalid(writeResultSchema, { ...written, status: "failed" });
    expectInvalid(writeResultSchema, { ...written, written: "yes" });

    const { entryCount: _omittedEntryCount, ...missingEntryCount } = written;
    expectInvalid(writeResultSchema, missingEntryCount);

    const { findings: _omittedFindings, ...missingFindings } = written;
    expectInvalid(writeResultSchema, missingFindings);

    expectInvalid(writeResultSchema, { ...written, extraField: true });
  });

  test("memory adapter read and write result schemas model read, written, blocked, and dry-run outputs", () => {
    const readSchema = parseSchema(path.join(schemaRoot, "memory-adapter-read-result.schema.json"));
    const readBase = {
      schemaVersion: 1,
      command: "memory-adapter",
      operation: "read",
      status: "read",
      source: "/tmp/source",
      config: "/tmp/source/.skill-sys/memory-adapter.json",
      path: ".skill-sys/memory/local.jsonl",
      name: "local-memory",
      entryCount: 1,
      entries: [
        {
          id: "note-1",
          memory: "Use Bun for local validation.",
          source: "local",
          createdAt: "2026-08-15T00:00:00.000Z",
        },
      ],
      findings: [],
    };

    expectValid(readSchema, readBase);
    expectValid(readSchema, {
      ...readBase,
      status: "blocked",
      entryCount: 0,
      entries: [],
      findings: [
        {
          level: "ERROR",
          code: "MEMORY_ADAPTER_TYPE_UNSUPPORTED",
          path: ".skill-sys/memory-adapter.json",
          message: "memory adapter type 'sqlite' is not supported for memory adapter I/O",
        },
      ],
    });
    expectInvalid(readSchema, { ...readBase, operation: "write" });
    expectInvalid(readSchema, { ...readBase, status: "failed" });
    expectInvalid(readSchema, { ...readBase, entries: [{ id: "note-1", memory: "Missing fields." }] });

    const { entries: _omittedEntries, ...missingEntries } = readBase;
    expectInvalid(readSchema, missingEntries);

    expectInvalid(readSchema, { ...readBase, extraField: true });

    const writeSchema = parseSchema(path.join(schemaRoot, "memory-adapter-write-result.schema.json"));
    const written = {
      schemaVersion: 1,
      command: "memory-adapter",
      operation: "write",
      status: "written",
      written: true,
      source: "/tmp/source",
      config: "/tmp/source/.skill-sys/memory-adapter.json",
      path: ".skill-sys/memory/local.jsonl",
      name: "local-memory",
      id: "note-1",
      entryCount: 1,
      dryRun: false,
      findings: [],
      output: "",
    };

    expectValid(writeSchema, written);
    expectValid(writeSchema, {
      ...written,
      status: "blocked",
      written: false,
      entryCount: 0,
      findings: [
        {
          level: "ERROR",
          code: "MEMORY_ADAPTER_WRITE_MODE_REQUIRED",
          path: ".skill-sys/memory-adapter.json",
          message: "memory adapter writes require read-write mode",
        },
      ],
    });
    expectValid(writeSchema, {
      ...written,
      status: "dry-run",
      written: false,
      dryRun: true,
    });
    expectInvalid(writeSchema, { ...written, operation: "append" });
    expectInvalid(writeSchema, { ...written, status: "failed" });
    expectInvalid(writeSchema, { ...written, written: "yes" });

    const { entryCount: _omittedEntryCount, ...missingWriteEntryCount } = written;
    expectInvalid(writeSchema, missingWriteEntryCount);

    const { findings: _omittedWriteFindings, ...missingWriteFindings } = written;
    expectInvalid(writeSchema, missingWriteFindings);

    expectInvalid(writeSchema, { ...written, extraField: true });
  });

  test("memory adapter schemas model local private adapter input and output", () => {
    const adapterSchema = parseSchema(path.join(schemaRoot, "memory-adapter.schema.json"));
    const resultSchema = parseSchema(path.join(schemaRoot, "memory-adapter-result.schema.json"));

    expectValid(adapterSchema, {
      schemaVersion: 1,
      name: "local-memory",
      visibility: "private",
      packageSurface: false,
      adapter: { type: "jsonl", mode: "read-only", path: ".skill-sys/memory/local.jsonl" },
      trustPolicy: { readOptIn: true, writeOptIn: false, allowSensitiveMemory: false },
      allowedSkills: ["code-discovery"],
    });
    expectInvalid(adapterSchema, { schemaVersion: 1, name: "local-memory", visibility: "public", packageSurface: false, adapter: { type: "jsonl", mode: "read-only", path: ".skill-sys/memory/local.jsonl" }, trustPolicy: { readOptIn: true, writeOptIn: false, allowSensitiveMemory: false }, allowedSkills: [] });
    expectInvalid(adapterSchema, { schemaVersion: 1, name: "local-memory", visibility: "private", packageSurface: true, adapter: { type: "jsonl", mode: "read-only", path: ".skill-sys/memory/local.jsonl" }, trustPolicy: { readOptIn: true, writeOptIn: false, allowSensitiveMemory: false }, allowedSkills: [] });

    expectValid(resultSchema, {
      schemaVersion: 1,
      command: "memory-adapter",
      status: "PASS",
      source: "/tmp/source",
      config: "/tmp/source/.skill-sys/memory-adapter.json",
      strict: false,
      adapterName: "local-memory",
      adapter: { type: "jsonl", mode: "read-only", path: ".skill-sys/memory/local.jsonl" },
      policy: { visibility: "private", packageSurface: false, readOptIn: true, writeOptIn: false, allowSensitiveMemory: false },
      allowedSkillCount: 1,
      findings: [],
    });
    expectInvalid(resultSchema, {
      schemaVersion: 1,
      command: "memory-adapter",
      status: "PASS",
      source: "/tmp/source",
      config: "/tmp/source/.skill-sys/memory-adapter.json",
      strict: false,
      adapterName: "local-memory",
      adapter: { type: "jsonl", mode: "read-only", path: ".skill-sys/memory/local.jsonl" },
      policy: { visibility: "private", packageSurface: false, readOptIn: true, writeOptIn: false, allowSensitiveMemory: false },
      allowedSkillCount: 1,
      findings: [],
      extraField: true,
    });
  });

  test("registry export schemas model interop bundle and result output", () => {
    const bundleSchema = parseSchema(path.join(schemaRoot, "registry-export-bundle.schema.json"));
    const resultSchema = parseSchema(path.join(schemaRoot, "registry-export-result.schema.json"));
    const bundle = {
      schemaVersion: 1,
      format: "skill-sys-registry-export",
      registryName: "universall-skill-sys",
      baseUrl: "./registry/",
      metadata: { version: 1 },
      index: { version: 1 },
      channels: {
        next: { path: "registry/channels/next.json", sha256: "a".repeat(64), document: { version: 1 } },
      },
      advisories: { path: "registry/advisories/security-status.json", sha256: "b".repeat(64), document: { version: 1 } },
      artifacts: [{ path: "registry/index.json", sha256: "c".repeat(64), kind: "index" }],
    };

    expectValid(bundleSchema, bundle);
    expectInvalid(bundleSchema, { ...bundle, extraField: true });
    expectInvalid(bundleSchema, { ...bundle, artifacts: [{ path: "registry/index.json", sha256: "c".repeat(64), kind: "unknown" }] });

    expectValid(resultSchema, {
      schemaVersion: 1,
      command: "registry-export",
      status: "PASS",
      source: "/tmp/source",
      strict: false,
      bundle,
      findings: [],
    });
    expectInvalid(resultSchema, {
      schemaVersion: 1,
      command: "registry-export",
      status: "PASS",
      source: "/tmp/source",
      strict: false,
      bundle,
      findings: [],
      extraField: true,
    });
  });

  test("registry import result schema models offline unverified provenance output", () => {
    const resultSchema = parseSchema(path.join(schemaRoot, "registry-import-result.schema.json"));
    const result = {
      schemaVersion: 1,
      command: "registry-import",
      status: "PASS",
      bundle: "/tmp/registry-bundle.json",
      output: "/tmp/imported-registry",
      strict: false,
      format: "skill-sys-registry-export",
      registryName: "universall-skill-sys",
      provenance: "UNVERIFIED",
      files: ["registry/index.json"],
      findings: [],
    };

    expectValid(resultSchema, result);
    expectInvalid(resultSchema, { ...result, provenance: "TRUSTED" });
    expectInvalid(resultSchema, { ...result, extraField: true });
  });

  test("registry trust schemas model local scorecard and trust result output", () => {
    const scorecardSchema = parseSchema(path.join(schemaRoot, "registry-trust-scorecard.schema.json"));
    const resultSchema = parseSchema(path.join(schemaRoot, "registry-trust-result.schema.json"));
    const scorecard = {
      schemaVersion: 1,
      name: "release-trust",
      thresholds: { minScore: 80 },
      signals: [{ id: "signed-ref", category: "signed-ref", status: "pass", weight: 25, evidence: "signed tag verified" }],
    };

    expectValid(scorecardSchema, scorecard);
    expectInvalid(scorecardSchema, { ...scorecard, extraField: true });
    expectInvalid(scorecardSchema, { ...scorecard, thresholds: { minScore: 101 } });
    expectInvalid(scorecardSchema, { ...scorecard, signals: [{ id: "bad", category: "unknown", status: "pass", weight: 25, evidence: "x" }] });

    expectValid(resultSchema, {
      schemaVersion: 1,
      command: "registry-trust",
      status: "CONCERNS",
      source: "/tmp/source",
      scorecard: "/tmp/scorecard.json",
      strict: false,
      scorecardName: "release-trust",
      score: 80,
      threshold: 80,
      registrySurface: { status: "PASS" },
      signals: [{ id: "signed-ref" }],
      findings: [{ level: "WARN", code: "REGISTRY_TRUST_SIGNAL_WARNING", signal: "docs", message: "docs warning" }],
    });
    expectInvalid(resultSchema, {
      schemaVersion: 1,
      command: "registry-trust",
      status: "UNKNOWN",
      source: "/tmp/source",
      scorecard: "/tmp/scorecard.json",
      strict: false,
      scorecardName: "release-trust",
      score: 80,
      threshold: 80,
      registrySurface: { status: "PASS" },
      signals: [],
      findings: [],
    });
  });

  test("telemetry policy schemas model local opt-in policy and result output", () => {
    const policySchema = parseSchema(path.join(schemaRoot, "telemetry-policy.schema.json"));
    const resultSchema = parseSchema(path.join(schemaRoot, "telemetry-policy-result.schema.json"));
    const policy = {
      schemaVersion: 1,
      name: "local-telemetry-policy",
      visibility: "private",
      packageSurface: false,
      collection: { enabled: false, explicitOptIn: false, approvedBy: "" },
      transports: { remoteUrls: [], localOnly: true },
      allowedSkills: ["registry-trust"],
    };

    expectValid(policySchema, policy);
    expectInvalid(policySchema, { ...policy, extraField: true });
    expectInvalid(policySchema, { ...policy, visibility: "public" });
    expectInvalid(policySchema, { ...policy, packageSurface: true });

    expectValid(resultSchema, {
      schemaVersion: 1,
      command: "telemetry-policy",
      status: "CONCERNS",
      source: "/tmp/source",
      config: "/tmp/source/.skill-sys/telemetry-policy.json",
      strict: false,
      policyName: "local-telemetry-policy",
      collection: { enabled: false, explicitOptIn: false, approvedBy: "" },
      transports: { remoteUrls: [], localOnly: true },
      allowedSkillCount: 1,
      findings: [{ level: "WARN", code: "TELEMETRY_POLICY_NO_ALLOWED_SKILLS", message: "warning" }],
    });
    expectInvalid(resultSchema, {
      schemaVersion: 1,
      command: "telemetry-policy",
      status: "UNKNOWN",
      source: "/tmp/source",
      config: "/tmp/source/.skill-sys/telemetry-policy.json",
      strict: false,
      policyName: "local-telemetry-policy",
      collection: {},
      transports: {},
      allowedSkillCount: 0,
      findings: [],
    });
  });

  test("catalog search result schema models the inactive revision-1 candidate", () => {
    const schema = parseSchema(path.join(schemaRoot, "catalog-search-result.schema.json"));
    const metadata = schema as JsonSchemaDocument & Record<string, unknown>;
    expect(metadata["x-skill-sys-schema-version"]).toBe("1");
    expect(metadata["x-skill-sys-logical-id"]).toBe("schema:skill-sys/catalog-search-result");
    expect(metadata["x-skill-sys-revision"]).toBe("1");

    const summary = {
      name: "example-skill",
      description: "",
      category: "",
      tags: ["example"],
      triggers: ["example"],
      version: "",
      updated_at: "",
      target_provider: "",
      path: "skills/example-skill",
      profiles: [],
      profile_metadata: [],
      internal: false,
      experimental: false,
    };
    const success = {
      schemaVersion: 1,
      operation: "catalog.skills.search",
      status: "success",
      data: { total: 1, returned: 1, items: [summary] },
      error: null,
    };
    const failure = (
      code: string,
      message: string,
      details: Record<string, unknown>,
      retryable: boolean
    ): Record<string, unknown> => ({
      schemaVersion: 1,
      operation: "catalog.skills.search",
      status: "failure",
      data: null,
      error: { code, message, details, retryable },
    });

    expectValid(schema, success);
    expectValid(schema, {
      ...success,
      data: { total: 0, returned: 0, items: [] },
    });
    const maxLengthSummary = {
      ...summary,
      name: "n".repeat(256),
      description: "d".repeat(8192),
      category: "c".repeat(1024),
      tags: ["t".repeat(256)],
      triggers: ["r".repeat(256)],
      version: "v".repeat(1024),
      updated_at: "u".repeat(1024),
      target_provider: "p".repeat(1024),
      path: "x".repeat(4096),
      profiles: ["p".repeat(256)],
      profile_metadata: [{
        name: "p".repeat(256),
        description: "d".repeat(8192),
        curation: "c".repeat(1024),
        scope: "s".repeat(1024),
      }],
    };
    expectValid(schema, {
      ...success,
      data: { total: 1, returned: 1, items: [maxLengthSummary] },
    });
    expectValid(schema, {
      ...success,
      data: {
        total: 1,
        returned: 1,
        items: [{
          ...summary,
          tags: Array(128).fill("tag"),
          triggers: Array(128).fill("trigger"),
          profiles: Array(1024).fill("core"),
          profile_metadata: Array(1024).fill({ name: "core" }),
        }],
      },
    });

    const invalidArgumentFields = [
      "arguments",
      "contract",
      "queries",
      "categories",
      "tags",
      "profiles",
      "limit",
      "includeInternal",
      "includeExperimental",
      "positionals",
    ] as const;
    const allowedInvalidArgumentFields = {
      unknown_option: ["arguments"],
      missing_value: ["contract", "queries", "categories", "tags", "profiles", "limit"],
      invalid_type: ["limit", "includeInternal", "includeExperimental"],
      out_of_range: ["limit"],
      too_many_occurrences: [
        "queries",
        "categories",
        "tags",
        "profiles",
        "limit",
        "includeInternal",
        "includeExperimental",
      ],
      too_many_items: ["queries", "categories", "tags", "profiles"],
      item_too_large: ["queries", "categories", "tags", "profiles"],
      aggregate_too_large: ["arguments"],
      unsafe_name: ["profiles"],
      unsupported_contract: ["contract"],
      duplicate_contract_selector: ["contract"],
      positional_unsupported: ["positionals"],
    } as const;
    for (const [reason, allowedFields] of Object.entries(allowedInvalidArgumentFields)) {
      for (const field of invalidArgumentFields) {
        const value = failure(
          "INVALID_ARGUMENT",
          "Invalid catalog search argument.",
          { field, reason },
          false
        );
        if ((allowedFields as readonly string[]).includes(field)) {
          expectValid(schema, value);
        } else {
          expectInvalid(schema, value);
        }
      }
    }

    const permanentCatalogReadReasons = [
      "source_missing",
      "source_unreadable",
      "invalid_catalog",
      "catalog_limit_exceeded",
      "profile_limit_exceeded",
      "field_limit_exceeded",
    ] as const;
    const otherFailures = [
      failure(
        "PERMISSION_DENIED",
        "Catalog search permission denied.",
        { permission: "catalog.skills.read" },
        false
      ),
      failure(
        "PERMISSION_DENIED",
        "Catalog search permission denied.",
        { permission: "catalog.skills.hidden.read" },
        false
      ),
      failure(
        "PROFILE_NOT_FOUND",
        "Catalog search profile not found.",
        { profile: "core" },
        false
      ),
      ...permanentCatalogReadReasons.map((reason) =>
        failure(
          "CATALOG_READ_FAILED",
          "Catalog search data could not be read.",
          { reason },
          false
        )
      ),
      failure(
        "CATALOG_READ_FAILED",
        "Catalog search data could not be read.",
        { reason: "temporarily_unavailable" },
        true
      ),
      failure(
        "RESULT_TOO_LARGE",
        "Catalog search result is too large.",
        { maxBytes: 1048576 },
        false
      ),
      failure(
        "DEADLINE_EXCEEDED",
        "Catalog search deadline exceeded.",
        { reason: "deadline_exceeded" },
        true
      ),
      failure(
        "INTERNAL_ERROR",
        "Catalog search failed.",
        { correlationId: "err_abcdefghijklmnopqrstuvwxyz" },
        false
      ),
    ];
    for (const value of otherFailures) {
      expectValid(schema, value);
    }

    expectInvalid(schema, { ...success, operation: "catalog.skills.list" });
    expectInvalid(schema, { ...success, schemaVersion: 2 });
    expectInvalid(schema, { ...success, status: "partial" });
    expectInvalid(schema, { ...success, extra: true });
    expectInvalid(schema, { ...success, error: otherFailures.at(-1)?.error });
    expectInvalid(schema, {
      schemaVersion: 1,
      operation: "catalog.skills.search",
      status: "success",
      data: { total: 0, returned: 0, items: [] },
    });
    expectInvalid(schema, { ...otherFailures[0], data: success.data });
    expectInvalid(schema, { ...success, data: { total: -1, returned: 0, items: [] } });
    expectInvalid(schema, { ...success, data: { total: 10001, returned: 0, items: [] } });
    expectInvalid(schema, { ...success, data: { total: 1, returned: 201, items: [] } });
    expectValid(schema, {
      ...success,
      data: { total: 10000, returned: 200, items: Array(200).fill(summary) },
    });
    expectInvalid(schema, {
      ...success,
      data: { total: 10000, returned: 200, items: Array(201).fill(summary) },
    });
    expectInvalid(schema, {
      ...success,
      data: { total: 129, returned: 1, items: [{ ...summary, tags: Array(129).fill("tag") }] },
    });
    expectInvalid(schema, {
      ...success,
      data: { total: 1, returned: 1, items: [{ ...summary, triggers: Array(129).fill("trigger") }] },
    });
    expectInvalid(schema, {
      ...success,
      data: { total: 1, returned: 1, items: [{ ...summary, name: "n".repeat(257) }] },
    });
    expectInvalid(schema, {
      ...success,
      data: { total: 1, returned: 1, items: [{ ...summary, name: "" }] },
    });
    expectInvalid(schema, {
      ...success,
      data: { total: 1, returned: 1, items: [{ ...summary, description: "d".repeat(8193) }] },
    });
    for (const field of ["category", "version", "updated_at", "target_provider"] as const) {
      expectInvalid(schema, {
        ...success,
        data: { total: 1, returned: 1, items: [{ ...summary, [field]: "x".repeat(1025) }] },
      });
    }
    expectInvalid(schema, {
      ...success,
      data: { total: 1, returned: 1, items: [{ ...summary, tags: ["t".repeat(257)] }] },
    });
    expectInvalid(schema, {
      ...success,
      data: { total: 1, returned: 1, items: [{ ...summary, triggers: ["t".repeat(257)] }] },
    });
    expectInvalid(schema, {
      ...success,
      data: { total: 1, returned: 1, items: [{ ...summary, profiles: Array(1025).fill("core") }] },
    });
    expectInvalid(schema, {
      ...success,
      data: { total: 1, returned: 1, items: [{ ...summary, profiles: ["p".repeat(257)] }] },
    });
    expectInvalid(schema, {
      ...success,
      data: { total: 1, returned: 1, items: [{ ...summary, profiles: ["."] }] },
    });
    expectInvalid(schema, {
      ...success,
      data: {
        total: 1,
        returned: 1,
        items: [{ ...summary, profile_metadata: Array(1025).fill({ name: "core" }) }],
      },
    });
    expectInvalid(schema, {
      ...success,
      data: {
        total: 1,
        returned: 1,
        items: [{ ...summary, profile_metadata: [{ name: "core", extra: true }] }],
      },
    });
    expectInvalid(schema, {
      ...success,
      data: {
        total: 1,
        returned: 1,
        items: [{
          ...summary,
          profile_metadata: [{ name: "core", description: "d".repeat(8193) }],
        }],
      },
    });
    for (const field of ["curation", "scope"] as const) {
      expectInvalid(schema, {
        ...success,
        data: {
          total: 1,
          returned: 1,
          items: [{
            ...summary,
            profile_metadata: [{ name: "core", [field]: "x".repeat(1025) }],
          }],
        },
      });
    }
    expectInvalid(schema, {
      ...success,
      data: { total: 1, returned: 1, items: [{ ...summary, path: "../private" }] },
    });
    for (const unsafePath of [
      "/absolute",
      "C:drive",
      "skills\\example",
      "skills//example",
      "skills/example/",
      "skills/../private",
      "skills/\u0085private",
      "x".repeat(4097),
    ]) {
      expectInvalid(schema, {
        ...success,
        data: { total: 1, returned: 1, items: [{ ...summary, path: unsafePath }] },
      });
    }
    expectInvalid(
      schema,
      failure(
        "INVALID_ARGUMENT",
        "Invalid catalog search argument.",
        { field: "profiles", reason: "out_of_range" },
        false
      )
    );
    expectInvalid(
      schema,
      failure(
        "CATALOG_READ_FAILED",
        "Catalog search data could not be read.",
        { reason: "source_missing" },
        true
      )
    );
    expectInvalid(
      schema,
      failure(
        "CATALOG_READ_FAILED",
        "Catalog search data could not be read.",
        { reason: "temporarily_unavailable" },
        false
      )
    );
    expectInvalid(
      schema,
      failure(
        "PERMISSION_DENIED",
        "Catalog search permission denied.",
        { permission: "catalog.skills.write" },
        false
      )
    );
    for (const unsafeProfile of [".", "..", "nested/core", "nested\\core"]) {
      expectInvalid(
        schema,
        failure(
          "PROFILE_NOT_FOUND",
          "Catalog search profile not found.",
          { profile: unsafeProfile },
          false
        )
      );
    }
    expectInvalid(
      schema,
      failure(
        "RESULT_TOO_LARGE",
        "Catalog search result is too large.",
        { maxBytes: 1048575 },
        false
      )
    );
    expectInvalid(
      schema,
      failure(
        "DEADLINE_EXCEEDED",
        "Catalog search deadline exceeded.",
        { reason: "cancelled" },
        true
      )
    );
    expectInvalid(
      schema,
      failure(
        "PERMISSION_DENIED",
        "Permission denied.",
        { permission: "catalog.skills.read" },
        false
      )
    );
    expectInvalid(
      schema,
      failure(
        "UNKNOWN_ERROR",
        "Catalog search failed.",
        { correlationId: "err_abcdefghijklmnopqrstuvwxyz" },
        false
      )
    );
    expectInvalid(
      schema,
      failure(
        "RESULT_TOO_LARGE",
        "Catalog search result is too large.",
        { maxBytes: 1048576, extra: true },
        false
      )
    );
    expectInvalid(
      schema,
      failure("INTERNAL_ERROR", "Catalog search failed.", { correlationId: "bad" }, false)
    );
  });

  test("skill card schema models the generated card shape", () => {
    const schema = parseSchema(path.join(schemaRoot, "skill-card.schema.json"));
    expect(schema.required).toEqual([
      "name",
      "description",
      "useWhen",
      "category",
      "tags",
      "triggers",
      "targetProvider",
      "providerSupport",
      "risk",
      "examples",
      "sourcePath",
    ]);

    const validCard = {
      name: "example-skill",
      description: "Use when demonstrating.",
      useWhen: "Use when demonstrating.",
      category: "examples",
      tags: ["example"],
      triggers: ["example"],
      targetProvider: "universal",
      providerSupport: { targetProvider: "universal", compatible: [] },
      risk: { destructive: false },
      examples: [],
      sourcePath: "skills/example-skill/SKILL.md",
    };
    expectValid(schema, validCard);
    // Extra keys are rejected.
    expectInvalid(schema, { ...validCard, extraField: true });
    // sourcePath must be anchored under skills/.
    expectInvalid(schema, { ...validCard, sourcePath: "other/path/SKILL.md" });
    // Missing required field.
    expectInvalid(schema, { ...validCard, risk: undefined });
    // providerSupport must be an object with the right shape.
    expectInvalid(schema, { ...validCard, providerSupport: "universal" });
  });
});
