import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyDevModeLocal,
  normalizeDevModeArgs,
  renderDevModeResult,
  runDevModePlan,
} from "../scripts/modules/skillpool/dev-mode.ts";

const devModeCommand = require("../scripts/commands/dev-mode.ts") as typeof import("../scripts/commands/dev-mode.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const repoRoot = path.resolve(__dirname, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-mode-"));
  tempRoots.push(root);
  return root;
}

function writeSkill(root: string, name: string): void {
  const dir = path.join(root, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\nmetadata:\n  tags: test\n---\n# ${name}\n`);
}

function writeConfig(root: string, value: unknown, filename = "skill-sys.dev.json"): string {
  const configPath = path.join(root, filename);
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
  return configPath;
}

function baseConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "local-dev",
    devOnly: true,
    publicRelease: false,
    installMode: "symlink",
    allowSymlinks: true,
    links: [{ skill: "alpha", target: ".agents/skills/alpha" }],
    ...extra,
  };
}

describe("dev mode — normalizeDevModeArgs", () => {
  test("rejects missing source or config", () => {
    expect(() => normalizeDevModeArgs({ config: "/tmp/config.json" })).toThrow("Missing --source");
    expect(() => normalizeDevModeArgs({ source: "/tmp/source" })).toThrow("Missing --config");
  });

  test("rejects symlinked config files and accepts strict", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const config = writeConfig(root, baseConfig());
    const link = path.join(root, "link.json");
    fs.symlinkSync(config, link);

    expect(() => normalizeDevModeArgs({ source: root, config: link })).toThrow("must not be a symlink");
    expect(normalizeDevModeArgs({ source: root, config, strict: true }).strict).toBe(true);
  });
});

describe("dev mode — CLI wiring", () => {
  test("parseArgs normalizes config and skill-sys dispatch routes to command", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const config = writeConfig(root, baseConfig());

    const args = devModeCommand.parseArgs(["bun", "dev-mode", "--source", root, "--config", config, "--json", "--strict"]);
    expect(args.source).toBe(root);
    expect(args.config).toBe(config);
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);

    const plan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "dev-mode", "--source", root, "--config", config, "--json", "--strict"]));
    expect(plan.argv).toEqual(["bun", path.join(repoRoot, "scripts", "commands", "dev-mode.ts"), "--source", root, "--config", config, "--json", "--strict"]);
  });
});

describe("dev mode — runDevModePlan", () => {
  test("passes and emits a dry-run symlink plan for explicit local dev config", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const config = writeConfig(root, baseConfig());

    const result = runDevModePlan(normalizeDevModeArgs({ source: root, config }));

    expect(result.status).toBe("PASS");
    expect(result.devName).toBe("local-dev");
    expect(result.plan.links).toEqual([{ skill: "alpha", source: "skills/alpha/SKILL.md", target: ".agents/skills/alpha", action: "would-link" }]);
    expect(result.findings).toEqual([]);
    expect(fs.existsSync(path.join(root, ".agents", "skills", "alpha"))).toBe(false);
  });

  test("blocks release unsafe config, missing skills, unsafe targets, and broad catalog embedding", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({
      devOnly: false,
      publicRelease: true,
      allowSymlinks: false,
      links: [{ skill: "missing", target: "../outside" }],
      skills: [{ name: "embedded" }],
    }));

    const result = runDevModePlan(normalizeDevModeArgs({ source: root, config }));

    expect(result.status).toBe("BLOCKED");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "DEV_MODE_CATALOG_EMBEDDED",
      "DEV_MODE_LINK_TARGET_UNSAFE",
      "DEV_MODE_PUBLIC_RELEASE_FORBIDDEN",
      "DEV_MODE_SKILL_MISSING",
      "DEV_MODE_SYMLINKS_NOT_ALLOWED",
    ]);
  });

  test("warns when no links are declared and strict blocks warnings", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({ links: [] }));

    const loose = runDevModePlan(normalizeDevModeArgs({ source: root, config }));
    const strict = runDevModePlan(normalizeDevModeArgs({ source: root, config, strict: true }));

    expect(loose.status).toBe("CONCERNS");
    expect(strict.status).toBe("BLOCKED");
    expect(loose.findings[0]?.code).toBe("DEV_MODE_LINKS_EMPTY");
  });

  test("renders stable JSON and text output", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const config = writeConfig(root, baseConfig());
    const result = runDevModePlan(normalizeDevModeArgs({ source: root, config }));

    expect(JSON.parse(renderDevModeResult(result, "json"))).toEqual(result);
    expect(renderDevModeResult(result, "text")).toContain("STATUS: PASS");
  });
});

describe("dev mode — explicit local apply seam", () => {
  test("is plan-only by default, then creates an owned project-local link idempotently", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const config = writeConfig(root, baseConfig());
    const input = normalizeDevModeArgs({ source: root, config });
    const target = path.join(root, ".agents", "skills", "alpha");

    const planned = applyDevModeLocal(input);
    expect(planned.status).toBe("PLANNED");
    expect(fs.existsSync(target)).toBe(false);

    const applied = applyDevModeLocal(input, { apply: true });
    expect(applied).toMatchObject({ status: "APPLIED", applied: true, cleaned: 0, findings: [] });
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(path.join(root, "skills", "alpha")));

    expect(applyDevModeLocal(input, { apply: true })).toMatchObject({ status: "UNCHANGED", applied: false, cleaned: 0 });
  });

  test("cleanup removes only a stale adapter-owned link", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    writeSkill(root, "beta");
    const config = writeConfig(root, baseConfig({ links: [{ skill: "alpha", target: ".agents/skills/alpha" }, { skill: "beta", target: ".agents/skills/beta" }] }));
    const input = normalizeDevModeArgs({ source: root, config });
    expect(applyDevModeLocal(input, { apply: true }).status).toBe("APPLIED");

    const cleanupConfig = writeConfig(root, baseConfig(), "cleanup.json");
    const cleaned = applyDevModeLocal(normalizeDevModeArgs({ source: root, config: cleanupConfig }), { apply: true, cleanup: true });
    expect(cleaned).toMatchObject({ status: "APPLIED", cleaned: 1 });
    expect(fs.existsSync(path.join(root, ".agents", "skills", "alpha"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".agents", "skills", "beta"))).toBe(false);
  });

  test("fails closed without mutating conflicts, unowned links, or config escapes", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const config = writeConfig(root, baseConfig());
    const target = path.join(root, ".agents", "skills", "alpha");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "not a link\n");
    expect(applyDevModeLocal(normalizeDevModeArgs({ source: root, config }), { apply: true })).toMatchObject({ status: "BLOCKED", applied: false });
    expect(fs.readFileSync(target, "utf8")).toBe("not a link\n");

    fs.unlinkSync(target);
    fs.symlinkSync(path.join(root, "skills", "alpha"), target, "dir");
    expect(applyDevModeLocal(normalizeDevModeArgs({ source: root, config }), { apply: true }).findings[0]?.code).toBe("DEV_MODE_LINK_UNOWNED");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);

    const externalConfig = writeConfig(makeTempRoot(), baseConfig());
    expect(applyDevModeLocal(normalizeDevModeArgs({ source: root, config: externalConfig }), { apply: true }).findings[0]?.code).toBe("DEV_MODE_CONFIG_PATH_UNSAFE");
  });
});
