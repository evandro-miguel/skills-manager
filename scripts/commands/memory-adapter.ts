#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  applyMemoryAdapterRead,
  applyMemoryAdapterWrite,
  normalizeMemoryAdapterArgs,
  renderMemoryAdapterReadResult,
  renderMemoryAdapterResult,
  renderMemoryAdapterWriteResult,
  runMemoryAdapterValidation,
} from "../modules/skillpool/memory-adapter.ts";

export type MemoryAdapterCommand = "validate" | "read" | "write";

export interface MemoryAdapterCliArgs {
  command?: MemoryAdapterCommand;
  source?: string;
  config?: string;
  id?: string;
  memory?: string;
  sourceEntry?: string;
  json: boolean;
  strict: boolean;
  dryRun: boolean;
  help: boolean;
}

export function help(): void {
  console.log(`
Manage local/private memory adapter interfaces under explicit trust policy

Usage:
  bun scripts/commands/memory-adapter.ts [validate] --source <dir> --config <file> [options]
  bun scripts/commands/memory-adapter.ts read --source <dir> --config <file> [options]
  bun scripts/commands/memory-adapter.ts write --source <dir> --config <file> --id <id> --memory <text> --source-entry <text> [options]

Commands:
  validate             Validate the memory adapter config (default)
  read                 Read memory records from a JSONL adapter
  write                Append a memory record to a JSONL adapter

Options:
  --source <dir>       Project/source root
  --config <file>      Memory adapter JSON config
  --id <id>            Record id (write)
  --memory <text>      Record memory text (write)
  --source-entry <text> Record provenance (write)
  --json               Emit machine-readable output
  --dry-run            Print what would be written without writing (write)
  --strict             Treat warnings as blocking
  --help               Show help
`);
}

export function parseArgs(argv: string[] = process.argv): MemoryAdapterCliArgs {
  const args: MemoryAdapterCliArgs = { json: false, strict: false, dryRun: false, help: false };
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
    if (token === "--id") {
      args.id = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--memory") {
      args.memory = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--source-entry") {
      args.sourceEntry = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "validate" || token === "read" || token === "write") {
      args.command = token;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (args.source) args.source = path.resolve(process.cwd(), args.source);
  if (args.config) args.config = path.resolve(process.cwd(), args.config);
  return args;
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const input = normalizeMemoryAdapterArgs({
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.config === undefined ? {} : { config: args.config }),
    strict: args.strict,
  });

  if (args.command === "read") {
    const result = applyMemoryAdapterRead(input);
    console.log(renderMemoryAdapterReadResult(result, args.json ? "json" : "text"));
    if (result.status === "blocked") process.exitCode = 1;
    return;
  }

  if (args.command === "write") {
    if (!args.id) throw new Error("Missing --id");
    if (!args.memory) throw new Error("Missing --memory");
    if (!args.sourceEntry) throw new Error("Missing --source-entry");
    const entry = { id: args.id, memory: args.memory, source: args.sourceEntry };
    const result = applyMemoryAdapterWrite(input, entry, { dryRun: args.dryRun });
    console.log(renderMemoryAdapterWriteResult(result, args.json ? "json" : "text"));
    if (result.status === "blocked") process.exitCode = 1;
    return;
  }

  const result = runMemoryAdapterValidation(input);
  console.log(renderMemoryAdapterResult(result, args.json ? "json" : "text"));
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
