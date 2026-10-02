import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROJECTION_BACKUP_DIR_PREFIX,
  PROJECTION_ROOT_MARKER_FILE,
  PROJECTION_STAGING_DIR_PREFIX,
  buildProjections,
  findProjectionCleanObstruction,
  validateProjections,
} from "../scripts/modules/skillpool/projections.ts";
import { parseProviderListForSource, type ConcreteProviderId } from "../scripts/modules/skillpool/providers.ts";

const repoRoot = path.resolve(__dirname, "..");

function writeSkill(root: string, name: string, description: string): void {
  const skillDir = path.join(root, "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\nvisibility: user-private\nexport_policy: never\n---\n\n# ${name}\n`,
    "utf8"
  );
}

function writeSkillWithMeta(
  root: string,
  name: string,
  description: string,
  risk: Record<string, boolean>,
  invocation: { implicitAllowed: boolean; manualOnly: boolean; requiresConfirmation: boolean }
): void {
  writeSkill(root, name, description);
  const skillDir = path.join(root, "skills", name);
  fs.writeFileSync(
    path.join(skillDir, "skill.meta.json"),
    `${JSON.stringify(
      {
        name,
        version: "1.0.0",
        contractVersion: "1.0",
        lifecycle: "active",
        risk,
        invocation,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function defaultRisk(overrides: Partial<Record<string, boolean>> = {}): Record<string, boolean> {
  return {
    readsFiles: false,
    writesProject: false,
    writesGlobal: false,
    executesShell: false,
    networkAccess: false,
    externalDirectory: false,
    credentialSensitive: false,
    destructive: false,
    browserAuthState: false,
    repoMutation: false,
    ...overrides,
  };
}

function createProjectionMatrixSource(): string {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-provider-matrix-source-"));
  fs.mkdirSync(path.join(sourceRoot, "profiles"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "providers"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "providers"), path.join(sourceRoot, "providers"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, "skillpack.json"),
    `${JSON.stringify(
      {
        name: "provider-matrix-fixture",
        version: "1.0.0",
        providers: ["codex", "opencode", "gemini-cli", "qwen", "antigravity", "claude-code"],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeSkillWithMeta(sourceRoot, "safe-skill", "Use when testing safe projection controls.", defaultRisk(), {
    implicitAllowed: true,
    manualOnly: false,
    requiresConfirmation: false,
  });
  writeSkillWithMeta(
    sourceRoot,
    "shell-network-skill",
    "Use when testing shell and network projection controls.",
    defaultRisk({ executesShell: true, networkAccess: true }),
    { implicitAllowed: false, manualOnly: false, requiresConfirmation: true }
  );
  writeSkillWithMeta(
    sourceRoot,
    "destructive-skill",
    "Use when testing destructive projection controls.",
    defaultRisk({ destructive: true, writesProject: true, writesGlobal: true, repoMutation: true }),
    { implicitAllowed: false, manualOnly: true, requiresConfirmation: true }
  );
  writeSkillWithMeta(
    sourceRoot,
    "credential-skill",
    "Use when testing credential-sensitive projection controls.",
    defaultRisk({ readsFiles: true, externalDirectory: true, credentialSensitive: true, browserAuthState: true }),
    { implicitAllowed: false, manualOnly: false, requiresConfirmation: true }
  );
  writeSkillWithMeta(sourceRoot, "manual-only-skill", "Use when testing manual-only projection controls.", defaultRisk(), {
    implicitAllowed: false,
    manualOnly: true,
    requiresConfirmation: false,
  });
  return sourceRoot;
}

describe("projection publish gate", () => {
  // Isolate the content-addressable projection store from the real
  // ~/.skillpool so builds in this file never read or write user home state.
  let skillpoolHome: string;
  let previousSkillpoolHome: string | undefined;
  beforeAll(() => {
    previousSkillpoolHome = process.env.SKILLPOOL_HOME;
    skillpoolHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-projection-gate-skillpool-"));
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

  test("all providers resolves to providers declared by a skillpack source", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const providers = parseProviderListForSource("all", sourceRoot);
    expect(providers).toEqual(["codex", "opencode"]);

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-projection-gate-"));
    try {
      const result = buildProjections({
        sourceRoot,
        providers,
        outDir,
        clean: true,
      });
      expect(result.projections).toHaveLength(2);
      expect(result.manifestPath).toBe(path.join(outDir, "projection-manifest.json"));
      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.rendererVersion).toBe(1);
      expect(manifest.providers).toEqual(["codex", "opencode"]);
      expect(manifest.projections).toHaveLength(2);
      expect(new Set(result.projections.map((projection) => projection.provider))).toEqual(new Set(["codex", "opencode"]));
      expect(result.projections.every((projection) => projection.skill === "example-skill")).toBe(true);
      expect(validateProjections({ sourceRoot, providers, outDir })).toEqual([]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("projection manifest is validated against generated projection metadata", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const providers = parseProviderListForSource("all", sourceRoot);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-projection-manifest-"));
    try {
      const result = buildProjections({ sourceRoot, providers, outDir, clean: true });
      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
      manifest.projections[0].projectionDigest = "0".repeat(64);
      fs.writeFileSync(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const findings = validateProjections({ sourceRoot, providers, outDir });
      expect(findings.some((finding) => finding.code === "PROJECTION_MANIFEST_RECORD_MISMATCH")).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("projection manifest detects tampered origin and canonical path records", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const providers = parseProviderListForSource("all", sourceRoot);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-projection-manifest-origin-"));
    try {
      const result = buildProjections({ sourceRoot, providers, outDir, clean: true });
      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
      manifest.projections[0].origin = "user";
      manifest.projections[0].canonicalPath = "user:skills/tampered";
      fs.writeFileSync(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const findings = validateProjections({ sourceRoot, providers, outDir });
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "PROJECTION_MANIFEST_RECORD_MISMATCH" }),
        ])
      );
      expect(findings.filter((finding) => finding.code === "PROJECTION_MANIFEST_RECORD_MISMATCH")).toHaveLength(2);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("user skill roots are opt-in projection sources with private origin metadata", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-root-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-projection-"));
    try {
      writeSkill(userRoot, "private-note", "Use when testing a local private skill.");
      const providers = ["codex"] as const;
      const withoutUser = buildProjections({ sourceRoot, providers: [...providers], outDir, clean: true });
      expect(withoutUser.projections.map((projection) => projection.skill)).toEqual(["example-skill"]);

      const withUser = buildProjections({
        sourceRoot,
        providers: [...providers],
        outDir,
        clean: true,
        userRoot,
        includeUser: true,
      });

      expect(withUser.projections.map((projection) => projection.skill).sort()).toEqual([
        "example-skill",
        "private-note",
      ]);
      const privateRecord = withUser.projections.find((projection) => projection.skill === "private-note");
      expect(privateRecord?.origin).toBe("user");
      expect(privateRecord?.canonicalPath).toBe("user:skills/private-note");
      expect(privateRecord?.projectionPath).toBe("codex/private-note");
      expect(withUser.manifest.origins).toEqual(["public", "user"]);
      expect(validateProjections({ sourceRoot, providers: [...providers], outDir, userRoot, includeUser: true })).toEqual([]);
      expect(validateProjections({ sourceRoot, providers: [...providers], outDir })).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "PROJECTION_SKILL_UNEXPECTED" })])
      );
    } finally {
      fs.rmSync(userRoot, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("opt-out build prunes stale user projections without requiring clean", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-stale-root-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-stale-out-"));
    try {
      writeSkill(userRoot, "private-note", "Use when testing stale private projections.");
      const providers = ["codex"] as const;

      buildProjections({
        sourceRoot,
        providers: [...providers],
        outDir,
        clean: true,
        userRoot,
        includeUser: true,
      });
      const staleProjectionDir = path.join(outDir, "codex", "private-note");
      expect(fs.existsSync(staleProjectionDir)).toBe(true);

      const withoutUser = buildProjections({
        sourceRoot,
        providers: [...providers],
        outDir,
        clean: false,
        userRoot,
        includeUser: false,
      });

      expect(withoutUser.projections.map((projection) => projection.skill)).toEqual(["example-skill"]);
      expect(fs.existsSync(staleProjectionDir)).toBe(false);
      expect(validateProjections({ sourceRoot, providers: [...providers], outDir })).toEqual([]);
    } finally {
      fs.rmSync(userRoot, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });



  test("include-user build prunes stale user projections for removed user skills", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-removed-root-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-removed-out-"));
    try {
      writeSkill(userRoot, "private-note", "Use when testing removed private projections.");
      const providers = ["codex"] as const;

      buildProjections({
        sourceRoot,
        providers: [...providers],
        outDir,
        clean: true,
        userRoot,
        includeUser: true,
      });
      const staleProjectionDir = path.join(outDir, "codex", "private-note");
      expect(fs.existsSync(staleProjectionDir)).toBe(true);

      fs.rmSync(path.join(userRoot, "skills", "private-note"), { recursive: true, force: true });
      const withoutRemovedUserSkill = buildProjections({
        sourceRoot,
        providers: [...providers],
        outDir,
        clean: false,
        userRoot,
        includeUser: true,
      });

      expect(withoutRemovedUserSkill.projections.map((projection) => projection.skill)).toEqual(["example-skill"]);
      expect(fs.existsSync(staleProjectionDir)).toBe(false);
      expect(validateProjections({ sourceRoot, providers: [...providers], outDir, userRoot, includeUser: true })).toEqual([]);
    } finally {
      fs.rmSync(userRoot, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("duplicate public and user skill names fail closed", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-duplicate-root-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-duplicate-out-"));
    try {
      writeSkill(userRoot, "example-skill", "Use when testing duplicate public/user skill collisions.");
      expect(() =>
        buildProjections({
          sourceRoot,
          providers: ["codex"],
          outDir,
          clean: true,
          userRoot,
          includeUser: true,
        })
      ).toThrow(/Duplicate skill 'example-skill'/);
    } finally {
      fs.rmSync(userRoot, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("user skill source symlinks fail even when a cached projection is reusable", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-symlink-root-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-symlink-out-"));
    const outsideFile = path.join(userRoot, "outside-secret.txt");
    try {
      writeSkill(userRoot, "private-note", "Use when testing unsafe source symlinks.");
      const providers = ["codex"] as const;
      buildProjections({
        sourceRoot,
        providers: [...providers],
        outDir,
        clean: true,
        userRoot,
        includeUser: true,
      });

      fs.writeFileSync(outsideFile, "secret\n", "utf8");
      fs.symlinkSync(outsideFile, path.join(userRoot, "skills", "private-note", "secret-link.txt"));

      expect(() =>
        buildProjections({
          sourceRoot,
          providers: [...providers],
          outDir,
          clean: false,
          userRoot,
          includeUser: true,
        })
      ).toThrow(/symlink/i);
    } finally {
      fs.rmSync(userRoot, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("cached projection symlinks fail before cache reuse", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-cached-target-root-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-user-cached-target-out-"));
    const outsideFile = path.join(userRoot, "outside-target-secret.txt");
    try {
      writeSkill(userRoot, "private-note", "Use when testing unsafe cached projection symlinks.");
      const providers = ["codex"] as const;
      buildProjections({
        sourceRoot,
        providers: [...providers],
        outDir,
        clean: true,
        userRoot,
        includeUser: true,
      });

      fs.writeFileSync(outsideFile, "secret\n", "utf8");
      fs.symlinkSync(outsideFile, path.join(outDir, "codex", "private-note", "secret-link.txt"));

      expect(() =>
        buildProjections({
          sourceRoot,
          providers: [...providers],
          outDir,
          clean: false,
          userRoot,
          includeUser: true,
        })
      ).toThrow(/symlink/i);
    } finally {
      fs.rmSync(userRoot, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });



  test("include-user build resolves SKILL_SYS_USER_ROOT when no userRoot option is passed", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-env-user-root-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-env-user-root-out-"));
    const originalSkillRoot = process.env.SKILL_SYS_USER_ROOT;
    try {
      writeSkill(userRoot, "private-note", "Use when testing env-based user root resolution.");
      process.env.SKILL_SYS_USER_ROOT = userRoot;
      const providers = ["codex"] as const;
      const result = buildProjections({
        sourceRoot,
        providers: [...providers],
        outDir,
        clean: true,
        includeUser: true,
      });

      const privateRecord = result.projections.find((projection) => projection.skill === "private-note");
      expect(privateRecord?.origin).toBe("user");
      expect(privateRecord?.canonicalPath).toBe("user:skills/private-note");
      expect(validateProjections({ sourceRoot, providers: [...providers], outDir, includeUser: true })).toEqual([]);
    } finally {
      if (originalSkillRoot === undefined) {
        delete process.env.SKILL_SYS_USER_ROOT;
      } else {
        process.env.SKILL_SYS_USER_ROOT = originalSkillRoot;
      }
      fs.rmSync(userRoot, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("default user root never falls back to the current project directory", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-cwd-root-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-cwd-root-out-"));
    const originalCwd = process.cwd();
    const originalHome = process.env.HOME;
    const originalSkillRoot = process.env.SKILL_SYS_USER_ROOT;
    try {
      writeSkill(path.join(cwdRoot, ".skill-sys"), "cwd-private", "Must not be discovered from cwd fallback.");
      process.chdir(cwdRoot);
      delete process.env.SKILL_SYS_USER_ROOT;
      process.env.HOME = "";

      let projectedCwdPrivate = false;
      try {
        const result = buildProjections({
          sourceRoot,
          providers: ["codex"],
          outDir,
          clean: true,
          includeUser: true,
        });
        projectedCwdPrivate = result.projections.some((projection) => projection.skill === "cwd-private");
      } catch (error) {
        expect(error instanceof Error).toBe(true);
      }

      expect(projectedCwdPrivate).toBe(false);
    } finally {
      process.chdir(originalCwd);
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalSkillRoot === undefined) {
        delete process.env.SKILL_SYS_USER_ROOT;
      } else {
        process.env.SKILL_SYS_USER_ROOT = originalSkillRoot;
      }
      fs.rmSync(cwdRoot, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("all provider projections record risk and enforce available manual-only controls", () => {
    const sourceRoot = createProjectionMatrixSource();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-provider-matrix-out-"));
    const providers = parseProviderListForSource("all", sourceRoot);
    const expectedProviders: ConcreteProviderId[] = ["codex", "opencode", "gemini-cli", "qwen", "antigravity", "claude-code"];
    const expectedSkills = [
      "credential-skill",
      "destructive-skill",
      "manual-only-skill",
      "safe-skill",
      "shell-network-skill",
    ];
    try {
      expect(providers).toEqual(expectedProviders);
      const result = buildProjections({ sourceRoot, providers, outDir, clean: true });
      expect(result.manifest.providers).toEqual(expectedProviders);
      expect(result.projections).toHaveLength(expectedProviders.length * expectedSkills.length);
      expect(validateProjections({ sourceRoot, providers, outDir })).toEqual([]);

      for (const provider of expectedProviders) {
        const projectedSkills = result.projections
          .filter((projection) => projection.provider === provider)
          .map((projection) => projection.skill)
          .sort();
        expect(projectedSkills).toEqual(expectedSkills);
      }

      const safeRecords = result.projections.filter((projection) => projection.skill === "safe-skill");
      expect(safeRecords.every((projection) => projection.manualOnly === false)).toBe(true);

      const riskyRecords = result.projections.filter((projection) => projection.skill !== "safe-skill");
      expect(riskyRecords.every((projection) => projection.manualOnly === true)).toBe(true);
      expect(riskyRecords.some((projection) => projection.risk.executesShell && projection.risk.networkAccess)).toBe(true);
      expect(riskyRecords.some((projection) => projection.risk.destructive && projection.risk.writesGlobal)).toBe(true);
      expect(riskyRecords.some((projection) => projection.risk.credentialSensitive && projection.risk.browserAuthState)).toBe(true);

      for (const skill of expectedSkills.filter((item) => item !== "safe-skill")) {
        expect(fs.existsSync(path.join(outDir, "codex", skill, "agents", "openai.yaml"))).toBe(true);
        expect(fs.existsSync(path.join(outDir, "opencode", skill, "opencode.permissions.json"))).toBe(true);
        const claudeSkill = fs.readFileSync(path.join(outDir, "claude-code", skill, "SKILL.md"), "utf8");
        expect(claudeSkill).toContain("disable-model-invocation: true");
      }

      for (const provider of ["gemini-cli", "qwen", "antigravity"]) {
        for (const skill of expectedSkills.filter((item) => item !== "safe-skill")) {
          const record = result.projections.find((projection) => projection.provider === provider && projection.skill === skill);
          expect(record?.manualOnly).toBe(true);
        }
      }
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("antigravity matrix documents its Gemini-compatible baseline path", () => {
    const antigravity = JSON.parse(fs.readFileSync(path.join(repoRoot, "providers", "antigravity.json"), "utf8"));
    const gemini = JSON.parse(fs.readFileSync(path.join(repoRoot, "providers", "gemini-cli.json"), "utf8"));
    expect(antigravity.skillPaths.user).toBe(gemini.skillPaths.user);
    expect(antigravity.dangerNotes.join("\n")).toContain("Gemini CLI user skill path");
  });

  test("clean fails closed for home, project root, filesystem root, source parents, and symlinked paths", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-clean-guard-"));
    try {
      const homedir = path.join(fixture, "home");
      const projectRoot = path.join(fixture, "project");
      fs.mkdirSync(homedir, { recursive: true });
      fs.mkdirSync(projectRoot, { recursive: true });
      const context = { homedir, projectRoot };

      expect(findProjectionCleanObstruction(path.parse(fixture).root, sourceRoot, context)).toMatch(/filesystem root/);
      expect(findProjectionCleanObstruction(homedir, sourceRoot, context)).toMatch(/home directory/);
      expect(findProjectionCleanObstruction(fixture, sourceRoot, context)).toMatch(/home directory/);
      expect(findProjectionCleanObstruction(projectRoot, sourceRoot, context)).toMatch(/project root/);
      expect(findProjectionCleanObstruction(path.dirname(sourceRoot), sourceRoot, context)).toMatch(/source root/);
      expect(findProjectionCleanObstruction(os.homedir(), sourceRoot)).toMatch(/home directory|filesystem root/);

      const symlinkOut = path.join(fixture, "symlink-out");
      fs.symlinkSync(projectRoot, symlinkOut);
      expect(findProjectionCleanObstruction(symlinkOut, sourceRoot, context)).toMatch(/symlink/i);
      expect(findProjectionCleanObstruction(path.join(symlinkOut, "out"), sourceRoot, context)).toMatch(/symlink/i);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("--out-dir . --clean fails closed against the current project directory", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const projectFixture = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-clean-cwd-"));
    const originalCwd = process.cwd();
    try {
      fs.writeFileSync(path.join(projectFixture, "sentinel.txt"), "keep\n", "utf8");
      process.chdir(projectFixture);
      expect(() =>
        buildProjections({
          sourceRoot,
          providers: ["codex"],
          outDir: ".",
          clean: true,
        })
      ).toThrow(/project root/);
      expect(fs.readFileSync(path.join(projectFixture, "sentinel.txt"), "utf8")).toBe("keep\n");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(projectFixture, { recursive: true, force: true });
    }
  });

  test("clean allows missing and empty output dirs and builds write a Skill-Sys ownership marker", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-clean-marker-"));
    try {
      const missingOut = path.join(fixture, "missing-out");
      buildProjections({ sourceRoot, providers: ["codex"], outDir: missingOut, clean: true });
      const marker = JSON.parse(fs.readFileSync(path.join(missingOut, PROJECTION_ROOT_MARKER_FILE), "utf8"));
      expect(marker).toMatchObject({ schemaVersion: 1, tool: "skill-sys", kind: "projection-output" });

      // Repeat --clean over the marked tree keeps working.
      expect(() => buildProjections({ sourceRoot, providers: ["codex"], outDir: missingOut, clean: true })).not.toThrow();

      const emptyOut = path.join(fixture, "empty-out");
      fs.mkdirSync(emptyOut, { recursive: true });
      buildProjections({ sourceRoot, providers: ["codex"], outDir: emptyOut, clean: true });
      expect(fs.existsSync(path.join(emptyOut, PROJECTION_ROOT_MARKER_FILE))).toBe(true);

      // Extra junk inside an owned tree is still removable by --clean.
      fs.writeFileSync(path.join(emptyOut, "stray.txt"), "junk\n", "utf8");
      buildProjections({ sourceRoot, providers: ["codex"], outDir: emptyOut, clean: true });
      expect(fs.existsSync(path.join(emptyOut, "stray.txt"))).toBe(false);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("clean refuses unmanaged output dirs without deleting contents and non-clean builds do not adopt them", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-clean-unmanaged-"));
    try {
      const outDir = path.join(fixture, "out");
      fs.mkdirSync(outDir, { recursive: true });
      const sentinel = path.join(outDir, "keep-me.txt");
      fs.writeFileSync(sentinel, "user data\n", "utf8");

      expect(() => buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true })).toThrow(
        /Refusing to clean/,
      );
      expect(fs.readFileSync(sentinel, "utf8")).toBe("user data\n");

      buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: false });
      expect(fs.existsSync(path.join(outDir, PROJECTION_ROOT_MARKER_FILE))).toBe(false);

      fs.writeFileSync(
        path.join(outDir, PROJECTION_ROOT_MARKER_FILE),
        `${JSON.stringify({ schemaVersion: 99, tool: "other" }, null, 2)}\n`,
        "utf8",
      );
      expect(() => buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true })).toThrow(
        /Refusing to clean/,
      );
      expect(fs.existsSync(sentinel)).toBe(true);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  function snapshotTree(rootDir: string): Map<string, string> {
    const snapshots = new Map<string, string>();
    const stack = [rootDir];
    while (stack.length) {
      const current = stack.pop() as string;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`unexpected symlink in fixture tree: ${entryPath}`);
        }
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        const rel = path.relative(rootDir, entryPath).replaceAll("\\", "/");
        snapshots.set(rel, crypto.createHash("sha256").update(fs.readFileSync(entryPath)).digest("hex"));
      }
    }
    return snapshots;
  }

  function expectSameTree(before: Map<string, string>, after: Map<string, string>): void {
    expect(after.size).toBe(before.size);
    for (const [rel, digest] of before) {
      expect(after.get(rel)).toBe(digest);
    }
  }

  function projectionTempSiblingNames(parentDir: string): string[] {
    return fs
      .readdirSync(parentDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.name.startsWith(PROJECTION_STAGING_DIR_PREFIX) ||
          entry.name.startsWith(PROJECTION_BACKUP_DIR_PREFIX)
      )
      .map((entry) => entry.name);
  }

  test("staged --clean builds create missing output parent chains and leave no staging or backup siblings", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-clean-nested-"));
    try {
      const outDir = path.join(fixture, "deep", "nested", "out");
      buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      expect(fs.existsSync(path.join(outDir, "projection-manifest.json"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, PROJECTION_ROOT_MARKER_FILE))).toBe(true);

      // Rebuild over the existing managed tree (two-rename swap path) and
      // confirm success leaves zero temp siblings anywhere under the fixture.
      buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      expect(projectionTempSiblingNames(fixture)).toEqual([]);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("a build failure mid-render preserves the original managed tree and removes the staging sibling", () => {
    const sourceRoot = createProjectionMatrixSource();
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-clean-render-fail-"));
    try {
      const outDir = path.join(fixture, "out");
      // Establish a healthy managed tree first.
      buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      fs.writeFileSync(path.join(outDir, "previous-build.txt"), "keep\n", "utf8");
      const before = snapshotTree(outDir);

      // Corrupt one skill's metadata so a later render throws partway through.
      const badSkillDir = path.join(sourceRoot, "skills", "bad-skill");
      fs.mkdirSync(badSkillDir, { recursive: true });
      fs.writeFileSync(path.join(badSkillDir, "SKILL.md"), "---\nname: bad-skill\ndescription: broken\n---\n", "utf8");
      fs.writeFileSync(path.join(badSkillDir, "skill.meta.json"), "{ not valid json", "utf8");

      expect(() => buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true })).toThrow(/bad-skill/);
      expectSameTree(before, snapshotTree(outDir));
      expect(fs.existsSync(path.join(outDir, PROJECTION_ROOT_MARKER_FILE))).toBe(true);
      expect(projectionTempSiblingNames(fixture)).toEqual([]);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  test("injected second-rename failure restores the original tree byte-identically and leaves no swap siblings", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-clean-rename-inject-"));
    const realRenameSync = fs.renameSync;
    try {
      const outDir = path.join(fixture, "out");
      buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      fs.writeFileSync(path.join(outDir, "previous-build.txt"), "keep\n", "utf8");
      const before = snapshotTree(outDir);

      let armed = true;
      (fs as { renameSync: unknown }).renameSync = (...renameArgs: Parameters<typeof realRenameSync>) => {
        if (armed && String(renameArgs[1]) === outDir) {
          armed = false;
          throw new Error("injected rename failure");
        }
        return realRenameSync(...renameArgs);
      };
      let thrown: unknown = null;
      try {
        buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      } catch (error) {
        thrown = error;
      } finally {
        (fs as { renameSync: unknown }).renameSync = realRenameSync;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("original output restored");
      expect((thrown as Error).message).toContain("injected rename failure");
      expect(armed).toBe(false);
      expectSameTree(before, snapshotTree(outDir));
      expect(projectionTempSiblingNames(fixture)).toEqual([]);
    } finally {
      fs.renameSync = realRenameSync;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("injected backup cleanup failure keeps the new live output authoritative and guards residue", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-clean-backup-rm-inject-"));
    const realRmSync = fs.rmSync;
    try {
      const outDir = path.join(fixture, "out");
      buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      fs.writeFileSync(path.join(outDir, "previous-build.txt"), "keep\n", "utf8");

      // Reference build proving what the complete NEW tree must look like.
      const referenceDir = path.join(fixture, "reference-out");
      buildProjections({ sourceRoot, providers: ["codex"], outDir: referenceDir, clean: true });
      const reference = snapshotTree(referenceDir);

      let armed = true;
      const backupPrefix = path.join(fixture, PROJECTION_BACKUP_DIR_PREFIX);
      (fs as { rmSync: unknown }).rmSync = (...rmArgs: Parameters<typeof realRmSync>) => {
        if (armed && String(rmArgs[0]).startsWith(backupPrefix)) {
          armed = false;
          throw new Error("injected backup removal failure");
        }
        return realRmSync(...rmArgs);
      };
      let thrown: unknown = null;
      try {
        buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      } catch (error) {
        thrown = error;
      } finally {
        (fs as { rmSync: unknown }).rmSync = realRmSync;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("Failed to remove the replaced projection output backup");
      expect((thrown as Error).message).toContain("remains complete and authoritative");
      expect((thrown as Error).message).toContain("Manually remove the guarded backup residue");
      // Exactly one removal attempt: no retry could deepen a partial delete.
      expect(armed).toBe(false);

      // The NEW live output is complete and matches a fresh reference build;
      // the previous-build sentinel is gone and no backup residue was
      // promoted over it.
      const live = snapshotTree(outDir);
      expect(live.size).toBe(reference.size);
      // Manifest and marker carry generatedAt timestamps; compare presence
      // only and byte-compare everything else.
      const timestampedFiles = new Set(["projection-manifest.json", PROJECTION_ROOT_MARKER_FILE]);
      for (const [rel, digest] of reference) {
        if (timestampedFiles.has(rel)) {
          continue;
        }
        expect(live.get(rel), `live output mismatch at ${rel}`).toBe(digest);
      }
      for (const rel of timestampedFiles) {
        expect(live.has(rel), `live output missing ${rel}`).toBe(true);
      }
      expect(fs.existsSync(path.join(outDir, "previous-build.txt"))).toBe(false);

      // The old tree remains behind as guarded residue under our reserved
      // prefix; nothing else was left in the parent.
      const residues = fs
        .readdirSync(fixture, { withFileTypes: true })
        .filter((entry) => entry.name.startsWith(PROJECTION_BACKUP_DIR_PREFIX));
      expect(residues).toHaveLength(1);
      const residuePath = path.join(fixture, residues[0]!.name);
      expect((thrown as Error).message).toContain(residuePath);
      expect(fs.existsSync(path.join(residuePath, "previous-build.txt"))).toBe(true);
      expect(
        projectionTempSiblingNames(fixture).filter((name) => name.startsWith(PROJECTION_STAGING_DIR_PREFIX))
      ).toEqual([]);
      realRmSync(residuePath, { recursive: true, force: true });
      expect(projectionTempSiblingNames(fixture)).toEqual([]);
    } finally {
      fs.rmSync = realRmSync;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("backup cleanup failure never reuses the staging slot or appends discard notes", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-clean-double-inject-"));
    const realRmSync = fs.rmSync;
    try {
      const outDir = path.join(fixture, "out");
      buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      fs.writeFileSync(path.join(outDir, "previous-build.txt"), "keep\n", "utf8");

      // Backup removal fails once; staging removal would fail persistently if
      // anything ever tried to reuse the staging slot after the swap.
      const backupFailed = new Set<string>();
      const backupPrefix = path.join(fixture, PROJECTION_BACKUP_DIR_PREFIX);
      const stagingPrefix = path.join(fixture, PROJECTION_STAGING_DIR_PREFIX);
      (fs as { rmSync: unknown }).rmSync = (...rmArgs: Parameters<typeof realRmSync>) => {
        const target = String(rmArgs[0]);
        if (target.startsWith(stagingPrefix)) {
          throw new Error("injected staging removal failure");
        }
        if (target.startsWith(backupPrefix) && !backupFailed.has(target)) {
          backupFailed.add(target);
          throw new Error("injected backup removal failure");
        }
        return realRmSync(...rmArgs);
      };
      let thrown: unknown = null;
      try {
        buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
      } catch (error) {
        thrown = error;
      } finally {
        (fs as { rmSync: unknown }).rmSync = realRmSync;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("remains complete and authoritative");
      expect((thrown as Error).message).not.toContain("Discarded staged output remains");
      expect((thrown as Error).message).not.toContain("additional staging cleanup failure");
      expect((thrown as Error).message).not.toContain("original output restored");
      expect(backupFailed.size).toBe(1);

      // New live output stays complete at outDir; staging is vacated and no
      // residue exists beyond the single reported backup sibling.
      expect(fs.existsSync(path.join(outDir, "codex", "example-skill", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "projection-manifest.json"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, PROJECTION_ROOT_MARKER_FILE))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "previous-build.txt"))).toBe(false);
      expect(
        projectionTempSiblingNames(fixture).filter((name) => name.startsWith(PROJECTION_STAGING_DIR_PREFIX))
      ).toEqual([]);
      const residues = projectionTempSiblingNames(fixture).filter((name) =>
        name.startsWith(PROJECTION_BACKUP_DIR_PREFIX)
      );
      expect(residues).toHaveLength(1);
      realRmSync(path.join(fixture, residues[0]!), { recursive: true, force: true });
      expect(projectionTempSiblingNames(fixture)).toEqual([]);
    } finally {
      fs.rmSync = realRmSync;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
