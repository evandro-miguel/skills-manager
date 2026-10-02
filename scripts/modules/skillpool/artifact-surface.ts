#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { fileExists, readJson } from "../../lib/files.ts";

const ARTIFACT_SURFACE_FILE = "artifact-surface.json";

const DEFAULT_REQUIRED_DIRECTORIES = [
  "skills",
  "adapters",
  "profiles",
  "schema",
  "scripts/commands",
  "scripts/modules",
  "scripts/lib",
  "scripts/bin",
  "scripts/ops",
];

const DEFAULT_REQUIRED_FILES = [
  ARTIFACT_SURFACE_FILE,
  "package.json",
  "index.json",
  "skill-lifecycle.json",
  "globals/core.json",
  "SKILLS.json",
  "SKILLS.md",
  "bun.lock",
];

const CRITICAL_DIRECTORY_CANDIDATES = [
  ...DEFAULT_REQUIRED_DIRECTORIES,
  "providers",
  "overlays",
];

const CRITICAL_FILE_CANDIDATES = DEFAULT_REQUIRED_FILES;

interface SourceLayoutLike {
  skillsDir: string;
  adaptersDir: string;
  profilesDir: string;
}

interface ArtifactSurface {
  $schema?: string;
  version: 1;
  requiredDirectories: string[];
  requiredFiles: string[];
  forbiddenPaths?: string[];
  denyUntrackedCriticalSurfaces: boolean;
}

interface LoadedArtifactSurface {
  surface: ArtifactSurface;
  surfacePath: string;
  loadedFromFile: boolean;
}

interface ArtifactSurfaceDirectoryEntry {
  path: string;
  absolutePath: string;
}

interface ArtifactSurfaceFileEntry {
  path: string;
  absolutePath: string;
}

interface ResolvedArtifactSurfaceEntries {
  surface: ArtifactSurface;
  surfacePath: string;
  loadedFromFile: boolean;
  directories: ArtifactSurfaceDirectoryEntry[];
  files: ArtifactSurfaceFileEntry[];
}

function defaultArtifactSurface(): ArtifactSurface {
  return {
    version: 1,
    requiredDirectories: [...DEFAULT_REQUIRED_DIRECTORIES],
    requiredFiles: [...DEFAULT_REQUIRED_FILES],
    denyUntrackedCriticalSurfaces: true,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty relative path string`);
  }
  const raw = value.trim().replaceAll("\\", "/");
  const normalized = path.posix.normalize(raw);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`${label} must be a relative path inside the source package: ${value}`);
  }
  return normalized;
}

function normalizePathList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const seen = new Set<string>();
  const output: string[] = [];
  for (const [index, item] of value.entries()) {
    const normalized = normalizeRelativePath(item, `${label}[${index}]`);
    if (seen.has(normalized)) {
      throw new Error(`${label} contains duplicate path: ${normalized}`);
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizeArtifactSurface(value: unknown, label: string): ArtifactSurface {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  const surface = value as Record<string, unknown>;
  if (surface.version !== 1) {
    throw new Error(`${label}.version must be 1`);
  }
  if (typeof surface.denyUntrackedCriticalSurfaces !== "boolean") {
    throw new Error(`${label}.denyUntrackedCriticalSurfaces must be boolean`);
  }
  return {
    ...(typeof surface.$schema === "string" ? { $schema: surface.$schema } : {}),
    version: 1,
    requiredDirectories: normalizePathList(surface.requiredDirectories, `${label}.requiredDirectories`),
    requiredFiles: normalizePathList(surface.requiredFiles, `${label}.requiredFiles`),
    ...(surface.forbiddenPaths === undefined
      ? {}
      : { forbiddenPaths: normalizePathList(surface.forbiddenPaths, `${label}.forbiddenPaths`) }),
    denyUntrackedCriticalSurfaces: surface.denyUntrackedCriticalSurfaces,
  };
}

function readArtifactSurface(poolRoot: string): LoadedArtifactSurface {
  const surfacePath = path.join(poolRoot, ARTIFACT_SURFACE_FILE);
  if (!fileExists(surfacePath)) {
    return {
      surface: defaultArtifactSurface(),
      surfacePath,
      loadedFromFile: false,
    };
  }

  try {
    return {
      surface: normalizeArtifactSurface(readJson(surfacePath), ARTIFACT_SURFACE_FILE),
      surfacePath,
      loadedFromFile: true,
    };
  } catch (error) {
    throw new Error(`Invalid ${ARTIFACT_SURFACE_FILE}: ${toErrorMessage(error)}`);
  }
}

function toPosixRelative(sourceRoot: string, targetPath: string): string {
  const relative = path.relative(sourceRoot, targetPath);
  if (!relative || relative === ".") {
    return ".";
  }
  return relative.split(path.sep).join("/");
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of paths) {
    const resolved = path.resolve(item);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    output.push(resolved);
  }
  return output;
}

function resolveDirectoryCandidates(
  sourceRoot: string,
  poolRoot: string,
  layout: SourceLayoutLike,
  relativePath: string
): string[] {
  if (relativePath === "skills") {
    return [layout.skillsDir];
  }
  if (relativePath === "adapters") {
    return [layout.adaptersDir];
  }
  if (relativePath === "profiles") {
    return [layout.profilesDir];
  }
  const candidates = [path.join(poolRoot, relativePath)];
  if (relativePath.startsWith("scripts/") && path.resolve(sourceRoot) !== path.resolve(poolRoot)) {
    candidates.push(path.join(sourceRoot, relativePath));
  }
  return uniquePaths(candidates);
}

function resolveFileCandidate(poolRoot: string, relativePath: string): string {
  return path.join(poolRoot, relativePath);
}

function assertCovered(
  surface: ArtifactSurface,
  sourceRoot: string,
  poolRoot: string,
  layout: SourceLayoutLike
): void {
  if (!surface.denyUntrackedCriticalSurfaces) {
    return;
  }

  const listedDirectories = new Set(surface.requiredDirectories);
  for (const candidate of CRITICAL_DIRECTORY_CANDIDATES) {
    const exists = resolveDirectoryCandidates(sourceRoot, poolRoot, layout, candidate).some((candidatePath) =>
      fileExists(candidatePath) && fs.statSync(candidatePath).isDirectory()
    );
    if (exists && !listedDirectories.has(candidate)) {
      throw new Error(
        `Critical artifact directory exists outside ${ARTIFACT_SURFACE_FILE}: ${candidate}`
      );
    }
  }

  const listedFiles = new Set(surface.requiredFiles);
  for (const candidate of CRITICAL_FILE_CANDIDATES) {
    const candidatePath = resolveFileCandidate(poolRoot, candidate);
    if (fileExists(candidatePath) && fs.statSync(candidatePath).isFile() && !listedFiles.has(candidate)) {
      throw new Error(`Critical artifact file exists outside ${ARTIFACT_SURFACE_FILE}: ${candidate}`);
    }
  }
}

function collectArtifactSurfaceEntries(
  sourceRoot: string,
  poolRoot: string,
  layout: SourceLayoutLike
): ResolvedArtifactSurfaceEntries {
  const loaded = readArtifactSurface(poolRoot);
  const { surface } = loaded;
  assertCovered(surface, sourceRoot, poolRoot, layout);

  const directories: ArtifactSurfaceDirectoryEntry[] = [];
  const files: ArtifactSurfaceFileEntry[] = [];

  for (const relativePath of surface.requiredDirectories) {
    const candidates = resolveDirectoryCandidates(sourceRoot, poolRoot, layout, relativePath);
    let found = false;
    for (const candidatePath of candidates) {
      if (!fileExists(candidatePath)) {
        continue;
      }
      if (!fs.statSync(candidatePath).isDirectory()) {
        throw new Error(`Artifact surface directory is not a directory: ${relativePath}`);
      }
      directories.push({
        path: toPosixRelative(sourceRoot, candidatePath),
        absolutePath: path.resolve(candidatePath),
      });
      found = true;
    }
    if (!found && loaded.loadedFromFile) {
      throw new Error(`Artifact surface required directory not found: ${relativePath}`);
    }
  }

  for (const relativePath of surface.requiredFiles) {
    const candidatePath = resolveFileCandidate(poolRoot, relativePath);
    if (!fileExists(candidatePath)) {
      if (loaded.loadedFromFile) {
        throw new Error(`Artifact surface required file not found: ${relativePath}`);
      }
      continue;
    }
    if (!fs.statSync(candidatePath).isFile()) {
      throw new Error(`Artifact surface file is not a file: ${relativePath}`);
    }
    files.push({
      path: toPosixRelative(sourceRoot, candidatePath),
      absolutePath: path.resolve(candidatePath),
    });
  }

  directories.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    ...loaded,
    directories,
    files,
  };
}

export {
  ARTIFACT_SURFACE_FILE,
  collectArtifactSurfaceEntries,
  defaultArtifactSurface,
  readArtifactSurface,
};
export type {
  ArtifactSurface,
  ArtifactSurfaceDirectoryEntry,
  ArtifactSurfaceFileEntry,
  LoadedArtifactSurface,
  ResolvedArtifactSurfaceEntries,
};
