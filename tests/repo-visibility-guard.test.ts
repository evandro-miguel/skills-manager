import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const guard = require("../scripts/commands/guard-repo-visibility.ts") as typeof import("../scripts/commands/guard-repo-visibility.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");
const registry = require("../scripts/modules/skill-sys/command-registry.ts") as typeof import("../scripts/modules/skill-sys/command-registry.ts");
const packageJson = require("../package.json") as { scripts: Record<string, string> };

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((path) => path.length > 0 && existsSync(path));
}

type CapturedCli = {
  code: number;
  stdout: string;
  stderr: string;
  argv: string[];
};

function runGuardCli(
  args: string[],
  ghResult: { code: number; stdout: string; stderr?: string }
): CapturedCli {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let capturedArgv: string[] = [];

  const code = guard.main(["bun", "guard-repo-visibility.ts", ...args], {
    run: (argv: string[]) => {
      capturedArgv = argv;
      return {
        code: ghResult.code,
        stdout: ghResult.stdout,
        stderr: ghResult.stderr || "",
      };
    },
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
  });

  return {
    code,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
    argv: capturedArgv,
  };
}

function repoJson(visibility: string, isPrivate: boolean): string {
  return JSON.stringify({ visibility, isPrivate });
}

describe("repo visibility guard", () => {
  test("passes only for the protected private GitHub repository and prints required human fields", () => {
    const result = runGuardCli([], { code: 0, stdout: repoJson("PRIVATE", true) });

    expect(result.code).toBe(0);
    expect(result.argv).toEqual([
      "gh",
      "repo",
      "view",
      "evandro-miguel/skills-manager",
      "--json",
      "visibility,isPrivate",
    ]);
    expect(result.stdout).toContain("STATUS: PASS");
    expect(result.stdout).toContain("Repository: evandro-miguel/skills-manager");
    expect(result.stdout).toContain("Architecture: public-engine/base");
    expect(result.stdout).toContain("GitHub visibility: PRIVATE");
    expect(result.stdout).toContain("must remain GitHub PRIVATE until the repository owner explicitly approves publication");
    expect(result.stderr).toBe("");
  });

  test("emits machine-readable JSON fields for private pass", () => {
    const result = runGuardCli(["--json"], { code: 0, stdout: repoJson("PRIVATE", true) });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      repository: "evandro-miguel/skills-manager",
      visibility: "PRIVATE",
      isPrivate: true,
      status: "PASS",
      localOk: false,
      allowPublicAfterExplicitUserApproval: false,
    });
  });

  test("fails closed when visibility contradicts isPrivate or is unknown even if isPrivate is true", () => {
    for (const visibility of ["PUBLIC", "INTERNAL", "MYSTERY"]) {
      const result = runGuardCli(["--json"], { code: 0, stdout: repoJson(visibility, true) });

      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        repository: "evandro-miguel/skills-manager",
        visibility,
        isPrivate: true,
        status: "BLOCKING",
        localOk: false,
        allowPublicAfterExplicitUserApproval: false,
      });
    }
  });

  test("fails closed for PUBLIC/INTERNAL without override and passes PUBLIC with the explicit approval override", () => {
    const publicWithoutOverride = runGuardCli([], { code: 0, stdout: repoJson("PUBLIC", false) });
    expect(publicWithoutOverride.code).toBe(1);
    expect(publicWithoutOverride.stdout).toContain("STATUS: BLOCKING");
    expect(publicWithoutOverride.stdout).toContain("GitHub visibility: PUBLIC");
    expect(publicWithoutOverride.stdout).toContain("must remain GitHub PRIVATE until the repository owner explicitly approves publication");

    const internalWithoutOverride = runGuardCli([], { code: 0, stdout: repoJson("INTERNAL", false) });
    expect(internalWithoutOverride.code).toBe(1);
    expect(internalWithoutOverride.stdout).toContain("STATUS: BLOCKING");
    expect(internalWithoutOverride.stdout).toContain("GitHub visibility: INTERNAL");

    const publicWithOverride = runGuardCli(["--allow-public-after-explicit-user-approval", "--json"], {
      code: 0,
      stdout: repoJson("PUBLIC", false),
    });
    expect(publicWithOverride.code).toBe(0);
    expect(JSON.parse(publicWithOverride.stdout)).toEqual({
      repository: "evandro-miguel/skills-manager",
      visibility: "PUBLIC",
      isPrivate: false,
      status: "PASS_WITH_EXPLICIT_USER_APPROVAL",
      localOk: false,
      allowPublicAfterExplicitUserApproval: true,
    });
  });

  test("fails closed for gh missing/auth failure without printing command stderr secrets", () => {
    const secret = ["ghp_", "secret_that_must_not_be_printed"].join("");
    const result = runGuardCli([], {
      code: 127,
      stdout: "",
      stderr: `gh auth failed with token ${secret}`,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("STATUS: BLOCKING");
    expect(result.stdout).toContain("GitHub visibility: UNKNOWN");
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).toBe("");
  });

  test("fails closed for invalid JSON or missing required fields", () => {
    const invalidJson = runGuardCli([], { code: 0, stdout: "not json" });
    expect(invalidJson.code).toBe(1);
    expect(invalidJson.stdout).toContain("STATUS: BLOCKING");
    expect(invalidJson.stdout).toContain("GitHub visibility: UNKNOWN");

    const missingFields = runGuardCli([], { code: 0, stdout: JSON.stringify({ visibility: "PRIVATE" }) });
    expect(missingFields.code).toBe(1);
    expect(missingFields.stdout).toContain("STATUS: BLOCKING");
  });


  test("supports repository override and local-only unverifiable validation", () => {
    const repoOverride = runGuardCli(["--repository", "example-org/example-skills", "--json"], {
      code: 0,
      stdout: repoJson("PRIVATE", true),
    });
    expect(repoOverride.code).toBe(0);
    expect(repoOverride.argv).toContain("example-org/example-skills");
    expect(JSON.parse(repoOverride.stdout).repository).toBe("example-org/example-skills");

    const localOk = runGuardCli(["--local-ok", "--json"], { code: 127, stdout: "" });
    expect(localOk.code).toBe(0);
    expect(JSON.parse(localOk.stdout).status).toBe("PASS_LOCAL_UNVERIFIED");
  });

  test("uses the current GitHub repository before the configured local fallback", () => {
    const previousGithubRepository = process.env.GITHUB_REPOSITORY;
    const previousConfiguredRepository = process.env.SKILL_SYS_REPOSITORY;
    try {
      process.env.GITHUB_REPOSITORY = "example-org/example-repo";
      process.env.SKILL_SYS_REPOSITORY = "example-org/configured-fallback";
      const result = runGuardCli(["--json"], { code: 0, stdout: repoJson("PRIVATE", true) });

      expect(result.code).toBe(0);
      expect(result.argv).toContain("example-org/example-repo");
      expect(JSON.parse(result.stdout).repository).toBe("example-org/example-repo");
    } finally {
      if (previousGithubRepository === undefined) delete process.env.GITHUB_REPOSITORY;
      else process.env.GITHUB_REPOSITORY = previousGithubRepository;
      if (previousConfiguredRepository === undefined) delete process.env.SKILL_SYS_REPOSITORY;
      else process.env.SKILL_SYS_REPOSITORY = previousConfiguredRepository;
    }
  });

  test("supports help and rejects unknown options", () => {
    const helpStdout: string[] = [];
    const helpCode = guard.main(["bun", "guard-repo-visibility.ts", "--help"], {
      run: () => {
        throw new Error("runner should not be called for help");
      },
      stdout: (text: string) => helpStdout.push(text),
      stderr: () => undefined,
    });

    expect(helpCode).toBe(0);
    expect(helpStdout.join("\n")).toContain("guard-repo-visibility");
    expect(helpStdout.join("\n")).toContain("--allow-public-after-explicit-user-approval");

    expect(() => guard.parseArgs(["bun", "guard-repo-visibility.ts", "--bogus"])).toThrow("Unknown option: --bogus");
  });

  test("package scripts include the guard by default and never use the publication override", () => {
    expect(packageJson.scripts["guard:repo-visibility"]).toBe(
      "bun scripts/commands/skill-sys.ts guard-repo-visibility"
    );
    expect(packageJson.scripts.validate).not.toContain("bun run guard:repo-visibility");
    expect(packageJson.scripts["validate:release"]).toContain("bun run guard:repo-visibility");

    for (const scriptName of ["guard:repo-visibility", "validate", "validate:release", "ci:checks"]) {
      expect(packageJson.scripts[scriptName] || "").not.toContain("--allow-public-after-explicit-user-approval");
    }
  });

  test("skill-sys registry and dispatcher expose guard-repo-visibility", () => {
    expect(registry.resolveSkillSysCommandName("guard-repo-visibility")).toBe("guard-repo-visibility");
    expect(registry.publicSkillSysCommands().some((command) => command.name === "guard-repo-visibility")).toBe(true);

    const plan = skillSys.buildCommand(
      skillSys.parseCli([
        "bun",
        "skill-sys.ts",
        "guard-repo-visibility",
        "--json",
        "--local-ok",
        "--allow-public-after-explicit-user-approval",
      ])
    );

    expect(plan.argv[0]).toBe("bun");
    expect(plan.argv[1]).toEndWith("scripts/commands/guard-repo-visibility.ts");
    expect(plan.argv.slice(2)).toEqual([
      "--json",
      "--local-ok",
      "--allow-public-after-explicit-user-approval",
    ]);
  });

  test("discarded first-party repository names stay out of tracked content", () => {
    const blockedNames = [
      ["evandro", "skillpack", "private"].join("-"),
      ["skill", "universal"].join("-"),
    ];
    const offenders: string[] = [];

    for (const file of trackedFiles()) {
      const content = readFileSync(file, "utf8");
      for (const blockedName of blockedNames) {
        if (content.includes(blockedName)) {
          offenders.push(`${file}: ${blockedName}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
