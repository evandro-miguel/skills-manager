#!/usr/bin/env bun
/**
 * Unified diagnostics:
 * - universal contract
 * - source validate
 * - adapter smoke install
 * - optional hash drift check for local OpenCode/Codex skills
 * - optional lockfile doctor for a project
 */

import path from "node:path";
import { runCommand } from "../lib/command.ts";
import { dirDigest, fileExists } from "../lib/files.ts";
import { listSkillDirs } from "../lib/skill-dirs.ts";
import { readGlobalCoreManifest, resolveGlobalCoreApp } from "../modules/global-core.ts";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CONTRACT = path.join(__dirname, "universal-contract.ts");
const SKILLPOOL = path.join(__dirname, "skillpool.ts");
const SMOKE = path.join(__dirname, "smoke-adapters.ts");

interface DoctorAllArgs {
  source: string;
  project: string | null;
  opencodeSkills: string | null;
  codexSkills: string | null;
  claudeSkills: string | null;
  qwenSkills: string | null;
  geminiSkills: string | null;
  repair: boolean;
  json: boolean;
  help: boolean;
}

interface CompareTargetsResult {
  findings: string[];
  errors: string[];
  warns: string[];
}

function help(): void {
  console.log(`
Doctor all checks

Usage:
  bun scripts/commands/doctor-all.ts [options]

Options:
  --source <dir>            source root (default: .)
  --project <dir>           project directory to run lockfile doctor --strict-hash
  --opencode-skills <dir>   compare source global core against installed OpenCode globals
  --codex-skills <dir>      compare source global core against installed Codex globals
  --claude-skills <dir>     compare source global core against installed Claude Code globals
  --qwen-skills <dir>       compare source global core against installed Qwen globals
  --gemini-skills <dir>     compare source global core against installed Gemini CLI globals
  --repair                  pull source and auto-sync drifted targets before rechecking
  --json                    emit machine-readable diagnostics
  --help                    show help
`);
}

function parseArgs(argv: string[]): DoctorAllArgs {
  const args: DoctorAllArgs = {
    source: REPO_ROOT,
    project: null,
    opencodeSkills: null,
    codexSkills: null,
    claudeSkills: null,
    qwenSkills: null,
    geminiSkills: null,
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
    if (token === "--repair") {
      args.repair = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      if (key === "opencode-skills") {
        args.opencodeSkills = value;
      } else if (key === "codex-skills") {
        args.codexSkills = value;
      } else if (key === "claude-skills") {
        args.claudeSkills = value;
      } else if (key === "qwen-skills") {
        args.qwenSkills = value;
      } else if (key === "gemini-skills") {
        args.geminiSkills = value;
      } else if (key === "project") {
        args.project = value;
      } else if (key === "source") {
        args.source = value;
      } else {
        throw new Error(`Unknown option: ${token}`);
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), args.source);
  if (args.project) {
    args.project = path.resolve(process.cwd(), args.project);
  }
  if (args.opencodeSkills) {
    args.opencodeSkills = path.resolve(process.cwd(), args.opencodeSkills);
  }
  if (args.codexSkills) {
    args.codexSkills = path.resolve(process.cwd(), args.codexSkills);
  }
  if (args.claudeSkills) {
    args.claudeSkills = path.resolve(process.cwd(), args.claudeSkills);
  }
  if (args.qwenSkills) {
    args.qwenSkills = path.resolve(process.cwd(), args.qwenSkills);
  }
  if (args.geminiSkills) {
    args.geminiSkills = path.resolve(process.cwd(), args.geminiSkills);
  }

  return args;
}

function run(args: string[], options: Parameters<typeof runCommand>[1] = {}): void {
  runCommand(args, options);
}

function isGitRepo(dirPath: string): boolean {
  return fileExists(path.join(dirPath, ".git"));
}

function compareTargets(
  sourceSkillsDir: string,
  targetSkillsDir: string,
  label: string,
  sourceSkills: string[]
): CompareTargetsResult {
  if (!fileExists(targetSkillsDir)) {
    return {
      findings: [`[ERROR ${label}] target not found: ${targetSkillsDir}`],
      errors: [`[ERROR ${label}] target not found: ${targetSkillsDir}`],
      warns: [],
    };
  }

  const targetSkills = new Set(listSkillDirs(targetSkillsDir));
  const findings: string[] = [];

  for (const skill of sourceSkills) {
    const src = path.join(sourceSkillsDir, skill);
    const dst = path.join(targetSkillsDir, skill);
    if (!targetSkills.has(skill)) {
      findings.push(`[ERROR ${label}] missing skill: ${skill}`);
      continue;
    }
    const srcHash = dirDigest(src);
    const dstHash = dirDigest(dst);
    if (srcHash !== dstHash) {
      findings.push(`[ERROR ${label}] drift detected: ${skill}`);
    }
  }

  for (const skill of targetSkills) {
    if (!sourceSkills.includes(skill)) {
      findings.push(`[WARN ${label}] extra skill in target: ${skill}`);
    }
  }

  const errors = findings.filter((line) => line.includes("[ERROR"));
  const warns = findings.filter((line) => line.includes("[WARN"));
  return { findings, errors, warns };
}

function printFindings(label: string, findings: string[]): void {
  if (!findings.length) {
    return;
  }
  console.log(`\n${label} findings:`);
  for (const line of findings) {
    console.log(`- ${line}`);
  }
}

function resolveSyncScript(sourceRoot: string): string {
  return path.join(sourceRoot, "scripts", "commands", "sync-skills.ts");
}

function syncTarget(sourceSkillsDir: string, targetSkillsDir: string, sourceRoot: string, sourceSkills: string[]): void {
  const syncScript = resolveSyncScript(sourceRoot);
  run([
    "bun",
    syncScript,
    "--from",
    sourceSkillsDir,
    "--to",
    targetSkillsDir,
    "--skills",
    sourceSkills.join(","),
    "--delete",
    "--no-contract-check",
  ]);
}

function compareWithOptionalRepair(
  sourceSkillsDir: string,
  targetSkillsDir: string,
  label: string,
  sourceRoot: string,
  repair: boolean,
  sourceSkills: string[]
): void {
  const initial = compareTargets(sourceSkillsDir, targetSkillsDir, label, sourceSkills);
  printFindings(label, initial.findings);

  if (!initial.errors.length) {
    return;
  }

  if (!repair) {
    throw new Error(`${label} drift check failed with ${initial.errors.length} error(s)`);
  }

  console.log(`-> Repairing ${label} drift via sync`);
  syncTarget(sourceSkillsDir, targetSkillsDir, sourceRoot, sourceSkills);

  const after = compareTargets(sourceSkillsDir, targetSkillsDir, `${label} (post-repair)`, sourceSkills);
  printFindings(`${label} (post-repair)`, after.findings);
  if (after.errors.length) {
    throw new Error(`${label} drift still failing after repair (${after.errors.length} error(s))`);
  }
}

function compareGlobalCoreApp(
  sourceRoot: string,
  sourceSkillsDir: string,
  targetSkillsDir: string,
  label: string,
  appName: string,
  repair: boolean
): void {
  const { manifest } = readGlobalCoreManifest(path.join(sourceRoot, "globals", "core.json"));
  const app = resolveGlobalCoreApp(manifest, appName);
  compareWithOptionalRepair(sourceSkillsDir, targetSkillsDir, label, sourceRoot, repair, app.skills);
}

interface DoctorAllCheck {
  name: string;
  status: "PASS";
  command?: string[];
}

interface DoctorAllDeps {
  compareGlobalCoreApp?: typeof compareGlobalCoreApp;
  isGitRepo?: typeof isGitRepo;
  run?: typeof run;
}

function main(argv: string[] = process.argv, deps: DoctorAllDeps = {}): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const sourceSkillsDir = path.join(args.source, "skills");
  const runFn = deps.run ?? run;
  const compareGlobalCoreAppFn = deps.compareGlobalCoreApp ?? compareGlobalCoreApp;
  const isGitRepoFn = deps.isGitRepo ?? isGitRepo;

  const checks: DoctorAllCheck[] = [];
  const runCheck = (name: string, command: string[]): void => {
    if (!args.json) {
      const label = name
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      console.log(`-> ${label}`);
    }
    runFn(command);
    checks.push({ name, status: "PASS", command });
  };

  if (args.repair && isGitRepoFn(args.source)) {
    if (!args.json) {
      console.log("-> Repair mode: pulling source repository");
    }
    const command = ["git", "-C", args.source, "pull", "--ff-only"];
    runFn(command);
    checks.push({ name: "repair-pull", status: "PASS", command });
  }

  runCheck("contract", ["bun", CONTRACT, "--skills-root", sourceSkillsDir]);
  runCheck("source-validate", ["bun", SKILLPOOL, "validate", "--source", args.source]);
  runCheck("adapter-smoke", ["bun", SMOKE, "--source", args.source]);

  if (args.project) {
    runCheck("project-lockfile-doctor", ["bun", SKILLPOOL, "doctor", "--project", args.project, "--strict-hash", "--source", args.source]);
  }

  if (args.opencodeSkills) {
    console.log("-> Drift compare: OpenCode");
    compareGlobalCoreAppFn(args.source, sourceSkillsDir, args.opencodeSkills, "OpenCode", "opencode", args.repair);
  }

  if (args.codexSkills) {
    console.log("-> Drift compare: Codex");
    compareGlobalCoreAppFn(args.source, sourceSkillsDir, args.codexSkills, "Codex", "codex", args.repair);
  }

  if (args.claudeSkills) {
    console.log("-> Drift compare: Claude Code");
    compareGlobalCoreAppFn(args.source, sourceSkillsDir, args.claudeSkills, "Claude Code", "claude-code", args.repair);
  }

  if (args.qwenSkills) {
    console.log("-> Drift compare: Qwen");
    compareGlobalCoreAppFn(args.source, sourceSkillsDir, args.qwenSkills, "Qwen", "qwen", args.repair);
  }

  if (args.geminiSkills) {
    console.log("-> Drift compare: Gemini CLI");
    compareGlobalCoreAppFn(args.source, sourceSkillsDir, args.geminiSkills, "Gemini CLI", "gemini-cli", args.repair);
  }

  if (args.json) {
    console.log(JSON.stringify({
      status: "PASS",
      source: args.source,
      project: args.project,
      repair: args.repair,
      checks,
    }, null, 2));
    return;
  }

  console.log("\nSTATUS: PASS");
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
  compareGlobalCoreApp,
  compareTargets,
  compareWithOptionalRepair,
  main,
  parseArgs,
  resolveSyncScript,
};
