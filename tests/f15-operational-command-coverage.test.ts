import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  main as budgetMain,
  parseArgs as parseBudgetArgs,
} from "../scripts/commands/budget-doctor.ts";
import {
  main as evalMain,
  parseArgs as parseEvalArgs,
} from "../scripts/commands/eval.ts";
import {
  buildCommonFlags,
  main as installMain,
  parseArgs as parseInstallArgs,
} from "../scripts/commands/install-skills.ts";
import * as publish from "../scripts/commands/publish-skill.ts";
import {
  main as rollbackMain,
  parseArgs as parseRollbackArgs,
  planRollback,
} from "../scripts/commands/rollback.ts";
import {
  main as upgradeMain,
  parseArgs as parseUpgradeArgs,
} from "../scripts/commands/upgrade-project.ts";

const tempDirs: string[] = [];

function tempRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tempDirs.push(root);
  return root;
}

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSemanticFixture(): string {
  const root = tempRoot("operational-semantic");
  writeText(
    path.join(root, "skills", "alpha", "SKILL.md"),
    [
      "---",
      "name: alpha",
      "description: Use when alpha testing is requested.",
      "metadata:",
      "  triggers: alpha, testing",
      "---",
      "# Alpha",
      "",
    ].join("\n"),
  );
  writeJson(path.join(root, "globals", "core.json"), {
    sets: { default: ["alpha"] },
  });
  writeJson(path.join(root, "adapters", "codex.json"), {
    name: "codex",
    targetPath: ".agents/skills",
  });
  writeJson(path.join(root, "profiles", "default.json"), {
    name: "default",
    skills: ["alpha"],
  });
  writeJson(path.join(root, "skills", "alpha", "evals", "triggers.json"), {
    positive: [
      {
        prompt: "Please run alpha testing",
        expectedSkill: "alpha",
      },
    ],
    collision: [
      {
        prompt: "Alpha testing",
        allowed: ["alpha"],
        preferred: "alpha",
      },
    ],
  });
  return root;
}

function captureLogs<T>(callback: () => T): { value: T; stdout: string } {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { value: callback(), stdout: lines.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

afterEach(() => {
  process.exitCode = undefined;
  for (const root of tempDirs.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("budget-doctor and eval command adapters", () => {
  test("budget-doctor parses every option and rejects malformed input", () => {
    const args = parseBudgetArgs([
      "bun",
      "budget-doctor.ts",
      "--source",
      "fixtures/pool",
      "--provider",
      "claude-code",
      "--global-core",
      "--budget",
      "120",
      "--json",
    ]);

    expect(args).toEqual({
      source: path.resolve(process.cwd(), "fixtures/pool"),
      provider: "claude-code",
      globalCore: true,
      budget: 120,
      json: true,
      help: false,
    });
    expect(parseBudgetArgs(["bun", "budget-doctor.ts", "-h"]).help).toBe(true);
    expect(() => parseBudgetArgs(["bun", "budget-doctor.ts", "--provider", "all"])).toThrow(
      "--provider expects one provider id",
    );
    expect(() => parseBudgetArgs(["bun", "budget-doctor.ts", "--budget", "0"])).toThrow(
      "--budget must be a positive integer",
    );
    expect(() => parseBudgetArgs(["bun", "budget-doctor.ts", "--source"])).toThrow(
      "Missing value",
    );
    expect(() => parseBudgetArgs(["bun", "budget-doctor.ts", "--wat"])).toThrow(
      "Unknown argument: --wat",
    );
  });

  test("budget-doctor emits human warnings, JSON results, and help", () => {
    const root = writeSemanticFixture();
    const human = captureLogs(() =>
      budgetMain([
        "bun",
        "budget-doctor.ts",
        "--source",
        root,
        "--budget",
        "1",
      ]),
    );
    expect(human.stdout).toContain("STATUS: WARN");
    expect(human.stdout).toContain("Suggested:");
    expect(human.stdout).toContain("SKILL_LISTING_BUDGET_EXCEEDED");

    const json = captureLogs(() =>
      budgetMain([
        "bun",
        "budget-doctor.ts",
        "--source",
        root,
        "--global-core",
        "--json",
      ]),
    );
    expect(JSON.parse(json.stdout)).toMatchObject({
      provider: "codex",
      scope: "global-core",
      skills: [{ skill: "alpha", globalCore: true }],
    });
    expect(captureLogs(() => budgetMain(["bun", "budget-doctor.ts", "--help"])).stdout).toContain(
      "Estimate provider initial skill listing budget",
    );
  });

  test("eval parses command modes and rejects invalid commands, providers, and options", () => {
    expect(
      parseEvalArgs([
        "bun",
        "eval.ts",
        "collisions",
        "--source",
        "fixtures/pool",
        "--provider",
        "opencode",
        "--json",
      ]),
    ).toEqual({
      command: "collisions",
      source: path.resolve(process.cwd(), "fixtures/pool"),
      provider: "opencode",
      json: true,
      help: false,
    });
    expect(parseEvalArgs(["bun", "eval.ts"]).command).toBe("triggers");
    expect(parseEvalArgs(["bun", "eval.ts", "--help"]).help).toBe(true);
    expect(() => parseEvalArgs(["bun", "eval.ts", "unknown"])).toThrow(
      "Unknown eval command: unknown",
    );
    expect(() => parseEvalArgs(["bun", "eval.ts", "triggers", "--provider", "all"])).toThrow(
      "--provider expects one provider id",
    );
    expect(() => parseEvalArgs(["bun", "eval.ts", "triggers", "--wat"])).toThrow(
      "Unknown argument: --wat",
    );
  });

  test("eval emits human and JSON reports for both command modes", () => {
    const validRoot = writeSemanticFixture();
    const human = captureLogs(() =>
      evalMain(["bun", "eval.ts", "collisions", "--source", validRoot]),
    );
    expect(human.stdout).toContain("STATUS: PASS");
    expect(human.stdout).toContain("Fixtures: 1");
    expect(human.stdout).toContain("Cases: 2");

    const json = captureLogs(() =>
      evalMain(["bun", "eval.ts", "triggers", "--source", validRoot, "--json"]),
    );
    expect(JSON.parse(json.stdout)).toMatchObject({
      provider: "codex",
      fixtureCount: 1,
      caseCount: 2,
      findings: [],
    });
    expect(process.exitCode ?? 0).toBe(0);

    expect(captureLogs(() => evalMain(["bun", "eval.ts", "--help"])).stdout).toContain(
      "Evaluate semantic skill fixtures",
    );
  });
});

describe("install-skills and upgrade-project orchestration", () => {
  test("install-skills parses flags, builds stable common flags, and rejects unknown input", () => {
    const options = parseInstallArgs([
      "bun",
      "install-skills.ts",
      "--project",
      "/work/project",
      "--lockfile",
      "skills.lock.json",
      "--source",
      "/work/pool",
      "--refresh-cache",
      "--strict-hash",
      "--dry-run",
    ]);

    expect(options).toMatchObject({
      project: "/work/project",
      lockfile: "skills.lock.json",
      source: "/work/pool",
      refreshCache: true,
      strictHash: true,
      dryRun: true,
    });
    expect(buildCommonFlags(options)).toEqual([
      "--project",
      "/work/project",
      "--lockfile",
      "skills.lock.json",
      "--source",
      "/work/pool",
      "--refresh-cache",
      "--dry-run",
    ]);
    expect(buildCommonFlags({})).toEqual([]);
    expect(parseInstallArgs(["bun", "install-skills.ts", "-h"]).help).toBe(true);
    expect(() => parseInstallArgs(["bun", "install-skills.ts", "--project"])).toThrow(
      "Missing value",
    );
    expect(() => parseInstallArgs(["bun", "install-skills.ts", "--wat"])).toThrow(
      "Unknown option: --wat",
    );
    expect(() => parseInstallArgs(["bun", "install-skills.ts", "stray"])).toThrow(
      "Unknown argument: stray",
    );
  });

  test("install-skills runs install then doctor with command-specific flags", () => {
    const calls: Array<{ subcommand: string; args: string[] }> = [];
    const result = captureLogs(() =>
      installMain(
        [
          "bun",
          "install-skills.ts",
          "--project",
          "project",
          "--source",
          "pool",
          "--dry-run",
          "--strict-hash",
        ],
        (subcommand, args) => calls.push({ subcommand, args: [...args] }),
      ),
    );

    expect(calls).toEqual([
      {
        subcommand: "install",
        args: ["--project", "project", "--source", "pool", "--dry-run"],
      },
      {
        subcommand: "doctor",
        args: ["--project", "project", "--source", "pool", "--strict-hash"],
      },
    ]);
    expect(result.stdout).toContain("Done: skills installed and verified.");
    expect(captureLogs(() => installMain(["bun", "install-skills.ts", "--help"])).stdout).toContain(
      "Install project skills from lockfile",
    );
  });

  test("upgrade-project validates required options and resolves filesystem paths", () => {
    const args = parseUpgradeArgs([
      "bun",
      "upgrade-project.ts",
      "--project",
      "fixtures/project",
      "--repo",
      "repo.git",
      "--ref",
      "v2",
      "--lockfile",
      "custom.lock.json",
      "--source",
      "fixtures/pool",
      "--refresh-cache",
    ]);
    expect(args).toEqual({
      project: path.resolve(process.cwd(), "fixtures/project"),
      repo: "repo.git",
      ref: "v2",
      lockfile: "custom.lock.json",
      source: path.resolve(process.cwd(), "fixtures/pool"),
      refreshCache: true,
    });
    expect(parseUpgradeArgs(["bun", "upgrade-project.ts", "--help"]).help).toBe(true);
    expect(() => parseUpgradeArgs(["bun", "upgrade-project.ts", "--ref", "v2"])).toThrow(
      "Missing --project",
    );
    expect(() => parseUpgradeArgs(["bun", "upgrade-project.ts", "--project", "."])).toThrow(
      "Missing --ref (or provide --repo)",
    );
    expect(() => parseUpgradeArgs(["bun", "upgrade-project.ts", "--wat"])).toThrow(
      "Unknown option: --wat",
    );
  });

  test("upgrade-project invokes upgrade then strict doctor with matching overrides", () => {
    const calls: string[][] = [];
    const project = tempRoot("upgrade-project");
    const source = tempRoot("upgrade-source");
    upgradeMain(
      [
        "bun",
        "upgrade-project.ts",
        "--project",
        project,
        "--repo",
        "repo.git",
        "--ref",
        "v2",
        "--lockfile",
        "custom.lock.json",
        "--source",
        source,
        "--refresh-cache",
      ],
      (args) => calls.push([...args]),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "upgrade",
        "--project",
        project,
        "--repo",
        "repo.git",
        "--ref",
        "v2",
        "--lockfile",
        "custom.lock.json",
        "--source",
        source,
        "--refresh-cache",
      ]),
    );
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        "doctor",
        "--project",
        project,
        "--strict-hash",
        "--lockfile",
        "custom.lock.json",
        "--source",
        source,
        "--refresh-cache",
      ]),
    );
    expect(captureLogs(() => upgradeMain(["bun", "upgrade-project.ts", "--help"])).stdout).toContain(
      "Upgrade project lockfile ref",
    );
  });
});

describe("publish-skill safety and orchestration", () => {
  const defaultRepo = "https://example.invalid/skills.git";

  test("parseArgs supports the full publish contract and fails closed for unsafe names", () => {
    const cwd = tempRoot("publish-cwd");
    const args = publish.parseArgs(
      [
        "bun",
        "publish-skill.ts",
        "--repo",
        "opencode",
        "--project",
        cwd,
        "--branch",
        "release",
        "--app",
        "codex",
        "--skill",
        "alpha",
        "--workdir",
        "checkout",
        "--message",
        "update alpha",
        "--push",
        "--dry-run",
      ],
      { cwd, detectDefaultRepo: () => defaultRepo },
    );

    expect(args).toMatchObject({
      repo: defaultRepo,
      project: cwd,
      branch: "release",
      app: "codex",
      skill: "alpha",
      workdir: "checkout",
      message: "update alpha",
      push: true,
      commit: true,
      dryRun: true,
    });
    expect(
      publish.parseArgs(["bun", "publish-skill.ts", "--help"], {
        cwd,
        detectDefaultRepo: () => defaultRepo,
      }).help,
    ).toBe(true);
    expect(() =>
      publish.parseArgs(["bun", "publish-skill.ts", "--skill", "alpha"], {
        cwd,
        detectDefaultRepo: () => defaultRepo,
      }),
    ).toThrow("Missing required --app");
    expect(() =>
      publish.parseArgs(["bun", "publish-skill.ts", "--app", "codex", "--skill", "../alpha"], {
        cwd,
        detectDefaultRepo: () => defaultRepo,
      }),
    ).toThrow("path separators are not allowed");
    expect(() =>
      publish.parseArgs(["bun", "publish-skill.ts", "--wat"], {
        cwd,
        detectDefaultRepo: () => defaultRepo,
      }),
    ).toThrow("Unknown option: --wat");
  });

  test("run and detectRemote normalize injected command results and failures", () => {
    const calls: string[][] = [];
    const runner = (args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: " origin.git \n", stderr: "" };
    };
    expect(publish.detectRemote("/repo", { runCommand: runner })).toBe("origin.git");
    expect(calls[0]).toEqual([
      "git",
      "-C",
      "/repo",
      "config",
      "--get",
      "remote.origin.url",
    ]);

    const ok = publish.run("git", ["status"], { cwd: "/repo" }, { runCommand: runner });
    expect(ok.stdout).toContain("origin.git");
    expect(() =>
      publish.run(
        "git",
        ["status"],
        {},
        { runCommand: () => ({ code: 2, stdout: "out", stderr: "bad" }) },
      ),
    ).toThrow("Command failed (2): git status");
    expect(
      publish.run(
        "git",
        ["status"],
        { allowFailure: true },
        { runCommand: () => ({ code: 2, stdout: "", stderr: "bad" }) },
      ).code,
    ).toBe(2);
  });

  test("adapter and source guards accept real skills and reject missing entries", () => {
    expect(publish.loadAdapter("codex")).toMatchObject({ targetPath: ".agents/skills" });
    expect(() => publish.loadAdapter("../codex")).toThrow("path separators are not allowed");

    const skill = path.join(tempRoot("publish-source"), "alpha");
    expect(() => publish.ensureSkillPath(skill, "Source")).toThrow("Source path not found");
    writeText(path.join(skill, "SKILL.md"), "# Alpha\n");
    expect(() => publish.ensureSkillPath(skill, "Source")).not.toThrow();
    expect(() => publish.scanSensitiveSkill(skill)).not.toThrow();
  });

  test("resolveWorkdir stays within the configured publish base", () => {
    const home = tempRoot("publish-home");
    const project = tempRoot("publish-project");
    const baseOptions = {
      repo: defaultRepo,
      project,
      branch: "main",
      commit: false,
      push: false,
      dryRun: true,
      app: "codex",
      skill: "alpha",
    };
    const env = { ...process.env, SKILLPOOL_HOME: home };
    const generated = publish.resolveWorkdir(baseOptions, {
      env,
      now: () => new Date("2026-07-27T12:34:56.000Z"),
    });
    expect(generated).toBe(
      path.join(home, "publish", "2026-07-27T12-34-56-000Z-alpha"),
    );

    const explicit = path.join(home, "publish", "explicit");
    expect(publish.resolveWorkdir({ ...baseOptions, workdir: explicit }, { env })).toBe(explicit);
    expect(() =>
      publish.resolveWorkdir({ ...baseOptions, workdir: project }, { env }),
    ).toThrow("Unsafe --workdir target");
    expect(() =>
      publish.resolveWorkdir({ ...baseOptions, workdir: path.join(home, "outside") }, { env }),
    ).toThrow("--workdir must be inside publish base");
  });

  test("fetchPublishWorkdir retries ref candidates and reports aggregate failure", () => {
    const calls: string[][] = [];
    let fetches = 0;
    publish.fetchPublishWorkdir(defaultRepo, "release", "/checkout", (command, args) => {
      calls.push([command, ...args]);
      if (args.includes("fetch")) {
        fetches += 1;
        if (fetches === 1) {
          throw new Error("missing tag");
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(fetches).toBe(2);
    expect(calls.some((call) => call.includes("refs/remotes/origin/release"))).toBe(true);

    expect(() =>
      publish.fetchPublishWorkdir(defaultRepo, "missing", "/checkout", (_command, args) => {
        if (args.includes("fetch")) {
          throw new Error("not found");
        }
        return { code: 0, stdout: "", stderr: "" };
      }),
    ).toThrow("Failed to fetch Git ref 'missing'");
  });

  test("publishSkill dry-run validates paths but skips mutation and sensitive scan", () => {
    const project = tempRoot("publish-dry-project");
    const logs: string[] = [];
    const validatedPaths: Array<[string, string]> = [];
    let scanned = false;
    let ran = false;
    const result = publish.publishSkill(
      {
        repo: defaultRepo,
        project,
        branch: "main",
        commit: false,
        push: false,
        dryRun: true,
        app: "codex",
        skill: "alpha",
      },
      {
        loadAdapter: () => ({ targetPath: ".agents/skills" }),
        ensureSkillPath: (skillPath, label) => {
          validatedPaths.push([skillPath, label]);
        },
        scanSensitiveSkill: () => {
          scanned = true;
        },
        resolveWorkdir: () => path.join(project, "checkout"),
        run: () => {
          ran = true;
          return { code: 0, stdout: "", stderr: "" };
        },
        log: (line) => logs.push(line),
      },
    );

    expect(result).toEqual({
      workdir: path.join(project, "checkout"),
      changed: false,
      dryRun: true,
    });
    expect(validatedPaths).toEqual([[path.join(project, ".agents", "skills", "alpha"), "Source"]]);
    expect(scanned).toBe(false);
    expect(ran).toBe(false);
    expect(logs.at(-1)).toContain("Dry-run");
  });

  test("publishSkill detects no changes and performs commit plus push when changed", () => {
    const project = tempRoot("publish-write-project");
    const workdir = path.join(tempRoot("publish-write-base"), "checkout");
    const baseOptions = {
      repo: defaultRepo,
      project,
      branch: "release",
      push: false,
      dryRun: false,
      app: "codex",
      skill: "alpha",
    };
    const baseDeps = {
      loadAdapter: () => ({ targetPath: ".agents/skills" }),
      ensureSkillPath: () => {},
      scanSensitiveSkill: () => {},
      resolveWorkdir: () => workdir,
      copySkillDirectory: () => {},
      log: () => {},
    };

    const noChange = publish.publishSkill(
      { ...baseOptions, commit: false },
      {
        ...baseDeps,
        run: (_command, args) => ({
          code: 0,
          stdout: args.includes("status") ? "" : "ok",
          stderr: "",
        }),
      },
    );
    expect(noChange).toEqual({ workdir, changed: false, dryRun: false });

    const commands: string[][] = [];
    const logs: string[] = [];
    const changed = publish.publishSkill(
      {
        ...baseOptions,
        commit: true,
        push: true,
        message: "update alpha",
      },
      {
        ...baseDeps,
        run: (command, args) => {
          commands.push([command, ...args]);
          return {
            code: 0,
            stdout: args.includes("status")
              ? " M skills/alpha/SKILL.md\n?? skills/alpha/new.md\n"
              : "",
            stderr: "",
          };
        },
        log: (line) => logs.push(line),
      },
    );

    expect(changed).toEqual({ workdir, changed: true, dryRun: false });
    expect(commands.some((command) => command.includes("add"))).toBe(true);
    expect(commands.some((command) => command.includes("commit"))).toBe(true);
    expect(commands.some((command) => command.includes("push"))).toBe(true);
    expect(logs.join("\n")).toContain("Pushed to origin/release");
  });

  test("publish main delegates parsed options and help to injected dependencies", () => {
    const project = tempRoot("publish-main-project");
    const result = publish.main(
      [
        "bun",
        "publish-skill.ts",
        "--app",
        "codex",
        "--skill",
        "alpha",
        "--dry-run",
      ],
      {
        cwd: project,
        detectDefaultRepo: () => defaultRepo,
        loadAdapter: () => ({ targetPath: ".agents/skills" }),
        ensureSkillPath: () => {},
        resolveWorkdir: () => path.join(project, "checkout"),
        log: () => {},
      },
    );
    expect(result).toEqual({
      workdir: path.join(project, "checkout"),
      changed: false,
      dryRun: true,
    });
    expect(
      captureLogs(() =>
        publish.main(["bun", "publish-skill.ts", "--help"], {
          cwd: project,
          detectDefaultRepo: () => defaultRepo,
        }),
      ).stdout,
    ).toContain("Publish improved skill");
  });
});

describe("rollback command edge behavior", () => {
  test("rollback parses defaults and all flags and rejects target escapes", () => {
    const project = tempRoot("rollback-project");
    expect(parseRollbackArgs(["bun", "rollback.ts"])).toEqual({
      project: path.resolve(process.cwd()),
      target: ".agents/skills",
      installId: "latest",
      dryRun: false,
      json: false,
      help: false,
    });
    expect(
      parseRollbackArgs([
        "bun",
        "rollback.ts",
        "--project",
        project,
        "--target",
        "custom/skills",
        "--install-id",
        "0001",
        "--dry-run",
        "--json",
      ]),
    ).toMatchObject({
      project,
      target: "custom/skills",
      installId: "0001",
      dryRun: true,
      json: true,
    });
    expect(parseRollbackArgs(["bun", "rollback.ts", "--help"]).help).toBe(true);
    expect(() => parseRollbackArgs(["bun", "rollback.ts", "--wat"])).toThrow(
      "Unknown argument: --wat",
    );
    expect(() =>
      planRollback({
        project,
        target: "../outside",
        installId: "latest",
        dryRun: true,
        json: false,
        help: false,
      }),
    ).toThrow("Rollback target must stay within project");
  });

  test("rollback reports NOOP and JSON when no completed backup exists", () => {
    const project = tempRoot("rollback-noop");
    const human = captureLogs(() =>
      rollbackMain(["bun", "rollback.ts", "--project", project]),
    );
    expect(human.stdout).toContain("STATUS: NOOP");
    expect(human.stdout).toContain("Backup: none");

    const json = captureLogs(() =>
      rollbackMain(["bun", "rollback.ts", "--project", project, "--json"]),
    );
    expect(JSON.parse(json.stdout)).toEqual({
      backupId: null,
      actions: [],
      dryRun: false,
    });
    expect(captureLogs(() => rollbackMain(["bun", "rollback.ts", "--help"])).stdout).toContain(
      "Restore skills from a .skill-sys-backup entry",
    );
  });
});
