#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dirDigest as dirDigestBase, fileExists, hashFile, readJson } from "../../lib/files.ts";
import { collectArtifactSurfaceEntries } from "./artifact-surface.ts";

const DEFAULT_LIFECYCLE_FILE = "skill-lifecycle.json";

interface SourceLayout {
  kind: "flat" | "monorepo-root" | "nested-app" | "skillpack";
  skillsDir: string;
  adaptersDir: string;
  profilesDir: string;
}

interface ResolveSourceLayoutOptions {
  requireSkills?: boolean;
}

interface SkillLifecycleEntry {
  skill?: string;
  date?: string;
  [key: string]: unknown;
}

interface SkillLifecycleFile {
  entries?: SkillLifecycleEntry[];
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPathWithin(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || relative === "." || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSafeExistingPath(
  sourceRoot: string,
  candidatePath: string,
  label: string,
  expectedType: "directory" | "file",
  options: { allowRoot?: boolean } = {}
): void {
  const sourceAbs = path.resolve(sourceRoot);
  const candidateAbs = path.resolve(candidatePath);
  const relative = path.relative(sourceAbs, candidateAbs);

  if (
    (!options.allowRoot && (relative === "" || relative === ".")) ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must stay within source root (${sourceAbs}): ${candidateAbs}`);
  }

  if (!fileExists(candidateAbs)) {
    throw new Error(`${label} not found: ${candidateAbs}`);
  }

  const sourceStat = fs.lstatSync(sourceAbs);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked source root: ${sourceAbs}`);
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`Source root is not a directory: ${sourceAbs}`);
  }

  let currentPath = sourceAbs;
  if (relative && relative !== ".") {
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      currentPath = path.join(currentPath, segment);
      if (!fileExists(currentPath)) {
        throw new Error(`${label} not found: ${candidateAbs}`);
      }
      if (fs.lstatSync(currentPath).isSymbolicLink()) {
        throw new Error(`Refusing to use symlinked ${label}: ${currentPath}`);
      }
    }
  }

  const sourceReal = fs.realpathSync.native(sourceAbs);
  const candidateReal = fs.realpathSync.native(candidateAbs);
  if (!isPathWithin(sourceReal, candidateReal)) {
    throw new Error(`${label} must stay within source root (${sourceAbs}): ${candidateAbs}`);
  }

  const candidateStat = fs.statSync(candidateAbs);
  if (expectedType === "directory" && !candidateStat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${candidateAbs}`);
  }
  if (expectedType === "file" && !candidateStat.isFile()) {
    throw new Error(`${label} is not a file: ${candidateAbs}`);
  }
}

function isSafeExistingDirectory(sourceRoot: string, candidatePath: string, label: string): boolean {
  try {
    assertSafeExistingPath(sourceRoot, candidatePath, label, "directory");
    return true;
  } catch (error) {
    if (fileExists(candidatePath) && toErrorMessage(error).includes("symlinked")) {
      throw error;
    }
    return false;
  }
}

function resolveSourceLayout(
  sourceRoot: string,
  opts: ResolveSourceLayoutOptions = {}
): SourceLayout {
  const requireSkills = opts.requireSkills !== false;
  assertSafeExistingPath(sourceRoot, sourceRoot, "Source root", "directory", { allowRoot: true });
  const candidates: SourceLayout[] = [
    {
      kind: "flat",
      skillsDir: path.join(sourceRoot, "skills"),
      adaptersDir: path.join(sourceRoot, "adapters"),
      profilesDir: path.join(sourceRoot, "profiles"),
    },
    {
      kind: "monorepo-root",
      skillsDir: path.join(sourceRoot, "skills"),
      adaptersDir: path.join(sourceRoot, "apps", "universal-skills", "adapters"),
      profilesDir: path.join(sourceRoot, "apps", "universal-skills", "profiles"),
    },
    {
      kind: "nested-app",
      skillsDir: path.join(sourceRoot, "apps", "universal-skills", "skills"),
      adaptersDir: path.join(sourceRoot, "apps", "universal-skills", "adapters"),
      profilesDir: path.join(sourceRoot, "apps", "universal-skills", "profiles"),
    },
  ];

  for (const candidate of candidates) {
    const hasAdapters = isSafeExistingDirectory(sourceRoot, candidate.adaptersDir, "Adapters directory");
    const hasProfiles = isSafeExistingDirectory(sourceRoot, candidate.profilesDir, "Profiles directory");
    const hasSkills = isSafeExistingDirectory(sourceRoot, candidate.skillsDir, "Skills directory");
    if (hasAdapters && hasProfiles && (!requireSkills || hasSkills)) {
      return candidate;
    }
  }

  const skillpackManifest = path.join(sourceRoot, "skillpack.json");
  const skillpackCandidate: SourceLayout = {
    kind: "skillpack",
    skillsDir: path.join(sourceRoot, "skills"),
    adaptersDir: path.join(sourceRoot, "adapters"),
    profilesDir: path.join(sourceRoot, "profiles"),
  };
  const hasSkillpackManifest = fileExists(skillpackManifest) && fs.statSync(skillpackManifest).isFile();
  const hasSkillpackProfiles = isSafeExistingDirectory(sourceRoot, skillpackCandidate.profilesDir, "Profiles directory");
  const hasSkillpackSkills = isSafeExistingDirectory(sourceRoot, skillpackCandidate.skillsDir, "Skills directory");
  if (hasSkillpackManifest && hasSkillpackProfiles && (!requireSkills || hasSkillpackSkills)) {
    return skillpackCandidate;
  }

  const details = candidates
    .map((item) => `${item.kind}: ${item.skillsDir} | ${item.adaptersDir} | ${item.profilesDir}`)
    .concat(`skillpack: ${skillpackCandidate.skillsDir} | ${skillpackCandidate.profilesDir} | ${skillpackManifest}`)
    .join("\n- ");
  throw new Error(
    `Unable to resolve source layout from ${sourceRoot}. Expected one of:\n- ${details}`
  );
}

function resolvePoolRoot(sourceRoot: string, layout: SourceLayout): string {
  const poolRootByLayout =
    layout.kind === "flat" || layout.kind === "skillpack" ? sourceRoot : path.join(sourceRoot, "apps", "universal-skills");
  assertSafeExistingPath(sourceRoot, poolRootByLayout, "Pool root", "directory", { allowRoot: true });
  if (fileExists(path.join(poolRootByLayout, "package.json"))) {
    return poolRootByLayout;
  }
  return sourceRoot;
}

function resolveLifecyclePath(sourceRoot: string, layout: SourceLayout): string {
  const poolRoot = resolvePoolRoot(sourceRoot, layout);
  return path.join(poolRoot, DEFAULT_LIFECYCLE_FILE);
}

function readSkillLifecycle(sourceRoot: string, layout: SourceLayout) {
  const lifecyclePath = resolveLifecyclePath(sourceRoot, layout);
  if (!fileExists(lifecyclePath)) {
    return { path: lifecyclePath, entriesBySkill: new Map<string, SkillLifecycleEntry[]>() };
  }
  assertSafeExistingPath(sourceRoot, lifecyclePath, "Skill lifecycle file", "file");

  const lifecycle = readJson(lifecyclePath) as SkillLifecycleFile;
  const entriesBySkill = new Map<string, SkillLifecycleEntry[]>();
  for (const entry of lifecycle.entries || []) {
    if (!entry || !entry.skill) {
      continue;
    }
    const entries = entriesBySkill.get(entry.skill) || [];
    entries.push(entry);
    entriesBySkill.set(entry.skill, entries);
  }

  for (const entries of entriesBySkill.values()) {
    entries.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  }

  return { path: lifecyclePath, entriesBySkill };
}

function computeSourceChecksum(sourceRoot: string, layout: SourceLayout): string {
  const poolRoot = resolvePoolRoot(sourceRoot, layout);
  const lines: string[] = [];

  if (fileExists(layout.skillsDir)) {
    assertSafeExistingPath(sourceRoot, layout.skillsDir, "Skills directory", "directory");
  }
  if (fileExists(layout.adaptersDir)) {
    assertSafeExistingPath(sourceRoot, layout.adaptersDir, "Adapters directory", "directory");
  } else if (layout.kind !== "skillpack") {
    assertSafeExistingPath(sourceRoot, layout.adaptersDir, "Adapters directory", "directory");
  }
  assertSafeExistingPath(sourceRoot, layout.profilesDir, "Profiles directory", "directory");

  const entries = collectArtifactSurfaceEntries(sourceRoot, poolRoot, layout);
  for (const entry of entries.directories) {
    assertSafeExistingPath(sourceRoot, entry.absolutePath, `${entry.path} directory`, "directory");
    lines.push(`dir:${entry.path}:${dirDigestBase(entry.absolutePath)}`);
  }

  for (const entry of entries.files) {
    assertSafeExistingPath(sourceRoot, entry.absolutePath, `${entry.path} file`, "file");
    lines.push(`file:${entry.path}:${hashFile(entry.absolutePath)}`);
  }

  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

export {
  computeSourceChecksum,
  readSkillLifecycle,
  resolveLifecyclePath,
  resolvePoolRoot,
  resolveSourceLayout,
};
