#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { unique } from "../../lib/args.ts";
import { fileExists, readJson } from "../../lib/files.ts";

interface SourceLayout {
  adaptersDir: string;
  profilesDir: string;
}

interface AdapterConfig {
  targetPath: string;
  [key: string]: unknown;
}

interface ProfileConfig {
  skills: string[];
  [key: string]: unknown;
}

interface InstallEntry {
  app?: unknown;
  profile?: unknown;
  skills?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSafeJsonPath(baseDir: string, name: unknown, label: string): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`Invalid ${label}: expected a non-empty string`);
  }

  const trimmed = name.trim();
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    throw new Error(`Invalid ${label} '${trimmed}': path separators are not allowed`);
  }

  return path.join(baseDir, `${trimmed}.json`);
}

function normalizeSafeRelativePath(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }

  const normalized = path.posix.normalize(raw.trim().replaceAll("\\", "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`${label} must stay within the project directory: '${raw}'`);
  }

  return normalized;
}

function isPathWithin(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || relative === "." || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveExistingRealPath(candidatePath: string): string {
  if (!fileExists(candidatePath)) {
    return path.resolve(candidatePath);
  }
  return fs.realpathSync.native(candidatePath);
}

function assertJsonFileWithinBase(baseDir: string, jsonPath: string, label: string): void {
  const baseAbs = path.resolve(baseDir);
  const jsonAbs = path.resolve(jsonPath);

  if (!isPathWithin(baseAbs, jsonAbs)) {
    throw new Error(`${label} must stay within ${baseAbs}: ${jsonAbs}`);
  }
  if (fileExists(jsonAbs) && fs.lstatSync(jsonAbs).isSymbolicLink()) {
    throw new Error(`Refusing to read symlinked ${label}: ${jsonAbs}`);
  }
  if (!isPathWithin(resolveExistingRealPath(baseAbs), resolveExistingRealPath(jsonAbs))) {
    throw new Error(`${label} must stay within ${baseAbs}: ${jsonAbs}`);
  }
}

function assertPathWithinProject(projectDir: string, targetPath: string, label: string): void {
  const projectAbs = path.resolve(projectDir);
  const targetAbs = path.resolve(targetPath);
  const relative = path.relative(projectAbs, targetAbs);

  if (relative === "" || relative === ".") {
    throw new Error(`${label} must not resolve to project root: ${targetAbs}`);
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay within project directory (${projectAbs}): ${targetAbs}`);
  }

  const projectReal = resolveExistingRealPath(projectAbs);
  if (!isPathWithin(projectReal, resolveExistingRealPath(targetAbs))) {
    throw new Error(`${label} must stay within project directory (${projectAbs}): ${targetAbs}`);
  }

  let currentPath = projectAbs;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    if (!fileExists(currentPath)) {
      continue;
    }
    if (!isPathWithin(projectReal, resolveExistingRealPath(currentPath))) {
      throw new Error(`${label} must stay within project directory (${projectAbs}): ${targetAbs}`);
    }
  }
}

function normalizeSkillName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`Invalid skill name: ${String(raw)}`);
  }
  const skillName = raw.trim();
  if (skillName.includes("/") || skillName.includes("\\") || skillName === "." || skillName === "..") {
    throw new Error(`Invalid skill name '${skillName}': path separators are not allowed`);
  }
  return skillName;
}

// Separators are already rejected above; a leading drive prefix is the remaining
// Windows-specific hazard (e.g. "C:" or "C:foo" is drive-relative on win32).
function normalizeSkillNameStrict(raw: unknown): string {
  const skillName = normalizeSkillName(raw);
  if (/^[a-zA-Z]:/.test(skillName)) {
    throw new Error(`Invalid skill name '${skillName}': Windows drive prefixes are not allowed`);
  }
  return skillName;
}

function readAdapter(layout: SourceLayout, app: unknown): AdapterConfig {
  const adapterPath = resolveSafeJsonPath(layout.adaptersDir, app, "app");
  if (!fileExists(adapterPath)) {
    throw new Error(`Adapter not found for app '${app}': ${adapterPath}`);
  }
  assertJsonFileWithinBase(layout.adaptersDir, adapterPath, `Adapter '${app}' file`);
  const adapterRaw = readJson(adapterPath);
  if (!isRecord(adapterRaw)) {
    throw new Error(`Adapter '${app}' must be a JSON object`);
  }
  if (typeof adapterRaw.targetPath !== "string" || !adapterRaw.targetPath.trim()) {
    throw new Error(`Adapter '${app}' missing required targetPath`);
  }
  return {
    ...adapterRaw,
    targetPath: normalizeSafeRelativePath(adapterRaw.targetPath, `Adapter '${app}' targetPath`),
  };
}

function readProfile(layout: SourceLayout, profileName: unknown): ProfileConfig {
  const profilePath = resolveSafeJsonPath(layout.profilesDir, profileName, "profile");
  if (!fileExists(profilePath)) {
    throw new Error(`Profile not found: ${profilePath}`);
  }
  assertJsonFileWithinBase(layout.profilesDir, profilePath, `Profile '${profileName}' file`);
  const profileRaw = readJson(profilePath);
  if (!isRecord(profileRaw)) {
    throw new Error(`Profile '${profileName}' must be a JSON object`);
  }
  if (!Array.isArray(profileRaw.skills)) {
    throw new Error(`Profile '${profileName}' must contain skills[]`);
  }
  return {
    ...profileRaw,
    skills: profileRaw.skills,
  };
}

function resolveSkillsForEntry(layout: SourceLayout, entry: InstallEntry): unknown[] {
  const profileSkills = entry.profile ? readProfile(layout, entry.profile).skills : [];
  const directSkills = Array.isArray(entry.skills) ? entry.skills : [];
  const merged = unique([...profileSkills, ...directSkills]).map((skillName) => normalizeSkillName(skillName));

  if (merged.length === 0) {
    throw new Error(`Install entry for app '${String(entry.app)}' resolved to zero skills`);
  }

  return merged;
}

export {
  assertPathWithinProject,
  normalizeSkillNameStrict,
  readAdapter,
  readProfile,
  resolveSkillsForEntry,
};
