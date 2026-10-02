import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileExists } from "../../lib/files.ts";
import { parseFrontmatter, stripQuotes } from "../skill-metadata-lib.ts";
import { readSkillMeta } from "./skill-meta.ts";

export type SkillOrigin = "public" | "user";

export interface SkillProjectionSource {
  origin: SkillOrigin;
  skillName: string;
  skillDir: string;
  rootDir: string;
  canonicalPath: string;
}

export function listSkillNames(skillsDir: string): string[] {
  if (!fileExists(skillsDir)) {
    return [];
  }
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function isRetiredProjectionSource(skillDir: string): boolean {
  // Eligibility must not read metadata through links before the build's
  // existing whole-tree symlink check runs.
  for (const name of ["SKILL.md", "skill.meta.json"]) {
    const filePath = path.join(skillDir, name);
    if (fs.lstatSync(filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Refusing to read symlinked projection source metadata: ${filePath}`);
    }
  }
  if (readSkillMeta(skillDir).lifecycle === "deprecated") return true;
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fileExists(skillFile)) return false;
  const parsed = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
  if (!parsed.ok) return false;
  for (const fields of [parsed.top, parsed.metadata]) {
    if (stripQuotes(fields.category ?? "").trim().toLowerCase() === "compatibility") return true;
    for (const key of ["deprecated", "archived", "compatibility_only"]) {
      if (["true", "1", "yes", "on"].includes(stripQuotes(fields[key] ?? "").trim().toLowerCase())) return true;
    }
  }
  return false;
}

function assertRealDirectory(dirPath: string, label: string): void {
  if (!fileExists(dirPath)) {
    throw new Error(
      `${label} not found: ${dirPath}. Create the directory or pass --user-root <dir>.`
    );
  }
  const linkStat = fs.lstatSync(dirPath);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked ${label}: ${dirPath}`);
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    throw new Error(`${label} is not a directory: ${dirPath}`);
  }
}

function defaultUserRoot(): string {
  if (process.env.SKILL_SYS_USER_ROOT) {
    return process.env.SKILL_SYS_USER_ROOT;
  }

  const homeDir = os.homedir();
  if (!homeDir) {
    throw new Error(
      "Cannot resolve user skill root: no home directory is available. " +
        "Set SKILL_SYS_USER_ROOT or pass --user-root <dir>."
    );
  }

  return path.join(homeDir, ".skill-sys");
}

function resolveUserSkillsDir(userRoot?: string): { rootDir: string; skillsDir: string } {
  const rootDir = path.resolve(userRoot || defaultUserRoot());
  assertRealDirectory(rootDir, "User skill root");
  const skillsDir = path.join(rootDir, "skills");
  assertRealDirectory(skillsDir, "User skills directory");
  return { rootDir, skillsDir };
}

export function collectSkillProjectionSources(
  publicSkillsDir: string,
  poolRoot: string,
  options: { includeUser?: boolean; userRoot?: string }
): SkillProjectionSource[] {
  const sources: SkillProjectionSource[] = listSkillNames(publicSkillsDir).map((skillName) => {
    const skillDir = path.join(publicSkillsDir, skillName);
    return {
      origin: "public" as const,
      skillName,
      skillDir,
      rootDir: poolRoot,
      canonicalPath: path.relative(poolRoot, skillDir).replaceAll("\\", "/"),
    };
  }).filter((source) => !isRetiredProjectionSource(source.skillDir));

  if (options.includeUser) {
    const user = resolveUserSkillsDir(options.userRoot);
    for (const skillName of listSkillNames(user.skillsDir)) {
      if (isRetiredProjectionSource(path.join(user.skillsDir, skillName))) continue;
      if (sources.some((source) => source.skillName === skillName)) {
        throw new Error(`Duplicate skill '${skillName}' found in public and user skill roots`);
      }
      sources.push({
        origin: "user",
        skillName,
        skillDir: path.join(user.skillsDir, skillName),
        rootDir: user.rootDir,
        canonicalPath: `user:skills/${skillName}`,
      });
    }
  }

  return sources.sort((a, b) => a.skillName.localeCompare(b.skillName) || a.origin.localeCompare(b.origin));
}

export function originsForSources(sources: SkillProjectionSource[]): SkillOrigin[] {
  const origins: SkillOrigin[] = [];
  for (const origin of ["public", "user"] as const) {
    if (sources.some((source) => source.origin === origin)) {
      origins.push(origin);
    }
  }
  return origins;
}
