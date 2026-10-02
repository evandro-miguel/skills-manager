#!/usr/bin/env bun
/**
 * Publish one improved skill from a project back to the central skills Git repo.
 *
 * Default behavior is safe: fetch + copy + show diff.
 * Use --commit to create commit, and --push to push.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { runCommand } from "../lib/command.ts";
import { copyDirectory } from "../lib/files.ts";
import { childFailureMessage, redactRemoteForDiagnostics } from "../lib/redact.ts";
import {
  detectDefaultRepo as detectDefaultRepoFromLib,
  detectRemote as detectRemoteFromLib,
} from "../lib/git.ts";
import { assertPathWithinProject } from "../modules/skillpool/entry.ts";
import {
  assertNoSensitiveFindings,
  scanSensitiveFiles,
} from "../modules/skillpool/sensitive-scan.ts";
import { fetchCandidates } from "../modules/skillpool/cache.ts";

interface AdapterConfig {
  targetPath: string;
}

interface PublishArgs {
  repo: string;
  project: string;
  branch: string;
  commit: boolean;
  push: boolean;
  dryRun: boolean;
  app?: string;
  skill?: string;
  workdir?: string;
  message?: string;
  help?: boolean;
  [key: string]: unknown;
}

interface ParseArgsOptions {
  detectDefaultRepo?: () => string;
  cwd?: string;
}

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type RunOptions = {
  cwd?: string;
  allowFailure?: boolean;
};

type RunDeps = {
  runCommand?: typeof runCommand;
};

interface DetectDefaultRepoDeps extends RunDeps {
  fs?: typeof fs;
  detectRemote?: (repoPath: string) => string | null;
}

interface ResolveWorkdirDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

type PublishSkillOptions = PublishArgs & {
  app: string;
  skill: string;
};

type PublishResult = {
  workdir: string;
  changed: boolean;
  dryRun: boolean;
};

type RunFn = (
  command: string,
  commandArgs: string[],
  options?: RunOptions,
  deps?: RunDeps
) => CommandResult;

interface PublishDeps extends ResolveWorkdirDeps {
  fs?: typeof fs;
  loadAdapter?: (app: string) => AdapterConfig;
  ensureSkillPath?: (skillPath: string, label: string) => void;
  run?: RunFn;
  resolveWorkdir?: (options: PublishSkillOptions, deps?: ResolveWorkdirDeps) => string;
  copySkillDirectory?: (srcDir: string, destDir: string) => void;
  scanSensitiveSkill?: (skillPath: string) => void;
  log?: (line: string) => void;
  detectDefaultRepo?: () => string;
  cwd?: string;
}

const TOOL_ROOT = path.resolve(__dirname, "../..");
const UNIVERSAL_ROOT = path.resolve(__dirname, "../..");
const OPENCODE_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DEFAULT_PUBLISH_SUBDIR = path.join(".skillpool", "publish");

function assertSafeName(name: string, label: string): string {
  const trimmed = String(name).trim();
  if (!trimmed) {
    throw new Error(`Invalid ${label}: expected a non-empty string`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    throw new Error(`Invalid ${label} '${trimmed}': path separators are not allowed`);
  }
  return trimmed;
}

function normalizeSafeRelativePath(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }

  const normalized = path.posix.normalize(raw.trim().replaceAll("\\", "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`${label} must stay within the project directory: '${raw}'`);
  }

  return normalized;
}

function resolvePublishBase(env: NodeJS.ProcessEnv): string {
  if (env.SKILLPOOL_HOME) {
    return path.resolve(env.SKILLPOOL_HOME, "publish");
  }
  return path.join(os.homedir(), DEFAULT_PUBLISH_SUBDIR);
}

function isPathWithin(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || relative === "." || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertWorkdirWithinPublishBase(
  workdir: string,
  publishBase: string,
  projectDir: string
): void {
  const workdirAbs = path.resolve(workdir);
  const baseAbs = path.resolve(publishBase);
  const relative = path.relative(baseAbs, workdirAbs);
  const forbiddenExact = new Set([
    path.parse(workdirAbs).root,
    path.resolve(os.homedir()),
    path.resolve(process.cwd()),
    path.resolve(projectDir),
    path.resolve(TOOL_ROOT),
    baseAbs,
  ]);

  if (forbiddenExact.has(workdirAbs)) {
    throw new Error(`Unsafe --workdir target: ${workdirAbs}`);
  }
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`--workdir must be inside publish base '${baseAbs}': ${workdirAbs}`);
  }

  assertNoSymlinkedPathComponents(baseAbs, "publish base");
  assertNoSymlinkedPathComponents(path.dirname(workdirAbs), "publish workdir parent");

  const baseReal = fs.existsSync(baseAbs)
    ? fs.realpathSync.native(baseAbs)
    : fs.realpathSync.native(nearestExistingPath(path.dirname(baseAbs)));
  const workdirParentReal = fs.realpathSync.native(nearestExistingPath(path.dirname(workdirAbs)));
  if (!isPathWithin(baseReal, workdirParentReal)) {
    throw new Error(`--workdir real path must stay inside publish base '${baseAbs}': ${workdirAbs}`);
  }
}

function nearestExistingPath(candidatePath: string): string {
  let currentPath = path.resolve(candidatePath);
  while (!fs.existsSync(currentPath)) {
    const parent = path.dirname(currentPath);
    if (parent === currentPath) {
      break;
    }
    currentPath = parent;
  }
  return currentPath;
}

function assertNoSymlinkedPathComponents(candidatePath: string, label: string): void {
  const absPath = path.resolve(candidatePath);
  const root = path.parse(absPath).root;
  let currentPath = root;

  for (const segment of path.relative(root, absPath).split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    if (fs.existsSync(currentPath) && fs.lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked ${label}: ${currentPath}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function help(): void {
  console.log(`
Publish improved skill back to skills repository

Usage:
  bun scripts/commands/publish-skill.ts [options]

Required:
  --app <app-name>              opencode | codex | claude-code | antigravity
  --skill <skill-name>          Skill folder name

Optional:
  --repo <git-url-or-path>      Skills repository (default: OpenCode origin; fallback local path)
  --project <dir>               Project directory (default: current directory)
  --branch <branch>             Target branch (default: main)
  --workdir <dir>               Working checkout directory (default: ~/.skillpool/publish/<timestamp>-<skill>)
  --message <text>              Commit message
  --commit                       Create commit after copy
  --push                         Push commit to origin/<branch> (implies --commit)
  --dry-run                      Print actions only
  --help                         Show help

Examples:
  bun scripts/commands/publish-skill.ts --app opencode --skill writing-skills
  bun scripts/commands/publish-skill.ts --repo git@github.com:you/skills-pool.git --app opencode --skill writing-skills --commit --push
`);
}

function detectRemote(repoPath: string, deps: RunDeps = {}): string | null {
  return detectRemoteFromLib(repoPath, {
    runner: deps.runCommand || runCommand,
  });
}

function detectDefaultRepo(deps: DetectDefaultRepoDeps = {}): string {
  const fsApi = deps.fs || fs;
  return detectDefaultRepoFromLib({
    universalRoot: UNIVERSAL_ROOT,
    opencodeRoot: OPENCODE_ROOT,
    detectRemote: deps.detectRemote || ((repoPath) => detectRemote(repoPath, deps)),
    exists: fsApi.existsSync.bind(fsApi),
  });
}

function parseArgs(argv: string[], options: ParseArgsOptions = {}): PublishArgs {
  const detectDefaultRepoFn = options.detectDefaultRepo || (() => detectDefaultRepo());
  const cwd = options.cwd || process.cwd();
  const args: PublishArgs = {
    repo: detectDefaultRepoFn(),
    project: cwd,
    branch: "main",
    commit: false,
    push: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--commit") {
      args.commit = true;
      continue;
    }
    if (token === "--push") {
      args.push = true;
      args.commit = true;
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
    if (token === "--branch") {
      args.branch = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--app") {
      args.app = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--skill") {
      args.skill = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--workdir") {
      args.workdir = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--message") {
      args.message = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.help) {
    if (!args.app) {
      throw new Error("Missing required --app");
    }
    if (!args.skill) {
      throw new Error("Missing required --skill");
    }
    args.app = assertSafeName(args.app, "app");
    args.skill = assertSafeName(args.skill, "skill");
  }

  if (args.repo === "opencode") {
    args.repo = detectDefaultRepoFn();
  }
  args.project = path.resolve(args.project);
  return args;
}

function run(command: string, commandArgs: string[], opts: RunOptions = {}, deps: RunDeps = {}): CommandResult {
  const runOpts: { cwd?: string; stdout: "pipe"; stderr: "pipe"; allowFailure: true } = {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
  };
  if (opts.cwd !== undefined) runOpts.cwd = opts.cwd;
  const result = (deps.runCommand || runCommand)([command, ...commandArgs], runOpts);

  if (result.code !== 0 && !opts.allowFailure) {
    // Captured child output can carry secrets, so failures surface only the
    // redacted argv header and exit code (same shape as runCommand's own
    // thrown header).
    throw new Error(childFailureMessage([command, ...commandArgs], result.code));
  }

  return result;
}

function loadAdapter(app: string): AdapterConfig {
  const safeApp = assertSafeName(app, "app");
  const adapterPath = path.join(TOOL_ROOT, "adapters", `${safeApp}.json`);
  if (!fs.existsSync(adapterPath)) {
    throw new Error(`Adapter not found: ${adapterPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as unknown;
  if (!isRecord(parsed) || typeof parsed.targetPath !== "string") {
    throw new Error(`Adapter '${safeApp}' is missing a valid targetPath`);
  }
  return { targetPath: parsed.targetPath };
}

function ensureSkillPath(skillPath: string, label: string): void {
  if (!fs.existsSync(skillPath)) {
    throw new Error(`${label} path not found: ${skillPath}`);
  }
  const entry = path.join(skillPath, "SKILL.md");
  if (!fs.existsSync(entry)) {
    throw new Error(`${label} skill missing SKILL.md: ${entry}`);
  }
}

function copySkillDirectory(srcDir: string, destDir: string): void {
  copyDirectory(srcDir, destDir, {
    skipNames: new Set([".git"]),
  });
}

function scanSensitiveSkill(skillPath: string): void {
  assertNoSensitiveFindings(
    scanSensitiveFiles({
      rootDir: skillPath,
      baseDir: path.dirname(skillPath),
    }),
    "Source skill"
  );
}

function fetchPublishWorkdir(repo: string, ref: string, workdir: string, runFn: RunFn): void {
  runFn("git", ["-C", workdir, "init"], {});
  runFn("git", ["-C", workdir, "remote", "add", "origin", repo], {});

  const failures: string[] = [];
  for (const candidate of fetchCandidates(ref)) {
    try {
      runFn("git", ["-C", workdir, "fetch", "--depth", "1", "origin", candidate.refspec], {});
      runFn("git", ["-C", workdir, "checkout", "--detach", candidate.checkout], {});
      return;
    } catch (error) {
      failures.push(`${candidate.refspec}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `Failed to fetch Git ref '${ref}' from '${redactRemoteForDiagnostics(repo)}'. Tried:\n- ${failures.join("\n- ")}`
  );
}

function resolveWorkdir(options: PublishSkillOptions, deps: ResolveWorkdirDeps = {}): string {
  const env = deps.env || process.env;
  const now = deps.now || (() => new Date());
  const publishBase = resolvePublishBase(env);

  if (options.workdir) {
    const workdir = path.resolve(options.workdir);
    assertWorkdirWithinPublishBase(workdir, publishBase, options.project);
    return workdir;
  }

  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const workdir = path.join(publishBase, `${stamp}-${options.skill}`);
  assertWorkdirWithinPublishBase(workdir, publishBase, options.project);
  return workdir;
}

function publishSkill(options: PublishSkillOptions, deps: PublishDeps = {}): PublishResult {
  const fsApi = deps.fs || fs;
  const loadAdapterFn = deps.loadAdapter || loadAdapter;
  const ensureSkillPathFn = deps.ensureSkillPath || ensureSkillPath;
  const runFn = deps.run || run;
  const resolveWorkdirFn = deps.resolveWorkdir || resolveWorkdir;
  const copySkillDirectoryFn = deps.copySkillDirectory || copySkillDirectory;
  const scanSensitiveSkillFn = deps.scanSensitiveSkill || scanSensitiveSkill;
  const log = deps.log || console.log;

  const adapter = loadAdapterFn(options.app);
  const safeTargetPath = normalizeSafeRelativePath(
    adapter.targetPath,
    `Adapter '${options.app}' targetPath`
  );
  const sourceSkillPath = path.join(options.project, safeTargetPath, options.skill);
  assertPathWithinProject(options.project, sourceSkillPath, `Adapter '${options.app}' targetPath`);
  ensureSkillPathFn(sourceSkillPath, "Source");
  if (!options.dryRun) {
    scanSensitiveSkillFn(sourceSkillPath);
  }

  const workdir = resolveWorkdirFn(options, deps);
  const repoSkillPath = path.join(workdir, "skills", options.skill);

  log(`-> Source: ${sourceSkillPath}`);
  log(`-> Checkout: ${workdir}`);
  log(`-> Target: ${repoSkillPath}`);

  if (!options.dryRun) {
    fsApi.rmSync(workdir, { recursive: true, force: true });
    fsApi.mkdirSync(workdir, { recursive: true });
    fetchPublishWorkdir(options.repo, options.branch, workdir, runFn);

    fsApi.rmSync(repoSkillPath, { recursive: true, force: true });
    copySkillDirectoryFn(sourceSkillPath, repoSkillPath);
  }

  const relSkillPath = `skills/${options.skill}`;

  if (!options.dryRun) {
    const status = runFn("git", ["-C", workdir, "status", "--porcelain", "--", relSkillPath], {});

    if (!status.stdout) {
      log("No changes detected for this skill. Nothing to publish.");
      return { workdir, changed: false, dryRun: false };
    }

    log("\nChanged files:");
    for (const line of status.stdout.split("\n")) {
      if (line.trim()) {
        log(`- ${line}`);
      }
    }

    if (options.commit) {
      runFn("git", ["-C", workdir, "add", "--", relSkillPath], {});
      const message =
        options.message || `chore(skills): update ${options.skill} from ${options.app} project`;
      runFn("git", ["-C", workdir, "commit", "-m", message], {});
      log(`\nCommit created: ${message}`);

      if (options.push) {
        runFn("git", ["-C", workdir, "push", "origin", `HEAD:${options.branch}`], {});
        log(`Pushed to origin/${options.branch}`);
      } else {
        log("Push skipped. Use --push to publish remote.");
      }
    } else {
      log("Commit skipped. Use --commit (and optional --push).");
    }

    log(`Working checkout kept at: ${workdir}`);
    return { workdir, changed: true, dryRun: false };
  }

  log("Dry-run: fetch/copy/commit/push were skipped.");
  return { workdir, changed: false, dryRun: true };
}

function main(argv: string[] = process.argv, deps: PublishDeps = {}): PublishResult | void {
  const parseOpts: ParseArgsOptions = {};
  if (deps.detectDefaultRepo !== undefined) parseOpts.detectDefaultRepo = deps.detectDefaultRepo;
  if (deps.cwd !== undefined) parseOpts.cwd = deps.cwd;
  const options = parseArgs(argv, parseOpts);
  if (options.help) {
    help();
    return;
  }
  return publishSkill(options as PublishSkillOptions, deps);
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
  detectDefaultRepo,
  detectRemote,
  ensureSkillPath,
  fetchPublishWorkdir,
  help,
  loadAdapter,
  main,
  parseArgs,
  publishSkill,
  resolveWorkdir,
  run,
  scanSensitiveSkill,
};
