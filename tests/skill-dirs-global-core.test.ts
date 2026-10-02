import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  copyLifecycleLedger,
  copySkillDirectory,
  isSkillDir,
  listSkillDirs,
  removeExtraSkills,
} from "../scripts/lib/skill-dirs.ts";
import {
  expandHome,
  detectWslWindowsHome,
  listDefaultAllowedTargetRoots,
  listGlobalCoreApps,
  readGlobalCoreManifest,
  resolveGlobalCoreApp,
  resolveGlobalCoreSkills,
  validateGlobalTargetPath,
} from "../scripts/modules/global-core.ts";

const tempDirs: string[] = [];
const posixSeparator = String.fromCharCode(47);
const windowsSeparator = String.fromCharCode(92);

function posixPath(...segments: string[]): string {
  return `${posixSeparator}${segments.join(posixSeparator)}`;
}

function windowsPath(...segments: string[]): string {
  return segments.join(windowsSeparator);
}

function tempRoot(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, body = `---\nname: fixture\ndescription: Use when testing.\nmetadata: {}\n---\n# Fixture\n`): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  return dir;
}

function writeManifest(root: string, manifest: unknown): string {
  const file = path.join(root, "core.json");
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("skill directory and global core contracts", () => {
  test("lists only real skill directories with SKILL.md and ignores hidden, files, missing manifests, and symlinks", () => {
    const root = tempRoot("skill-dirs");
    writeSkill(root, "alpha");
    writeSkill(root, "beta");
    fs.mkdirSync(path.join(root, "no-skill-md"));
    fs.writeFileSync(path.join(root, "plain-file"), "not a directory");
    writeSkill(root, ".hidden");
    fs.symlinkSync(path.join(root, "alpha"), path.join(root, "linked-skill"));

    expect(isSkillDir(root, "alpha")).toBe(true);
    expect(isSkillDir(root, "no-skill-md")).toBe(false);
    expect(isSkillDir(root, "linked-skill")).toBe(false);
    expect(listSkillDirs(root)).toEqual(["alpha", "beta"]);
    expect(listSkillDirs(path.join(root, "missing"))).toEqual([]);
  });

  test("copies skills while skipping local runtime files and removes extras only outside dry-run", () => {
    const root = tempRoot("skill-copy");
    const src = writeSkill(root, "source");
    fs.mkdirSync(path.join(src, "nested"));
    fs.writeFileSync(path.join(src, "nested", "note.md"), "kept");
    fs.mkdirSync(path.join(src, ".git"));
    fs.writeFileSync(path.join(src, ".git", "config"), "skip me");
    const destRoot = path.join(root, "dest");
    const dest = path.join(destRoot, "source");

    copySkillDirectory(src, dest);

    expect(fs.existsSync(path.join(dest, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "nested", "note.md"))).toBe(true);
    expect(fs.existsSync(path.join(dest, ".git", "config"))).toBe(false);

    writeSkill(destRoot, "extra");
    expect(removeExtraSkills(["source"], destRoot, true)).toEqual(["extra"]);
    expect(fs.existsSync(path.join(destRoot, "extra"))).toBe(true);
    expect(removeExtraSkills(["source"], destRoot, false)).toEqual(["extra"]);
    expect(fs.existsSync(path.join(destRoot, "extra"))).toBe(false);
  });

  test("copies lifecycle ledger next to a skills root and dry-run reports destination without writing", () => {
    const root = tempRoot("skill-ledger");
    const skillsRoot = path.join(root, "skills");
    fs.mkdirSync(skillsRoot);
    fs.writeFileSync(path.join(root, "skill-lifecycle.json"), JSON.stringify({ skills: [] }));
    const destRoot = path.join(root, "dest");

    const dryRunDest = copyLifecycleLedger(skillsRoot, destRoot, true);
    expect(dryRunDest).toBe(path.join(destRoot, ".skill-lifecycle.json"));
    expect(fs.existsSync(dryRunDest!)).toBe(false);

    const writtenDest = copyLifecycleLedger(skillsRoot, destRoot, false);
    expect(writtenDest).toBe(path.join(destRoot, ".skill-lifecycle.json"));
    expect(JSON.parse(fs.readFileSync(writtenDest!, "utf8"))).toEqual({ skills: [] });
    expect(copyLifecycleLedger(path.join(root, "missing-ledger", "skills"), destRoot, false)).toBeNull();
  });

  test("reads global-core manifest, app defaults, set expansion, exclusions, and target env override safely", () => {
    const root = tempRoot("global-core-manifest");
    const allowedRoot = path.join(root, "home", ".codex");
    const targetFromManifest = path.join(allowedRoot, "skills");
    const envTarget = path.join(root, "home", ".config", "opencode", "skills");
    process.env.GLOBAL_CORE_TEST_TARGET = envTarget;

    const manifestFile = writeManifest(root, {
      defaultApps: ["codex"],
      skills: ["base", "shared"],
      sets: {
        critical: ["critical-a", "critical-b"],
      },
      apps: {
        codex: {
          targetPath: targetFromManifest,
          skillSet: "critical",
          extraSkills: ["shared", "codex-extra"],
          excludeSkills: ["critical-b"],
        },
        opencode: {
          targetPath: targetFromManifest,
          targetEnv: "GLOBAL_CORE_TEST_TARGET",
          skills: ["opencode-only"],
        },
      },
    });

    const { path: resolvedPath, manifest } = readGlobalCoreManifest(manifestFile);
    expect(resolvedPath).toBe(manifestFile);
    expect(listGlobalCoreApps(manifest)).toEqual(["codex"]);
    expect(resolveGlobalCoreSkills(manifest)).toEqual([
      "base",
      "shared",
      "critical-a",
      "critical-b",
      "codex-extra",
      "opencode-only",
    ]);
    expect(resolveGlobalCoreApp(manifest, "codex", { allowedTargetRoots: [allowedRoot] })).toEqual({
      app: "codex",
      skills: ["critical-a", "shared", "codex-extra"],
      targetPath: targetFromManifest,
    });
    expect(resolveGlobalCoreApp(manifest, "opencode", { allowedTargetRoots: [path.dirname(envTarget)] }).targetPath).toBe(envTarget);

    delete process.env.GLOBAL_CORE_TEST_TARGET;
  });

  test("global-core fails closed for traversal, wrong basename, symlink parents, missing sets, and malformed manifests", () => {
    const root = tempRoot("global-core-guards");
    const allowedRoot = path.join(root, "home", ".codex");
    const goodTarget = path.join(allowedRoot, "skills");
    fs.mkdirSync(path.join(root, "real-parent"), { recursive: true });
    fs.symlinkSync(path.join(root, "real-parent"), path.join(root, "linked-parent"));

    expect(validateGlobalTargetPath("codex", goodTarget, { allowedTargetRoots: [allowedRoot] })).toBe(goodTarget);
    expect(() => validateGlobalTargetPath("codex", path.join(root, "outside", "skills"), { allowedTargetRoots: [allowedRoot] })).toThrow("allowed roots");
    expect(() => validateGlobalTargetPath("codex", path.join(allowedRoot, "not-skills"), { allowedTargetRoots: [allowedRoot] })).toThrow("must end with '/skills'");
    expect(() => validateGlobalTargetPath("codex", path.join(root, "linked-parent", "skills"), { allowedTargetRoots: [root] })).toThrow("must not be a symlink");

    const manifestFile = writeManifest(root, { apps: { codex: { targetPath: goodTarget, skillSet: "missing" } }, sets: {} });
    const { manifest } = readGlobalCoreManifest(manifestFile);
    expect(() => resolveGlobalCoreApp(manifest, "codex", { allowedTargetRoots: [allowedRoot] })).toThrow("missing or empty");
    expect(() => resolveGlobalCoreApp(manifest, "unknown", { allowedTargetRoots: [allowedRoot] })).toThrow("not defined");

    expect(() => readGlobalCoreManifest(path.join(root, "missing.json"))).toThrow("manifest not found");
    expect(() => readGlobalCoreManifest(writeManifest(root, { skills: [] }))).toThrow('must define "apps"');
    expect(() => readGlobalCoreManifest(writeManifest(root, { apps: {}, skills: [] }))).not.toThrow();
    expect(expandHome("~/skills")).toBe(path.join(os.homedir(), "skills"));
  });

  test("detects WSL Windows homes across drive case, spaces, missing mounts, and PATH entries", () => {
    const aliceWslHome = posixPath("mnt", "d", "Users", "Alice Smith");
    const existing = new Set([aliceWslHome]);
    const options = {
      platform: "linux" as NodeJS.Platform,
      exists: (candidate: string) => existing.has(candidate),
    };
    expect(detectWslWindowsHome({ ...options, env: { WSL_WINDOWS_HOME: windowsPath("D:", "Users", "Alice Smith") } })).toBe(aliceWslHome);
    expect(
      detectWslWindowsHome({
        ...options,
        env: {
          WSL_WINDOWS_HOME: windowsPath("D:", "Users", "Missing"),
          PATH: [
            posixPath("usr", "bin"),
            posixPath("mnt", "D", "Users", "Alice Smith", ".local", "bin"),
            posixPath("bin"),
          ].join(path.delimiter),
        },
      }),
    ).toBe(aliceWslHome);
    expect(
      detectWslWindowsHome({
        ...options,
        env: { PATH: `${posixPath("opt", "mnt", "d", "Users", "Alice Smith", "bin")}${path.delimiter}${posixPath("usr", "bin")}` },
      }),
    ).toBeNull();
  });

  test("covers native Windows, ~windows expansion, PATH delimiter boundaries, and the Users fallback", () => {
    expect(detectWslWindowsHome({ platform: "win32", env: {}, exists: () => false })).toBe(os.homedir());

    const aliceWslHome = posixPath("mnt", "d", "Users", "Alice Smith");
    const existing = new Set([aliceWslHome]);
    const options = {
      platform: "linux" as NodeJS.Platform,
      exists: (candidate: string) => existing.has(candidate),
    };
    expect(
      detectWslWindowsHome({
        ...options,
        env: {
          PATH: [
            windowsPath("D:", "Users", "Alice Smith", "bin"),
            windowsPath("C:", "Users", "Other", "bin"),
          ].join(";"),
        },
      }),
    ).toBe(aliceWslHome);
    expect(
      detectWslWindowsHome({
        ...options,
        env: { PATH: `${posixPath("mnt", "d", "Users", "Alice Smith2", "bin")}${path.delimiter}${posixPath("usr", "bin")}` },
      }),
    ).toBeNull();
    expect(
      detectWslWindowsHome({
        ...options,
        env: { PATH: `${posixPath("opt", "mnt", "d", "Users", "Alice Smith", "bin")};${posixPath("usr", "bin")}` },
      }),
    ).toBeNull();

    const windowsProfile = detectWslWindowsHome({
      platform: "linux",
      env: {},
      exists: (candidate) => candidate === posixPath("mnt", "c", "Users") || candidate.endsWith(`${posixSeparator}.codex`),
    });
    if (windowsProfile) {
      const previous = process.env.WSL_WINDOWS_HOME;
      process.env.WSL_WINDOWS_HOME = windowsProfile;
      try {
        expect(expandHome("~windows")).toBe(windowsProfile);
        expect(expandHome("~windows/skills")).toBe(path.join(windowsProfile, "skills"));
      } finally {
        if (previous === undefined) {
          delete process.env.WSL_WINDOWS_HOME;
        } else {
          process.env.WSL_WINDOWS_HOME = previous;
        }
      }
    }

    expect(listDefaultAllowedTargetRoots()).toContain(path.join(os.homedir(), ".codex"));
  });
});
