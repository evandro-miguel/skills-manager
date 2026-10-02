#!/usr/bin/env bun
/**
 * PR10 — remove/uninstall planner and apply.
 *
 * The planning path is non-destructive: it reads `.skills.state.json`, selects
 * only entries managed by `skill-sys`, and produces a deterministic
 * JSON-friendly plan describing what *would* be removed.
 *
 * `--apply` is implemented separately in `applyRemove` and always runs the
 * planner first. Before any mutation it creates rollback-compatible backups,
 * rechecks digests immediately before each removal, and writes state last.
 *
 * Safety contract:
 * - `--apply` is exclusive with `--plan` / `--dry-run`.
 * - One of `--plan` / `--dry-run` / `--apply` is required.
 * - Broad remove (no `--skill`) requires `--all`; broad apply also requires
 *   `--confirm-all`.
 * - Each candidate target is validated to be a project-relative path that stays
 *   inside the project, is not the HOME directory, and is not a symlink.
 * - Digest mismatch or a missing recorded target fails closed unless `--force`.
 * - A live digest is recomputed immediately before each `rm`; any TOCTOU drift
 *   aborts even when `--force` is passed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  copyDirectory,
  digestTreeStrict,
  ensureDir,
  fileExists,
  readJson,
  withProjectMutationLock,
  writeFileAtomicSafe,
} from "../../lib/files.ts";
import { createApplyJournal, recoverApplyJournal, type ApplyJournalWriter } from "./apply-journal.ts";
import {
  finalizeRemovePlan,
  prepareRemovePlan,
} from "../skill-sys/remove-planning.ts";
import type {
  DetachedRemoveStateEntry,
  RemoveCandidateObservation,
  RemovePlan,
  RemovePlanAction,
  RemovePlannerInput,
} from "../skill-sys/remove-planning.ts";

export type {
  RemovePlan,
  RemovePlanAction,
  RemovePlannerInput,
} from "../skill-sys/remove-planning.ts";

const STATE_FILENAME = ".skills.state.json";
const BACKUP_DIR = ".skill-sys-backup";
const LEDGER_FILENAME = "remove-ledger.json";

export type RemoveRawArgs = Record<string, string | boolean | string[] | undefined>;

export interface NormalizedRemoveArgs extends RemovePlannerInput {
  apply: boolean;
  confirmAll: boolean;
  force: boolean;
}

export interface RemoveApplyResult {
  schemaVersion: number;
  command: "remove";
  mode: "apply";
  project: string;
  removeId: string;
  selected: number;
  deleted: number;
  targets: Array<{
    app: string;
    skill: string;
    target: string;
    exists: boolean;
  }>;
  backups: string[];
  stateUpdated: boolean;
}

function stringValue(args: RemoveRawArgs, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === true || value === false) {
    return null;
  }
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return typeof last === "string" && last.trim() ? last : null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function boolValue(args: RemoveRawArgs, key: string): boolean {
  return args[key] === true;
}

const USAGE =
  "Usage: skill-sys remove --project <dir> --skill <name> --plan|--dry-run|--apply [--app <app>] [--all] [--confirm-all] [--force] [--json]";

/**
 * Normalize and validate raw CLI args. Throws (fails closed) for unsupported,
 * unsafe, or incomplete invocations. This is the single dispatch-boundary
 * validator shared by the `skill-sys` dispatcher. For apply, the planner fields
 * are filled with a plan-mode copy; the destructive path is dispatched only
 * from `applyRemove`.
 */
export function normalizeRemoveArgs(
  raw: RemoveRawArgs,
  options: { cwd?: string } = {}
): NormalizedRemoveArgs {
  const cwd = options.cwd || process.cwd();

  const apply = boolValue(raw, "apply");
  const plan = boolValue(raw, "plan");
  const dryRun = boolValue(raw, "dry-run");
  const force = boolValue(raw, "force");
  const confirmAll = boolValue(raw, "confirm-all");

  if (apply && (plan || dryRun)) {
    throw new Error(
      "skill-sys remove --apply cannot be combined with --plan or --dry-run."
    );
  }

  const projectRaw = stringValue(raw, "project");
  if (!projectRaw) {
    throw new Error(USAGE);
  }
  const project = path.resolve(cwd, projectRaw);

  if (!apply && !plan && !dryRun) {
    throw new Error(
      "skill-sys remove requires a mode: pass --plan or --dry-run for a plan-only preview, or --apply for destructive removal."
    );
  }

  const skill = stringValue(raw, "skill");
  const all = boolValue(raw, "all");
  if (skill && all) {
    throw new Error("skill-sys remove --skill <name> cannot be combined with --all.");
  }
  if (!skill && !all) {
    throw new Error(
      "skill-sys remove without --skill requires --all to confirm a broad removal of all skill-sys-managed skills."
    );
  }
  if (all && apply && !confirmAll) {
    throw new Error(
      "skill-sys remove --all --apply requires --confirm-all to confirm broad destructive removal."
    );
  }

  return {
    project,
    skill,
    app: stringValue(raw, "app"),
    all,
    plan: apply ? true : plan,
    dryRun: apply ? false : dryRun,
    apply,
    confirmAll,
    force,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function detachStateEntry(entry: Record<string, unknown>): DetachedRemoveStateEntry {
  return {
    managedBy: asString(entry.managedBy),
    app: asString(entry.app),
    skill: asString(entry.skill),
    target: asString(entry.target),
    installMode: asString(entry.installMode),
    recordedDigest: asString(entry.skillDigest),
  };
}

/**
 * Validate a stored target path. It must be a relative path that resolves
 * strictly inside the project and never to the HOME directory. Throws on
 * violation so unsafe targets can never reach an action.
 */
function assertTargetSafe(projectAbs: string, home: string, target: string): void {
  if (path.isAbsolute(target)) {
    throw new Error(`Remove target must be a project-relative path, got absolute target: ${target}`);
  }
  const targetAbs = path.resolve(projectAbs, target);
  const relative = path.relative(projectAbs, targetAbs);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Remove target must stay within the project: ${target}`);
  }
  if (targetAbs === home) {
    throw new Error(`Refusing to plan removal of HOME directory: ${target}`);
  }
}

function assertNoSymlinkPathComponents(projectAbs: string, targetAbs: string, target: string): void {
  const relative = path.relative(projectAbs, targetAbs);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = projectAbs;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      break;
    }
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing to plan removal through symlink path component: ${target}`);
    }
  }
}

interface ResolvedTarget {
  exists: boolean;
  actualDigest: string | null;
}

/**
 * Inspect a target path on disk (read-only). Refuses symlinks. Returns the
 * strict tree digest when the target is a real directory, so symlinked
 * entries abort instead of being silently omitted from the digest.
 */
function resolveTargetOnDisk(targetAbs: string, target: string): ResolvedTarget {
  let lstat: fs.Stats | null = null;
  try {
    lstat = fs.lstatSync(targetAbs);
  } catch {
    lstat = null;
  }
  if (lstat && lstat.isSymbolicLink()) {
    throw new Error(`Refusing to plan removal of symlink target: ${target}`);
  }
  const exists = lstat !== null && lstat.isDirectory();
  return {
    exists,
    actualDigest: exists ? digestTreeStrict(targetAbs) : null,
  };
}

/**
 * Build a deterministic, read-only removal plan from a validated input. Reads
 * `.skills.state.json` and the target skill directories; performs zero
 * mutation.
 */
export function planRemove(input: RemovePlannerInput): RemovePlan {
  const projectAbs = path.resolve(input.project);
  const home = os.homedir();
  if (projectAbs === home) {
    throw new Error("Refusing to plan removal with the HOME directory as --project.");
  }

  const statePath = path.join(projectAbs, STATE_FILENAME);
  const entries: DetachedRemoveStateEntry[] = [];
  if (fileExists(statePath)) {
    const state = readJson<Record<string, unknown>>(statePath);
    if (Array.isArray(state.installed)) {
      for (const raw of state.installed) {
        if (isPlainObject(raw)) {
          entries.push(detachStateEntry(raw));
        }
      }
    }
  }

  const plannerInput: RemovePlannerInput = {
    project: projectAbs,
    skill: input.skill,
    app: input.app,
    all: input.all,
    plan: input.plan,
    dryRun: input.dryRun,
  };
  const prepared = prepareRemovePlan(plannerInput, entries);
  const observations: RemoveCandidateObservation[] = [];
  for (const candidate of prepared.candidates) {
    assertTargetSafe(projectAbs, home, candidate.target);
    const targetAbs = path.resolve(projectAbs, candidate.target);
    assertNoSymlinkPathComponents(projectAbs, targetAbs, candidate.target);
    const onDisk = resolveTargetOnDisk(targetAbs, candidate.target);
    observations.push({
      candidateId: candidate.candidateId,
      target: candidate.target,
      exists: onDisk.exists,
      actualDigest: onDisk.actualDigest,
    });
  }

  return finalizeRemovePlan(prepared, observations);
}

function createRemoveId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

function toPosixRelative(baseDir: string, targetPath: string): string {
  return path.relative(baseDir, targetPath).replaceAll("\\", "/");
}

/**
 * Apply a validated removal plan. This is the only destructive entry point: it
 * runs under the canonical project mutation lock (one acquisition per command)
 * held from the state-reading planner through backups, deletions, and the final
 * state rewrite, so a concurrent APPLY command fails deterministically with
 * targets and state left unchanged. It always runs the read-only planner
 * first, then creates rollback-compatible backups, deletes present targets
 * after a final digest recheck, and rewrites state last. Empty plans are a
 * no-op and never create a backup.
 */
export function applyRemove(input: NormalizedRemoveArgs): RemoveApplyResult {
  const projectAbs = path.resolve(input.project);
  return withProjectMutationLock(projectAbs, () => applyRemoveLocked(projectAbs, input));
}

function applyRemoveLocked(projectAbs: string, input: NormalizedRemoveArgs): RemoveApplyResult {
  // A leftover apply journal from a crashed run is recovered (completing or
  // undoing it by target identity) before the planner reads state.
  recoverApplyJournal(projectAbs);
  const plan = planRemove(input);

  const targets = plan.actions.map((action) => ({
    app: action.app,
    skill: action.skill,
    target: action.target,
    exists: action.exists,
  }));

  if (plan.actions.length === 0) {
    return {
      schemaVersion: 1,
      command: "remove",
      mode: "apply",
      project: projectAbs,
      removeId: "",
      selected: 0,
      deleted: 0,
      targets,
      backups: [],
      stateUpdated: false,
    };
  }

  for (const action of plan.actions) {
    if (action.recordedDigest !== null && !action.exists && !input.force) {
      throw new Error(
        `Refusing to apply removal: recorded target is missing for '${action.target}'. Pass --force to override.`
      );
    }
    if (action.digestMatches === false && !input.force) {
      throw new Error(
        `Refusing to apply removal: digest mismatch for '${action.target}'. Pass --force to override.`
      );
    }
  }

  const statePath = path.join(projectAbs, STATE_FILENAME);
  const state = fileExists(statePath)
    ? readJson<Record<string, unknown>>(statePath)
    : null;
  const installedEntries =
    state && Array.isArray(state.installed) ? state.installed : [];
  const removedTargets = new Set(plan.actions.map((action) => action.target));

  const ledgerEntries = installedEntries.filter((entry) => {
    if (!isPlainObject(entry)) return false;
    if (entry.managedBy !== "skill-sys") return false;
    return typeof entry.target === "string" && removedTargets.has(entry.target);
  });

  const removeId = createRemoveId();

  // Duplicate state entries must not copy or delete the same target twice.
  const uniquePresentActions = new Map<string, RemovePlanAction>();
  for (const action of plan.actions) {
    if (!action.exists || uniquePresentActions.has(action.target)) {
      continue;
    }
    uniquePresentActions.set(action.target, action);
  }

  interface BackupGroup {
    base: string;
    actions: RemovePlanAction[];
  }
  const groups = new Map<string, BackupGroup>();
  for (const action of uniquePresentActions.values()) {
    const targetAbs = path.resolve(projectAbs, action.target);
    const base = path.dirname(targetAbs);
    let group = groups.get(base);
    if (!group) {
      group = { base, actions: [] };
      groups.set(base, group);
    }
    group.actions.push(action);
  }

  // W7 durable apply journal: written before the first mutation (backup
  // creation), updated after each irreversible deletion, removed only after
  // the state write commits. Any failure path recovers (or deliberately
  // keeps) the journal. Applies with no present targets never mutate, so
  // they run journal-free.
  const journalItems = [...uniquePresentActions.values()].map((action) => ({
    action: "remove" as const,
    target: action.target,
    backup: toPosixRelative(
      projectAbs,
      path.join(
        path.dirname(path.resolve(projectAbs, action.target)),
        BACKUP_DIR,
        removeId,
        path.basename(path.resolve(projectAbs, action.target))
      )
    ),
  }));
  const writer: ApplyJournalWriter | null = journalItems.length
    ? createApplyJournal(projectAbs, { applyId: removeId, command: "remove", items: journalItems })
    : null;

  try {
    const createdBackupRoots: string[] = [];
    const backupRoots: string[] = [];
    try {
      for (const group of groups.values()) {
        const backupRoot = path.join(group.base, BACKUP_DIR, removeId);
        ensureDir(backupRoot);
        createdBackupRoots.push(backupRoot);

        for (const action of group.actions) {
          const targetAbs = path.resolve(projectAbs, action.target);
          const backupSkillDir = path.join(backupRoot, path.basename(targetAbs));
          copyDirectory(targetAbs, backupSkillDir);
        }

        const baseLedger = ledgerEntries.filter((entry) => {
          const target = entry.target;
          if (typeof target !== "string") return false;
          return path.dirname(path.resolve(projectAbs, target)) === group.base;
        });
        if (baseLedger.length > 0) {
          writeFileAtomicSafe(
            path.join(backupRoot, LEDGER_FILENAME),
            `${JSON.stringify(
              { schemaVersion: 1, removeId, entries: baseLedger },
              null,
              2
            )}\n`
          );
        }
        writeFileAtomicSafe(path.join(backupRoot, ".complete"), "complete\n");
        backupRoots.push(backupRoot);
      }
    } catch (error) {
      for (const root of createdBackupRoots.reverse()) {
        if (fileExists(root)) {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
      throw error;
    }

    for (const action of uniquePresentActions.values()) {
      const targetAbs = path.resolve(projectAbs, action.target);
      assertNoSymlinkPathComponents(projectAbs, targetAbs, action.target);
      const linkStat = fs.lstatSync(targetAbs);
      if (linkStat.isSymbolicLink()) {
        throw new Error(`Refusing to remove symlink target: ${action.target}`);
      }
      const currentDigest = digestTreeStrict(targetAbs);
      if (currentDigest !== action.actualDigest) {
        throw new Error(
          `TOCTOU abort: target '${action.target}' changed since planning.`
        );
      }
      fs.rmSync(targetAbs, { recursive: true, force: true });
      writer?.markRemoved(action.target);
    }

    let stateUpdated = false;
    if (state !== null) {
      const nextInstalled = installedEntries.filter((entry) => {
        if (!isPlainObject(entry)) return true;
        if (entry.managedBy !== "skill-sys") return true;
        if (typeof entry.target !== "string") return true;
        return !removedTargets.has(entry.target);
      });
      if (nextInstalled.length !== installedEntries.length) {
        writeFileAtomicSafe(
          statePath,
          `${JSON.stringify({ ...state, installed: nextInstalled }, null, 2)}\n`
        );
        stateUpdated = true;
      }
    }

    writer?.close();

    return {
      schemaVersion: 1,
      command: "remove",
      mode: "apply",
      project: projectAbs,
      removeId,
      selected: plan.actions.length,
      deleted: uniquePresentActions.size,
      targets,
      backups: backupRoots.map((root) => toPosixRelative(projectAbs, root)),
      stateUpdated,
    };
  } catch (error) {
    try {
      recoverApplyJournal(projectAbs);
    } catch (recoveryError) {
      throw new Error(
        `${String(error)} (apply-journal recovery also failed: ${String(recoveryError)})`
      );
    }
    throw error;
  }
}

export function renderRemoveApplyResult(
  result: RemoveApplyResult,
  format: "text" | "json"
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const lines: string[] = [];
  lines.push(result.selected === 0 ? "STATUS: NOOP" : "STATUS: APPLY");
  lines.push("Command: skill-sys remove (apply mode)");
  lines.push(`Project: ${result.project}`);
  if (result.selected > 0) {
    lines.push(`RemoveId: ${result.removeId}`);
  }
  lines.push(`Selected: ${result.selected}`);
  lines.push(`Deleted: ${result.deleted}`);
  for (const target of result.targets) {
    lines.push(
      `- ${target.app || "(no app)"}/${target.skill || "(no skill)"} -> ${target.target} [${target.exists ? "removed" : "missing"}]`
    );
  }
  lines.push(`Backups: ${result.backups.length}`);
  for (const backup of result.backups) {
    lines.push(`- ${backup}`);
  }
  lines.push(`State: ${result.stateUpdated ? "updated" : "unchanged"}`);
  return `${lines.join("\n")}\n`;
}

export function renderRemovePlan(plan: RemovePlan, format: "text" | "json"): string {
  if (format === "json") {
    return `${JSON.stringify(plan, null, 2)}\n`;
  }

  const lines: string[] = [];
  lines.push("STATUS: PLAN");
  lines.push(`Command: skill-sys remove (${plan.scope} scope, ${plan.mode} mode)`);
  lines.push(`Project: ${plan.project}`);
  lines.push(`Apply supported: ${plan.applySupported ? "yes" : "no"}`);
  lines.push(`Actions: ${plan.actions.length}`);
  for (const action of plan.actions) {
    const digest =
      action.digestMatches === null
        ? "no recorded digest"
        : action.digestMatches
          ? "digest matches"
          : "DIGEST MISMATCH";
    const presence = action.exists ? "present" : "MISSING";
    lines.push(
      `- ${action.app || "(no app)"}/${action.skill || "(no skill)"} -> ${action.target} [${presence}; ${digest}]`
    );
  }
  lines.push(
    `Ignored: ${plan.ignored.unmanaged} unmanaged, ${plan.ignored.filtered} filtered, ${plan.ignored.malformed} malformed`
  );
  return `${lines.join("\n")}\n`;
}
