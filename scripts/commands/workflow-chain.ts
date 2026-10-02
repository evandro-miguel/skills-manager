#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  normalizeWorkflowChainArgs,
  localTestWorkflowAdapter,
  renderWorkflowChainPlan,
  runWorkflowChainExecution,
  runWorkflowChainPlan,
} from "../modules/skillpool/workflow-chain.ts";

export interface WorkflowChainCliArgs {
  source?: string;
  workflow?: string;
  json: boolean;
  strict: boolean;
  execute: boolean;
  adapter?: string;
  help: boolean;
}

export function help(): void {
  console.log(`
Validate and dry-run a declarative workflow chain

Usage:
  bun scripts/commands/workflow-chain.ts --source <dir> --workflow <file> [options]

Options:
  --source <dir>       Source root containing skills/
  --workflow <file>    Workflow chain JSON file
  --json               Emit machine-readable output
  --strict             Treat warnings as blocking
  --execute             Run only an explicitly named local test adapter after validation
  --adapter <name>     Adapter name; only local-test is available
  --help               Show help
`);
}

export function parseArgs(argv: string[] = process.argv): WorkflowChainCliArgs {
  const args: WorkflowChainCliArgs = { json: false, strict: false, execute: false, help: false };
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
    if (token === "--execute") {
      args.execute = true;
      continue;
    }
    if (token === "--adapter") {
      args.adapter = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--source") {
      args.source = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--workflow") {
      args.workflow = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (args.source) {
    args.source = path.resolve(process.cwd(), args.source);
  }
  if (args.workflow) {
    args.workflow = path.resolve(process.cwd(), args.workflow);
  }
  return args;
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const input = normalizeWorkflowChainArgs({
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.workflow === undefined ? {} : { workflow: args.workflow }),
    strict: args.strict,
  });
  const result = runWorkflowChainPlan(input);
  if (!args.execute) {
    console.log(renderWorkflowChainPlan(result, args.json ? "json" : "text"));
    if (result.status === "BLOCKED") process.exitCode = 1;
    return;
  }
  const adapter = args.adapter === "local-test" ? localTestWorkflowAdapter : undefined;
  const execution = runWorkflowChainExecution(result, args.adapter ?? "<none>", adapter);
  console.log(args.json ? JSON.stringify(execution, null, 2) : `STATUS: ${execution.status}\nAdapter: ${execution.adapter}\nExecution: ${execution.execution}\nFindings: ${execution.findings.length}`);
  if (execution.status === "BLOCKED") {
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
