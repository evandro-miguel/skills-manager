#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SKIP_ENTRY_NAMES, fileExists, hashFile, listFilesRecursive, readJson } from "../../lib/files.ts";

const PUBLIC_SURFACE_SKIP_ENTRY_NAMES = new Set([
  ...DEFAULT_SKIP_ENTRY_NAMES,
  ".skill-sys-backup",
  ".skill-sys-tmp",
  ".skills.state.json",
]);

export interface PublicSurfaceFile {
  version: 1;
  requiredDirectories?: string[];
  requiredFiles?: string[];
  /** Deprecated alias for forbiddenInArtifactPaths. */
  forbiddenPaths?: string[];
  forbiddenInArtifactPaths?: string[];
  forbiddenInSourcePaths?: string[];
  allowedInForbiddenSourcePaths?: string[];
  denyUntrackedCriticalSurfaces?: boolean;
}

export interface ResolvedPublicSurface {
  includePaths: string[];
  /** Deprecated compatibility alias for artifact-level forbidden paths. */
  forbiddenPaths: string[];
  forbiddenInArtifactPaths: string[];
  forbiddenInSourcePaths: string[];
  allowedInForbiddenSourcePaths: string[];
  denyUntrackedCriticalSurfaces: boolean;
  scanned: string;
  surfacePath?: string;
}

const CRITICAL_PUBLIC_DIRECTORIES = [
  "skills",
  "adapters",
  "profiles",
  "providers",
  "overlays",
  "schema",
  "scripts/commands",
  "scripts/modules",
  "scripts/lib",
  "scripts/bin",
  "scripts/ops",
];

const CRITICAL_PUBLIC_FILES = [
  "artifact-surface.json",
  "package.json",
  "index.json",
  "skill-lifecycle.json",
  "globals/core.json",
  "SKILLS.json",
  "SKILLS.md",
  "bun.lock",
];

export interface PublicSurfacePacklistEntry {
  path: string;
  absolutePath: string;
  bytes: number;
  sha256: string;
}

export interface PublicSurfacePacklist {
  surface: string;
  surfacePath?: string;
  files: PublicSurfacePacklistEntry[];
  fileCount: number;
  totalBytes: number;
  digest: string;
}

function toPosixRelative(root: string, targetPath: string): string {
  return path.relative(root, targetPath).split(path.sep).join("/") || path.basename(targetPath);
}

function normalizeSurfaceSpec(source: string, surface: string): string {
  const trimmed = surface.trim();
  if (!trimmed) {
    throw new Error("Surface must be a non-empty value");
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  if (trimmed.endsWith(".json") || trimmed.includes("/") || trimmed.includes("\\")) {
    return path.resolve(source, trimmed);
  }
  return path.resolve(source, "artifact-surfaces", `${trimmed}.json`);
}

function normalizeSurfaceEntries(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const seen = new Set<string>();
  const output: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${label}[${index}] must be a non-empty string`);
    }
    const normalized = path.posix.normalize(item.trim().replaceAll("\\", "/"));
    if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      throw new Error(`${label}[${index}] must be a relative path inside the source root`);
    }
    if (seen.has(normalized)) {
      throw new Error(`${label} contains duplicate path: ${normalized}`);
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizeForbiddenSourceExceptions(value: unknown): string[] {
  const label = "surface.allowedInForbiddenSourcePaths";
  const entries = normalizeSurfaceEntries(value, label);
  for (const [index, entry] of entries.entries()) {
    const wildcardIndex = entry.indexOf("*");
    if (wildcardIndex >= 0 && !(entry.endsWith("/**") && wildcardIndex === entry.length - 2)) {
      throw new Error(`${label}[${index}] may use a wildcard only as a trailing /** subtree`);
    }
    const basePath = entry.endsWith("/**") ? entry.slice(0, -3) : entry;
    if (!basePath || basePath === ".") {
      throw new Error(`${label}[${index}] must identify a path below a forbidden source root`);
    }
  }
  return entries;
}

function assertForbiddenSourceExceptions(
  exceptions: string[],
  forbiddenInSourcePaths: string[]
): void {
  for (const exception of exceptions) {
    const basePath = exception.endsWith("/**") ? exception.slice(0, -3) : exception;
    if (!forbiddenInSourcePaths.some((forbiddenPath) => basePath.startsWith(`${forbiddenPath}/`))) {
      throw new Error(
        `surface.allowedInForbiddenSourcePaths entry must be below a forbiddenInSourcePaths root: ${exception}`
      );
    }
  }
}

function mergeUniqueSurfaceEntries(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item)) {
        continue;
      }
      seen.add(item);
      output.push(item);
    }
  }
  return output;
}

function assertSafeResolvedPath(source: string, candidatePath: string, label: string): void {
  const sourceAbs = path.resolve(source);
  const candidateAbs = path.resolve(candidatePath);
  const relative = path.relative(sourceAbs, candidateAbs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside source root: ${candidateAbs}`);
  }
  if (fs.lstatSync(candidateAbs).isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked ${label}: ${candidateAbs}`);
  }
}

function collectCandidateFiles(source: string, relativePath: string): string[] {
  const absolutePath = path.resolve(source, relativePath);
  if (!fileExists(absolutePath)) {
    throw new Error(`Surface required path not found: ${relativePath}`);
  }
  assertSafeResolvedPath(source, absolutePath, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    return listFilesRecursive(absolutePath, { skipNames: PUBLIC_SURFACE_SKIP_ENTRY_NAMES });
  }
  if (stat.isFile()) {
    return [absolutePath];
  }
  throw new Error(`Surface required path is neither a file nor directory: ${relativePath}`);
}

function uniqueSortedFiles(filePaths: string[]): string[] {
  return [...new Set(filePaths.map((filePath) => path.resolve(filePath)))].sort((a, b) => a.localeCompare(b));
}

function pathMatchesRule(candidate: string, rule: string): boolean {
  return candidate === rule || candidate.startsWith(`${rule}/`) || rule.startsWith(`${candidate}/`);
}

function pathIsForbidden(candidate: string, forbiddenPaths: string[]): boolean {
  return forbiddenPaths.some((forbiddenPath) => candidate === forbiddenPath || candidate.startsWith(`${forbiddenPath}/`));
}

function assertCriticalSurfaceCoverage(
  sourceRoot: string,
  includePaths: string[],
  forbiddenPaths: string[],
  denyUntrackedCriticalSurfaces: boolean
): void {
  if (!denyUntrackedCriticalSurfaces) {
    return;
  }
  const rules = [...includePaths, ...forbiddenPaths];
  for (const candidate of CRITICAL_PUBLIC_DIRECTORIES) {
    const absolutePath = path.resolve(sourceRoot, candidate);
    if (!fileExists(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
      continue;
    }
    if (!rules.some((rule) => pathMatchesRule(candidate, rule))) {
      throw new Error(`Critical public surface directory is neither included nor forbidden: ${candidate}`);
    }
  }
  for (const candidate of CRITICAL_PUBLIC_FILES) {
    const absolutePath = path.resolve(sourceRoot, candidate);
    if (!fileExists(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      continue;
    }
    if (!rules.some((rule) => pathMatchesRule(candidate, rule))) {
      throw new Error(`Critical public surface file is neither included nor forbidden: ${candidate}`);
    }
  }
}

function assertNoForbiddenFiles(files: string[], sourceRoot: string, forbiddenPaths: string[]): void {
  if (!forbiddenPaths.length) {
    return;
  }
  for (const absolutePath of files) {
    const relativePath = toPosixRelative(sourceRoot, absolutePath);
    if (pathIsForbidden(relativePath, forbiddenPaths)) {
      throw new Error(`Surface includes forbidden path: ${relativePath}`);
    }
  }
}


export function resolvePublicSurface(source: string, surface?: string): ResolvedPublicSurface {
  const sourceRoot = path.resolve(source);
  if (!fileExists(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`Surface source not found or not a directory: ${sourceRoot}`);
  }
  if (fs.lstatSync(sourceRoot).isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked surface source: ${sourceRoot}`);
  }

  if (!surface) {
    return {
      includePaths: ["."],
      forbiddenPaths: [],
      forbiddenInArtifactPaths: [],
      forbiddenInSourcePaths: [],
      allowedInForbiddenSourcePaths: [],
      denyUntrackedCriticalSurfaces: false,
      scanned: ".",
    };
  }

  const surfacePath = normalizeSurfaceSpec(sourceRoot, surface);
  if (!fileExists(surfacePath)) {
    throw new Error(`Surface not found: ${surfacePath}`);
  }
  assertSafeResolvedPath(sourceRoot, surfacePath, "surface file");
  const parsed = readJson<PublicSurfaceFile>(surfacePath);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Surface must be an object: ${surfacePath}`);
  }
  if (parsed.version !== 1) {
    throw new Error(`surface.version must be 1: ${surfacePath}`);
  }
  const includePaths = [
    ...normalizeSurfaceEntries(parsed.requiredDirectories, "surface.requiredDirectories"),
    ...normalizeSurfaceEntries(parsed.requiredFiles, "surface.requiredFiles"),
  ];
  if (!includePaths.length) {
    throw new Error(`Surface does not include any requiredDirectories or requiredFiles: ${surfacePath}`);
  }
  for (const includePath of includePaths) {
    const absolutePath = path.resolve(sourceRoot, includePath);
    if (!fileExists(absolutePath)) {
      throw new Error(`Surface required path not found: ${includePath}`);
    }
    assertSafeResolvedPath(sourceRoot, absolutePath, includePath);
  }
  const legacyForbiddenPaths = normalizeSurfaceEntries(parsed.forbiddenPaths, "surface.forbiddenPaths");
  const forbiddenInArtifactPaths = mergeUniqueSurfaceEntries(
    normalizeSurfaceEntries(parsed.forbiddenInArtifactPaths, "surface.forbiddenInArtifactPaths"),
    legacyForbiddenPaths
  );
  const forbiddenInSourcePaths = normalizeSurfaceEntries(parsed.forbiddenInSourcePaths, "surface.forbiddenInSourcePaths");
  const allowedInForbiddenSourcePaths = normalizeForbiddenSourceExceptions(parsed.allowedInForbiddenSourcePaths);
  assertForbiddenSourceExceptions(allowedInForbiddenSourcePaths, forbiddenInSourcePaths);
  const denyUntrackedCriticalSurfaces = parsed.denyUntrackedCriticalSurfaces === true;
  assertCriticalSurfaceCoverage(
    sourceRoot,
    includePaths,
    mergeUniqueSurfaceEntries(forbiddenInArtifactPaths, forbiddenInSourcePaths),
    denyUntrackedCriticalSurfaces
  );
  return {
    includePaths,
    forbiddenPaths: forbiddenInArtifactPaths,
    forbiddenInArtifactPaths,
    forbiddenInSourcePaths,
    allowedInForbiddenSourcePaths,
    denyUntrackedCriticalSurfaces,
    scanned: toPosixRelative(sourceRoot, surfacePath),
    surfacePath,
  };
}

export function collectPublicSurfacePacklist(source: string, surface?: string): PublicSurfacePacklist {
  const sourceRoot = path.resolve(source);
  const resolved = resolvePublicSurface(sourceRoot, surface);
  const filePaths = uniqueSortedFiles(
    resolved.includePaths.flatMap((relativePath) => collectCandidateFiles(sourceRoot, relativePath))
  );
  assertNoForbiddenFiles(filePaths, sourceRoot, resolved.forbiddenPaths);
  const files = filePaths.map((absolutePath) => {
    const stat = fs.statSync(absolutePath);
    return {
      path: toPosixRelative(sourceRoot, absolutePath),
      absolutePath,
      bytes: stat.size,
      sha256: hashFile(absolutePath),
    };
  });
  const manifest = files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`).join("\n");
  const digest = crypto.createHash("sha256").update(manifest).digest("hex");
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  return {
    surface: resolved.scanned,
    ...(resolved.surfacePath ? { surfacePath: toPosixRelative(sourceRoot, resolved.surfacePath) } : {}),
    files,
    fileCount: files.length,
    totalBytes,
    digest,
  };
}
