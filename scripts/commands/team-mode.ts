#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  normalizeTeamModeArgs,
  renderTeamModeResult,
  runTeamModeValidation,
} from "../modules/skillpool/team-mode.ts";

export interface TeamModeCliArgs {
  source?: string;
  config?: string;
  json: boolean;
  strict: boolean;
  help: boolean;
}

export function help(): void {
  console.log(`
Validate a deterministic team-mode configuration

Usage:
  bun scripts/commands/team-mode.ts --source <dir> --config <file> [options]

Options:
  --source <dir>    Source/project root for relative policy validation
  --config <file>   Team-mode JSON config file
  --json            Emit machine-readable output
  --strict          Treat warnings as blocking
  --help            Show help
`);
}

export function parseArgs(argv: string[] = process.argv): TeamModeCliArgs {
  const args: TeamModeCliArgs = { json: false, strict: false, help: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--strict") {
      args.strict = true;
      continue;
    }
    if (token === "--source") {
      args.source = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--config") {
      args.config = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (args.source) args.source = path.resolve(process.cwd(), args.source);
  if (args.config) args.config = path.resolve(process.cwd(), args.config);
  return args;
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const input = normalizeTeamModeArgs({
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.config === undefined ? {} : { config: args.config }),
    strict: args.strict,
  });
  const result = runTeamModeValidation(input);
  console.log(renderTeamModeResult(result, args.json ? "json" : "text"));
  if (result.status === "BLOCKED") process.exitCode = 1;
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
