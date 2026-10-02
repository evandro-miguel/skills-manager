#!/usr/bin/env bun
/**
 * W7 durable apply journal.
 *
 * Every APPLY command (install, sync-plan, remove) records one atomic journal
 * at `<projectDir>/.skills.apply-journal.json` before its first irreversible
 * mutation, updates it after each irreversible rename/removal, and removes it
 * only after the state write/reconciliation commits. The next locked APPLY
 * recovers any leftover journal before planning:
 *
 * - Incomplete commits (target moved to backup, replacement not yet swapped
 *   in) are restored from the journaled backup.
 * - Completed targets are recognized through the durable step flags and
 *   reconciled into `.skills.state.json` strictly by project-relative POSIX
 *   target identity: managed entries for touched targets get their digest
 *   refreshed to on-disk reality, entries for completed removals are dropped,
 *   and untouched, foreign, and unmanaged entries are preserved verbatim.
 *
 * Recovery is fail-closed: malformed journals, absolute/traversing paths,
 * paths outside the project or outside the expected `.skill-sys-tmp` /
 * `.skill-sys-backup` per-applyId roots, and symlinks on the journal or on
 * touched paths abort recovery before any mutation. A journal alone is never
 * ownership proof: target mutation additionally requires an existing
 * `.skills.state.json` record with `managedBy:"skill-sys"` for that exact
 * project-relative target; untracked targets and missing/invalid state fail
 * closed with journal, targets, and backups preserved for manual recovery.
 * Recovery never deletes backups; it only consumes them by renaming them back
 * into place.
 */

import fs from "node:fs";
import path from "node:path";
import {
  digestTreeStrict,
  ensureDir,
  fileExists,
  hashFile,
  readJson,
  writeFileAtomicSafe,
} from "../../lib/files.ts";

export const APPLY_JOURNAL_FILENAME = ".skills.apply-journal.json";

const STATE_FILENAME = ".skills.state.json";

const TMP_DIRNAME = ".skill-sys-tmp";
const BACKUP_DIRNAME = ".skill-sys-backup";
const MAX_JOURNAL_BYTES = 1_000_000;
const APPLY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,198}$/;

export type ApplyJournalCommand = "install" | "sync-plan" | "remove";
export type ApplyAction = "swap" | "remove";

export interface ApplyJournalItemSpec {
  action: ApplyAction;
  /** Project-relative POSIX target identity. */
  target: string;
  /** Project-relative POSIX staging path (swap items only). */
  temp?: string;
  /** Project-relative POSIX backup path. */
  backup?: string;
  /**
   * Whether the target existed before the apply started (swap items only).
   * Recovery uses this to distinguish undo-to-backup from undo-delete.
   */
  hadTarget?: boolean;
}

export interface ApplyJournalWriter {
  markBackedUp(target: string): void;
  markSwapped(target: string): void;
  markRemoved(target: string): void;
  /** Remove the journal after the state write/reconciliation committed. */
  close(): void;
}

interface RawJournalItem {
  action: ApplyAction;
  target: string;
  temp?: string;
  backup?: string;
  hadTarget: boolean;
  backedUp: boolean;
  swapped: boolean;
  removed: boolean;
}

interface ValidatedJournalItem extends RawJournalItem {
  targetAbs: string;
  tempAbs: string | null;
  backupAbs: string | null;
}

interface ValidatedJournal {
  applyId: string;
  command: ApplyJournalCommand;
  items: ValidatedJournalItem[];
}

function fail(message: string): never {
  throw new Error(`Apply journal rejected: ${message}`);
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertBooleanField(item: Record<string, unknown>, key: string, label: string): boolean {
  const value = item[key];
  if (typeof value !== "boolean") {
    fail(`${label}.${key} must be a boolean`);
  }
  return value;
}

/** Strict project-relative POSIX path: no absolute, drive, backslash, dot, or dot-dot segments. */
function assertSafeRelativeProjectPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    fail(`${label} must be a non-empty relative path`);
  }
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    fail(`${label} must be a project-relative POSIX path: ${value}`);
  }
  for (const segment of value.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      fail(`${label} must not contain empty, '.', or '..' segments: ${value}`);
    }
  }
  return value;
}

function resolveContained(projectDir: string, relativePath: string, label: string): string {
  const resolved = path.resolve(projectDir, relativePath);
  const relative = path.relative(projectDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} must stay within the project: ${relativePath}`);
  }
  return resolved;
}

/**
 * Temp/backup paths derived from an untrusted journal are only ever touched
 * inside the per-applyId roots the apply flows actually create them in.
 */
function assertUnderExpectedRoot(
  projectDir: string,
  candidateAbs: string,
  kind: "temp" | "backup",
  applyId: string,
  targetAbs: string,
  label: string
): void {
  const rootDir = path.join(
    path.dirname(targetAbs),
    kind === "temp" ? TMP_DIRNAME : BACKUP_DIRNAME,
    applyId
  );
  const relative = path.relative(rootDir, candidateAbs);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} must stay under the expected ${kind} root for this apply: ${candidateAbs}`);
  }
}

function pathPresent(absPath: string): boolean {
  try {
    fs.lstatSync(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Walk from the project root down to `absPath`, refusing any symlinked component. */
function assertNoSymlinkComponents(projectDir: string, absPath: string, label: string): void {
  const relative = path.relative(projectDir, absPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} must stay within the project: ${absPath}`);
  }
  let current = projectDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return; // Remaining tail does not exist yet; nothing to refuse.
    }
    if (stat.isSymbolicLink()) {
      fail(`${label} must not traverse a symlink: ${current}`);
    }
  }
}

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "applyId", "command", "createdAt", "items"]);
const SWAP_ITEM_KEYS = new Set([
  "action",
  "target",
  "temp",
  "backup",
  "hadTarget",
  "backedUp",
  "swapped",
]);
const REMOVE_ITEM_KEYS = new Set(["action", "target", "backup", "hadTarget", "removed"]);

function assertKnownKeys(record: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail(`${label} has unsupported field '${key}'`);
    }
  }
}

function validateJournal(raw: unknown, projectDir: string): ValidatedJournal {
  const journal = assertPlainObject(raw, "journal");
  assertKnownKeys(journal, TOP_LEVEL_KEYS, "journal");
  if (journal.schemaVersion !== 1) {
    fail(`unsupported schemaVersion ${JSON.stringify(journal.schemaVersion)}`);
  }
  const applyId = journal.applyId;
  if (typeof applyId !== "string" || !APPLY_ID_PATTERN.test(applyId)) {
    fail(`applyId must be a safe single path component: ${JSON.stringify(applyId)}`);
  }
  const command = journal.command;
  if (command !== "install" && command !== "sync-plan" && command !== "remove") {
    fail(`unsupported command ${JSON.stringify(command)}`);
  }
  if (typeof journal.createdAt !== "string" || !journal.createdAt.trim()) {
    fail("createdAt must be a timestamp string");
  }
  if (!Array.isArray(journal.items) || journal.items.length === 0) {
    fail("items must be a non-empty array");
  }

  const seenTargets = new Set<string>();
  const items: ValidatedJournalItem[] = [];
  for (const rawEntry of journal.items) {
    const entry = assertPlainObject(rawEntry, "journal item");
    const action = entry.action;
    if (action !== "swap" && action !== "remove") {
      fail(`unsupported item action ${JSON.stringify(action)}`);
    }
    const label = `item ${String(entry.target ?? "(unspecified)")}`;
    assertKnownKeys(entry, action === "swap" ? SWAP_ITEM_KEYS : REMOVE_ITEM_KEYS, label);
    const target = assertSafeRelativeProjectPath(entry.target, `${label} target`);
    if (seenTargets.has(target)) {
      fail(`duplicate item target: ${target}`);
    }
    seenTargets.add(target);
    const targetAbs = resolveContained(projectDir, target, `${label} target`);

    let tempAbs: string | null = null;
    let tempRel: string | undefined;
    let backupAbs: string | null = null;
    if (action === "swap") {
      if (typeof entry.temp !== "string") {
        fail(`${label} swap requires a temp path`);
      }
      tempRel = entry.temp;
      tempAbs = resolveContained(projectDir, entry.temp, `${label} temp`);
      assertUnderExpectedRoot(projectDir, tempAbs, "temp", applyId, targetAbs, `${label} temp`);
    }
    if (typeof entry.backup !== "string") {
      fail(`${label} requires a backup path`);
    }
    const backupRel: string = entry.backup;
    backupAbs = resolveContained(projectDir, entry.backup, `${label} backup`);
    assertUnderExpectedRoot(projectDir, backupAbs, "backup", applyId, targetAbs, `${label} backup`);

    const hadTarget = assertBooleanField(entry, "hadTarget", label);
    const backedUp = action === "swap" ? assertBooleanField(entry, "backedUp", label) : false;
    const swapped = action === "swap" ? assertBooleanField(entry, "swapped", label) : false;
    const removed = action === "remove" ? assertBooleanField(entry, "removed", label) : false;
    if (action === "remove" && !hadTarget) {
      fail(`${label} remove items always replace an existing target`);
    }
    if (backedUp && !hadTarget) {
      fail(`${label} cannot be backed up without a prior target`);
    }
    const validated: ValidatedJournalItem = {
      action,
      target,
      hadTarget,
      backedUp,
      swapped,
      removed,
      targetAbs,
      tempAbs,
      backupAbs,
    };
    if (tempRel !== undefined) {
      validated.temp = tempRel;
    }
    items.push(validated);
  }
  return { applyId, command, items };
}

function journalPathFor(projectDir: string): string {
  return path.join(projectDir, APPLY_JOURNAL_FILENAME);
}

function readValidatedJournal(projectDir: string): ValidatedJournal {
  const journalPath = journalPathFor(projectDir);
  const linkStat = fs.lstatSync(journalPath);
  if (linkStat.isSymbolicLink()) {
    fail(`journal must not be a symlink: ${journalPath}`);
  }
  if (linkStat.size > MAX_JOURNAL_BYTES) {
    fail(`journal exceeds ${MAX_JOURNAL_BYTES} bytes: ${journalPath}`);
  }
  return validateJournal(readJson(journalPath), projectDir);
}

function writeJournalAtomic(projectDir: string, payload: unknown): void {
  writeFileAtomicSafe(journalPathFor(projectDir), `${JSON.stringify(payload, null, 2)}\n`);
}

function serializeSpec(spec: ApplyJournalItemSpec, applyId: string, projectDir: string): RawJournalItem {
  const target = assertSafeRelativeProjectPath(spec.target, "journal item target");
  const targetAbs = resolveContained(projectDir, target, "journal item target");
  const base: RawJournalItem = {
    action: spec.action,
    target,
    hadTarget: spec.action === "remove" ? true : spec.hadTarget === true,
    backedUp: false,
    swapped: false,
    removed: false,
  };
  if (spec.action === "swap") {
    if (typeof spec.temp !== "string" || typeof spec.backup !== "string") {
      fail(`swap item requires temp and backup paths: ${target}`);
    }
    const tempAbs = resolveContained(projectDir, spec.temp, "journal item temp");
    assertUnderExpectedRoot(projectDir, tempAbs, "temp", applyId, targetAbs, "journal item temp");
    const backupAbs = resolveContained(projectDir, spec.backup, "journal item backup");
    assertUnderExpectedRoot(projectDir, backupAbs, "backup", applyId, targetAbs, "journal item backup");
    return { ...base, temp: spec.temp, backup: spec.backup };
  }
  if (typeof spec.backup !== "string") {
    fail(`remove item requires a backup path: ${target}`);
  }
  const backupAbs = resolveContained(projectDir, spec.backup, "journal item backup");
  assertUnderExpectedRoot(projectDir, backupAbs, "backup", applyId, targetAbs, "journal item backup");
  return { ...base, hadTarget: true, backup: spec.backup };
}

/**
 * Serialize a runtime journal item into the exact on-disk shape the strict
 * validator accepts: swap items never carry `removed`, remove items never
 * carry temp/backedUp/swapped.
 */
function serializeWritableItem(item: RawJournalItem): Record<string, unknown> {
  if (item.action === "swap") {
    return {
      action: item.action,
      target: item.target,
      temp: item.temp,
      backup: item.backup,
      hadTarget: item.hadTarget,
      backedUp: item.backedUp,
      swapped: item.swapped,
    };
  }
  return {
    action: item.action,
    target: item.target,
    backup: item.backup,
    hadTarget: true,
    removed: item.removed,
  };
}

/**
 * Create the durable journal before the first irreversible mutation of an
 * APPLY run. Must be called while holding the canonical project mutation
 * lock. Step flags start clean and are flipped atomically by the mark*
 * callbacks as each irreversible rename/removal lands.
 */
export function createApplyJournal(
  projectDir: string,
  options: { applyId: string; command: ApplyJournalCommand; items: ApplyJournalItemSpec[] }
): ApplyJournalWriter {
  if (!APPLY_ID_PATTERN.test(options.applyId)) {
    fail(`applyId must be a safe single path component: ${options.applyId}`);
  }
  if (!options.items.length) {
    fail("journal requires at least one item");
  }
  const createdAt = new Date().toISOString();
  const items = options.items.map((spec) => serializeSpec(spec, options.applyId, projectDir));
  const flush = (): void =>
    writeJournalAtomic(projectDir, {
      schemaVersion: 1,
      applyId: options.applyId,
      command: options.command,
      createdAt,
      items: items.map(serializeWritableItem),
    });
  flush();

  const byTarget = new Map<string, RawJournalItem>();
  for (const item of items) {
    byTarget.set(item.target, item);
  }
  const itemFor = (target: string): RawJournalItem => {
    const item = byTarget.get(target);
    if (!item) {
      fail(`journal has no item for target ${target}`);
    }
    return item;
  };
  return {
    markBackedUp: (target) => {
      itemFor(target).backedUp = true;
      flush();
    },
    markSwapped: (target) => {
      itemFor(target).swapped = true;
      flush();
    },
    markRemoved: (target) => {
      itemFor(target).removed = true;
      flush();
    },
    close: () => {
      fs.rmSync(journalPathFor(projectDir), { force: true });
    },
  };
}

function restoreFromBackup(projectDir: string, item: ValidatedJournalItem): void {
  const backupAbs = item.backupAbs as string;
  assertNoSymlinkComponents(projectDir, backupAbs, "journal backup");
  const backupStat = fs.lstatSync(backupAbs);
  if (backupStat.isSymbolicLink()) {
    fail(`journal backup must not be a symlink: ${backupAbs}`);
  }
  assertNoSymlinkComponents(projectDir, item.targetAbs, "journal target");
  if (pathPresent(item.targetAbs)) {
    fail(`journal restore refused: target and backup both exist for ${item.target}`);
  }
  ensureDir(path.dirname(item.targetAbs));
  fs.renameSync(backupAbs, item.targetAbs);
}

function isManagedRecord(entry: unknown, target: string): boolean {
  return (
    !!entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    (entry as Record<string, unknown>).managedBy === "skill-sys" &&
    (entry as Record<string, unknown>).target === target
  );
}

function hasManagedRecordFor(workingInstalled: unknown[] | null, target: string): boolean {
  return workingInstalled !== null && workingInstalled.some((entry) => isManagedRecord(entry, target));
}

const OWNERSHIP_REFUSAL_SUFFIX = "'; refusing journal-driven mutation (manual recovery required)";

/**
 * A journal alone is not ownership proof. Any recovery branch that deletes,
 * overwrites, or restores into a target first requires an existing
 * `.skills.state.json` record with `managedBy:"skill-sys"` for that exact
 * project-relative target.
 */
function assertManagedTargetOwnership(workingInstalled: unknown[] | null, target: string): void {
  if (!hasManagedRecordFor(workingInstalled, target)) {
    fail(`no skill-sys-managed state record proves ownership of '${target}${OWNERSHIP_REFUSAL_SUFFIX}`);
  }
}

function freshTargetDigest(targetAbs: string, label: string): string {
  const stat = fs.lstatSync(targetAbs);
  if (stat.isSymbolicLink()) {
    fail(`completed journal target must not be a symlink: ${targetAbs}`);
  }
  if (stat.isDirectory()) {
    // Strict walk: symlinked entries abort instead of being silently omitted.
    return digestTreeStrict(targetAbs);
  }
  if (stat.isFile()) {
    return hashFile(targetAbs);
  }
  fail(`completed journal target has unsupported type: ${targetAbs} (${label})`);
}

function removeGuardedTempRoot(projectDir: string, rootDir: string): void {
  assertNoSymlinkComponents(projectDir, rootDir, "journal temp root");
  if (!pathPresent(rootDir)) {
    return;
  }
  const stat = fs.lstatSync(rootDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`journal temp root must be a real directory: ${rootDir}`);
  }
  fs.rmSync(rootDir, { recursive: true, force: true });
  const parent = path.dirname(rootDir);
  try {
    if (fileExists(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
  } catch {
    // Parent cleanup is best-effort; the guarded root removal already ran.
  }
}

/**
 * Recover a leftover apply journal under the canonical project mutation lock.
 * No-op when no journal exists. Throws (mutating nothing) on malformed,
 * path-escaping, or symlink-protected journals; otherwise repairs the
 * filesystem for incomplete commits, reconciles state by target identity for
 * completed ones, cleans the apply's temp roots, and removes the journal
 * last. Target mutation additionally requires a `managedBy:"skill-sys"` state
 * record for the exact project-relative target: untracked targets and
 * missing/invalid state fail closed before any mutation with journal, targets,
 * and backups preserved for manual recovery. Temp roots are only cleaned after
 * target recovery succeeds. Backups are deliberately never deleted by
 * recovery.
 */
export function recoverApplyJournal(projectDir: string): void {
  const journalPath = journalPathFor(projectDir);
  if (!fileExists(journalPath)) {
    return;
  }

  const journal = readValidatedJournal(projectDir);

  const statePath = path.join(projectDir, STATE_FILENAME);
  let state: Record<string, unknown> | null = null;
  if (fileExists(statePath)) {
    if (fs.lstatSync(statePath).isSymbolicLink()) {
      fail(`state must not be a symlink: ${statePath}`);
    }
    const parsed = readJson<Record<string, unknown>>(statePath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`state must be a JSON object: ${statePath}`);
    }
    if (parsed.installed !== undefined && !Array.isArray(parsed.installed)) {
      fail(`state.installed must be an array: ${statePath}`);
    }
    state = parsed;
  }
  const workingInstalled: unknown[] | null = Array.isArray(state?.installed)
    ? [...(state.installed as unknown[])]
    : null;
  let stateChanged = false;

  // Ownership pre-pass: a journal is never proof that skill-sys owns a target.
  // Before any branch below may delete, overwrite, or restore into a target,
  // every swap item that could require such a mutation must be backed by an
  // existing `managedBy:"skill-sys"` state record for the exact target.
  // Untracked targets and missing/invalid state abort here, preserving the
  // journal, targets, and backups for manual recovery.
  for (const item of journal.items) {
    if (item.action !== "swap") {
      continue; // Remove items never mutate targets during recovery.
    }
    const targetPresent = pathPresent(item.targetAbs);
    const backupPresent = item.backupAbs !== null && pathPresent(item.backupAbs);
    const mayMutateTarget =
      (targetPresent && backupPresent) || // completed-or-poisoned swap decision
      (!item.hadTarget && targetPresent) || // fresh replacement reconcile-or-undo
      (!targetPresent && backupPresent); // half-swapped restore
    if (mayMutateTarget) {
      assertManagedTargetOwnership(workingInstalled, item.target);
    }
  }

  for (const item of journal.items) {
    const targetPresent = pathPresent(item.targetAbs);
    const backupPresent = item.backupAbs !== null && pathPresent(item.backupAbs);

    if (item.action === "swap") {
      if (targetPresent && backupPresent) {
        // Completed swap (step flags may lag the renames): the target holds
        // post-apply content and the backup holds the pre-apply target.
        if (!item.hadTarget) {
          fail(`fresh swap item cannot have both target and backup: ${item.target}`);
        }
        // The pre-pass proved managed ownership for this branch.
        const freshDigest = freshTargetDigest(item.targetAbs, item.target);
        for (const entry of workingInstalled as Array<Record<string, unknown>>) {
          if (
            isManagedRecord(entry, item.target) &&
            typeof entry.skillDigest === "string" &&
            entry.skillDigest !== freshDigest
          ) {
            entry.skillDigest = freshDigest;
            stateChanged = true;
          }
        }
      } else if (targetPresent) {
        if (!item.hadTarget) {
          // The journal recorded no prior target; only our swapped-in
          // replacement can be reconciled, never deleted without a managed
          // state record proving ownership (enforced by the pre-pass).
          assertManagedTargetOwnership(workingInstalled, item.target);
          const freshDigest = freshTargetDigest(item.targetAbs, item.target);
          for (const entry of workingInstalled as Array<Record<string, unknown>>) {
            if (
              isManagedRecord(entry, item.target) &&
              typeof entry.skillDigest === "string" &&
              entry.skillDigest !== freshDigest
            ) {
              entry.skillDigest = freshDigest;
              stateChanged = true;
            }
          }
        }
        // hadTarget && !backupPresent: either the untouched original or an
        // already-restored/consumed swap; the surviving state already
        // describes the on-disk content, so nothing to repair.
      } else if (backupPresent) {
        // Half-swapped: the prior target lives in the backup.
        restoreFromBackup(projectDir, item);
      } else if (item.hadTarget) {
        fail(`journaled target and backup are both missing: ${item.target}`);
      }
    } else {
      // Remove action.
      if (targetPresent) {
        if (item.removed) {
          fail(`journaled removal target reappeared: ${item.target}`);
        }
        // Removal never executed; nothing to reconcile.
      } else if (item.removed || backupPresent) {
        // Completed removal (flag or backup evidence): finish it in state by
        // dropping only the touched managed entries for this target.
        if (workingInstalled !== null) {
          const filtered = workingInstalled.filter((entry) => !isManagedRecord(entry, item.target));
          if (filtered.length !== workingInstalled.length) {
            workingInstalled.splice(0, workingInstalled.length, ...filtered);
            stateChanged = true;
          }
        }
      }
      // Absent target with no removal flag and no backup: benign pre-apply
      // disappearance; the surviving state entry keeps describing it.
    }
  }

  if (stateChanged && state) {
    state.installed = workingInstalled;
    writeFileAtomicSafe(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  // Cleanup is best-effort-converging: state reconciliation has already
  // committed, so a cleanup failure leaves the journal for an idempotent
  // replay instead of corrupting anything.
  const tempRoots = new Set<string>();
  for (const item of journal.items) {
    if (item.action === "swap" && item.tempAbs) {
      tempRoots.add(path.join(path.dirname(item.targetAbs), TMP_DIRNAME, journal.applyId));
    }
  }
  for (const rootDir of tempRoots) {
    removeGuardedTempRoot(projectDir, rootDir);
  }

  fs.rmSync(journalPath, { force: true });
}
