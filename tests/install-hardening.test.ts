import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cache = require("../scripts/modules/skillpool/cache.ts") as typeof import("../scripts/modules/skillpool/cache.ts");
const files = require("../scripts/lib/files.ts") as typeof import("../scripts/lib/files.ts");
const applyJournal = require("../scripts/modules/skillpool/apply-journal.ts") as typeof import("../scripts/modules/skillpool/apply-journal.ts");
const install = require("../scripts/modules/skillpool/install.ts") as typeof import("../scripts/modules/skillpool/install.ts");
const plan = require("../scripts/modules/skillpool/plan.ts") as typeof import("../scripts/modules/skillpool/plan.ts");
const projections = require("../scripts/modules/skillpool/projections.ts") as typeof import("../scripts/modules/skillpool/projections.ts");
const rollback = require("../scripts/commands/rollback.ts") as typeof import("../scripts/commands/rollback.ts");
const sourceModule = require("../scripts/modules/skillpool/source.ts") as typeof import("../scripts/modules/skillpool/source.ts");
const commandHelpers = require("./helpers/skillpool-command.ts") as typeof import("./helpers/skillpool-command.ts");

const repoRoot = path.resolve(__dirname, "..");
const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
const fullCommit = "a".repeat(40);
const sourceSha = "b".repeat(64);
const canonicalSha = "c".repeat(64);
const projectionSha = "d".repeat(64);

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

function gitOutput(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function initializeTestGitRepo(root: string): string {
  gitOutput(root, ["init", "--quiet"]);
  gitOutput(root, ["add", "."]);
  gitOutput(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  return gitOutput(root, ["rev-parse", "HEAD"]);
}

function hardenedProjectionPolicy() {
  return {
    requireSourceCommit: true,
    sourceCommit: fullCommit,
    requireSourceChecksum: true,
    expectedSourceSha256: sourceSha,
    requireProjectionDigests: true,
    expectedProjectionDigests: [
      {
        provider: "codex",
        skill: "example-skill",
        canonicalDigest: canonicalSha,
        projectionDigest: projectionSha,
        rendererVersion: 1,
      },
    ],
  };
}

function baseLock(policyOverride?: Record<string, unknown>, installs: Array<Record<string, unknown>> = [{ app: "codex", skills: ["example-skill"] }]) {
  const lock: Record<string, unknown> = {
    repo: "https://example.invalid/skills.git",
    ref: "v1.2.3",
    installs,
  };
  if (policyOverride !== undefined) {
    lock.policy = policyOverride;
  }
  return lock;
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

function createTwoAppCopyInstall(projectDir: string): string {
  const pack = path.join(projectDir, "pack");
  fs.cpSync(sourceRoot, pack, { recursive: true });
  writeText(path.join(pack, "adapters", "opencode.json"), `${JSON.stringify({ name: "opencode", targetPath: ".opencode/skills" })}\n`);
  const commit = initializeTestGitRepo(pack);
  const layout = require("../scripts/modules/skillpool/source.ts").resolveSourceLayout(pack, { requireSkills: true });
  const checksum = require("../scripts/modules/skillpool/source.ts").computeSourceChecksum(pack, layout);
  const canonicalDigest = files.dirDigest(path.join(pack, "skills", "example-skill"));
  writeText(path.join(projectDir, ".skills.lock.json"), `${JSON.stringify({
    repo: "https://example.invalid/skills.git",
    ref: "HEAD",
    policy: {
      requireSourceCommit: true,
      sourceCommit: commit,
      requireSourceChecksum: true,
      expectedSourceSha256: checksum,
      requireProjectionDigests: true,
      expectedProjectionDigests: ["codex", "opencode"].map((provider) => ({
        provider,
        skill: "example-skill",
        canonicalDigest,
        projectionDigest: "a".repeat(64),
        rendererVersion: 1,
      })),
    },
    installs: [
      { app: "codex", skills: ["example-skill"] },
      { app: "opencode", skills: ["example-skill"] },
    ],
  }, null, 2)}\n`);
  return pack;
}

describe("Phase B install hardening", () => {
  // Isolate the content-addressable projection store from the real
  // ~/.skillpool so projection-backed installs in this file never read or
  // write user home state.
  let skillpoolHome: string;
  let previousSkillpoolHome: string | undefined;
  beforeAll(() => {
    previousSkillpoolHome = process.env.SKILLPOOL_HOME;
    skillpoolHome = fs.mkdtempSync(path.join(os.tmpdir(), "install-hardening-skillpool-"));
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

  test("direct remote install planning requires an explicit ref and never injects main", () => {
    expect(() =>
      plan.buildInstallPlan(
        {
          app: "codex",
          repo: "https://example.invalid/skills.git",
          skills: "example-skill",
        },
        null
      )
    ).toThrow("Remote install requires explicit --ref");

    const localPlan = plan.buildInstallPlan(
      {
        app: "codex",
        source: sourceRoot,
        skills: "example-skill",
      },
      null
    ) as { ref?: unknown };
    expect(localPlan.ref).toBeUndefined();
  });

  test("cache source resolution fails closed instead of defaulting remote refs to main", () => {
    expect(() =>
      cache.resolveSourceRootForPlan(
        {
          repo: "https://example.invalid/skills.git",
          installs: [],
        },
        false
      )
    ).toThrow("Remote source requires explicit ref");
  });

  test("remote lockfiles require source commit, source checksum, and projection digests", () => {
    expect(plan.validateLockShape(baseLock())).toEqual(
      expect.arrayContaining([
        "lockfile.policy is required for remote lockfiles",
      ])
    );

    expect(
      plan.validateLockShape(
        baseLock({
          requireSourceCommit: true,
          sourceCommit: fullCommit,
          requireSourceChecksum: true,
          expectedSourceSha256: sourceSha,
        })
      )
    ).toEqual(
      expect.arrayContaining([
        "lockfile.policy.requireProjectionDigests must be true for remote lockfiles",
        "lockfile.policy.expectedProjectionDigests must be a non-empty array when requireProjectionDigests=true",
      ])
    );

    expect(plan.validateLockShape(baseLock(hardenedProjectionPolicy()))).toEqual([]);
  });

  test("lockfile install entries reject unsupported install modes", () => {
    expect(
      plan.validateLockShape(
        baseLock(hardenedProjectionPolicy(), [
          { app: "codex", skills: ["example-skill"], installMode: "projection" },
          { app: "codex", skills: ["example-skill"], installMode: "copy" },
        ])
      )
    ).toEqual([]);

    expect(
      plan.validateLockShape(
        baseLock(hardenedProjectionPolicy(), [{ app: "codex", skills: ["example-skill"], installMode: "symlink" }])
      )
    ).toContain("installs[0].installMode must be projection or copy");

    expect(
      plan.validateLockShape(
        baseLock(hardenedProjectionPolicy(), [{ app: "codex", skills: ["example-skill"], installMode: true }])
      )
    ).toContain("installs[0].installMode must be projection or copy");
  });

  test("canonical raw install is blocked unless the explicit legacy flag is present", () => {
    withTempDir("install-projection-guard-", (projectDir) => {
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
      ).toThrow("Projection-backed install is required");

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

  test("projection-backed install uses verified provider projection content", () => {
    withTempDir("install-projection-backed-", (projectDir) => {
      const outDir = path.join(projectDir, "projections");
      projections.buildProjections({
        sourceRoot,
        providers: ["codex"],
        outDir,
        clean: true,
      });

      const result = commandHelpers.captureCommand(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            "projection-dir": outDir,
          },
          installOptions()
        )
      );

      expect(result.code).toBe(0);
      const installedSkill = path.join(projectDir, ".agents", "skills", "example-skill");
      expect(fs.existsSync(path.join(installedSkill, "projection.meta.json"))).toBe(true);
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
      expect(state.installed[0].skillDigest).toBe(files.digestTreeStrict(installedSkill));
      expect(state.installed[0].projection.provider).toBe("codex");
      expect(state.installed[0].projection.skill).toBe("example-skill");
    });
  });

  test("minimal public skillpack passes real projection-backed install audits", () => {
    withTempDir("install-real-audits-", (projectDir) => {
      const outDir = path.join(projectDir, "projections");
      projections.buildProjections({
        sourceRoot,
        providers: ["codex"],
        outDir,
        clean: true,
      });

      const result = commandHelpers.captureCommand(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            "projection-dir": outDir,
          },
          {
            universalContractScript: path.join(repoRoot, "scripts", "commands", "universal-contract.ts"),
            skillMetadataScript: path.join(repoRoot, "scripts", "commands", "skill-metadata.ts"),
            skillLifecycleScript: path.join(repoRoot, "scripts", "commands", "skill-lifecycle.ts"),
          }
        )
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Installed entries: 1");
    });
  });

  test("projection-backed install rejects tampered projection digests", () => {
    withTempDir("install-projection-tamper-", (projectDir) => {
      const outDir = path.join(projectDir, "projections");
      projections.buildProjections({
        sourceRoot,
        providers: ["codex"],
        outDir,
        clean: true,
      });
      writeText(path.join(outDir, "codex", "example-skill", "tamper.txt"), "changed\n");

      expect(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            "projection-dir": outDir,
          },
          installOptions()
        )
      ).toThrow("Projection digest mismatch");
    });
  });

  test("projection-backed install rejects symlinked projection entries before digest checks", () => {
    withTempDir("install-projection-symlink-", (projectDir) => {
      const outDir = path.join(projectDir, "projections");
      const outside = path.join(projectDir, "outside.txt");
      projections.buildProjections({
        sourceRoot,
        providers: ["codex"],
        outDir,
        clean: true,
      });
      writeText(outside, "outside\n");
      fs.symlinkSync(outside, path.join(outDir, "codex", "example-skill", "linked.txt"));

      expect(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            "projection-dir": outDir,
          },
          installOptions()
        )
      ).toThrow("Refusing to use symlinked projection entry");
    });
  });

  test("projection-backed install rejects projection directories outside the project", () => {
    withTempDir("install-projection-dir-boundary-", (root) => {
      const projectDir = path.join(root, "project");
      const outsideProjectionDir = path.join(root, "outside-projections");
      fs.mkdirSync(projectDir, { recursive: true });
      projections.buildProjections({
        sourceRoot,
        providers: ["codex"],
        outDir: outsideProjectionDir,
        clean: true,
      });

      expect(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            "projection-dir": outsideProjectionDir,
          },
          installOptions()
        )
      ).toThrow("Projection directory must stay within project directory");
    });
  });

  test("rollback reconciles restored files with .skills.state.json digests", () => {
    withTempDir("rollback-state-reconcile-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      const skillTarget = path.join(targetBase, "alpha");
      const backupSkill = path.join(targetBase, ".skill-sys-backup", "0001", "alpha");
      writeText(path.join(skillTarget, "SKILL.md"), "# Alpha v2\n");
      writeText(path.join(backupSkill, "SKILL.md"), "# Alpha v1\n");
      writeText(path.join(targetBase, ".skill-sys-backup", "0001", ".complete"), "complete\n");

      files.writeFileAtomicSafe(
        path.join(projectDir, ".skills.state.json"),
        `${JSON.stringify(
          {
            schemaVersion: 2,
            installed: [
              {
                managedBy: "skill-sys",
                app: "codex",
                skill: "alpha",
                target: ".agents/skills/alpha",
                skillDigest: files.dirDigest(skillTarget),
              },
            ],
          },
          null,
          2
        )}\n`
      );

      const result = commandHelpers.captureCommand(() =>
        rollback.main([
          "bun",
          "scripts/commands/rollback.ts",
          "--project",
          projectDir,
          "--target",
          ".agents/skills",
          "--install-id",
          "0001",
        ])
      );

      expect(result.code).toBe(0);
      expect(fs.readFileSync(path.join(skillTarget, "SKILL.md"), "utf8")).toBe("# Alpha v1\n");
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
      expect(state.installed[0].skillDigest).toBe(files.digestTreeStrict(skillTarget));
    });
  });

  test("rollback reconciliation records strict digests and refuses symlinked restored targets", () => {
    withTempDir("rollback-reconcile-strict-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      const skillTarget = path.join(targetBase, "alpha");
      writeText(path.join(skillTarget, "SKILL.md"), "# Alpha restored\n");

      const action = {
        kind: "directory" as const,
        backup: path.join(targetBase, ".skill-sys-backup", "0009", "alpha"),
        target: skillTarget,
        restoreName: "alpha",
      };
      const result = { backupId: "0009", actions: [action], dryRun: false };
      const writeState = (installed: unknown[]): void =>
        files.writeFileAtomicSafe(
          path.join(projectDir, ".skills.state.json"),
          `${JSON.stringify({ schemaVersion: 2, installed }, null, 2)}\n`
        );

      // Managed records converge onto the strict tree digest format.
      writeState([
        { managedBy: "skill-sys", app: "codex", skill: "alpha", target: ".agents/skills/alpha", skillDigest: "stale-digest" },
        { managedBy: "other-tool", app: "codex", skill: "foreign", target: ".foreign/tool", skillDigest: "foreign" },
      ]);
      rollback.reconcileRollbackState(projectDir, result as unknown as Parameters<typeof rollback.reconcileRollbackState>[1]);
      let state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
      expect(state.installed[0].skillDigest).toBe(files.digestTreeStrict(skillTarget));
      expect(state.installed[1].skillDigest).toBe("foreign");

      // A symlinked entry inside the restored target aborts reconciliation
      // instead of being silently omitted from the digest.
      const outsideDir = path.join(projectDir, "outside");
      writeText(path.join(outsideDir, "secret.txt"), "secret\n");
      fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(skillTarget, "escape-link"));
      const stateBefore = fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8");
      expect(() =>
        rollback.reconcileRollbackState(projectDir, result as unknown as Parameters<typeof rollback.reconcileRollbackState>[1])
      ).toThrow(/symlink/i);
      expect(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8")).toBe(stateBefore);

      // A symlinked target itself is refused outright.
      fs.rmSync(skillTarget, { recursive: true });
      fs.symlinkSync(outsideDir, skillTarget);
      expect(() =>
        rollback.reconcileRollbackState(projectDir, result as unknown as Parameters<typeof rollback.reconcileRollbackState>[1])
      ).toThrow(/Refusing to reconcile symlinked rollback target/i);
      expect(fs.readFileSync(path.join(outsideDir, "secret.txt"), "utf8")).toBe("secret\n");
    });
  });

  test("install fails deterministically while the canonical project lock is held and mutates nothing", () => {
    withTempDir("install-held-lock-", (projectDir) => {
      const outDir = path.join(projectDir, "projections");
      projections.buildProjections({
        sourceRoot,
        providers: ["codex"],
        outDir,
        clean: true,
      });
      const lockPath = path.join(projectDir, ".skills.state.json.lock");
      fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, timestamp: Date.now() })}\n`);

      const result = commandHelpers.captureCommand(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            "projection-dir": outDir,
          },
          installOptions()
        )
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Project state is locked by another writer");
      expect(result.stderr).toContain(".skills.state.json.lock");
      expect(fs.existsSync(path.join(projectDir, ".agents", "skills", "example-skill"))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, ".skills.state.json"))).toBe(false);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
    });
  });

  test("a failing state write compensates on disk and surfaces the original error without masking", () => {
    withTempDir("install-state-write-failure-", (projectDir) => {
      const outDir = path.join(projectDir, "projections");
      projections.buildProjections({
        sourceRoot,
        providers: ["codex"],
        outDir,
        clean: true,
      });

      // nlink > 1 makes the atomic state write refuse before any rename while
      // the earlier read of the existing state still succeeds.
      const statePath = path.join(projectDir, ".skills.state.json");
      fs.writeFileSync(statePath, `${JSON.stringify({ schemaVersion: 2, installed: [] }, null, 2)}\n`);
      fs.linkSync(statePath, path.join(projectDir, ".skills.state.json.link-sentinel"));

      const result = commandHelpers.captureCommand(() =>
        install.installCommand(
          {
            project: projectDir,
            source: sourceRoot,
            app: "codex",
            skills: "example-skill",
            "projection-dir": outDir,
          },
          installOptions()
        )
      );

      expect(result.code).toBe(1);
      // The original state-write failure surfaces verbatim, never masked by
      // the compensation/reconciliation path.
      expect(result.stderr).toContain("Refusing to overwrite hardlinked target");
      // Filesystem compensation ran: no swapped-in target and no leftover
      // backups.
      expect(fs.existsSync(path.join(projectDir, ".agents", "skills", "example-skill"))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, ".skill-sys-backup"))).toBe(false);
      // Post-compensation reconciliation consumed the journal (full rollback
      // leaves nothing to repair), so a replay starts clean.
      expect(fs.existsSync(path.join(projectDir, ".skills.apply-journal.json"))).toBe(false);
    });
  });

  test("a post-compensation journal-reconciliation failure composes both errors and preserves context", () => {
    const stateError = new Error("Refusing to overwrite hardlinked target: /p/.skills.state.json");
    const recoveryError = new Error(
      "Apply journal rejected: no skill-sys-managed state record proves ownership of '.agents/skills/example-skill'"
    );

    const composed = install.composeStateWriteRecoveryFailure(stateError, recoveryError) as Error & {
      cause?: unknown;
    };

    expect(composed.message).toContain("Install state write failed");
    expect(composed.message).toContain("Refusing to overwrite hardlinked target");
    expect(composed.message).toContain("apply-journal reconciliation also failed");
    expect(composed.message).toContain("journal preserved for manual recovery");
    // The original error stays attached for programmatic diagnosis.
    expect(composed.cause).toBe(stateError);
  });

  test("rollback aborts while the canonical project lock is held; dry-run bypasses the lock", () => {
    withTempDir("rollback-held-lock-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      const skillTarget = path.join(targetBase, "alpha");
      const backupSkill = path.join(targetBase, ".skill-sys-backup", "0003", "alpha");
      writeText(path.join(skillTarget, "SKILL.md"), "# Alpha v2\n");
      writeText(path.join(backupSkill, "SKILL.md"), "# Alpha v1\n");
      writeText(path.join(targetBase, ".skill-sys-backup", "0003", ".complete"), "complete\n");
      files.writeFileAtomicSafe(
        path.join(projectDir, ".skills.state.json"),
        `${JSON.stringify(
          {
            schemaVersion: 2,
            installed: [
              {
                managedBy: "skill-sys",
                app: "codex",
                skill: "alpha",
                target: ".agents/skills/alpha",
                skillDigest: files.dirDigest(skillTarget),
              },
            ],
          },
          null,
          2
        )}\n`
      );
      const stateBefore = fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8");

      // Dry-run is planning-only: it succeeds without creating or needing a lock.
      const dryRun = commandHelpers.captureCommand(() =>
        rollback.main([
          "bun",
          "scripts/commands/rollback.ts",
          "--project",
          projectDir,
          "--target",
          ".agents/skills",
          "--install-id",
          "0003",
          "--dry-run",
        ])
      );
      expect(dryRun.code).toBe(0);
      expect(fs.existsSync(path.join(projectDir, ".skills.state.json.lock"))).toBe(false);

      const lockPath = path.join(projectDir, ".skills.state.json.lock");
      fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, timestamp: Date.now() })}\n`);

      const blocked = commandHelpers.captureCommand(() =>
        rollback.main([
          "bun",
          "scripts/commands/rollback.ts",
          "--project",
          projectDir,
          "--target",
          ".agents/skills",
          "--install-id",
          "0003",
        ])
      );

      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toContain("Project state is locked by another writer");
      expect(blocked.stderr).toContain(".skills.state.json.lock");
      expect(fs.readFileSync(path.join(skillTarget, "SKILL.md"), "utf8")).toBe("# Alpha v2\n");
      expect(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8")).toBe(stateBefore);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
    });
  });

  test("rollback dry-run plans explicit install-id without touching files", () => {
    withTempDir("rollback-dry-run-explicit-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      const skillTarget = path.join(targetBase, "alpha");
      const backupSkill = path.join(targetBase, ".skill-sys-backup", "0002", "alpha");
      writeText(path.join(skillTarget, "SKILL.md"), "# Alpha v2\n");
      writeText(path.join(backupSkill, "SKILL.md"), "# Alpha v1\n");
      writeText(path.join(targetBase, ".skill-sys-backup", "0002", ".complete"), "complete\n");

      const result = commandHelpers.captureCommand(() =>
        rollback.main([
          "bun",
          "scripts/commands/rollback.ts",
          "--project",
          projectDir,
          "--target",
          ".agents/skills",
          "--install-id",
          "0002",
          "--dry-run",
        ])
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("STATUS: PASS");
      expect(result.stdout).toContain("Actions: 1");
      expect(fs.readFileSync(path.join(skillTarget, "SKILL.md"), "utf8")).toBe("# Alpha v2\n");
    });
  });

  test("rollback restores managed lifecycle ledger file backups", () => {
    withTempDir("rollback-lifecycle-file-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      const lifecycleTarget = path.join(targetBase, ".skill-lifecycle.json");
      const backupLifecycle = path.join(targetBase, ".skill-sys-backup", "0004", ".skill-lifecycle.json");
      writeText(lifecycleTarget, "{\"version\":2}\n");
      writeText(backupLifecycle, "{\"version\":1}\n");
      writeText(path.join(targetBase, ".skill-sys-backup", "0004", ".complete"), "complete\n");

      const result = commandHelpers.captureCommand(() =>
        rollback.main([
          "bun",
          "scripts/commands/rollback.ts",
          "--project",
          projectDir,
          "--target",
          ".agents/skills",
          "--install-id",
          "0004",
        ])
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("restore .skill-lifecycle.json -> .agents/skills/.skill-lifecycle.json");
      expect(fs.readFileSync(lifecycleTarget, "utf8")).toBe("{\"version\":1}\n");
    });
  });

  test("rollback explicit install-id fails closed for incomplete or corrupt backups", () => {
    withTempDir("rollback-fail-closed-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      writeText(path.join(targetBase, ".skill-sys-backup", "partial", "alpha", "SKILL.md"), "# Alpha v1\n");
      expect(() =>
        rollback.planRollback({
          project: projectDir,
          target: ".agents/skills",
          installId: "partial",
          dryRun: true,
          json: false,
          help: false,
        })
      ).toThrow("Rollback backup id is incomplete: partial");

      writeText(path.join(targetBase, ".skill-sys-backup", "corrupt", ".complete"), "complete\n");
      writeText(path.join(targetBase, ".skill-sys-backup", "corrupt", "alpha"), "not a directory\n");
      expect(() =>
        rollback.planRollback({
          project: projectDir,
          target: ".agents/skills",
          installId: "corrupt",
          dryRun: true,
          json: false,
          help: false,
        })
      ).toThrow("Rollback backup entry must be a real directory");
    });
  });

  test("rollback state reconciliation leaves unmanaged records untouched", () => {
    withTempDir("rollback-unmanaged-state-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      const skillTarget = path.join(targetBase, "alpha");
      const backupSkill = path.join(targetBase, ".skill-sys-backup", "0003", "alpha");
      writeText(path.join(skillTarget, "SKILL.md"), "# Alpha v2\n");
      writeText(path.join(backupSkill, "SKILL.md"), "# Alpha v1\n");
      writeText(path.join(targetBase, ".skill-sys-backup", "0003", ".complete"), "complete\n");
      const unmanagedDigest = files.dirDigest(skillTarget);
      files.writeFileAtomicSafe(
        path.join(projectDir, ".skills.state.json"),
        `${JSON.stringify(
          {
            schemaVersion: 2,
            installed: [
              {
                managedBy: "manual",
                app: "codex",
                skill: "alpha",
                target: ".agents/skills/alpha",
                skillDigest: unmanagedDigest,
              },
            ],
          },
          null,
          2
        )}\n`
      );

      rollback.main([
        "bun",
        "scripts/commands/rollback.ts",
        "--project",
        projectDir,
        "--target",
        ".agents/skills",
        "--install-id",
        "0003",
      ]);

      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
      expect(state.installed[0].skillDigest).toBe(unmanagedDigest);
      expect(fs.readFileSync(path.join(skillTarget, "SKILL.md"), "utf8")).toBe("# Alpha v1\n");
    });
  });

  test("install transaction restores a moved backup when its replacement rename fails", () => {
    withTempDir("install-transaction-restore-", (root) => {
      const target = path.join(root, "alpha");
      const temp = path.join(root, ".skill-sys-tmp", "id", "alpha");
      const backup = path.join(root, ".skill-sys-backup", "id", "alpha");
      writeText(path.join(target, "SKILL.md"), "# Previous\n");
      writeText(path.join(temp, "SKILL.md"), "# Next\n");
      const renameSync = fs.renameSync;
      try {
        fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
          if (path.resolve(String(from)) === temp && path.resolve(String(to)) === target) {
            throw new Error("injected second rename failure");
          }
          return renameSync(from, to);
        }) as typeof fs.renameSync;
        expect(() => install.commitInstallTransaction([{
          kind: "directory",
          label: "codex/alpha",
          from: temp,
          to: target,
          temp,
          backup,
        }])).toThrow("injected second rename failure");
      } finally {
        fs.renameSync = renameSync;
      }
      expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("# Previous\n");
    });
  });

  test("a later app install preserves prior managed state and lifecycle records", () => {
    withTempDir("install-state-merge-", (projectDir) => {
      files.writeFileAtomicSafe(path.join(projectDir, ".skills.state.json"), `${JSON.stringify({
        schemaVersion: 2,
        source: {
          repo: null,
          ref: null,
          sourceChecksum: sourceModule.computeSourceChecksum(sourceRoot, sourceModule.resolveSourceLayout(sourceRoot, { requireSkills: true })),
        },
        installed: [{ managedBy: "skill-sys", app: "other", skill: "alpha", target: ".other/skills/alpha", skillDigest: "old" }],
        lifecycle: [{ app: "other", target: ".other/skills/.skill-lifecycle.json" }],
      })}\n`);
      install.installCommand({
        project: projectDir,
        source: sourceRoot,
        app: "codex",
        skills: "example-skill",
        "legacy-raw-install": true,
      }, installOptions());
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
      expect(state.installed).toEqual(expect.arrayContaining([
        expect.objectContaining({ app: "other", target: ".other/skills/alpha" }),
        expect.objectContaining({ app: "codex", target: ".agents/skills/example-skill" }),
      ]));
      expect(state.lifecycle).toEqual(expect.arrayContaining([
        expect.objectContaining({ app: "other", target: ".other/skills/.skill-lifecycle.json" }),
        expect.objectContaining({ app: "codex", target: ".agents/skills/.skill-lifecycle.json" }),
      ]));
    });
  });

  test("rollback rejects target-base symlink escapes", () => {
    withTempDir("rollback-target-symlink-", (projectDir) => {
      const outside = path.join(projectDir, "outside");
      fs.mkdirSync(outside);
      fs.mkdirSync(path.join(projectDir, ".agents"), { recursive: true });
      fs.symlinkSync(outside, path.join(projectDir, ".agents", "skills"));
      expect(() => rollback.planRollback({
        project: projectDir,
        target: ".agents/skills",
        installId: "latest",
        dryRun: true,
        json: false,
        help: false,
      })).toThrow("must not be a symlink");
    });
  });

  test("rollback leaves earlier targets unchanged when a later replacement rename fails", () => {
    withTempDir("rollback-transaction-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      const backupDir = path.join(targetBase, ".skill-sys-backup", "0005");
      writeText(path.join(targetBase, "alpha", "SKILL.md"), "# Alpha v2\n");
      writeText(path.join(targetBase, "beta", "SKILL.md"), "# Beta v2\n");
      writeText(path.join(backupDir, "alpha", "SKILL.md"), "# Alpha v1\n");
      writeText(path.join(backupDir, "beta", "SKILL.md"), "# Beta v1\n");
      writeText(path.join(backupDir, ".complete"), "complete\n");
      const result = rollback.planRollback({ project: projectDir, target: ".agents/skills", installId: "0005", dryRun: false, json: false, help: false });
      const renameSync = fs.renameSync;
      let failed = false;
      try {
        fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
          if (!failed && String(from).includes("beta.rollback-") && path.resolve(String(to)) === path.join(targetBase, "beta")) {
            failed = true;
            throw new Error("injected later rollback rename failure");
          }
          return renameSync(from, to);
        }) as typeof fs.renameSync;
        expect(() => rollback.applyRollback(result)).toThrow("injected later rollback rename failure");
      } finally {
        fs.renameSync = renameSync;
      }
      expect(fs.readFileSync(path.join(targetBase, "alpha", "SKILL.md"), "utf8")).toBe("# Alpha v2\n");
      expect(fs.readFileSync(path.join(targetBase, "beta", "SKILL.md"), "utf8")).toBe("# Beta v2\n");
    });
  });

  test("install transaction removes a newly swapped target despite a stale backup on later failure", () => {
    withTempDir("install-stale-backup-", (root) => {
      const alpha = path.join(root, "alpha");
      const beta = path.join(root, "beta");
      const alphaTemp = path.join(root, ".skill-sys-tmp", "id", "alpha");
      const betaTemp = path.join(root, ".skill-sys-tmp", "id", "beta");
      const alphaBackup = path.join(root, ".skill-sys-backup", "id", "alpha");
      const betaBackup = path.join(root, ".skill-sys-backup", "id", "beta");
      writeText(path.join(alphaTemp, "SKILL.md"), "# Alpha next\n");
      writeText(path.join(betaTemp, "SKILL.md"), "# Beta next\n");
      writeText(path.join(alphaBackup, "SKILL.md"), "# Stale backup\n");
      writeText(path.join(beta, "SKILL.md"), "# Beta previous\n");
      const renameSync = fs.renameSync;
      try {
        fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
          if (path.resolve(String(from)) === betaTemp && path.resolve(String(to)) === beta) {
            throw new Error("injected later install rename failure");
          }
          return renameSync(from, to);
        }) as typeof fs.renameSync;
        expect(() => install.commitInstallTransaction([
          { kind: "directory", label: "codex/alpha", from: alphaTemp, to: alpha, temp: alphaTemp, backup: alphaBackup },
          { kind: "directory", label: "codex/beta", from: betaTemp, to: beta, temp: betaTemp, backup: betaBackup },
        ])).toThrow("injected later install rename failure");
      } finally {
        fs.renameSync = renameSync;
      }
      expect(fs.existsSync(alpha)).toBe(false);
      expect(fs.readFileSync(path.join(alphaBackup, "SKILL.md"), "utf8")).toBe("# Stale backup\n");
      expect(fs.readFileSync(path.join(beta, "SKILL.md"), "utf8")).toBe("# Beta previous\n");
    });
  });

  test("rollback retains original targets if previous cleanup fails", () => {
    withTempDir("rollback-cleanup-failure-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      const backupDir = path.join(targetBase, ".skill-sys-backup", "0006");
      for (const skill of ["alpha", "beta"]) {
        writeText(path.join(targetBase, skill, "SKILL.md"), `# ${skill} v2\n`);
        writeText(path.join(backupDir, skill, "SKILL.md"), `# ${skill} v1\n`);
      }
      writeText(path.join(backupDir, ".complete"), "complete\n");
      const result = rollback.planRollback({ project: projectDir, target: ".agents/skills", installId: "0006", dryRun: false, json: false, help: false });
      const rmSync = fs.rmSync;
      let previousRemovals = 0;
      try {
        fs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
          if (String(target).endsWith(".previous") && ++previousRemovals === 2) {
            throw new Error("injected previous cleanup failure");
          }
          return rmSync(target, options);
        }) as typeof fs.rmSync;
        expect(() => rollback.applyRollback(result)).toThrow("injected previous cleanup failure");
      } finally {
        fs.rmSync = rmSync;
      }
      expect(fs.readFileSync(path.join(targetBase, "alpha", "SKILL.md"), "utf8")).toBe("# alpha v1\n");
      expect(fs.readFileSync(path.join(targetBase, "beta", "SKILL.md"), "utf8")).toBe("# beta v1\n");
    });
  });

  test("rollback cleans staged temps if later staging fails", () => {
    withTempDir("rollback-stage-failure-", (root) => {
      const alphaBackup = path.join(root, "backup", "alpha");
      const betaBackup = path.join(root, "backup", "beta");
      const alphaTarget = path.join(root, "target", "alpha");
      const betaTarget = path.join(root, "target", "beta");
      writeText(alphaBackup, "alpha\n");
      writeText(betaBackup, "beta\n");
      const copyFileSync = fs.copyFileSync;
      try {
        fs.copyFileSync = ((from: fs.PathLike, to: fs.PathLike, mode?: number) => {
          if (path.resolve(String(from)) === betaBackup) throw new Error("injected stage failure");
          return copyFileSync(from, to, mode);
        }) as typeof fs.copyFileSync;
        expect(() => rollback.applyRollback({
          backupId: "0007",
          dryRun: false,
          actions: [
            { kind: "file", backup: alphaBackup, target: alphaTarget, restoreName: "alpha" },
            { kind: "file", backup: betaBackup, target: betaTarget, restoreName: "beta" },
          ],
        })).toThrow("injected stage failure");
      } finally {
        fs.copyFileSync = copyFileSync;
      }
      expect(fs.existsSync(`${alphaTarget}.rollback-${process.pid}`)).toBe(false);
    });
  });

  test("install transaction rejects symlinked temporary roots without writing outside", () => {
    withTempDir("install-temp-root-symlink-", (root) => {
      const targetBase = path.join(root, "skills");
      const outside = path.join(root, "outside");
      const source = path.join(root, "source");
      const temp = path.join(targetBase, ".skill-sys-tmp", "id", "alpha");
      const backup = path.join(targetBase, ".skill-sys-backup", "id", "alpha");
      writeText(path.join(source, "SKILL.md"), "# Source\n");
      writeText(path.join(outside, "sentinel"), "preserve\n");
      fs.mkdirSync(targetBase, { recursive: true });
      fs.symlinkSync(outside, path.join(targetBase, ".skill-sys-tmp"));
      expect(() => install.runInstallTransaction([{ kind: "directory", label: "codex/alpha", from: source, to: path.join(targetBase, "alpha"), temp, backup }], false)).toThrow("symlink");
      expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("preserve\n");
      expect(fs.existsSync(path.join(outside, "id", "alpha"))).toBe(false);
    });
  });

  test("install transaction rejects symlinked backup roots without moving target outside", () => {
    withTempDir("install-backup-root-symlink-", (root) => {
      const targetBase = path.join(root, "skills");
      const outside = path.join(root, "outside");
      const target = path.join(targetBase, "alpha");
      const temp = path.join(targetBase, ".skill-sys-tmp", "id", "alpha");
      const backup = path.join(targetBase, ".skill-sys-backup", "id", "alpha");
      writeText(path.join(target, "SKILL.md"), "# Previous\n");
      writeText(path.join(temp, "SKILL.md"), "# Next\n");
      writeText(path.join(outside, "sentinel"), "preserve\n");
      fs.symlinkSync(outside, path.join(targetBase, ".skill-sys-backup"));
      expect(() => install.commitInstallTransaction([{ kind: "directory", label: "codex/alpha", from: temp, to: target, temp, backup }])).toThrow("symlink");
      expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("# Previous\n");
      expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("preserve\n");
    });
  });

  test("rollback rejects traversal-like install ids and symlinked backup roots", () => {
    withTempDir("rollback-backup-root-symlink-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      const outside = path.join(projectDir, "outside");
      fs.mkdirSync(targetBase, { recursive: true });
      writeText(path.join(outside, "escape", ".complete"), "complete\n");
      expect(() => rollback.planRollback({ project: projectDir, target: ".agents/skills", installId: "../outside/escape", dryRun: true, json: false, help: false })).toThrow("safe single path component");
      fs.symlinkSync(outside, path.join(targetBase, ".skill-sys-backup"));
      expect(() => rollback.planRollback({ project: projectDir, target: ".agents/skills", installId: "latest", dryRun: true, json: false, help: false })).toThrow("must not be a symlink");
      expect(fs.existsSync(path.join(outside, "escape"))).toBe(true);
    });
  });

  test("lock install fails before mutation when provider projections collide at one target", () => {
    withTempDir("install-projection-collision-", (projectDir) => {
      const pack = path.join(projectDir, "pack");
      const outDir = path.join(projectDir, "projections");
      fs.cpSync(sourceRoot, pack, { recursive: true });
      writeText(path.join(pack, "adapters", "opencode.json"), `${JSON.stringify({ name: "opencode", targetPath: ".agents/skills" })}\n`);
      const commit = initializeTestGitRepo(pack);
      const built = projections.buildProjections({ sourceRoot: pack, providers: ["codex", "opencode"], outDir, clean: true });
      writeText(path.join(projectDir, ".skills.lock.json"), `${JSON.stringify({
        repo: "https://example.invalid/skills.git",
        ref: "HEAD",
        policy: {
          requireSourceCommit: true,
          sourceCommit: commit,
          requireSourceChecksum: true,
          expectedSourceSha256: require("../scripts/modules/skillpool/source.ts").computeSourceChecksum(pack, require("../scripts/modules/skillpool/source.ts").resolveSourceLayout(pack, { requireSkills: true })),
          requireProjectionDigests: true,
          expectedProjectionDigests: built.projections.map((entry) => ({ provider: entry.provider, skill: entry.skill, canonicalDigest: entry.canonicalDigest, projectionDigest: entry.projectionDigest, rendererVersion: entry.rendererVersion })),
        },
        installs: [
          { app: "codex", skills: ["example-skill"] },
          { app: "opencode", skills: ["example-skill"] },
        ],
      })}\n`);
      expect(() => install.installCommand({ project: projectDir, source: pack, "projection-dir": outDir }, installOptions())).toThrow("Conflicting install target");
      expect(fs.existsSync(path.join(projectDir, ".agents", "skills", "example-skill"))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, ".skills.state.json"))).toBe(false);
    });
  });

  test("sequential shared-target projections replace stale state ownership", () => {
    withTempDir("install-sequential-collision-", (projectDir) => {
      const pack = path.join(projectDir, "pack");
      const outDir = path.join(projectDir, "projections");
      fs.cpSync(sourceRoot, pack, { recursive: true });
      writeText(path.join(pack, "adapters", "opencode.json"), `${JSON.stringify({ name: "opencode", targetPath: ".agents/skills" })}\n`);
      projections.buildProjections({ sourceRoot: pack, providers: ["codex", "opencode"], outDir, clean: true });
      for (const app of ["codex", "opencode"]) {
        install.installCommand({ project: projectDir, source: pack, app, skills: "example-skill", "projection-dir": outDir }, installOptions());
      }
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
      expect(state.installed).toEqual([expect.objectContaining({ app: "opencode", target: ".agents/skills/example-skill" })]);
      expect(state.lifecycle).toEqual([expect.objectContaining({ app: "opencode", target: ".agents/skills/.skill-lifecycle.json" })]);
      expect(files.dirDigest(path.join(projectDir, ".agents", "skills", "example-skill"))).toBe(files.dirDigest(path.join(outDir, "opencode", "example-skill")));
    });
  });

  test("identical canonical copies sharing a target coalesce safely", () => {
    withTempDir("install-copy-coalesce-", (projectDir) => {
      const commit = gitOutput(sourceRoot, ["rev-parse", "HEAD"]);
      const skillDigest = files.dirDigest(path.join(sourceRoot, "skills", "example-skill"));
      writeText(path.join(projectDir, ".skills.lock.json"), `${JSON.stringify({
        repo: "https://example.invalid/skills.git",
        ref: "HEAD",
        policy: {
          requireSourceCommit: true,
          sourceCommit: commit,
          requireSourceChecksum: true,
          expectedSourceSha256: require("../scripts/modules/skillpool/source.ts").computeSourceChecksum(sourceRoot, require("../scripts/modules/skillpool/source.ts").resolveSourceLayout(sourceRoot, { requireSkills: true })),
          requireProjectionDigests: true,
          expectedProjectionDigests: [{ provider: "codex", skill: "example-skill", canonicalDigest: skillDigest, projectionDigest: "a".repeat(64), rendererVersion: 1 }],
        },
        installs: [
          { app: "codex", skills: ["example-skill"] },
          { app: "codex", skills: ["example-skill"] },
        ],
      })}\n`);
      const result = commandHelpers.captureCommand(() => install.installCommand({ project: projectDir, source: sourceRoot, "install-mode": "copy" }, installOptions()));
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Installed entries: 1");
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
      expect(state.installed).toHaveLength(1);
      expect(state.lifecycle).toHaveLength(1);
    });
  });

  test("multi-app install rolls back earlier app commits when a later app replacement fails", () => {
    withTempDir("install-multi-app-commit-failure-", (projectDir) => {
      const pack = createTwoAppCopyInstall(projectDir);
      const opencodeTarget = path.join(projectDir, ".opencode", "skills", "example-skill");
      const renameSync = fs.renameSync;
      try {
        fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
          if (String(from).includes(`${path.sep}.opencode${path.sep}skills${path.sep}.skill-sys-tmp${path.sep}`) && path.resolve(String(to)) === opencodeTarget) {
            throw new Error("injected later app commit failure");
          }
          return renameSync(from, to);
        }) as typeof fs.renameSync;
        expect(() => install.installCommand({ project: projectDir, source: pack, "legacy-raw-install": true }, installOptions())).toThrow(
          "injected later app commit failure"
        );
      } finally {
        fs.renameSync = renameSync;
      }
      expect(fs.existsSync(path.join(projectDir, ".agents", "skills", "example-skill"))).toBe(false);
      expect(fs.existsSync(opencodeTarget)).toBe(false);
      expect(fs.existsSync(path.join(projectDir, ".skills.state.json"))).toBe(false);
    });
  });

  test("multi-app install does not commit an earlier app when staging a later app fails", () => {
    withTempDir("install-multi-app-stage-failure-", (projectDir) => {
      const pack = createTwoAppCopyInstall(projectDir);
      const copyFileSync = fs.copyFileSync;
      try {
        fs.copyFileSync = ((from: fs.PathLike, to: fs.PathLike, mode?: number) => {
          if (String(to).includes(`${path.sep}.opencode${path.sep}skills${path.sep}.skill-sys-tmp${path.sep}`)) {
            throw new Error("injected later app stage failure");
          }
          return copyFileSync(from, to, mode);
        }) as typeof fs.copyFileSync;
        expect(() => install.installCommand({ project: projectDir, source: pack, "legacy-raw-install": true }, installOptions())).toThrow(
          "injected later app stage failure"
        );
      } finally {
        fs.copyFileSync = copyFileSync;
      }
      expect(fs.existsSync(path.join(projectDir, ".agents", "skills", "example-skill"))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, ".opencode", "skills", "example-skill"))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, ".skills.state.json"))).toBe(false);
    });
  });

  test("invalid existing state fails before replacing multi-app targets or lifecycle files", () => {
    withTempDir("install-invalid-state-precommit-", (projectDir) => {
      const pack = createTwoAppCopyInstall(projectDir);
      const codexBase = path.join(projectDir, ".agents", "skills");
      const opencodeBase = path.join(projectDir, ".opencode", "skills");
      const statePath = path.join(projectDir, ".skills.state.json");
      writeText(path.join(codexBase, "example-skill", "SKILL.md"), "# Codex previous\n");
      writeText(path.join(opencodeBase, "example-skill", "SKILL.md"), "# OpenCode previous\n");
      writeText(path.join(codexBase, ".skill-lifecycle.json"), "{\"codex\":\"previous\"}\n");
      writeText(path.join(opencodeBase, ".skill-lifecycle.json"), "{\"opencode\":\"previous\"}\n");
      writeText(statePath, "not valid json\n");

      expect(() => install.installCommand({ project: projectDir, source: pack, "legacy-raw-install": true }, installOptions())).toThrow(
        "Invalid JSON"
      );

      expect(fs.readFileSync(path.join(codexBase, "example-skill", "SKILL.md"), "utf8")).toBe("# Codex previous\n");
      expect(fs.readFileSync(path.join(opencodeBase, "example-skill", "SKILL.md"), "utf8")).toBe("# OpenCode previous\n");
      expect(fs.readFileSync(path.join(codexBase, ".skill-lifecycle.json"), "utf8")).toBe("{\"codex\":\"previous\"}\n");
      expect(fs.readFileSync(path.join(opencodeBase, ".skill-lifecycle.json"), "utf8")).toBe("{\"opencode\":\"previous\"}\n");
      expect(fs.readFileSync(statePath, "utf8")).toBe("not valid json\n");
      expect(fs.existsSync(path.join(codexBase, ".skill-sys-backup"))).toBe(false);
      expect(fs.existsSync(path.join(opencodeBase, ".skill-sys-backup"))).toBe(false);
    });
  });

  test("multi-app install restores filesystem when the atomic state write fails", () => {
    withTempDir("install-multi-app-state-failure-", (projectDir) => {
      const pack = createTwoAppCopyInstall(projectDir);
      const codexTarget = path.join(projectDir, ".agents", "skills", "example-skill");
      const opencodeTarget = path.join(projectDir, ".opencode", "skills", "example-skill");
      const statePath = path.join(projectDir, ".skills.state.json");
      writeText(path.join(codexTarget, "SKILL.md"), "# Codex previous\n");
      writeText(path.join(opencodeTarget, "SKILL.md"), "# OpenCode previous\n");
      writeText(statePath, "{\"previous\":true}\n");
      const renameSync = fs.renameSync;
      try {
        fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
          if (path.resolve(String(to)) === statePath) {
            throw new Error("injected state write failure");
          }
          return renameSync(from, to);
        }) as typeof fs.renameSync;
        expect(() => install.installCommand({ project: projectDir, source: pack, "legacy-raw-install": true }, installOptions())).toThrow(
          "injected state write failure"
        );
      } finally {
        fs.renameSync = renameSync;
      }
      expect(fs.readFileSync(path.join(codexTarget, "SKILL.md"), "utf8")).toBe("# Codex previous\n");
      expect(fs.readFileSync(path.join(opencodeTarget, "SKILL.md"), "utf8")).toBe("# OpenCode previous\n");
      expect(fs.readFileSync(statePath, "utf8")).toBe("{\"previous\":true}\n");
      expect(fs.existsSync(path.join(projectDir, ".agents", "skills", ".skill-sys-backup"))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, ".opencode", "skills", ".skill-sys-backup"))).toBe(false);
    });
  });

  test("direct install preserves remaining managed records only when state source identity matches", () => {
    withTempDir("install-state-source-match-", (projectDir) => {
      const sourceIdentity = {
        repo: null,
        ref: null,
        sourceChecksum: sourceModule.computeSourceChecksum(sourceRoot, sourceModule.resolveSourceLayout(sourceRoot, { requireSkills: true })),
      };
      writeText(path.join(projectDir, ".skills.state.json"), `${JSON.stringify({
        schemaVersion: 2,
        source: sourceIdentity,
        installed: [{ managedBy: "skill-sys", app: "codex", skill: "prior", target: ".agents/skills/prior", skillDigest: "prior" }],
        lifecycle: [],
      })}\n`);
      install.installCommand({ project: projectDir, source: sourceRoot, app: "codex", skills: "example-skill", "legacy-raw-install": true }, installOptions());
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
      expect(state.installed).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: ".agents/skills/prior" }),
        expect.objectContaining({ target: ".agents/skills/example-skill" }),
      ]));
    });
  });

  test("direct install fails before mutation when remaining managed records have a different state source", () => {
    withTempDir("install-state-source-conflict-", (projectDir) => {
      const statePath = path.join(projectDir, ".skills.state.json");
      const original = {
        schemaVersion: 2,
        source: { repo: null, ref: null, sourceChecksum: "0".repeat(64) },
        installed: [{ managedBy: "skill-sys", app: "codex", skill: "prior", target: ".agents/skills/prior", skillDigest: "prior" }],
        lifecycle: [],
      };
      writeText(statePath, `${JSON.stringify(original)}\n`);
      expect(() => install.installCommand({ project: projectDir, source: sourceRoot, app: "codex", skills: "example-skill", "legacy-raw-install": true }, installOptions())).toThrow(
        "Cannot mix managed installs from different state.source identities"
      );
      expect(fs.existsSync(path.join(projectDir, ".agents", "skills", "example-skill"))).toBe(false);
      expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual(original);
    });
  });

  test("successful apply removes the durable apply journal", () => {
    withTempDir("install-journal-success-", (projectDir) => {
      const outDir = path.join(projectDir, "projections");
      projections.buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      const result = commandHelpers.captureCommand(() =>
        install.installCommand(
          { project: projectDir, source: sourceRoot, app: "codex", skills: "example-skill", "projection-dir": outDir },
          installOptions()
        )
      );
      expect(result.code).toBe(0);
      expect(fs.existsSync(path.join(projectDir, ".skills.apply-journal.json"))).toBe(false);
    });
  });

  test("injected failure after target->backup before temp->target restores the prior target and clears the journal", () => {
    withTempDir("install-journal-halfswap-", (projectDir) => {
      const outDir = path.join(projectDir, "projections");
      projections.buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      const targetBase = path.join(projectDir, ".agents", "skills");
      const skillTarget = path.join(targetBase, "example-skill");
      writeText(path.join(skillTarget, "SKILL.md"), "# Previous\n");
      writeText(
        path.join(projectDir, ".skills.state.json"),
        `${JSON.stringify(
          {
            schemaVersion: 2,
            installed: [
              { managedBy: "skill-sys", app: "codex", skill: "example-skill", target: ".agents/skills/example-skill", skillDigest: files.dirDigest(skillTarget) },
            ],
          },
          null,
          2
        )}\n`
      );
      const stateBefore = fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8");

      const renameSync = fs.renameSync;
      try {
        fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
          if (path.resolve(String(to)) === skillTarget && String(from).includes(`${path.sep}.skill-sys-tmp${path.sep}`)) {
            throw new Error("injected temp rename failure");
          }
          return renameSync(from, to);
        }) as typeof fs.renameSync;
        const result = commandHelpers.captureCommand(() =>
          install.installCommand(
            { project: projectDir, source: sourceRoot, app: "codex", skills: "example-skill", "projection-dir": outDir },
            installOptions()
          )
        );
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("injected temp rename failure");
      } finally {
        fs.renameSync = renameSync;
      }

      expect(fs.readFileSync(path.join(skillTarget, "SKILL.md"), "utf8")).toBe("# Previous\n");
      expect(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8")).toBe(stateBefore);
      expect(fs.existsSync(path.join(projectDir, ".skills.apply-journal.json"))).toBe(false);
    });
  });

  test("hand-built post-commit crash journal reconciles state by target identity preserving foreign and unmanaged entries", () => {
    withTempDir("install-journal-postcommit-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      const skillTarget = path.join(targetBase, "example-skill");
      writeText(path.join(skillTarget, "SKILL.md"), "# Next\n");
      const backupRoot = path.join(targetBase, ".skill-sys-backup", "crash9");
      writeText(path.join(backupRoot, "example-skill", "SKILL.md"), "# Previous\n");
      writeText(path.join(backupRoot, ".complete"), "complete\n");

      const foreignEntry = { managedBy: "other-tool", app: "codex", skill: "foreign", target: ".foreign/tool", skillDigest: "foreign" };
      const unmanagedEntry = { managedBy: "manual", skill: "unmanaged", target: ".agents/skills/example-skill", skillDigest: "manual" };
      const statePath = path.join(projectDir, ".skills.state.json");
      writeText(statePath, `${JSON.stringify(
        {
          schemaVersion: 2,
          mode: "minimal",
          source: { repo: null, ref: null, sourceChecksum: "x".repeat(64) },
          installed: [
            { managedBy: "skill-sys", app: "codex", skill: "example-skill", target: ".agents/skills/example-skill", skillDigest: "old-digest" },
            foreignEntry,
            unmanagedEntry,
          ],
        },
        null,
        2
      )}\n`);

      writeText(path.join(projectDir, ".skills.apply-journal.json"), `${JSON.stringify(
        {
          schemaVersion: 1,
          applyId: "crash9",
          command: "install",
          createdAt: new Date().toISOString(),
          items: [
            {
              action: "swap",
              target: ".agents/skills/example-skill",
              temp: ".agents/skills/.skill-sys-tmp/crash9/example-skill",
              backup: ".agents/skills/.skill-sys-backup/crash9/example-skill",
              hadTarget: true,
              backedUp: true,
              swapped: true,
            },
          ],
        },
        null,
        2
      )}\n`);

      applyJournal.recoverApplyJournal(projectDir);

      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(state.installed[0].skillDigest).toBe(files.digestTreeStrict(skillTarget));
      expect(state.installed[1]).toEqual(foreignEntry);
      expect(state.installed[2]).toEqual(unmanagedEntry);
      // The completed target is recognized and kept; recovery never deletes backups.
      expect(fs.readFileSync(path.join(skillTarget, "SKILL.md"), "utf8")).toBe("# Next\n");
      expect(fs.existsSync(path.join(backupRoot, "example-skill", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(projectDir, ".skills.apply-journal.json"))).toBe(false);
    });
  });

  test("the next locked install recovers a planted half-swapped journal before mutating", () => {
    withTempDir("install-journal-preapply-", (projectDir) => {
      const outDir = path.join(projectDir, "projections");
      projections.buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      const targetBase = path.join(projectDir, ".agents", "skills");
      const backupRoot = path.join(targetBase, ".skill-sys-backup", "pre1");
      writeText(path.join(backupRoot, "stale-one", "SKILL.md"), "# Stale one\n");
      writeText(path.join(backupRoot, "stale-two", "SKILL.md"), "# Stale two\n");
      writeText(path.join(backupRoot, ".complete"), "complete\n");
      // Recovery only restores targets proven managed by an existing state
      // record; seed both stale targets as previously installed from the same
      // source identity this install uses so recovery and the install continue.
      const layout = sourceModule.resolveSourceLayout(sourceRoot, { requireSkills: true });
      writeText(path.join(projectDir, ".skills.state.json"), `${JSON.stringify(
        {
          schemaVersion: 2,
          mode: "minimal",
          source: { repo: null, ref: null, sourceChecksum: sourceModule.computeSourceChecksum(sourceRoot, layout) },
          installed: ["stale-one", "stale-two"].map((name) => ({
            managedBy: "skill-sys",
            app: "codex",
            skill: name,
            target: `.agents/skills/${name}`,
            skillDigest: "stale",
          })),
        },
        null,
        2
      )}\n`);
      writeText(path.join(projectDir, ".skills.apply-journal.json"), `${JSON.stringify(
        {
          schemaVersion: 1,
          applyId: "pre1",
          command: "install",
          createdAt: new Date().toISOString(),
          items: ["stale-one", "stale-two"].map((name) => ({
            action: "swap",
            target: `.agents/skills/${name}`,
            temp: `.agents/skills/.skill-sys-tmp/pre1/${name}`,
            backup: `.agents/skills/.skill-sys-backup/pre1/${name}`,
            hadTarget: true,
            backedUp: true,
            swapped: false,
          })),
        },
        null,
        2
      )}\n`);

      const result = commandHelpers.captureCommand(() =>
        install.installCommand(
          { project: projectDir, source: sourceRoot, app: "codex", skills: "example-skill", "projection-dir": outDir },
          installOptions()
        )
      );

      expect(result.code).toBe(0);
      expect(fs.readFileSync(path.join(targetBase, "stale-one", "SKILL.md"), "utf8")).toBe("# Stale one\n");
      expect(fs.readFileSync(path.join(targetBase, "stale-two", "SKILL.md"), "utf8")).toBe("# Stale two\n");
      expect(fs.existsSync(path.join(projectDir, ".skills.apply-journal.json"))).toBe(false);
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
      expect(state.installed).toEqual(
        expect.arrayContaining([expect.objectContaining({ skill: "example-skill", target: ".agents/skills/example-skill" })])
      );
    });
  });

  test("staged installs refuse symlinked entries in the source skill tree", () => {
    withTempDir("install-staged-symlink-", (projectDir) => {
      const outsideDir = path.join(projectDir, "outside");
      writeText(path.join(outsideDir, "secret.txt"), "secret\n");
      const srcSkill = path.join(projectDir, "src-skill");
      writeText(path.join(srcSkill, "SKILL.md"), "# Example\n");
      fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(srcSkill, "link.txt"));

      const targetBase = path.join(projectDir, ".agents", "skills");
      // dirDigest would silently omit the link; strict staging digests refuse it.
      expect(() => files.digestTreeStrict(srcSkill)).toThrow(/symlink/i);
      expect(() =>
        install.stageInstallItem({
          kind: "directory",
          label: "codex/src-skill",
          from: srcSkill,
          to: path.join(targetBase, "src-skill"),
          temp: path.join(targetBase, ".skill-sys-tmp", "stage1", "src-skill"),
          backup: path.join(targetBase, ".skill-sys-backup", "stage1", "src-skill"),
        })
      ).toThrow(/symlink/i);
      expect(fs.readFileSync(path.join(outsideDir, "secret.txt"), "utf8")).toBe("secret\n");
    });
  });

  test("rollback refuses symlinked or wrong-typed install backups at the restore boundary", () => {
    withTempDir("install-rollback-backup-lstat-", (projectDir) => {
      const targetBase = path.join(projectDir, ".agents", "skills");
      const outsideDir = path.join(projectDir, "outside");
      writeText(path.join(outsideDir, "evil.md"), "evil\n");

      const symlinkedBackup = path.join(targetBase, ".skill-sys-backup", "rb1", "example-skill");
      fs.mkdirSync(path.dirname(symlinkedBackup), { recursive: true });
      fs.symlinkSync(outsideDir, symlinkedBackup);
      // The transaction path guard or the restore-boundary lstat must refuse
      // a symlinked backup before anything is renamed into place.
      expect(() =>
        install.rollbackInstallTransaction([
          {
            kind: "directory",
            label: "codex/example-skill",
            from: path.join(projectDir, "unused"),
            to: path.join(targetBase, "example-skill"),
            temp: path.join(targetBase, ".skill-sys-tmp", "rb1", "example-skill"),
            backup: symlinkedBackup,
            hadTarget: true,
          },
        ])
      ).toThrow(/symlinked install backup/i);
      expect(fs.existsSync(path.join(targetBase, "example-skill"))).toBe(false);

      const fileBackup = path.join(targetBase, ".skill-sys-backup", "rb2", "example-skill");
      fs.mkdirSync(path.dirname(fileBackup), { recursive: true });
      fs.writeFileSync(fileBackup, "not a directory\n", "utf8");
      expect(() =>
        install.rollbackInstallTransaction([
          {
            kind: "directory",
            label: "codex/example-skill",
            from: path.join(projectDir, "unused"),
            to: path.join(targetBase, "example-skill"),
            temp: path.join(targetBase, ".skill-sys-tmp", "rb2", "example-skill"),
            backup: fileBackup,
            hadTarget: true,
          },
        ])
      ).toThrow(/Refusing to restore non-directory install backup/i);
      expect(fs.existsSync(path.join(targetBase, "example-skill"))).toBe(false);
      expect(fs.readFileSync(path.join(outsideDir, "evil.md"), "utf8")).toBe("evil\n");
    });
  });
});
