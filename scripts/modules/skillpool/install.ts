#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCommand } from "../../lib/command.ts";
import { copyDirectory as copyDirectoryBase, digestTreeStrict, dirDigest, ensureDir, fileExists, hashFile, listFilesRecursive, readJson, withProjectMutationLock, writeFileAtomicSafe } from "../../lib/files.ts";
import { assertSafeGitRef } from "../../lib/git-ref.ts";
import { redactRemoteForDiagnostics } from "../../lib/redact.ts";
import { createApplyJournal, recoverApplyJournal, type ApplyJournalWriter } from "./apply-journal.ts";
import { readGlobalCoreManifest, resolveGlobalCoreSkills } from "../global-core.ts";
import {
  resolveSourceRootForPlan,
  verifyRepoRefExists,
  verifySignedTag,
} from "./cache.ts";
import { assertPathWithinProject, readAdapter, resolveSkillsForEntry } from "./entry.ts";
import { loadLockfile, resolveProjectDir } from "./lockfile.ts";
import { buildInstallPlan, compareSemver, normalizeSemver, validateLockShape } from "./plan.ts";
import { validateSourceLock } from "../skill-sys/source-lock.ts";
import {
  computeSourceChecksum,
  readSkillLifecycle,
  resolvePoolRoot,
  resolveSourceLayout,
} from "./source.ts";
import {
  getPoolVersion,
  runSkillLifecycleAudit,
  runSkillMetadataAudit,
  runUniversalContract,
} from "./validate.ts";
import { verifyReleaseArtifactPolicy } from "./verify-artifacts.ts";
import { assertNotHomeAgentsSkillsTarget } from "../home-agents-guard.ts";
import { assertNoSensitiveFindings, scanSensitiveFiles } from "./sensitive-scan.ts";
import {
  LIFECYCLE_RESOLUTION_SCHEMA,
  LifecycleResolutionError,
  resolveLifecycle,
  type LifecycleEntry,
} from "./lifecycle-resolution.ts";

interface SkillpoolInstallArgs {
  project?: string;
  lockfile?: string;
  source?: string;
  repo?: string;
  ref?: string;
  app?: string;
  dryRun?: boolean;
  "dry-run"?: boolean;
  refreshCache?: boolean;
  "refresh-cache"?: boolean;
  verifySignedTag?: boolean;
  "verify-signed-tag"?: boolean;
  expectedSourceSha256?: string;
  "expected-source-sha256"?: string;
  allowGlobalCoreSkills?: boolean;
  "allow-global-core-skills"?: boolean;
  debugState?: boolean;
  "debug-state"?: boolean;
  legacyRawInstall?: boolean;
  "legacy-raw-install"?: boolean;
  installMode?: string;
  "install-mode"?: string;
  projectionDir?: string;
  "projection-dir"?: string;
  [key: string]: string | boolean | string[] | undefined;
}

interface InstallOptions {
  universalContractScript: string;
  skillMetadataScript: string;
  skillLifecycleScript: string;
  runUniversalContract?: typeof runUniversalContract;
  runSkillMetadataAudit?: typeof runSkillMetadataAudit;
  runSkillLifecycleAudit?: typeof runSkillLifecycleAudit;
}

interface LifecycleIndex {
  path?: string;
  entriesBySkill?: Map<string, LifecycleEntry[]>;
}

interface ProjectionInstallMetadata {
  provider: string;
  skill: string;
  canonicalDigest: string;
  projectionDigest: string;
  rendererVersion: number;
  projectionPath?: string;
  manualOnly?: boolean;
}

interface InstallReportLine {
  app: string;
  skill: string;
  from: string;
  to: string;
  dryRun: boolean;
  installMode: "projection" | "copy";
  canonicalDigest: string;
  projection?: ProjectionInstallMetadata;
}

interface LifecycleInstallLine {
  app: string;
  to: string;
  dryRun: boolean;
}

interface InstallTransactionItem {
  kind: "directory" | "file";
  label: string;
  from: string;
  to: string;
  temp: string;
  backup: string;
  hadTarget?: boolean;
}

interface InstallStateSource {
  repo: string | null;
  ref: string | null;
  releaseTag?: string;
  sourceChecksum: string;
  manifestSha256?: string;
  skillBomSha256?: string;
}

const INSTALL_TMP_DIR = ".skill-sys-tmp";
const INSTALL_BACKUP_DIR = ".skill-sys-backup";

/**
 * Durable apply-journal step hooks: fired after each irreversible rename so a
 * crash leaves a journal that recovery can replay idempotently.
 */
interface InstallCommitHooks {
  onBackedUp?: (item: InstallTransactionItem) => void;
  onSwapped?: (item: InstallTransactionItem) => void;
}

function resolveGlobalCoreManifestPath(layout: { profilesDir?: string }, sourceRoot: string): string {
  const baseDir = layout.profilesDir ? path.resolve(layout.profilesDir, "..") : sourceRoot;
  return path.join(baseDir, "globals", "core.json");
}

function readGlobalCoreSkillSet(layout: { profilesDir?: string }, sourceRoot: string): Set<string> {
  const manifestPath = resolveGlobalCoreManifestPath(layout, sourceRoot);
  if (!fileExists(manifestPath)) {
    return new Set();
  }
  const { manifest } = readGlobalCoreManifest(manifestPath);
  return new Set(resolveGlobalCoreSkills(manifest));
}

function listActiveSkillNames(skillsRoot: string): string[] {
  if (!fileExists(skillsRoot)) {
    return [];
  }
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .filter((name) => fileExists(path.join(skillsRoot, name, "SKILL.md")))
    .sort((left, right) => left.localeCompare(right));
}

function formatLifecycleAdvice(
  skillName: string,
  lifecycle: LifecycleIndex,
  activeSkills?: ReadonlySet<string>,
): string {
  const entriesBySkill = lifecycle?.entriesBySkill || new Map<string, LifecycleEntry[]>();
  const entries = entriesBySkill.get(skillName) || [];
  if (!entries.length) {
    return "";
  }

  const entry = entries[0]!;
  const inferredActiveSkills = new Set<string>();
  if (!activeSkills) {
    for (const candidateEntries of entriesBySkill.values()) {
      for (const candidate of candidateEntries) {
        for (const replacement of candidate.replacements || []) {
          if (!entriesBySkill.has(replacement)) {
            inferredActiveSkills.add(replacement);
          }
        }
      }
    }
  }

  let resolution;
  try {
    resolution = resolveLifecycle(entriesBySkill, skillName, {
      activeSkills: activeSkills || inferredActiveSkills,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      `Lifecycle entry found for '${skillName}': ${entry.event} on ${entry.date}.`,
      `Lifecycle resolution failed: ${message}`,
      entry.reason ? `Reason: ${entry.reason}` : "",
      entry.agent_action ? `Agent action: ${entry.agent_action}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const replacement = resolution.terminal_event === "active"
    ? resolution.terminal
    : `no active replacement (terminal ${resolution.terminal_event})`;
  return [
    `Lifecycle entry found for '${skillName}': ${entry.event} on ${entry.date}.`,
    `Use instead: ${replacement}.`,
    resolution.path.length > 1 ? `Resolution path: ${resolution.path.join(" -> ")}.` : "",
    entry.reason ? `Reason: ${entry.reason}` : "",
    entry.agent_action ? `Agent action: ${entry.agent_action}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function installLifecycleLedger(
  lifecycle: LifecycleIndex,
  targetBase: string,
  dryRun: boolean
): string | null {
  if (!lifecycle?.path || !fileExists(lifecycle.path)) {
    return null;
  }
  const dest = path.join(targetBase, ".skill-lifecycle.json");
  if (!dryRun) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(lifecycle.path, dest);
  }
  return dest;
}

function createInstallId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

function copyDirectory(srcDir: string, destDir: string, dryRun = false): void {
  if (!fileExists(srcDir)) {
    throw new Error(`Source skill directory not found: ${srcDir}`);
  }

  copyDirectoryBase(srcDir, destDir, { dryRun });
}

function assertSafeSwapTarget(item: InstallTransactionItem): void {
  if (!fileExists(item.to)) {
    return;
  }
  const linkStat = fs.lstatSync(item.to);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked install target: ${item.to}`);
  }
  const stat = fs.statSync(item.to);
  if (item.kind === "directory" && !stat.isDirectory()) {
    throw new Error(`Refusing to replace non-directory install target: ${item.to}`);
  }
  if (item.kind === "file" && !stat.isFile()) {
    throw new Error(`Refusing to replace non-file install target: ${item.to}`);
  }
}

function assertSafeTransactionPath(root: string, candidate: string, label: string): void {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay within install target: ${candidatePath}`);
  }
  let current = rootPath;
  for (const segment of relative.split(path.sep)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing symlinked ${label}: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (segment && segment !== ".") current = path.join(current, segment);
  }
  try {
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing symlinked ${label}: ${current}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (fileExists(rootPath) && fileExists(candidatePath)) {
    const realRoot = fs.realpathSync(rootPath);
    const realCandidate = fs.realpathSync(candidatePath);
    const realRelative = path.relative(realRoot, realCandidate);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`${label} resolves outside install target: ${candidatePath}`);
    }
  }
}

function assertSafeTransactionItem(item: InstallTransactionItem, includeBackup = true): void {
  const targetBase = path.dirname(item.to);
  assertSafeTransactionPath(targetBase, item.to, "install target");
  assertSafeTransactionPath(path.join(targetBase, INSTALL_TMP_DIR), item.temp, "install temporary path");
  if (includeBackup) {
    assertSafeTransactionPath(path.join(targetBase, INSTALL_BACKUP_DIR), item.backup, "install backup path");
  }
}

function stageInstallItem(item: InstallTransactionItem): void {
  assertSafeTransactionItem(item, false);
  if (fileExists(item.temp)) {
    fs.rmSync(item.temp, { recursive: true, force: true });
  }
  ensureDir(path.dirname(item.temp));
  if (item.kind === "directory") {
    copyDirectory(item.from, item.temp, false);
    // Strict tree digests: symlinked entries abort staging instead of being
    // silently omitted from the compared manifests.
    const sourceDigest = digestTreeStrict(item.from);
    const tempDigest = digestTreeStrict(item.temp);
    if (sourceDigest !== tempDigest) {
      throw new Error(`Staged install digest mismatch for ${item.label}`);
    }
    return;
  }

  if (!fileExists(item.from)) {
    throw new Error(`Source file not found for ${item.label}: ${item.from}`);
  }
  fs.copyFileSync(item.from, item.temp);
  if (hashFile(item.from) !== hashFile(item.temp)) {
    throw new Error(`Staged install file digest mismatch for ${item.label}`);
  }
}

function rollbackInstallTransaction(swapped: InstallTransactionItem[]): void {
  for (const item of [...swapped].reverse()) {
    assertSafeTransactionItem(item);
    if (fileExists(item.to)) {
      fs.rmSync(item.to, { recursive: true, force: true });
    }
    if (item.hadTarget && fileExists(item.backup)) {
      // Mutation boundary: lstat the backup immediately before restoring and
      // refuse symlinks or a wrong entry type so rollback can never rename
      // attacker-influenced content into the target path.
      const backupStat = fs.lstatSync(item.backup);
      if (backupStat.isSymbolicLink()) {
        throw new Error(`Refusing to restore symlinked install backup: ${item.backup}`);
      }
      if (item.kind === "directory" && !backupStat.isDirectory()) {
        throw new Error(`Refusing to restore non-directory install backup: ${item.backup}`);
      }
      if (item.kind === "file" && !backupStat.isFile()) {
        throw new Error(`Refusing to restore non-file install backup: ${item.backup}`);
      }
      ensureDir(path.dirname(item.to));
      fs.renameSync(item.backup, item.to);
    }
  }
}

function commitInstallTransaction(items: InstallTransactionItem[], hooks: InstallCommitHooks = {}): void {
  const swapped: InstallTransactionItem[] = [];
  const backupRoots = new Set<string>();
  try {
    for (const item of items) {
      assertSafeTransactionItem(item);
      assertSafeSwapTarget(item);
    }
    for (const item of items) {
      assertSafeTransactionItem(item);
      ensureDir(path.dirname(item.to));
      item.hadTarget = fileExists(item.to);
      if (item.hadTarget) {
        ensureDir(path.dirname(item.backup));
        if (fileExists(item.backup)) {
          fs.rmSync(item.backup, { recursive: true, force: true });
        }
        fs.renameSync(item.to, item.backup);
        backupRoots.add(path.dirname(item.backup));
        // The old target has moved. Register it before the replacement rename so
        // a failure there still restores the backup.
        swapped.push(item);
        hooks.onBackedUp?.(item);
      }
      fs.renameSync(item.temp, item.to);
      hooks.onSwapped?.(item);
      if (!item.hadTarget) {
        swapped.push(item);
      }
    }
    for (const backupRoot of backupRoots) {
      fs.writeFileSync(path.join(backupRoot, ".complete"), "complete\n", "utf8");
    }
  } catch (error) {
    rollbackInstallTransaction(swapped);
    throw error;
  }
}

function cleanupInstallTemps(items: InstallTransactionItem[]): void {
  const roots = new Set(items.map((item) => path.dirname(item.temp)));
  for (const root of roots) {
    const targetBase = path.dirname(path.dirname(root));
    assertSafeTransactionPath(path.join(targetBase, INSTALL_TMP_DIR), root, "install temporary path");
    if (fileExists(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    const parent = path.dirname(root);
    if (fileExists(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
  }
}

function cleanupInstallBackups(items: InstallTransactionItem[]): void {
  const roots = new Set(items.map((item) => path.dirname(item.backup)));
  for (const root of roots) {
    const targetBase = path.dirname(path.dirname(root));
    assertSafeTransactionPath(path.join(targetBase, INSTALL_BACKUP_DIR), root, "install backup path");
    if (fileExists(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    const parent = path.dirname(root);
    if (fileExists(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
  }
}

function runInstallTransaction(items: InstallTransactionItem[], dryRun: boolean, hooks: InstallCommitHooks = {}): void {
  if (dryRun || !items.length) {
    return;
  }
  try {
    for (const item of items) {
      stageInstallItem(item);
    }
    commitInstallTransaction(items, hooks);
  } finally {
    cleanupInstallTemps(items);
  }
}

function toProjectRelative(projectDir: string, targetPath: string): string {
  const relativePath = path.relative(projectDir, targetPath);
  if (!relativePath || relativePath === ".") {
    return ".";
  }
  return relativePath.split(path.sep).join("/");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function buildStateSource(
  plan: { repo: unknown; ref: unknown; policy: unknown },
  sourceChecksum: string
): InstallStateSource {
  const policy = (plan.policy as Record<string, unknown>) || {};
  const source: InstallStateSource = {
    repo: stringOrNull(plan.repo),
    ref: stringOrNull(plan.ref),
    sourceChecksum,
  };
  const releaseTag = stringOrNull(policy.releaseTag);
  const releaseManifestSha256 = stringOrNull(policy.expectedReleaseManifestSha256);
  const skillBomSha256 = stringOrNull(policy.expectedSkillBomSha256);
  if (releaseTag) {
    source.releaseTag = releaseTag;
  }
  if (releaseManifestSha256) {
    source.manifestSha256 = releaseManifestSha256;
  }
  if (skillBomSha256) {
    source.skillBomSha256 = skillBomSha256;
  }
  return source;
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  writeFileAtomicSafe(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function resolveLocalRefCommit(sourceRoot: string, ref: string): string {
  ref = assertSafeGitRef(ref);
  const result = runCommand(["git", "-C", sourceRoot, "rev-parse", "--verify", `${ref}^{commit}`], {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
  });
  if (result.code !== 0 || !result.stdout) {
    throw new Error(`Git ref not found in source checkout: ${ref}`);
  }
  return result.stdout.trim().toLowerCase();
}

function assertUnsupportedOriginPolicy(policy: Record<string, unknown>): void {
  if (policy.requireCosignBundles === true || policy.cosign !== undefined) {
    throw new Error(
      "UNSUPPORTED_PROVENANCE_POLICY: Cosign bundle verification is not implemented by skillpool install; run skill-sys verify-origin after this policy is supported"
    );
  }
  if (policy.requireGithubAttestation === true || policy.githubAttestation !== undefined) {
    throw new Error(
      "UNSUPPORTED_PROVENANCE_POLICY: GitHub artifact attestation verification is not implemented by skillpool install; run skill-sys verify-origin after this policy is supported"
    );
  }
}

interface SourceLockBinding {
  path?: unknown;
  sha256?: unknown;
  entryName?: unknown;
}

/**
 * Verify the optional `sourceLock` evidence binding recorded in a primary
 * lockfile. The source lock is corroborating evidence only: it must resolve to
 * a project-contained regular non-symlink file whose exact bytes match the
 * pinned SHA-256 and whose selected entry matches this lockfile's repo, ref,
 * and policy sourceCommit exactly. Policy commit/checksum/projection pins stay
 * independently authoritative and are verified by their existing code paths.
 */
function verifySourceLockEvidence(
  projectDir: string,
  binding: SourceLockBinding,
  expected: { repo: unknown; ref: unknown; sourceCommit: unknown }
): void {
  if (typeof binding.path !== "string" || !binding.path.trim()) {
    throw new Error("lockfile.sourceLock.path must be a non-empty string");
  }
  if (typeof binding.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(binding.sha256)) {
    throw new Error("lockfile.sourceLock.sha256 must be 64-char hex string");
  }
  if (typeof binding.entryName !== "string" || !binding.entryName.trim()) {
    throw new Error("lockfile.sourceLock.entryName must be a non-empty string");
  }

  const sourceLockPath = path.resolve(projectDir, binding.path);
  assertPathWithinProject(projectDir, sourceLockPath, "Source lock path");

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(sourceLockPath);
  } catch (_error) {
    throw new Error(`Source lock file not found: ${sourceLockPath}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to read symlinked source lock file: ${sourceLockPath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Source lock path is not a regular file: ${sourceLockPath}`);
  }

  const raw = fs.readFileSync(sourceLockPath);
  const actualSha256 = crypto.createHash("sha256").update(raw).digest("hex");
  if (actualSha256 !== binding.sha256.toLowerCase()) {
    throw new Error(
      `Source lock bytes do not match the pinned sha256 for ${binding.path}. expected=${binding.sha256.toLowerCase()} actual=${actualSha256}`
    );
  }

  // Parse exactly the hashed buffer (no re-read) so validation can never see
  // different bytes than the pinned digest, and keep the source-lock path in
  // the error for malformed JSON.
  let parsedSourceLock: unknown;
  try {
    parsedSourceLock = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON at ${sourceLockPath}: ${detail}`);
  }
  const sourceLock = validateSourceLock(parsedSourceLock);
  const entries = sourceLock.sources.filter((entry) => entry.name === binding.entryName);
  if (entries.length !== 1) {
    throw new Error(`Source lock has no unique entry named '${binding.entryName}': ${binding.path}`);
  }
  const entry = entries[0]!;
  if (entry.source !== String(expected.repo)) {
    // Equality above uses the raw values; only the rendered diagnostics are
    // redacted so credential-bearing remotes never reach error output.
    throw new Error(
      `Source lock entry '${entry.name}' does not match lockfile repo. expected=${redactRemoteForDiagnostics(String(expected.repo))} actual=${redactRemoteForDiagnostics(entry.source)}`
    );
  }
  if (entry.ref !== String(expected.ref)) {
    throw new Error(
      `Source lock entry '${entry.name}' does not match lockfile ref. expected=${String(expected.ref)} actual=${entry.ref}`
    );
  }
  if (
    typeof expected.sourceCommit !== "string" ||
    !expected.sourceCommit ||
    entry.resolvedCommit.toLowerCase() !== expected.sourceCommit.toLowerCase()
  ) {
    throw new Error(
      `Source lock entry '${entry.name}' resolvedCommit does not match policy sourceCommit. expected=${String(expected.sourceCommit)} actual=${entry.resolvedCommit}`
    );
  }

  console.log(`Verified source lock evidence: ${binding.path} (${binding.entryName})`);
}

function projectionDigestExcludingMeta(dirPath: string): string {
  const files = listFilesRecursive(dirPath)
    .filter((filePath) => path.basename(filePath) !== "projection.meta.json")
    .map((filePath) => {
      const rel = path.relative(dirPath, filePath).replaceAll("\\", "/");
      return `${rel}\0${hashFile(filePath)}`;
    })
    .join("\n");
  return crypto.createHash("sha256").update(files).digest("hex");
}

function projectionPolicyEntries(policy: Record<string, unknown>): ProjectionInstallMetadata[] {
  const entries = policy.expectedProjectionDigests;
  return Array.isArray(entries) ? entries as ProjectionInstallMetadata[] : [];
}

function expectedProjectionFor(
  policy: Record<string, unknown>,
  provider: string,
  skillName: string
): ProjectionInstallMetadata | null {
  return projectionPolicyEntries(policy).find((entry) => {
    const entryProvider = typeof entry.provider === "string" ? entry.provider : (entry as ProjectionInstallMetadata & { app?: string }).app;
    return entryProvider === provider && entry.skill === skillName;
  }) || null;
}

function assertNoSymlinkEntries(rootDir: string, label: string): void {
  const rootStat = fs.lstatSync(rootDir);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked ${label}: ${rootDir}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${rootDir}`);
  }

  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to use symlinked projection entry in ${label}: ${entryPath}`);
      }
      if (stat.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }
}

function resolveProjectionSkillSource(
  projectionRoot: string | null,
  policy: Record<string, unknown>,
  app: string,
  skillName: string,
  canonicalSkillDir: string
): { sourceDir: string; metadata?: ProjectionInstallMetadata } {
  if (!projectionRoot) {
    return { sourceDir: canonicalSkillDir };
  }
  const projectionSkillDir = path.join(projectionRoot, app, skillName);
  if (!fileExists(projectionSkillDir)) {
    throw new Error(`Projection directory not found for ${app}/${skillName}: ${projectionSkillDir}`);
  }
  assertNoSymlinkEntries(projectionSkillDir, `projection for ${app}/${skillName}`);
  const metaPath = path.join(projectionSkillDir, "projection.meta.json");
  if (!fileExists(metaPath)) {
    throw new Error(`Projection metadata missing for ${app}/${skillName}: ${metaPath}`);
  }
  const metadata = readJson<ProjectionInstallMetadata>(metaPath);
  if (metadata.provider !== app || metadata.skill !== skillName) {
    throw new Error(`Projection metadata mismatch for ${app}/${skillName}`);
  }
  const canonicalDigest = dirDigest(canonicalSkillDir);
  if (metadata.canonicalDigest !== canonicalDigest) {
    throw new Error(`Projection canonical digest mismatch for ${app}/${skillName}. expected=${canonicalDigest} actual=${metadata.canonicalDigest}`);
  }
  const actualProjectionDigest = projectionDigestExcludingMeta(projectionSkillDir);
  if (metadata.projectionDigest !== actualProjectionDigest) {
    throw new Error(`Projection digest mismatch for ${app}/${skillName}. expected=${metadata.projectionDigest} actual=${actualProjectionDigest}`);
  }
  const expected = expectedProjectionFor(policy, app, skillName);
  if (policy.requireProjectionDigests === true && !expected) {
    throw new Error(`lockfile policy expectedProjectionDigests missing ${app}/${skillName}`);
  }
  if (expected) {
    for (const key of ["canonicalDigest", "projectionDigest", "rendererVersion"] as const) {
      if (expected[key] !== metadata[key]) {
        throw new Error(`Projection policy ${key} mismatch for ${app}/${skillName}`);
      }
    }
  }
  return { sourceDir: projectionSkillDir, metadata };
}

function installCommand(args: SkillpoolInstallArgs, options: InstallOptions): void {
  const projectDir = resolveProjectDir(args);
  const dryRun = Boolean(args["dry-run"] || args.dryRun);
  const refreshCache = Boolean(args["refresh-cache"] || args.refreshCache);
  const debugState = Boolean(args["debug-state"] || args.debugState);
  const legacyRawInstall = Boolean(args["legacy-raw-install"] || args.legacyRawInstall);
  const installMode = String(args.installMode || args["install-mode"] || "");
  if (installMode === "symlink") {
    throw new Error("install-mode 'symlink' is dev/team-only and not allowed in public or release install");
  }
  if (installMode && installMode !== "projection" && installMode !== "copy") {
    throw new Error(`Invalid install-mode '${installMode}'. Expected projection or copy.`);
  }
  // Map install-mode to legacy semantics
  const effectiveCopyMode = legacyRawInstall || installMode === "copy";
  const projectionDirArg = args["projection-dir"] || args.projectionDir || null;
  const verifySignedTagFlag = Boolean(args["verify-signed-tag"] || args.verifySignedTag);
  const expectedChecksumFlag =
    args["expected-source-sha256"] || args.expectedSourceSha256 || null;

  let lock: unknown = null;
  let lockfilePath: string | null = null;

  if (!args.app) {
    const loaded = loadLockfile(projectDir, args);
    lock = loaded.lock;
    lockfilePath = loaded.lockfilePath;

    const lockErrors = validateLockShape(lock);
    if (lockErrors.length) {
      throw new Error(`Invalid lockfile (${lockfilePath}):\n- ${lockErrors.join("\n- ")}`);
    }
  }

  const plan = buildInstallPlan(args, lock as { repo?: unknown; ref?: unknown; installs?: unknown; policy?: unknown } | null);
  const policy: Record<string, unknown> = (plan.policy as Record<string, unknown>) || {};
  assertUnsupportedOriginPolicy(policy);
  if (!plan.source && !plan.repo) {
    throw new Error("Install requires --source or --repo (or lockfile with repo)");
  }
  if (!effectiveCopyMode && !projectionDirArg) {
    throw new Error(
      "Projection-backed install is required; pass --projection-dir, --install-mode copy, or explicitly use --legacy-raw-install"
    );
  }

  // Source-lock evidence must validate before any source resolution or target
  // mutation, so a tampered or mismatched binding fails closed without
  // touching the cache, network, or project targets.
  if (lock && typeof lock === "object" && (lock as { sourceLock?: unknown }).sourceLock !== undefined) {
    const binding = (lock as { sourceLock?: unknown }).sourceLock;
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw new Error("Invalid lockfile: lockfile.sourceLock must be an object when provided");
    }
    verifySourceLockEvidence(projectDir, binding as SourceLockBinding, {
      repo: plan.repo,
      ref: plan.ref,
      sourceCommit: policy.sourceCommit,
    });
  }

  const requireRefExists = (policy.requireRefExists as boolean) !== false;
  if (requireRefExists && !plan.source && plan.repo && plan.ref) {
    verifyRepoRefExists(plan.repo as string, plan.ref as string);
  }

  const sourceRoot = resolveSourceRootForPlan(plan, refreshCache);
  const projectionRoot = projectionDirArg ? path.resolve(projectDir, String(projectionDirArg)) : null;
  if (projectionRoot) {
    assertPathWithinProject(projectDir, projectionRoot, "Projection directory");
  }
  const layout = resolveSourceLayout(sourceRoot, { requireSkills: true });
  const poolRoot = resolvePoolRoot(sourceRoot, layout);
  const sourceSkillsDir = layout.skillsDir;
  const activeSkills = new Set(listActiveSkillNames(sourceSkillsDir));
  const universalContract = (options.runUniversalContract ?? runUniversalContract)(
    sourceSkillsDir,
    options.universalContractScript
  );

  if (!universalContract.ok) {
    // Audit failure output is captured child stdout/stderr over untrusted
    // source content, so it is never echoed here; stage, source identity,
    // and a rerun pointer stay instead.
    throw new Error(
      `Source skills failed universal contract check (${sourceSkillsDir}); audit details withheld. Rerun: bun ${options.universalContractScript} --skills-root ${sourceSkillsDir}`
    );
  }

  const metadataAudit = (options.runSkillMetadataAudit ?? runSkillMetadataAudit)(
    sourceSkillsDir,
    options.skillMetadataScript
  );
  if (!metadataAudit.ok) {
    throw new Error(
      `Source skills failed metadata audit (${sourceSkillsDir}); audit details withheld. Rerun: bun ${options.skillMetadataScript} audit --skills-root ${sourceSkillsDir} --strict`
    );
  }

  const lifecycleAudit = (options.runSkillLifecycleAudit ?? runSkillLifecycleAudit)(
    poolRoot,
    sourceSkillsDir,
    options.skillLifecycleScript
  );
  if (!lifecycleAudit.ok) {
    throw new Error(
      `Source skills failed skill lifecycle audit (${poolRoot}); audit details withheld. Rerun the skill lifecycle audit script against this pool for details`
    );
  }

  const poolVersion = getPoolVersion(sourceRoot, layout);
  const minPoolVersion = policy.minPoolVersion as string | undefined;
  if (minPoolVersion) {
    const minVersion = normalizeSemver(minPoolVersion);
    if (!poolVersion) {
      throw new Error(
        `lockfile policy requires minPoolVersion=${minPoolVersion}, but source has no package version`
      );
    }
    if (minVersion && compareSemver(poolVersion, minVersion) < 0) {
      throw new Error(
        `Source pool version ${poolVersion} is below required minPoolVersion ${minVersion}`
      );
    }
  }

  const shouldVerifySignedTag = verifySignedTagFlag || Boolean(policy.requireSignedTag);
  if (shouldVerifySignedTag && !plan.ref) {
    throw new Error("Signed tags verification requested but no ref was provided");
  }
  if (shouldVerifySignedTag) {
    verifySignedTag(sourceRoot, plan.ref as string);
  }

  const requiredSourceCommit = policy.sourceCommit;
  if (policy.requireSourceCommit && typeof requiredSourceCommit !== "string") {
    throw new Error("lockfile policy requires sourceCommit when requireSourceCommit=true");
  }
  if (typeof requiredSourceCommit === "string") {
    if (!plan.ref) {
      throw new Error("lockfile policy sourceCommit verification requires ref");
    }
    const actualCommit = resolveLocalRefCommit(sourceRoot, plan.ref as string);
    if (actualCommit !== requiredSourceCommit.toLowerCase()) {
      throw new Error(
        `Source commit mismatch. expected=${requiredSourceCommit.toLowerCase()} actual=${actualCommit}`
      );
    }
    console.log(`Verified source commit: ${actualCommit}`);
  }

  let sourceChecksum: string | null = null;
  const getSourceChecksum = (): string => {
    if (!sourceChecksum) {
      sourceChecksum = computeSourceChecksum(sourceRoot, layout);
    }
    return sourceChecksum;
  };

  const expectedChecksum = (expectedChecksumFlag as string | null) || (policy.expectedSourceSha256 as string | null) || null;
  if (policy.requireSourceChecksum && !expectedChecksum) {
    throw new Error("lockfile policy requires expectedSourceSha256 when requireSourceChecksum=true");
  }
  if (expectedChecksum) {
    const actualChecksum = getSourceChecksum();
    if (actualChecksum.toLowerCase() !== String(expectedChecksum).toLowerCase()) {
      throw new Error(
        `Source checksum mismatch. expected=${expectedChecksum} actual=${actualChecksum}`
      );
    }
    console.log(`Verified source checksum: ${actualChecksum}`);
  }

  verifyReleaseArtifactPolicy({
    sourceRoot,
    layout,
    ref: plan.ref,
    policy,
  });

  const report: InstallReportLine[] = [];
  const lifecycle = readSkillLifecycle(sourceRoot, layout);
  const lifecycleInstalls: LifecycleInstallLine[] = [];
  const globalCoreSkills = readGlobalCoreSkillSet(layout, sourceRoot);
  const allowGlobalCoreSkills = Boolean(
    args["allow-global-core-skills"] ||
      args.allowGlobalCoreSkills ||
      policy.allowGlobalCoreProjectSkills
  );
  const skippedGlobalCoreSkills: InstallReportLine[] = [];
  const installPlans = (plan.installs as Array<Record<string, unknown>>).map((installEntry: Record<string, unknown>) => {
    const app = String(installEntry.app);
    const adapter = readAdapter(layout, app);
    const targetBase = path.resolve(projectDir, adapter.targetPath);
    assertPathWithinProject(projectDir, targetBase, `Adapter '${app}' targetPath`);
    assertNotHomeAgentsSkillsTarget(targetBase, `Adapter '${app}' targetPath`);
    const resolvedSkills = resolveSkillsForEntry(layout, installEntry) as string[];
    const skills = allowGlobalCoreSkills
      ? resolvedSkills
      : resolvedSkills.filter((skillName) => {
          if (!globalCoreSkills.has(skillName)) {
            return true;
          }
          skippedGlobalCoreSkills.push({
            app,
            skill: skillName,
            from: path.join(sourceSkillsDir, skillName),
            to: path.join(targetBase, skillName),
            dryRun,
            installMode: effectiveCopyMode ? "copy" : "projection",
            canonicalDigest: dirDigest(path.join(sourceSkillsDir, skillName)),
          });
          return false;
        });
    return {
      app,
      skills,
      targetBase,
    };
  });

  const missingSkillMessages: string[] = [];
  for (const installPlan of installPlans) {
    for (const skillName of installPlan.skills) {
      const srcSkillDir = path.join(sourceSkillsDir, skillName);
      const srcSkillEntry = path.join(srcSkillDir, "SKILL.md");
      if (!fileExists(srcSkillEntry)) {
        const advice = formatLifecycleAdvice(skillName, lifecycle, activeSkills);
        missingSkillMessages.push(
          [
            `Skill '${skillName}' is not active in source (${srcSkillDir}): missing SKILL.md`,
            advice,
          ]
            .filter(Boolean)
            .join("\n")
        );
      }
    }
  }

  if (missingSkillMessages.length) {
    throw new Error(missingSkillMessages.join("\n\n"));
  }

  const installedTargets = new Set<string>();
  const installedLifecycleTargets = new Set<string>();
  for (const installPlan of installPlans) {
    for (const skillName of installPlan.skills) {
      const srcSkillDir = path.join(sourceSkillsDir, skillName);
      assertNoSymlinkEntries(srcSkillDir, `canonical skill '${skillName}'`);
      assertNoSensitiveFindings(
        scanSensitiveFiles({
          rootDir: srcSkillDir,
          baseDir: sourceRoot,
        }),
        `Skill '${skillName}'`
      );
    }
  }

  const targetContents = new Map<string, { digest: string; label: string }>();
  for (const { app, skills, targetBase } of installPlans) {
    for (const skillName of skills) {
      const canonicalSkillDir = path.join(sourceSkillsDir, skillName);
      const projectionSource = resolveProjectionSkillSource(projectionRoot, policy, app, skillName, canonicalSkillDir);
      const target = path.join(targetBase, skillName);
      const digest = dirDigest(projectionSource.sourceDir);
      const existing = targetContents.get(target);
      if (existing && existing.digest !== digest) {
        throw new Error(`Conflicting install target '${target}' for ${existing.label} and ${app}/${skillName}: projected bytes differ`);
      }
      if (!existing) {
        targetContents.set(target, { digest, label: `${app}/${skillName}` });
      }
    }
  }

  const installId = createInstallId();
  const transactionItems: InstallTransactionItem[] = [];
  for (const installPlan of installPlans) {
    const { app, skills, targetBase } = installPlan;
    const lifecycleSource = lifecycle?.path && fileExists(lifecycle.path) ? lifecycle.path : null;
    const lifecycleDest = lifecycleSource ? path.join(targetBase, ".skill-lifecycle.json") : null;
    if (lifecycleDest && !installedLifecycleTargets.has(lifecycleDest)) {
      transactionItems.push({
        kind: "file",
        label: `${app}/lifecycle`,
        from: lifecycleSource as string,
        to: lifecycleDest,
        temp: path.join(targetBase, INSTALL_TMP_DIR, installId, ".skill-lifecycle.json"),
        backup: path.join(targetBase, INSTALL_BACKUP_DIR, installId, ".skill-lifecycle.json"),
      });
      lifecycleInstalls.push({
        app,
        to: lifecycleDest,
        dryRun,
      });
      installedLifecycleTargets.add(lifecycleDest);
    }

    for (const skillName of skills) {
      const canonicalSkillDir = path.join(sourceSkillsDir, skillName);
      const canonicalDigest = dirDigest(canonicalSkillDir);
      const projectionSource = resolveProjectionSkillSource(projectionRoot, policy, app, skillName, canonicalSkillDir);
      const srcSkillDir = projectionSource.sourceDir;
      const destSkillDir = path.join(targetBase, skillName);
      if (installedTargets.has(destSkillDir)) {
        continue;
      }
      installedTargets.add(destSkillDir);
      const reportLine: InstallReportLine = {
        app,
        skill: skillName,
        from: srcSkillDir,
        to: destSkillDir,
        dryRun,
        installMode: projectionSource.metadata ? "projection" : "copy",
        canonicalDigest,
      };
      if (projectionSource.metadata) {
        reportLine.projection = projectionSource.metadata;
      }
      report.push(reportLine);
      transactionItems.push({
        kind: "directory",
        label: `${app}/${skillName}`,
        from: srcSkillDir,
        to: destSkillDir,
        temp: path.join(targetBase, INSTALL_TMP_DIR, installId, skillName),
        backup: path.join(targetBase, INSTALL_BACKUP_DIR, installId, skillName),
      });
    }
  }

  const statePath = path.join(projectDir, ".skills.state.json");

  if (dryRun) {
    runInstallTransaction(transactionItems, true);
  } else {
    // One canonical lock acquisition per command, held across the target
    // filesystem mutation AND the `.skills.state.json` read-modify-write plus
    // reconciliation, so a concurrent APPLY command fails deterministically
    // with targets and state left unchanged. A leftover apply journal from a
    // crashed run is recovered before planning/mutation.
    withProjectMutationLock(projectDir, () => {
      recoverApplyJournal(projectDir);
      const existingState = fileExists(statePath) ? readJson<Record<string, unknown>>(statePath) : {};
      const previousInstalled = Array.isArray(existingState.installed) ? existingState.installed : [];
      const previousLifecycle = Array.isArray(existingState.lifecycle) ? existingState.lifecycle : [];
      const nextSource = buildStateSource(plan, getSourceChecksum());
      const replacedTargets = new Set(report.map((line) => toProjectRelative(projectDir, line.to)));
      const hasRemainingManagedRecord = previousInstalled.some((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const record = entry as Record<string, unknown>;
        return record.managedBy === "skill-sys" && typeof record.target === "string" && !replacedTargets.has(record.target);
      });
      if (hasRemainingManagedRecord && JSON.stringify(existingState.source) !== JSON.stringify(nextSource)) {
        throw new Error("Cannot mix managed installs from different state.source identities; replace all managed targets or use the same source");
      }
      const installed = previousInstalled.filter((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
        const record = entry as Record<string, unknown>;
        return !report.some((line) => record.target === toProjectRelative(projectDir, line.to));
      });
      const lifecycleState = previousLifecycle.filter((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
        const record = entry as Record<string, unknown>;
        return !lifecycleInstalls.some((line) => record.target === toProjectRelative(projectDir, line.to));
      });
      const minimalState = {
        schemaVersion: 2,
        mode: debugState ? "debug" : "minimal",
        updatedAt: new Date().toISOString(),
        source: nextSource,
        installed: [...installed, ...report.map((line) => ({
          managedBy: "skill-sys",
          app: line.app,
          skill: line.skill,
          target: toProjectRelative(projectDir, line.to),
          installMode: line.installMode,
          canonicalDigest: line.canonicalDigest,
          // Staging verifies the installed directory digest against this source
          // (strict tree digest, symlinks rejected) before any target is
          // replaced, so state construction stays pre-commit and the recorded
          // skillDigest matches the strict digests recovery/remove/sync
          // recompute from disk.
          skillDigest: digestTreeStrict(line.from),
          ...(line.projection
            ? {
                projection: {
                  provider: line.projection.provider,
                  skill: line.projection.skill,
                  canonicalDigest: line.projection.canonicalDigest,
                  projectionDigest: line.projection.projectionDigest,
                  rendererVersion: line.projection.rendererVersion,
                  projectionPath: line.projection.projectionPath,
                },
              }
            : {}),
        }))],
        lifecycle: [...lifecycleState, ...lifecycleInstalls.map((line) => ({
          app: line.app,
          target: toProjectRelative(projectDir, line.to),
        }))],
      };

      const statePayload: unknown = debugState
        ? {
            ...minimalState,
            debug: {
              sourcePath: plan.source ? path.resolve(plan.source as string) : sourceRoot,
              policy: policy || null,
              installed: report,
              lifecycle: lifecycleInstalls,
            },
          }
        : minimalState;

      // W7 durable apply journal: written before the first irreversible
      // rename, updated after each one, removed only after the state write
      // commits. Any failure path recovers (or deliberately keeps) the journal.
      const writer: ApplyJournalWriter = createApplyJournal(projectDir, {
        applyId: installId,
        command: "install",
        items: transactionItems.map((item) => ({
          action: "swap" as const,
          target: toProjectRelative(projectDir, item.to),
          temp: toProjectRelative(projectDir, item.temp),
          backup: toProjectRelative(projectDir, item.backup),
          hadTarget: fileExists(item.to),
        })),
      });
      const hooks = {
        onBackedUp: (item: InstallTransactionItem) => writer.markBackedUp(toProjectRelative(projectDir, item.to)),
        onSwapped: (item: InstallTransactionItem) => writer.markSwapped(toProjectRelative(projectDir, item.to)),
      };
      try {
        runInstallTransaction(transactionItems, false, hooks);
      } catch (applyError) {
        try {
          recoverApplyJournal(projectDir);
        } catch (recoveryError) {
          throw new Error(
            `Install failed (${String(applyError)}) and apply-journal recovery failed: ${String(recoveryError)}`,
            { cause: applyError instanceof Error ? applyError : undefined }
          );
        }
        throw applyError;
      }

      try {
        writeJsonAtomic(statePath, statePayload);
      } catch (stateError) {
        try {
          rollbackInstallTransaction(transactionItems);
          cleanupInstallBackups(transactionItems);
        } catch (rollbackError) {
          throw new Error(
            `Install state write failed and filesystem compensation failed: ${String(stateError)}; ${String(rollbackError)}`
          );
        }
        // The filesystem compensation restored the pre-apply world; reconcile
        // the journal flags with it. A reconciliation failure must not be
        // swallowed silently: compose it with the original state-write error
        // and keep the journal so the next locked APPLY can retry recovery
        // idempotently.
        try {
          recoverApplyJournal(projectDir);
        } catch (recoveryError) {
          throw composeStateWriteRecoveryFailure(stateError, recoveryError);
        }
        throw stateError;
      }
      writer.close();
    });
  }

  console.log(`Installed entries: ${report.length}`);
  report.forEach((line) => {
    console.log(`- ${line.app}: ${line.skill} -> ${toProjectRelative(projectDir, line.to)}${dryRun ? " (dry-run)" : ""}`);
  });
  skippedGlobalCoreSkills.forEach((line) => {
    console.log(`- ${line.app}: ${line.skill} skipped (global-core managed, not project-local)`);
  });
  lifecycleInstalls.forEach((line) => {
    console.log(`- ${line.app}: lifecycle -> ${toProjectRelative(projectDir, line.to)}${dryRun ? " (dry-run)" : ""}`);
  });

  if (lockfilePath) {
    console.log(`Lockfile: ${toProjectRelative(projectDir, lockfilePath)}`);
  }
  console.log(`State: ${toProjectRelative(projectDir, statePath)}${dryRun ? " (not written in dry-run)" : ""}`);
}

/**
 * Compose a failed post-compensation journal reconciliation with the original
 * state-write error so neither failure is swallowed silently. The journal is
 * deliberately kept: recovery retries idempotently on the next locked APPLY.
 */
function composeStateWriteRecoveryFailure(stateError: unknown, recoveryError: unknown): Error {
  return new Error(
    `Install state write failed (${String(stateError)}) and apply-journal reconciliation also failed: ${String(recoveryError)}; journal preserved for manual recovery`,
    { cause: stateError instanceof Error ? stateError : undefined }
  );
}

export {
  composeStateWriteRecoveryFailure,
  LIFECYCLE_RESOLUTION_SCHEMA,
  LifecycleResolutionError,
  copyDirectory,
  commitInstallTransaction,
  formatLifecycleAdvice,
  installCommand,
  rollbackInstallTransaction,
  resolveLifecycle,
  runInstallTransaction,
  stageInstallItem,
};
