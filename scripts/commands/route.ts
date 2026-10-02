#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  normalizeRouteArgs,
  localTestRouteAdapter,
  renderRouteResult,
  runRouteExecution,
  runRouteQuery,
} from "../modules/skillpool/routing-rules.ts";

export interface RouteCliArgs {
  source?: string;
  rules?: string;
  query?: string;
  json: boolean;
  strict: boolean;
  execute: boolean;
  adapter?: string;
  help: boolean;
}

export function help(): void {
  console.log(`
Route a query to matching skills using declarative routing rules

Usage:
  bun scripts/commands/route.ts --source <dir> --rules <file> --query <text> [options]

Options:
  --source <dir>    Source root containing skills/
  --rules <file>    Routing rules JSON file
  --query <text>    User intent/query to route
  --json            Emit machine-readable output
  --strict          Treat warnings as blocking
  --execute         Run only an explicitly named local test adapter after validation
  --adapter <name>  Adapter name; only local-test is available
  --help            Show help
`);
}

export function parseArgs(argv: string[] = process.argv): RouteCliArgs {
  const args: RouteCliArgs = { json: false, strict: false, execute: false, help: false };
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
    if (token === "--rules") {
      args.rules = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--query") {
      args.query = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (args.source) args.source = path.resolve(process.cwd(), args.source);
  if (args.rules) args.rules = path.resolve(process.cwd(), args.rules);
  return args;
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const input = normalizeRouteArgs({
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.rules === undefined ? {} : { rules: args.rules }),
    ...(args.query === undefined ? {} : { query: args.query }),
    strict: args.strict,
  });
  const result = runRouteQuery(input);
  if (args.execute) {
    const adapter = args.adapter === "local-test" ? localTestRouteAdapter : undefined;
    const execution = runRouteExecution(result, args.adapter ?? "<none>", adapter);
    console.log(args.json ? JSON.stringify(execution, null, 2) : `STATUS: ${execution.status}\nAdapter: ${execution.adapter}\nExecution: ${execution.execution}\nDecision: ${execution.decision}\nFindings: ${execution.findings.length}`);
    if (execution.status === "BLOCKED") process.exitCode = 1;
    return;
  }
  console.log(renderRouteResult(result, args.json ? "json" : "text"));
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
