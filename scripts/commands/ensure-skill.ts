#!/usr/bin/env bun
/**
 * On-demand skill installer.
 *
 * Ensures one skill is present for the selected app in a project.
 * If already installed, exits without changes.
 */

import path from "node:path";
import { parseCsv, unique, requireOptionValue } from "../lib/args.ts";
import { runCommand } from "../lib/command.ts";
import { fileExists, readJson } from "../lib/files.ts";
import { assertNotHomeAgentsSkillsTarget } from "../modules/home-agents-guard.ts";
import { readGlobalCoreManifest, resolveGlobalCoreSkills } from "../modules/global-core.ts";

interface AdapterConfig {
  targetPath: string;
}

interface EnsureSkillArgs {
  project: string;
  app: string;
  apps: string[];
  source: string | null;
  repo?: string;
  ref?: string;
  skill?: string;
  refreshCache: boolean;
  verifySignedTag: boolean;
  expectedSourceSha256: string | null;
  allowGlobalCoreSkills: boolean;
  dryRun: boolean;
  help: boolean;
  [key: string]: unknown;
}

const SCRIPT_DIR = __dirname;
const TOOL_ROOT = path.resolve(SCRIPT_DIR, "../..");
const ADAPTERS_DIR = path.join(TOOL_ROOT, "adapters");
const SKILLPOOL = path.join(SCRIPT_DIR, "skillpool.ts");

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

function help(): void {
  console.log(`
Ensure one skill is installed (on-demand)

Usage:
  bun scripts/commands/ensure-skill.ts --skill <name> [options]

Options:
  --skill <name>                  Skill name to ensure (required)
  --project <dir>                 Project directory (default: current directory)
  --app <name|auto>               Project app label: opencode|codex|claude-code|antigravity|auto (default: auto)
  --apps <csv>                    Auto app order fallback (default: opencode)
  --source <dir>                  Local universall-skill-sys source (default: script parent)
  --repo <git-url-or-path>        Optional source repo (if not using --source)
  --ref <tag|branch|sha>          Source ref (default: main when --repo is used)
  --refresh-cache                 Refresh source cache (repo mode)
  --verify-signed-tag             Require ref to be a valid signed tag
  --expected-source-sha256 <hex>  Require source checksum to match this SHA-256
  --dry-run                       Print actions without writing files
  --allow-global-core-skills      Exceptional: install a project-local alternative for a global-core skill
  --help                          Show help

Examples:
  bun scripts/commands/ensure-skill.ts --skill writing-skills --project .
  bun scripts/commands/ensure-skill.ts --skill bun-skill --project . --app opencode
  bun scripts/commands/ensure-skill.ts --skill react-skill --project . --repo git@github.com:your-org/example-skillpack.git --ref v0.2.0
`);
}

function parseArgs(argv: string[]): EnsureSkillArgs {
  const args: EnsureSkillArgs = {
    project: process.cwd(),
    app: "auto",
    apps: ["opencode"],
    source: null,
    refreshCache: false,
    verifySignedTag: false,
    expectedSourceSha256: null,
    allowGlobalCoreSkills: false,
    dryRun: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--refresh-cache") {
      args.refreshCache = true;
      continue;
    }
    if (token === "--verify-signed-tag") {
      args.verifySignedTag = true;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "--allow-global-core-skills") {
      args.allowGlobalCoreSkills = true;
      continue;
    }
    if (token === "--project") {
      args.project = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--app") {
      args.app = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--apps") {
      args.apps = parseCsv(requireOptionValue(argv, i, token), args.apps);
      i += 1;
      continue;
    }
    if (token === "--source") {
      args.source = requireOptionValue(argv, i, token);
      i += 1;
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
    if (token === "--skill") {
      args.skill = requireOptionValue(argv, i, token);
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

  if (!args.help && !args.skill) {
    throw new Error("Missing required argument: --skill <name>");
  }

  args.project = path.resolve(args.project);
  args.apps = unique(parseCsv(args.apps, args.apps)).map((appName) => assertSafeName(appName, "app"));
  if (args.source) {
    args.source = path.resolve(args.source);
  } else if (!args.repo) {
    args.source = TOOL_ROOT;
  }
  args.app = assertSafeName(args.app, "app");
  if (args.skill) {
    args.skill = assertSafeName(String(args.skill), "skill");
  }
  if (args.app !== "auto" && !args.apps.includes(args.app)) {
    args.apps.unshift(args.app);
    args.apps = unique(args.apps);
  }
  return args;
}

function run(args: string[]): void {
  runCommand(args);
}

function readAdapter(app: string): AdapterConfig {
  const safeApp = assertSafeName(app, "app");
  const adapterPath = path.join(ADAPTERS_DIR, `${safeApp}.json`);
  if (!fileExists(adapterPath)) {
    throw new Error(`Unknown app '${safeApp}'. Missing adapter: ${adapterPath}`);
  }
  let adapter: unknown;
  try {
    adapter = readJson(adapterPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid adapter JSON (${adapterPath}): ${message}`);
  }
  if (!adapter || typeof adapter !== "object" || typeof (adapter as AdapterConfig).targetPath !== "string") {
    throw new Error(`Invalid adapter '${safeApp}': missing targetPath`);
  }
  return adapter as AdapterConfig;
}

function normalizeAdapterTargetPath(raw: unknown, app: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`Invalid adapter '${app}': targetPath must be a non-empty string`);
  }

  const normalized = path.posix.normalize(raw.trim().replaceAll("\\", "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid adapter '${app}': targetPath must stay within the project directory`);
  }

  return normalized;
}

function assertPathWithinProject(projectDir: string, targetPath: string, label: string): void {
  const projectAbs = path.resolve(projectDir);
  const targetAbs = path.resolve(targetPath);
  const relative = path.relative(projectAbs, targetAbs);

  if (relative === "" || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay within project directory (${projectAbs}): ${targetAbs}`);
  }
}

function installedSkillEntry(projectDir: string, app: string, skill: string): string {
  const adapter = readAdapter(app);
  const targetPath = path.join(
    projectDir,
    normalizeAdapterTargetPath(adapter.targetPath, app),
    skill,
    "SKILL.md"
  );
  assertPathWithinProject(projectDir, targetPath, `Installed skill entry for '${app}'`);
  return targetPath;
}

function isGlobalCoreSkill(sourceRoot: string | null, skill: string): boolean {
  const manifestPath = path.join(sourceRoot || TOOL_ROOT, "globals", "core.json");
  if (!fileExists(manifestPath)) {
    return false;
  }
  const { manifest } = readGlobalCoreManifest(manifestPath);
  return resolveGlobalCoreSkills(manifest).includes(skill);
}

function detectApp(projectDir: string, candidates: string[]): string {
  const markers: Record<string, string | string[]> = {
    opencode: [".agents", ".opencode", ".agent"],
    codex: ".codex",
    "claude-code": ".claude",
    antigravity: path.join(".gemini", "antigravity"),
  };

  for (const app of candidates) {
    const appMarkers = markers[app];
    if (!appMarkers) {
      continue;
    }
    const normalizedMarkers = Array.isArray(appMarkers) ? appMarkers : [appMarkers];
    if (normalizedMarkers.some((marker) => fileExists(path.join(projectDir, marker)))) {
      return app;
    }
  }

  return candidates[0] || "opencode";
}

interface EnsureSkillDeps {
  detectApp?: typeof detectApp;
  fileExists?: typeof fileExists;
  installedSkillEntry?: typeof installedSkillEntry;
  isGlobalCoreSkill?: typeof isGlobalCoreSkill;
  run?: typeof run;
}

function main(argv: string[] = process.argv, deps: EnsureSkillDeps = {}): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const skill = String(args.skill);
  const candidates = args.app === "auto" ? args.apps : [args.app];
  const detectAppFn = deps.detectApp ?? detectApp;
  const fileExistsFn = deps.fileExists ?? fileExists;
  const installedSkillEntryFn = deps.installedSkillEntry ?? installedSkillEntry;
  const isGlobalCoreSkillFn = deps.isGlobalCoreSkill ?? isGlobalCoreSkill;
  const runFn = deps.run ?? run;

  if (!args.allowGlobalCoreSkills && isGlobalCoreSkillFn(args.source || TOOL_ROOT, skill)) {
    console.log(`Skill is managed by global-core, not project-local: ${skill}`);
    console.log("- use sync-global-core for user-global folders, or pass --allow-global-core-skills only for an intentional project-local alternative");
    return;
  }

  for (const app of candidates) {
    const existing = installedSkillEntryFn(args.project, app, skill);
    const targetBase = path.dirname(path.dirname(existing));
    assertNotHomeAgentsSkillsTarget(targetBase, `On-demand skill target for '${app}'`);
    if (fileExistsFn(existing)) {
      console.log(`Skill already installed: ${skill} (${app})`);
      console.log(`- path: ${existing}`);
      return;
    }
  }

  const targetApp = args.app === "auto" ? detectAppFn(args.project, candidates) : args.app;
  const cmd = ["bun", SKILLPOOL, "install", "--project", args.project, "--app", targetApp, "--skills", skill];

  if (args.source) {
    cmd.push("--source", args.source);
  } else if (args.repo) {
    cmd.push("--repo", args.repo);
    cmd.push("--ref", args.ref || "main");
  } else {
    throw new Error("Missing source input. Provide --source or --repo.");
  }

  if (args.refreshCache) {
    cmd.push("--refresh-cache");
  }
  if (args.verifySignedTag) {
    cmd.push("--verify-signed-tag");
  }
  if (args.expectedSourceSha256) {
    cmd.push("--expected-source-sha256", args.expectedSourceSha256);
  }
  if (args.dryRun) {
    cmd.push("--dry-run");
  }
  if (args.allowGlobalCoreSkills) {
    cmd.push("--allow-global-core-skills");
  }

  console.log(`Installing on-demand skill '${skill}' for app '${targetApp}'`);
  runFn(cmd);

  const finalEntry = installedSkillEntryFn(args.project, targetApp, skill);
  if (!args.dryRun && !fileExistsFn(finalEntry)) {
    throw new Error(`Install finished but skill entry was not found: ${finalEntry}`);
  }

  console.log(`Skill ensured: ${skill} (${targetApp})`);
  console.log(`- path: ${finalEntry}`);
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
  detectApp,
  installedSkillEntry,
  isGlobalCoreSkill,
  main,
  normalizeAdapterTargetPath,
  parseArgs,
  readAdapter,
};
