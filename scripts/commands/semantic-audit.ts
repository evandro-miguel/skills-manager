#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  formatFindings,
  hasErrors,
  semanticAudit,
} from "../modules/skillpool/semantic-evals.ts";

interface SemanticAuditArgs {
  source: string;
  json: boolean;
  help: boolean;
}

function help(): void {
  console.log(`
Audit skill descriptions for semantic supply-chain risks

Usage:
  bun scripts/commands/semantic-audit.ts [options]

Options:
  --source <dir>       Source root (default: .)
  --json               Emit machine-readable output
  --help               Show help
`);
}

function parseArgs(argv: string[] = process.argv): SemanticAuditArgs {
  const args: SemanticAuditArgs = {
    source: ".",
    json: false,
    help: false,
  };

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
    if (token === "--source") {
      args.source = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), args.source);
  return args;
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const result = semanticAudit({ sourceRoot: args.source });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(hasErrors(result.findings) ? "STATUS: BLOCKING" : "STATUS: PASS");
    console.log(`Skills: ${result.skillCount}`);
    console.log(formatFindings(result.findings));
  }

  if (hasErrors(result.findings)) {
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

export {
  help,
  main,
  parseArgs,
};
