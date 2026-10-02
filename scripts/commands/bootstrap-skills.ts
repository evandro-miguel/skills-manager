#!/usr/bin/env bun
/**
 * Bootstrap a project with a .skills.lock.json and install skills.
 *
 * Flow:
 * 1) generate/overwrite lockfile from --repo/--ref/--apps/--profile/--skills
 * 2) run install-skills.ts (install + doctor)
 *
 * Remote repositories use a strict offline flow: the caller must supply a
 * complete strict policy (--policy-file), a v1 skill-sys.sources.lock.json
 * evidence file plus selected entry (--source-lock/--source-entry), a locally
 * materialized source checkout (--source), and prebuilt projection artifacts
 * (--projection-dir). Bootstrap binds this evidence into the primary lockfile
 * and never derives trust pins from the checkout, fetches the network, or
 * refreshes the source cache.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseCsv, requireOptionValue } from "../lib/args.ts";
import { runCommand } from "../lib/command.ts";
import { fileExists, readJson, writeJson } from "../lib/files.ts";
import { detectDefaultRepo as detectDefaultRepoFromLib, detectRemote as detectRemoteFromLib } from "../lib/git.ts";
import { redactRemoteForDiagnostics } from "../lib/redact.ts";
import { assertPathWithinProject } from "../modules/skillpool/entry.ts";
import { validateLockShape } from "../modules/skillpool/plan.ts";
import { validateSourceLock } from "../modules/skill-sys/source-lock.ts";

interface BootstrapArgs {
  repo: string;
  project: string;
  ref: string;
  lockfile: string;
  apps: string[];
  profile: string;
  skills: string[];
  source?: string;
  policyFile?: string;
  sourceLock?: string;
  sourceEntry?: string;
  projectionDir?: string;
  force: boolean;
  refreshCache: boolean;
  strictHash: boolean;
  dryRun: boolean;
  help?: boolean;
  [key: string]: unknown;
}

interface DetectDefaultRepoOptions {
  detectDefaultRepoFn?: () => string;
}

interface RunInstallerDeps {
  runCommand?: typeof runCommand;
  exit?: (code?: number) => never | void;
}

interface SourceLockBinding {
  path: string;
  sha256: string;
  entryName: string;
}

interface StrictEvidence {
  policy: Record<string, unknown>;
  sourceLockBinding: SourceLockBinding;
}

const SCRIPT_DIR = __dirname;
const INSTALLER = path.join(SCRIPT_DIR, "install-skills.ts");
const UNIVERSAL_ROOT = path.resolve(SCRIPT_DIR, "../..");
const OPENCODE_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..", "..");

const REMOTE_REPO_PATTERNS = [
  /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, // scheme URLs (https://, ssh://, ...)
  /^[^/@]+@[^:/]+:/, // scp-like syntax (git@host:path)
];

function help(): void {
  console.log(`
Bootstrap project skills from private git repo

Usage:
  bun scripts/commands/bootstrap-skills.ts [options]

Optional:
  --repo <git-url-or-path>      Skills repository (default: OpenCode origin; fallback local path)
  --project <dir>               Project directory (default: current directory)
  --ref <tag|branch|sha>        Git ref (default: main)
  --lockfile <file>             Lockfile name/path relative to project (default: .skills.lock.json)
  --apps <csv>                  Project app labels to install (default: opencode; project installs target .agents/skills)
  --profile <name>              Profile name for each app (default: core)
  --skills <csv>                Extra direct skills for each app (optional)
  --source <dir>                Local source override for install step (required for remote repos)
  --policy-file <json>          Complete strict install policy JSON (required for remote repos)
  --source-lock <file>          skill-sys.sources.lock.json v1 evidence file (required for remote repos)
  --source-entry <name>         Selected source-lock entry name (required for remote repos)
  --projection-dir <dir>        Prebuilt provider projections directory (required for remote repos)
  --force                       Overwrite lockfile if it exists
  --refresh-cache               Refresh source cache before install (rejected for remote repos)
  --strict-hash                 Run doctor with strict hash
  --dry-run                     Print actions without writing files
  --help                        Show help

Examples:
  bun scripts/commands/bootstrap-skills.ts --project .
  bun scripts/commands/bootstrap-skills.ts --repo git@github.com:you/skills-pool.git --apps opencode --profile core --skills writing-skills
`);
}

function detectRemote(repoPath: string): string | null {
  return detectRemoteFromLib(repoPath);
}

function detectDefaultRepo(): string {
  return detectDefaultRepoFromLib({
    universalRoot: UNIVERSAL_ROOT,
    opencodeRoot: OPENCODE_ROOT,
    exists: fileExists,
  });
}

/**
 * A repo is remote unless it names an existing local directory. Unknown or
 * nonexistent values are treated as remote so the strict offline gate fails
 * closed instead of silently attempting a fetch.
 */
function isRemoteRepo(repo: string): boolean {
  if (REMOTE_REPO_PATTERNS.some((pattern) => pattern.test(repo))) {
    return true;
  }
  try {
    return !fs.statSync(repo).isDirectory();
  } catch (_error) {
    return true;
  }
}

function requireRegularFile(filePath: string, label: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (_error) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked ${label}: ${filePath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
}

function buildInstalls(options: BootstrapArgs): Array<{ app: string; profile?: string; skills?: string[] }> {
  return options.apps.map((app) => {
    const entry: { app: string; profile?: string; skills?: string[] } = { app };
    if (options.profile) {
      entry.profile = options.profile;
    }
    if (options.skills.length) {
      entry.skills = options.skills;
    }
    return entry;
  });
}

/**
 * Assemble the strict offline evidence required by remote bootstraps. Every
 * input is validated here, before any byte is written: the policy must be a
 * regular non-symlink file that is complete under the existing remote lockfile
 * policy validator, and the v1 source lock must be a project-contained regular
 * non-symlink file whose selected entry matches repo/ref/policy sourceCommit
 * exactly. Only the source-lock bytes hash is computed, purely to bind bytes.
 */
function assembleStrictOfflineEvidence(
  options: BootstrapArgs,
  installs: Array<{ app: string; profile?: string; skills?: string[] }>
): StrictEvidence {
  if (options.refreshCache) {
    throw new Error(
      "Strict offline bootstrap rejects --refresh-cache: refreshing the source cache fetches network state"
    );
  }

  const missing: string[] = [];
  if (!options.policyFile) {
    missing.push("--policy-file <json> with the complete strict install policy");
  }
  if (!options.sourceLock) {
    missing.push("--source-lock <file> (v1 skill-sys.sources.lock.json evidence)");
  }
  if (!options.sourceEntry) {
    missing.push("--source-entry <name> (selected source-lock entry)");
  }
  if (!options.source) {
    missing.push("--source <dir> (local materialized source checkout)");
  }
  if (!options.projectionDir) {
    missing.push("--projection-dir <dir> (prebuilt provider projection artifacts)");
  }
  if (missing.length) {
    throw new Error(
      `Refusing legacy remote bootstrap (no silent trust-on-first-use migration). Remote bootstrap requires strict offline evidence inputs:\n- ${missing.join("\n- ")}`
    );
  }

  const policyPath = path.resolve(String(options.policyFile));
  requireRegularFile(policyPath, "--policy-file");
  const policyValue = readJson<unknown>(policyPath);
  if (!policyValue || typeof policyValue !== "object" || Array.isArray(policyValue)) {
    throw new Error(`--policy-file must contain a JSON policy object: ${policyPath}`);
  }
  const policy = policyValue as Record<string, unknown>;

  const prospective = {
    repo: options.repo,
    ref: options.ref,
    installs,
    policy,
  };
  const policyErrors = validateLockShape(prospective);
  if (policyErrors.length) {
    throw new Error(
      `Incomplete strict bootstrap policy (--policy-file ${String(options.policyFile)}):\n- ${policyErrors.join("\n- ")}`
    );
  }

  const sourceLockPath = path.resolve(options.project, String(options.sourceLock));
  assertPathWithinProject(options.project, sourceLockPath, "Source lock path");
  requireRegularFile(sourceLockPath, "--source-lock");

  const raw = fs.readFileSync(sourceLockPath);
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  const sourceLock = validateSourceLock(JSON.parse(raw.toString("utf8")));
  const entries = sourceLock.sources.filter((entry) => entry.name === options.sourceEntry);
  if (entries.length !== 1) {
    throw new Error(
      `--source-entry '${String(options.sourceEntry)}' has no unique entry in ${sourceLockPath}`
    );
  }
  const entry = entries[0]!;
  if (entry.source !== String(options.repo)) {
    // Equality above uses the raw values; only the rendered diagnostics are
    // redacted so credential-bearing remotes never reach error output.
    throw new Error(
      `Source lock entry '${entry.name}' does not match --repo. expected=${redactRemoteForDiagnostics(String(options.repo))} actual=${redactRemoteForDiagnostics(entry.source)}`
    );
  }
  if (entry.ref !== String(options.ref)) {
    throw new Error(
      `Source lock entry '${entry.name}' does not match --ref. expected=${String(options.ref)} actual=${entry.ref}`
    );
  }
  const policyCommit = policy.sourceCommit;
  if (
    typeof policyCommit !== "string" ||
    !policyCommit ||
    entry.resolvedCommit.toLowerCase() !== policyCommit.toLowerCase()
  ) {
    throw new Error(
      `Source lock entry '${entry.name}' resolvedCommit does not match policy sourceCommit. expected=${String(policyCommit)} actual=${entry.resolvedCommit}`
    );
  }

  const sourceRoot = path.resolve(String(options.source));
  if (!fileExists(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`--source must be an existing local directory: ${sourceRoot}`);
  }

  const projectionRoot = path.resolve(options.project, String(options.projectionDir));
  assertPathWithinProject(options.project, projectionRoot, "Projection directory");
  if (!fileExists(projectionRoot)) {
    throw new Error(`--projection-dir not found: ${projectionRoot}`);
  }

  const relativeSourceLock = path.relative(path.resolve(options.project), sourceLockPath)
    .split(path.sep)
    .join("/");

  return {
    policy,
    sourceLockBinding: {
      path: relativeSourceLock,
      sha256,
      entryName: String(options.sourceEntry),
    },
  };
}

function buildLockObject(options: BootstrapArgs): Record<string, unknown> {
  const installs = buildInstalls(options);
  const lock: Record<string, unknown> = {
    repo: options.repo,
    ref: options.ref,
    installs,
  };

  if (isRemoteRepo(String(options.repo))) {
    const evidence = assembleStrictOfflineEvidence(options, installs);
    lock.policy = evidence.policy;
    lock.sourceLock = evidence.sourceLockBinding;
  }

  return lock;
}

function parseArgs(argv: string[], options: DetectDefaultRepoOptions = {}): BootstrapArgs {
  const detectDefaultRepoFn = options.detectDefaultRepoFn || detectDefaultRepo;
  const args: BootstrapArgs = {
    repo: detectDefaultRepoFn(),
    project: process.cwd(),
    ref: "main",
    lockfile: ".skills.lock.json",
    apps: ["opencode"],
    profile: "core",
    skills: [],
    force: false,
    refreshCache: false,
    strictHash: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (token === "--force") {
      args.force = true;
      continue;
    }

    if (token === "--refresh-cache") {
      args.refreshCache = true;
      continue;
    }

    if (token === "--strict-hash") {
      args.strictHash = true;
      continue;
    }

    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (token === "--repo") {
      args.repo = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--project") {
      args.project = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--ref") {
      args.ref = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--lockfile") {
      args.lockfile = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--apps") {
      args.apps = parseCsv(requireOptionValue(argv, i, token), ["opencode"]);
      i += 1;
      continue;
    }
    if (token === "--profile") {
      args.profile = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--skills") {
      args.skills = parseCsv(requireOptionValue(argv, i, token), []);
      i += 1;
      continue;
    }
    if (token === "--source") {
      args.source = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--policy-file") {
      args.policyFile = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--source-lock") {
      args.sourceLock = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--source-entry") {
      args.sourceEntry = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--projection-dir") {
      args.projectionDir = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  args.project = path.resolve(args.project);
  if (args.repo === "opencode") {
    args.repo = detectDefaultRepoFn();
  }
  args.apps = parseCsv(args.apps, ["opencode"]);
  args.skills = parseCsv(args.skills, []);

  return args;
}

function writeLockfile(options: BootstrapArgs): string {
  const lockfilePath = path.resolve(options.project, options.lockfile);
  assertPathWithinProject(options.project, lockfilePath, "Lockfile path");

  // Evidence validation happens before the existence check so a remote
  // bootstrap fails closed on incomplete evidence without touching disk.
  const lock = buildLockObject(options);

  const exists = fileExists(lockfilePath);
  if (exists && !options.force) {
    throw new Error(`Lockfile already exists: ${lockfilePath}. Use --force to overwrite.`);
  }

  if (!options.dryRun) {
    writeJson(lockfilePath, lock);
  }

  console.log(`Lockfile ${exists ? "updated" : "created"}: ${lockfilePath}${options.dryRun ? " (dry-run)" : ""}`);
  if (lock.sourceLock !== undefined) {
    const binding = lock.sourceLock as SourceLockBinding;
    console.log(
      `Bound source-lock evidence: ${binding.path} (${binding.entryName}) sha256=${binding.sha256}${options.dryRun ? " (dry-run)" : ""}`
    );
  }
  return lockfilePath;
}

function runInstaller(options: BootstrapArgs, lockfilePath: string, deps: RunInstallerDeps = {}): number {
  const args = buildInstallerArgs(options, lockfilePath);
  const runCommandFn = deps.runCommand || runCommand;
  const exitFn = deps.exit || process.exit;

  const result = runCommandFn(args, {
    cwd: options.project,
    stdout: "inherit",
    stderr: "inherit",
    allowFailure: true,
  });

  if (result.code !== 0) {
    exitFn(result.code);
  }

  return result.code;
}

function buildInstallerArgs(options: BootstrapArgs, lockfilePath: string): string[] {
  const lockfileArg = path.relative(path.resolve(options.project), path.resolve(lockfilePath));
  const args = ["bun", INSTALLER, "--project", options.project, "--lockfile", lockfileArg];
  if (options.refreshCache) {
    args.push("--refresh-cache");
  }
  if (options.source) {
    args.push("--source", path.resolve(String(options.source)));
  }
  if (options.projectionDir) {
    args.push("--projection-dir", path.resolve(options.project, String(options.projectionDir)));
  }
  if (options.strictHash) {
    args.push("--strict-hash");
  }
  if (options.dryRun) {
    args.push("--dry-run");
  }
  return args;
}

function main(argv: string[] = process.argv, deps: DetectDefaultRepoOptions & RunInstallerDeps = {}): void {
  const parseOpts: DetectDefaultRepoOptions = {};
  if (deps.detectDefaultRepoFn !== undefined) parseOpts.detectDefaultRepoFn = deps.detectDefaultRepoFn;
  const options = parseArgs(argv, parseOpts);
  if (options.help) {
    help();
    return;
  }

  const lockfilePath = writeLockfile(options);
  runInstaller(options, lockfilePath, deps);
}

if (require.main === module) {
  main();
}

export {
  assembleStrictOfflineEvidence,
  buildInstallerArgs,
  buildLockObject,
  detectDefaultRepo,
  detectRemote,
  isRemoteRepo,
  main,
  parseArgs,
  runInstaller,
  writeLockfile,
};
