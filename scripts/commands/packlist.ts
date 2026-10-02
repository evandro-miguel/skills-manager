#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { collectPublicSurfacePacklist } from "../modules/skillpool/public-surface.ts";

interface PacklistArgs {
  source: string;
  surface: string;
  json: boolean;
  hashes: boolean;
  help?: boolean;
}

function help(): void {
  console.log(`
List files included by a public artifact surface

Usage:
  bun scripts/commands/packlist.ts --source <dir> [options]

Options:
  --source <dir>       Source root (default: current directory)
  --surface <name|json>  Surface file to list (default: engine-public)
  --hashes             Include bytes and sha256 in text output
  --json               Emit machine-readable packlist with digest
  --help               Show help
`);
}

function parseArgs(argv: string[]): PacklistArgs {
  const args: PacklistArgs = {
    source: process.cwd(),
    surface: "engine-public",
    json: false,
    hashes: false,
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
    if (token === "--hashes") {
      args.hashes = true;
      continue;
    }
    if (token === "--source") {
      args.source = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--surface") {
      args.surface = requireOptionValue(argv, i, token);
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
  const packlist = collectPublicSurfacePacklist(args.source, args.surface);
  if (args.json) {
    console.log(JSON.stringify(packlist, null, 2));
    return;
  }

  console.log(`Surface: ${packlist.surface}`);
  console.log(`Files: ${packlist.fileCount}`);
  console.log(`Bytes: ${packlist.totalBytes}`);
  console.log(`Digest: ${packlist.digest}`);
  console.log("");
  for (const file of packlist.files) {
    if (args.hashes) {
      console.log(`${file.path}\t${file.bytes}\tsha256:${file.sha256}`);
    } else {
      console.log(file.path);
    }
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
