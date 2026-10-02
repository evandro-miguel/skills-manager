import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { CatalogIntegrationError } from "../scripts/modules/integrations/skills-sh/errors.ts";
import { main, parseArgs, runInspect } from "../scripts/commands/inspect-skill.ts";
import { buildCommand, parseCli } from "../scripts/commands/skill-sys.ts";

const REPO_ROOT = path.resolve(__dirname, "..");

describe("runInspect (offline)", () => {
  test("resolves prefixed references to a full resolution card", async () => {
    const report = await runInspect({
      reference: "skills.sh:vercel-labs/skills/find-skills",
    });
    expect(report.owner).toBe("vercel-labs");
    expect(report.repo).toBe("skills");
    expect(report.skillPathHint).toEqual(["find-skills"]);
    expect(report.canonicalSourceHint).toBe(
      "https://github.com/vercel-labs/skills.git",
    );
    expect(report.installable).toBe(true);
    expect(report.manifestHint.source).toBe(
      "https://github.com/vercel-labs/skills.git",
    );
    expect(report.manifestHint.skillPathHint).toEqual(["find-skills"]);
    expect(Object.hasOwn(report, "online")).toBe(false);
  });

  test("malformed references fail closed", async () => {
    try {
      await runInspect({ reference: "not-a-reference" });
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as CatalogIntegrationError).code).toBe(
        "CATALOG_SOURCE_UNRESOLVED",
      );
    }
  });
});

describe("offline-only option contract", () => {
  test("rejects deprecated online, strict, and home options", () => {
    for (const argv of [
      ["bun", "x", "--online"],
      ["bun", "x", "--strict"],
      ["bun", "x", "--home", "/tmp/inspect-skill-home"],
    ]) {
      expect(() => parseArgs(argv)).toThrow("deprecated and rejected");
    }
  });

  test("the command keeps no skills-sh transport wiring", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "scripts", "commands", "inspect-skill.ts"),
      "utf8",
    );
    expect(source).not.toContain("SkillsShApiClient");
    expect(source).not.toContain("FetchRestrictedHttpClient");
    expect(source).not.toContain("FileExternalEvidenceCache");
  });
});

describe("main", () => {
  test("--help exits 0 with usage", async () => {
    const stdout: string[] = [];
    const exit = await main(["bun", "x", "--help"], {
      stdout: (l) => stdout.push(l),
    });
    expect(exit).toBe(0);
    expect(stdout.join("\n")).toContain("Usage:");
  });

  test("missing --reference exits 2", async () => {
    const stderr: string[] = [];
    const exit = await main(["bun", "x"], { stderr: (l) => stderr.push(l) });
    expect(exit).toBe(2);
    expect(stderr[0]).toContain("--reference is required");
  });

  test("deprecated options exit 2 with a clear error and no report", async () => {
    for (const legacyArgs of [
      ["--online"],
      ["--strict"],
      ["--home", "/tmp/inspect-skill-home"],
    ]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exit = await main(
        [
          "bun",
          "x",
          "--reference",
          "skills.sh:o/r/s",
          ...legacyArgs,
          "--json",
        ],
        {
          stdout: (l) => stdout.push(l),
          stderr: (l) => stderr.push(l),
        },
      );
      expect(exit).toBe(2);
      expect(stdout).toEqual([]);
      expect(stderr.join("\n")).toContain(
        `${legacyArgs[0]} is deprecated and rejected`,
      );
    }
  });

  test("parseArgs rejects unknown options and bare arguments", () => {
    for (const argv of [["bun", "x", "--bogus"], ["bun", "x", "positional"]]) {
      expect(() => parseArgs(argv)).toThrow();
    }
  });

  test("offline JSON report flows through stdout", async () => {
    const stdout: string[] = [];
    const exit = await main(
      ["bun", "x", "--reference", "skills.sh:o/r/s", "--json"],
      { stdout: (l) => stdout.push(l) },
    );
    const report = JSON.parse(stdout.join("\n")) as { repo: string };
    expect(report.repo).toBe("r");
    expect(exit).toBe(0);
  });
});

describe("facade dispatch (skill-sys inspect-skill)", () => {
  const facadeArgv = [
    "bun",
    "skill-sys",
    "inspect-skill",
    "--reference",
    "skills.sh:vercel-labs/skills/find-skills",
    "--online",
    "--json",
  ];

  test("parseCli accepts deprecated --online for compatibility forwarding", () => {
    const parsed = parseCli(facadeArgv);
    expect(parsed.command).toBe("inspect-skill");
  });

  test("buildCommand forwards deprecated --online for child rejection", () => {
    const plan = buildCommand(parseCli(facadeArgv));
    expect(plan.argv[1]).toMatch(/inspect-skill\.ts$/);
    expect(plan.argv).toContain("--online");
    expect(plan.argv).toContain("--json");
    expect(plan.argv.indexOf("--online")).toBeGreaterThan(
      plan.argv.indexOf("--reference"),
    );
  });

  test("spawned facade rejects every deprecated option without a report", () => {
    for (const legacyArgs of [
      ["--online"],
      ["--strict"],
      ["--home", "/tmp/inspect-skill-home"],
    ]) {
      const result = Bun.spawnSync({
        cmd: [
          "bun",
          path.join(REPO_ROOT, "scripts", "commands", "skill-sys.ts"),
          "inspect-skill",
          "--reference",
          "skills.sh:vercel-labs/skills/find-skills",
          ...legacyArgs,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(2);
      expect(Buffer.from(result.stdout ?? []).toString()).toBe("");
      expect(Buffer.from(result.stderr ?? []).toString()).toContain(
        `${legacyArgs[0]} is deprecated and rejected`,
      );
    }
  });
});
