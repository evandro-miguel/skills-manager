import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const commandHelpers = require("./helpers/skillpool-command.ts") as typeof import("./helpers/skillpool-command.ts");
const files = require("../scripts/lib/files.ts") as typeof import("../scripts/lib/files.ts");
const install = require("../scripts/modules/skillpool/install.ts") as typeof import("../scripts/modules/skillpool/install.ts");
const projections = require("../scripts/modules/skillpool/projections.ts") as typeof import("../scripts/modules/skillpool/projections.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");
const skillpool = require("../scripts/commands/skillpool.ts") as typeof import("../scripts/commands/skillpool.ts");
const upgradeModule = require("../scripts/modules/skillpool/upgrade.ts") as typeof import("../scripts/modules/skillpool/upgrade.ts");

const repoRoot = path.resolve(__dirname, "..");
const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");

function withTempDir<T>(prefix: string, callback: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function installOptions() {
  return {
    universalContractScript: "noop-universal-contract.ts",
    skillMetadataScript: "noop-skill-metadata.ts",
    skillLifecycleScript: "noop-skill-lifecycle.ts",
    runUniversalContract: commandHelpers.okAudit,
    runSkillMetadataAudit: commandHelpers.okAudit,
    runSkillLifecycleAudit: commandHelpers.okLifecycleAudit,
  };
}

function minimalProjectionSetup(projectDir: string) {
  const projectionDir = path.join(projectDir, "dist", "projection-smoke");
  projections.buildProjections({
    sourceRoot,
    providers: ["codex"],
    outDir: projectionDir,
    clean: true,
  });
  return projectionDir;
}

describe("install mode contract", () => {
  // Isolate the content-addressable projection store from the real
  // ~/.skillpool so projection-backed installs in this file never read or
  // write user home state.
  let skillpoolHome: string;
  let previousSkillpoolHome: string | undefined;
  beforeAll(() => {
    previousSkillpoolHome = process.env.SKILLPOOL_HOME;
    skillpoolHome = fs.mkdtempSync(path.join(os.tmpdir(), "install-mode-contract-skillpool-"));
    process.env.SKILLPOOL_HOME = skillpoolHome;
  });
  afterAll(() => {
    if (previousSkillpoolHome === undefined) {
      delete process.env.SKILLPOOL_HOME;
    } else {
      process.env.SKILLPOOL_HOME = previousSkillpoolHome;
    }
    fs.rmSync(skillpoolHome, { recursive: true, force: true });
  });

  // --- Parser tests ---

  test("--install-mode is accepted as a value option in the skill-sys parser", () => {
    const parsed = skillSys.parseCli([
      "bun",
      "skill-sys",
      "add",
      sourceRoot,
      "--install-mode",
      "projection",
      "--skill",
      "example-skill",
    ]);
    expect(parsed.command).toBe("add");
    expect(parsed.args["install-mode"]).toBe("projection");
  });

  test("buildCommand rejects invalid install-mode value", () => {
    expect(() =>
      skillSys.buildCommand(
        skillSys.parseCli([
          "bun",
          "skill-sys",
          "add",
          sourceRoot,
          "--install-mode",
          "invalid",
          "--skill",
          "example-skill",
        ])
      )
    ).toThrow(/Invalid install-mode 'invalid'/);
  });

  test("buildCommand rejects symlink install-mode with dev/team-only message", () => {
    expect(() =>
      skillSys.buildCommand(
        skillSys.parseCli([
          "bun",
          "skill-sys",
          "add",
          sourceRoot,
          "--install-mode",
          "symlink",
          "--skill",
          "example-skill",
        ])
      )
    ).toThrow(/symlink.*not.*(release|public|safe)|dev.*team/i);
  });

  test("buildCommand accepts projection install-mode and passes projection-dir through", () => {
    withTempDir("install-mode-projection-", (projectDir) => {
      const projectionDir = minimalProjectionSetup(projectDir);
      const plan = skillSys.buildCommand(
        skillSys.parseCli([
          "bun",
          "skill-sys",
          "add",
          sourceRoot,
          "--install-mode",
          "projection",
          "--project",
          projectDir,
          "--skill",
          "example-skill",
          "--projection-dir",
          projectionDir,
          "--dry-run",
        ]),
        { cwd: repoRoot }
      );
      expect(plan.argv.join(" ")).toContain("--projection-dir");
      expect(plan.argv.join(" ")).not.toContain("--legacy-raw-install");
    });
  });

  test("buildCommand accepts copy install-mode and maps to legacy-raw-install", () => {
    withTempDir("install-mode-copy-parser-", (projectDir) => {
      const plan = skillSys.buildCommand(
        skillSys.parseCli([
          "bun",
          "skill-sys",
          "add",
          sourceRoot,
          "--install-mode",
          "copy",
          "--project",
          projectDir,
          "--skill",
          "example-skill",
        ]),
        { cwd: repoRoot }
      );
      expect(plan.argv.join(" ")).toContain("--legacy-raw-install");
    });
  });

  // --- Backend tests ---

  test("install backend accepts installMode=copy and records copy mode digest state", () => {
    withTempDir("install-mode-copy-", (projectDir) => {
      const result = commandHelpers.captureCommand(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            installMode: "copy",
          },
          installOptions()
        )
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Installed entries: 1");

      const installedSkill = path.join(projectDir, ".agents", "skills", "example-skill");
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
      expect(state.installed[0].installMode).toBe("copy");
      expect(state.installed[0].canonicalDigest).toBe(files.dirDigest(path.join(sourceRoot, "skills", "example-skill")));
      expect(state.installed[0].skillDigest).toBe(files.digestTreeStrict(installedSkill));
      expect(state.installed[0].projection).toBeUndefined();
    });
  });

  test("install backend with installMode=projection records projection mode and digest state", () => {
    withTempDir("install-mode-projection-backend-", (projectDir) => {
      const projectionDir = minimalProjectionSetup(projectDir);
      const result = commandHelpers.captureCommand(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            installMode: "projection",
            "projection-dir": projectionDir,
          },
          installOptions()
        )
      );
      expect(result.code).toBe(0);
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
      expect(state.installed[0].installMode).toBe("projection");
      expect(state.installed[0].canonicalDigest).toBe(files.dirDigest(path.join(sourceRoot, "skills", "example-skill")));
      expect(state.installed[0].projection.provider).toBe("codex");
      expect(state.installed[0].projection.projectionDigest).toBeString();
    });
  });

  test("install backend rejects copy mode when canonical skill contains symlink entries", () => {
    withTempDir("install-mode-copy-symlink-", (root) => {
      const source = path.join(root, "source");
      const projectDir = path.join(root, "project");
      fs.cpSync(sourceRoot, source, { recursive: true });
      const skillDir = path.join(source, "skills", "unsafe-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: unsafe-skill\ndescription: Use when testing unsafe symlink rejection.\n---\n# Unsafe\n");
      fs.writeFileSync(path.join(root, "outside.txt"), "outside\n");
      fs.symlinkSync(path.join(root, "outside.txt"), path.join(skillDir, "linked.txt"));

      expect(() =>
        install.installCommand(
          {
            project: projectDir,
            source,
            app: "codex",
            skills: "unsafe-skill",
            installMode: "copy",
          },
          installOptions()
        )
      ).toThrow(/Refusing to use symlinked .*canonical skill/);
    });
  });

  test("install backend rejects installMode=symlink", () => {
    withTempDir("install-mode-symlink-", (projectDir) => {
      expect(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            "dry-run": true,
            installMode: "symlink",
          },
          installOptions()
        )
      ).toThrow(/symlink/i);
    });
  });

  test("install backend rejects invalid installMode", () => {
    withTempDir("install-mode-invalid-backend-", (projectDir) => {
      expect(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            "dry-run": true,
            installMode: "ftp",
          },
          installOptions()
        )
      ).toThrow(/Invalid install-mode/);
    });
  });

  // --- Backward compatibility ---

  test("--legacy-raw-install continues working without --install-mode", () => {
    withTempDir("install-legacy-compat-", (projectDir) => {
      const result = commandHelpers.captureCommand(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            "dry-run": true,
            "legacy-raw-install": true,
          },
          installOptions()
        )
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Installed entries: 1");
    });
  });

  test("without --install-mode or --legacy-raw-install, projection-backed install is still required", () => {
    withTempDir("install-default-requires-projection-", (projectDir) => {
      expect(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            "dry-run": true,
          },
          installOptions()
        )
      ).toThrow(/Projection-backed install is required/);
    });
  });

  test("--install-mode copy takes precedence over explicit --legacy-raw-install flag", () => {
    // Both copy mode and legacy flag present; copy mode wins
    withTempDir("install-mode-precedence-", (projectDir) => {
      const plan = skillSys.buildCommand(
        skillSys.parseCli([
          "bun",
          "skill-sys",
          "add",
          sourceRoot,
          "--install-mode",
          "copy",
          "--legacy-raw-install",
          "--project",
          projectDir,
          "--skill",
          "example-skill",
        ]),
        { cwd: repoRoot }
      );
      // Should still pass --legacy-raw-install (copy maps to it)
      expect(plan.argv.join(" ")).toContain("--legacy-raw-install");
    });
  });

  // --- Update path tests (PR04: update --projection-dir reinstall) ---

  test("skill-sys update --projection-dir --install-mode projection plans upgrade with projection flags and no legacy-raw-install", () => {
    withTempDir("update-projection-parser-", (projectDir) => {
      const projectionDir = minimalProjectionSetup(projectDir);
      const plan = skillSys.buildCommand(
        skillSys.parseCli([
          "bun",
          "skill-sys",
          "update",
          "--project",
          projectDir,
          "--ref",
          "v2",
          "--projection-dir",
          projectionDir,
          "--install-mode",
          "projection",
          "--dry-run",
        ]),
        { cwd: repoRoot }
      );
      const joined = plan.argv.join(" ");
      expect(plan.argv).toContain("upgrade");
      expect(joined).toContain("--projection-dir");
      expect(joined).toContain("--install-mode");
      expect(joined).not.toContain("--legacy-raw-install");
    });
  });

  test("skill-sys update --install-mode copy maps to --legacy-raw-install", () => {
    withTempDir("update-copy-parser-", (projectDir) => {
      const plan = skillSys.buildCommand(
        skillSys.parseCli([
          "bun",
          "skill-sys",
          "update",
          "--project",
          projectDir,
          "--ref",
          "v2",
          "--install-mode",
          "copy",
        ]),
        { cwd: repoRoot }
      );
      expect(plan.argv).toContain("upgrade");
      expect(plan.argv.join(" ")).toContain("--legacy-raw-install");
    });
  });

  test("skill-sys update rejects symlink install-mode", () => {
    expect(() =>
      skillSys.buildCommand(
        skillSys.parseCli([
          "bun",
          "skill-sys",
          "update",
          "--project",
          ".",
          "--ref",
          "v2",
          "--install-mode",
          "symlink",
        ])
      )
    ).toThrow(/symlink.*not.*(release|public|safe)|dev.*team/i);
  });

  test("skill-sys update rejects invalid install-mode", () => {
    expect(() =>
      skillSys.buildCommand(
        skillSys.parseCli([
          "bun",
          "skill-sys",
          "update",
          "--project",
          ".",
          "--ref",
          "v2",
          "--install-mode",
          "ftp",
        ])
      )
    ).toThrow(/Invalid install-mode 'ftp'/);
  });

  test("upgrade backend forwards projection-dir/install-mode to reinstall and forces refresh-cache", () => {
    withTempDir("update-projection-backend-", (root) => {
      const lockfilePath = path.join(root, ".skills.lock.json");
      fs.writeFileSync(
        lockfilePath,
        JSON.stringify(
          {
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
          },
          null,
          2,
        ),
      );
      const installCalls: Array<Record<string, unknown>> = [];
      const log = spyOn(console, "log").mockImplementation(() => undefined);
      try {
        upgradeModule.upgradeCommand(
          {
            project: root,
            ref: "v2",
            repo: "old-repo",
            install: true,
            "projection-dir": path.join(root, "dist", "projection"),
            "install-mode": "projection",
          },
          { installCommand: (args: Record<string, unknown>) => installCalls.push(args) },
        );
        expect(installCalls).toHaveLength(1);
        expect(installCalls[0]).toMatchObject({
          project: root,
          ref: "v2",
          "projection-dir": path.join(root, "dist", "projection"),
          "install-mode": "projection",
          "refresh-cache": true,
          refreshCache: true,
        });
        expect(installCalls[0]).not.toHaveProperty("app");
      } finally {
        log.mockRestore();
      }
    });
  });

  test("skill-sys update argv with --app/--projection-dir/--install-mode round-trips through the skillpool upgrade CLI parser", () => {
    withTempDir("update-projection-skillpool-parser-", (projectDir) => {
      const projectionDir = minimalProjectionSetup(projectDir);
      const plan = skillSys.buildCommand(
        skillSys.parseCli([
          "bun",
          "skill-sys",
          "update",
          "--project",
          projectDir,
          "--ref",
          "v2",
          "--app",
          "codex",
          "--projection-dir",
          projectionDir,
          "--install-mode",
          "projection",
          "--dry-run",
        ]),
        { cwd: repoRoot }
      );
      // The upgrade argv produced by skill-sys must round-trip through the
      // skillpool CLI parser without an "Unknown option" rejection under
      // strict parsing.
      const parsed = skillpool.parseCli(plan.argv);
      expect(parsed.command).toBe("upgrade");
      expect(parsed.args.project).toBe(projectDir);
      expect(parsed.args["projection-dir"]).toBe(projectionDir);
      expect(parsed.args["install-mode"]).toBe("projection");
      expect(parsed.args.app).toBe("codex");
      expect(parsed.args["dry-run"]).toBe(true);
    });
  });
});
