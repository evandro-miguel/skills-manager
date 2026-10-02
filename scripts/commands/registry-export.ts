#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  normalizeRegistryExportArgs,
  renderRegistryExportResult,
  runRegistryExport,
  writeRegistryExportBundle,
} from "../modules/skillpool/registry-export.ts";

export interface RegistryExportCliArgs {
  source?: string;
  output?: string;
  json: boolean;
  strict: boolean;
  help: boolean;
}

export function help(): void {
  console.log(`
Export the validated public registry surface as a deterministic interop bundle

Usage:
  bun scripts/commands/registry-export.ts --source <dir> [options]

Options:
  --source <dir>  Repository/source root (default: cwd)
  --output <file> Write the deterministic registry bundle atomically
  --json          Emit machine-readable output
  --strict        Reserved for future warning-as-blocking checks
  --help          Show help
`);
}

export function parseArgs(argv: string[] = process.argv): RegistryExportCliArgs {
  const args: RegistryExportCliArgs = { json: false, strict: false, help: false };
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
    if (token === "--output") {
      args.output = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (args.source) args.source = path.resolve(process.cwd(), args.source);
  if (args.output) args.output = path.resolve(process.cwd(), args.output);
  return args;
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const input = normalizeRegistryExportArgs({
    ...(args.source === undefined ? {} : { source: args.source }),
    strict: args.strict,
  });
  const result = runRegistryExport(input);
  if (args.output) writeRegistryExportBundle(args.output, result.bundle);
  console.log(renderRegistryExportResult(result, args.json ? "json" : "text"));
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
