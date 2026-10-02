import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upgradeCommand } from "../scripts/modules/skillpool/upgrade.ts";

const skillpool = require("../scripts/commands/skillpool.ts") as typeof import("../scripts/commands/skillpool.ts");

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

function makeLock(
  root: string,
  overrides: Record<string, unknown> = {},
): { lockfilePath: string; lock: Record<string, unknown> } {
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
        { provider: "codex", skill: "beta", canonicalDigest: "e".repeat(64), projectionDigest: "f".repeat(64), rendererVersion: 1 },
      ],
    },
    installs: [{ app: "codex", skills: ["alpha", "beta"] }],
    ...overrides,
  };
  fs.writeFileSync(lockfilePath, JSON.stringify(lock, null, 2));
  return { lockfilePath, lock };
}

interface CapturedInstall {
  args: Record<string, unknown>;
  scopedLock: Record<string, unknown>;
}

function captureScopedInstall(root: string): { captured: CapturedInstall[]; installCommand: (args: Record<string, unknown>) => void } {
  const captured: CapturedInstall[] = [];
  const installCommand = (args: Record<string, unknown>) => {
    const lockfile = args.lockfile as string | undefined;
    if (!lockfile) {
      throw new Error("expected a scoped lockfile argument");
    }
    const scopedLock = JSON.parse(fs.readFileSync(path.join(root, lockfile), "utf8")) as Record<string, unknown>;
    captured.push({ args, scopedLock });
  };
  return { captured, installCommand };
}

describe("skillpool upgrade --skills", () => {
  test("refreshes requested skills from the current lock without rewriting it", () => {
    const root = makeTempRoot("skillpool-upgrade-skills-");
    const { lockfilePath } = makeLock(root);
    const lockBefore = fs.readFileSync(lockfilePath, "utf8");
    const { captured, installCommand } = captureScopedInstall(root);

    upgradeCommand({ project: root, skills: "beta" }, { installCommand });

    expect(fs.readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.args.skills).toBe("beta");
    expect(captured[0]?.args["refresh-cache"]).toBe(true);
    expect(captured[0]?.scopedLock).toMatchObject({ repo: "old-repo", ref: "v1" });
    expect(captured[0]?.scopedLock.installs).toEqual([{ app: "codex", skills: ["beta"] }]);
  });

  test("fails closed on an unknown skill before mutating the lock", () => {
    const root = makeTempRoot("skillpool-upgrade-skills-unknown-");
    const { lockfilePath } = makeLock(root);
    const lockBefore = fs.readFileSync(lockfilePath, "utf8");
    let installCalled = false;
    let lockWrites = 0;

    expect(() => upgradeCommand({ project: root, skills: "nope" }, {
      installCommand: () => {
        installCalled = true;
      },
      writeLockfile: () => {
        lockWrites += 1;
      },
    })).toThrow("Unknown skill");

    expect(installCalled).toBe(false);
    expect(lockWrites).toBe(0);
    expect(fs.readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
  });

  test("fails closed on unknown skills before promoting when --ref is combined with --skills", () => {
    const root = makeTempRoot("skillpool-upgrade-ref-skills-unknown-");
    const { lockfilePath } = makeLock(root);
    const lockBefore = fs.readFileSync(lockfilePath, "utf8");
    let lockWrites = 0;

    expect(() => upgradeCommand({ project: root, ref: "v2", skills: "missing" }, {
      installCommand: () => undefined,
      writeLockfile: () => {
        lockWrites += 1;
      },
    })).toThrow("Unknown skill");

    expect(lockWrites).toBe(0);
    expect(fs.readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
  });

  test("promotes the lock and scopes the reinstall when --ref and --skills are combined", () => {
    const root = makeTempRoot("skillpool-upgrade-ref-skills-");
    const { lockfilePath } = makeLock(root);
    const { captured, installCommand } = captureScopedInstall(root);

    upgradeCommand({ project: root, ref: "v2", skills: "alpha" }, { installCommand });

    expect(JSON.parse(fs.readFileSync(lockfilePath, "utf8"))).toMatchObject({ repo: "old-repo", ref: "v2" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.args.skills).toBe("alpha");
    expect(captured[0]?.scopedLock).toMatchObject({ repo: "old-repo", ref: "v2" });
    expect(captured[0]?.scopedLock.installs).toEqual([{ app: "codex", skills: ["alpha"] }]);
  });

  test("a full upgrade without --skills does not pass a scoped lockfile", () => {
    const root = makeTempRoot("skillpool-upgrade-full-no-scope-");
    makeLock(root);
    const captured: Array<Record<string, unknown>> = [];

    upgradeCommand({ project: root, ref: "v2" }, {
      installCommand: (args) => captured.push(args as Record<string, unknown>),
    });

    expect(captured[0]?.["lockfile"]).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(root, ".skills.lock.json"), "utf8"))).toMatchObject({ ref: "v2" });
  });

  test("keeps the lock untouched and leaves no recovery marker when a scoped refresh install fails", () => {
    const root = makeTempRoot("skillpool-upgrade-skills-failure-");
    const { lockfilePath } = makeLock(root);
    const lockBefore = fs.readFileSync(lockfilePath, "utf8");

    expect(() => upgradeCommand({ project: root, skills: "alpha" }, {
      installCommand: () => {
        throw new Error("refresh failed");
      },
    })).toThrow("refresh failed");

    expect(fs.readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
    expect(fs.existsSync(`${lockfilePath}.upgrade-recovery.json`)).toBe(false);
    expect(fs.readdirSync(root).filter((entry) => entry.includes(".upgrade-"))).toEqual([]);
  });

  test("dry-run scoped refresh keeps the lock bytes unchanged", () => {
    const root = makeTempRoot("skillpool-upgrade-skills-dry-run-");
    const { lockfilePath } = makeLock(root);
    const lockBefore = fs.readFileSync(lockfilePath, "utf8");
    const { captured, installCommand } = captureScopedInstall(root);

    upgradeCommand({ project: root, skills: "alpha", "dry-run": true }, { installCommand });

    expect(fs.readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.scopedLock.installs).toEqual([{ app: "codex", skills: ["alpha"] }]);
  });

  test("--no-install with --skills and no --ref/--repo is a safe no-op", () => {
    const root = makeTempRoot("skillpool-upgrade-skills-no-install-");
    const { lockfilePath } = makeLock(root);
    const lockBefore = fs.readFileSync(lockfilePath, "utf8");
    let installCalled = false;

    upgradeCommand({ project: root, skills: "alpha", install: false }, {
      installCommand: () => {
        installCalled = true;
      },
    });

    expect(installCalled).toBe(false);
    expect(fs.readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
  });

  test("drops profile-based install entries that cannot scope the requested skill", () => {
    const root = makeTempRoot("skillpool-upgrade-skills-profile-");
    makeLock(root, {
      installs: [
        { app: "codex", skills: ["alpha"] },
        { app: "claude-code", profile: "core" },
      ],
    });
    const { captured, installCommand } = captureScopedInstall(root);

    upgradeCommand({ project: root, skills: "alpha" }, { installCommand });

    expect(captured[0]?.scopedLock.installs).toEqual([
      { app: "codex", skills: ["alpha"] },
    ]);
  });

  test("scopes a profile-only lock from a state-declared skill without rewriting the lock", () => {
    const root = makeTempRoot("skillpool-upgrade-skills-profile-state-");
    const { lockfilePath } = makeLock(root, {
      installs: [{ app: "codex", profile: "core" }],
    });
    fs.writeFileSync(
      path.join(root, ".skills.state.json"),
      JSON.stringify({
        schemaVersion: 2,
        mode: "minimal",
        installed: [
          {
            managedBy: "skill-sys",
            app: "codex",
            skill: "alpha",
            target: ".agents/skills/alpha",
            installMode: "projection",
            skillDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
      }, null, 2),
    );
    const lockBefore = fs.readFileSync(lockfilePath, "utf8");
    const { captured, installCommand } = captureScopedInstall(root);

    upgradeCommand({ project: root, skills: "alpha" }, { installCommand });

    expect(fs.readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
    expect(captured[0]?.scopedLock.installs).toEqual([{ app: "codex", skills: ["alpha"] }]);
  });

  test("scopes a profile-only lock from a resolved source profile and drops profile", () => {
    const root = makeTempRoot("skillpool-upgrade-skills-profile-source-");
    const source = makeTempRoot("skillpool-upgrade-skills-source-");
    fs.mkdirSync(path.join(source, "adapters"), { recursive: true });
    fs.mkdirSync(path.join(source, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(source, "profiles", "core.json"), JSON.stringify({ skills: ["alpha", "beta"] }));

    const { lockfilePath } = makeLock(root, {
      installs: [{ app: "codex", profile: "core" }],
    });
    const lockBefore = fs.readFileSync(lockfilePath, "utf8");
    const { captured, installCommand } = captureScopedInstall(root);

    upgradeCommand({ project: root, skills: "alpha", source }, { installCommand });

    expect(fs.readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
    expect(captured[0]?.scopedLock.installs).toEqual([{ app: "codex", skills: ["alpha"] }]);
  });

  test("fails closed for a profile-only lock with an unresolvable profile", () => {
    const root = makeTempRoot("skillpool-upgrade-skills-profile-missing-source-");
    const { lockfilePath } = makeLock(root, {
      installs: [{ app: "codex", profile: "core" }],
    });
    const lockBefore = fs.readFileSync(lockfilePath, "utf8");
    let installCalled = false;

    expect(() => upgradeCommand({ project: root, skills: "alpha" }, {
      installCommand: () => {
        installCalled = true;
      },
    })).toThrow(/--source/);

    expect(installCalled).toBe(false);
    expect(fs.readFileSync(lockfilePath, "utf8")).toBe(lockBefore);
  });

  test("skillpool upgrade parser accepts --skills", () => {
    const parsed = skillpool.parseCli(["bun", "skillpool", "upgrade", "--ref", "v2", "--skills", "alpha,beta"]);
    expect(parsed.command).toBe("upgrade");
    expect(parsed.args.skills).toBe("alpha,beta");
  });
});
