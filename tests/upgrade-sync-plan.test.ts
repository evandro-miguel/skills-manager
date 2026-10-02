import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestTreeStrict } from "../scripts/lib/files.ts";
import { applySyncPlan, buildSyncPlan, type SyncPlanArgs } from "../scripts/commands/sync-plan.ts";
import { normalizeSkillNameStrict } from "../scripts/modules/skillpool/entry.ts";
import {
  getPoolVersion,
  runSkillLifecycleAudit,
  runSkillMetadataAudit,
  runUniversalContract,
  validateCommand,
  validateSourceStructure,
} from "../scripts/modules/skillpool/validate.ts";

const tempDirs: string[] = [];

function tempRoot(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFlatFixture(options: { invalidAdapter?: boolean; missingProfileSkill?: boolean; invalidProfileName?: boolean } = {}): string {
  const root = tempRoot("validate-fixture");
  writeJson(path.join(root, "package.json"), { name: "fixture", version: "1.2.3" });
  const skillDir = path.join(root, "skills", "alpha");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: alpha\ndescription: Use when validating fixture skills.\nmetadata:\n  tags: validate\n  triggers: validate\n  target_provider: universal\n---\n# Alpha\n"
  );
  writeJson(path.join(root, "adapters", "codex.json"), options.invalidAdapter ? { name: 7 } : { name: "codex", targetPath: ".agents/skills" });
  writeJson(path.join(root, "profiles", "core.json"), {
    ...(options.invalidProfileName ? {} : { name: "core" }),
    skills: options.missingProfileSkill ? ["missing"] : ["alpha"],
  });
  writeJson(path.join(root, "skill-lifecycle.json"), { entries: [{ skill: "alpha", event: "created", date: "2026-01-01" }] });
  return root;
}

function captureValidate(run: () => void): { stdout: string; exitCode: number | string | undefined } {
  const stdout: string[] = [];
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  try {
    run();
    return { stdout: stdout.join("\n"), exitCode: process.exitCode };
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
  }
}

function planArgs(source: string, project: string, overrides: Partial<SyncPlanArgs> = {}): SyncPlanArgs {
  return {
    source,
    project,
    profile: "core",
    app: "codex",
    apply: false,
    plan: true,
    explain: false,
    repair: false,
    json: false,
    help: false,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("skillpool validation characterization", () => {
  test("validateSourceStructure accepts a complete flat source and reports malformed adapters/profiles as blocking findings", () => {
    const good = writeFlatFixture();
    expect(validateSourceStructure(good)).toEqual([]);
    expect(getPoolVersion(good, { kind: "flat", skillsDir: path.join(good, "skills"), adaptersDir: path.join(good, "adapters"), profilesDir: path.join(good, "profiles") })).toBe("1.2.3");

    const invalidAdapter = writeFlatFixture({ invalidAdapter: true });
    expect(validateSourceStructure(invalidAdapter).map((finding) => finding.code)).toContain("ADAPTER_NAME_INVALID");
    expect(validateSourceStructure(invalidAdapter).map((finding) => finding.code)).toContain("ADAPTER_TARGET_INVALID");

    const missingProfileSkill = writeFlatFixture({ missingProfileSkill: true });
    expect(validateSourceStructure(missingProfileSkill).map((finding) => finding.code)).toContain("PROFILE_SKILL_MISSING");

    const invalidProfileName = writeFlatFixture({ invalidProfileName: true });
    expect(validateSourceStructure(invalidProfileName).map((finding) => finding.code)).toContain("PROFILE_NAME_INVALID");
  });

  test("validateSourceStructure fails closed for missing source layout and malformed skill frontmatter", () => {
    const missing = tempRoot("missing-source-layout");
    const missingFindings = validateSourceStructure(missing);
    expect(missingFindings[0]?.code).toBe("SOURCE_DIR_MISSING");

    const badSkill = writeFlatFixture();
    writeJson(path.join(badSkill, "skills", "alpha", "skill.meta.json"), { name: "wrong", version: "not-semver" });
    expect(validateSourceStructure(badSkill).map((finding) => finding.code)).toContain("SKILL_META_INVALID");
  });

  test("audit script wrappers report missing scripts without spawning and lifecycle requires the changelog", () => {
    const root = writeFlatFixture();
    const skillsDir = path.join(root, "skills");

    expect(runUniversalContract(skillsDir, path.join(root, "missing-contract.ts"))).toEqual({
      ok: false,
      message: `Universal contract script not found: ${path.join(root, "missing-contract.ts")}`,
    });
    expect(runSkillMetadataAudit(skillsDir, path.join(root, "missing-meta.ts")).message).toContain("Skill metadata script not found");

    fs.rmSync(path.join(root, "skill-lifecycle.json"));
    expect(runSkillLifecycleAudit(root, skillsDir, path.join(root, "missing-life.ts"))).toEqual({
      ok: false,
      message: `Skill lifecycle changelog not found: ${path.join(root, "skill-lifecycle.json")}`,
    });
  });

  test("validateCommand prints PASS with injected passing audits and BLOCKING with injected audit failures", () => {
    const root = writeFlatFixture();
    const baseOptions = {
      toolRoot: root,
      universalContractScript: "unused-universal.ts",
      skillMetadataScript: "unused-metadata.ts",
      skillLifecycleScript: "unused-lifecycle.ts",
      runUniversalContract: () => ({ ok: true, message: "universal ok" }),
      runSkillMetadataAudit: () => ({ ok: true, message: "metadata ok" }),
      runSkillLifecycleAudit: () => ({ ok: true, message: "lifecycle ok" }),
      runSensitiveScan: () => ({ ok: true, message: "sensitive ok" }),
    };

    const pass = captureValidate(() => validateCommand({ project: root, source: root }, baseOptions));
    expect(pass.exitCode).toBe(0);
    expect(pass.stdout).toContain("STATUS: PASS");
    expect(pass.stdout).toContain("Errors: 0  Warnings: 0");

    const fail = captureValidate(() =>
      validateCommand(
        { project: root, source: root },
        {
          ...baseOptions,
          runUniversalContract: () => ({ ok: false, message: "contract broke" }),
          runSensitiveScan: () => ({ ok: false, message: "sensitive finding" }),
        }
      )
    );
    expect(fail.exitCode).toBe(1);
    expect(fail.stdout).toContain("STATUS: BLOCKING");
    expect(fail.stdout).toContain("UNIVERSAL_CONTRACT_INVALID");
    expect(fail.stdout).toContain("SENSITIVE_SCAN_FAILED");
  });

  test("validateCommand checks lockfile policy version and lockfile adapter/skill references", () => {
    const root = writeFlatFixture();
    writeJson(path.join(root, ".skills.lock.json"), {
      repo: "https://example.invalid/skills.git",
      ref: "v1.2.3",
      installs: [
        { app: "missing-adapter", skills: ["alpha"] },
        { app: "codex", skills: ["missing-skill"] },
      ],
      policy: {
        minPoolVersion: "9.0.0",
        requireSourceCommit: true,
        sourceCommit: "b".repeat(40),
        requireSourceChecksum: true,
        expectedSourceSha256: "c".repeat(64),
        requireProjectionDigests: true,
        expectedProjectionDigests: [
          {
            provider: "codex",
            skill: "missing-skill",
            canonicalDigest: "d".repeat(64),
            projectionDigest: "e".repeat(64),
            rendererVersion: 1,
          },
          {
            provider: "missing-adapter",
            skill: "alpha",
            canonicalDigest: "d".repeat(64),
            projectionDigest: "e".repeat(64),
            rendererVersion: 1,
          },
        ],
      },
    });
    const output = captureValidate(() =>
      validateCommand(
        { project: root, source: root },
        {
          toolRoot: root,
          universalContractScript: "unused-universal.ts",
          skillMetadataScript: "unused-metadata.ts",
          skillLifecycleScript: "unused-lifecycle.ts",
          runUniversalContract: () => ({ ok: true, message: "universal ok" }),
          runSkillMetadataAudit: () => ({ ok: true, message: "metadata ok" }),
          runSkillLifecycleAudit: () => ({ ok: true, message: "lifecycle ok" }),
          runSensitiveScan: () => ({ ok: true, message: "sensitive ok" }),
        }
      )
    );

    expect(output.exitCode).toBe(1);
    expect(output.stdout).toContain("LOCKFILE_POLICY_MIN_VERSION_FAILED");
    expect(output.stdout).toContain("LOCKFILE_REFERENCE_INVALID");
  });
});

describe("sync-plan skill name containment", () => {
  test("normalizeSkillNameStrict rejects empty, traversal, absolute, separator, and drive-prefix names", () => {
    expect(normalizeSkillNameStrict("alpha")).toBe("alpha");
    const rejected = ["", "   ", ".", "..", "a/b", "a\\b", "/abs", "..\\abs", "C:", "C:foo", "C:\\abs"];
    for (const name of rejected) {
      expect(() => normalizeSkillNameStrict(name)).toThrow(/Invalid skill name/);
    }
    expect(() => normalizeSkillNameStrict(42)).toThrow(/Invalid skill name/);
  });

  test("buildSyncPlan fails closed when a profile skill name path-traverses", () => {
    const root = writeFlatFixture();
    writeJson(path.join(root, "profiles", "core.json"), { name: "core", skills: ["alpha", "../../outside"] });
    expect(() => buildSyncPlan(planArgs(root, tempRoot("traversal-project")))).toThrow(/Invalid skill name/);
  });

  test("applySyncPlan fails closed and writes nothing outside the project for traversing plan items", () => {
    const root = writeFlatFixture();
    const projectDir = tempRoot("traversal-apply-project");
    const plan = buildSyncPlan(planArgs(root, projectDir));
    const item = plan.install.add[0];
    if (!item) {
      throw new Error("expected plan to contain an add item");
    }
    const escapeName = `outside-${path.basename(projectDir)}`;
    item.skill = "../../outside";
    item.target = `../${escapeName}`;
    expect(() => applySyncPlan(planArgs(root, projectDir, { apply: true }), plan)).toThrow();
    expect(fs.existsSync(path.resolve(projectDir, "..", escapeName))).toBe(false);
  });

  test("managed state entries with traversing skill names are ignored instead of planned for removal", () => {
    const root = writeFlatFixture();
    const projectDir = tempRoot("traversal-state-project");
    const siblingDir = path.join(projectDir, "sibling");
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, "keep.txt"), "keep\n");
    writeJson(path.join(projectDir, ".skills.state.json"), {
      schemaVersion: 2,
      installed: [{ managedBy: "skill-sys", app: "codex", skill: "../sibling", target: "../sibling" }],
    });
    const plan = buildSyncPlan(planArgs(root, projectDir));
    expect(plan.install.remove).toEqual([]);
    expect(fs.existsSync(path.join(siblingDir, "keep.txt"))).toBe(true);
  });
});

describe("sync-plan canonical project mutation lock", () => {
  function holdCanonicalLock(projectDir: string): string {
    const lockPath = path.join(projectDir, ".skills.state.json.lock");
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, timestamp: Date.now() })}\n`);
    return lockPath;
  }

  test("buildSyncPlan planning does not create the canonical project mutation lock", () => {
    const root = writeFlatFixture();
    const projectDir = tempRoot("unlocked-plan-project");

    buildSyncPlan(planArgs(root, projectDir));

    expect(fs.existsSync(path.join(projectDir, ".skills.state.json.lock"))).toBe(false);
  });

  test("applySyncPlan fails deterministically while the lock is held and mutates nothing", () => {
    const root = writeFlatFixture();
    const projectDir = tempRoot("locked-apply-project");
    const plan = buildSyncPlan(planArgs(root, projectDir));
    const lockPath = holdCanonicalLock(projectDir);

    expect(() => applySyncPlan(planArgs(root, projectDir, { apply: true }), plan)).toThrow(
      "Project state is locked by another writer",
    );
    expect(() => applySyncPlan(planArgs(root, projectDir, { apply: true }), plan)).toThrow(
      ".skills.state.json.lock",
    );
    // No target mutation and no state file appeared; the foreign lock survives.
    expect(fs.existsSync(path.join(projectDir, ".agents", "skills"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, ".skills.state.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
  });

  test("a hand-built half-swapped multi-item journal is recovered by the next locked sync-plan apply", () => {
    const root = writeFlatFixture();
    const projectDir = tempRoot("journal-halfswap-project");
    const targetBase = path.join(projectDir, ".agents", "skills");
    const sourceAlpha = fs.readFileSync(path.join(root, "skills", "alpha", "SKILL.md"), "utf8");

    // alpha: half-swapped against a managed entry (backup holds source-identical
    // content, target missing). stale-two: half-swapped item that is also a
    // previously managed target — recovery restores only state-proven managed
    // targets, so both carry managed records.
    const backupRoot = path.join(targetBase, ".skill-sys-backup", "half1");
    fs.mkdirSync(path.join(backupRoot, "alpha"), { recursive: true });
    fs.writeFileSync(path.join(backupRoot, "alpha", "SKILL.md"), sourceAlpha, "utf8");
    fs.mkdirSync(path.join(backupRoot, "stale-two"), { recursive: true });
    fs.writeFileSync(path.join(backupRoot, "stale-two", "SKILL.md"), "# Stale two\n", "utf8");
    fs.writeFileSync(path.join(backupRoot, ".complete"), "complete\n", "utf8");
    writeJson(path.join(projectDir, ".skills.state.json"), {
      schemaVersion: 2,
      mode: "minimal",
      installed: [
        {
          managedBy: "skill-sys",
          app: "codex",
          skill: "alpha",
          target: ".agents/skills/alpha",
          skillDigest: digestTreeStrict(path.join(root, "skills", "alpha")),
        },
        {
          managedBy: "skill-sys",
          app: "other-app",
          skill: "stale-two",
          target: ".agents/skills/stale-two",
          skillDigest: digestTreeStrict(path.join(backupRoot, "stale-two")),
        },
      ],
    });
    writeJson(path.join(projectDir, ".skills.apply-journal.json"), {
      schemaVersion: 1,
      applyId: "half1",
      command: "sync-plan",
      createdAt: new Date().toISOString(),
      items: [
        {
          action: "swap",
          target: ".agents/skills/alpha",
          temp: ".agents/skills/.skill-sys-tmp/half1/alpha",
          backup: ".agents/skills/.skill-sys-backup/half1/alpha",
          hadTarget: true,
          backedUp: true,
          swapped: false,
        },
        {
          action: "swap",
          target: ".agents/skills/stale-two",
          temp: ".agents/skills/.skill-sys-tmp/half1/stale-two",
          backup: ".agents/skills/.skill-sys-backup/half1/stale-two",
          hadTarget: true,
          backedUp: true,
          swapped: false,
        },
      ],
    });

    const plan = buildSyncPlan(planArgs(root, projectDir));
    expect(plan.install.add.map((item) => item.skill)).toEqual(["alpha"]);
    const applied = applySyncPlan(planArgs(root, projectDir, { apply: true }), plan);

    // Recovery restored both half-swapped targets before the plan executed.
    expect(applied.applied).toBe(true);
    expect(fs.readFileSync(path.join(targetBase, "alpha", "SKILL.md"), "utf8")).toBe(sourceAlpha);
    expect(fs.readFileSync(path.join(targetBase, "stale-two", "SKILL.md"), "utf8")).toBe("# Stale two\n");
    expect(fs.existsSync(path.join(projectDir, ".skills.apply-journal.json"))).toBe(false);
    const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8"));
    expect(state.installed).toEqual([
      expect.objectContaining({ skill: "alpha", target: ".agents/skills/alpha" }),
    ]);
    expect((state.installed as Array<{ skillDigest: string }>)[0]?.skillDigest).toBe(
      digestTreeStrict(path.join(targetBase, "alpha")),
    );
  });

  test("applySyncPlan aborts on duplicate journal targets instead of silently filtering one away", () => {
    const root = writeFlatFixture();
    const projectDir = tempRoot("duplicate-target-project");
    const plan = buildSyncPlan(planArgs(root, projectDir));
    const add = plan.install.add[0];
    if (!add) {
      throw new Error("expected plan to contain an add item");
    }
    plan.install.remove.push({
      app: "codex",
      skill: "ghost",
      target: add.target,
      skillDigest: "",
      reason: "managed skill no longer selected",
    });

    expect(() => applySyncPlan(planArgs(root, projectDir, { apply: true }), plan)).toThrow(
      /Duplicate sync-plan journal target/,
    );
    // The apply aborted before any journal write or target mutation.
    expect(fs.existsSync(path.join(projectDir, ".skills.apply-journal.json"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, ".agents", "skills", "alpha"))).toBe(false);
  });

  test("plan refuses a current target containing symlinked entries instead of omitting them", () => {
    const root = writeFlatFixture();
    const projectDir = tempRoot("journal-target-symlink-project");
    const targetBase = path.join(projectDir, ".agents", "skills");
    const targetDir = path.join(targetBase, "alpha");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "SKILL.md"), "# Alpha on disk\n", "utf8");
    const outsideDir = path.join(projectDir, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret\n", "utf8");
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(targetDir, "escape-link"));

    expect(() => buildSyncPlan(planArgs(root, projectDir))).toThrow(/symlink/i);
    expect(fs.readFileSync(path.join(outsideDir, "secret.txt"), "utf8")).toBe("secret\n");
    expect(fs.existsSync(path.join(projectDir, ".skills.state.json"))).toBe(false);
  });
});
