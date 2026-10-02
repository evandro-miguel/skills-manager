#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  copyDirectory,
  digestTreeStrict,
  dirDigest,
  ensureDir,
  fileExists,
  readJson,
  withProjectMutationLock,
  writeFileAtomicSafe,
} from "../lib/files.ts";
import { assertNotHomeAgentsSkillsTarget } from "../modules/home-agents-guard.ts";
import { createApplyJournal, recoverApplyJournal } from "../modules/skillpool/apply-journal.ts";
import { assertPathWithinProject, normalizeSkillNameStrict, readAdapter, readProfile } from "../modules/skillpool/entry.ts";
import { assertNoSensitiveFindings, scanSensitiveFiles } from "../modules/skillpool/sensitive-scan.ts";
import { resolvePoolRoot, resolveSourceLayout } from "../modules/skillpool/source.ts";

interface SyncPlanArgs {
  source: string;
  project: string;
  profile: string;
  app: string;
  apply: boolean;
  plan: boolean;
  explain: boolean;
  repair: boolean;
  json: boolean;
  help: boolean;
}

interface StateInstalledEntry {
  managedBy?: unknown;
  app?: unknown;
  skill?: unknown;
  target?: unknown;
  skillDigest?: unknown;
}

interface SyncPlanItem {
  app: string;
  skill: string;
  target: string;
  skillDigest: string;
  previousDigest?: string;
  reason: string;
}

interface SyncPlanResult {
  source: {
    path: string;
    profile: string;
    app: string;
    target: string;
  };
  install: {
    add: SyncPlanItem[];
    update: SyncPlanItem[];
    remove: SyncPlanItem[];
    skipped: SyncPlanItem[];
  };
  repaired: string[];
  applied: boolean;
}

const TMP_DIR = ".skill-sys-tmp";
const BACKUP_DIR = ".skill-sys-backup";
const STATE_FILENAME = ".skills.state.json";

function help(): void {
  console.log(`
Build and optionally apply a digest-based skill sync plan

Usage:
  bun scripts/commands/sync-plan.ts [options]

Options:
  --source <dir>       Source root (default: .)
  --project <dir>      Target project directory (default: .)
  --profile <name>     Source profile to sync (default: core)
  --app <id>           Adapter app/provider (default: codex)
  --plan               Print the plan without writing
  --explain            Alias for plan-style output
  --apply              Apply add/update/remove actions
  --repair             Clean orphan .skill-sys-tmp directories
  --json               Emit machine-readable output
  --help               Show help
`);
}

function parseArgs(argv: string[] = process.argv): SyncPlanArgs {
  const args: SyncPlanArgs = {
    source: ".",
    project: ".",
    profile: "core",
    app: "codex",
    apply: false,
    plan: false,
    explain: false,
    repair: false,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--plan") {
      args.plan = true;
      continue;
    }
    if (token === "--explain") {
      args.explain = true;
      continue;
    }
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--repair") {
      args.repair = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--source") {
      args.source = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--project") {
      args.project = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--profile") {
      args.profile = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--app") {
      args.app = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), args.source);
  args.project = path.resolve(process.cwd(), args.project);
  return args;
}

function projectRelative(projectDir: string, targetPath: string): string {
  const relative = path.relative(projectDir, targetPath);
  return relative ? relative.replaceAll("\\", "/") : ".";
}

// Post-resolve containment proof for a single joined path; lexical only,
// callers separately refuse symlinked targets before mutating them.
function assertResolvedWithin(baseDir: string, candidatePath: string, label: string): string {
  const baseAbs = path.resolve(baseDir);
  const candidateAbs = path.resolve(candidatePath);
  const relative = path.relative(baseAbs, candidateAbs);
  if (relative === "" || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay within ${baseAbs}: ${candidateAbs}`);
  }
  return candidateAbs;
}

function readInstalledState(projectDir: string): StateInstalledEntry[] {
  const statePath = path.join(projectDir, STATE_FILENAME);
  if (!fileExists(statePath)) {
    return [];
  }
  if (fs.lstatSync(statePath).isSymbolicLink()) {
    throw new Error(`Refusing to read symlinked state: ${statePath}`);
  }
  const parsed = readJson(statePath) as { installed?: unknown };
  return Array.isArray(parsed.installed) ? (parsed.installed as StateInstalledEntry[]) : [];
}

function cleanupOrphanTemps(targetBase: string): string[] {
  const tmpPath = path.join(targetBase, TMP_DIR);
  if (!fileExists(tmpPath)) {
    return [];
  }
  if (fs.lstatSync(tmpPath).isSymbolicLink()) {
    throw new Error(`Refusing to remove symlinked temp directory: ${tmpPath}`);
  }
  fs.rmSync(tmpPath, { recursive: true, force: true });
  return [tmpPath];
}

function createInstallId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

type SwapStepNotice = "backedUp" | "swapped";

function swapSkillDirectory(
  sourceDir: string,
  targetDir: string,
  targetBase: string,
  skillName: string,
  installId: string,
  notify?: (step: SwapStepNotice) => void
): void {
  const tempDir = path.join(targetBase, TMP_DIR, installId, skillName);
  const backupDir = path.join(targetBase, BACKUP_DIR, installId, skillName);
  if (fileExists(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  copyDirectory(sourceDir, tempDir);
  // Strict tree digests: symlinked entries abort staging instead of being
  // silently omitted from the compared manifests.
  if (digestTreeStrict(sourceDir) !== digestTreeStrict(tempDir)) {
    throw new Error(`Staged digest mismatch for ${skillName}`);
  }
  if (fileExists(targetDir)) {
    if (fs.lstatSync(targetDir).isSymbolicLink()) {
      throw new Error(`Refusing to replace symlinked target: ${targetDir}`);
    }
    ensureDir(path.dirname(backupDir));
    fs.renameSync(targetDir, backupDir);
    notify?.("backedUp");
  }
  ensureDir(path.dirname(targetDir));
  fs.renameSync(tempDir, targetDir);
  notify?.("swapped");
  ensureDir(path.dirname(backupDir));
  fs.writeFileSync(path.join(path.dirname(backupDir), ".complete"), "complete\n", "utf8");
}

function backupRemoveSkillDirectory(
  targetDir: string,
  targetBase: string,
  skillName: string,
  installId: string,
  notify?: () => void
): void {
  if (!fileExists(targetDir)) {
    return;
  }
  if (fs.lstatSync(targetDir).isSymbolicLink()) {
    throw new Error(`Refusing to remove symlinked target: ${targetDir}`);
  }
  const backupDir = path.join(targetBase, BACKUP_DIR, installId, `${skillName}.removed`);
  ensureDir(path.dirname(backupDir));
  fs.renameSync(targetDir, backupDir);
  notify?.();
  fs.writeFileSync(path.join(path.dirname(backupDir), ".complete"), "complete\n", "utf8");
}

function writeState(projectDir: string, result: SyncPlanResult): void {
  const statePath = path.join(projectDir, STATE_FILENAME);
  const installed = [...result.install.add, ...result.install.update, ...result.install.skipped]
    .sort((a, b) => a.skill.localeCompare(b.skill))
    .map((item) => ({
      managedBy: "skill-sys",
      app: item.app,
      skill: item.skill,
      target: item.target,
      skillDigest: item.skillDigest,
    }));

  writeFileAtomicSafe(
    statePath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        mode: "minimal",
        updatedAt: new Date().toISOString(),
        source: {
          repo: null,
          ref: null,
          profile: result.source.profile,
          app: result.source.app,
          sourceChecksum: dirDigest(path.join(result.source.path, "skills")),
        },
        installed,
      },
      null,
      2
    )}\n`
  );
}

function buildSyncPlan(args: SyncPlanArgs): SyncPlanResult {
  const layout = resolveSourceLayout(args.source, { requireSkills: true });
  const poolRoot = resolvePoolRoot(args.source, layout);
  const projectDir = args.project;
  const adapter = readAdapter(layout, args.app);
  const profile = readProfile(layout, args.profile);
  const targetBase = path.resolve(projectDir, adapter.targetPath);
  assertPathWithinProject(projectDir, targetBase, `Adapter '${args.app}' targetPath`);
  assertNotHomeAgentsSkillsTarget(targetBase, `Adapter '${args.app}' targetPath`);

  const desired = new Set(profile.skills.map((skillName) => normalizeSkillNameStrict(skillName)));
  const stateEntries = readInstalledState(projectDir);
  const add: SyncPlanItem[] = [];
  const update: SyncPlanItem[] = [];
  const skipped: SyncPlanItem[] = [];
  const remove: SyncPlanItem[] = [];

  for (const skillName of [...desired].sort((a, b) => a.localeCompare(b))) {
    const sourceSkillDir = assertResolvedWithin(
      layout.skillsDir,
      path.join(layout.skillsDir, skillName),
      `Skill '${skillName}' source dir`
    );
    const sourceSkillEntry = path.join(sourceSkillDir, "SKILL.md");
    if (!fileExists(sourceSkillEntry)) {
      throw new Error(`Profile '${args.profile}' references missing skill: ${skillName}`);
    }
    assertNoSensitiveFindings(
      scanSensitiveFiles({
        rootDir: sourceSkillDir,
        baseDir: poolRoot,
      }),
      `Skill '${skillName}'`
    );
    const targetDir = assertResolvedWithin(targetBase, path.join(targetBase, skillName), `Skill '${skillName}' target dir`);
    // Strict tree digests keep the recorded skillDigest comparable with the
    // strict digests recovery and remove recompute from disk, and reject
    // symlinked source or target entries instead of omitting them.
    const skillDigest = digestTreeStrict(sourceSkillDir);
    const target = projectRelative(projectDir, targetDir);
    if (!fileExists(targetDir)) {
      add.push({ app: args.app, skill: skillName, target, skillDigest, reason: "target missing" });
      continue;
    }
    const previousDigest = digestTreeStrict(targetDir);
    if (previousDigest !== skillDigest) {
      update.push({
        app: args.app,
        skill: skillName,
        target,
        skillDigest,
        previousDigest,
        reason: "digest changed",
      });
      continue;
    }
    skipped.push({
      app: args.app,
      skill: skillName,
      target,
      skillDigest,
      previousDigest,
      reason: "digest unchanged",
    });
  }

  for (const entry of stateEntries) {
    if (entry.managedBy !== "skill-sys" || entry.app !== args.app || typeof entry.skill !== "string") {
      continue;
    }
    let entrySkill: string;
    try {
      entrySkill = normalizeSkillNameStrict(entry.skill);
    } catch {
      continue;
    }
    if (desired.has(entrySkill)) {
      continue;
    }
    const target = typeof entry.target === "string" && entry.target.trim()
      ? entry.target
      : projectRelative(projectDir, path.join(targetBase, entrySkill));
    const targetDir = path.resolve(projectDir, target);
    const expectedTargetDir = assertResolvedWithin(
      targetBase,
      path.join(targetBase, entrySkill),
      `State skill '${entrySkill}' target dir`
    );
    if (targetDir !== expectedTargetDir || !fileExists(targetDir)) {
      continue;
    }
    remove.push({
      app: args.app,
      skill: entrySkill,
      target,
      skillDigest: typeof entry.skillDigest === "string" ? entry.skillDigest : "",
      reason: "managed skill no longer selected",
    });
  }

  return {
    source: {
      path: poolRoot,
      profile: args.profile,
      app: args.app,
      target: projectRelative(projectDir, targetBase),
    },
    install: { add, update, remove, skipped },
    repaired: [],
    applied: false,
  };
}

function applySyncPlanLocked(args: SyncPlanArgs, result: SyncPlanResult): SyncPlanResult {
  // A leftover apply journal from a crashed run is recovered before any
  // planning-derived mutation touches disk.
  recoverApplyJournal(args.project);
  const targetBase = path.resolve(args.project, result.source.target);
  assertPathWithinProject(args.project, targetBase, "Plan target");
  ensureDir(targetBase);
  const installId = createInstallId();
  const layout = resolveSourceLayout(args.source, { requireSkills: true });

  // W7 durable apply journal: written before the first irreversible rename,
  // updated after each one, removed only after the state write commits.
  // Journal items are keyed strictly by target identity: a duplicate target
  // would make the journal ambiguous for crash recovery, so it aborts the
  // apply before anything is written instead of being silently filtered.
  const seenTargets = new Set<string>();
  const journalItems: Array<
    | {
        action: "swap";
        target: string;
        temp: string;
        backup: string;
        hadTarget: boolean;
      }
    | {
        action: "remove";
        target: string;
        backup: string;
      }
  > = [];
  const candidateItems = [
    ...[...result.install.add, ...result.install.update].map((item) => ({
      action: "swap" as const,
      target: item.target,
      temp: projectRelative(args.project, path.join(targetBase, TMP_DIR, installId, normalizeSkillNameStrict(item.skill))),
      backup: projectRelative(args.project, path.join(targetBase, BACKUP_DIR, installId, normalizeSkillNameStrict(item.skill))),
      hadTarget: fileExists(path.resolve(args.project, item.target)),
    })),
    ...result.install.remove.map((item) => ({
      action: "remove" as const,
      target: item.target,
      backup: projectRelative(args.project, path.join(targetBase, BACKUP_DIR, installId, `${normalizeSkillNameStrict(item.skill)}.removed`)),
    })),
  ];
  for (const item of candidateItems) {
    if (seenTargets.has(item.target)) {
      throw new Error(
        `Duplicate sync-plan journal target '${item.target}'; refusing to build an ambiguous apply journal`
      );
    }
    seenTargets.add(item.target);
    journalItems.push(item);
  }
  if (!journalItems.length) {
    cleanupOrphanTemps(targetBase);
    const noopApplied = { ...result, applied: true };
    writeState(args.project, noopApplied);
    return noopApplied;
  }
  const writer = createApplyJournal(args.project, {
    applyId: installId,
    command: "sync-plan",
    items: journalItems,
  });

  try {
    for (const item of [...result.install.add, ...result.install.update]) {
      const skillName = normalizeSkillNameStrict(item.skill);
      swapSkillDirectory(
        assertResolvedWithin(
          layout.skillsDir,
          path.join(layout.skillsDir, skillName),
          `Skill '${skillName}' source dir`
        ),
        assertResolvedWithin(targetBase, path.resolve(args.project, item.target), `Skill '${skillName}' target dir`),
        targetBase,
        skillName,
        installId,
        (step) => {
          if (step === "backedUp") {
            writer.markBackedUp(item.target);
          } else {
            writer.markSwapped(item.target);
          }
        }
      );
    }
    for (const item of result.install.remove) {
      const skillName = normalizeSkillNameStrict(item.skill);
      backupRemoveSkillDirectory(
        assertResolvedWithin(targetBase, path.resolve(args.project, item.target), `Skill '${skillName}' target dir`),
        targetBase,
        skillName,
        installId,
        () => writer.markRemoved(item.target)
      );
    }
    cleanupOrphanTemps(targetBase);

    const applied = {
      ...result,
      applied: true,
    };
    writeState(args.project, applied);
    writer.close();
    return applied;
  } catch (error) {
    try {
      recoverApplyJournal(args.project);
    } catch (recoveryError) {
      throw new Error(
        `Sync-plan apply failed (${String(error)}) and apply-journal recovery failed: ${String(recoveryError)}`
      );
    }
    throw error;
  }
}

/**
 * Apply a sync plan under the canonical project mutation lock. Direct callers
 * (including tests) get the same serialization as the CLI APPLY path.
 */
function applySyncPlan(args: SyncPlanArgs, result: SyncPlanResult): SyncPlanResult {
  return withProjectMutationLock(args.project, () => applySyncPlanLocked(args, result));
}

function renderPlan(result: SyncPlanResult): string {
  const lines = [
    "Source:",
    `  path: ${result.source.path}`,
    `  profile: ${result.source.profile}`,
    "",
    "Install:",
    `  app: ${result.source.app}`,
    `  target: ${result.source.target}`,
  ];
  for (const key of ["add", "update", "remove", "skipped"] as const) {
    lines.push(`  ${key}:`);
    const items = result.install[key];
    if (!items.length) {
      lines.push("    none");
      continue;
    }
    for (const item of items) {
      lines.push(`    ${item.skill} (${item.reason})`);
    }
  }
  if (result.repaired.length) {
    lines.push("  repaired:");
    for (const item of result.repaired) {
      lines.push(`    ${item}`);
    }
  }
  lines.push(`  applied: ${result.applied ? "yes" : "no"}`);
  return lines.join("\n");
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  // APPLY holds the canonical project mutation lock across the whole
  // journal-recovery -> state-read -> plan -> repair -> mutate -> write-state
  // chain so a concurrent APPLY command fails deterministically with targets
  // and state unchanged. Plan/explain-only runs (and repair without apply)
  // never mutate skill targets or state; repair-only cleanup still serializes
  // under the same lock.
  let result: SyncPlanResult;
  if (args.apply) {
    result = withProjectMutationLock(args.project, () => {
      recoverApplyJournal(args.project);
      let planned = buildSyncPlan(args);
      if (args.repair) {
        planned = {
          ...planned,
          repaired: cleanupOrphanTemps(path.resolve(args.project, planned.source.target)),
        };
      }
      return applySyncPlanLocked(args, planned);
    });
  } else {
    result = buildSyncPlan(args);
    if (args.repair) {
      const repairTargetBase = path.resolve(args.project, result.source.target);
      result = withProjectMutationLock(args.project, () => ({
        ...result,
        repaired: cleanupOrphanTemps(repairTargetBase),
      }));
    }
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderPlan(result));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
}

export {
  applySyncPlan,
  buildSyncPlan,
  help,
  main,
  parseArgs,
  renderPlan,
};
export type {
  SyncPlanArgs,
  SyncPlanResult,
};
