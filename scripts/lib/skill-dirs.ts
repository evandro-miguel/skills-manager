#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

import {
  copyDirectory,
  DEFAULT_SKIP_ENTRY_NAMES,
  ensureDir,
  fileExists,
} from "./files";

export const LIFECYCLE_FILE = "skill-lifecycle.json";
export const INSTALLED_LIFECYCLE_FILE = ".skill-lifecycle.json";

type SkillCopyOptions = {
  dryRun?: boolean;
  skipNames?: Iterable<string> | Set<string>;
};

export function isSkillDir(rootDir: string, entryName: string): boolean {
  const skillDir = path.join(rootDir, entryName);
  if (!fileExists(skillDir)) {
    return false;
  }

  const entryStat = fs.lstatSync(skillDir);
  if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
    return false;
  }

  const rootReal = fs.realpathSync.native(rootDir);
  const skillReal = fs.realpathSync.native(skillDir);
  const relative = path.relative(rootReal, skillReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  return (
    fileExists(path.join(skillDir, "SKILL.md"))
  );
}

export function listSkillDirs(rootDir: string): string[] {
  if (!fileExists(rootDir)) {
    return [];
  }

  return fs
    .readdirSync(rootDir)
    .filter((entryName) => !entryName.startsWith("."))
    .filter((entryName) => isSkillDir(rootDir, entryName))
    .sort((a, b) => a.localeCompare(b));
}

export function copySkillDirectory(srcDir: string, destDir: string, options: SkillCopyOptions = {}): void {
  copyDirectory(srcDir, destDir, {
    dryRun: options.dryRun === true,
    skipNames: options.skipNames || DEFAULT_SKIP_ENTRY_NAMES,
  });
}

export function removeExtraSkills(expectedSkills: string[], destRoot: string, dryRun: boolean): string[] {
  if (!fileExists(destRoot)) {
    return [];
  }

  const expected = new Set(expectedSkills);
  const removed: string[] = [];
  for (const skillName of listSkillDirs(destRoot)) {
    if (!expected.has(skillName)) {
      removed.push(skillName);
      if (!dryRun) {
        fs.rmSync(path.join(destRoot, skillName), { recursive: true, force: true });
      }
    }
  }

  return removed;
}

export function resolveLifecycleSource(skillsRoot: string): string | null {
  const candidate = path.join(path.dirname(skillsRoot), LIFECYCLE_FILE);
  return fileExists(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
}

export function copyLifecycleLedger(sourceSkillsRoot: string, destRoot: string, dryRun: boolean): string | null {
  const source = resolveLifecycleSource(sourceSkillsRoot);
  if (!source) {
    return null;
  }

  const dest = path.join(destRoot, INSTALLED_LIFECYCLE_FILE);
  if (!dryRun) {
    ensureDir(destRoot);
    fs.copyFileSync(source, dest);
  }
  return dest;
}
