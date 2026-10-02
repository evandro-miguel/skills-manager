import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../scripts/lib/command.ts";

const repoRoot = path.resolve(__dirname, "..");

const argsLib = require("../scripts/lib/args.ts") as typeof import("../scripts/lib/args.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");
const skillpool = require("../scripts/commands/skillpool.ts") as typeof import("../scripts/commands/skillpool.ts");
const coverageGate = require("../scripts/commands/coverage-gate.ts") as typeof import("../scripts/commands/coverage-gate.ts");
const upgradeModule = require("../scripts/modules/skillpool/upgrade.ts") as typeof import("../scripts/modules/skillpool/upgrade.ts");

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

function jsonFiles(dir: string): string[] {
  return fs
    .readdirSync(path.join(repoRoot, dir))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
}

describe("shared CLI parser helper", () => {
  test("parses strict, permissive, repeated, equals, and no-prefix forms", () => {
    const spec = { boolean: new Set(["dry-run", "install"]), value: new Set(["project", "tag"]) };
    expect(
      argsLib.parseCliOptions(
        ["bun", "tool", "cmd", "--project", ".", "--dry-run", "--tag=v1", "--", "--literal"],
        3,
        spec,
        { allowEquals: true, repeat: "collect", strict: true },
      ),
    ).toEqual({ _: ["--literal"], project: ".", "dry-run": true, tag: "v1" });

    expect(
      argsLib.parseCliOptions(["bun", "tool", "cmd", "--no-install", "--loose", "value"], 3, null, {
        allowNoPrefix: true,
        strict: false,
      }),
    ).toEqual({ _: [], install: false, loose: "value" });

    expect(argsLib.parseCsv("alpha, beta,,gamma")).toEqual(["alpha", "beta", "gamma"]);
    expect(argsLib.unique(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(argsLib.requireOptionValue(["cmd", "--name", "alpha"], 1, "--name")).toBe("alpha");
    expect(() => argsLib.requireOptionValue(["cmd", "--name"], 1, "--name")).toThrow("Missing value for --name");
  });

  test("preserves edge semantics for exported legacy helpers and parser repeat modes", () => {
    const spec = { boolean: new Set(["flag"]), value: new Set(["name", "tag"]) };
    expect(argsLib.parseCsv(undefined, ["fallback"])).toEqual(["fallback"]);
    expect(argsLib.unique(new Set(["alpha", "beta"]))).toEqual(["alpha", "beta"]);
    expect(
      argsLib.parseCliOptions(["bun", "tool", "--name", "alpha", "--name", "beta", "positional"], 2, spec, {
        repeat: "collect",
        strict: true,
      }),
    ).toEqual({ _: ["positional"], name: ["alpha", "beta"] });
    expect(
      argsLib.parseCliOptions(["bun", "tool", "--flag", "--tag=", "--name", "beta"], 2, spec, {
        allowEquals: true,
        strict: true,
      }),
    ).toEqual({ _: [], flag: true, tag: "", name: "beta" });
    expect(() =>
      argsLib.parseCliOptions(["bun", "tool", "--flag=value"], 2, spec, { allowEquals: true, strict: true }),
    ).toThrow("Unknown option: --flag");
  });
});

describe("CLI parser characterization", () => {
  test("skill-sys preserves compatibility flags when planning skillpool backends", () => {
    const update = skillSys.parseCli(["bun", "skill-sys", "update", "--no-install", "--legacy-raw-install"]);
    expect(update.command).toBe("update");
    expect(update.args["no-install"]).toBe(true);
    expect(update.args["legacy-raw-install"]).toBe(true);

    const install = skillSys.parseCli([
      "bun",
      "skill-sys",
      "install",
      "--legacy-raw-install",
      "--install-mode",
      "copy",
      "--project",
      ".",
      "--projection-dir",
      "dist/projection-smoke",
    ]);
    expect(install.args["legacy-raw-install"]).toBe(true);
    expect(install.args["install-mode"]).toBe("copy");
    expect(install.args.project).toBe(".");
    expect(install.args["projection-dir"]).toBe("dist/projection-smoke");
  });

  test("skillpool parser keeps install and upgrade compatibility semantics", () => {
    const install = skillpool.parseCli([
      "bun",
      "skillpool",
      "install",
      "--projection-dir",
      "dist/projection-smoke",
      "--install-mode",
      "projection",
      "--legacy-raw-install",
    ]);
    expect(install.command).toBe("install");
    expect(install.args["projection-dir"]).toBe("dist/projection-smoke");
    expect(install.args["install-mode"]).toBe("projection");
    expect(install.args["legacy-raw-install"]).toBe(true);

    const upgrade = skillpool.parseCli(["bun", "skillpool", "upgrade", "--no-install"]);
    expect(upgrade.command).toBe("upgrade");
    expect(upgrade.args.install).toBe(false);
  });

  test("strict parser surfaces reject unknown options and missing values", () => {
    expect(() => skillSys.parseCli(["bun", "skill-sys", "install", "--unknown"])).toThrow("Unknown option: --unknown");
    expect(() => skillSys.parseCli(["bun", "skill-sys", "install", "--project"])).toThrow("Missing value for --project");
    expect(() => skillSys.parseCli(["bun", "skill-sys", "install", "--projection-dir"])).toThrow(
      "Missing value for --projection-dir",
    );
    expect(() => skillSys.parseCli(["bun", "skill-sys", "install", "--install-mode"])).toThrow(
      "Missing value for --install-mode",
    );
    expect(() => skillpool.parseCli(["bun", "skillpool", "install", "--unknown"])).toThrow("Unknown option: --unknown");
    expect(() => skillpool.parseCli(["bun", "skillpool", "install", "--projection-dir"])).toThrow(
      "Missing value for --projection-dir",
    );
    expect(() => skillpool.parseCli(["bun", "skillpool", "install", "--install-mode"])).toThrow(
      "Missing value for --install-mode",
    );
  });
});

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

describe("skill-sys command planning characterization", () => {
  test("plans compatibility backend commands and provider/package gates without executing them", () => {
    const plans = [
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "add", "owner/repo", "--project", ".", "--skill", "alpha", "--agent", "codex"]), { cwd: repoRoot }),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "update", "--project", ".", "--ref", "v1.2.3", "--no-install"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "doctor", "--budget", "--provider", "codex", "--global-core", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "doctor", "--duplicates", "--permissions", "--source", "."])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "validate", "--source", ".", "--strict-hash", "--state-safety"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "scan-sensitive", "--source", ".", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "scan-privacy", "--source", ".", "--surface", "engine-public", "--strict"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "scan-security", "--source", ".", "--strict", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "verify-sandbox", "--source", ".", "--plan", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "public-audit", "--source", ".", "--surface", "engine-public", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "packlist", "--source", ".", "--surface", "engine-public", "--hashes"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "npm-pack-audit", "--source", ".", "--surface", "engine-public"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "validate-registry-surface", "--source", ".", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "validate-skillpack", "--source", ".", "--strict", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "create-skillpack", "tmp/pkg", "--name", "pkg", "--providers", "codex", "--dry-run"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "verify-origin", "--source", ".", "--version", "v1.2.3", "--require-skill-bom", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "build-projections", "--source", ".", "--providers", "all", "--out-dir", "dist", "--projection-store-dir", ".tmp/projection-store", "--clean", "--include-user"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "validate-projections", "--source", ".", "--providers", "all", "--out-dir", "dist", "--include-user"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "semantic-audit", "--source", ".", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "docs-check", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "guard-repo-visibility", "--repository", "owner/repo", "--local-ok"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "eval", "collisions", "--provider", "codex", "--source", "."])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "list", "--profile", "core", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "find", "parser", "--names-only"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "sync", "--global-core", "--source", ".", "--apps", "codex", "--dry-run"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "sync", "--project", ".", "--profile", "core", "--plan", "--json"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "sync", "--from", "a", "--to", "b", "--skill", "alpha", "--delete"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "rollback", "--project", ".", "--install-id", "1", "--dry-run"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "setup", "--repo", "owner/repo", "--app", "codex", "--no-global-sync"])),
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "init", "--project", ".", "--force", "--dry-run"])),
    ];

    expect(plans).toHaveLength(30);
    expect(plans[0]?.argv).toContain("--repo");
    expect(plans[1]?.argv).toContain("--no-install");
    expect(plans.every((plan) => plan.argv[0] === "bun")).toBe(true);
    // PR10: remove plans in-process and can apply destructively. Bare or
    // conflicting remove still fails closed at the dispatch boundary
    // (buildCommand), while valid plan/apply requests route to an in-process
    // marker. See remove-planner.test.ts and remove-apply.test.ts for the
    // read-only planner and the rollback-compatible apply path.
    expect(() => skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "remove"]))).toThrow(
      "Usage: skill-sys remove",
    );
    expect(() =>
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "remove", "--project", "."])),
    ).toThrow("plan-only");
    expect(() =>
      skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "remove", "--project", ".", "--plan"])),
    ).toThrow("--all");
    const removeApplyMarker = skillSys.buildCommand(
      skillSys.parseCli(["bun", "skill-sys", "remove", "--project", ".", "--skill", "alpha", "--apply"]),
    );
    expect(removeApplyMarker.argv).toContain("--apply");
    expect(removeApplyMarker.argv).toContain("--skill");
    expect(removeApplyMarker.argv).toContain("alpha");
    expect(removeApplyMarker.argv).not.toContain("--plan");
    const removePlanMarker = skillSys.buildCommand(
      skillSys.parseCli(["bun", "skill-sys", "remove", "--project", ".", "--skill", "alpha", "--plan"]),
    );
    expect(removePlanMarker.argv).toContain("--skill");
    expect(removePlanMarker.argv).toContain("alpha");
    expect(removePlanMarker.argv).toContain("--plan");
    expect(() => skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "eval", "unknown"]))).toThrow("Usage: skill-sys eval");
  });

  test("plans projection-dir for add/install and routes skillPath metadata for tree URLs", () => {
    const addPlan = skillSys.buildCommand(
      skillSys.parseCli(["bun", "skill-sys", "add", "owner/repo", "--project", ".", "--projection-dir", "dist/provider"]),
      { cwd: repoRoot },
    );
    const addCopyPlan = skillSys.buildCommand(
      skillSys.parseCli(["bun", "skill-sys", "add", "owner/repo", "--project", ".", "--install-mode", "copy"]),
      { cwd: repoRoot },
    );
    const treePlan = skillSys.buildCommand(
      skillSys.parseCli([
        "bun",
        "skill-sys",
        "add",
        "https://github.com/org/repo/tree/main/skills/foo",
        "--project",
        ".",
        "--projection-dir",
        "dist/provider",
      ]),
      { cwd: repoRoot },
    );
    const localSkillDirPlan = skillSys.buildCommand(
      skillSys.parseCli([
        "bun",
        "skill-sys",
        "add",
        "./examples/minimal-skillpack/skills/example-skill",
        "--project",
        ".",
      ]),
      { cwd: repoRoot },
    );
    const installPlan = skillSys.buildCommand(
      skillSys.parseCli(["bun", "skill-sys", "install", "--project", ".", "--projection-dir", "dist/provider"]),
      { cwd: repoRoot },
    );
    const updatePlan = skillSys.buildCommand(
      skillSys.parseCli(["bun", "skill-sys", "update", "--project", ".", "--ref", "v1.2.3", "--no-install"]),
      { cwd: repoRoot },
    );

    expect(valueAfter(addPlan.argv, "--projection-dir")).toBe("dist/provider");
    expect(valueAfter(addPlan.argv, "--repo")).toBe("https://github.com/owner/repo.git");
    expect(valueAfter(addCopyPlan.argv, "--install-mode")).toBe("copy");
    expect(valueAfter(treePlan.argv, "--projection-dir")).toBe("dist/provider");
    expect(valueAfter(treePlan.argv, "--repo")).toBe("https://github.com/org/repo.git");
    expect(valueAfter(treePlan.argv, "--ref")).toBe("main");
    expect(valueAfter(treePlan.argv, "--skill-path")).toBe("skills/foo");
    expect(valueAfter(treePlan.argv, "--skills")).toBe("foo");
    expect(valueAfter(installPlan.argv, "--projection-dir")).toBe("dist/provider");
    expect(valueAfter(localSkillDirPlan.argv, "--source")).toBe(path.join(repoRoot, "examples/minimal-skillpack"));
    expect(valueAfter(localSkillDirPlan.argv, "--skills")).toBe("example-skill");
    expect(updatePlan.argv).toContain("upgrade");
    expect(updatePlan.argv).toContain("--no-install");
    expect(updatePlan.argv).not.toContain("--projection-dir");

    // PR04: update now forwards --projection-dir/--install-mode to the upgrade
    // reinstall path instead of rejecting it.
    const updateProjectionPlan = skillSys.buildCommand(
      skillSys.parseCli([
        "bun",
        "skill-sys",
        "update",
        "--project",
        ".",
        "--ref",
        "v1.2.3",
        "--projection-dir",
        "dist/provider",
        "--install-mode",
        "projection",
      ]),
      { cwd: repoRoot },
    );
    expect(updateProjectionPlan.argv).toContain("upgrade");
    expect(valueAfter(updateProjectionPlan.argv, "--projection-dir")).toBe("dist/provider");
    expect(valueAfter(updateProjectionPlan.argv, "--install-mode")).toBe("projection");
    expect(updateProjectionPlan.argv).not.toContain("--legacy-raw-install");

    const updateSkillPlan = skillSys.buildCommand(
      skillSys.parseCli(["bun", "skill-sys", "update", "alpha", "--project", "."]),
      { cwd: repoRoot },
    );
    expect(updateSkillPlan.argv).toContain("upgrade");
    expect(valueAfter(updateSkillPlan.argv, "--skills")).toBe("alpha");
    expect(updateSkillPlan.argv).not.toContain("--ref");
    expect(() =>
      skillSys.buildCommand(
        skillSys.parseCli(["bun", "skill-sys", "update", "../escape", "--project", "."]),
        { cwd: repoRoot },
      ),
    ).toThrow("Invalid skill name");
  });

  test("forwards direct --app and --agent through skill-sys main and executes a copy smoke", () => {
    const captured: string[][] = [];
    for (const flag of ["--app", "--agent"]) {
      const result = skillSys.main(
        [
          "bun",
          "skill-sys",
          "install",
          "--project",
          ".",
          "--source",
          path.join(repoRoot, "examples/minimal-skillpack"),
          "--skills",
          "example-skill",
          flag,
          "codex",
          "--install-mode",
          "copy",
        ],
        {
          cwd: repoRoot,
          run: (argv) => {
            captured.push(argv);
            return { code: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(result).toBe(0);
    }
    expect(captured).toHaveLength(2);
    for (const argv of captured) {
      expect(valueAfter(argv, "--app")).toBe("codex");
      expect(valueAfter(argv, "--source")).toBe(path.join(repoRoot, "examples/minimal-skillpack"));
      expect(argv).toContain("--legacy-raw-install");
    }

    const project = makeTempRoot("skill-sys-direct-app-");
    const result = skillSys.main(
      [
        "bun",
        "skill-sys",
        "install",
        "--project",
        project,
        "--source",
        path.join(repoRoot, "examples/minimal-skillpack"),
        "--skills",
        "example-skill",
        "--agent",
        "codex",
        "--install-mode",
        "copy",
      ],
      {
        cwd: repoRoot,
        run: (argv) => runCommand(argv, { cwd: repoRoot, stdout: "pipe", stderr: "pipe", allowFailure: true }),
      },
    );
    expect(result).toBe(0);
    expect(fs.existsSync(path.join(project, ".agents", "skills", "example-skill", "SKILL.md"))).toBe(true);
  });
});

describe("skillpool entrypoint characterization", () => {
  test("dispatches help and supported commands through injected dependencies", () => {
    const help: string[] = [];
    skillpool.main(["bun", "skillpool", "help"], { printHelp: () => help.push("help") });
    expect(help).toEqual(["help"]);

    const calls: Array<[string, unknown]> = [];
    skillpool.main(["bun", "skillpool", "install", "--project", ".", "--legacy-raw-install"], {
      installCommand: (args) => calls.push(["install", args]),
    });
    skillpool.main(["bun", "skillpool", "doctor", "--project", ".", "--strict-hash"], {
      doctorCommand: (args) => calls.push(["doctor", args]),
    });
    skillpool.main(["bun", "skillpool", "validate", "--source", "."], {
      validateCommand: (args) => calls.push(["validate", args]),
    });
    skillpool.main(["bun", "skillpool", "upgrade", "--ref", "v1.2.3", "--install"], {
      upgradeCommand: (args, deps) => {
        calls.push(["upgrade", args]);
        deps.installCommand({ _: [], project: "fixture" });
      },
      installCommand: (args) => calls.push(["upgrade-install", args]),
    });

    expect(calls.map(([name]) => name)).toEqual(["install", "doctor", "validate", "upgrade", "upgrade-install"]);
    expect(calls[0]?.[1]).toMatchObject({ project: ".", "legacy-raw-install": true });
    expect(calls[3]?.[1]).toMatchObject({ ref: "v1.2.3", install: true });
  });

  test("strict parser accepts --skill-path in install", () => {
    const calls: Array<Record<string, unknown>> = [];
    skillpool.main(["bun", "skillpool", "install", "--app", "codex", "--source", ".", "--skill-path", "skills/foo"], {
      installCommand: (args) => {
        calls.push(args);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls.at(0)?.["skill-path"]).toBe("skills/foo");
  });

  test("prints the built-in help text for help aliases", () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    skillpool.main(["bun", "skillpool", "--help"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Universal Skills (Git-only)"));
    expect(log.mock.calls[0]?.[0]).toContain("--legacy-raw-install");
    log.mockRestore();
  });
});

function writeSkillFixture(root: string): void {
  const skillDir = path.join(root, "skills", "alpha");
  fs.mkdirSync(path.join(skillDir, "references", "topic"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Use when testing alpha.\nmetadata:\n  tags: alpha\n---\n# Alpha\nCore body.\n");
  fs.writeFileSync(path.join(skillDir, "gotchas.md"), "# Gotchas\nUse safely.\n");
  fs.writeFileSync(path.join(skillDir, "references", "README.md"), "# Reference index\n");
  fs.writeFileSync(path.join(skillDir, "references", "topic", "README.md"), "# Topic index\n");
  fs.writeFileSync(path.join(skillDir, "references", "topic", "details.md"), "# Deep details\n");
}

describe("skill-sys context and entrypoint characterization", () => {
  test("builds context bundles by tier and renders markdown or JSON", () => {
    const root = makeTempRoot("skill-sys-context-");
    writeSkillFixture(root);

    const quick = skillSys.buildContextBundle({ _: ["alpha"], tier: "quick" }, { cwd: root });
    expect(quick.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(quick.approxTokens).toBeGreaterThan(0);

    const standard = skillSys.buildContextBundle({ _: ["alpha"] }, { cwd: root });
    expect(standard.tier).toBe("standard");
    expect(standard.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "gotchas.md",
      "references/README.md",
      "references/topic/README.md",
    ]);

    const deep = skillSys.buildContextBundle({ _: ["alpha"], tier: "deep" }, { cwd: root });
    expect(deep.files.map((file) => file.path)).toContain("references/topic/details.md");
    expect(skillSys.renderContextBundle(quick, "markdown")).toContain("# skill-sys context: alpha");
    expect(JSON.parse(skillSys.renderContextBundle(quick, "json"))).toMatchObject({ skill: "alpha", tier: "quick" });
  });

  test("rejects invalid context args and dispatches context/help without spawning commands", () => {
    const root = makeTempRoot("skill-sys-main-");
    writeSkillFixture(root);
    const output: string[] = [];
    const errors: string[] = [];

    expect(skillSys.main(["bun", "skill-sys", "help"], { stdout: (text) => output.push(text) })).toBe(0);
    expect(output[0]).toContain("Skill-Sys");

    expect(
      skillSys.main(["bun", "skill-sys", "context", "alpha", "--format", "json"], {
        cwd: root,
        stdout: (text) => output.push(text),
        stderr: (text) => errors.push(text),
      }),
    ).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({ skill: "alpha", tier: "standard" });

    expect(skillSys.main(["bun", "skill-sys", "context", "alpha", "--tier", "invalid"], { cwd: root, stderr: (text) => errors.push(text) })).toBe(1);
    expect(errors.at(-1)).toContain("Invalid context tier");
    expect(skillSys.main(["bun", "skill-sys", "context", "alpha", "--format", "yaml"], { cwd: root, stderr: (text) => errors.push(text) })).toBe(1);
    expect(errors.at(-1)).toContain("Invalid context format");
    expect(skillSys.main(["bun", "skill-sys", "context", "../alpha"], { cwd: root, stderr: (text) => errors.push(text) })).toBe(1);
    expect(errors.at(-1)).toContain("Invalid skill name");
    expect(skillSys.main(["bun", "skill-sys", "context"], { cwd: root, stderr: (text) => errors.push(text) })).toBe(1);
    expect(errors.at(-1)).toContain("Usage: skill-sys context");
    expect(skillSys.main(["bun", "skill-sys", "context", "missing"], { cwd: root, stderr: (text) => errors.push(text) })).toBe(1);
    expect(errors.at(-1)).toContain("Skill not found");
  });

  test("normalizes source specs and appends deferred help to planned commands", () => {
    const root = makeTempRoot("skill-sys-source-");
    fs.mkdirSync(path.join(root, "source"), { recursive: true });

    expect(skillSys.normalizeSourceSpec("source#v1", { cwd: root })).toEqual({
      kind: "source",
      value: path.join(root, "source"),
      ref: "v1",
    });
    expect(skillSys.normalizeSourceSpec("./examples/minimal-skillpack", { cwd: repoRoot })).toEqual({
      kind: "source",
      value: path.join(repoRoot, "examples/minimal-skillpack"),
    });
    expect(skillSys.normalizeSourceSpec("owner/repo#v2", { cwd: root })).toEqual({
      kind: "repo",
      value: "https://github.com/owner/repo.git",
      ref: "v2",
    });
    expect(skillSys.normalizeSourceSpec("https://github.com/org/repo/tree/main/skills/foo", { cwd: root })).toEqual({
      kind: "repo",
      value: "https://github.com/org/repo.git",
      ref: "main",
      skillPath: "skills/foo",
    });
    expect(skillSys.normalizeSourceSpec("https://github.com/org/repo/tree/feature/foo/skills/bar", { cwd: root })).toEqual({
      kind: "repo",
      value: "https://github.com/org/repo.git",
      ref: "feature/foo",
      skillPath: "skills/bar",
    });
    expect(skillSys.normalizeSourceSpec("https://github.com/org/repo/tree/release/skill/v1/skills/foo", { cwd: root })).toEqual({
      kind: "repo",
      value: "https://github.com/org/repo.git",
      ref: "release/skill/v1",
      skillPath: "skills/foo",
    });
    expect(() =>
      skillSys.normalizeSourceSpec("https://github.com/org/repo/tree/feature/foo/skills/bar/skills/baz", { cwd: root }),
    ).toThrow("Ambiguous GitHub tree source path");

    expect(skillSys.normalizeSourceSpec("git@github.com:owner/repo.git", { cwd: root })).toEqual({
      kind: "repo",
      value: "git@github.com:owner/repo.git",
    });
    expect(skillSys.normalizeSourceSpec("git@gitlab.com:org/repo.git#v1.2.3", { cwd: root })).toEqual({
      kind: "repo",
      value: "git@gitlab.com:org/repo.git",
      ref: "v1.2.3",
    });
    expect(skillSys.normalizeSourceSpec("./examples/minimal-skillpack/skills/example-skill", { cwd: repoRoot })).toEqual({
      kind: "source",
      value: path.join(repoRoot, "examples/minimal-skillpack"),
      skillPath: "skills/example-skill",
    });
    const linkRoot = makeTempRoot("skill-sys-source-link-");
    const symlinkTarget = path.join(linkRoot, "target");
    fs.mkdirSync(symlinkTarget);
    fs.writeFileSync(path.join(symlinkTarget, "SKILL.md"), "# target\n");
    const sourceLink = path.join(linkRoot, "link-source");
    fs.symlinkSync(symlinkTarget, sourceLink, "dir");
    expect(() => skillSys.normalizeSourceSpec(sourceLink, { cwd: linkRoot })).toThrow(
      "Source path traversal through symlinks is not allowed",
    );
    expect(() => skillSys.normalizeSourceSpec("../etc/passwd", { cwd: root })).toThrow("Source path traversal is not allowed");
    expect(() => skillSys.normalizeSourceSpec("~/.skill", { cwd: root })).toThrow("Source must not use shell-style home expansion");
    expect(() => skillSys.normalizeSourceSpec("$HOME/.skill", { cwd: root })).toThrow("Source must not use shell-style home expansion");
    expect(() => skillSys.normalizeSourceSpec("   ", { cwd: root })).toThrow("Source must be a non-empty string");
    expect(() =>
      skillSys.normalizeSourceSpec("https://user:token@github.com/org/repo.git", { cwd: root }),
    ).toThrow("Source must not include URL credential information");
    expect(() => skillSys.normalizeSourceSpec("not-a-source", { cwd: root })).toThrow("Cannot classify source");
    expect(() => skillSys.normalizeSourceSpec("owner/repo#main;rm", { cwd: root })).toThrow("Unsafe git ref");
    expect(() => skillSys.normalizeSourceSpec("owner/repo#HEAD~1", { cwd: root })).toThrow("Unsafe git ref");
    expect(() => skillSys.normalizeSourceSpec("owner/repo#", { cwd: root })).toThrow("Source ref must be a non-empty string");
    expect(() => skillSys.normalizeSourceSpec("owner/repo#feature with-space", { cwd: root })).toThrow("Unsafe git ref");
    expect(() => skillSys.normalizeSourceSpec("https://github.com/org/repo/tree/main/skills/../foo", { cwd: root })).toThrow(
      "Unsafe skill path in tree URL",
    );

    expect(() => skillSys.buildCommand({ command: "unknown", args: { _: [] } })).toThrow("Unknown command: unknown");

    const ran: string[][] = [];
    const helpOutput: string[] = [];
    const result = skillSys.main(["bun", "skill-sys", "validate", "--source", ".", "--help"], {
      stdout: (message: string) => helpOutput.push(message),
      run: (argv) => {
        ran.push(argv);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(result).toBe(0);
    expect(ran).toEqual([]);
    expect(helpOutput.join("\n")).toContain("skill-sys validate --source <dir>");

    const listPlan = skillSys.buildCommand(
      skillSys.parseCli(["bun", "skill-sys", "list", "--include-internal", "--include-experimental", "--names-only"]),
    );
    expect(listPlan.argv).toContain("--include-internal");
    expect(listPlan.argv).toContain("--include-experimental");

    const findPlan = skillSys.buildCommand(
      skillSys.parseCli(["bun", "skill-sys", "find", "alpha", "--include-internal"]),
    );
    expect(findPlan.argv).toContain("--include-internal");

    const catalogPlan = skillSys.buildCommand(
      skillSys.parseCli([
        "bun",
        "skill-sys",
        "catalog",
        "--source",
        "examples/minimal-skillpack",
        "--out-dir",
        "dist/cards",
        "--format",
        "both",
        "--check",
        "--include-experimental",
      ]),
    );
    expect(catalogPlan.argv.some((token) => token.endsWith("generate-skill-catalog.ts"))).toBe(true);
    expect(catalogPlan.argv).toContain("--out-dir");
    expect(catalogPlan.argv).toContain("dist/cards");
    expect(catalogPlan.argv).toContain("--check");
    expect(catalogPlan.argv).toContain("--include-experimental");
  });
});

describe("coverage gate parser characterization", () => {
  test("covers help, LCOV, text coverage, and parser failure paths without running tests", () => {
    const output: string[] = [];
    const errors: string[] = [];
    const log = spyOn(console, "log").mockImplementation((text: string) => output.push(text));
    const error = spyOn(console, "error").mockImplementation((text: string) => errors.push(text));
    const exit = spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });
    try {
      coverageGate.main(["bun", "coverage-gate", "--help"]);
      expect(output.join("\n")).toContain("Coverage gate");
      expect(coverageGate.parseTextCoverageSummary("All files | 81.25 | 82.50 |\n")).toEqual({ funcsPct: 81.25, linesPct: 82.5 });
      expect(() => coverageGate.parseTextCoverageSummary("no summary")).toThrow("Unable to parse Bun text coverage summary");
      expect(() => coverageGate.parseTextCoverageSummary(`All files | ${"9".repeat(400)} | 82.50 |\n`)).toThrow(
        "Parsed invalid Bun text coverage summary values",
      );
      expect(coverageGate.parseLcovSummary("SF:file.ts\nLF:2\nLH:1\nFNF:1\nFNH:1\nend_of_record\n")).toEqual({
        linesPct: 50,
        funcsPct: 100,
      });
      expect(() => coverageGate.parseLcovSummary("LF:0\nLH:0\n")).toThrow("LCOV report has no source file records");
      expect(() => coverageGate.parseLcovSummary("SF:file.ts\nLF:0\nLH:0\nFNF:0\nFNH:0\n")).toThrow(
        "LCOV report has no measurable LF/FNF counters",
      );

      const root = makeTempRoot("coverage-gate-");
      const lcov = path.join(root, "lcov.info");
      fs.writeFileSync(lcov, "SF:file.ts\nLF:4\nLH:3\nFNF:2\nFNH:2\nend_of_record\n");
      coverageGate.main(["bun", "coverage-gate", "--no-run-tests", "--lcov-file", lcov, "--threshold-lines", "75"]);
      expect(output.at(-1)).toBe("STATUS: PASS");

      expect(() =>
        coverageGate.main(["bun", "coverage-gate", "--no-run-tests", "--lcov-file", lcov, "--threshold-lines", "100"]),
      ).toThrow("exit:1");
      expect(errors).toContain("STATUS: FAIL");
    } finally {
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });
});

describe("skillpool upgrade characterization", () => {
  test("updates lockfiles, supports dry-run, and optionally reinstalls", () => {
    const root = makeTempRoot("skillpool-upgrade-");
    const lockfilePath = path.join(root, ".skills.lock.json");
    const lock = {
      repo: "old-repo",
      ref: "v1",
      policy: {
        requireSourceCommit: true,
        sourceCommit: "a".repeat(40),
        requireSourceChecksum: true,
        expectedSourceSha256: "b".repeat(64),
        requireProjectionDigests: true,
        expectedProjectionDigests: [
          { provider: "codex", skill: "alpha", canonicalDigest: "c".repeat(64), projectionDigest: "d".repeat(64), rendererVersion: 1 },
        ],
      },
      installs: [{ app: "codex", skills: ["alpha"] }],
    };
    fs.writeFileSync(lockfilePath, JSON.stringify(lock, null, 2));
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((text: string) => logs.push(text));
    const installCalls: unknown[] = [];
    try {
      upgradeModule.upgradeCommand({ project: root, ref: "v2", repo: "new-repo", install: true }, {
        installCommand: (args) => installCalls.push(args),
      });
      expect(JSON.parse(fs.readFileSync(lockfilePath, "utf8"))).toMatchObject({ repo: "new-repo", ref: "v2" });
      expect(fs.existsSync(`${lockfilePath}.upgrade-recovery.json`)).toBe(false);
      expect(installCalls[0]).toMatchObject({ project: root, ref: "v2", repo: "new-repo", refreshCache: true, "refresh-cache": true });
      expect(logs).toContain("-> Reinstalling with upgraded lockfile");

      upgradeModule.upgradeCommand({ project: root, ref: "v3", "dry-run": true, install: false }, { installCommand: () => installCalls.push("dry") });
      expect(JSON.parse(fs.readFileSync(lockfilePath, "utf8"))).toMatchObject({ repo: "new-repo", ref: "v2" });
      expect(logs.at(-3)).toContain("(dry-run)");
      expect(() => upgradeModule.upgradeCommand({ project: root }, { installCommand: () => undefined })).toThrow(
        "upgrade requires --ref and/or --repo",
      );
    } finally {
      log.mockRestore();
    }
  });

  test("keeps the existing lockfile and installed content when reinstall fails", () => {
    const root = makeTempRoot("skillpool-upgrade-failure-");
    const lockfilePath = path.join(root, ".skills.lock.json");
    const installedSkillPath = path.join(root, ".agents", "skills", "alpha", "SKILL.md");
    const oldLock = {
      repo: "old-repo",
      ref: "v1",
      policy: {
        requireSourceCommit: true,
        sourceCommit: "a".repeat(40),
        requireSourceChecksum: true,
        expectedSourceSha256: "b".repeat(64),
        requireProjectionDigests: true,
        expectedProjectionDigests: [
          { provider: "codex", skill: "alpha", canonicalDigest: "c".repeat(64), projectionDigest: "d".repeat(64), rendererVersion: 1 },
        ],
      },
      installs: [{ app: "codex", skills: ["alpha"] }],
    };
    fs.mkdirSync(path.dirname(installedSkillPath), { recursive: true });
    fs.writeFileSync(lockfilePath, JSON.stringify(oldLock, null, 2));
    fs.writeFileSync(installedSkillPath, "old installed content\n");

    expect(() => upgradeModule.upgradeCommand({ project: root, ref: "v2" }, {
      installCommand: () => {
        throw new Error("reinstall failed");
      },
    })).toThrow("reinstall failed");

    expect(JSON.parse(fs.readFileSync(lockfilePath, "utf8"))).toMatchObject(oldLock);
    expect(fs.readFileSync(installedSkillPath, "utf8")).toBe("old installed content\n");
    expect(fs.existsSync(`${lockfilePath}.upgrade-recovery.json`)).toBe(false);
  });

  test("keeps lock, installed content, and state unchanged when canonical lock staging fails", () => {
    const root = makeTempRoot("skillpool-upgrade-lock-write-failure-");
    const lockfilePath = path.join(root, ".skills.lock.json");
    const installedSkillPath = path.join(root, ".agents", "skills", "alpha", "SKILL.md");
    const statePath = path.join(root, ".skills.state.json");
    const oldLock = {
      repo: "old-repo",
      ref: "v1",
      policy: {
        requireSourceCommit: true,
        sourceCommit: "a".repeat(40),
        requireSourceChecksum: true,
        expectedSourceSha256: "b".repeat(64),
        requireProjectionDigests: true,
        expectedProjectionDigests: [
          { provider: "codex", skill: "alpha", canonicalDigest: "c".repeat(64), projectionDigest: "d".repeat(64), rendererVersion: 1 },
        ],
      },
      installs: [{ app: "codex", skills: ["alpha"] }],
    };
    fs.mkdirSync(path.dirname(installedSkillPath), { recursive: true });
    fs.writeFileSync(lockfilePath, JSON.stringify(oldLock, null, 2));
    fs.writeFileSync(installedSkillPath, "old installed content\n");
    fs.writeFileSync(statePath, JSON.stringify({ source: { ref: "v1" } }, null, 2));
    const lockBefore = fs.readFileSync(lockfilePath, "utf8");
    const stateBefore = fs.readFileSync(statePath, "utf8");
    let reinstallCalled = false;

    expect(() => upgradeModule.upgradeCommand({ project: root, ref: "v2" }, {
      installCommand: () => {
        reinstallCalled = true;
        fs.writeFileSync(installedSkillPath, "new installed content\n");
        fs.writeFileSync(statePath, JSON.stringify({ source: { ref: "v2" } }, null, 2));
      },
      writeLockfile: () => {
        throw new Error("canonical lock write failed");
      },
    })).toThrow("canonical lock write failed");

    expect(reinstallCalled).toBe(false);
    expect(fs.readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
    expect(fs.readFileSync(installedSkillPath, "utf8")).toBe("old installed content\n");
    expect(fs.readFileSync(statePath, "utf8")).toBe(stateBefore);
  });

  test("writes a deterministic recovery marker when reinstall and lock restoration both fail", () => {
    const root = makeTempRoot("skillpool-upgrade-recovery-");
    const lockfilePath = path.join(root, ".skills.lock.json");
    const oldLock = {
      repo: "old-repo", ref: "v1",
      policy: {
        requireSourceCommit: true, sourceCommit: "a".repeat(40),
        requireSourceChecksum: true, expectedSourceSha256: "b".repeat(64),
        requireProjectionDigests: true,
        expectedProjectionDigests: [{ provider: "codex", skill: "alpha", canonicalDigest: "c".repeat(64), projectionDigest: "d".repeat(64), rendererVersion: 1 }],
      },
      installs: [{ app: "codex", skills: ["alpha"] }],
    };
    fs.writeFileSync(lockfilePath, JSON.stringify(oldLock, null, 2));
    let writes = 0;

    let failure: unknown;
    try {
      upgradeModule.upgradeCommand({ project: root, ref: "v2" }, {
        installCommand: () => { throw new Error("reinstall failed"); },
        writeLockfile: (target, lock) => {
          writes += 1;
          if (writes === 2) throw new Error("restore write failed");
          fs.writeFileSync(target, JSON.stringify(lock, null, 2));
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toContain("reinstall failed");
    expect((failure as Error).message).toContain("restore write failed");
    expect((failure as AggregateError).errors.map((error) => (error as Error).message)).toEqual(["reinstall failed", "restore write failed"]);

    const markerPath = path.join(root, ".skills.lock.json.upgrade-recovery.json");
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      lockfile: lockfilePath,
      priorLock: oldLock,
      installError: "reinstall failed",
      recoveryError: "restore write failed",
    });
    expect(() => upgradeModule.upgradeCommand({ project: root, ref: "v3" }, { installCommand: () => undefined })).toThrow("recovery marker already exists");
  });

  test("dry-run candidate lock uses exclusive safe creation and preserves a preexisting target", () => {
    const root = makeTempRoot("skillpool-upgrade-dry-run-temp-");
    const lockfilePath = path.join(root, ".skills.lock.json");
    const candidatePath = path.join(root, "candidate.tmp");
    const lock = {
      repo: "old-repo", ref: "v1",
      policy: {
        requireSourceCommit: true, sourceCommit: "a".repeat(40),
        requireSourceChecksum: true, expectedSourceSha256: "b".repeat(64),
        requireProjectionDigests: true,
        expectedProjectionDigests: [{ provider: "codex", skill: "alpha", canonicalDigest: "c".repeat(64), projectionDigest: "d".repeat(64), rendererVersion: 1 }],
      },
      installs: [{ app: "codex", skills: ["alpha"] }],
    };
    fs.writeFileSync(lockfilePath, JSON.stringify(lock, null, 2));
    fs.writeFileSync(candidatePath, "preserve\n");

    expect(() => upgradeModule.upgradeCommand({ project: root, ref: "v2", "dry-run": true }, {
      installCommand: () => undefined,
      temporaryLockfilePath: () => candidatePath,
    })).toThrow("EEXIST");
    expect(fs.readFileSync(candidatePath, "utf8")).toBe("preserve\n");
    expect(JSON.parse(fs.readFileSync(lockfilePath, "utf8"))).toMatchObject(lock);
  });
});

describe("skill-sys CLI error boundary", () => {
  test("returns a clean ERROR and exit 1 for parse errors", () => {
    const errors: string[] = [];

    expect(skillSys.main(["bun", "skill-sys", "install", "--project"], {
      stderr: (text) => errors.push(text),
    })).toBe(1);
    expect(errors).toEqual(["ERROR: Missing value for --project"]);
  });
});

describe("provider and adapter contract consistency", () => {
  test("index apps, provider schema enum, and provider manifests stay aligned", () => {
    const index = readJson("index.json") as { apps: string[] };
    const providerSchema = readJson("schema/provider.schema.json") as {
      properties: { provider: { enum: string[] } };
    };
    const providerNames = jsonFiles("providers").map((file) => file.replace(/\.json$/, ""));

    expect(providerSchema.properties.provider.enum.slice().sort()).toEqual(index.apps.slice().sort());
    expect(providerNames).toEqual(index.apps.slice().sort());

    for (const file of jsonFiles("providers")) {
      const manifest = readJson(path.join("providers", file)) as { provider: string; skillPaths: { project?: string } };
      expect(manifest.provider).toBe(file.replace(/\.json$/, ""));
      expect(manifest.skillPaths.project).toBe(".agents/skills");
    }
  });

  test("provider manifests use only schema-modeled support flags", () => {
    const providerSchema = readJson("schema/provider.schema.json") as {
      properties: { supports: { properties: Record<string, unknown> } };
    };
    const allowedSupportKeys = new Set(Object.keys(providerSchema.properties.supports.properties));

    for (const file of jsonFiles("providers")) {
      const manifest = readJson(path.join("providers", file)) as { supports: Record<string, unknown> };
      const unknownSupportKeys = Object.keys(manifest.supports).filter((key) => !allowedSupportKeys.has(key));
      expect(unknownSupportKeys).toEqual([]);
    }
  });

  test("project adapters remain the lockfile-supported app subset and target shared project skills", () => {
    const index = readJson("index.json") as { apps: string[] };
    const lockfileSchema = readJson("schema/lockfile.schema.json") as {
      properties: { installs: { items: { properties: { app: { enum: string[] } } } } };
    };
    const lockfileApps = lockfileSchema.properties.installs.items.properties.app.enum.slice().sort();
    const adapterNames = jsonFiles("adapters").map((file) => file.replace(/\.json$/, ""));

    expect(adapterNames).toEqual(lockfileApps);
    for (const adapter of adapterNames) {
      expect(index.apps).toContain(adapter);
    }

    for (const file of jsonFiles("adapters")) {
      const manifest = readJson(path.join("adapters", file)) as { name: string; targetPath: string };
      expect(manifest.name).toBe(file.replace(/\.json$/, ""));
      expect(manifest.targetPath).toBe(".agents/skills");
    }
  });
});
