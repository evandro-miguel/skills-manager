import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

const providersModule = require("../scripts/modules/skillpool/providers.ts") as typeof import("../scripts/modules/skillpool/providers.ts");
const matrixCommand = require("../scripts/commands/generate-provider-matrix.ts") as typeof import("../scripts/commands/generate-provider-matrix.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");
const registry = require("../scripts/modules/skill-sys/command-registry.ts") as typeof import("../scripts/modules/skill-sys/command-registry.ts");

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function makeTempRoot(prefix: string): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function providerFiles(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, "providers"))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
}

describe("provider matrix v2 metadata", () => {
  test("every provider manifest declares displayName and a valid detectionPaths map", () => {
    const providerSchema = readJson("schema/provider.schema.json") as {
      properties: { detectionPaths: { properties: Record<string, unknown> } };
    };
    const allowedDetectionKeys = new Set(Object.keys(providerSchema.properties.detectionPaths.properties));

    for (const file of providerFiles()) {
      const manifest = readJson(path.join("providers", file)) as {
        provider: string;
        displayName?: unknown;
        detectionPaths?: unknown;
      };
      expect(typeof manifest.displayName).toBe("string");
      expect((manifest.displayName as string).trim().length).toBeGreaterThan(0);

      expect(manifest.detectionPaths).toBeDefined();
      const detectionPaths = manifest.detectionPaths as Record<string, unknown>;
      expect(manifest.detectionPaths).not.toBeNull();
      expect(typeof detectionPaths).toBe("object");
      expect(Array.isArray(detectionPaths)).toBe(false);
      const detectionEntries = Object.entries(detectionPaths);
      expect(detectionEntries.length).toBeGreaterThan(0);
      for (const [key, value] of detectionEntries) {
        expect(allowedDetectionKeys.has(key)).toBe(true);
        expect(typeof value).toBe("string");
        expect((value as string).trim().length).toBeGreaterThan(0);
      }
    }
  });

  test("provider schema models displayName and detectionPaths while keeping additionalProperties false", () => {
    const providerSchema = readJson("schema/provider.schema.json") as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(providerSchema.additionalProperties).toBe(false);
    expect(providerSchema.properties).toHaveProperty("displayName");
    expect(providerSchema.properties).toHaveProperty("detectionPaths");
  });

  test("normalizer preserves displayName and detectionPaths and stays lenient when absent", () => {
    const preserved = providersModule.normalizeProviderCapability(
      {
        provider: "codex",
        displayName: "Codex",
        skillPaths: { project: ".agents/skills" },
        detectionPaths: { project: ".codex", user: "~/.codex" },
        supports: { description: true },
        dangerNotes: [],
      },
      "fixture",
    );
    expect(preserved.displayName).toBe("Codex");
    expect(preserved.detectionPaths).toEqual({ project: ".codex", user: "~/.codex" });

    const lenient = providersModule.normalizeProviderCapability(
      {
        provider: "codex",
        skillPaths: { project: ".agents/skills" },
        supports: { description: true },
        dangerNotes: [],
      },
      "fixture",
    );
    expect(lenient).not.toHaveProperty("displayName");
    expect(lenient).not.toHaveProperty("detectionPaths");
  });
});

describe("generated provider matrix docs", () => {
  test("generateMatrixBody is deterministic and includes provider ids and display names", () => {
    const body = matrixCommand.generateMatrixBody(repoRoot);
    expect(matrixCommand.generateMatrixBody(repoRoot)).toBe(body);

    const codex = readJson(path.join("providers", "codex.json")) as { displayName: string };
    const opencode = readJson(path.join("providers", "opencode.json")) as { displayName: string };
    expect(body).toContain("`codex`");
    expect(body).toContain(codex.displayName);
    expect(body).toContain("`opencode`");
    expect(body).toContain(opencode.displayName);

    // Deterministic, host-independent: no timestamps or absolute host paths leak in.
    expect(body).not.toMatch(/\b20\d{2}-\d{2}-\d{2}T/);
    expect(body).not.toContain(os.tmpdir());
  });

  test("generateMatrixBody renders provider rows with leading and trailing pipes", () => {
    const body = matrixCommand.generateMatrixBody(repoRoot);

    expect(body).not.toMatch(/^`[^`]+`\s+\|/m);
    expect(body).toMatch(/^\| `codex` \|.*\|$/m);
    expect(body).toMatch(/^\| `opencode` \|.*\|$/m);
  });

  test("renderMatrixSection wraps the body with stable markers", () => {
    const section = matrixCommand.renderMatrixSection(repoRoot);
    expect(section.startsWith(matrixCommand.MATRIX_BEGIN)).toBe(true);
    expect(section.trimEnd().endsWith(matrixCommand.MATRIX_END)).toBe(true);
    expect(section).toContain(matrixCommand.generateMatrixBody(repoRoot));
  });

  test("injectMatrixSection replaces the bounded section and is idempotent", () => {
    const section = matrixCommand.renderMatrixSection(repoRoot);
    const seed = `# Doc\n\nintro\n\n${section}\n\ntail\n`;
    const once = matrixCommand.injectMatrixSection(seed, section);
    const twice = matrixCommand.injectMatrixSection(once, section);
    expect(once).toBe(twice);
    expect(matrixCommand.extractMatrixSection(once)).toBe(section);
    expect(matrixCommand.injectMatrixSection("# No markers\n", section)).toContain(section);
  });

  test("checked-in compatibility matrix section matches generated output (docs are in sync)", () => {
    const docsPath = path.join(repoRoot, "docs", "compatibility-matrix.md");
    const content = fs.readFileSync(docsPath, "utf8");
    const expected = matrixCommand.renderMatrixSection(repoRoot);
    expect(matrixCommand.extractMatrixSection(content)).toBe(expected);
    expect(matrixCommand.checkMatrix(content, repoRoot)).toBe(true);
  });

  test("checkMatrix returns false for a drifted section", () => {
    const drifted = `# Doc\n\n${matrixCommand.MATRIX_BEGIN}\nstale\n${matrixCommand.MATRIX_END}\n`;
    expect(matrixCommand.checkMatrix(drifted, repoRoot)).toBe(false);
  });

  test("generateMatrixBody works against an isolated source root with no host reads", () => {
    const root = makeTempRoot("provider-matrix-src-");
    const providersDir = path.join(root, "providers");
    fs.mkdirSync(providersDir, { recursive: true });
    fs.writeFileSync(
      path.join(providersDir, "codex.json"),
      JSON.stringify({
        provider: "codex",
        displayName: "Codex",
        skillPaths: { project: ".agents/skills", user: "~/.codex/skills" },
        detectionPaths: { project: ".codex", user: "~/.codex" },
        supports: { description: true, skillMd: true },
        dangerNotes: ["careful"],
      }),
    );
    fs.writeFileSync(
      path.join(providersDir, "opencode.json"),
      JSON.stringify({
        provider: "opencode",
        displayName: "OpenCode",
        skillPaths: { project: ".agents/skills", user: "~/.config/opencode/skills" },
        detectionPaths: { project: ".opencode", user: "~/.config/opencode" },
        supports: { permissions: true },
        dangerNotes: [],
      }),
    );

    const body = matrixCommand.generateMatrixBody(root);
    expect(body).toContain("`codex`");
    expect(body).toContain("`opencode`");
    expect(body).toContain("careful");
    expect(matrixCommand.generateMatrixBody(root)).toBe(body);
  });
});

describe("skill-sys provider-matrix command wiring", () => {
  test("registry exposes provider-matrix as a public command", () => {
    expect(registry.resolveSkillSysCommandName("provider-matrix")).toBe("provider-matrix");
    expect(registry.resolveSkillSysCommandName("generate-provider-matrix")).toBe("provider-matrix");
    const definition = registry.SKILL_SYS_COMMANDS.find((command) => command.name === "provider-matrix");
    expect(definition?.audience).toBe("public");
  });

  test("buildCommand routes provider-matrix to the generator with passthrough flags", () => {
    const plan = skillSys.buildCommand(
      skillSys.parseCli(["bun", "skill-sys", "provider-matrix", "--source", ".", "--output", "out.md", "--check"]),
    );
    expect(plan.argv[0]).toBe("bun");
    expect(plan.argv.some((token) => token.endsWith("generate-provider-matrix.ts"))).toBe(true);
    const indexOf = (flag: string) => plan.argv.indexOf(flag);
    expect(plan.argv[indexOf("--source") + 1]).toBe(".");
    expect(plan.argv[indexOf("--output") + 1]).toBe("out.md");
    expect(plan.argv).toContain("--check");
  });
});
