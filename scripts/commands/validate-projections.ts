#!/usr/bin/env bun

import path from "node:path";
import { validateProjections } from "../modules/skillpool/projections.ts";
import { parseProviderListForSource } from "../modules/skillpool/providers.ts";

interface ValidateProjectionArgs {
  source: string;
  providers: string;
  outDir: string;
  userRoot?: string;
  includeUser: boolean;
  json: boolean;
  help: boolean;
}

function help(): void {
  console.log(`
Validate provider projections

Usage:
  bun scripts/commands/validate-projections.ts [options]

Options:
  --source <dir>       Source root (default: .)
  --providers <csv>    Providers to validate, or all (default: all)
  --out-dir <dir>      Projection output directory (default: dist)
  --include-user       Include user-local skills from --user-root/SKILL_SYS_USER_ROOT/~/.skill-sys
  --user-root <dir>    User-local Skill-Sys root containing skills/
  --json               Emit machine-readable output
  --help               Show help
`);
}

function parseArgs(argv: string[] = process.argv): ValidateProjectionArgs {
  const args: ValidateProjectionArgs = {
    source: ".",
    providers: "all",
    outDir: "dist",
    includeUser: false,
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
    if (token === "--include-user") {
      args.includeUser = true;
      continue;
    }
    if (token === "--source" || token === "--providers" || token === "--out-dir" || token === "--user-root") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      if (token === "--source") args.source = value;
      if (token === "--providers") args.providers = value;
      if (token === "--out-dir") args.outDir = value;
      if (token === "--user-root") args.userRoot = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), args.source);
  args.outDir = path.resolve(process.cwd(), args.outDir);
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

  const validateOptions: Parameters<typeof validateProjections>[0] = {
    sourceRoot: args.source,
    providers: parseProviderListForSource(args.providers, args.source),
    outDir: args.outDir,
    includeUser: args.includeUser,
  };
  if (args.userRoot !== undefined) {
    validateOptions.userRoot = args.userRoot;
  }
  const findings = validateProjections(validateOptions);

  if (args.json) {
    console.log(JSON.stringify({ findings }, null, 2));
  }

  if (!findings.length) {
    if (!args.json) {
      console.log("STATUS: PASS");
      console.log("Findings: 0");
    }
    return;
  }

  if (!args.json) {
    console.log("STATUS: BLOCKING");
    console.log(`Findings: ${findings.length}`);
    for (const finding of findings) {
      console.log(`- [${finding.level} ${finding.code}] ${finding.message}`);
    }
  }
  process.exitCode = 1;
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
