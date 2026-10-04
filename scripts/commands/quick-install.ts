#!/usr/bin/env bun
/**
 * One-command installer:
 * - fetch universal-skills repo
 * - validate contract
 * - sync declared global core skills
 * - optional project bootstrap
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCsv, requireOptionValue } from "../lib/args.ts";
import { runCommand } from "../lib/command.ts";
import { assertSafeGitRef } from "../lib/git-ref.ts";
import { redactRemoteForDiagnostics } from "../lib/redact.ts";
import {
  assertNoCredentialedHttpSource,
  assertNoUnsafeHomeRefs,
  assertSafeRemoteUrl,
} from "../lib/source-host.ts";
import { fetchCandidates } from "../modules/skillpool/cache.ts";
import { computeChecksum, resolveLayout } from "./source-checksum.ts";
import { listSkillDirs, validateSkill } from "./universal-contract.ts";

interface QuickInstallArgs {
  repo?: string;
  ref: string;
  target: string;
  syncGlobals: string[];
  globalSync: boolean;
  project?: string;
  policyFile?: string;
  sourceLock?: string;
  sourceEntry?: string;
  projectionDir?: string;
  apps: string[];
  profile: string;
  skills: string[];
  verifySignedTag: boolean;
  expectedSourceSha256: string | null;
  help: boolean;
  [key: string]: unknown;
}

interface RunOptions {
  cwd?: string;
  stdout?: "inherit" | "pipe";
  stderr?: "inherit" | "pipe";
  env?: NodeJS.ProcessEnv;
  /**
   * Per-command wall-clock budget override. Defaults to
   * QUICK_INSTALL_COMMAND_TIMEOUT_MS so every spawned child (git fetches,
   * checkouts, signed-tag verification, trusted sync/bootstrap runners) is
   * bounded by a finite, documented budget.
   */
  timeoutMs?: number;
}

const DEFAULT_TARGET = path.join(os.homedir(), ".local", "share", "universal-skills");

/**
 * Finite wall-clock budget applied to every child command quick-install spawns.
 * Generous enough for cold network fetches and bootstrap installs, but bounded
 * so a hung child can never wedge an install forever.
 */
const QUICK_INSTALL_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Trusted command scripts from the currently executing distribution. Fetched
 * bytes under args.target are data only: quick-install never resolves or
 * executes any script from the fetched tree.
 */
const TRUSTED_SYNC_GLOBAL_CORE_SCRIPT = path.join(__dirname, "sync-global-core.ts");
const TRUSTED_BOOTSTRAP_SKILLS_SCRIPT = path.join(__dirname, "bootstrap-skills.ts");

/**
 * URL patterns used to reject unsafe source arguments before Git receives them.
 */
const SCHEME_REMOTE_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const GIT_REMOTE_HELPER_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*::/;
const SCP_LIKE_REMOTE_PATTERN = /^(?:[A-Za-z0-9_.-]+@)?(?:\[[^\]]+\]|[^/:?#]+):.+/;

function isRemoteRepoArg(repo: string): boolean {
  return SCHEME_REMOTE_PATTERN.test(repo) || SCP_LIKE_REMOTE_PATTERN.test(repo);
}

function shouldPullAfterCheckout(ref: string): boolean {
  const normalized = String(ref || "").trim();
  if (!normalized) {
    return false;
  }

  if (/^[0-9a-f]{7,40}$/i.test(normalized)) {
    return false;
  }

  if (normalized.startsWith("refs/tags/")) {
    return false;
  }

  if (/^v?\d+\.\d+\.\d+(?:[-+._][0-9A-Za-z.-]+)?$/.test(normalized)) {
    return false;
  }

  return true;
}

function fetchExactRefIntoTarget(
  args: QuickInstallArgs,
  runFn: typeof run,
  mkdirSyncFn: typeof fs.mkdirSync,
  initialCheckout: boolean
): void {
  if (initialCheckout) {
    if (!args.repo) {
      throw new Error("Missing --repo for initial fetch");
    }
    mkdirSyncFn(path.dirname(args.target), { recursive: true });
    mkdirSyncFn(args.target, { recursive: true });
    runFn(["git", "-C", args.target, "init"]);
    runFn(["git", "-C", args.target, "remote", "add", "origin", String(args.repo)]);
  }

  const failures: string[] = [];
  for (const candidate of fetchCandidates(args.ref)) {
    try {
      runFn(["git", "-C", args.target, "fetch", "--depth", "1", "origin", candidate.refspec]);
      runFn(["git", "-C", args.target, "checkout", "--detach", candidate.checkout]);
      return;
    } catch (error) {
      failures.push(`${candidate.refspec}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Failed to fetch Git ref '${args.ref}'. Tried:\n- ${failures.join("\n- ")}`);
}

function help(): void {
  console.log(`
Quick install universal-skills

Usage:
  bun scripts/commands/quick-install.ts [options]

Options:
  --repo <git-url-or-path>         Source repository (required unless --target already cloned)
  --ref <tag|branch|sha>           Ref to checkout (default: main)
  --target <dir>                   Local source checkout location (default: ~/.local/share/universal-skills)
  --sync-globals <csv>             Global core targets: opencode,codex,qwen,gemini-cli (default: manifest defaultApps)
  --no-global-sync                 Skip global sync
  --project <dir>                  Optional project to bootstrap with lockfile
  --policy-file <json>             Complete strict policy (required with --project)
  --source-lock <file>             Source-lock evidence relative to project (required with --project)
  --source-entry <name>            Selected source-lock entry (required with --project)
  --projection-dir <dir>           Prebuilt projections inside project (required with --project)
  --apps <csv>                     Project app labels for bootstrap (default: opencode; project installs target .agents/skills)
  --profile <name>                 Profile for bootstrap (default: core)
  --skills <csv>                   Extra direct skills for bootstrap
  --verify-signed-tag              Verify selected ref is a signed tag before sync/install
  --expected-source-sha256 <hex>   Verify source checksum before sync/install.
                                   Required for every mutation (--global-sync or --project);
                                   floating refs without checksum evidence fail closed.
  --help                           Show help

Notes:
  Sync and bootstrap run trusted scripts from this distribution only; fetched
  bytes are treated as inert data. Every child command is bounded by a finite
  timeout (QUICK_INSTALL_COMMAND_TIMEOUT_MS, 5 minutes).
`);
}

function parseArgs(argv: string[]): QuickInstallArgs {
  const args: QuickInstallArgs = {
    ref: "main",
    target: DEFAULT_TARGET,
    syncGlobals: ["opencode", "codex", "qwen", "gemini-cli"],
    globalSync: true,
    apps: ["opencode"],
    profile: "core",
    skills: [],
    verifySignedTag: false,
    expectedSourceSha256: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--no-global-sync") {
      args.globalSync = false;
      continue;
    }
    if (token === "--verify-signed-tag") {
      args.verifySignedTag = true;
      continue;
    }
    if (token === "--repo") {
      args.repo = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--ref") {
      args.ref = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--target") {
      args.target = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--sync-globals") {
      args.syncGlobals = parseCsv(requireOptionValue(argv, i, token), args.syncGlobals);
      i += 1;
      continue;
    }
    if (token === "--project") {
      args.project = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--policy-file" || token === "--source-lock" || token === "--source-entry" || token === "--projection-dir") {
      const field = { "--policy-file": "policyFile", "--source-lock": "sourceLock", "--source-entry": "sourceEntry", "--projection-dir": "projectionDir" }[token];
      args[field] = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--apps") {
      args.apps = parseCsv(requireOptionValue(argv, i, token), args.apps);
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
    if (token === "--expected-source-sha256") {
      args.expectedSourceSha256 = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.target = path.resolve(args.target);
  if (args.project) {
    args.project = path.resolve(String(args.project));
  }
  if (args.repo !== undefined) {
    args.repo = assertSafeRepoArg(String(args.repo));
  }
  // Fail closed before the ref reaches URLs, paths, or git commands.
  args.ref = assertSafeGitRef(args.ref);
  if (args.expectedSourceSha256 !== null && !/^[0-9a-fA-F]{64}$/.test(args.expectedSourceSha256)) {
    throw new Error(
      `Unsafe --expected-source-sha256 '${args.expectedSourceSha256}': expected a 64-character hex SHA-256 digest`
    );
  }
  args.syncGlobals = parseCsv(args.syncGlobals, args.syncGlobals);
  args.apps = parseCsv(args.apps, args.apps);
  args.skills = parseCsv(args.skills, []);

  return args;
}

function run(args: string[], opts: RunOptions = {}) {
  return runCommand(args, {
    cwd: opts.cwd || process.cwd(),
    stdout: opts.stdout || "inherit",
    stderr: opts.stderr || "inherit",
    env: opts.env || process.env,
    timeoutMs: opts.timeoutMs ?? QUICK_INSTALL_COMMAND_TIMEOUT_MS,
  });
}

function assertSafeRepoArg(repo: string): string {
  const trimmed = String(repo || "").trim();
  const rendered = redactRemoteForDiagnostics(trimmed);
  if (!trimmed || trimmed.startsWith("-")) {
    throw new Error(`Unsafe git repo URL or path '${rendered}'`);
  }

  assertNoUnsafeHomeRefs(trimmed);

  // Git's <transport>::<address> syntax invokes a remote-helper executable.
  // quick-install accepts repository data locators, never executable transport
  // helpers, so reject the form before it can reach `git remote add`.
  if (GIT_REMOTE_HELPER_PATTERN.test(trimmed)) {
    throw new Error(`Unsafe git repo remote-helper source '${rendered}'`);
  }

  if (!isRemoteRepoArg(trimmed)) {
    return trimmed;
  }

  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    if (scheme !== "https" && scheme !== "ssh") {
      throw new Error(
        `Unsupported source URL scheme '${scheme}:'. Git repositories must use HTTPS or SSH.`
      );
    }
  }

  assertNoCredentialedHttpSource(trimmed);
  assertSafeRemoteUrl(trimmed);
  return trimmed;
}

interface QuickInstallDeps {
  bootstrapProject?: typeof bootstrapProject;
  ensureRepo?: typeof ensureRepo;
  existsSync?: typeof fs.existsSync;
  help?: typeof help;
  mkdirSync?: typeof fs.mkdirSync;
  run?: typeof run;
  syncGlobals?: typeof syncGlobals;
  verifySource?: typeof verifySource;
}

function ensureRepo(args: QuickInstallArgs, deps: Pick<QuickInstallDeps, "existsSync" | "mkdirSync" | "run"> = {}): void {
  const existsSyncFn = deps.existsSync ?? fs.existsSync;
  const mkdirSyncFn = deps.mkdirSync ?? fs.mkdirSync;
  const runFn = deps.run ?? run;
  const targetGit = path.join(args.target, ".git");

  if (!existsSyncFn(targetGit)) {
    const targetExistsBeforeFetch = existsSyncFn(args.target);
    if (targetExistsBeforeFetch) {
      throw new Error(`Target exists but is not a git checkout: ${args.target}`);
    }
    try {
      fetchExactRefIntoTarget(args, runFn, mkdirSyncFn, true);
    } catch (error) {
      if (!targetExistsBeforeFetch && existsSyncFn(args.target)) {
        fs.rmSync(args.target, { recursive: true, force: true });
      }
      throw error;
    }
  } else {
    fetchExactRefIntoTarget(args, runFn, mkdirSyncFn, false);
  }
}

const MAX_CONTRACT_FINDINGS_REPORTED = 20;

/**
 * Validate the fetched skills root using repository-local trusted helpers.
 * Fetched bytes under the target are read strictly as inert data: they are
 * never executed, imported, or permission-checked by quick-install.
 */
function collectContractFindings(skillsRoot: string): string[] {
  const findings: string[] = [];
  const skills = listSkillDirs(skillsRoot, false);
  if (!skills.length) {
    return [`[ERROR SKILLS_ROOT_EMPTY] ${skillsRoot}`];
  }
  for (const skill of skills) {
    for (const issue of validateSkill(skill, path.join(skillsRoot, skill))) {
      findings.push(`[ERROR ${skill}] ${issue}`);
    }
  }
  return findings;
}

function verifySource(args: QuickInstallArgs, deps: Pick<QuickInstallDeps, "run"> = {}): void {
  const runFn = deps.run ?? run;

  // Trust boundary: verification never spawns anything from args.target. The
  // contract check and checksum are computed locally over fetched data; a
  // mismatch or unresolved checksum fails closed before sync/bootstrap run.
  const skillsRoot = path.join(args.target, "skills");
  const findings = collectContractFindings(skillsRoot);
  if (findings.length) {
    const reported = findings.slice(0, MAX_CONTRACT_FINDINGS_REPORTED).join("\n- ");
    const suffix = findings.length > MAX_CONTRACT_FINDINGS_REPORTED
      ? `\n- ... (${findings.length - MAX_CONTRACT_FINDINGS_REPORTED} more)`
      : "";
    throw new Error(
      `Universal contract verification failed for ${skillsRoot}:\n- ${reported}${suffix}`
    );
  }

  if (args.verifySignedTag) {
    runFn(["git", "-C", args.target, "tag", "-v", args.ref]);
    console.log(`Verified signed tag: ${args.ref}`);
  }

  if (args.expectedSourceSha256) {
    let actual: string;
    try {
      actual = computeChecksum(resolveLayout(args.target)).toLowerCase();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to compute source checksum locally for '${args.target}': ${message}`
      );
    }
    const expected = String(args.expectedSourceSha256).toLowerCase();
    if (actual !== expected) {
      throw new Error(`Checksum mismatch. expected=${expected} actual=${actual}`);
    }
    console.log(`Verified source checksum: ${actual}`);
  }
}

function syncGlobals(args: QuickInstallArgs, deps: Pick<QuickInstallDeps, "run"> = {}): void {
  if (!args.globalSync) {
    return;
  }

  (deps.run ?? run)(buildSyncGlobalsCommand(args));
}

function buildSyncGlobalsCommand(args: QuickInstallArgs): string[] {
  // Trusted script from the currently executing distribution; the fetched tree
  // enters only as inert --source data and is never executed.
  return [
    "bun",
    TRUSTED_SYNC_GLOBAL_CORE_SCRIPT,
    "--source",
    args.target,
    "--apps",
    args.syncGlobals.join(","),
    "--no-contract-check",
  ];
}

function buildBootstrapCommand(args: QuickInstallArgs): string[] {
  // Trusted script from the currently executing distribution; repo/ref data
  // about the fetched source is passed through as inert arguments only.
  const cmd = [
    "bun",
    TRUSTED_BOOTSTRAP_SKILLS_SCRIPT,
    "--project",
    String(args.project),
    "--repo",
    args.repo || args.target,
    "--ref",
    args.ref,
    "--apps",
    args.apps.join(","),
    "--profile",
    args.profile,
    "--source",
    args.target,
  ];
  for (const [flag, value] of [
    ["--policy-file", args.policyFile], ["--source-lock", args.sourceLock],
    ["--source-entry", args.sourceEntry], ["--projection-dir", args.projectionDir],
  ] as const) {
    if (value) cmd.push(flag, value);
  }
  if (args.skills.length) {
    cmd.push("--skills", args.skills.join(","));
  }
  return cmd;
}

function requireProjectEvidence(args: QuickInstallArgs): void {
  if (!args.project) return;
  if (!args.policyFile || !args.sourceLock || !args.sourceEntry || !args.projectionDir) {
    throw new Error(
      "Project bootstrap requires strict offline evidence for every repository:\n" +
        "- --policy-file <json> (complete strict install policy)\n" +
        "- --source-lock <file> (v1 skill-sys.sources.lock.json evidence)\n" +
        "- --source-entry <name> (selected source-lock entry)\n" +
        "- --projection-dir <dir> (prebuilt provider projection artifacts)\n" +
        "Supply these flags to quick-install/setup, or use skill-sys init with a verified local source."
    );
  }
}

function bootstrapProject(args: QuickInstallArgs, deps: Pick<QuickInstallDeps, "run"> = {}): void {
  if (!args.project) return;
  requireProjectEvidence(args);
  (deps.run ?? run)(buildBootstrapCommand(args));
}

function main(argv: string[] = process.argv, deps: QuickInstallDeps = {}): void {
  const args = parseArgs(argv);
  const helpFn = deps.help ?? help;
  const ensureRepoFn = deps.ensureRepo ?? ensureRepo;
  const verifySourceFn = deps.verifySource ?? verifySource;
  const syncGlobalsFn = deps.syncGlobals ?? syncGlobals;
  const bootstrapProjectFn = deps.bootstrapProject ?? bootstrapProject;
  if (args.help) {
    helpFn();
    return;
  }

  // Fail closed before any mutation: global sync and project bootstrap may only
  // run against a fetched tree bound by an explicit expected checksum. A
  // floating ref without checksum evidence is untrusted by definition.
  if ((args.globalSync || Boolean(args.project)) && !args.expectedSourceSha256) {
    throw new Error(
      "Refusing to mutate without immutable source evidence. " +
        "Global sync and project bootstrap require --expected-source-sha256 <hex> " +
        "(the SHA-256 of the fetched source tree); a floating ref without a " +
        "checksum cannot be verified against what will be installed."
    );
  }

  requireProjectEvidence(args);
  ensureRepoFn(args);
  verifySourceFn(args);
  const runDeps = deps.run ? { run: deps.run } : {};
  if (args.project) {
    // Validate supplied policy, binding and paths before any global skill sync.
    // The trusted bootstrap preview performs no install and writes no lock.
    (deps.run ?? run)([...buildBootstrapCommand(args), "--dry-run"]);
  }
  syncGlobalsFn(args, runDeps);
  bootstrapProjectFn(args, runDeps);

  console.log("Done: quick-install completed.");
  console.log(`- repo dir: ${args.target}`);
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
  DEFAULT_TARGET,
  QUICK_INSTALL_COMMAND_TIMEOUT_MS,
  bootstrapProject,
  buildBootstrapCommand,
  buildSyncGlobalsCommand,
  collectContractFindings,
  ensureRepo,
  main,
  parseArgs,
  run,
  shouldPullAfterCheckout,
  syncGlobals,
  verifySource,
};
