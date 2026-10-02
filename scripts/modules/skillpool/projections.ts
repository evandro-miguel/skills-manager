#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  copyDirectory,
  dirDigest,
  ensureDir,
  fileExists,
  hashFile,
  listFilesRecursive,
  readJson,
  writeFileAtomicSafe,
} from "../../lib/files.ts";
import {
  collectSkillProjectionSources,
  listSkillNames,
  originsForSources,
  type SkillOrigin,
  type SkillProjectionSource,
} from "./projection-sources.ts";
import { type ConcreteProviderId, parseProviderList, readProviderCapabilities } from "./providers.ts";
import {
  PROJECTION_STORE_SCHEMA_VERSION,
  RENDERER_VERSION,
  projectionContentKey,
  projectionStoreEntryPath,
  projectionStoreEntryValid,
  readProjectionFromStore,
  writeProjectionToStore,
  type ProjectionStoreDescriptor,
} from "./projection-store.ts";
import { hasDangerousRisk, readSkillMeta, type SkillMeta } from "./skill-meta.ts";
import { resolvePoolRoot, resolveSourceLayout } from "./source.ts";

const PROJECTION_META_FILE = "projection.meta.json";
const PROJECTION_MANIFEST_FILE = "projection-manifest.json";
// Ownership marker written at an output directory's root. --clean only deletes
// directories that are missing, empty, or carry a valid marker here, so an
// arbitrary user-chosen out-dir is never removed recursively.
export const PROJECTION_ROOT_MARKER_FILE = ".skill-sys-projections.json";
const PROJECTION_ROOT_MARKER_SCHEMA_VERSION = 1;
// --clean builds materialize the complete new tree in an exclusively-created
// sibling staging directory before anything touches the live out-dir, then
// swap via guarded renames. Both prefixes are exported so tests can assert
// sibling hygiene (no leftovers after success or failure).
export const PROJECTION_STAGING_DIR_PREFIX = ".skill-sys-projection-staging-";
export const PROJECTION_BACKUP_DIR_PREFIX = ".skill-sys-projection-backup-";
const MAX_SIBLING_ALLOCATION_ATTEMPTS = 8;
const RISK_KEYS = [
  "readsFiles",
  "writesProject",
  "writesGlobal",
  "executesShell",
  "networkAccess",
  "externalDirectory",
  "credentialSensitive",
  "destructive",
  "browserAuthState",
  "repoMutation",
] as const;

interface ProjectionOverlay {
  manualOnly?: unknown;
  note?: unknown;
}

interface ProjectionRecord {
  provider: ConcreteProviderId;
  skill: string;
  origin: SkillOrigin;
  canonicalPath: string;
  projectionPath: string;
  canonicalDigest: string;
  projectionDigest: string;
  rendererVersion: number;
  manualOnly: boolean;
  risk: SkillMeta["risk"];
  cached?: boolean;
}

interface BuildProjectionsOptions {
  sourceRoot: string;
  providers: ConcreteProviderId[];
  outDir: string;
  clean: boolean;
  projectionStoreDir?: string;
  userRoot?: string;
  includeUser?: boolean;
}

interface ProjectionManifest {
  schemaVersion: 1;
  rendererVersion: number;
  providers: ConcreteProviderId[];
  origins: SkillOrigin[];
  projectionCount: number;
  generatedAt: string;
  projections: ProjectionRecord[];
  cache: {
    cachedCount: number;
    rebuiltCount: number;
    storeHitCount: number;
  };
}

interface BuildProjectionsResult {
  outDir: string;
  providers: ConcreteProviderId[];
  projections: ProjectionRecord[];
  manifestPath: string;
  manifest: ProjectionManifest;
}

interface BuiltProjectionTree {
  projections: ProjectionRecord[];
  manifest: ProjectionManifest;
}

interface ValidateProjectionsOptions {
  sourceRoot: string;
  providers: ConcreteProviderId[];
  outDir: string;
  userRoot?: string;
  includeUser?: boolean;
}

interface ProjectionCleanTargetContext {
  homedir?: string;
  projectRoot?: string;
}

interface ValidateProjectionFinding {
  level: "ERROR" | "WARN";
  code: string;
  message: string;
}

function digestDirectoryExcludingMeta(dirPath: string): string {
  const files = listFilesRecursive(dirPath)
    .filter((filePath) => path.basename(filePath) !== PROJECTION_META_FILE)
    .map((filePath) => {
      const rel = path.relative(dirPath, filePath).replaceAll("\\", "/");
      return `${rel}\0${hashFile(filePath)}`;
    })
    .join("\n");
  return crypto.createHash("sha256").update(files).digest("hex");
}

function readOverlay(sourceRoot: string, provider: ConcreteProviderId, skillName: string): ProjectionOverlay {
  const overlayPath = path.join(sourceRoot, "overlays", provider, `${skillName}.overlay.json`);
  if (!fileExists(overlayPath)) {
    return {};
  }
  const overlay = readJson<ProjectionOverlay>(overlayPath);
  if (overlay.manualOnly !== undefined && typeof overlay.manualOnly !== "boolean") {
    throw new Error(`${overlayPath}.manualOnly must be boolean`);
  }
  if (overlay.note !== undefined && typeof overlay.note !== "string") {
    throw new Error(`${overlayPath}.note must be string`);
  }
  return overlay;
}

function writeCodexManualPolicy(projectedSkillDir: string): void {
  const policyPath = path.join(projectedSkillDir, "agents", "openai.yaml");
  writeFileAtomicSafe(
    policyPath,
    "policy:\n  allow_implicit_invocation: false\n"
  );
}

function insertClaudeDisableModelInvocation(skillMarkdown: string): string {
  if (!skillMarkdown.startsWith("---\n")) {
    return `---\ndisable-model-invocation: true\n---\n\n${skillMarkdown}`;
  }
  const end = skillMarkdown.indexOf("\n---", 4);
  if (end === -1) {
    return skillMarkdown;
  }
  const frontmatter = skillMarkdown.slice(0, end);
  if (/^disable-model-invocation:/m.test(frontmatter)) {
    return skillMarkdown;
  }
  return `${frontmatter}\ndisable-model-invocation: true${skillMarkdown.slice(end)}`;
}

function writeOpenCodePermission(projectedSkillDir: string): void {
  writeFileAtomicSafe(
    path.join(projectedSkillDir, "opencode.permissions.json"),
    `${JSON.stringify(
      {
        permission: {
          edit: "ask",
          bash: "ask",
          webfetch: "ask",
          websearch: "ask",
        },
      },
      null,
      2
    )}\n`
  );
}

function computeManualOnly(meta: SkillMeta, overlay: ProjectionOverlay): boolean {
  return overlay.manualOnly === true || meta.invocation.manualOnly || !meta.invocation.implicitAllowed || hasDangerousRisk(meta);
}

function extractMarkdownFrontmatter(skillMarkdown: string): string | null {
  if (!skillMarkdown.startsWith("---\n")) {
    return null;
  }
  const end = skillMarkdown.indexOf("\n---", 4);
  if (end === -1) {
    return null;
  }
  return skillMarkdown.slice(4, end);
}

function hasClaudeDisableModelInvocation(skillMarkdown: string): boolean {
  const frontmatter = extractMarkdownFrontmatter(skillMarkdown);
  if (frontmatter === null) {
    return false;
  }
  const keyMatches = frontmatter.match(/^disable-model-invocation\s*:/gm) || [];
  if (keyMatches.length !== 1) {
    return false;
  }
  return /^disable-model-invocation:\s*true\s*$/m.test(frontmatter);
}

function riskMatchesRecord(recordRisk: unknown, expectedRisk: SkillMeta["risk"]): boolean {
  if (!recordRisk || typeof recordRisk !== "object" || Array.isArray(recordRisk)) {
    return false;
  }
  const actualRisk = recordRisk as Record<string, unknown>;
  return RISK_KEYS.every((key) => actualRisk[key] === expectedRisk[key]);
}

function applyProviderRiskControls(
  provider: ConcreteProviderId,
  projectedSkillDir: string,
  manualOnly: boolean
): void {
  if (!manualOnly) {
    return;
  }
  if (provider === "codex") {
    writeCodexManualPolicy(projectedSkillDir);
    return;
  }
  if (provider === "claude-code") {
    const skillPath = path.join(projectedSkillDir, "SKILL.md");
    writeFileAtomicSafe(skillPath, insertClaudeDisableModelInvocation(fs.readFileSync(skillPath, "utf8")));
    return;
  }
  if (provider === "opencode") {
    writeOpenCodePermission(projectedSkillDir);
  }
}

function reusableProjectionRecord(
  targetDir: string,
  provider: ConcreteProviderId,
  source: SkillProjectionSource,
  canonicalDigest: string,
  manualOnly: boolean
): ProjectionRecord | null {
  const metaPath = path.join(targetDir, PROJECTION_META_FILE);
  if (!fileExists(metaPath)) {
    return null;
  }
  const record = readJson<ProjectionRecord>(metaPath);
  if (
    record.provider !== provider ||
    record.skill !== source.skillName ||
    record.origin !== source.origin ||
    record.rendererVersion !== RENDERER_VERSION ||
    record.canonicalDigest !== canonicalDigest ||
    record.canonicalPath !== source.canonicalPath ||
    record.manualOnly !== manualOnly
  ) {
    return null;
  }
  if (record.projectionDigest !== digestDirectoryExcludingMeta(targetDir)) {
    return null;
  }
  return {
    ...record,
    cached: true,
  };
}

function assertNoSymlinkEntries(rootDir: string, label: string): void {
  const rootStat = fs.lstatSync(rootDir);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to project symlinked ${label}: ${rootDir}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${rootDir}`);
  }

  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const linkStat = fs.lstatSync(entryPath);
      if (linkStat.isSymbolicLink()) {
        throw new Error(`Refusing to project symlinked source entry in ${label}: ${entryPath}`);
      }
      if (linkStat.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }
}

function pruneStaleUserProjectionDirs(outDir: string, expectedUserSkills?: Set<string>): void {
  if (!fileExists(outDir)) {
    return;
  }
  const outStat = fs.lstatSync(outDir);
  if (outStat.isSymbolicLink() || !outStat.isDirectory()) {
    return;
  }
  for (const providerEntry of fs.readdirSync(outDir, { withFileTypes: true })) {
    const providerDir = path.join(outDir, providerEntry.name);
    if (!providerEntry.isDirectory() || providerEntry.isSymbolicLink()) {
      continue;
    }
    for (const entry of fs.readdirSync(providerDir, { withFileTypes: true })) {
      const projectionDir = path.join(providerDir, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const metaPath = path.join(projectionDir, PROJECTION_META_FILE);
      if (!fileExists(metaPath) || fs.lstatSync(metaPath).isSymbolicLink()) {
        continue;
      }
      let record: ProjectionRecord;
      try {
        record = readJson<ProjectionRecord>(metaPath);
      } catch {
        // Corrupt metadata is handled by validation; only prune confirmed stale user projections here.
        continue;
      }
      if (record.origin === "user" && (expectedUserSkills === undefined || !expectedUserSkills.has(record.skill))) {
        assertNoSymlinkEntries(projectionDir, "stale user projection");
        if (digestDirectoryExcludingMeta(projectionDir) !== record.projectionDigest) {
          throw new Error(`Refusing to remove modified user projection: ${projectionDir}. Preserve manual changes before rebuilding.`);
        }
        fs.rmSync(projectionDir, { recursive: true, force: true });
      }
    }
  }
}

function pathContains(parentDir: string, childDir: string): boolean {
  return childDir === parentDir || childDir.startsWith(`${parentDir}${path.sep}`);
}

function firstSymlinkedPath(dirPath: string): string | null {
  const root = path.parse(dirPath).root;
  let current = dirPath;
  while (true) {
    if (fileExists(current) && fs.lstatSync(current).isSymbolicLink()) {
      return current;
    }
    if (current === root) {
      return null;
    }
    current = path.dirname(current);
  }
}

type ProjectionRootMarkerCheck = { ok: true } | { ok: false; reason: string };

function checkProjectionRootMarker(outDir: string): ProjectionRootMarkerCheck {
  const markerPath = path.join(outDir, PROJECTION_ROOT_MARKER_FILE);
  if (!fileExists(markerPath)) {
    return { ok: false, reason: `no ${PROJECTION_ROOT_MARKER_FILE} marker present` };
  }
  let marker: Record<string, unknown>;
  try {
    marker = readJson<Record<string, unknown>>(markerPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `unreadable ${PROJECTION_ROOT_MARKER_FILE}: ${message}` };
  }
  if (marker.schemaVersion !== PROJECTION_ROOT_MARKER_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported ${PROJECTION_ROOT_MARKER_FILE} schemaVersion` };
  }
  if (marker.tool !== "skill-sys" || marker.kind !== "projection-output") {
    return { ok: false, reason: `${PROJECTION_ROOT_MARKER_FILE} is not a Skill-Sys projection-output marker` };
  }
  return { ok: true };
}

/**
 * Returns null when --clean may delete `outDir`, otherwise a refusal reason.
 * A deletable out-dir is never the filesystem root, $HOME, the project root,
 * or the source tree (or any of their ancestors), is not reached through a
 * symlinked path, and is missing, empty, or owned by a valid Skill-Sys
 * projection-output marker.
 */
function findProjectionCleanObstruction(
  outDir: string,
  sourceRoot: string,
  context: ProjectionCleanTargetContext = {}
): string | null {
  const resolvedOutDir = path.resolve(outDir);
  const homedir = path.resolve(context.homedir ?? os.homedir());
  const projectRoot = path.resolve(context.projectRoot ?? process.cwd());
  const resolvedSourceRoot = path.resolve(sourceRoot);

  if (resolvedOutDir === path.parse(resolvedOutDir).root) {
    return `Refusing to clean filesystem root as projection output: ${resolvedOutDir}`;
  }
  if (pathContains(resolvedOutDir, homedir)) {
    return `Refusing to clean a directory containing the home directory (${homedir}): ${resolvedOutDir}`;
  }
  if (pathContains(resolvedOutDir, projectRoot)) {
    return `Refusing to clean a directory containing the project root (${projectRoot}): ${resolvedOutDir}`;
  }
  if (pathContains(resolvedOutDir, resolvedSourceRoot)) {
    return `Refusing to clean a directory containing the projection source root (${resolvedSourceRoot}): ${resolvedOutDir}`;
  }
  const symlinkedPath = firstSymlinkedPath(resolvedOutDir);
  if (symlinkedPath !== null) {
    return `Refusing to clean through symlinked path: ${symlinkedPath}`;
  }
  if (!fileExists(resolvedOutDir)) {
    return null;
  }
  const outStat = fs.lstatSync(resolvedOutDir);
  if (outStat.isSymbolicLink() || !outStat.isDirectory()) {
    return `Refusing to clean projection output that is not a real directory: ${resolvedOutDir}`;
  }
  if (fs.readdirSync(resolvedOutDir).length === 0) {
    return null;
  }
  const markerCheck = checkProjectionRootMarker(resolvedOutDir);
  if (markerCheck.ok) {
    return null;
  }
  return (
    `Refusing to clean unmanaged projection output directory: ${resolvedOutDir}. ` +
    `Only directories that are missing, empty, or owned by a valid Skill-Sys projection marker may be cleaned. ` +
    `Problem: ${markerCheck.reason}`
  );
}

function writeProjectionRootMarker(outDir: string): void {
  const marker = {
    schemaVersion: PROJECTION_ROOT_MARKER_SCHEMA_VERSION,
    tool: "skill-sys",
    kind: "projection-output",
    generatedAt: new Date().toISOString(),
  };
  writeFileAtomicSafe(
    path.join(outDir, PROJECTION_ROOT_MARKER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`
  );
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns null when a generated staging/backup sibling path is safe to create
 * and fill, otherwise the refusal reason. The path must not be the filesystem
 * root, must never contain (be an ancestor of) the projection source root,
 * the project root, or the home directory — so filling or removing the path
 * can never consume those trees — and must not be reached through a symlinked
 * path component. Collision safety comes from exclusive creation at
 * allocation time, not from this check.
 */
function findProjectionSiblingPathObjection(
  candidatePath: string,
  sourceRoot: string,
  context: ProjectionCleanTargetContext = {}
): string | null {
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedCandidate === path.parse(resolvedCandidate).root) {
    return `Refusing staging or backup path at filesystem root: ${resolvedCandidate}`;
  }
  const protectedTrees: Array<[string, string]> = [
    [path.resolve(sourceRoot), "projection source root"],
    [path.resolve(context.projectRoot ?? process.cwd()), "project root"],
    [path.resolve(context.homedir ?? os.homedir()), "home directory"],
  ];
  for (const [protectedRoot, label] of protectedTrees) {
    if (pathContains(resolvedCandidate, protectedRoot)) {
      return `Refusing staging or backup path containing the ${label} (${protectedRoot}): ${resolvedCandidate}`;
    }
  }
  const symlinkedPath = firstSymlinkedPath(resolvedCandidate);
  if (symlinkedPath !== null) {
    return `Refusing staging or backup path through symlinked path: ${symlinkedPath}`;
  }
  return null;
}

/**
 * Exclusively create a uniquely named directory directly under `parentDir`.
 * The candidate name embeds pid, timestamp, and random bytes; the guard check
 * runs per candidate and creation uses `mkdir` without `recursive`, so an
 * existing entry at that exact name can never be overwritten (EEXIST retries
 * with a fresh name instead).
 */
function allocateGuardedProjectionSiblingDir(
  parentDir: string,
  prefix: string,
  label: string,
  sourceRoot: string
): string {
  const resolvedParent = path.resolve(parentDir);
  let collisions = 0;
  for (let attempt = 0; attempt < MAX_SIBLING_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidatePath = path.join(
      resolvedParent,
      `${prefix}${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`
    );
    const objection = findProjectionSiblingPathObjection(candidatePath, sourceRoot);
    if (objection !== null) {
      throw new Error(objection);
    }
    try {
      fs.mkdirSync(candidatePath);
      return candidatePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      collisions += 1;
    }
  }
  throw new Error(
    `Unable to allocate a unique ${label} directory under ${resolvedParent} after ${collisions} collision(s)`
  );
}

/**
 * Remove one of our own exclusively-created temp trees (staging slot or
 * discarded build output). Refuses anything that is not a real directory so
 * the recursive delete can never be aimed through a symlink or at a file.
 */
function removeOwnedProjectionTempDir(dirPath: string): void {
  if (!fileExists(dirPath)) {
    return;
  }
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to remove unexpected non-directory projection temp path: ${dirPath}`);
  }
  fs.rmSync(dirPath, { recursive: true, force: true });
}

interface ProjectionStagedInstall {
  outDir: string;
  stagingDir: string;
  sourceRoot: string;
}

/**
 * Install a fully built staging tree at outDir. Nothing deletes the live tree
 * before the replacement is complete; only renames move whole trees. Exact
 * failure semantics:
 *
 * - Live outDir absent: single rename(staging -> outDir). A failure leaves
 *   staging intact for cleanup and outDir absent.
 * - Live present: rename(outDir -> backup), then rename(staging -> outDir).
 *   If the second rename fails, rename(backup -> outDir) restores the
 *   original tree byte-identically (the backup was never touched) and the
 *   error is rethrown.
 *   Once the second rename succeeds, the new live output is authoritative:
 *   if backup removal fails afterwards, the new output stays in place at
 *   outDir and the error names the guarded backup residue path for manual
 *   cleanup. A partially deleted backup is never promoted over the valid
 *   new live tree, and the staging slot is never reused after the swap.
 */
function installStagedProjections(install: ProjectionStagedInstall): void {
  const { outDir, stagingDir, sourceRoot } = install;

  if (!fileExists(outDir)) {
    fs.renameSync(stagingDir, outDir);
    return;
  }

  const backupDir = allocateGuardedProjectionSiblingDir(
    path.dirname(outDir),
    PROJECTION_BACKUP_DIR_PREFIX,
    "projection output backup",
    sourceRoot
  );

  // Phase 1: park the original live tree as a sibling backup. Nothing has
  // been destroyed yet; the live path is merely vacated.
  fs.renameSync(outDir, backupDir);

  // Phase 2: install the fully built tree at the live path.
  try {
    fs.renameSync(stagingDir, outDir);
  } catch (error) {
    // Compensation: undo phase 1 so the original tree returns byte-identically.
    try {
      fs.renameSync(backupDir, outDir);
    } catch (undoError) {
      throw new Error(
        `Failed to move staged projection output into place (${toMessage(error)}) and compensation failed (${toMessage(undoError)}); original output preserved at: ${backupDir}`
      );
    }
    throw new Error(
      `Failed to move staged projection output into place; original output restored (${toMessage(error)})`
    );
  }

  // Phase 3: drop the backup of the replaced tree. The new live output is
  // now authoritative, so deletion trouble must never trigger a rollback:
  // a failed recursive delete can leave the backup partially destroyed, and
  // promoting it over the valid new tree would destroy good output.
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `Failed to remove the replaced projection output backup (${toMessage(error)}); ` +
        `the newly built projection output remains complete and authoritative at: ${outDir}. ` +
        `Manually remove the guarded backup residue if it is no longer needed: ${backupDir}`
    );
  }
}

function buildProjections(options: BuildProjectionsOptions): BuildProjectionsResult {
  const sourceRoot = path.resolve(options.sourceRoot);
  const layout = resolveSourceLayout(sourceRoot, { requireSkills: false });
  const poolRoot = resolvePoolRoot(sourceRoot, layout);
  const outDir = path.resolve(options.outDir);
  const projectionStoreDir = options.projectionStoreDir
    ? path.resolve(options.projectionStoreDir)
    : undefined;
  if (
    projectionStoreDir !== undefined &&
    (pathContains(outDir, projectionStoreDir) || pathContains(projectionStoreDir, outDir))
  ) {
    throw new Error(
      `Projection store ${projectionStoreDir} must not overlap projection output ${outDir}`
    );
  }
  const providers = options.providers;
  readProviderCapabilities(poolRoot, providers);

  const cleanObstruction = findProjectionCleanObstruction(outDir, sourceRoot);
  if (options.clean && cleanObstruction !== null) {
    throw new Error(cleanObstruction);
  }
  // Only claim marker ownership of trees that were safe to manage beforehand;
  // a non-clean build into foreign content must not bless later --clean runs.
  const manageProjectionRoot = cleanObstruction === null;

  const skillSourceOptions: { includeUser?: boolean; userRoot?: string } = {};
  if (options.includeUser !== undefined) skillSourceOptions.includeUser = options.includeUser;
  if (options.userRoot !== undefined) skillSourceOptions.userRoot = options.userRoot;

  // Render one complete projection tree (content, manifest, and ownership
  // marker) rooted at treeRoot. For --clean this runs against an empty
  // staging sibling, so the live out-dir is untouched until the whole tree —
  // including manifest and marker — exists.
  const renderProjectionTree = (treeRoot: string): BuiltProjectionTree => {
    ensureDir(treeRoot);
    for (const provider of providers) {
      ensureDir(path.join(treeRoot, provider));
    }

    const projections: ProjectionRecord[] = [];
    const skillSources = collectSkillProjectionSources(layout.skillsDir, poolRoot, skillSourceOptions);
    const expectedSkillNames = new Set(skillSources.map((source) => source.skillName));
    // A non-clean build cannot silently keep retired public payloads beside
    // an active-only manifest. --clean uses the existing guarded tree swap.
    for (const name of listSkillNames(layout.skillsDir)) {
      if (expectedSkillNames.has(name)) continue;
      for (const provider of providers) {
        if (fileExists(path.join(treeRoot, provider, name))) {
          throw new Error(`Retired projection ${provider}/${name} remains in the output; rebuild with --clean to replace the managed projection tree.`);
        }
      }
    }
    const expectedUserSkills = new Set(
      skillSources.filter((source) => source.origin === "user").map((source) => source.skillName)
    );
    pruneStaleUserProjectionDirs(treeRoot, options.includeUser === true ? expectedUserSkills : undefined);
    let cachedCount = 0;
    let rebuiltCount = 0;
    let storeHitCount = 0;
    for (const provider of providers) {
      for (const source of skillSources) {
        const { skillName, skillDir } = source;
        const targetDir = path.join(treeRoot, provider, skillName);
        assertNoSymlinkEntries(skillDir, `${source.origin} skill '${skillName}'`);
        const meta = readSkillMeta(skillDir, skillName);
        const overlay = readOverlay(poolRoot, provider, skillName);
        const manualOnly = computeManualOnly(meta, overlay);
        const canonicalDigest = dirDigest(skillDir);
        if (fileExists(targetDir)) {
          assertNoSymlinkEntries(targetDir, `cached projection for ${source.origin} skill '${skillName}'`);
        }
        const cachedRecord = reusableProjectionRecord(targetDir, provider, source, canonicalDigest, manualOnly);
        if (cachedRecord) {
          projections.push(cachedRecord);
          cachedCount += 1;
          continue;
        }

        // Content-addressable store lookup. Integrity digests stay full-content;
        // only the copy+render is skipped. User-origin projections never touch
        // the store (privacy hard rule: both read and write are guarded).
        let storeEntryDir: string | null = null;
        let storeContentKey: string | null = null;
        let storeHit = false;
        if (source.origin !== "user") {
          storeContentKey = projectionContentKey(provider, source.origin, canonicalDigest, manualOnly);
          storeEntryDir = projectionStoreEntryPath(provider, storeContentKey, projectionStoreDir);
          if (projectionStoreEntryValid(storeEntryDir, storeContentKey)) {
            if (fileExists(targetDir)) {
              fs.rmSync(targetDir, { recursive: true, force: true });
            }
            try {
              readProjectionFromStore(storeEntryDir, targetDir);
              storeHit = true;
            } catch {
              // Corrupt store entry: fall through to a full rebuild below.
            }
          }
        }

        if (!storeHit) {
          if (fileExists(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
          }
          copyDirectory(skillDir, targetDir);
          applyProviderRiskControls(provider, targetDir, manualOnly);
        }

        const projectionDigest = digestDirectoryExcludingMeta(targetDir);
        const record: ProjectionRecord = {
          provider,
          skill: skillName,
          origin: source.origin,
          canonicalPath: source.canonicalPath,
          projectionPath: path.relative(treeRoot, targetDir).replaceAll("\\", "/"),
          canonicalDigest,
          projectionDigest,
          rendererVersion: RENDERER_VERSION,
          manualOnly,
          risk: meta.risk,
        };
        writeFileAtomicSafe(
          path.join(targetDir, PROJECTION_META_FILE),
          `${JSON.stringify(record, null, 2)}\n`
        );

        if (storeHit) {
          storeHitCount += 1;
        } else {
          rebuiltCount += 1;
          if (source.origin !== "user" && storeEntryDir !== null && storeContentKey !== null) {
            const descriptor: ProjectionStoreDescriptor = {
              schemaVersion: PROJECTION_STORE_SCHEMA_VERSION,
              rendererVersion: RENDERER_VERSION,
              provider,
              origin: source.origin,
              canonicalDigest,
              manualOnly,
              contentKey: storeContentKey,
            };
            writeProjectionToStore(targetDir, storeEntryDir, descriptor);
          }
        }
        projections.push(record);
      }
    }

    const manifestPath = path.join(treeRoot, PROJECTION_MANIFEST_FILE);
    const manifest: ProjectionManifest = {
      schemaVersion: 1,
      rendererVersion: RENDERER_VERSION,
      providers,
      origins: originsForSources(skillSources),
      projectionCount: projections.length,
      generatedAt: new Date().toISOString(),
      projections,
      cache: {
        cachedCount,
        rebuiltCount,
        storeHitCount,
      },
    };
    writeFileAtomicSafe(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (manageProjectionRoot) {
      writeProjectionRootMarker(treeRoot);
    }

    return { projections, manifest };
  };

  if (!options.clean) {
    // In-place build against the live out-dir; behavior is unchanged.
    const built = renderProjectionTree(outDir);
    return {
      outDir,
      providers,
      projections: built.projections,
      manifestPath: path.join(outDir, PROJECTION_MANIFEST_FILE),
      manifest: built.manifest,
    };
  }

  // Staged --clean build: never delete or modify the live managed out-dir
  // before the complete replacement tree, manifest, and ownership marker
  // exist in a uniquely named staging sibling under the same parent.
  // The staging sibling lives directly under out-dir's parent, so recreate any
  // missing parent chain first (parity with the old recursive ensureDir);
  // guarded allocation re-checks symlinks before creating anything.
  const stagingParent = path.dirname(outDir);
  ensureDir(stagingParent);
  const stagingDir = allocateGuardedProjectionSiblingDir(
    stagingParent,
    PROJECTION_STAGING_DIR_PREFIX,
    "projection staging",
    sourceRoot
  );
  try {
    const built = renderProjectionTree(stagingDir);
    installStagedProjections({ outDir, stagingDir, sourceRoot });
    return {
      outDir,
      providers,
      projections: built.projections,
      manifestPath: path.join(outDir, PROJECTION_MANIFEST_FILE),
      manifest: built.manifest,
    };
  } catch (error) {
    let cleanupNote = "";
    try {
      removeOwnedProjectionTempDir(stagingDir);
    } catch (cleanupError) {
      cleanupNote = ` (additional staging cleanup failure: ${toMessage(cleanupError)})`;
    }
    throw new Error(`${toMessage(error)}${cleanupNote}`);
  }
}

interface ValidateProjectionRecordContext {
  poolRoot: string;
  outDir: string;
  provider: ConcreteProviderId;
  skillName: string;
  source: SkillProjectionSource;
  projectionDir: string;
}

function addFinding(
  findings: ValidateProjectionFinding[],
  code: string,
  message: string
): void {
  findings.push({ level: "ERROR", code, message });
}

function projectionRecordKey(record: Pick<ProjectionRecord, "provider" | "skill">): string {
  return `${record.provider}/${record.skill}`;
}

function readProjectionManifest(outDir: string, findings: ValidateProjectionFinding[]): ProjectionManifest | null {
  const manifestPath = path.join(outDir, PROJECTION_MANIFEST_FILE);
  if (!fileExists(manifestPath)) {
    addFinding(findings, "PROJECTION_MANIFEST_MISSING", `Missing projection manifest: ${manifestPath}`);
    return null;
  }
  try {
    const manifest = readJson<ProjectionManifest>(manifestPath);
    if (manifest.schemaVersion !== 1 || manifest.rendererVersion !== RENDERER_VERSION) {
      addFinding(findings, "PROJECTION_MANIFEST_INVALID", `Invalid projection manifest version: ${manifestPath}`);
    }
    return manifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addFinding(findings, "PROJECTION_MANIFEST_INVALID", `Invalid projection manifest JSON: ${message}`);
    return null;
  }
}

function validateProjectionManifest(
  manifest: ProjectionManifest | null,
  providers: ConcreteProviderId[],
  origins: SkillOrigin[],
  records: ProjectionRecord[],
  findings: ValidateProjectionFinding[]
): void {
  if (!manifest) {
    return;
  }
  if (JSON.stringify(manifest.providers) !== JSON.stringify(providers)) {
    addFinding(findings, "PROJECTION_MANIFEST_PROVIDER_MISMATCH", "Projection manifest provider list does not match validation providers");
  }
  if (JSON.stringify(manifest.origins || ["public"]) !== JSON.stringify(origins)) {
    addFinding(findings, "PROJECTION_MANIFEST_ORIGIN_MISMATCH", "Projection manifest origins do not match validation skill roots");
  }
  if (manifest.projectionCount !== records.length || manifest.projections.length !== records.length) {
    addFinding(findings, "PROJECTION_MANIFEST_COUNT_MISMATCH", "Projection manifest projection count does not match validated records");
  }
  const manifestRecords = new Map(manifest.projections.map((record) => [projectionRecordKey(record), record]));
  for (const record of records) {
    const manifestRecord = manifestRecords.get(projectionRecordKey(record));
    if (!manifestRecord) {
      addFinding(findings, "PROJECTION_MANIFEST_RECORD_MISSING", `Projection manifest missing record for ${record.provider}/${record.skill}`);
      continue;
    }
    for (const key of [
      "origin",
      "canonicalPath",
      "canonicalDigest",
      "projectionDigest",
      "rendererVersion",
      "projectionPath",
    ] as const) {
      if (manifestRecord[key] !== record[key]) {
        addFinding(findings, "PROJECTION_MANIFEST_RECORD_MISMATCH", `Projection manifest ${key} mismatch for ${record.provider}/${record.skill}`);
      }
    }
  }
}

function toPosixRelative(rootDir: string, targetPath: string): string {
  return path.relative(rootDir, targetPath).replaceAll("\\", "/");
}

function scanProjectionTreeSafety(
  projectionDir: string,
  provider: ConcreteProviderId,
  skillName: string,
  findings: ValidateProjectionFinding[]
): void {
  const stack = [projectionDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const linkStat = fs.lstatSync(entryPath);
      if (linkStat.isSymbolicLink()) {
        addFinding(
          findings,
          "PROJECTION_UNSAFE_ENTRY",
          `${provider}/${skillName} contains symlinked projection entry: ${entryPath}`
        );
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }
}

function validateCodexManualPolicy(
  projectionDir: string,
  provider: ConcreteProviderId,
  skillName: string,
  findings: ValidateProjectionFinding[]
): void {
  const policyPath = path.join(projectionDir, "agents", "openai.yaml");
  if (!fileExists(policyPath)) {
    addFinding(
      findings,
      "PROJECTION_MANUAL_POLICY_MISSING",
      `${provider}/${skillName} is manual-only but missing agents/openai.yaml`
    );
    return;
  }
  const policyText = fs.readFileSync(policyPath, "utf8");
  const expectedPolicyText = "policy:\n  allow_implicit_invocation: false\n";
  if (policyText !== expectedPolicyText) {
    addFinding(
      findings,
      "PROJECTION_MANUAL_POLICY_INVALID",
      `${provider}/${skillName} must set Codex allow_implicit_invocation to false`
    );
  }
}

function validateOpenCodeManualPolicy(
  projectionDir: string,
  provider: ConcreteProviderId,
  skillName: string,
  findings: ValidateProjectionFinding[]
): void {
  const policyPath = path.join(projectionDir, "opencode.permissions.json");
  if (!fileExists(policyPath)) {
    addFinding(
      findings,
      "PROJECTION_MANUAL_POLICY_MISSING",
      `${provider}/${skillName} is manual-only but missing opencode.permissions.json`
    );
    return;
  }
  const policy = readJson<Record<string, unknown>>(policyPath);
  const permissions = policy.permission;
  if (!permissions || typeof permissions !== "object") {
    addFinding(
      findings,
      "PROJECTION_MANUAL_POLICY_INVALID",
      `${provider}/${skillName} has invalid opencode.permissions.json`
    );
    return;
  }
  for (const key of ["edit", "bash", "webfetch", "websearch"]) {
    const value = (permissions as Record<string, unknown>)[key];
    if (value !== "ask" && value !== "deny") {
      addFinding(
        findings,
        "PROJECTION_MANUAL_POLICY_INVALID",
        `${provider}/${skillName} must set opencode ${key} permission to ask or deny`
      );
    }
  }
}

function validateProjectionRecord(
  context: ValidateProjectionRecordContext,
  record: ProjectionRecord,
  findings: ValidateProjectionFinding[]
): void {
  const { poolRoot, outDir, provider, skillName, source, projectionDir } = context;
  const skillDir = source.skillDir;
  if (record.provider !== provider) {
    addFinding(
      findings,
      "PROJECTION_PROVIDER_MISMATCH",
      `${provider}/${skillName} metadata provider mismatch. expected=${provider} actual=${record.provider}`
    );
  }
  if (record.skill !== skillName) {
    addFinding(
      findings,
      "PROJECTION_SKILL_MISMATCH",
      `${provider}/${skillName} metadata skill mismatch. expected=${skillName} actual=${record.skill}`
    );
  }
  if (record.origin !== source.origin) {
    addFinding(
      findings,
      "PROJECTION_ORIGIN_MISMATCH",
      `${provider}/${skillName} origin mismatch. expected=${source.origin} actual=${record.origin}`
    );
  }
  if (record.rendererVersion !== RENDERER_VERSION) {
    addFinding(
      findings,
      "PROJECTION_RENDERER_VERSION_MISMATCH",
      `${provider}/${skillName} renderer mismatch. expected=${RENDERER_VERSION} actual=${record.rendererVersion}`
    );
  }

  const expectedCanonicalPath = source.canonicalPath;
  if (record.canonicalPath !== expectedCanonicalPath) {
    addFinding(
      findings,
      "PROJECTION_CANONICAL_PATH_MISMATCH",
      `${provider}/${skillName} canonicalPath mismatch. expected=${expectedCanonicalPath} actual=${record.canonicalPath}`
    );
  }
  const expectedProjectionPath = toPosixRelative(outDir, projectionDir);
  if (record.projectionPath !== expectedProjectionPath) {
    addFinding(
      findings,
      "PROJECTION_PATH_MISMATCH",
      `${provider}/${skillName} projectionPath mismatch. expected=${expectedProjectionPath} actual=${record.projectionPath}`
    );
  }

  const actualCanonicalDigest = dirDigest(skillDir);
  if (record.canonicalDigest !== actualCanonicalDigest) {
    addFinding(
      findings,
      "PROJECTION_CANONICAL_DIGEST_MISMATCH",
      `${provider}/${skillName} canonical digest mismatch. expected=${actualCanonicalDigest} actual=${record.canonicalDigest}`
    );
  }

  const meta = readSkillMeta(skillDir, skillName);
  const overlay = readOverlay(poolRoot, provider, skillName);
  const expectedManualOnly = computeManualOnly(meta, overlay);
  if (record.manualOnly !== expectedManualOnly) {
    addFinding(
      findings,
      "PROJECTION_MANUAL_ONLY_MISMATCH",
      `${provider}/${skillName} manualOnly mismatch. expected=${expectedManualOnly} actual=${record.manualOnly}`
    );
  }
  if (!riskMatchesRecord(record.risk, meta.risk)) {
    addFinding(
      findings,
      "PROJECTION_RISK_MISMATCH",
      `${provider}/${skillName} risk metadata mismatch`
    );
  }

  const skillMarkdownPath = path.join(projectionDir, "SKILL.md");
  if (!fileExists(skillMarkdownPath)) {
    addFinding(findings, "PROJECTION_SKILL_MD_MISSING", `Missing SKILL.md: ${projectionDir}`);
  }
  scanProjectionTreeSafety(projectionDir, provider, skillName, findings);

  const actualDigest = digestDirectoryExcludingMeta(projectionDir);
  if (actualDigest !== record.projectionDigest) {
    addFinding(
      findings,
      "PROJECTION_DIGEST_MISMATCH",
      `${provider}/${skillName} digest mismatch. expected=${record.projectionDigest} actual=${actualDigest}`
    );
  }
  if (expectedManualOnly && provider === "codex") {
    validateCodexManualPolicy(projectionDir, provider, skillName, findings);
  }
  if (expectedManualOnly && provider === "claude-code" && fileExists(skillMarkdownPath)) {
    const skillText = fs.readFileSync(skillMarkdownPath, "utf8");
    if (!hasClaudeDisableModelInvocation(skillText)) {
      addFinding(
        findings,
        "PROJECTION_MANUAL_POLICY_MISSING",
        `${provider}/${skillName} is manual-only but missing disable-model-invocation`
      );
    }
  }
  if (expectedManualOnly && provider === "opencode") {
    validateOpenCodeManualPolicy(projectionDir, provider, skillName, findings);
  }
}

function validateProjections(options: ValidateProjectionsOptions): ValidateProjectionFinding[] {
  const sourceRoot = path.resolve(options.sourceRoot);
  const layout = resolveSourceLayout(sourceRoot, { requireSkills: false });
  const poolRoot = resolvePoolRoot(sourceRoot, layout);
  const outDir = path.resolve(options.outDir);
  readProviderCapabilities(poolRoot, options.providers);
  const validateSkillSourceOptions: { includeUser?: boolean; userRoot?: string } = {};
  if (options.includeUser !== undefined) validateSkillSourceOptions.includeUser = options.includeUser;
  if (options.userRoot !== undefined) validateSkillSourceOptions.userRoot = options.userRoot;
  const skillSources = collectSkillProjectionSources(layout.skillsDir, poolRoot, validateSkillSourceOptions);
  const expectedSkillSet = new Set(skillSources.map((source) => source.skillName));
  const findings: ValidateProjectionFinding[] = [];
  const manifest = readProjectionManifest(outDir, findings);
  const validatedRecords: ProjectionRecord[] = [];

  for (const provider of options.providers) {
    const providerDir = path.join(outDir, provider);
    if (!fileExists(providerDir)) {
      addFinding(findings, "PROJECTION_PROVIDER_MISSING", `Missing projection provider directory: ${providerDir}`);
      continue;
    }
    const providerStat = fs.lstatSync(providerDir);
    if (providerStat.isSymbolicLink() || !providerStat.isDirectory()) {
      addFinding(findings, "PROJECTION_UNSAFE_ENTRY", `Projection provider path must be a real directory: ${providerDir}`);
      continue;
    }

    const providerEntries = fs.readdirSync(providerDir, { withFileTypes: true });
    const actualSkillDirs: string[] = [];
    for (const entry of providerEntries) {
      const entryPath = path.join(providerDir, entry.name);
      if (entry.isSymbolicLink()) {
        addFinding(
          findings,
          "PROJECTION_UNSAFE_ENTRY",
          `Projection provider entry must not be symlinked: ${entryPath}`
        );
        continue;
      }
      if (!entry.isDirectory()) {
        addFinding(
          findings,
          "PROJECTION_UNSAFE_ENTRY",
          `Projection provider entry must be a directory: ${entryPath}`
        );
        continue;
      }
      actualSkillDirs.push(entry.name);
    }
    actualSkillDirs.sort((a, b) => a.localeCompare(b));
    for (const skillName of actualSkillDirs) {
      if (!expectedSkillSet.has(skillName)) {
        addFinding(
          findings,
          "PROJECTION_SKILL_UNEXPECTED",
          `Unexpected projection directory for ${provider}/${skillName}`
        );
      }
    }

    for (const source of skillSources) {
      const { skillName } = source;
      const projectionDir = path.join(providerDir, skillName);
      if (!fileExists(projectionDir)) {
        addFinding(
          findings,
          "PROJECTION_SKILL_MISSING",
          `Missing projection directory for ${provider}/${skillName}: ${projectionDir}`
        );
        continue;
      }
      const projectionStat = fs.lstatSync(projectionDir);
      if (projectionStat.isSymbolicLink() || !projectionStat.isDirectory()) {
        addFinding(
          findings,
          "PROJECTION_UNSAFE_ENTRY",
          `Projection skill path must be a real directory: ${projectionDir}`
        );
        continue;
      }
      const metaPath = path.join(projectionDir, PROJECTION_META_FILE);
      if (!fileExists(metaPath)) {
        addFinding(findings, "PROJECTION_META_MISSING", `Missing projection metadata: ${metaPath}`);
        continue;
      }
      const record = readJson<ProjectionRecord>(metaPath);
      validatedRecords.push(record);
      validateProjectionRecord(
        {
          poolRoot,
          outDir,
          provider,
          skillName,
          source,
          projectionDir,
        },
        record,
        findings
      );
    }
  }

  validateProjectionManifest(manifest, options.providers, originsForSources(skillSources), validatedRecords, findings);

  return findings;
}

export {
  buildProjections,
  findProjectionCleanObstruction,
  findProjectionSiblingPathObjection,
  parseProviderList,
  validateProjections,
};
export type {
  BuildProjectionsOptions,
  BuildProjectionsResult,
  ProjectionCleanTargetContext,
  ProjectionRecord,
  ValidateProjectionFinding,
  ValidateProjectionsOptions,
};
