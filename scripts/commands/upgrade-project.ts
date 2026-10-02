#!/usr/bin/env bun
/**
 * Upgrade one project's skills lockfile ref and verify with strict hash doctor.
 */

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";

interface UpgradeArgs {
  project?: string;
  ref?: string;
  repo?: string;
  lockfile?: string;
  source?: string;
  refreshCache: boolean;
  help?: boolean;
  [key: string]: unknown;
}

type Runner = (args: string[]) => void;

const SKILLPOOL = path.join(__dirname, "skillpool.ts");

function help(): void {
  console.log(`
Upgrade project lockfile ref and verify install

Usage:
  bun scripts/commands/upgrade-project.ts --project <dir> [--ref <tag|branch|sha>] [--repo <url|path>] [options]

Options:
  --project <dir>       project directory (required)
  --ref <value>         target git ref (required if --repo is not provided)
  --repo <url|path>     optional repository override
  --lockfile <file>     optional lockfile path relative to project
  --source <dir>        optional source override
  --refresh-cache       refresh source cache during upgrade
  --help                show help
`);
}

function parseArgs(argv: string[]): UpgradeArgs {
  const args: UpgradeArgs = {
    refreshCache: false,
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
    if (token === "--repo") {
      args.repo = requireOptionValue(argv, i, token);
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
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.help) {
    if (!args.project) {
      throw new Error("Missing --project");
    }
    if (!args.ref && !args.repo) {
      throw new Error("Missing --ref (or provide --repo)");
    }
  }

  if (args.project) {
    args.project = path.resolve(process.cwd(), args.project);
  }
  if (args.source) {
    args.source = path.resolve(process.cwd(), args.source);
  }
  return args;
}

function run(args: string[]): void {
  const proc = Bun.spawnSync(args, {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (proc.exitCode !== 0) {
    process.exit(proc.exitCode);
  }
}

function main(argv: string[] = process.argv, runFn: Runner = run): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const upgradeArgs = ["bun", SKILLPOOL, "upgrade", "--project", String(args.project)];

  if (args.ref) {
    upgradeArgs.push("--ref", args.ref);
  }

  if (args.repo) {
    upgradeArgs.push("--repo", args.repo);
  }
  if (args.lockfile) {
    upgradeArgs.push("--lockfile", args.lockfile);
  }
  if (args.source) {
    upgradeArgs.push("--source", args.source);
  }
  if (args.refreshCache) {
    upgradeArgs.push("--refresh-cache");
  }

  runFn(upgradeArgs);

  const doctorArgs = ["bun", SKILLPOOL, "doctor", "--project", String(args.project), "--strict-hash"];
  if (args.lockfile) {
    doctorArgs.push("--lockfile", args.lockfile);
  }
  if (args.source) {
    doctorArgs.push("--source", args.source);
  }
  if (args.refreshCache) {
    doctorArgs.push("--refresh-cache");
  }

  runFn(doctorArgs);
}

try {
  if (require.main === module) {
    main();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

export {
  main,
  parseArgs,
};
