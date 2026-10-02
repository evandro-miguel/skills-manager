#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { formatSkillpackFindings, validateSkillpack } from "../modules/skillpool/skillpack.ts";

interface ValidateSkillpackArgs {
  source: string;
  json: boolean;
  strict: boolean;
  help?: boolean;
}

function help(): void {
  console.log(`
Validate a Skill-Sys skillpack manifest and local file contract

Usage:
  bun scripts/commands/validate-skillpack.ts --source <dir> [options]

Options:
  --source <dir>  Skillpack root (default: current directory)
  --strict        Treat WARN findings as blocking
  --json          Emit machine-readable findings
  --help          Show help
`);
}

function parseArgs(argv: string[]): ValidateSkillpackArgs {
  const args: ValidateSkillpackArgs = {
    source: process.cwd(),
    json: false,
    strict: false,
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
    if (token === "--strict") {
      args.strict = true;
      continue;
    }
    if (token === "--source") {
      args.source = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
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
  const result = validateSkillpack({ source: args.source, strict: args.strict });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.findings.length) {
    console.log("STATUS: PASS");
    console.log(`Source: ${result.source}`);
    console.log("Findings: 0");
  } else {
    const warnOnly = result.blockingFindingCount === 0;
    console.log(warnOnly ? "STATUS: WARN" : "STATUS: BLOCKING");
    console.log(`Source: ${result.source}`);
    console.log(`Findings: ${result.findings.length}`);
    console.log(`Blocking findings: ${result.blockingFindingCount}`);
    console.log("\nFINDINGS:");
    console.log(formatSkillpackFindings(result.findings));
  }
  if (result.blockingFindingCount) {
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
