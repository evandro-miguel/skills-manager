#!/usr/bin/env bun
/**
 * Smoke test for project adapter installs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { runCommand } from "../lib/command.ts";
import { fileExists } from "../lib/files.ts";

interface SmokeAdaptersArgs {
  source: string;
  keepTemp: boolean;
  help: boolean;
  [key: string]: unknown;
}

const REPO_ROOT = path.resolve(__dirname, "../..");
const SKILLPOOL = path.join(__dirname, "skillpool.ts");

function help(): void {
  console.log(`
Smoke test adapter installs

Usage:
  bun scripts/commands/smoke-adapters.ts [options]

Options:
  --source <dir>      Source root for universal-skills (default: .)
  --keep-temp         Keep temporary project directory
  --help              Show help
`);
}

function parseArgs(argv: string[]): SmokeAdaptersArgs {
  const args: SmokeAdaptersArgs = {
    source: REPO_ROOT,
    keepTemp: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--keep-temp") {
      args.keepTemp = true;
      continue;
    }
    if (token.startsWith("--")) {
      if (token === "--source") {
        args.source = requireOptionValue(argv, i, token);
        i += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), args.source);
  return args;
}

function run(args: string[], options: Parameters<typeof runCommand>[1] = {}): void {
  runCommand(args, options);
}

function assertFile(filePath: string): void {
  if (!fileExists(filePath)) {
    throw new Error(`Missing expected file: ${filePath}`);
  }
}

function runInstall(tmpProject: string, sourceRoot: string, app: string): void {
  run(["bun", SKILLPOOL, "install", "--project", tmpProject, "--source", sourceRoot, "--app", app, "--profile", "core"]);
}

interface SmokeAdaptersDeps {
  fileExists?: typeof fileExists;
  mkdtempSync?: typeof fs.mkdtempSync;
  rmSync?: typeof fs.rmSync;
  runInstall?: typeof runInstall;
}

function main(argv: string[] = process.argv, deps: SmokeAdaptersDeps = {}): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const fileExistsFn = deps.fileExists ?? fileExists;
  const mkdtempSyncFn = deps.mkdtempSync ?? fs.mkdtempSync;
  const rmSyncFn = deps.rmSync ?? fs.rmSync;
  const runInstallFn = deps.runInstall ?? runInstall;

  if (!fileExistsFn(path.join(args.source, "skills"))) {
    throw new Error(`Invalid source root (missing skills/): ${args.source}`);
  }

  const tmpProject = mkdtempSyncFn(path.join(os.tmpdir(), "skillpool-smoke-"));
  console.log(`-> Smoke project: ${tmpProject}`);

  try {
    const apps = ["opencode", "codex", "claude-code", "antigravity"];
    for (const app of apps) {
      runInstallFn(tmpProject, args.source, app);
    }

    if (!fileExistsFn(path.join(tmpProject, ".agents", "skills", "writing-skills", "SKILL.md"))) {
      throw new Error(`Missing expected file: ${path.join(tmpProject, ".agents", "skills", "writing-skills", "SKILL.md")}`);
    }
    if (fileExistsFn(path.join(tmpProject, ".codex", "skills"))) {
      throw new Error("Project adapter smoke created deprecated .codex/skills target");
    }
    if (fileExistsFn(path.join(tmpProject, ".claude", "skills"))) {
      throw new Error("Project adapter smoke created deprecated .claude/skills target");
    }
    if (fileExistsFn(path.join(tmpProject, ".gemini", "antigravity", "skills"))) {
      throw new Error("Project adapter smoke created deprecated .gemini/antigravity/skills target");
    }

    console.log("STATUS: PASS");
    console.log("Smoke install passed for project adapters using .agents/skills");
  } finally {
    if (!args.keepTemp) {
      rmSyncFn(tmpProject, { recursive: true, force: true });
    }
  }
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
  assertFile,
  main,
  parseArgs,
};
