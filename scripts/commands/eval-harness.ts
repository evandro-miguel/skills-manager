#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  normalizeEvalHarnessArgs,
  renderEvalHarnessResult,
  runEvalHarness,
} from "../modules/skillpool/eval-harness.ts";

interface EvalHarnessCliArgs {
  source?: string;
  skill?: string;
  json: boolean;
  strict: boolean;
  help: boolean;
}

export function help(): void {
  console.log(`
Evaluate deterministic skill eval fixtures

Usage:
  bun scripts/commands/eval-harness.ts --source <dir> [options]

Options:
  --source <dir>       Source root containing skills/
  --skill <name>       Evaluate one skill only
  --json               Emit machine-readable output
  --strict             Treat warnings as blocking
  --help               Show help
`);
}

export function parseArgs(argv: string[] = process.argv): EvalHarnessCliArgs {
  const args: EvalHarnessCliArgs = { json: false, strict: false, help: false };
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
    if (token === "--skill") {
      args.skill = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (args.source) {
    args.source = path.resolve(process.cwd(), args.source);
  }
  return args;
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const input = normalizeEvalHarnessArgs({
    source: args.source,
    skill: args.skill,
    strict: args.strict,
  });
  const result = runEvalHarness(input);
  console.log(renderEvalHarnessResult(result, args.json ? "json" : "text"));
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
