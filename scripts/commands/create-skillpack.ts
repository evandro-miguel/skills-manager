#!/usr/bin/env bun

import path from "node:path";
import { parseCsv, requireOptionValue } from "../lib/args.ts";
import { createSkillpack } from "../modules/skillpool/skillpack.ts";

interface CreateSkillpackArgs {
  target: string;
  name?: string;
  visibility: "public" | "private";
  providers: string[];
  profile: string;
  dryRun: boolean;
  force: boolean;
  yesIUnderstandOverwrite: boolean;
  json: boolean;
  help?: boolean;
}

function help(): void {
  console.log(`
Create a sanitized Skill-Sys skillpack scaffold

Usage:
  bun scripts/commands/create-skillpack.ts <target> [options]

Options:
  --target <dir>           Skillpack root to create
  --name <name>            Package-style skillpack name
  --visibility public|private  Visibility marker (default: public)
  --providers <csv>        Provider ids (default: codex,opencode)
  --profile <name>         Profile name (default: default)
  --force                  Allow writing into an existing non-empty target
  --yes-i-understand-overwrite  Required with --force to acknowledge overwrite risk
  --dry-run                Print planned files without writing
  --json                   Emit machine-readable plan
  --help                   Show help
`);
}

function normalizeVisibility(value: string): "public" | "private" {
  if (value === "public" || value === "private") {
    return value;
  }
  throw new Error(`Invalid visibility '${value}'. Expected public or private.`);
}

function parseArgs(argv: string[]): CreateSkillpackArgs {
  const args: CreateSkillpackArgs = {
    target: "",
    visibility: "public",
    providers: ["codex", "opencode"],
    profile: "default",
    dryRun: false,
    force: false,
    yesIUnderstandOverwrite: false,
    json: false,
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
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "--force") {
      args.force = true;
      continue;
    }
    if (token === "--yes-i-understand-overwrite") {
      args.yesIUnderstandOverwrite = true;
      continue;
    }
    if (token === "--target") {
      args.target = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--name") {
      args.name = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--visibility") {
      args.visibility = normalizeVisibility(requireOptionValue(argv, i, token));
      i += 1;
      continue;
    }
    if (token === "--providers") {
      args.providers = parseCsv(requireOptionValue(argv, i, token));
      i += 1;
      continue;
    }
    if (token === "--profile") {
      args.profile = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    if (args.target) {
      throw new Error(`Unknown argument: ${token}`);
    }
    args.target = token;
  }
  if (args.help) {
    return args;
  }
  if (!args.target) {
    throw new Error("Usage: create-skillpack <target> [--name <name>]");
  }
  if (args.force && !args.yesIUnderstandOverwrite) {
    throw new Error("--force requires --yes-i-understand-overwrite");
  }
  args.target = path.resolve(process.cwd(), args.target);
  return args;
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const plan = createSkillpack({
    targetDir: args.target,
    ...(args.name ? { name: args.name } : {}),
    visibility: args.visibility,
    providers: args.providers,
    profile: args.profile,
    dryRun: args.dryRun,
    force: args.force,
  });
  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(args.dryRun ? "STATUS: DRY-RUN" : "STATUS: CREATED");
  console.log(`Target: ${plan.targetDir}`);
  console.log("Files:");
  for (const file of plan.files) {
    console.log(`- ${file}`);
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
