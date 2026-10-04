import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const skillpack = require("../scripts/modules/skillpool/skillpack.ts") as typeof import("../scripts/modules/skillpool/skillpack.ts");
const source = require("../scripts/modules/skillpool/source.ts") as typeof import("../scripts/modules/skillpool/source.ts");
const skillMeta = require("../scripts/modules/skillpool/skill-meta.ts") as typeof import("../scripts/modules/skillpool/skill-meta.ts");
const createCommand = require("../scripts/commands/create-skillpack.ts") as typeof import("../scripts/commands/create-skillpack.ts");
const validateCommand = require("../scripts/commands/validate-skillpack.ts") as typeof import("../scripts/commands/validate-skillpack.ts");
const { captureCommand } = require("./helpers/skillpool-command.ts") as {
  captureCommand: (run: () => void) => { code: number; stdout: string; stderr: string };
};

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readJson<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

describe("skillpack contract", () => {
  test("the shipped skill-sys operator skill passes strict skillpack validation", () => {
    const root = path.join(makeTempDir("shipped-skillpack-"), "pack");
    skillpack.createSkillpack({ targetDir: root, name: "operator-skill-check" });
    fs.cpSync(path.resolve(__dirname, "../skills/skill-sys"), path.join(root, "skills/skill-sys"), { recursive: true });
    for (const relativePath of ["skillpack.json", "profiles/default.json"]) {
      const filePath = path.join(root, relativePath);
      const data = readJson<{ skills: string[] }>(filePath);
      data.skills = ["skill-sys"];
      fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
    }
    const result = captureCommand(() =>
      validateCommand.main(["bun", "validate-skillpack.ts", "--source", root, "--strict"])
    );
    expect(result.stdout).toContain("STATUS: PASS");
    expect(result.code).toBe(0);
  });

  test("create-skillpack writes a sanitized scaffold that validate-skillpack accepts", () => {
    const root = path.join(makeTempDir("skillpack-create-"), "public-example");

    const createResult = captureCommand(() =>
      createCommand.main([
        "bun",
        "create-skillpack.ts",
        root,
        "--name",
        "@example/public-pack",
        "--providers",
        "codex,opencode,gemini-cli",
      ])
    );

    expect(createResult.code).toBe(0);
    expect(createResult.stdout).toContain("STATUS: CREATED");
    expect(fs.existsSync(path.join(root, "skillpack.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "skills", "example-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "skills", "example-skill", "skill.meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "skills", "example-skill", "evals", "triggers.json"))).toBe(true);

    const manifest = readJson<{ name: string; providers: string[]; privacy: { containsPersonalData: boolean } }>(path.join(root, "skillpack.json"));
    expect(manifest.name).toBe("@example/public-pack");
    expect(manifest.providers).toEqual(["codex", "opencode", "gemini-cli"]);
    expect(manifest.privacy.containsPersonalData).toBe(false);

    const skillMd = fs.readFileSync(path.join(root, "skills", "example-skill", "SKILL.md"), "utf8");
    expect(skillMd).toContain("updated_at:");
    expect(skillMd).toContain("target_provider: universal");

    const meta = readJson<any>(path.join(root, "skills", "example-skill", "skill.meta.json"));
    expect(meta).toMatchObject({
      name: "example-skill",
      version: "0.1.0",
      contractVersion: "1.0",
      lifecycle: "active",
      risk: {
        browserAuthState: false,
        repoMutation: false,
      },
      invocation: {
        requiresConfirmation: false,
      },
    });
    expect(() => skillMeta.readSkillMeta(path.join(root, "skills", "example-skill"))).not.toThrow();

    const triggers = readJson<any>(path.join(root, "skills", "example-skill", "evals", "triggers.json"));
    expect(triggers.positive[0]).toEqual({
      prompt: "Validate this example skillpack.",
      expectedSkill: "example-skill",
    });
    expect(triggers.negative[0]).toEqual({
      prompt: "Operate my private workflow.",
      mustNotTrigger: "example-skill",
    });

    expect(source.resolveSourceLayout(root, { requireSkills: true }).kind).toBe("skillpack");

    const validateResult = captureCommand(() =>
      validateCommand.main(["bun", "validate-skillpack.ts", "--source", root, "--strict"])
    );
    expect(validateResult.code).toBe(0);
    expect(validateResult.stdout).toContain("STATUS: PASS");
  });

  test("create-skillpack refuses to overwrite an existing target by default", () => {
    const root = path.join(makeTempDir("skillpack-existing-"), "pack");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "README.md"), "existing content\n", "utf8");

    expect(() => skillpack.createSkillpack({ targetDir: root, name: "existing-pack" })).toThrow(
      "already exists and is not empty"
    );
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("existing content\n");
  });

  test("validate-skillpack rejects malformed trigger evals, skill metadata, and SKILL.md frontmatter", () => {
    const root = path.join(makeTempDir("skillpack-contract-invalid-"), "pack");
    skillpack.createSkillpack({ targetDir: root, name: "contract-invalid-pack" });

    fs.writeFileSync(
      path.join(root, "skills", "example-skill", "evals", "triggers.json"),
      `${JSON.stringify({ positive: ["string prompt"], negative: ["string prompt"] }, null, 2)}\n`,
      "utf8"
    );

    const metaPath = path.join(root, "skills", "example-skill", "skill.meta.json");
    const meta = readJson<any>(metaPath);
    delete meta.name;
    delete meta.version;
    delete meta.contractVersion;
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    const skillMdPath = path.join(root, "skills", "example-skill", "SKILL.md");
    fs.writeFileSync(
      skillMdPath,
      fs.readFileSync(skillMdPath, "utf8").replace(/^\s*updated_at:.*\n/m, ""),
      "utf8"
    );

    const result = skillpack.validateSkillpack({ source: root, strict: true });
    expect(result.blockingFindingCount).toBeGreaterThanOrEqual(4);
    expect(result.findings.some((finding) => finding.message.includes("triggers.positive[0] must be an object"))).toBe(true);
    expect(result.findings.some((finding) => finding.message.includes("skill.meta.json.name must match skill directory"))).toBe(true);
    expect(result.findings.some((finding) => finding.message.includes("skill.meta.json.version must be semver"))).toBe(true);
    expect(result.findings.some((finding) => finding.message.includes("missing metadata.updated_at"))).toBe(true);
  });

  test("all risky capabilities force manual-only projection policy", () => {
    const riskyFlags = [
      "writesProject",
      "writesGlobal",
      "executesShell",
      "networkAccess",
      "externalDirectory",
      "credentialSensitive",
      "destructive",
      "browserAuthState",
      "repoMutation",
    ];

    for (const flag of riskyFlags) {
      const meta = skillMeta.defaultSkillMeta("example-skill") as any;
      meta.risk[flag] = true;
      expect(skillMeta.hasDangerousRisk(meta)).toBe(true);
    }
  });

  test("create-skillpack refuses path traversal in generated identifiers", () => {
    const root = makeTempDir("skillpack-traversal-");
    const target = path.join(root, "pack");

    expect(() => skillpack.createSkillpack({ targetDir: target, name: "traversal-pack", profile: "../../escaped" })).toThrow(
      "profile must be a lowercase identifier without slashes or path traversal"
    );
    expect(fs.existsSync(path.join(root, "escaped.json"))).toBe(false);

    expect(() =>
      skillpack.createSkillpack({ targetDir: target, name: "traversal-pack", providers: ["codex", "../escaped"] })
    ).toThrow("providers[1] must be a lowercase identifier without slashes or path traversal");
    expect(fs.existsSync(target)).toBe(false);
  });

  test("validate-skillpack blocks public privacy declarations and unsafe risky skills", () => {
    const root = path.join(makeTempDir("skillpack-invalid-"), "pack");
    skillpack.createSkillpack({ targetDir: root, name: "invalid-pack" });

    const manifestPath = path.join(root, "skillpack.json");
    const manifest = readJson<any>(manifestPath);
    manifest.privacy.containsLocalPaths = true;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const metaPath = path.join(root, "skills", "example-skill", "skill.meta.json");
    const meta = readJson<any>(metaPath);
    meta.risk.executesShell = true;
    meta.invocation.implicitAllowed = true;
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    const result = skillpack.validateSkillpack({ source: root, strict: true });
    expect(result.blockingFindingCount).toBeGreaterThanOrEqual(2);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "public skillpacks must declare no personal, local-path, or company data"
    );
    expect(result.findings.some((finding) => finding.message.includes("invocation.implicitAllowed is not false"))).toBe(true);
  });

  test("create-skillpack CLI covers dry-run, JSON, help, and parser failures", () => {
    const root = path.join(makeTempDir("skillpack-cli-create-"), "pack");

    expect(createCommand.parseArgs(["bun", "create-skillpack.ts", root, "--visibility", "private", "--dry-run"])).toMatchObject({
      target: root,
      visibility: "private",
      dryRun: true,
    });
    expect(() => createCommand.parseArgs(["bun", "create-skillpack.ts", root, "--visibility", "internal"])).toThrow(
      "Invalid visibility"
    );
    expect(() => createCommand.parseArgs(["bun", "create-skillpack.ts", root, "extra"])).toThrow("Unknown argument");
    expect(() => createCommand.parseArgs(["bun", "create-skillpack.ts", root, "--force"])).toThrow("--force requires");
    expect(() => createCommand.parseArgs(["bun", "create-skillpack.ts", "--bad"])).toThrow("Unknown option");
    expect(() => createCommand.parseArgs(["bun", "create-skillpack.ts"])).toThrow("Usage: create-skillpack");

    const help = captureCommand(() => createCommand.main(["bun", "create-skillpack.ts", "--help"]));
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Create a sanitized Skill-Sys skillpack scaffold");

    const dryRun = captureCommand(() =>
      createCommand.main(["bun", "create-skillpack.ts", root, "--name", "dry-pack", "--dry-run", "--json"])
    );
    expect(dryRun.code).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ targetDir: root, dryRun: true });
    expect(fs.existsSync(root)).toBe(false);

    const text = captureCommand(() => createCommand.main(["bun", "create-skillpack.ts", root, "--force", "--yes-i-understand-overwrite"]));
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("STATUS: CREATED");
  });

  test("validate-skillpack CLI covers help, JSON, warn/blocking output, and parser failures", () => {
    const root = path.join(makeTempDir("skillpack-cli-validate-"), "pack");
    skillpack.createSkillpack({ targetDir: root, name: "validate-pack" });

    expect(validateCommand.parseArgs(["bun", "validate-skillpack.ts", "--source", root, "--json", "--strict"])).toMatchObject({
      source: root,
      json: true,
      strict: true,
    });
    expect(() => validateCommand.parseArgs(["bun", "validate-skillpack.ts", "--bad"])).toThrow("Unknown option");
    expect(() => validateCommand.parseArgs(["bun", "validate-skillpack.ts", "extra"])).toThrow("Unknown argument");

    const help = captureCommand(() => validateCommand.main(["bun", "validate-skillpack.ts", "--help"]));
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Validate a Skill-Sys skillpack manifest");

    const json = captureCommand(() => validateCommand.main(["bun", "validate-skillpack.ts", "--source", root, "--json"]));
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ blockingFindingCount: 0 });

    const metaPath = path.join(root, "skills", "example-skill", "skill.meta.json");
    const meta = readJson<any>(metaPath);
    meta.risk.executesShell = true;
    meta.invocation.implicitAllowed = false;
    meta.invocation.manualOnly = false;
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    const warn = captureCommand(() => validateCommand.main(["bun", "validate-skillpack.ts", "--source", root]));
    expect(warn.code).toBe(0);
    expect(warn.stdout).toContain("STATUS: WARN");

    const strict = captureCommand(() => validateCommand.main(["bun", "validate-skillpack.ts", "--source", root, "--strict"]));
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("STATUS: BLOCKING");
  });
});
