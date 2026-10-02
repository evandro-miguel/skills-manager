#!/usr/bin/env bun

import path from "node:path";
import { buildProjections } from "../modules/skillpool/projections.ts";
import { parseProviderListForSource } from "../modules/skillpool/providers.ts";

interface BuildProjectionArgs {
  source: string;
  providers: string;
  outDir: string;
  projectionStoreDir?: string;
  userRoot?: string;
  includeUser: boolean;
  clean: boolean;
  json: boolean;
  help: boolean;
}

function help(): void {
  console.log(`
Build provider projections

Usage:
  bun scripts/commands/build-projections.ts [options]

Options:
  --source <dir>       Source root (default: .)
  --providers <csv>    Providers to build, or all (default: all)
  --out-dir <dir>      Projection output directory (default: dist)
  --projection-store-dir <dir>
                       Optional content-addressable projection store (disabled unless specified)
  --include-user       Include user-local skills from --user-root/SKILL_SYS_USER_ROOT/~/.skill-sys
  --user-root <dir>    User-local Skill-Sys root containing skills/
  --clean              Remove output directory before building (only missing, empty, or Skill-Sys-marked directories)
  --json               Emit machine-readable output
  --help               Show help
`);
}

function parseArgs(argv: string[] = process.argv): BuildProjectionArgs {
  const args: BuildProjectionArgs = {
    source: ".",
    providers: "all",
    outDir: "dist",
    includeUser: false,
    clean: false,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--clean") {
      args.clean = true;
      continue;
    }
    if (token === "--include-user") {
      args.includeUser = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (
      token === "--source" ||
      token === "--providers" ||
      token === "--out-dir" ||
      token === "--projection-store-dir" ||
      token === "--user-root"
    ) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      if (token === "--source") args.source = value;
      if (token === "--providers") args.providers = value;
      if (token === "--out-dir") args.outDir = value;
      if (token === "--projection-store-dir") args.projectionStoreDir = value;
      if (token === "--user-root") args.userRoot = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), args.source);
  args.outDir = path.resolve(process.cwd(), args.outDir);
  if (args.projectionStoreDir !== undefined) {
    args.projectionStoreDir = path.resolve(process.cwd(), args.projectionStoreDir);
  }
  if (args.userRoot !== undefined) {
    args.userRoot = path.resolve(process.cwd(), args.userRoot);
  }
  return args;
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const buildOptions: Parameters<typeof buildProjections>[0] = {
    sourceRoot: args.source,
    providers: parseProviderListForSource(args.providers, args.source),
    outDir: args.outDir,
    clean: args.clean,
    includeUser: args.includeUser,
  };
  if (args.projectionStoreDir !== undefined) {
    buildOptions.projectionStoreDir = args.projectionStoreDir;
  }
  if (args.userRoot !== undefined) {
    buildOptions.userRoot = args.userRoot;
  }
  const result = buildProjections(buildOptions);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Built ${result.projections.length} projection(s) in ${result.outDir}`);
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
