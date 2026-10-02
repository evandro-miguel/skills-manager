#!/usr/bin/env bun
/**
 * Simple bootstrap installer for project skills lockfile.
 *
 * Runs:
 *   1) skillpool install
 *   2) skillpool doctor
 *
 * Usage:
 *   bun scripts/commands/install-skills.ts --project /path/to/project --source .
 */

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";

interface InstallSkillsArgs {
  project?: string;
  lockfile?: string;
  source?: string;
  projectionDir?: string;
  refreshCache?: boolean;
  strictHash?: boolean;
  dryRun?: boolean;
  help?: boolean;
  [key: string]: unknown;
}

type SkillpoolRunner = (subcommand: string, argsList: string[]) => void;

const SCRIPT_DIR = __dirname;
const SKILLPOOL = path.join(SCRIPT_DIR, "skillpool.ts");

function help(): void {
  console.log(`
Install project skills from lockfile (simple mode)

Usage:
  bun scripts/commands/install-skills.ts [options]

Options:
  --project <dir>        Project directory (default: current directory)
  --lockfile <file>      Lockfile path relative to project (default: .skills.lock.json)
  --source <dir>         Local source path for skills pool
  --projection-dir <dir> Prebuilt provider projections directory for install
  --refresh-cache        Refresh git source cache before install
  --strict-hash          Run doctor with strict hash comparison
  --dry-run              Print actions without writing files
  --help                 Show help

Examples:
  bun scripts/commands/install-skills.ts --project . --source .
  bun scripts/commands/install-skills.ts --project /work/repo
`);
}

function parseArgs(argv: string[]): InstallSkillsArgs {
  const args: InstallSkillsArgs = {};
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

    if (token === "--strict-hash") {
      args.strictHash = true;
      continue;
    }

    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (token === "--project") {
      args.project = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--lockfile") {
      args.lockfile = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--source") {
      args.source = requireOptionValue(argv, i, token);
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
  return args;
}

function runSkillpool(subcommand: string, argsList: string[]): void {
  const proc = Bun.spawnSync(["bun", SKILLPOOL, subcommand, ...argsList], {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });

  if (proc.exitCode !== 0) {
    process.exit(proc.exitCode);
  }
}

function buildCommonFlags(options: InstallSkillsArgs): string[] {
  const flags: string[] = [];

  if (options.project) {
    flags.push("--project", options.project);
  }

  if (options.lockfile) {
    flags.push("--lockfile", options.lockfile);
  }

  if (options.source) {
    flags.push("--source", options.source);
  }

  if (options.projectionDir) {
    flags.push("--projection-dir", options.projectionDir);
  }

  if (options.refreshCache) {
    flags.push("--refresh-cache");
  }

  if (options.dryRun) {
    flags.push("--dry-run");
  }

  return flags;
}

function main(
  argv: string[] = process.argv,
  runSkillpoolFn: SkillpoolRunner = runSkillpool
): void {
  const options = parseArgs(argv);

  if (options.help) {
    help();
    return;
  }

  const common = buildCommonFlags(options);

  console.log("-> Installing skills from lockfile");
  runSkillpoolFn("install", common);

  const doctorFlags = common.filter((flag) => flag !== "--dry-run");
  if (options.strictHash) {
    doctorFlags.push("--strict-hash");
  }

  console.log("-> Verifying installation");
  runSkillpoolFn("doctor", doctorFlags);

  console.log("Done: skills installed and verified.");
}

if (require.main === module) {
  main();
}

export {
  buildCommonFlags,
  main,
  parseArgs,
};
