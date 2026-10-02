#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { copyDirectory, digestTreeStrict, ensureDir, fileExists, readJson, withProjectMutationLock, writeFileAtomicSafe } from "../lib/files.ts";
import { recoverApplyJournal } from "../modules/skillpool/apply-journal.ts";
import { assertNotHomeAgentsSkillsTarget } from "../modules/home-agents-guard.ts";

const STATE_FILENAME = ".skills.state.json";

interface RollbackArgs {
  project: string;
  target: string;
  installId: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

interface RollbackAction {
  kind: "directory" | "file";
  backup: string;
  target: string;
  restoreName: string;
}

interface RollbackResult {
  backupId: string | null;
  actions: RollbackAction[];
  dryRun: boolean;
}

function help(): void {
  console.log(`
Restore skills from a .skill-sys-backup entry

Usage:
  bun scripts/commands/rollback.ts [options]

Options:
  --project <dir>      Target project directory (default: .)
  --target <path>      Skills target under project (default: .agents/skills)
  --install-id <id>    Backup id, or latest (default: latest)
  --dry-run            Print actions without writing
  --json               Emit machine-readable output
  --help               Show help
`);
}

function parseArgs(argv: string[] = process.argv): RollbackArgs {
  const args: RollbackArgs = {
    project: ".",
    target: ".agents/skills",
    installId: "latest",
    dryRun: false,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--project") {
      args.project = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--target") {
      args.target = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--install-id") {
      args.installId = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.project = path.resolve(process.cwd(), args.project);
  return args;
}

function assertTargetWithinProject(projectDir: string, targetPath: string): void {
  const projectAbs = path.resolve(projectDir);
  const targetAbs = path.resolve(targetPath);
  const relative = path.relative(projectAbs, targetAbs);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Rollback target must stay within project: ${targetAbs}`);
  }
}

function assertNoSymlinkPath(projectDir: string, targetPath: string): void {
  const relative = path.relative(path.resolve(projectDir), path.resolve(targetPath));
  let current = path.resolve(projectDir);
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === ".") continue;
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Rollback target path must not be a symlink: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function resolveBackupId(backupRoot: string, installId: string): string | null {
  if (installId !== "latest" && (installId !== path.basename(installId) || installId === "." || installId === "..")) {
    throw new Error(`Rollback install id must be a safe single path component: ${installId}`);
  }
  if (!fileExists(backupRoot)) {
    if (installId !== "latest") {
      throw new Error(`Rollback backup root does not exist for explicit install id: ${installId}`);
    }
    return null;
  }
  if (installId !== "latest") {
    const explicitBackupDir = path.join(backupRoot, installId);
    if (!fileExists(explicitBackupDir)) {
      throw new Error(`Rollback backup id not found: ${installId}`);
    }
    if (!fs.lstatSync(explicitBackupDir).isDirectory() || fs.lstatSync(explicitBackupDir).isSymbolicLink()) {
      throw new Error(`Rollback backup id is not a real directory: ${installId}`);
    }
    if (!fileExists(path.join(explicitBackupDir, ".complete"))) {
      throw new Error(`Rollback backup id is incomplete: ${installId}`);
    }
    return installId;
  }
  const candidates = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fileExists(path.join(backupRoot, entry.name, ".complete")))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  return candidates[candidates.length - 1] || null;
}

function planRollback(args: RollbackArgs): RollbackResult {
  const targetBase = path.resolve(args.project, args.target);
  assertTargetWithinProject(args.project, targetBase);
  assertNoSymlinkPath(args.project, targetBase);
  assertNotHomeAgentsSkillsTarget(targetBase, "Rollback target");
  const backupRoot = path.join(targetBase, ".skill-sys-backup");
  assertNoSymlinkPath(args.project, backupRoot);
  const backupId = resolveBackupId(backupRoot, args.installId);
  if (!backupId) {
    return { backupId: null, actions: [], dryRun: args.dryRun };
  }
  const backupDir = path.join(backupRoot, backupId);
  const actions = fs
    .readdirSync(backupDir, { withFileTypes: true })
    .filter(
      (entry) => entry.name !== ".complete" && entry.name !== "remove-ledger.json"
    )
    .map((entry) => {
      const entryPath = path.join(backupDir, entry.name);
      const entryStat = fs.lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`Rollback backup entry must be a real directory: ${entryPath}`);
      }
      const isManagedFileBackup = entry.name === ".skill-lifecycle.json" && entryStat.isFile();
      if (!entryStat.isDirectory() && !isManagedFileBackup) {
        throw new Error(`Rollback backup entry must be a real directory: ${entryPath}`);
      }
      const restoreName = entry.name.endsWith(".removed")
        ? entry.name.slice(0, -".removed".length)
        : entry.name;
      if (!restoreName || restoreName === "." || restoreName === "..") {
        throw new Error(`Rollback backup entry has an invalid restore name: ${entryPath}`);
      }
      return {
        kind: isManagedFileBackup ? "file" as const : "directory" as const,
        backup: entryPath,
        target: path.join(targetBase, restoreName),
        restoreName,
      };
    });
  return { backupId, actions, dryRun: args.dryRun };
}

function applyRollback(result: RollbackResult): void {
  if (!result.backupId || result.dryRun) {
    return;
  }
  const staged = result.actions.map((action) => ({
    action,
    tempTarget: `${action.target}.rollback-${process.pid}`,
    previousTarget: `${action.target}.rollback-${process.pid}.previous`,
  }));
  const cleanupTemps = (): void => {
    for (const { tempTarget } of staged) {
      if (fileExists(tempTarget)) {
        fs.rmSync(tempTarget, { recursive: true, force: true });
      }
    }
  };
  try {
    try {
      for (const { action, tempTarget } of staged) {
        if (fs.lstatSync(action.backup).isSymbolicLink()) {
          throw new Error(`Refusing symlinked backup: ${action.backup}`);
        }
        if (fileExists(tempTarget)) {
          fs.rmSync(tempTarget, { recursive: true, force: true });
        }
        if (action.kind === "directory") {
          copyDirectory(action.backup, tempTarget);
        } else {
          ensureDir(path.dirname(tempTarget));
          fs.copyFileSync(action.backup, tempTarget);
        }
      }
    } catch (error) {
      cleanupTemps();
      throw error;
    }

    const touched: typeof staged = [];
    try {
      for (const item of staged) {
        const { action, tempTarget, previousTarget } = item;
        if (fileExists(previousTarget)) {
          fs.rmSync(previousTarget, { recursive: true, force: true });
        }
        if (fileExists(action.target)) {
          if (fs.lstatSync(action.target).isSymbolicLink()) {
            throw new Error(`Refusing symlinked rollback target: ${action.target}`);
          }
          fs.renameSync(action.target, previousTarget);
          touched.push(item);
        }
        ensureDir(path.dirname(action.target));
        fs.renameSync(tempTarget, action.target);
        if (!fileExists(previousTarget)) {
          touched.push(item);
        }
      }
    } catch (error) {
      for (const { action, previousTarget } of [...touched].reverse()) {
        if (fileExists(action.target)) {
          fs.rmSync(action.target, { recursive: true, force: true });
        }
        if (fileExists(previousTarget)) {
          ensureDir(path.dirname(action.target));
          fs.renameSync(previousTarget, action.target);
        }
      }
      throw error;
    }
  } finally {
    cleanupTemps();
  }

  // Cleanup is post-commit: a cleanup failure must not compensate a completed
  // restore, because earlier previous targets may already have been deleted.
  for (const { previousTarget } of staged) {
    if (fileExists(previousTarget)) {
      fs.rmSync(previousTarget, { recursive: true, force: true });
    }
  }
}

function toPosixRelative(baseDir: string, targetPath: string): string {
  return path.relative(baseDir, targetPath).replaceAll("\\", "/");
}

function reconcileRollbackState(projectDir: string, result: RollbackResult): void {
  if (!result.backupId || result.dryRun || result.actions.length === 0) {
    return;
  }
  const statePath = path.join(projectDir, STATE_FILENAME);
  if (!fileExists(statePath)) {
    return;
  }
  const state = readJson<Record<string, unknown>>(statePath);
  if (!Array.isArray(state.installed)) {
    return;
  }
  let changed = false;
  for (const action of result.actions) {
    let targetStat: fs.Stats;
    try {
      targetStat = fs.lstatSync(action.target);
    } catch {
      continue; // Restored target absent: nothing to reconcile.
    }
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Refusing to reconcile symlinked rollback target: ${action.target}`);
    }
    if (!targetStat.isDirectory()) {
      continue; // File backups (e.g. .skill-lifecycle.json) carry no skillDigest.
    }
    const relativeTarget = toPosixRelative(projectDir, action.target);
    // Strict tree digest under the project mutation lock: symlinked entries
    // abort reconciliation instead of being silently omitted, and the stored
    // format stays comparable with the install/sync/recovery/removal
    // verifiers that recompute digests from disk.
    const restoredDigest = digestTreeStrict(action.target);
    for (const entry of state.installed) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (record.managedBy !== "skill-sys") {
        continue;
      }
      if (record.target === relativeTarget && record.skillDigest !== restoredDigest) {
        record.skillDigest = restoredDigest;
        changed = true;
      }
    }
  }
  if (changed) {
    writeFileAtomicSafe(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function mergeRemoveLedgerState(
  projectDir: string,
  targetBase: string,
  backupId: string | null,
  dryRun: boolean
): void {
  if (dryRun || !backupId) {
    return;
  }
  const ledgerPath = path.join(targetBase, ".skill-sys-backup", backupId, "remove-ledger.json");
  if (!fileExists(ledgerPath)) {
    return;
  }
  const ledger = readJson<{ entries?: unknown[] }>(ledgerPath);
  if (!Array.isArray(ledger.entries) || ledger.entries.length === 0) {
    return;
  }

  const statePath = path.join(projectDir, STATE_FILENAME);
  const state = fileExists(statePath)
    ? readJson<Record<string, unknown>>(statePath)
    : { schemaVersion: 2, mode: "minimal", updatedAt: new Date().toISOString() };
  const existing = Array.isArray(state.installed) ? state.installed : [];
  const presentTargets = new Set<string>();
  for (const entry of existing) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const target = (entry as Record<string, unknown>).target;
      if (typeof target === "string") {
        presentTargets.add(target);
      }
    }
  }

  const toAdd: unknown[] = [];
  for (const rawEntry of ledger.entries) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    const record = rawEntry as Record<string, unknown>;
    if (record.managedBy !== "skill-sys") {
      continue;
    }
    const target = record.target;
    if (typeof target !== "string") {
      continue;
    }
    if (presentTargets.has(target)) {
      continue;
    }
    toAdd.push(rawEntry);
    presentTargets.add(target);
  }

  if (toAdd.length === 0) {
    return;
  }
  state.installed = [...existing, ...toAdd];
  writeFileAtomicSafe(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  // Dry-run is planning-only and never locks; a mutating run takes the
  // canonical project mutation lock once, held across apply-journal recovery,
  // the target restore, and both `.skills.state.json` reconciliation writes.
  if (args.dryRun) {
    executeRollbackCommand(args);
  } else {
    withProjectMutationLock(args.project, () => {
      recoverApplyJournal(args.project);
      executeRollbackCommand(args);
    });
  }
}

function executeRollbackCommand(args: RollbackArgs): void {
  const result = planRollback(args);
  applyRollback(result);
  const targetBase = path.resolve(args.project, args.target);
  mergeRemoveLedgerState(args.project, targetBase, result.backupId, result.dryRun);
  reconcileRollbackState(args.project, result);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.backupId ? "STATUS: PASS" : "STATUS: NOOP");
  console.log(`Backup: ${result.backupId || "none"}`);
  console.log(`Actions: ${result.actions.length}`);
  for (const action of result.actions) {
    console.log(`- restore ${action.restoreName} -> ${path.relative(args.project, action.target).replaceAll("\\", "/")}`);
  }
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
  applyRollback,
  help,
  main,
  parseArgs,
  planRollback,
  reconcileRollbackState,
};
export type {
  RollbackAction,
  RollbackResult,
};
