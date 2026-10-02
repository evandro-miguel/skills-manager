#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unique } from "../lib/args.ts";
import { fileExists, readJson } from "../lib/files.ts";

const DEFAULT_GLOBAL_CORE_MANIFEST = path.resolve(__dirname, "..", "..", "globals", "core.json");

type GlobalCoreAppConfig = {
  targetPath?: string;
  targetEnv?: string;
  skills?: string[];
  skillSet?: string;
  skillSets?: string[];
  excludeSkills?: string[];
  extraSkills?: string[];
};

type GlobalCoreManifest = {
  apps?: Record<string, GlobalCoreAppConfig>;
  sets?: Record<string, string[]>;
  skills?: string[];
  defaultApps?: string[];
};

interface ResolveGlobalCoreAppOptions {
  allowedTargetRoots?: string[];
}

interface WslWindowsHomeDetectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
}

function isPathWithin(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || relative === "." || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function listDefaultAllowedTargetRoots(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, ".config", "opencode"),
    path.join(home, ".codex"),
    path.join(home, ".qwen"),
    path.join(home, ".gemini"),
    path.join(home, ".claude"),
  ];
  const windowsHome = detectWslWindowsHome();
  if (windowsHome) {
    roots.push(
      path.join(windowsHome, ".codex"),
      path.join(windowsHome, ".claude"),
      path.join(windowsHome, ".qwen"),
      path.join(windowsHome, ".gemini")
    );
  }
  return roots;
}

function assertNoSymlinkParents(targetPath: string): void {
  const root = path.parse(targetPath).root;
  let current = path.resolve(path.dirname(targetPath));

  while (true) {
    if (fileExists(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Global core target parent must not be a symlink: ${current}`);
    }
    if (current === root) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

function validateGlobalTargetPath(
  appName: string,
  targetPath: string,
  options: ResolveGlobalCoreAppOptions = {}
): string {
  const targetAbs = path.resolve(targetPath);
  const allowedRootsRaw = options.allowedTargetRoots?.length
    ? options.allowedTargetRoots
    : listDefaultAllowedTargetRoots();
  const allowedRoots = allowedRootsRaw.map((item) => path.resolve(String(expandHome(item))));
  const underAllowedRoot = allowedRoots.some((root) => isPathWithin(root, targetAbs));

  if (!underAllowedRoot) {
    throw new Error(
      `Global core app '${appName}' targetPath must stay inside allowed roots (${allowedRoots.join(
        ", "
      )}): ${targetAbs}`
    );
  }
  if (path.basename(targetAbs) !== "skills") {
    throw new Error(`Global core app '${appName}' targetPath must end with '/skills': ${targetAbs}`);
  }

  assertNoSymlinkParents(targetAbs);
  return targetAbs;
}

function expandHome(value: unknown): unknown {
  if (!value || typeof value !== "string") {
    return value;
  }
  if (value === "~windows" || value.startsWith("~windows/")) {
    const windowsHome = detectWslWindowsHome();
    if (!windowsHome) {
      throw new Error("Unable to resolve ~windows for global core targetPath");
    }
    return value === "~windows" ? windowsHome : path.join(windowsHome, value.slice("~windows/".length));
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function windowsPathToWsl(value: string): string | null {
  const match = value.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) {
    const wslMatch = value.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
    if (!wslMatch) return null;
    return path.posix.join("/mnt", wslMatch[1]!.toLowerCase(), wslMatch[2] || "");
  }
  const drive = match[1]!.toLowerCase();
  const rest = match[2]!.replace(/\\/g, "/");
  return path.posix.join("/mnt", drive, rest);
}

function splitPathEntries(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const isDriveLetterColon =
      character === ":" &&
      current.length === 1 &&
      /^[A-Za-z]$/.test(current) &&
      /[\\/]/.test(value[index + 1] || "");
    if (character === ";" || (character === path.delimiter && !isDriveLetterColon)) {
      if (current) {
        entries.push(current);
      }
      current = "";
      continue;
    }
    current += character;
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

function detectWslWindowsHome(options: WslWindowsHomeDetectionOptions = {}): string | null {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const exists = options.exists || fileExists;
  if (platform === "win32") {
    return os.homedir();
  }

  for (const key of ["WSL_WINDOWS_HOME", "WINDOWS_HOME", "USERPROFILE"]) {
    const value = env[key];
    if (!value) {
      continue;
    }
    const converted = windowsPathToWsl(value);
    if (converted && exists(converted)) {
      return converted;
    }
  }

  const pathValue = env.PATH || "";
  for (const entry of splitPathEntries(pathValue)) {
    const converted = windowsPathToWsl(entry);
    const profileMatch = converted?.match(/^\/mnt\/([a-z])\/Users\/([^/]+)(?:\/|$)/i);
    if (!profileMatch) continue;
    const profilePath = path.posix.join("/mnt", profileMatch[1]!.toLowerCase(), "Users", profileMatch[2]!);
    if (exists(profilePath)) {
      return profilePath;
    }
  }

  const usersRoot = "/mnt/c/Users";
  if (!exists(usersRoot)) {
    return null;
  }
  try {
    const candidate = fs
      .readdirSync(usersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(usersRoot, entry.name))
      .find((profilePath) => exists(path.join(profilePath, ".codex")));
    return candidate || null;
  } catch {
    return null;
  }
}

function readGlobalCoreManifest(
  manifestPath: string = DEFAULT_GLOBAL_CORE_MANIFEST
): { path: string; manifest: GlobalCoreManifest } {
  const resolvedPath = path.resolve(manifestPath);
  if (!fileExists(resolvedPath)) {
    throw new Error(`Global core manifest not found: ${resolvedPath}`);
  }

  const manifest = readJson<GlobalCoreManifest>(resolvedPath);
  if (!manifest.apps || typeof manifest.apps !== "object") {
    throw new Error(`Global core manifest must define "apps": ${resolvedPath}`);
  }
  if (manifest.sets && typeof manifest.sets !== "object") {
    throw new Error(`Global core manifest "sets" must be an object: ${resolvedPath}`);
  }
  if (!Array.isArray(manifest.skills) && !manifest.sets) {
    throw new Error(`Global core manifest must define "skills" or "sets": ${resolvedPath}`);
  }

  return {
    path: resolvedPath,
    manifest,
  };
}

function listGlobalCoreApps(manifest: GlobalCoreManifest): string[] {
  if (Array.isArray(manifest.defaultApps) && manifest.defaultApps.length) {
    return [...manifest.defaultApps];
  }
  const apps = manifest.apps || {};
  return Object.keys(apps).sort((a, b) => a.localeCompare(b));
}

function resolveSkillSets(manifest: GlobalCoreManifest, setNames: string | string[]): string[] {
  const names = Array.isArray(setNames) ? setNames : [setNames];
  const collected: string[] = [];

  for (const setName of names.filter(Boolean)) {
    const skills = manifest.sets?.[setName];
    if (!Array.isArray(skills) || !skills.length) {
      throw new Error(`Global core skill set "${setName}" is missing or empty`);
    }
    collected.push(...skills);
  }

  return collected;
}

function resolveGlobalCoreSkills(manifest: GlobalCoreManifest): string[] {
  const collected: string[] = [];

  if (Array.isArray(manifest.skills)) {
    collected.push(...manifest.skills);
  }
  for (const skills of Object.values(manifest.sets || {})) {
    if (Array.isArray(skills)) {
      collected.push(...skills);
    }
  }
  for (const appConfig of Object.values(manifest.apps || {})) {
    if (Array.isArray(appConfig.skills)) {
      collected.push(...appConfig.skills);
    }
    if (appConfig.skillSet) {
      collected.push(...resolveSkillSets(manifest, appConfig.skillSet));
    }
    if (appConfig.skillSets) {
      collected.push(...resolveSkillSets(manifest, appConfig.skillSets));
    }
    if (Array.isArray(appConfig.extraSkills)) {
      collected.push(...appConfig.extraSkills);
    }
  }

  return unique(collected);
}

function resolveGlobalCoreApp(
  manifest: GlobalCoreManifest,
  appName: string,
  options: ResolveGlobalCoreAppOptions = {}
): { app: string; skills: string[]; targetPath: string } {
  const appConfig = manifest.apps?.[appName];
  if (!appConfig) {
    throw new Error(`Global core app "${appName}" is not defined in manifest`);
  }
  if (!appConfig.targetPath || typeof appConfig.targetPath !== "string") {
    throw new Error(`Global core app "${appName}" is missing targetPath`);
  }
  const targetOverride =
    appConfig.targetEnv && process.env[appConfig.targetEnv]
      ? process.env[appConfig.targetEnv]
      : appConfig.targetPath;
  const baseSkills =
    Array.isArray(appConfig.skills) && appConfig.skills.length
      ? appConfig.skills
      : appConfig.skillSets
        ? resolveSkillSets(manifest, appConfig.skillSets)
        : appConfig.skillSet
          ? resolveSkillSets(manifest, appConfig.skillSet)
          : Array.isArray(manifest.skills)
            ? manifest.skills
            : [];

  const excluded = new Set(Array.isArray(appConfig.excludeSkills) ? appConfig.excludeSkills : []);
  const skills = unique([
    ...baseSkills,
    ...(Array.isArray(appConfig.extraSkills) ? appConfig.extraSkills : []),
  ]).filter((skillName) => !excluded.has(skillName));

  if (!skills.length) {
    throw new Error(`Global core app "${appName}" resolved to an empty skill list`);
  }

  return {
    app: appName,
    skills,
    targetPath: validateGlobalTargetPath(appName, String(expandHome(targetOverride)), options),
  };
}

export {
  DEFAULT_GLOBAL_CORE_MANIFEST,
  assertNoSymlinkParents,
  detectWslWindowsHome,
  expandHome,
  listGlobalCoreApps,
  listDefaultAllowedTargetRoots,
  readGlobalCoreManifest,
  resolveGlobalCoreApp,
  resolveGlobalCoreSkills,
  validateGlobalTargetPath,
};
