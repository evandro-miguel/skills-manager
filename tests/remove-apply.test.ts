import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { digestTreeStrict } from "../scripts/lib/files.ts";
import {
  applyRemove,
  normalizeRemoveArgs,
  planRemove,
} from "../scripts/modules/skillpool/remove.ts";

const commandHelpers = require("./helpers/skillpool-command.ts") as typeof import("./helpers/skillpool-command.ts");
const rollback = require("../scripts/commands/rollback.ts") as typeof import("../scripts/commands/rollback.ts");

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempProject(prefix = "remove-apply-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeSkill(project: string, target: string, body = "# Skill\n"): string {
  const dir = path.join(project, target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
  return dir;
}

function writeState(project: string, installed: unknown[]): void {
  fs.writeFileSync(
    path.join(project, ".skills.state.json"),
    `${JSON.stringify({ schemaVersion: 2, mode: "minimal", installed }, null, 2)}\n`,
    "utf8",
  );
}

function managedEntry(project: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const target = String(overrides.target ?? ".agents/skills/alpha");
  writeSkill(project, target, "# Alpha\n");
  return {
    managedBy: "skill-sys",
    app: "codex",
    skill: "alpha",
    target,
    installMode: "projection",
    skillDigest: digestTreeStrict(path.join(project, target)),
    ...overrides,
  };
}

function readState(project: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(project, ".skills.state.json"), "utf8"));
}

describe("skill-sys remove --apply", () => {
  test("single-skill apply removes the target, drops state, and writes a complete backup ledger", () => {
    const project = tempProject();
    const entry = managedEntry(project);
    writeState(project, [entry]);
    const target = path.join(project, ".agents", "skills", "alpha");
    const before = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");

    const result = applyRemove(
      normalizeRemoveArgs({ project, skill: "alpha", app: "codex", apply: true }, { cwd: project }),
    );

    expect(result.selected).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.stateUpdated).toBe(true);
    expect(result.backups).toHaveLength(1);
    expect(fs.existsSync(target)).toBe(false);

    const state = readState(project);
    expect(state.installed).toEqual([]);

    const backupRoot = path.join(project, ".agents", "skills", ".skill-sys-backup", result.removeId);
    expect(fs.readFileSync(path.join(backupRoot, "alpha", "SKILL.md"), "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(backupRoot, ".complete"), "utf8")).toBe("complete\n");
    const ledger = JSON.parse(fs.readFileSync(path.join(backupRoot, "remove-ledger.json"), "utf8"));
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.removeId).toBe(result.removeId);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      managedBy: "skill-sys",
      app: "codex",
      skill: "alpha",
      target: ".agents/skills/alpha",
    });
  });

  test("broad apply requires --confirm-all and plan path still mutates nothing", () => {
    const project = tempProject();
    expect(() =>
      normalizeRemoveArgs({ project, all: true, apply: true }, { cwd: project }),
    ).toThrow("--confirm-all");

    const input = normalizeRemoveArgs(
      { project, all: true, apply: true, "confirm-all": true },
      { cwd: project },
    );
    expect(input.apply).toBe(true);
    expect(input.confirmAll).toBe(true);
    expect(input.plan).toBe(true);

    const entry = managedEntry(project);
    writeState(project, [entry]);
    const stateBefore = fs.readFileSync(path.join(project, ".skills.state.json"), "utf8");
    const skillBefore = fs.readFileSync(path.join(project, ".agents", "skills", "alpha", "SKILL.md"), "utf8");

    const plan = planRemove(normalizeRemoveArgs({ project, skill: "alpha", plan: true }, { cwd: project }));
    expect(plan.applySupported).toBe(false);
    expect(fs.readFileSync(path.join(project, ".skills.state.json"), "utf8")).toBe(stateBefore);
    expect(fs.readFileSync(path.join(project, ".agents", "skills", "alpha", "SKILL.md"), "utf8")).toBe(skillBefore);
  });

  test("digest mismatch fails closed without --force and leaves the target untouched", () => {
    const project = tempProject();
    const entry = managedEntry(project);
    entry.skillDigest = "sha256:not-the-current-digest";
    writeState(project, [entry]);
    const target = path.join(project, ".agents", "skills", "alpha");

    expect(() =>
      applyRemove(normalizeRemoveArgs({ project, skill: "alpha", apply: true }, { cwd: project })),
    ).toThrow("digest mismatch");

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(path.join(project, ".agents", "skills", ".skill-sys-backup"))).toBe(false);
    expect(readState(project).installed).toHaveLength(1);
  });

  test("missing recorded target fails closed without --force and --force drops only state", () => {
    const project = tempProject();
    const target = ".agents/skills/alpha";
    writeState(project, [
      {
        managedBy: "skill-sys",
        app: "codex",
        skill: "alpha",
        target,
        installMode: "projection",
        skillDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);
    const stateBefore = fs.readFileSync(path.join(project, ".skills.state.json"), "utf8");

    expect(() =>
      applyRemove(normalizeRemoveArgs({ project, skill: "alpha", apply: true }, { cwd: project })),
    ).toThrow(/recorded target is missing/i);

    expect(fs.existsSync(path.join(project, target))).toBe(false);
    expect(fs.readFileSync(path.join(project, ".skills.state.json"), "utf8")).toBe(stateBefore);

    const result = applyRemove(
      normalizeRemoveArgs({ project, skill: "alpha", apply: true, force: true }, { cwd: project }),
    );

    expect(result.selected).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.stateUpdated).toBe(true);
    expect(readState(project).installed).toEqual([]);
    expect(fs.existsSync(path.join(project, target))).toBe(false);
  });

  test("--force overrides a digest mismatch and still records a rollback backup", () => {
    const project = tempProject();
    const entry = managedEntry(project);
    entry.skillDigest = "sha256:not-the-current-digest";
    writeState(project, [entry]);
    const target = path.join(project, ".agents", "skills", "alpha");

    const result = applyRemove(
      normalizeRemoveArgs({ project, skill: "alpha", apply: true, force: true }, { cwd: project }),
    );

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
    const backupRoot = path.join(project, ".agents", "skills", ".skill-sys-backup", result.removeId);
    expect(fs.existsSync(path.join(backupRoot, ".complete"))).toBe(true);
    expect(fs.existsSync(path.join(backupRoot, "remove-ledger.json"))).toBe(true);
  });

  test("rollback restores the removed directory and merges the ledger entry back into state", () => {
    const project = tempProject();
    const entry = managedEntry(project);
    writeState(project, [entry]);
    const target = path.join(project, ".agents", "skills", "alpha");
    const before = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");

    const result = applyRemove(
      normalizeRemoveArgs({ project, skill: "alpha", apply: true }, { cwd: project }),
    );
    expect(fs.existsSync(target)).toBe(false);

    const rollbackResult = commandHelpers.captureCommand(() =>
      rollback.main([
        "bun",
        "scripts/commands/rollback.ts",
        "--project",
        project,
        "--target",
        ".agents/skills",
        "--install-id",
        result.removeId,
      ]),
    );

    expect(rollbackResult.code).toBe(0);
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe(before);
    const state = readState(project);
    expect(state.installed).toEqual([
      expect.objectContaining({
        managedBy: "skill-sys",
        app: "codex",
        skill: "alpha",
        target: ".agents/skills/alpha",
      }),
    ]);
    expect((state.installed as Array<Record<string, unknown>>)[0]?.skillDigest).toBe(digestTreeStrict(target));
  });

  test("aborts on a TOCTOU change between planning and deletion", () => {
    const project = tempProject();
    const entry = managedEntry(project);
    writeState(project, [entry]);
    const target = path.join(project, ".agents", "skills", "alpha");
    const skillMd = path.join(target, "SKILL.md");
    const originalReadFileSync = fs.readFileSync;
    let reads = 0;

    fs.readFileSync = ((filePath: fs.PathLike, ...args: unknown[]) => {
      if (String(filePath) === skillMd) {
        reads += 1;
        if (reads === 2) {
          return "# Tampered after planning\n";
        }
      }
      return (
        originalReadFileSync as unknown as (
          path: fs.PathLike,
          ...rest: unknown[]
        ) => string | Buffer
      )(filePath, ...args);
    }) as typeof fs.readFileSync;

    try {
      expect(() =>
        applyRemove(normalizeRemoveArgs({ project, skill: "alpha", apply: true }, { cwd: project })),
      ).toThrow("TOCTOU abort");
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    expect(fs.existsSync(target)).toBe(true);
    expect(readState(project).installed).toHaveLength(1);
  });

  test("empty plan is a NOOP and creates no backup", () => {
    const project = tempProject();
    writeState(project, [
      { managedBy: "other", app: "codex", skill: "alpha", target: ".agents/skills/alpha" },
    ]);

    const result = applyRemove(
      normalizeRemoveArgs(
        { project, all: true, apply: true, "confirm-all": true },
        { cwd: project },
      ),
    );

    expect(result.selected).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.removeId).toBe("");
    expect(result.backups).toEqual([]);
    expect(fs.existsSync(path.join(project, ".agents", "skills", ".skill-sys-backup"))).toBe(false);
  });

  test("apply aborts while the canonical project lock is held and leaves targets and state untouched", () => {
    const project = tempProject();
    const entry = managedEntry(project);
    writeState(project, [entry]);
    const target = path.join(project, ".agents", "skills", "alpha");
    const statePath = path.join(project, ".skills.state.json");
    const stateBefore = fs.readFileSync(statePath, "utf8");
    const skillBefore = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");
    const lockPath = `${statePath}.lock`;
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, timestamp: Date.now() })}\n`);

    expect(() =>
      applyRemove(normalizeRemoveArgs({ project, skill: "alpha", apply: true }, { cwd: project })),
    ).toThrow("Project state is locked by another writer");

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe(skillBefore);
    expect(fs.readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(fs.existsSync(path.join(project, ".agents", "skills", ".skill-sys-backup"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid });
  });

  test("plan mode does not take the canonical project mutation lock", () => {
    const project = tempProject();
    const entry = managedEntry(project);
    writeState(project, [entry]);

    const plan = planRemove(normalizeRemoveArgs({ project, skill: "alpha", plan: true }, { cwd: project }));

    expect(plan.actions).toHaveLength(1);
    expect(fs.existsSync(path.join(project, ".skills.state.json.lock"))).toBe(false);
  });

  test("a crashed remove apply finishes state reconciliation by target identity on the next apply", () => {
    const project = tempProject();
    const touched = managedEntry(project);
    const foreignEntry = {
      managedBy: "other-tool",
      app: "codex",
      skill: "foreign",
      target: ".foreign/tool",
      skillDigest: "foreign",
    };
    writeState(project, [touched, foreignEntry]);
    const target = path.join(project, ".agents", "skills", "alpha");
    const before = fs.readFileSync(path.join(target, "SKILL.md"), "utf8");

    // Simulate a crash after the filesystem deletion but before the journal
    // removal flag landed: target gone, backup present, flag still false.
    const backupEntry = path.join(project, ".agents", "skills", ".skill-sys-backup", "rmcrash", "alpha");
    fs.mkdirSync(backupEntry, { recursive: true });
    fs.writeFileSync(path.join(backupEntry, "SKILL.md"), before, "utf8");
    fs.rmSync(target, { recursive: true, force: true });
    fs.writeFileSync(
      path.join(project, ".skills.apply-journal.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          applyId: "rmcrash",
          command: "remove",
          createdAt: new Date().toISOString(),
          items: [
            {
              action: "remove",
              target: ".agents/skills/alpha",
              backup: ".agents/skills/.skill-sys-backup/rmcrash/alpha",
              hadTarget: true,
              removed: false,
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = applyRemove(
      normalizeRemoveArgs({ project, skill: "alpha", apply: true }, { cwd: project }),
    );

    // Recovery completed the removal in state before planning, so this apply
    // finds nothing left to do.
    expect(result.selected).toBe(0);
    expect(result.deleted).toBe(0);
    const state = readState(project);
    expect(state.installed).toEqual([foreignEntry]);
    expect(fs.existsSync(target)).toBe(false);
    // Remove backups are deliberately preserved for manual recovery.
    expect(fs.readFileSync(path.join(backupEntry, "SKILL.md"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(project, ".skills.apply-journal.json"))).toBe(false);
  });

  test("planning refuses a current target containing symlinked entries instead of omitting them", () => {
    const project = tempProject();
    const entry = managedEntry(project);
    writeState(project, [entry]);
    const target = path.join(project, ".agents", "skills", "alpha");
    const outsideDir = path.join(project, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret\n", "utf8");
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(target, "escape-link"));

    // dirDigest would silently omit the link and report digestMatches=true;
    // strict planning digests fail closed before any backup or deletion.
    expect(() => planRemove(normalizeRemoveArgs({ project, skill: "alpha", plan: true }, { cwd: project }))).toThrow(/symlink/i);
    expect(() =>
      applyRemove(normalizeRemoveArgs({ project, skill: "alpha", apply: true }, { cwd: project })),
    ).toThrow(/symlink/i);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(path.join(outsideDir, "secret.txt"), "utf8")).toBe("secret\n");
  });
});
