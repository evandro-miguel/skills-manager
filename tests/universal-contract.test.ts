import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fixFrontmatter,
  listSkillDirs,
  main,
  parseArgs,
  parseFrontmatterLines,
  validateSkill,
} from "../scripts/commands/universal-contract.ts";

function withTempDir<T>(prefix: string, callback: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function skillFrontmatter(name: string, overrides = ""): string {
  return `---
name: ${name}
description: Use when ${name} is needed.
metadata:
  tags: "test, contract"
  triggers: "test"
  references: "none"
  version: 1.2.3
  updated_at: 2026-06-08T00:00:00Z
  target_provider: universal
${overrides}---
# ${name}
`;
}

function captureMain(run: () => void): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  process.exit = ((exitCode?: string | number | null | undefined) => {
    const code = typeof exitCode === "number" ? exitCode : 0;
    throw new Error(`process.exit:${code}`);
  }) as typeof process.exit;
  try {
    run();
    return { code: 0, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("process.exit:")) {
      throw error;
    }
    return { code: Number(message.slice("process.exit:".length)), stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
}

describe("universal contract command", () => {
  test("parseArgs resolves roots, accepts help/fix/only flags, and rejects malformed arguments", () => {
    const parsed = parseArgs([
      "bun",
      "universal-contract.ts",
      "--skills-root",
      "fixtures/skills",
      "--only-with-skill-md",
      "--fix",
    ]);
    expect(parsed.skillsRoot).toBe(path.resolve(process.cwd(), "fixtures/skills"));
    expect(parsed.onlyWithSkillMd).toBe(true);
    expect(parsed.fix).toBe(true);
    expect(parseArgs(["bun", "universal-contract.ts", "--help"]).help).toBe(true);
    expect(parseArgs(["bun", "universal-contract.ts", "-h"]).help).toBe(true);
    expect(() => parseArgs(["bun", "universal-contract.ts", "--skills-root"])).toThrow("Missing value");
    expect(() => parseArgs(["bun", "universal-contract.ts", "--unknown", "x"])).toThrow("Unknown option");
    expect(() => parseArgs(["bun", "universal-contract.ts", "stray"])).toThrow("Unknown argument");
  });

  test("listSkillDirs returns sorted visible directories and can require SKILL.md", () => {
    withTempDir("universal-contract-dirs-", (root) => {
      const skills = path.join(root, "skills");
      fs.mkdirSync(path.join(skills, "beta"), { recursive: true });
      fs.mkdirSync(path.join(skills, "alpha"), { recursive: true });
      fs.mkdirSync(path.join(skills, ".hidden"), { recursive: true });
      writeText(path.join(skills, "alpha", "SKILL.md"), skillFrontmatter("alpha"));
      writeText(path.join(skills, "file.txt"), "not a directory\n");

      expect(listSkillDirs(path.join(root, "missing"), false)).toEqual([]);
      expect(listSkillDirs(skills, false)).toEqual(["alpha", "beta"]);
      expect(listSkillDirs(skills, true)).toEqual(["alpha"]);
    });
  });

  test("parseFrontmatterLines strips BOM and reports missing frontmatter delimiters", () => {
    expect(parseFrontmatterLines("\uFEFF---\nname: alpha\n---\n# Alpha")).toMatchObject({ ok: true, start: 1, end: 2 });
    expect(parseFrontmatterLines("# Alpha")).toEqual({ ok: false, error: "missing YAML frontmatter" });
    expect(parseFrontmatterLines("---\nname: alpha\n# Alpha")).toEqual({ ok: false, error: "missing closing frontmatter delimiter" });
  });

  test("fixFrontmatter quotes unsafe scalars and normalizes inline and list CSV metadata", () => {
    const source = `---
name: alpha
description: Use when alpha: beta
metadata:
  tags: [one, 'two']
  triggers:
    - first
    - second
  references: "already csv"
---
# Alpha
`;
    const fixed = fixFrontmatter(source);

    expect(fixed.changed).toBe(true);
    expect(fixed.fixed).toBe(true);
    expect(fixed.content).toContain('description: "Use when alpha: beta"');
    expect(fixed.content).toContain('  tags: "one, two"');
    expect(fixed.content).toContain('  triggers: "first, second"');
    expect(fixFrontmatter("# no frontmatter")).toEqual({ fixed: false, content: "# no frontmatter", changed: false });
    expect(fixFrontmatter(skillFrontmatter("alpha")).changed).toBe(false);
  });

  test("validateSkill accepts a complete skill and pinpoints frontmatter contract violations", () => {
    withTempDir("universal-contract-validate-", (root) => {
      const skills = path.join(root, "skills");
      writeText(path.join(skills, "alpha", "SKILL.md"), skillFrontmatter("alpha"));
      expect(validateSkill("alpha", path.join(skills, "alpha"))).toEqual([]);

      writeText(
        path.join(skills, "bad-skill", "SKILL.md"),
        `---
name: Bad Skill
description: |
  multiline
extra: no
metadata:
  tags: [one, two]
  triggers:
    - cli
  compatible_providers: "universal, codex, codex"
  legacy_name: old
  version: nope
  updated_at: yesterday
  target_provider: codex
---
# Bad
`
      );

      const issues = validateSkill("bad-skill", path.join(skills, "bad-skill"));
      expect(issues).toEqual(expect.arrayContaining([
        "description must be a single-line scalar",
        "unexpected top-level key: extra",
        "metadata.tags must be CSV string (array found)",
        "metadata.triggers must be CSV string (list syntax found)",
        "invalid name format: Bad Skill",
        "name mismatch: frontmatter 'Bad Skill' vs folder 'bad-skill'",
        "metadata.version must be semver x.y.z: nope",
        "metadata.updated_at must be UTC ISO timestamp: yesterday",
        "metadata.compatible_providers must not include universal",
        "metadata.compatible_providers must not repeat metadata.target_provider",
        "metadata.compatible_providers contains invalid or duplicate providers",
      ]));
      expect(validateSkill("missing", path.join(skills, "missing"))).toEqual(["missing SKILL.md"]);
    });
  });

  test("main reports empty roots, blocking findings, fix counts, pass state, and help", () => {
    withTempDir("universal-contract-main-", (root) => {
      const empty = path.join(root, "empty");
      fs.mkdirSync(empty);
      const emptyResult = captureMain(() => {
        const originalArgv = process.argv;
        process.argv = ["bun", "universal-contract.ts", "--skills-root", empty];
        try {
          main();
        } finally {
          process.argv = originalArgv;
        }
      });
      expect(emptyResult.code).toBe(1);
      expect(emptyResult.stdout).toContain("STATUS: BLOCKING");
      expect(emptyResult.stdout).toContain("SKILLS_ROOT_EMPTY");

      const skills = path.join(root, "skills");
      writeText(path.join(skills, "alpha", "SKILL.md"), skillFrontmatter("alpha"));
      writeText(path.join(skills, "beta", "SKILL.md"), `---
name: beta
description: Use when beta: needs quoting.
metadata:
  tags: [beta, cli]
  triggers:
    - beta
  references: "fixture"
  version: 1.0.0
  updated_at: 2026-06-08T00:00:00Z
  target_provider: universal
---
# Beta
`);

      const fixed = captureMain(() => {
        const originalArgv = process.argv;
        process.argv = ["bun", "universal-contract.ts", "--skills-root", skills, "--fix"];
        try {
          main();
        } finally {
          process.argv = originalArgv;
        }
      });
      expect(fixed.code).toBe(0);
      expect(fixed.stdout).toContain("STATUS: PASS");
      expect(fixed.stdout).toContain("Fixed: 1");
      expect(fs.readFileSync(path.join(skills, "beta", "SKILL.md"), "utf8")).toContain('tags: "beta, cli"');

      const help = captureMain(() => {
        const originalArgv = process.argv;
        process.argv = ["bun", "universal-contract.ts", "--help"];
        try {
          main();
        } finally {
          process.argv = originalArgv;
        }
      });
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("Universal skill contract checker");
    });
  });
});
