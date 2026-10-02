#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SKIP_ENTRY_NAMES = new Set([
  ".git",
  ".venv",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".next",
  "dist",
  "build",
]);

type SkipNames = Iterable<string> | Set<string>;

type RecursiveListOptions = {
  skipNames?: SkipNames;
};

type CopyDirectoryOptions = {
  dryRun?: boolean;
  skipNames?: SkipNames;
};

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function readJson<T = unknown>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    throw new Error(`Invalid JSON at ${filePath}: ${toErrorMessage(error)}`);
  }
}

export function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function ensureNoSymlinkParents(targetPath: string): void {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedParent = path.dirname(resolvedTarget);
  const parsed = path.parse(resolvedParent);
  const tail = resolvedParent.slice(parsed.root.length);
  const segments = tail.split(path.sep).filter(Boolean);

  let current = parsed.root || path.sep;
  if (fileExists(current) && fs.lstatSync(current).isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked parent path: ${current}`);
  }

  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fileExists(current)) {
      break;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked parent path: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Parent path is not a directory: ${current}`);
    }
  }
}

function assertSafeWriteTarget(filePath: string): void {
  if (!fileExists(filePath)) {
    return;
  }

  const linkStat = fs.lstatSync(filePath);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlink target: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Refusing to overwrite non-file target: ${filePath}`);
  }
  if (stat.nlink > 1) {
    throw new Error(`Refusing to overwrite hardlinked target: ${filePath}`);
  }
}

export function writeFileAtomicSafe(filePath: string, content: string): void {
  const resolvedPath = path.resolve(filePath);
  const parentDir = path.dirname(resolvedPath);
  ensureNoSymlinkParents(resolvedPath);
  ensureDir(parentDir);
  ensureNoSymlinkParents(resolvedPath);
  assertSafeWriteTarget(resolvedPath);

  const tempFile = path.join(
    parentDir,
    `.tmp-${path.basename(resolvedPath)}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  try {
    fs.writeFileSync(tempFile, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tempFile, resolvedPath);
  } finally {
    if (fileExists(tempFile)) {
      fs.rmSync(tempFile, { force: true });
    }
  }
}

export type FileLockOutcome<T> =
  | { status: "acquired"; value: T }
  | { status: "locked" };

/**
 * Crash-window grace for unparseable lock files (zero-byte or truncated JSON).
 * A writer creates its lock with O_EXCL and writes the owner payload moments
 * later; a crash between those two steps leaves an unparseable lock that would
 * otherwise wedge every later acquisition behind a misleading "locked by
 * another writer" report. Locks younger than this grace are never stolen —
 * they may belong to a live writer mid-write — so acquisition fails with an
 * actionable {@link CorruptLockError} naming the path instead. After the grace
 * the lock is broken, but only when an opened fd and the path still resolve to
 * the same inode immediately before unlink, so a replacement lock created
 * concurrently is never deleted.
 */
export const CORRUPT_LOCK_GRACE_MS = 5_000;

/**
 * Bounded synchronous re-poll for a fresh unparseable lock that may still be
 * mid-write by a live concurrent writer (payload typically lands within
 * microseconds of O_EXCL creation). Kept well under CORRUPT_LOCK_GRACE_MS.
 */
const CORRUPT_LOCK_RECHECKS = 8;
const CORRUPT_LOCK_RECHECK_DELAY_MS = 25;

/** Distinct, actionable failure for corrupt/unrecognized fresh lock files. */
export class CorruptLockError extends Error {
  readonly lockPath: string;
  readonly detail: string;

  constructor(lockPath: string, detail: string) {
    super(
      `File lock at ${lockPath} is corrupt or unrecognized (${detail}); it was not stolen automatically. ` +
        `After confirming no writer is active, remove the lock manually and retry: ${lockPath}`
    );
    this.name = "CorruptLockError";
    this.lockPath = lockPath;
    this.detail = detail;
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait unavailable on this thread: degrade to immediate rechecks.
  }
}

type LockPayloadClassification =
  | { kind: "ok"; payload: FileLockPayload }
  | { kind: "unparseable"; detail: string }
  | { kind: "unrecognized" };

/**
 * Classify a lock file payload for the acquisition path. "unparseable" means
 * the bytes could not be read as JSON at all (crash-window artifact eligible
 * for grace-aged recovery); "unrecognized" means parseable JSON that is not a
 * lock format this implementation manages, which is never broken or released.
 */
function classifyLockPayload(lockPath: string): LockPayloadClassification {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return { kind: "unparseable", detail: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "unparseable",
      detail: raw.trim().length === 0 ? "empty file" : `invalid JSON (${detail})`,
    };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as Partial<FileLockPayload>).pid !== "number" ||
    !Number.isInteger((parsed as Partial<FileLockPayload>).pid) ||
    ((parsed as Partial<FileLockPayload>).pid as number) <= 0
  ) {
    return { kind: "unrecognized" };
  }
  const record = parsed as Partial<FileLockPayload>;
  const token = typeof record.token === "string" && record.token.length > 0 ? record.token : null;
  const timestamp = typeof record.timestamp === "number" ? record.timestamp : null;
  // Current locks always carry a token; legacy locks carry only a timestamp.
  // A payload with neither is not recognizable as a lock this implementation
  // may manage, so it must never be broken or released.
  if (token === null && timestamp === null) {
    return { kind: "unrecognized" };
  }
  return { kind: "ok", payload: { pid: record.pid as number, token, timestamp: timestamp ?? 0 } };
}

type FileLockOptions = {
  maxAttempts?: number;
};

type FileLockPayload = {
  pid: number;
  /** Null for legacy tokenless locks (`{pid,timestamp}`) written by older versions. */
  token: string | null;
  timestamp: number;
};

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLockPayload(lockPath: string): FileLockPayload | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<FileLockPayload> | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0
    ) {
      return null;
    }
    const token = typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
    const timestamp = typeof parsed.timestamp === "number" ? parsed.timestamp : null;
    // Current locks always carry a token; legacy locks carry only a timestamp.
    // A payload with neither is not recognizable as a lock this implementation
    // may manage, so it must never be broken or released.
    if (token === null && timestamp === null) {
      return null;
    }
    return { pid: parsed.pid, token, timestamp: timestamp ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Break an aged unparseable lock. The opened fd and the path are rechecked for
 * dev+inode identity immediately before unlink, so a lock file replaced by
 * another process (new inode) between classification and deletion is never
 * removed, and a payload that became parseable in the meantime is left to the
 * normal live/stale rules.
 */
function breakAgedUnparseableLock(lockPath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "r");
  } catch {
    return false;
  }
  try {
    if (classifyLockPayload(lockPath).kind !== "unparseable") {
      return false;
    }
    const opened = fs.fstatSync(fd);
    // Identity recheck immediately before unlink.
    const currentStat = fs.statSync(lockPath);
    if (currentStat.dev !== opened.dev || currentStat.ino !== opened.ino) {
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // fd already closed or vanished
    }
  }
}

/**
 * Decide what to do with an existing lock file at acquisition time:
 * "retry" means the caller may attempt O_EXCL creation again, "locked" means
 * acquisition must fail with `{ status: "locked" }`. Throws CorruptLockError
 * for fresh unparseable locks (after a brief mid-write re-poll) and for aged
 * unparseable locks that survived every recovery attempt.
 */
function handleExistingLock(
  lockPath: string,
  attempt: number,
  maxAttempts: number
): "retry" | "locked" {
  let classification = classifyLockPayload(lockPath);
  if (classification.kind === "unparseable") {
    let ageMs: number;
    try {
      ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      return "retry"; // Lock vanished between EEXIST and classification.
    }
    if (ageMs < CORRUPT_LOCK_GRACE_MS) {
      // A concurrent writer may be between O_EXCL creation and its payload
      // write; re-poll briefly before reporting corruption.
      for (let recheck = 0; recheck < CORRUPT_LOCK_RECHECKS; recheck += 1) {
        sleepSync(CORRUPT_LOCK_RECHECK_DELAY_MS);
        classification = classifyLockPayload(lockPath);
        if (classification.kind !== "unparseable") {
          break;
        }
      }
      if (classification.kind === "unparseable") {
        throw new CorruptLockError(
          lockPath,
          `${classification.detail}; younger than the ${CORRUPT_LOCK_GRACE_MS}ms crash-window grace`
        );
      }
    }
    if (classification.kind === "unparseable") {
      const broke = attempt < maxAttempts ? breakAgedUnparseableLock(lockPath) : false;
      if (broke) {
        return "retry";
      }
      // Re-classify: the payload may have become parseable (or vanished)
      // between the age check and the break attempt.
      classification = classifyLockPayload(lockPath);
      if (classification.kind === "unparseable") {
        throw new CorruptLockError(
          lockPath,
          `${classification.detail}; older than the ${CORRUPT_LOCK_GRACE_MS}ms crash-window grace` +
            (attempt < maxAttempts ? " but could not be recovered" : " and still unrecoverable after all attempts")
        );
      }
    }
  }
  if (classification.kind === "ok" && !isPidAlive(classification.payload.pid)) {
    if (!breakStaleLockFile(lockPath)) {
      return "locked";
    }
    return "retry";
  }
  // Live valid locks and parseable-but-unrecognized payloads are never managed.
  return "locked";
}

function breakStaleLockFile(lockPath: string): boolean {
  const observed = readLockPayload(lockPath);
  if (!observed || isPidAlive(observed.pid)) return false;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "r");
  } catch {
    return false;
  }
  try {
    const opened = fs.fstatSync(fd);
    const currentStat = fs.statSync(lockPath);
    if (currentStat.dev !== opened.dev || currentStat.ino !== opened.ino) {
      return false;
    }
    const current = readLockPayload(lockPath);
    if (!current || current.token !== observed.token || isPidAlive(current.pid)) {
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // fd already closed or vanished
    }
  }
}

// Compare-and-delete release: unlink only if the on-disk file is still the one
// this holder created (same inode) and still carries this holder's token, so a
// holder whose lock was broken and replaced never deletes the new owner's lock.
function releaseOwnedLock(fd: number, lockPath: string, token: string | null): void {
  try {
    const created = fs.fstatSync(fd);
    const current = fs.statSync(lockPath);
    const payload = readLockPayload(lockPath);
    const sameInode = current.dev === created.dev && current.ino === created.ino;
    if (sameInode && (token === null || payload?.token === token)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Lock already vanished or became unreadable; nothing left to release.
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Run `fn` while holding an advisory `<targetPath>.lock` file created with
 * O_EXCL ("wx"). The lock records a cryptographically random owner token, the
 * owner PID, and a creation timestamp. When another writer holds the lock,
 * `{ status: "locked" }` is returned without running `fn`; only locks whose
 * owner PID is dead are broken, and only after the on-disk token still matches
 * the observed stale payload. Legacy tokenless `{pid,timestamp}` locks are
 * honored for compatibility: they are broken only when the owner PID is dead
 * and the opened file still matches the path's inode, and a live PID is never
 * stolen regardless of lock format.
 *
 * Unparseable lock payloads (zero-byte or truncated JSON, typically a crash
 * between O_EXCL creation and payload write) get a dedicated path: locks
 * younger than CORRUPT_LOCK_GRACE_MS raise CorruptLockError naming the lock
 * path instead of being stolen or misreported as a live writer; older ones are
 * broken only when an opened fd and the path still share the same inode
 * immediately before unlink. Acquisition is retried up to `maxAttempts`.
 * Release is compare-and-delete on the inode + token. The lock is always
 * released, including when `fn` throws.
 */
export function withFileLock<T>(
  targetPath: string,
  fn: () => T,
  options: FileLockOptions = {},
): FileLockOutcome<T> {
  const lockPath = `${path.resolve(targetPath)}.lock`;
  const maxAttempts = options.maxAttempts ?? 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (handleExistingLock(lockPath, attempt, maxAttempts) === "locked") {
        return { status: "locked" };
      }
      continue;
    }
    const token = crypto.randomBytes(16).toString("hex");
    let ownershipRecorded = false;
    try {
      fs.writeSync(
        fd,
        `${JSON.stringify({ pid: process.pid, token, timestamp: Date.now() } satisfies FileLockPayload)}\n`
      );
      ownershipRecorded = true;
      return { status: "acquired", value: fn() };
    } finally {
      // Before ownership is recorded the empty lock can only be ours, so an
      // inode-only check is sufficient there.
      releaseOwnedLock(fd, lockPath, ownershipRecorded ? token : null);
    }
  }
  return { status: "locked" };
}

// Canonical per-project APPLY mutation state shared by install/sync-plan/
// remove/rollback; its `.lock` sibling is the W5 serialization point.
export const PROJECT_STATE_FILENAME = ".skills.state.json";

/**
 * W5 canonical project mutation lock: every APPLY mutation (install,
 * sync-plan, remove, rollback) serializes on `<projectDir>/.skills.state.json`
 * and therefore its `.skills.state.json.lock` sibling. Planning/dry-run paths
 * never take it. A fresh corrupt lock file surfaces as a distinct actionable
 * error naming the path instead of a misleading "locked by another writer".
 */
export function withProjectMutationLock<T>(projectDir: string, fn: () => T): T {
  const statePath = path.join(projectDir, PROJECT_STATE_FILENAME);
  const lockPath = `${path.resolve(statePath)}.lock`;
  let outcome: FileLockOutcome<T>;
  try {
    outcome = withFileLock(statePath, fn);
  } catch (error) {
    if (error instanceof CorruptLockError) {
      throw new Error(
        `Project state lock at ${lockPath} is corrupt or unrecognized; no live writer can be confirmed. ` +
          `After confirming no APPLY command is running for this project, remove the lock manually and retry: ${lockPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (outcome.status === "locked") {
    throw new Error(`Project state is locked by another writer; retry: ${lockPath}`);
  }
  return outcome.value;
}

function normalizeSkipNames(skipNames?: SkipNames | null): Set<string> {
  if (!skipNames) {
    return new Set();
  }
  return skipNames instanceof Set ? skipNames : new Set(skipNames);
}

export function listFilesRecursive(rootDir: string, options: RecursiveListOptions = {}): string[] {
  const output: string[] = [];
  const skipNames = normalizeSkipNames(options.skipNames || DEFAULT_SKIP_ENTRY_NAMES);
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (skipNames.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      // lstat each entry instead of trusting Dirent type bits so digest/scanner traversals
      // fail closed around symlinks and remain correct on filesystems with unknown d_type.
      const linkStat = fs.lstatSync(fullPath);
      if (linkStat.isSymbolicLink()) {
        continue;
      }
      if (linkStat.isDirectory()) {
        stack.push(fullPath);
      } else if (linkStat.isFile()) {
        output.push(fullPath);
      }
    }
  }
  return output.sort((a, b) => a.localeCompare(b));
}

export function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function dirDigest(dirPath: string, options: RecursiveListOptions = {}): string {
  const files = listFilesRecursive(dirPath, options);
  const manifest = files
    .map((filePath) => {
      const rel = path.relative(dirPath, filePath).replaceAll("\\", "/");
      return `${rel}\0${hashFile(filePath)}`;
    })
    .join("\n");
  return crypto.createHash("sha256").update(manifest).digest("hex");
}

export type StrictWalkEntry =
  | { kind: "directory"; relativePath: string; absolutePath: string }
  | { kind: "file"; relativePath: string; absolutePath: string; bytes: Buffer };

type StrictWalkOptions = {
  exclude?: (relativePath: string) => boolean;
};

function normalizeRelPath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}

/**
 * Fail-closed tree walk with no implicit skip list: symlinks, sockets, FIFOs,
 * device nodes, and unknown entry types abort traversal, and file bytes are
 * read eagerly so read errors surface here. `exclude` receives
 * `/`-normalized relative paths and prunes matching files and subtrees.
 * Returned entries are sorted by relative path; the root itself is not included.
 */
export function walkTreeStrict(rootDir: string, options: StrictWalkOptions = {}): StrictWalkEntry[] {
  const resolvedRoot = path.resolve(rootDir);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to walk symlinked root: ${resolvedRoot}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Root path is not a directory: ${resolvedRoot}`);
  }
  const realRoot = fs.realpathSync(resolvedRoot);

  const entries: StrictWalkEntry[] = [];
  const visit = (absolutePath: string, relativePath: string): void => {
    const linkStat = fs.lstatSync(absolutePath);
    if (linkStat.isSymbolicLink()) {
      throw new Error(`Refusing to traverse symlinked entry: ${absolutePath}`);
    }
    const childReal = fs.realpathSync(absolutePath);
    // Never follow a resolution that leaves the walked tree.
    if (childReal !== realRoot && !childReal.startsWith(realRoot + path.sep)) {
      throw new Error(`Refusing to traverse path escaping tree root: ${absolutePath}`);
    }
    if (linkStat.isDirectory()) {
      if (relativePath !== "") {
        entries.push({ kind: "directory", relativePath, absolutePath });
      }
      for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
        const childAbsolute = path.join(absolutePath, entry.name);
        const childRelative = normalizeRelPath(path.join(relativePath, entry.name));
        if (options.exclude?.(childRelative)) {
          continue;
        }
        visit(childAbsolute, childRelative);
      }
      return;
    }
    if (linkStat.isSocket() || linkStat.isFIFO() || linkStat.isCharacterDevice() || linkStat.isBlockDevice()) {
      throw new Error(`Refusing unsupported entry type in tree: ${absolutePath}`);
    }
    if (!linkStat.isFile()) {
      throw new Error(`Refusing unknown entry type in tree: ${absolutePath}`);
    }
    entries.push({ kind: "file", relativePath, absolutePath, bytes: fs.readFileSync(absolutePath) });
  };

  visit(resolvedRoot, "");
  return entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

/**
 * Digest of `walkTreeStrict` output: each manifest line carries the entry
 * type, its `/`-normalized relative path, and (for files) the SHA-256 of the
 * file bytes, so digests match regardless of host path separators and change
 * on any content or layout modification.
 */
export function digestTreeStrict(rootDir: string, options: StrictWalkOptions = {}): string {
  const manifest = walkTreeStrict(rootDir, options)
    .map((entry) => {
      if (entry.kind === "directory") {
        return `dir\0${entry.relativePath}`;
      }
      const fileHash = crypto.createHash("sha256").update(entry.bytes).digest("hex");
      return `file\0${entry.relativePath}\0${fileHash}`;
    })
    .join("\n");
  return crypto.createHash("sha256").update(manifest).digest("hex");
}

export function copyDirectory(srcDir: string, destDir: string, options: CopyDirectoryOptions = {}): void {
  const dryRun = options.dryRun === true;
  const skipNames = normalizeSkipNames(options.skipNames || DEFAULT_SKIP_ENTRY_NAMES);
  const srcStat = fs.lstatSync(srcDir);
  if (srcStat.isSymbolicLink()) {
    throw new Error(`Refusing to copy from symlinked directory: ${srcDir}`);
  }
  if (!srcStat.isDirectory()) {
    throw new Error(`Source path is not a directory: ${srcDir}`);
  }

  if (!dryRun) {
    ensureDir(destDir);
  }

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) {
      continue;
    }

    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to copy symlinked entry: ${srcPath}`);
    }

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath, { dryRun, skipNames });
    } else if (entry.isFile() && !dryRun) {
      ensureDir(path.dirname(destPath));
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
