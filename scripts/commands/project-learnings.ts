#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  applyProjectLearningsAppend,
  applyProjectLearningsUpdate,
  normalizeProjectLearningsArgs,
  renderProjectLearningsResult,
  renderProjectLearningsWriteResult,
  runProjectLearningsValidation,
} from "../modules/skillpool/project-learnings.ts";

export type ProjectLearningsCommand = "validate" | "append" | "update";

export interface ProjectLearningsCliArgs {
  command?: ProjectLearningsCommand;
  source?: string;
  learnings?: string;
  id?: string;
  summary?: string;
  sourceEntry?: string;
  json: boolean;
  strict: boolean;
  dryRun: boolean;
  help: boolean;
}

export function help(): void {
  console.log(`
Manage local/private project learnings without publishing them

Usage:
  bun scripts/commands/project-learnings.ts [validate] --source <dir> --learnings <file> [options]
  bun scripts/commands/project-learnings.ts append --source <dir> --learnings <file> --id <id> --summary <text> --source-entry <text> [options]
  bun scripts/commands/project-learnings.ts update --source <dir> --learnings <file> --id <id> --summary <text> [options]

Commands:
  validate             Validate learnings (default)
  append               Add a new learning entry
  update               Replace an existing entry's summary

Options:
  --source <dir>       Project/source root
  --learnings <file>   Project learnings JSON file
  --id <id>            Entry id (append/update)
  --summary <text>     Entry summary (append/update)
  --source-entry <text> Entry source/origin (append)
  --json               Emit machine-readable output
  --dry-run            Print what would be written without writing
  --strict             Treat warnings as blocking
  --help               Show help
`);
}

export function parseArgs(argv: string[] = process.argv): ProjectLearningsCliArgs {
  const args: ProjectLearningsCliArgs = { json: false, strict: false, dryRun: false, help: false };
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
    if (token === "--learnings") {
      args.learnings = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--id") {
      args.id = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--summary") {
      args.summary = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--source-entry") {
      args.sourceEntry = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "validate" || token === "append" || token === "update") {
      args.command = token;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (args.source) args.source = path.resolve(process.cwd(), args.source);
  if (args.learnings) args.learnings = path.resolve(process.cwd(), args.learnings);
  return args;
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const input = normalizeProjectLearningsArgs({
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.learnings === undefined ? {} : { learnings: args.learnings }),
    strict: args.strict,
  });

  if (args.command === "append" || args.command === "update") {
    if (!args.id) throw new Error("Missing --id");
    if (!args.summary) throw new Error("Missing --summary");
    if (args.command === "append" && !args.sourceEntry) throw new Error("Missing --source-entry");
    const entry = { id: args.id, summary: args.summary, source: args.sourceEntry ?? "" };
    const result = args.command === "append"
      ? applyProjectLearningsAppend(input, entry, { dryRun: args.dryRun })
      : applyProjectLearningsUpdate(input, entry, { dryRun: args.dryRun });
    console.log(renderProjectLearningsWriteResult(result, args.json ? "json" : "text"));
    if (result.status === "blocked") process.exitCode = 1;
    return;
  }

  const result = runProjectLearningsValidation(input);
  console.log(renderProjectLearningsResult(result, args.json ? "json" : "text"));
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
