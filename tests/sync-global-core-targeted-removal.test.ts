import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as syncGlobalCore from "../scripts/commands/sync-global-core.ts";

const tempDirs: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-global-core-targeted-"));
  tempDirs.push(root);
  return root;
}

function writeSkill(root: string, name: string, body = `# ${name}\n`): void {
  const skillDir = path.join(root, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), body);
}

function fixture(): {
  root: string;
  source: string;
  target: string;
  manifest: string;
} {
  const root = tempRoot();
  const source = path.join(root, "source");
  const target = path.join(root, "home", ".codex", "skills");
  const manifest = path.join(root, "core.json");
  writeSkill(path.join(source, "skills"), "alpha");
  writeSkill(target, "legacy");
  writeSkill(target, "untouched");
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({
      defaultApps: ["codex"],
      skills: ["alpha"],
      apps: { codex: { targetPath: target, skills: ["alpha"] } },
    }, null, 2)}\n`,
  );
  return { root, source, target, manifest };
}

function writeOwnership(target: string, skills: Array<{ name: string; digest: string }>): void {
  fs.writeFileSync(
    path.join(target, syncGlobalCore.GLOBAL_CORE_OWNERSHIP_FILE),
    `${JSON.stringify({
      version: 2,
      owner: syncGlobalCore.GLOBAL_CORE_OWNER,
      app: "codex",
      skills,
    }, null, 2)}\n`,
  );
}

function quarantinePaths(target: string): string[] {
  return fs
    .readdirSync(target)
    .filter((name) => name.startsWith(".global-core-delete-"))
    .map((name) => path.join(target, name));
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("sync-global-core targeted removal", () => {
  test("parses CSV names and rejects mutually exclusive deletion modes", () => {
    expect(syncGlobalCore.parseArgs([
      "bun",
      "sync-global-core.ts",
      "--delete-skill",
      "legacy,obsolete",
    ]).deleteSkills).toEqual(["legacy", "obsolete"]);
    expect(() => syncGlobalCore.parseArgs([
      "bun",
      "sync-global-core.ts",
      "--delete-extra",
      "--delete-skill",
      "legacy",
    ])).toThrow("mutually exclusive");
  });

  test("removes only the requested unchanged managed skill and preserves other undeclared entries", () => {
    const fixtureData = fixture();
    const skills = ["legacy", "untouched"].map((name) => ({
      name,
      digest: syncGlobalCore.managedSkillDigest(fixtureData.target, name),
    }));
    writeOwnership(fixtureData.target, skills);

    syncGlobalCore.main([
      "bun",
      "sync-global-core.ts",
      "--source",
      fixtureData.source,
      "--manifest",
      fixtureData.manifest,
      "--apps",
      "codex",
      "--delete-skill",
      "legacy",
      "--no-contract-check",
    ], {
      allowedTargetRoots: [fixtureData.root],
      run: () => undefined,
    });

    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(false);
    expect(fs.existsSync(path.join(fixtureData.target, "untouched"))).toBe(true);
    expect(fs.existsSync(path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_CLEANUP_RECEIPT_FILE))).toBe(false);
    const ledger = syncGlobalCore.readCoreOwnership(fixtureData.target, "codex");
    expect(ledger?.skills.map(({ name }) => name)).toEqual(["untouched"]);
  });

  test("restores the skill and original ledger when the reduced ledger write fails", () => {
    const fixtureData = fixture();
    const skills = ["legacy", "untouched"].map((name) => ({
      name,
      digest: syncGlobalCore.managedSkillDigest(fixtureData.target, name),
    }));
    writeOwnership(fixtureData.target, skills);
    const ledgerPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_OWNERSHIP_FILE);
    const originalLedger = fs.readFileSync(ledgerPath, "utf8");
    let attemptedLedger: string[] = [];

    expect(() => syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], {
      allowedTargetRoots: [fixtureData.root],
      run: () => undefined,
      writeCoreOwnership: (_targetDir, _appName, reducedSkills) => {
        attemptedLedger = reducedSkills.map(({ name }) => name);
        fs.writeFileSync(ledgerPath, "{ partial ledger\n");
        throw new Error("injected ledger write failure");
      },
    })).toThrow("injected ledger write failure");

    expect(attemptedLedger).toEqual(["untouched"]);
    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(true);
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(originalLedger);
    expect(quarantinePaths(fixtureData.target)).toEqual([]);
    expect(fs.existsSync(path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_CLEANUP_RECEIPT_FILE))).toBe(false);
  });

  test("recovers cleanup residue on an ordinary retry without touching unrelated paths", () => {
    const fixtureData = fixture();
    const skills = ["legacy", "untouched"].map((name) => ({
      name,
      digest: syncGlobalCore.managedSkillDigest(fixtureData.target, name),
    }));
    writeOwnership(fixtureData.target, skills);
    let cleanupPath = "";

    expect(() => syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], {
      allowedTargetRoots: [fixtureData.root],
      run: () => undefined,
      cleanupQuarantine: (quarantinePath) => {
        cleanupPath = quarantinePath;
        throw new Error("injected cleanup failure");
      },
    })).toThrow("injected cleanup failure");

    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(false);
    const ledger = syncGlobalCore.readCoreOwnership(fixtureData.target, "codex");
    expect(ledger?.skills.map(({ name }) => name)).toEqual(["untouched"]);
    expect(cleanupPath).not.toBe("");
    expect(fs.existsSync(path.join(cleanupPath, "SKILL.md"))).toBe(true);
    expect(quarantinePaths(fixtureData.target)).toEqual([cleanupPath]);
    const unrelatedPath = path.join(fixtureData.target, ".global-core-delete-unrelated");
    writeSkill(unrelatedPath, "unrelated\n");
    const receiptPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_CLEANUP_RECEIPT_FILE);
    expect(fs.existsSync(receiptPath)).toBe(true);

    syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], {
      allowedTargetRoots: [fixtureData.root],
      run: () => undefined,
    });

    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(false);
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(quarantinePaths(fixtureData.target)).toEqual([unrelatedPath]);
    const retriedLedger = syncGlobalCore.readCoreOwnership(fixtureData.target, "codex");
    expect(retriedLedger?.skills.map(({ name }) => name)).toEqual(["untouched"]);
  });

  test("restores a prepared receipt after a crash before the ledger commit", () => {
    const fixtureData = fixture();
    const skills = ["legacy", "untouched"].map((name) => ({
      name,
      digest: syncGlobalCore.managedSkillDigest(fixtureData.target, name),
    }));
    writeOwnership(fixtureData.target, skills);
    const ledgerPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_OWNERSHIP_FILE);
    const originalLedger = fs.readFileSync(ledgerPath, "utf8");
    const receiptPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_CLEANUP_RECEIPT_FILE);

    expect(() => syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], {
      allowedTargetRoots: [fixtureData.root],
      run: () => undefined,
      cleanupQuarantine: () => {
        throw new Error("injected cleanup failure");
      },
    })).toThrow("injected cleanup failure");

    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    expect(receipt.state).toBe("ledger-committed");
    fs.writeFileSync(ledgerPath, originalLedger);
    receipt.state = "prepared";
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], { allowedTargetRoots: [fixtureData.root], run: () => undefined });

    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(true);
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(originalLedger);
    expect(fs.existsSync(receiptPath)).toBe(false);
  });

  test("restores a partial-rename prepared receipt while preserving live sources", () => {
    const fixtureData = fixture();
    writeSkill(fixtureData.target, "obsolete");
    const skills = ["legacy", "obsolete", "untouched"].map((name) => ({
      name,
      digest: syncGlobalCore.managedSkillDigest(fixtureData.target, name),
    }));
    writeOwnership(fixtureData.target, skills);
    const ledgerPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_OWNERSHIP_FILE);
    const originalLedger = fs.readFileSync(ledgerPath, "utf8");
    const legacyDigest = skills.find(({ name }) => name === "legacy")!.digest;
    const obsoleteDigest = skills.find(({ name }) => name === "obsolete")!.digest;
    const receiptPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_CLEANUP_RECEIPT_FILE);
    const legacyQuarantine = ".global-core-delete-legacy-crash-window";
    const obsoleteQuarantine = ".global-core-delete-obsolete-crash-window";
    fs.renameSync(
      path.join(fixtureData.target, "legacy"),
      path.join(fixtureData.target, legacyQuarantine),
    );
    fs.writeFileSync(receiptPath, `${JSON.stringify({
      version: 1,
      owner: syncGlobalCore.GLOBAL_CORE_OWNER,
      app: "codex",
      target: path.resolve(fixtureData.target),
      state: "prepared",
      originalLedger,
      originalSkills: skills,
      remainingSkills: [{ name: "untouched", digest: skills.find(({ name }) => name === "untouched")!.digest }],
      entries: [
        { name: "legacy", digest: legacyDigest, quarantineName: legacyQuarantine },
        { name: "obsolete", digest: obsoleteDigest, quarantineName: obsoleteQuarantine },
      ],
    }, null, 2)}\n`);

    syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy,obsolete", "--no-contract-check",
    ], { allowedTargetRoots: [fixtureData.root], run: () => undefined });

    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(true);
    expect(fs.existsSync(path.join(fixtureData.target, "obsolete"))).toBe(true);
    expect(quarantinePaths(fixtureData.target)).toEqual([]);
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(originalLedger);
  });

  test("clears a prepared receipt after zero renames without changing the target", () => {
    const fixtureData = fixture();
    const skills = ["legacy", "untouched"].map((name) => ({
      name,
      digest: syncGlobalCore.managedSkillDigest(fixtureData.target, name),
    }));
    writeOwnership(fixtureData.target, skills);
    const ledgerPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_OWNERSHIP_FILE);
    const originalLedger = fs.readFileSync(ledgerPath, "utf8");
    const receiptPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_CLEANUP_RECEIPT_FILE);
    fs.writeFileSync(receiptPath, `${JSON.stringify({
      version: 1,
      owner: syncGlobalCore.GLOBAL_CORE_OWNER,
      app: "codex",
      target: path.resolve(fixtureData.target),
      state: "prepared",
      originalLedger,
      originalSkills: skills,
      remainingSkills: [{ name: "untouched", digest: skills.find(({ name }) => name === "untouched")!.digest }],
      entries: [{
        name: "legacy",
        digest: skills.find(({ name }) => name === "legacy")!.digest,
        quarantineName: ".global-core-delete-legacy-zero-renames",
      }],
    }, null, 2)}\n`);

    syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], { allowedTargetRoots: [fixtureData.root], run: () => undefined });

    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(true);
    expect(fs.existsSync(path.join(fixtureData.target, "untouched"))).toBe(true);
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(originalLedger);
    expect(quarantinePaths(fixtureData.target)).toEqual([]);
    expect(fs.existsSync(receiptPath)).toBe(false);
  });

  test("leaves state unchanged when the prepared receipt cannot be written", () => {
    const fixtureData = fixture();
    const skills = ["legacy", "untouched"].map((name) => ({
      name,
      digest: syncGlobalCore.managedSkillDigest(fixtureData.target, name),
    }));
    writeOwnership(fixtureData.target, skills);
    const ledgerPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_OWNERSHIP_FILE);
    const originalLedger = fs.readFileSync(ledgerPath, "utf8");
    const receiptPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_CLEANUP_RECEIPT_FILE);

    expect(() => syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], {
      allowedTargetRoots: [fixtureData.root],
      run: () => undefined,
      writeCleanupReceipt: () => {
        throw new Error("injected prepared receipt write failure");
      },
    })).toThrow("injected prepared receipt write failure");

    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(true);
    expect(fs.existsSync(path.join(fixtureData.target, "untouched"))).toBe(true);
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(originalLedger);
    expect(quarantinePaths(fixtureData.target)).toEqual([]);
    expect(fs.existsSync(receiptPath)).toBe(false);
  });

  test("rejects a symlinked cleanup receipt without mutating the target or ledger", () => {
    const fixtureData = fixture();
    const skills = ["legacy", "untouched"].map((name) => ({
      name,
      digest: syncGlobalCore.managedSkillDigest(fixtureData.target, name),
    }));
    writeOwnership(fixtureData.target, skills);
    const ledgerPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_OWNERSHIP_FILE);
    const originalLedger = fs.readFileSync(ledgerPath, "utf8");
    const receiptPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_CLEANUP_RECEIPT_FILE);
    const outsideReceipt = path.join(fixtureData.root, "outside-receipt.json");
    fs.writeFileSync(outsideReceipt, "keep\n");
    fs.symlinkSync(outsideReceipt, receiptPath);

    expect(() => syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], { allowedTargetRoots: [fixtureData.root], run: () => undefined })).toThrow(/regular unlinked file/);

    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(true);
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(originalLedger);
    expect(quarantinePaths(fixtureData.target)).toEqual([]);
    expect(fs.readFileSync(outsideReceipt, "utf8")).toBe("keep\n");
  });

  test("rejects tampered receipt digests and traversal paths without unsafe action", () => {
    const fixtureData = fixture();
    const skills = ["legacy", "untouched"].map((name) => ({
      name,
      digest: syncGlobalCore.managedSkillDigest(fixtureData.target, name),
    }));
    writeOwnership(fixtureData.target, skills);
    const ledgerPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_OWNERSHIP_FILE);
    const originalLedger = fs.readFileSync(ledgerPath, "utf8");
    const receiptPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_CLEANUP_RECEIPT_FILE);
    const outsideSentinel = path.join(fixtureData.root, "outside-sentinel");
    fs.writeFileSync(outsideSentinel, "keep\n");
    const receipt = {
      version: 1,
      owner: syncGlobalCore.GLOBAL_CORE_OWNER,
      app: "codex",
      target: path.resolve(fixtureData.target),
      state: "prepared",
      originalLedger,
      originalSkills: skills,
      remainingSkills: [{ name: "untouched", digest: skills.find(({ name }) => name === "untouched")!.digest }],
      entries: [{
        name: "legacy",
        digest: "0".repeat(64),
        quarantineName: ".global-core-delete-legacy-tampered",
      }],
    };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], { allowedTargetRoots: [fixtureData.root], run: () => undefined })).toThrow(/Invalid global core cleanup receipt/);

    receipt.entries[0]!.digest = skills.find(({ name }) => name === "legacy")!.digest;
    receipt.entries[0]!.quarantineName = "../outside-sentinel";
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], { allowedTargetRoots: [fixtureData.root], run: () => undefined })).toThrow(/Invalid global core cleanup receipt/);

    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(true);
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(originalLedger);
    expect(quarantinePaths(fixtureData.target)).toEqual([]);
    expect(fs.readFileSync(outsideSentinel, "utf8")).toBe("keep\n");
  });

  test("retries after cleanup completed but receipt clearing failed", () => {
    const fixtureData = fixture();
    const skills = ["legacy", "untouched"].map((name) => ({
      name,
      digest: syncGlobalCore.managedSkillDigest(fixtureData.target, name),
    }));
    writeOwnership(fixtureData.target, skills);
    const receiptPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_CLEANUP_RECEIPT_FILE);
    let clearAttempts = 0;

    expect(() => syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], {
      allowedTargetRoots: [fixtureData.root],
      run: () => undefined,
      clearCleanupReceipt: () => {
        clearAttempts += 1;
        throw new Error("injected receipt clear failure");
      },
    })).toThrow("injected receipt clear failure");

    expect(clearAttempts).toBe(1);
    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(false);
    expect(quarantinePaths(fixtureData.target)).toEqual([]);
    expect(fs.existsSync(receiptPath)).toBe(true);

    syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", fixtureData.source,
      "--manifest", fixtureData.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], { allowedTargetRoots: [fixtureData.root], run: () => undefined });

    expect(fs.existsSync(receiptPath)).toBe(false);
    const ledger = syncGlobalCore.readCoreOwnership(fixtureData.target, "codex");
    expect(ledger?.skills.map(({ name }) => name)).toEqual(["untouched"]);
  });

  test("dry-run reports the exact removal without changing the target or ledger", () => {
    const fixtureData = fixture();
    const skills = ["legacy", "untouched"].map((name) => ({
      name,
      digest: syncGlobalCore.managedSkillDigest(fixtureData.target, name),
    }));
    writeOwnership(fixtureData.target, skills);
    const ledgerPath = path.join(fixtureData.target, syncGlobalCore.GLOBAL_CORE_OWNERSHIP_FILE);
    const beforeLedger = fs.readFileSync(ledgerPath, "utf8");
    const calls: string[][] = [];

    syncGlobalCore.main([
      "bun",
      "sync-global-core.ts",
      "--source",
      fixtureData.source,
      "--manifest",
      fixtureData.manifest,
      "--apps",
      "codex",
      "--delete-skill",
      "legacy",
      "--dry-run",
      "--no-contract-check",
    ], {
      allowedTargetRoots: [fixtureData.root],
      run: (args) => calls.push(args),
    });

    expect(fs.existsSync(path.join(fixtureData.target, "legacy"))).toBe(true);
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(beforeLedger);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--dry-run");
  });

  test("rejects declared or digest-drifted targeted skills before removal", () => {
    const declared = fixture();
    const legacyDigest = syncGlobalCore.managedSkillDigest(declared.target, "legacy");
    writeOwnership(declared.target, [{ name: "legacy", digest: legacyDigest }]);
    const declaredManifest = JSON.parse(fs.readFileSync(declared.manifest, "utf8")) as {
      skills: string[];
      apps: { codex: { skills: string[] } };
    };
    declaredManifest.skills.push("legacy");
    declaredManifest.apps.codex.skills.push("legacy");
    fs.writeFileSync(declared.manifest, JSON.stringify(declaredManifest));
    expect(() => syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", declared.source,
      "--manifest", declared.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], { allowedTargetRoots: [declared.root], run: () => undefined })).toThrow("still declared");

    const drifted = fixture();
    writeOwnership(drifted.target, [{
      name: "legacy",
      digest: syncGlobalCore.managedSkillDigest(drifted.target, "legacy"),
    }]);
    fs.appendFileSync(path.join(drifted.target, "legacy", "SKILL.md"), "drift\n");
    expect(() => syncGlobalCore.main([
      "bun", "sync-global-core.ts", "--source", drifted.source,
      "--manifest", drifted.manifest, "--apps", "codex",
      "--delete-skill", "legacy", "--no-contract-check",
    ], { allowedTargetRoots: [drifted.root], run: () => undefined })).toThrow("digest differs");
    expect(fs.existsSync(path.join(drifted.target, "legacy"))).toBe(true);
  });
});
