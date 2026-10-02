import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as files from "../scripts/lib/files.ts";

const applyJournal = require("../scripts/modules/skillpool/apply-journal.ts") as typeof import("../scripts/modules/skillpool/apply-journal.ts");

describe("filesystem traversal hardening", () => {
  test("recursive file listing ignores symlinked entries instead of following them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-files-hardening-"));
    try {
      const safeDir = path.join(root, "safe");
      const outsideDir = path.join(root, "outside");
      fs.mkdirSync(safeDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(safeDir, "keep.txt"), "safe\n", "utf8");
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret\n", "utf8");
      fs.symlinkSync(outsideDir, path.join(safeDir, "outside-link"));
      fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(safeDir, "secret-link.txt"));

      const listed = files.listFilesRecursive(safeDir).map((filePath) => path.relative(safeDir, filePath));

      expect(listed).toEqual(["keep.txt"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-files-hardening-"));
}

describe("strict tree walking", () => {
  test("rejects symlinked entries inside the tree", () => {
    const root = makeTempRoot();
    try {
      const outsideDir = path.join(root, "outside");
      fs.mkdirSync(outsideDir);
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret\n", "utf8");

      const fileLinkRoot = path.join(root, "tree-file-link");
      fs.mkdirSync(fileLinkRoot);
      fs.writeFileSync(path.join(fileLinkRoot, "keep.txt"), "safe\n", "utf8");
      fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(fileLinkRoot, "secret-link.txt"));
      expect(() => files.walkTreeStrict(fileLinkRoot)).toThrow(/symlink/i);

      const dirLinkRoot = path.join(root, "tree-dir-link");
      fs.mkdirSync(dirLinkRoot);
      fs.writeFileSync(path.join(dirLinkRoot, "keep.txt"), "safe\n", "utf8");
      fs.symlinkSync(outsideDir, path.join(dirLinkRoot, "outside-link"));
      expect(() => files.walkTreeStrict(dirLinkRoot)).toThrow(/symlink/i);
      expect(() => files.digestTreeStrict(dirLinkRoot)).toThrow(/symlink/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("has no implicit skip list but honors explicit exclusions", () => {
    const root = makeTempRoot();
    try {
      fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
      fs.mkdirSync(path.join(root, ".git"));
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "x", "utf8");
      fs.writeFileSync(path.join(root, ".git", "config"), "[core]", "utf8");
      fs.writeFileSync(path.join(root, "src", "index.ts"), "export {}", "utf8");

      const relativePaths = (entries: Array<{ relativePath: string }>) =>
        entries.map((entry) => entry.relativePath);

      expect(relativePaths(files.walkTreeStrict(root))).toEqual([
        ".git",
        ".git/config",
        "node_modules",
        "node_modules/pkg",
        "node_modules/pkg/index.js",
        "src",
        "src/index.ts",
      ]);

      const filtered = relativePaths(
        files.walkTreeStrict(root, {
          exclude: (relativePath) =>
            relativePath === "node_modules" || relativePath.startsWith("node_modules/"),
        })
      );
      expect(filtered).toEqual([".git", ".git/config", "src", "src/index.ts"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("digest uses normalized forward-slash relative paths and is stable across root spellings", () => {
    const root = makeTempRoot();
    try {
      fs.mkdirSync(path.join(root, "nested"));
      fs.writeFileSync(path.join(root, "a.txt"), "alpha\n", "utf8");
      fs.writeFileSync(path.join(root, "nested", "b.txt"), "beta\n", "utf8");

      const sha = (content: string) => crypto.createHash("sha256").update(content).digest("hex");
      const expectedManifest = [
        `file\0a.txt\0${sha("alpha\n")}`,
        `dir\0nested`,
        `file\0nested/b.txt\0${sha("beta\n")}`,
      ].join("\n");
      const expected = crypto.createHash("sha256").update(expectedManifest).digest("hex");

      expect(files.digestTreeStrict(root)).toBe(expected);
      expect(files.digestTreeStrict(root + path.sep)).toBe(expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("digest changes when a regular file byte changes", () => {
    const root = makeTempRoot();
    try {
      fs.mkdirSync(path.join(root, "nested"));
      fs.writeFileSync(path.join(root, "a.txt"), "alpha\n", "utf8");
      fs.writeFileSync(path.join(root, "nested", "b.txt"), "beta\n", "utf8");

      const before = files.digestTreeStrict(root);
      fs.writeFileSync(path.join(root, "nested", "b.txt"), "beTa\n", "utf8");

      expect(files.digestTreeStrict(root)).not.toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("withFileLock ownership", () => {
  function writeLockFile(lockPath: string, pid: number, token: string, timestamp = Date.now()): void {
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid, token, timestamp })}\n`, "utf8");
  }

  function writeLegacyLockFile(lockPath: string, pid: number, timestamp = Date.now()): void {
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid, timestamp })}\n`, "utf8");
  }

  function findConfirmedDeadPid(): number {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = spawnSync("true");
      if (typeof result.pid === "number") {
        try {
          process.kill(result.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            return result.pid;
          }
        }
      }
    }
    throw new Error("Unable to obtain a confirmed-dead PID for stale lock testing");
  }

  test("does not steal a lock whose owner PID is alive even if far older than any staleness window", () => {
    const root = makeTempRoot();
    try {
      const target = path.join(root, "state.json");
      const lockPath = `${target}.lock`;
      const liveToken = "a".repeat(32);
      writeLockFile(lockPath, process.pid, liveToken, Date.now() - 10 * 60_000);

      let ran = false;
      const outcome = files.withFileLock(
        target,
        () => {
          ran = true;
          return null;
        },
        { maxAttempts: 1 }
      );

      expect(outcome.status).toBe("locked");
      expect(ran).toBe(false);
      const remaining = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: string };
      expect(remaining.token).toBe(liveToken);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("breaks a lock whose owner PID is dead and releases its own lock afterwards", () => {
    const root = makeTempRoot();
    try {
      const target = path.join(root, "state.json");
      const lockPath = `${target}.lock`;
      writeLockFile(lockPath, findConfirmedDeadPid(), "b".repeat(32));

      const outcome = files.withFileLock(target, () => "ran");

      expect(outcome).toEqual({ status: "acquired", value: "ran" });
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("breaks a legacy tokenless lock when its owner PID is dead and the file identity matches", () => {
    const root = makeTempRoot();
    try {
      const target = path.join(root, "state.json");
      const lockPath = `${target}.lock`;
      writeLegacyLockFile(lockPath, findConfirmedDeadPid());

      const outcome = files.withFileLock(target, () => "ran");

      expect(outcome).toEqual({ status: "acquired", value: "ran" });
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("never steals a live legacy tokenless lock", () => {
    const root = makeTempRoot();
    try {
      const target = path.join(root, "state.json");
      const lockPath = `${target}.lock`;
      writeLegacyLockFile(lockPath, process.pid);
      const before = fs.readFileSync(lockPath, "utf8");

      let ran = false;
      const outcome = files.withFileLock(
        target,
        () => {
          ran = true;
          return null;
        },
        { maxAttempts: 1 }
      );

      expect(outcome.status).toBe("locked");
      expect(ran).toBe(false);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not break an unrecognized lock payload even with a dead owner PID", () => {
    const root = makeTempRoot();
    try {
      const target = path.join(root, "state.json");
      const lockPath = `${target}.lock`;
      // No token and no timestamp: not recognizable as a managed lock.
      fs.writeFileSync(lockPath, `${JSON.stringify({ pid: findConfirmedDeadPid() })}\n`, "utf8");
      const before = fs.readFileSync(lockPath, "utf8");

      let ran = false;
      const outcome = files.withFileLock(
        target,
        () => {
          ran = true;
          return null;
        },
        { maxAttempts: 1 }
      );

      expect(outcome.status).toBe("locked");
      expect(ran).toBe(false);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("holder whose lock was replaced does not delete the new owner's lock", async () => {
    const root = makeTempRoot();
    const newOwner = spawn("sleep", ["30"]);
    try {
      const target = path.join(root, "state.json");
      const lockPath = `${target}.lock`;
      const replacementToken = "c".repeat(32);

      const outcome = files.withFileLock(target, () => {
        // Simulate another live holder taking over the lock before release.
        writeLockFile(lockPath, newOwner.pid ?? process.pid, replacementToken);
        return "ran";
      });

      expect(outcome.status).toBe("acquired");
      expect(fs.existsSync(lockPath)).toBe(true);
      const remaining = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: string };
      expect(remaining.token).toBe(replacementToken);
    } finally {
      newOwner.kill();
      await new Promise<void>((resolve) => newOwner.once("exit", () => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a fresh zero-byte lock is not stolen and fails with an actionable corrupt-lock error naming the path", () => {
    const root = makeTempRoot();
    try {
      const target = path.join(root, "state.json");
      const lockPath = `${target}.lock`;
      // Zero-byte artifact of a crash between O_EXCL creation and payload write.
      fs.writeFileSync(lockPath, "", "utf8");

      let ran = false;
      let thrown: unknown = null;
      try {
        files.withFileLock(
          target,
          () => {
            ran = true;
            return null;
          },
          { maxAttempts: 3 }
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(files.CorruptLockError);
      const corruptError = thrown as files.CorruptLockError;
      expect(corruptError.lockPath).toBe(lockPath);
      expect(corruptError.message).toContain(lockPath);
      expect(corruptError.message).toContain("empty file");
      expect(corruptError.message).toContain("remove the lock manually");
      expect(ran).toBe(false);
      // The fresh crash-window artifact is preserved, not stolen.
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.readFileSync(lockPath, "utf8")).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an aged zero-byte lock from a crashed writer is recovered with inode identity checks", () => {
    const root = makeTempRoot();
    try {
      const target = path.join(root, "state.json");
      const lockPath = `${target}.lock`;
      fs.writeFileSync(lockPath, "", "utf8");
      const staleTime = new Date(Date.now() - 10 * files.CORRUPT_LOCK_GRACE_MS);
      fs.utimesSync(lockPath, staleTime, staleTime);

      const outcome = files.withFileLock(target, () => "ran");

      expect(outcome).toEqual({ status: "acquired", value: "ran" });
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an aged corrupt (invalid JSON) lock is recovered the same way as an aged zero-byte lock", () => {
    const root = makeTempRoot();
    try {
      const target = path.join(root, "state.json");
      const lockPath = `${target}.lock`;
      fs.writeFileSync(lockPath, '{"pid": 123, "tok', "utf8");
      const staleTime = new Date(Date.now() - 10 * files.CORRUPT_LOCK_GRACE_MS);
      fs.utimesSync(lockPath, staleTime, staleTime);

      const outcome = files.withFileLock(target, () => "ran");

      expect(outcome).toEqual({ status: "acquired", value: "ran" });
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a replacement lock placed during recovery-acquired ownership survives release via inode identity", () => {
    const root = makeTempRoot();
    try {
      const target = path.join(root, "state.json");
      const lockPath = `${target}.lock`;
      fs.writeFileSync(lockPath, "", "utf8");
      const staleTime = new Date(Date.now() - 10 * files.CORRUPT_LOCK_GRACE_MS);
      fs.utimesSync(lockPath, staleTime, staleTime);

      const outcome = files.withFileLock(target, () => {
        // Simulate another process replacing our held lock file (new inode,
        // fresh zero-byte payload) before our release runs.
        fs.rmSync(lockPath);
        fs.writeFileSync(lockPath, "", "utf8");
        return "ran";
      });

      expect(outcome).toEqual({ status: "acquired", value: "ran" });
      // The fd/path inode identity recheck prevents deleting the replacement.
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.readFileSync(lockPath, "utf8")).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("withProjectMutationLock surfaces a fresh corrupt lock with actionable guidance instead of blaming another writer", () => {
    const root = makeTempRoot();
    try {
      const lockPath = path.join(root, ".skills.state.json.lock");
      fs.writeFileSync(lockPath, "{truncated", "utf8");
      const before = fs.readFileSync(lockPath, "utf8");

      let ran = false;
      expect(() =>
        files.withProjectMutationLock(root, () => {
          ran = true;
          return null;
        })
      ).toThrow(/corrupt or unrecognized.*\.skills\.state\.json\.lock/s);

      expect(ran).toBe(false);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("apply journal fail-closed recovery", () => {
  function makeJournalProject(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "apply-journal-"));
  }

  function journalPath(projectDir: string): string {
    return path.join(projectDir, ".skills.apply-journal.json");
  }

  function writeJournal(projectDir: string, journal: unknown): void {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(journalPath(projectDir), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  }

  function writeText(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }

  function snapshot(root: string): Map<string, string> {
    const out = new Map<string, string>();
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(entryPath);
        } else {
          out.set(path.relative(root, entryPath), fs.readFileSync(entryPath, "utf8"));
        }
      }
    };
    visit(root);
    return out;
  }

  function halfSwappedJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 1,
      applyId: "half1",
      command: "install",
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
      ],
      ...overrides,
    };
  }

  test("malformed journals are rejected without mutating anything", () => {
    const projectDir = makeJournalProject();
    try {
      const sentinel = path.join(projectDir, ".agents", "skills", "alpha", "SKILL.md");
      writeText(sentinel, "# Keep\n");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(journalPath(projectDir), "{ not json", "utf8");

      expect(() => applyJournal.recoverApplyJournal(projectDir)).toThrow(/Apply journal rejected|Invalid JSON/);

      expect(fs.readFileSync(sentinel, "utf8")).toBe("# Keep\n");
      expect(fs.existsSync(journalPath(projectDir))).toBe(true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("path-escaping temp and backup fields are rejected before any mutation", () => {
    const projectDir = makeJournalProject();
    try {
      writeJournal(projectDir, halfSwappedJournal());
      let raw = JSON.parse(fs.readFileSync(journalPath(projectDir), "utf8")) as { items: Array<Record<string, unknown>> };
      raw.items[0]!.temp = "../../outside-tmp/alpha";
      fs.writeFileSync(journalPath(projectDir), JSON.stringify(raw), "utf8");
      expect(() => applyJournal.recoverApplyJournal(projectDir)).toThrow(
        /temp.*(stay within the project|expected .* root)/i,
      );

      raw = JSON.parse(fs.readFileSync(journalPath(projectDir), "utf8")) as { items: Array<Record<string, unknown>> };
      raw.items[0]!.temp = ".agents/skills/.skill-sys-tmp/half1/alpha";
      raw.items[0]!.backup = "/absolute/escape/alpha";
      fs.writeFileSync(journalPath(projectDir), JSON.stringify(raw), "utf8");
      expect(() => applyJournal.recoverApplyJournal(projectDir)).toThrow(
        /backup.*(stay within the project|project-relative POSIX)/i,
      );

      // Nothing was created or restored by the rejected recoveries.
      expect(fs.existsSync(path.join(projectDir, "outside-tmp"))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, ".agents"))).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("symlinked backup entries and symlinked journal files fail closed", () => {
    const projectDir = makeJournalProject();
    try {
      const outside = path.join(projectDir, "outside");
      writeText(path.join(outside, "secret"), "preserve\n");

      // Seed managed ownership so recovery reaches the backup lstat boundary
      // itself instead of stopping at the ownership gate.
      writeText(path.join(projectDir, ".skills.state.json"), `${JSON.stringify(
        {
          schemaVersion: 2,
          mode: "minimal",
          installed: [
            { managedBy: "skill-sys", app: "codex", skill: "alpha", target: ".agents/skills/alpha", skillDigest: "x" },
          ],
        },
        null,
        2
      )}\n`);
      writeJournal(projectDir, halfSwappedJournal());
      const backupEntry = path.join(projectDir, ".agents", "skills", ".skill-sys-backup", "half1", "alpha");
      fs.mkdirSync(path.dirname(backupEntry), { recursive: true });
      fs.symlinkSync(outside, backupEntry);
      expect(() => applyJournal.recoverApplyJournal(projectDir)).toThrow(/symlink/i);
      expect(fs.readFileSync(path.join(outside, "secret"), "utf8")).toBe("preserve\n");

      fs.rmSync(journalPath(projectDir));
      writeText(path.join(projectDir, "real-journal.json"), "{}\n");
      fs.symlinkSync(path.join(projectDir, "real-journal.json"), journalPath(projectDir));
      expect(() => applyJournal.recoverApplyJournal(projectDir)).toThrow(/symlink/i);
      expect(fs.existsSync(path.join(projectDir, "real-journal.json"))).toBe(true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("half-swapped multi-item recovery is idempotent across a double replay", () => {
    const projectDir = makeJournalProject();
    try {
      const skillsBase = path.join(projectDir, ".agents", "skills");
      const backupOne = path.join(skillsBase, ".skill-sys-backup", "half1", "alpha");
      const backupTwo = path.join(skillsBase, ".skill-sys-backup", "half1", "beta");
      writeText(path.join(backupOne, "SKILL.md"), "# Alpha v1\n");
      writeText(path.join(backupTwo, "SKILL.md"), "# Beta v1\n");
      writeText(path.join(skillsBase, ".skill-sys-backup", "half1", ".complete"), "complete\n");
      writeText(path.join(projectDir, ".skills.state.json"), `${JSON.stringify(
        {
          schemaVersion: 2,
          mode: "minimal",
          installed: [
            { managedBy: "skill-sys", app: "codex", skill: "alpha", target: ".agents/skills/alpha", skillDigest: files.dirDigest(backupOne) },
            { managedBy: "skill-sys", app: "codex", skill: "beta", target: ".agents/skills/beta", skillDigest: files.dirDigest(backupTwo) },
            { managedBy: "other-tool", app: "codex", skill: "foreign", target: ".foreign/tool" },
          ],
        },
        null,
        2
      )}\n`);
      writeJournal(projectDir, {
        schemaVersion: 1,
        applyId: "half1",
        command: "install",
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
            target: ".agents/skills/beta",
            temp: ".agents/skills/.skill-sys-tmp/half1/beta",
            backup: ".agents/skills/.skill-sys-backup/half1/beta",
            hadTarget: true,
            backedUp: true,
            swapped: false,
          },
        ],
      });

      applyJournal.recoverApplyJournal(projectDir);

      expect(fs.readFileSync(path.join(skillsBase, "alpha", "SKILL.md"), "utf8")).toBe("# Alpha v1\n");
      expect(fs.readFileSync(path.join(skillsBase, "beta", "SKILL.md"), "utf8")).toBe("# Beta v1\n");
      expect(fs.existsSync(journalPath(projectDir))).toBe(false);

      const firstPass = snapshot(projectDir);
      applyJournal.recoverApplyJournal(projectDir);
      expect(snapshot(projectDir)).toEqual(firstPass);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("schema-valid journal targeting README.md fails closed without mutating target, backup, or journal", () => {
    const projectDir = makeJournalProject();
    try {
      const readmePath = path.join(projectDir, "README.md");
      writeText(readmePath, "# Planted by journal\n");
      const backupEntry = path.join(projectDir, ".skill-sys-backup", "poison1", "README.md");
      writeText(backupEntry, "# Real README\n");
      const journal = halfSwappedJournal({
        applyId: "poison1",
        items: [
          {
            action: "swap",
            target: "README.md",
            temp: ".skill-sys-tmp/poison1/README.md",
            backup: ".skill-sys-backup/poison1/README.md",
            hadTarget: true,
            backedUp: true,
            swapped: false,
          },
        ],
      });
      writeJournal(projectDir, journal);
      const journalBefore = fs.readFileSync(journalPath(projectDir), "utf8");

      // No .skills.state.json exists at all: a journal alone is not ownership
      // proof, so recovery must abort with everything preserved unchanged.
      expect(() => applyJournal.recoverApplyJournal(projectDir)).toThrow(
        /no skill-sys-managed state record proves ownership/i,
      );
      expect(fs.readFileSync(readmePath, "utf8")).toBe("# Planted by journal\n");
      expect(fs.readFileSync(backupEntry, "utf8")).toBe("# Real README\n");
      expect(fs.readFileSync(journalPath(projectDir), "utf8")).toBe(journalBefore);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("schema-valid completed-swap journal targeting .git/config fails closed and preserves both sides", () => {
    const projectDir = makeJournalProject();
    try {
      const gitConfig = path.join(projectDir, ".git", "config");
      writeText(gitConfig, "[core]\n\trepositoryformatversion = 0\n");
      const backupEntry = path.join(projectDir, ".git", ".skill-sys-backup", "poison2", "config");
      writeText(backupEntry, "[evil]\n\tinjected = true\n");
      writeText(path.join(projectDir, ".skills.state.json"), `${JSON.stringify(
        {
          schemaVersion: 2,
          mode: "minimal",
          installed: [
            { managedBy: "skill-sys", app: "codex", skill: "alpha", target: ".agents/skills/alpha", skillDigest: "x" },
          ],
        },
        null,
        2
      )}\n`);
      writeJournal(projectDir, {
        schemaVersion: 1,
        applyId: "poison2",
        command: "install",
        createdAt: new Date().toISOString(),
        items: [
          {
            action: "swap",
            target: ".git/config",
            temp: ".git/.skill-sys-tmp/poison2/config",
            backup: ".git/.skill-sys-backup/poison2/config",
            hadTarget: true,
            backedUp: true,
            swapped: true,
          },
        ],
      });
      const journalBefore = fs.readFileSync(journalPath(projectDir), "utf8");

      expect(() => applyJournal.recoverApplyJournal(projectDir)).toThrow(
        /no skill-sys-managed state record proves ownership/i,
      );
      expect(fs.readFileSync(gitConfig, "utf8")).toContain("repositoryformatversion = 0");
      expect(fs.readFileSync(backupEntry, "utf8")).toContain("injected = true");
      expect(fs.readFileSync(journalPath(projectDir), "utf8")).toBe(journalBefore);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("fresh swap replacement for an untracked target is preserved instead of deleted", () => {
    const projectDir = makeJournalProject();
    try {
      const targetDir = path.join(projectDir, ".agents", "skills", "fresh");
      writeText(path.join(targetDir, "SKILL.md"), "# Swapped in before crash\n");
      writeJournal(projectDir, {
        schemaVersion: 1,
        applyId: "fresh1",
        command: "install",
        createdAt: new Date().toISOString(),
        items: [
          {
            action: "swap",
            target: ".agents/skills/fresh",
            temp: ".agents/skills/.skill-sys-tmp/fresh1/fresh",
            backup: ".agents/skills/.skill-sys-backup/fresh1/fresh",
            hadTarget: false,
            backedUp: false,
            swapped: true,
          },
        ],
      });
      const journalBefore = fs.readFileSync(journalPath(projectDir), "utf8");

      expect(() => applyJournal.recoverApplyJournal(projectDir)).toThrow(
        /no skill-sys-managed state record proves ownership/i,
      );
      expect(fs.readFileSync(path.join(targetDir, "SKILL.md"), "utf8")).toBe("# Swapped in before crash\n");
      expect(fs.readFileSync(journalPath(projectDir), "utf8")).toBe(journalBefore);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("managed half-swapped targets still recover safely and idempotently", () => {
    const projectDir = makeJournalProject();
    try {
      const skillsBase = path.join(projectDir, ".agents", "skills");
      const backupOne = path.join(skillsBase, ".skill-sys-backup", "own1", "alpha");
      writeText(path.join(backupOne, "SKILL.md"), "# Alpha v1\n");
      writeText(path.join(skillsBase, ".skill-sys-backup", "own1", ".complete"), "complete\n");
      writeText(path.join(projectDir, ".skills.state.json"), `${JSON.stringify(
        {
          schemaVersion: 2,
          mode: "minimal",
          installed: [
            { managedBy: "skill-sys", app: "codex", skill: "alpha", target: ".agents/skills/alpha", skillDigest: files.dirDigest(backupOne) },
          ],
        },
        null,
        2
      )}\n`);
      writeJournal(projectDir, halfSwappedJournal({
        applyId: "own1",
        items: [
          {
            action: "swap",
            target: ".agents/skills/alpha",
            temp: ".agents/skills/.skill-sys-tmp/own1/alpha",
            backup: ".agents/skills/.skill-sys-backup/own1/alpha",
            hadTarget: true,
            backedUp: true,
            swapped: false,
          },
        ],
      }));

      applyJournal.recoverApplyJournal(projectDir);

      expect(fs.readFileSync(path.join(skillsBase, "alpha", "SKILL.md"), "utf8")).toBe("# Alpha v1\n");
      expect(fs.existsSync(journalPath(projectDir))).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("recovery of a completed swap refuses a symlinked entry inside the managed target", () => {
    const projectDir = makeJournalProject();
    try {
      const outside = path.join(projectDir, "outside");
      writeText(path.join(outside, "secret"), "preserve\n");
      const skillsBase = path.join(projectDir, ".agents", "skills");
      const targetDir = path.join(skillsBase, "alpha");
      writeText(path.join(targetDir, "SKILL.md"), "# Next\n");
      fs.symlinkSync(path.join(outside, "secret"), path.join(targetDir, "escape-link"));
      const backupEntry = path.join(skillsBase, ".skill-sys-backup", "linkrec1", "alpha");
      writeText(path.join(backupEntry, "SKILL.md"), "# Previous\n");
      writeText(path.join(projectDir, ".skills.state.json"), `${JSON.stringify(
        {
          schemaVersion: 2,
          mode: "minimal",
          installed: [
            { managedBy: "skill-sys", app: "codex", skill: "alpha", target: ".agents/skills/alpha", skillDigest: "stale" },
          ],
        },
        null,
        2
      )}\n`);
      writeJournal(projectDir, {
        schemaVersion: 1,
        applyId: "linkrec1",
        command: "install",
        createdAt: new Date().toISOString(),
        items: [
          {
            action: "swap",
            target: ".agents/skills/alpha",
            temp: ".agents/skills/.skill-sys-tmp/linkrec1/alpha",
            backup: ".agents/skills/.skill-sys-backup/linkrec1/alpha",
            hadTarget: true,
            backedUp: true,
            swapped: true,
          },
        ],
      });
      const journalBefore = fs.readFileSync(journalPath(projectDir), "utf8");

      expect(() => applyJournal.recoverApplyJournal(projectDir)).toThrow(/symlink/i);
      expect(fs.readFileSync(path.join(outside, "secret"), "utf8")).toBe("preserve\n");
      expect(JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.state.json"), "utf8")).installed[0].skillDigest).toBe("stale");
      expect(fs.readFileSync(path.join(backupEntry, "SKILL.md"), "utf8")).toBe("# Previous\n");
      expect(fs.readFileSync(journalPath(projectDir), "utf8")).toBe(journalBefore);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
