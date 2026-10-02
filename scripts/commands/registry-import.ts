#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  importRegistryBundle,
  normalizeRegistryImportArgs,
  renderRegistryImportResult,
} from "../modules/skillpool/registry-import.ts";

export interface RegistryImportCliArgs {
  bundle?: string;
  output?: string;
  json: boolean;
  strict: boolean;
  help: boolean;
}

export function help(): void {
  console.log(`
Import a local Skill-Sys registry export bundle into a new registry directory

Usage:
  bun scripts/commands/registry-import.ts --bundle <file> --output <dir> [options]

Options:
  --bundle <file>  Local registry-export bundle JSON
  --output <dir>   Empty directory that receives registry JSON files
  --json           Emit machine-readable output
  --strict         Reserved for future warning-as-blocking checks
  --help           Show help

The importer is offline and authority-independent. It validates canonical
document digests and rejects remote taps or signed/provenance metadata that
cannot be verified by a configured authority.
`);
}

export function parseArgs(argv: string[] = process.argv): RegistryImportCliArgs {
  const args: RegistryImportCliArgs = { json: false, strict: false, help: false };
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
    if (token === "--bundle") {
      args.bundle = requireOptionValue(argv, i, token);
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
  if (args.bundle) args.bundle = path.resolve(process.cwd(), args.bundle);
  if (args.output) args.output = path.resolve(process.cwd(), args.output);
  return args;
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const input = normalizeRegistryImportArgs({
    ...(args.bundle === undefined ? {} : { bundle: args.bundle }),
    ...(args.output === undefined ? {} : { output: args.output }),
    strict: args.strict,
  });
  const result = importRegistryBundle(input);
  console.log(renderRegistryImportResult(result, args.json ? "json" : "text"));
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
