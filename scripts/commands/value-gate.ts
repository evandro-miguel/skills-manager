#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  normalizeValueGateArgs,
  renderValueGateResult,
  runValueGate,
} from "../modules/skillpool/value-gate.ts";

interface ValueGateCliArgs {
  receipt?: string;
  baseline?: string;
  policy?: string;
  json: boolean;
  help: boolean;
}

export function help(): void {
  console.log(`
Compare verified measured-eval receipts against an explicit baseline and policy

Usage:
  bun scripts/commands/value-gate.ts --receipt <file> --baseline <file> --policy <file> [--json]

Options:
  --receipt <file>     Candidate measured-eval receipt
  --baseline <file>    Immutable baseline evidence containing a receipt
  --policy <file>      Explicit comparison-policy snapshot
  --json               Emit machine-readable output
  --help               Show help
`);
}

export function parseArgs(argv: string[] = process.argv): ValueGateCliArgs {
  const args: ValueGateCliArgs = { json: false, help: false };
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
    if (token === "--receipt") {
      args.receipt = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--baseline") {
      args.baseline = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--policy") {
      args.policy = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  for (const key of ["receipt", "baseline", "policy"] as const) if (args[key]) args[key] = path.resolve(process.cwd(), args[key]!);
  return args;
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const input = normalizeValueGateArgs({
    receipt: args.receipt,
    baseline: args.baseline,
    policy: args.policy,
  });
  const result = runValueGate(input);
  console.log(renderValueGateResult(result, args.json ? "json" : "text"));
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
