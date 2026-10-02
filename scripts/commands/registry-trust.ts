#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  normalizeRegistryTrustArgs,
  renderRegistryTrustResult,
  runRegistryTrust,
} from "../modules/skillpool/registry-trust.ts";

export interface RegistryTrustCliArgs {
  source?: string;
  scorecard?: string;
  json: boolean;
  strict: boolean;
  help: boolean;
}

export function help(): void {
  console.log(`
Score registry trust from a local scorecard and validated registry surface

Usage:
  bun scripts/commands/registry-trust.ts --source <dir> --scorecard <file> [options]

Options:
  --source <dir>      Repository/source root
  --scorecard <file>  Local registry trust scorecard JSON
  --json              Emit machine-readable output
  --strict            Treat warnings as blocking
  --help              Show help
`);
}

export function parseArgs(argv: string[] = process.argv): RegistryTrustCliArgs {
  const args: RegistryTrustCliArgs = { json: false, strict: false, help: false };
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
    if (token === "--scorecard") {
      args.scorecard = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (args.source) args.source = path.resolve(process.cwd(), args.source);
  if (args.scorecard) args.scorecard = path.resolve(process.cwd(), args.scorecard);
  return args;
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const input = normalizeRegistryTrustArgs({
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.scorecard === undefined ? {} : { scorecard: args.scorecard }),
    strict: args.strict,
  });
  const result = runRegistryTrust(input);
  console.log(renderRegistryTrustResult(result, args.json ? "json" : "text"));
  if (result.status === "BLOCKED") {
    process.exitCode = 1;
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
