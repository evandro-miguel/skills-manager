#!/usr/bin/env bun
/**
 * update-check: read-only check for available updates on declared third-party
 * skill sources.
 *
 * Reads the source manifest (`skill-sys.sources.json`) and the current source
 * lock (`skill-sys.sources.lock.json`), resolves each declared ref against its
 * remote via `git ls-remote`, and reports whether the locked commit still
 * matches the latest resolved commit. It never writes files and never applies
 * updates.
 *
 * Output: the update report is printed as JSON to stdout (see
 * `schema/update-report.schema.json`). A short human-readable summary is
 * printed to stderr. The default exit code is 0 even when updates are
 * available; pass `--strict` to exit non-zero on any `update-available` or
 * `error` entry.
 */

import path from "node:path";
import { runCommand } from "../lib/command.ts";
import { fileExists } from "../lib/files.ts";
import { assertSafeGitRef, isFullCommitSha } from "../lib/git-ref.ts";
import {
  findDuplicateSkills,
  loadSourceManifest,
  type SourceManifest,
} from "../modules/skill-sys/source-manifest.ts";
import {
  loadSourceLock,
  type SourceLock,
} from "../modules/skill-sys/source-lock.ts";

const DEFAULT_MANIFEST_NAME = "skill-sys.sources.json";
const DEFAULT_LOCK_NAME = "skill-sys.sources.lock.json";

export type UpdateReportStatus = "up-to-date" | "update-available" | "error";

export type UpdateReportEntry = {
  name: string;
  status: UpdateReportStatus;
  /** Currently locked ref (from the lock entry), when a lock entry exists. */
  currentRef?: string;
  /** Currently locked 40-char commit (from the lock entry). */
  currentCommit?: string;
  /** Declared ref from the manifest that was queried. */
  latestRef?: string;
  /** Latest resolved 40-char commit for the declared ref. */
  latestCommit?: string;
  /** Error message when status is "error". */
  error?: string;
};

export type UpdateReport = {
  checkedAt: string;
  entries: UpdateReportEntry[];
};

/** Resolves a declared (source, ref) to a full 40-char commit SHA. Throws on failure. */
export type ResolveRemoteRef = (source: string, ref: string) => string;

interface UpdateCheckArgs {
  source: string;
  manifest: string | null;
  lockfile: string | null;
  strict: boolean;
  json: boolean;
  help: boolean;
}

export type UpdateCheckOptions = {
  /** Base directory used to resolve default manifest/lock paths. Defaults to cwd. */
  source: string;
  /** Explicit manifest path (resolved against `source`). When null, the default name is used. */
  manifest: string | null;
  /** Explicit lock path (resolved against `source`). When null, the default name is used. */
  lockfile: string | null;
  strict: boolean;
  resolve?: ResolveRemoteRef;
  now?: () => string;
};

export type UpdateCheckResult = {
  report: UpdateReport;
  exitCode: number;
};

const HELP_TEXT = `Report available updates for declared third-party skill sources (read-only).

Usage:
  bun scripts/commands/update-check.ts [options]

Options:
  --source <dir>        Base directory for manifest/lock lookup (default: current directory)
  --manifest <path>     Manifest path (default: <source>/skill-sys.sources.json)
  --lockfile <path>     Lock path (default: <source>/skill-sys.sources.lock.json)
  --strict              Exit non-zero when any update is available or any check errors
  --json                Emit the JSON report to stdout (default behavior; accepted for consistency)
  --help                Show this help

The report schema is schema/update-report.schema.json. The default exit code is 0
even when updates are available; --strict inverts this for CI notification pipelines.
`;

function help(): void {
  console.log(HELP_TEXT);
}

function requireOptionValue(argv: string[], index: number, token: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${token}`);
  }
  return value;
}

export function parseArgs(argv: string[] = process.argv): UpdateCheckArgs {
  const args: UpdateCheckArgs = {
    source: ".",
    manifest: null,
    lockfile: null,
    strict: false,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--strict") {
      args.strict = true;
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

/** Parse the first 40-char SHA from `git ls-remote` output (`<sha>\t<ref>` lines). */
function parseFirstLsRemoteSha(output: string): string | null {
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const sha = line.split(/\s+/, 1)[0];
    if (sha && /^[a-f0-9]{40}$/i.test(sha)) {
      return sha.toLowerCase();
    }
  }
  return null;
}

/**
 * Default remote-ref resolver. Uses `git ls-remote --exit-code` (no shell) to
 * resolve the declared ref to a commit SHA. A full commit SHA is returned as-is
 * (a pinned commit cannot drift). Throws on any failure, which the caller turns
 * into an `error` report entry.
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
  const commit = parseFirstLsRemoteSha(result.stdout);
  if (!commit) {
    throw new Error(`git ls-remote returned no commit for ref '${ref}' in '${source}'`);
  }
  return commit;
}

function toIsoNow(now: (() => string) | undefined): string {
  return (now ?? (() => new Date().toISOString()))();
}

/**
 * Build the update report from already-loaded, validated manifest and lock.
 * Pure and synchronous given the injected resolver; safe to unit test without
 * any network access.
 */
export function buildUpdateReport(
  manifest: SourceManifest,
  lock: SourceLock,
  resolve: ResolveRemoteRef,
  now?: () => string,
): UpdateReport {
  const lockByName = new Map<string, SourceLock["sources"][number]>();
  for (const lockEntry of lock.sources) {
    lockByName.set(lockEntry.name, lockEntry);
  }

  const entries: UpdateReportEntry[] = [];
  for (const declared of manifest.sources) {
    const lockEntry = lockByName.get(declared.name);

    let latestCommit: string | null = null;
    let resolveError: string | null = null;
    try {
      // A pinned full commit SHA cannot drift and needs no network lookup.
      if (isFullCommitSha(declared.ref)) {
        latestCommit = declared.ref.toLowerCase();
      } else {
        latestCommit = resolve(declared.source, declared.ref).toLowerCase();
        if (!isFullCommitSha(latestCommit)) {
          throw new Error(`resolver returned an invalid commit SHA for '${declared.name}'`);
        }
      }
    } catch (error) {
      resolveError = error instanceof Error ? error.message : String(error);
    }

    if (resolveError) {
      const entry: UpdateReportEntry = {
        name: declared.name,
        status: "error",
        error: resolveError,
      };
      if (lockEntry) {
        entry.currentRef = lockEntry.ref;
        entry.currentCommit = lockEntry.resolvedCommit.toLowerCase();
      }
      entries.push(entry);
      continue;
    }

    const latest = latestCommit as string;

    if (lockEntry) {
      const currentCommit = lockEntry.resolvedCommit.toLowerCase();
      entries.push({
        name: declared.name,
        status: currentCommit === latest ? "up-to-date" : "update-available",
        currentRef: lockEntry.ref,
        currentCommit,
        latestRef: declared.ref,
        latestCommit: latest,
      });
    } else {
      entries.push({
        name: declared.name,
        status: "update-available",
        latestRef: declared.ref,
        latestCommit: latest,
      });
    }
  }

  return { checkedAt: toIsoNow(now), entries };
}

export type MainDeps = {
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  resolve?: ResolveRemoteRef;
  now?: () => string;
};

/**
 * Load manifest and lock from disk, validate them, reject duplicate skill
 * names, and build the update report. Throws on usage errors (missing or
 * invalid manifest/lock, duplicate names); the caller decides the exit code.
 */
export function runUpdateCheck(options: UpdateCheckOptions): UpdateCheckResult {
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
  const manifest = loadSourceManifest(manifestPath);

  const duplicates = findDuplicateSkills(manifest);
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate skill names in manifest: ${duplicates.join(", ")}`,
    );
  }

  if (!fileExists(lockPath)) {
    throw new Error(
      `Source lock not found at ${lockPath}. update-check requires a resolved lock; ` +
        "run 'skill-sys generate-lock' to create it.",
    );
  }
  const lock = loadSourceLock(lockPath);

  const resolve = options.resolve ?? resolveRemoteRefViaGit;
  const report = buildUpdateReport(manifest, lock, resolve, options.now);

  const hasActionable = report.entries.some(
    (entry) => entry.status === "update-available" || entry.status === "error",
  );
  const exitCode = options.strict && hasActionable ? 1 : 0;

  return { report, exitCode };
}

function summarize(report: UpdateReport): { upToDate: number; updates: number; errors: number } {
  let upToDate = 0;
  let updates = 0;
  let errors = 0;
  for (const entry of report.entries) {
    if (entry.status === "up-to-date") {
      upToDate += 1;
    } else if (entry.status === "update-available") {
      updates += 1;
    } else {
      errors += 1;
    }
  }
  return { upToDate, updates, errors };
}

export function main(argv: string[] = process.argv, deps: MainDeps = {}): number {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;

  const args = parseArgs(argv);
  if (args.help) {
    stdout(HELP_TEXT);
    return 0;
  }

  try {
    const options: UpdateCheckOptions = {
      source: args.source,
      manifest: args.manifest,
      lockfile: args.lockfile,
      strict: args.strict,
    };
    if (deps.resolve) {
      options.resolve = deps.resolve;
    }
    if (deps.now) {
      options.now = deps.now;
    }
    const { report, exitCode } = runUpdateCheck(options);
    stdout(JSON.stringify(report, null, 2));
    const counts = summarize(report);
    stderr(
      `Checked ${report.entries.length} source(s): ${counts.upToDate} up-to-date, ` +
        `${counts.updates} update(s) available, ${counts.errors} error(s).`,
    );
    return exitCode;
  } catch (error) {
    stderr(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

export { resolveRemoteRefViaGit };
