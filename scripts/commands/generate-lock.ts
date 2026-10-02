#!/usr/bin/env bun
/**
 * generate-lock: resolve declared third-party skill sources and materialize a
 * pinned `skill-sys.sources.lock.json` from `skill-sys.sources.json`.
 *
 * For each manifest source it:
 *   1. Validates the source is a safe remote Git repository (rejects file://,
 *      loopback/private hosts, and credential-bearing URLs) before any network
 *      or materialization step.
 *   2. Validates a declared `skillPath` is free of traversal/backslash escapes.
 *   3. Resolves the declared ref to a 40-char commit and materializes a
 *      checked-out tree.
 *   4. Locates the SKILL.md within the checkout (required at `skillPath` when
 *      declared, otherwise a single recursive match).
 *
 * The resulting lock is assembled via the pure `buildSourceLock` helper and
 * written with deterministic key ordering unless `--dry-run` is set.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../lib/command.ts";
import { fileExists, listFilesRecursive } from "../lib/files.ts";
import { assertSafeGitRef, isFullCommitSha } from "../lib/git-ref.ts";
import { normalizeSourceSpec } from "./skill-sys.ts";
import {
  findDuplicateSkills,
  loadSourceManifest,
  type SourceManifest,
  type SourceManifestEntry,
} from "../modules/skill-sys/source-manifest.ts";
import {
  buildSourceLock,
  writeSourceLock,
  type SourceLock,
  type SourceLockResolution,
} from "../modules/skill-sys/source-lock.ts";

const DEFAULT_MANIFEST_NAME = "skill-sys.sources.json";
const DEFAULT_LOCK_NAME = "skill-sys.sources.lock.json";

/** Resolves a declared (source, ref) to a full 40-char commit SHA. Throws on failure. */
export type ResolveRemoteRef = (source: string, ref: string) => string;

/**
 * Result of materializing a checked-out repository tree for a resolved commit.
 * `cleanup`, when present, removes the checkout and is invoked by the generator
 * after the SKILL.md has been located — on both success and failure.
 */
export type MaterializeResult = {
  /** Absolute path to the materialized checkout root. */
  checkout: string;
  /**
   * Optional cleanup invoked after the checkout's SKILL.md has been located, on
   * both success and failure. Production uses this to remove its temp checkout;
   * injected (test) materializers may omit it and manage the lifecycle itself.
   */
  cleanup?: () => void;
};

/**
 * Materializes a checked-out repository tree for a resolved commit. Returns
 * either the checkout root path (caller owns the lifecycle) or a result
 * carrying an optional `cleanup` that the generator invokes after locating the
 * SKILL.md.
 */
export type MaterializeSource = (
  source: string,
  ref: string,
  commit: string,
) => string | MaterializeResult;

export type GenerateLockArgs = {
  source: string;
  manifest: string | null;
  lockfile: string | null;
  dryRun: boolean;
  json: boolean;
  help: boolean;
};

export type GenerateLockOptions = {
  /** Base directory used to resolve default manifest/lock paths. Defaults to cwd. */
  source: string;
  /** Explicit manifest path (resolved against `source`). When null, the default name is used. */
  manifest: string | null;
  /** Explicit lock path (resolved against `source`). When null, the default name is used. */
  lockfile: string | null;
  dryRun: boolean;
  resolve?: ResolveRemoteRef;
  materialize?: MaterializeSource;
  now?: () => string;
};

export type GenerateLockResult = {
  written: boolean;
  lockPath: string;
  lock: SourceLock;
};

export type GenerateLockMainDeps = {
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  resolve?: ResolveRemoteRef;
  materialize?: MaterializeSource;
  now?: () => string;
};

const HELP_TEXT = `Generate a pinned source lock from the source manifest (skill-sys.sources.json).

Usage:
  bun scripts/commands/generate-lock.ts [options]

Options:
  --source <dir>        Base directory for manifest/lock lookup (default: current directory)
  --manifest <path>     Manifest path (default: <source>/skill-sys.sources.json)
  --lockfile <path>     Lock path (default: <source>/skill-sys.sources.lock.json)
  --dry-run             Build the lock but do not write the lockfile
  --json                Emit the generated lock as JSON to stdout
  --help                Show this help

Each manifest source is resolved to a 40-char commit, materialized, and its
SKILL.md located. The lock schema is schema/source-lock.schema.json.
`;

function requireOptionValue(argv: string[], index: number, token: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${token}`);
  }
  return value;
}

export function parseArgs(argv: string[] = process.argv): GenerateLockArgs {
  const args: GenerateLockArgs = {
    source: ".",
    manifest: null,
    lockfile: null,
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
    if (token.startsWith("--")) {
      const value = requireOptionValue(argv, i, token);
      if (token === "--source") {
        args.source = value;
      } else if (token === "--manifest") {
        args.manifest = value;
      } else if (token === "--lockfile") {
        args.lockfile = value;
      } else {
        throw new Error(`Unknown option: ${token}`);
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function toIsoNow(now: (() => string) | undefined): string {
  return (now ?? (() => new Date().toISOString()))();
}

/**
 * Default remote-ref resolver. Resolves the declared ref to a 40-char commit
 * SHA via `git ls-remote --exit-code` (no shell). A pinned full commit SHA is
 * returned as-is. Throws on any failure.
 */
function resolveRemoteRefViaGit(source: string, ref: string): string {
  const safeRef = assertSafeGitRef(ref);
  if (isFullCommitSha(safeRef)) {
    return safeRef;
  }
  const result = runCommand(["git", "ls-remote", "--exit-code", source, safeRef], {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
    trimOutput: true,
  });
  if (result.code !== 0) {
    throw new Error(`git ls-remote failed for ref '${ref}' in '${source}'`);
  }
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const sha = line.split(/\s+/, 1)[0];
    if (sha && /^[a-f0-9]{40}$/i.test(sha)) {
      return sha.toLowerCase();
    }
  }
  throw new Error(`git ls-remote returned no commit for ref '${ref}' in '${source}'`);
}

/**
 * Default materializer. Clones the source and checks out the resolved commit
 * into a fresh temp directory (no shell). Returns the checkout root plus a
 * cleanup that removes the temp directory; the cleanup also runs on clone or
 * checkout failure so no temp checkout is ever leaked in /tmp.
 */
function materializeSourceViaGit(
  source: string,
  _ref: string,
  commit: string,
): MaterializeResult {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-generate-lock-"));
  const cleanup = (): void => {
    fs.rmSync(checkout, { recursive: true, force: true });
  };
  const clone = runCommand(["git", "clone", "--quiet", source, checkout], {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
  });
  if (clone.code !== 0) {
    cleanup();
    throw new Error(`git clone failed for '${source}'`);
  }
  const checkoutResult = runCommand(["git", "-C", checkout, "checkout", "--quiet", commit], {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
  });
  if (checkoutResult.code !== 0) {
    cleanup();
    throw new Error(`git checkout failed for commit '${commit}' in '${source}'`);
  }
  return { checkout, cleanup };
}

/**
 * Validate a manifest source is a safe remote Git repository. Delegates to the
 * shared `normalizeSourceSpec` classifier and requires `kind === "repo"`, which
 * rejects local paths, file:// URLs, loopback/private hosts, and credential
 * URLs before any resolve/materialize step.
 */
function assertSafeRemoteSource(rawSource: string): void {
  const spec = normalizeSourceSpec(rawSource);
  if (spec.kind !== "repo") {
    throw new Error(
      `Source '${rawSource}' must be a remote Git repository; local sources are not lockable.`,
    );
  }
}

/**
 * Reject skillPath values that could escape the checkout root: backslashes,
 * absolute paths, leading dots, empty segments, or parent traversal.
 */
function assertSafeSkillPath(skillPath: string): void {
  if (skillPath.includes("\\")) {
    throw new Error(`Unsafe skillPath '${skillPath}': backslash traversal is not allowed`);
  }
  if (path.isAbsolute(skillPath) || path.posix.isAbsolute(skillPath)) {
    throw new Error(`Unsafe skillPath '${skillPath}': absolute paths are not allowed`);
  }
  const segments = skillPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(".."))) {
    throw new Error(`Unsafe skillPath '${skillPath}': parent traversal is not allowed`);
  }
}

/**
 * Confirm a file is a regular file (not a symlink) rooted within `root`, both
 * lexically and after resolving intermediate symlinks via realpath.
 */
function assertRegularFileWithinRoot(filePath: string, root: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative === "" || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to read file outside checkout root: ${filePath}`);
  }
  if (!fs.existsSync(resolvedFile)) {
    return;
  }
  // Resolve intermediate symlinks and re-check containment: a path that is
  // lexically inside the root can still escape via a symlinked directory
  // (e.g. skills/alpha -> /etc makes skills/alpha/SKILL.md read outside).
  const realRoot = fs.realpathSync(resolvedRoot);
  const realFile = fs.realpathSync(resolvedFile);
  const realRelative = path.relative(realRoot, realFile);
  if (
    realRelative === "" ||
    realRelative === "." ||
    realRelative.startsWith("..") ||
    path.isAbsolute(realRelative)
  ) {
    throw new Error(`Refusing to read file outside checkout root: ${filePath}`);
  }
  const stat = fs.lstatSync(resolvedFile);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to follow symlinked SKILL.md: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`SKILL.md path is not a regular file: ${filePath}`);
  }
}

/**
 * Locate the SKILL.md path (relative, posix) within a materialized checkout.
 * When `skillPath` is declared, the manifest file must exist there. Otherwise a
 * single recursive match is required; zero or multiple matches are rejected.
 */
function findManifestPathInCheckout(checkout: string, skillPath: string | undefined): string {
  if (skillPath !== undefined) {
    const candidateAbsolute = path.join(checkout, ...skillPath.split("/"), "SKILL.md");
    assertRegularFileWithinRoot(candidateAbsolute, checkout);
    if (!fs.existsSync(candidateAbsolute)) {
      throw new Error(`SKILL.md not found at ${skillPath}/SKILL.md in checkout`);
    }
    return `${skillPath}/SKILL.md`;
  }

  const matches = listFilesRecursive(checkout)
    .filter((filePath) => path.basename(filePath) === "SKILL.md")
    .map((filePath) => {
      assertRegularFileWithinRoot(filePath, checkout);
      return path.relative(checkout, filePath).replaceAll("\\", "/");
    });

  if (matches.length === 0) {
    throw new Error("No SKILL.md found in checkout; declare a skillPath or add SKILL.md");
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple SKILL.md files found in checkout (${matches.join(", ")}); declare a skillPath to disambiguate`,
    );
  }
  return matches[0]!;
}

/**
 * Load and validate the manifest, reject duplicate skill names, resolve +
 * materialize each source safely, and assemble the source lock. Throws on
 * usage errors; the caller decides the exit code.
 */
export function runGenerateLock(options: GenerateLockOptions): GenerateLockResult {
  const baseDir = path.resolve(process.cwd(), options.source);
  const manifestPath = options.manifest
    ? path.resolve(baseDir, options.manifest)
    : path.join(baseDir, DEFAULT_MANIFEST_NAME);
  const lockPath = options.lockfile
    ? path.resolve(baseDir, options.lockfile)
    : path.join(baseDir, DEFAULT_LOCK_NAME);

  if (!fileExists(manifestPath)) {
    throw new Error(`Source manifest not found at ${manifestPath}`);
  }
  const manifest: SourceManifest = loadSourceManifest(manifestPath);

  const duplicates = findDuplicateSkills(manifest);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate skill names in manifest: ${duplicates.join(", ")}`);
  }

  const resolve = options.resolve ?? resolveRemoteRefViaGit;
  const materialize = options.materialize ?? materializeSourceViaGit;
  const now = toIsoNow(options.now);

  const resolutions: Record<string, SourceLockResolution> = {};
  for (const entry of manifest.sources) {
    resolveSourceEntry(entry, resolve, materialize, resolutions);
  }

  const lock = buildSourceLock(manifest, resolutions, now);

  let written = false;
  if (!options.dryRun) {
    writeSourceLock(lockPath, lock);
    written = true;
  }

  return { written, lockPath, lock };
}

function resolveSourceEntry(
  entry: SourceManifestEntry,
  resolve: ResolveRemoteRef,
  materialize: MaterializeSource,
  resolutions: Record<string, SourceLockResolution>,
): void {
  // 1. Source safety: must be a safe remote repository before any network step.
  assertSafeRemoteSource(entry.source);
  // 2. skillPath safety: reject traversal before resolve/materialize.
  if (entry.skillPath !== undefined) {
    assertSafeSkillPath(entry.skillPath);
  }
  // 3. Resolve the declared ref to a pinned commit.
  const resolvedCommit = resolve(entry.source, entry.ref);
  // 4. Materialize the checkout at that commit.
  const materialized = materialize(entry.source, entry.ref, resolvedCommit);
  const checkout = typeof materialized === "string" ? materialized : materialized.checkout;
  const cleanup = typeof materialized === "string" ? undefined : materialized.cleanup;
  // 5. Locate the SKILL.md within the checkout, then release the checkout on
  //    both success and failure so no temp directory is leaked.
  try {
    const manifestRelPath = findManifestPathInCheckout(checkout, entry.skillPath);
    resolutions[entry.name] = { resolvedCommit, manifestPath: manifestRelPath };
  } finally {
    cleanup?.();
  }
}

export function main(argv: string[] = process.argv, deps: GenerateLockMainDeps = {}): number {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;

  const args = parseArgs(argv);
  if (args.help) {
    stdout(HELP_TEXT);
    return 0;
  }

  try {
    const options: GenerateLockOptions = {
      source: args.source,
      manifest: args.manifest,
      lockfile: args.lockfile,
      dryRun: args.dryRun,
    };
    if (deps.resolve) {
      options.resolve = deps.resolve;
    }
    if (deps.materialize) {
      options.materialize = deps.materialize;
    }
    if (deps.now) {
      options.now = deps.now;
    }

    const result = runGenerateLock(options);

    if (args.json) {
      stdout(JSON.stringify(result.lock, null, 2));
    }

    if (result.written) {
      stderr(`Wrote ${result.lock.sources.length} source(s) to ${result.lockPath}`);
    } else {
      stderr(
        `Dry run: resolved ${result.lock.sources.length} source(s); nothing was written.`,
      );
    }
    return 0;
  } catch (error) {
    stderr(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}
