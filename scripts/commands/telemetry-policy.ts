#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  applyTelemetryCollection,
  normalizeTelemetryPolicyArgs,
  renderTelemetryCollectionResult,
  renderTelemetryPolicyResult,
  runTelemetryPolicy,
} from "../modules/skillpool/telemetry-policy.ts";

export interface TelemetryPolicyCliArgs {
  command?: "collect";
  source?: string;
  config?: string;
  output?: string;
  event?: string;
  skill?: string;
  json: boolean;
  strict: boolean;
  dryRun: boolean;
  help: boolean;
}

export function help(): void {
  console.log(`
Validate a local telemetry policy without collecting or sending telemetry

Usage:
  bun scripts/commands/telemetry-policy.ts --source <dir> --config <file> [options]
  bun scripts/commands/telemetry-policy.ts collect --source <dir> --config <file> --output <file> --event <name> --skill <name> [options]

Options:
  --source <dir>   Repository/source root
  --config <file>  Local telemetry policy JSON
  --output <file>  Local/private JSONL output (collect)
  --event <name>   Caller-supplied event name (collect)
  --skill <name>   Policy-approved skill name (collect)
  --json           Emit machine-readable output
  --dry-run        Render event without writing (collect)
  --strict         Treat warnings as blocking
  --help           Show help
`);
}

export function parseArgs(argv: string[] = process.argv): TelemetryPolicyCliArgs {
  const args: TelemetryPolicyCliArgs = { json: false, strict: false, dryRun: false, help: false };
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
    if (token === "--dry-run") {
      args.dryRun = true;
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
    if (token === "--output") {
      args.output = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--event") {
      args.event = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--skill") {
      args.skill = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "collect") {
      args.command = token;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (args.source) args.source = path.resolve(process.cwd(), args.source);
  if (args.config) args.config = path.resolve(process.cwd(), args.config);
  if (args.output) args.output = path.resolve(process.cwd(), args.output);
  return args;
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const input = normalizeTelemetryPolicyArgs({
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.config === undefined ? {} : { config: args.config }),
    strict: args.strict,
  });
  if (args.command === "collect") {
    if (!args.output) throw new Error("Missing --output");
    if (!args.event) throw new Error("Missing --event");
    if (!args.skill) throw new Error("Missing --skill");
    const result = applyTelemetryCollection(input, { event: args.event, skill: args.skill }, args.output, { dryRun: args.dryRun });
    console.log(renderTelemetryCollectionResult(result, args.json ? "json" : "text"));
    if (result.status === "blocked") process.exitCode = 1;
    return;
  }
  const result = runTelemetryPolicy(input);
  console.log(renderTelemetryPolicyResult(result, args.json ? "json" : "text"));
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
