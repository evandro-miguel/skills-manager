#!/usr/bin/env bun
/**
 * Sync skills from a source directory into universal-skills/skills.
 */

import fs from "node:fs";
import path from "node:path";
import { parseCsv, requireOptionValue } from "../lib/args.ts";
import { runCommand } from "../lib/command.ts";
import { ensureDir, fileExists } from "../lib/files.ts";
import {
  copyLifecycleLedger,
  copySkillDirectory,
  listSkillDirs,
  removeExtraSkills,
} from "../lib/skill-dirs.ts";
import {
  assertNoSensitiveFindings,
  scanSensitiveFiles,
} from "../modules/skillpool/sensitive-scan.ts";

interface SyncSkillsArgs {
  from: string;
  to: string;
  skills: string[];
  noContractCheck: boolean;
  delete: boolean;
  dryRun: boolean;
  help?: boolean;
  [key: string]: unknown;
}

const UNIVERSAL_CONTRACT_SCRIPT = path.resolve(__dirname, "universal-contract.ts");

function help(): void {
  console.log(`
Sync skills into universal-skills repository

Usage:
  bun scripts/commands/sync-skills.ts [options]

Options:
  --from <dir>      Source skills directory (default: ./skills)
  --to <dir>        Destination directory (default: ./skills)
  --skills <csv>    Sync only this subset of skills
  --no-contract-check  Skip universal SKILL.md contract validation on source
  --delete          Remove destination skills that do not exist in source
  --dry-run         Print actions only
  --help            Show help

When the parent of --from has skill-lifecycle.json, it is copied to
<to>/.skill-lifecycle.json so installed agents can resolve removed skills.

Examples:
  bun scripts/commands/sync-skills.ts
  bun scripts/commands/sync-skills.ts --from ./skills --to ./skills --delete
  bun scripts/commands/sync-skills.ts --from ./skills --to ~/.codex/skills --skills agent-memory-obsidian-ops,mcp-skill --delete
  bun scripts/commands/sync-skills.ts --from ./skills --to ./skills --no-contract-check
`);
}

function parseArgs(argv: string[]): SyncSkillsArgs {
  const args: SyncSkillsArgs = {
    from: path.resolve(process.cwd(), "skills"),
    to: path.resolve(process.cwd(), "skills"),
    skills: [],
    noContractCheck: false,
    delete: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (token === "--delete") {
      args.delete = true;
      continue;
    }

    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (token === "--no-contract-check") {
      args.noContractCheck = true;
      continue;
    }

    if (token === "--from") {
      args.from = path.resolve(process.cwd(), requireOptionValue(argv, i, token));
      i += 1;
      continue;
    }
    if (token === "--to") {
      args.to = path.resolve(process.cwd(), requireOptionValue(argv, i, token));
      i += 1;
      continue;
    }
    if (token === "--skills") {
      args.skills = parseCsv(requireOptionValue(argv, i, token));
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function runContractCheck(skillsRoot: string): void {
  if (!fileExists(UNIVERSAL_CONTRACT_SCRIPT)) {
    throw new Error(`Universal contract script not found: ${UNIVERSAL_CONTRACT_SCRIPT}`);
  }

  const result = runCommand(["bun", UNIVERSAL_CONTRACT_SCRIPT, "--skills-root", skillsRoot], {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    allowFailure: true,
  });

  if (result.code !== 0) {
    throw new Error(
      `Universal contract validation failed for source: ${skillsRoot}. ` +
        "Run `bun scripts/commands/universal-contract.ts --skills-root <dir> --fix` and retry."
    );
  }
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  if (!fileExists(args.from) || !fs.statSync(args.from).isDirectory()) {
    throw new Error(`Source directory not found: ${args.from}`);
  }

  if (!args.noContractCheck) {
    console.log("-> Validating universal contract on source skills");
    runContractCheck(args.from);
  } else {
    console.log("-> Skipping universal contract check (--no-contract-check)");
  }

  if (!args.dryRun) {
    ensureDir(args.to);
  }

  const availableSkillDirs = listSkillDirs(args.from);
  const skillDirs = args.skills.length ? args.skills : availableSkillDirs;
  const missingSkills = skillDirs.filter((skillName) => !availableSkillDirs.includes(skillName));
  if (missingSkills.length) {
    throw new Error(`Requested skills not found in source: ${missingSkills.join(", ")}`);
  }

  for (const skillName of skillDirs) {
    assertNoSensitiveFindings(
      scanSensitiveFiles({
        rootDir: path.join(args.from, skillName),
        baseDir: args.from,
      }),
      `Skill '${skillName}'`
    );
  }

  let copied = 0;
  let skipped = 0;

  for (const skillName of skillDirs) {
    const srcSkill = path.join(args.from, skillName);
    const skillEntry = path.join(srcSkill, "SKILL.md");
    if (!fileExists(skillEntry)) {
      skipped += 1;
      console.log(`skip (missing SKILL.md): ${skillName}`);
      continue;
    }

    const destSkill = path.join(args.to, skillName);
    if (!args.dryRun) {
      fs.rmSync(destSkill, { recursive: true, force: true });
    }
    copySkillDirectory(srcSkill, destSkill, { dryRun: args.dryRun });
    copied += 1;
    console.log(`sync: ${skillName}`);
  }

  const removed = args.delete ? removeExtraSkills(skillDirs, args.to, args.dryRun) : [];
  const lifecycleDest = copyLifecycleLedger(args.from, args.to, args.dryRun);

  console.log(`\nDone.`);
  console.log(`- copied: ${copied}`);
  console.log(`- skipped: ${skipped}`);
  if (args.skills.length) {
    console.log(`- selected: ${skillDirs.length}`);
  }
  if (args.delete) {
    console.log(`- removed: ${removed.length}`);
  }
  if (lifecycleDest) {
    console.log(`- lifecycle: ${lifecycleDest}`);
  }
  console.log(`- source: ${args.from}`);
  console.log(`- target: ${args.to}`);
  if (args.dryRun) {
    console.log("- mode: dry-run");
  }
}

if (require.main === module) {
  main();
}

export {
  main,
  parseArgs,
  runContractCheck,
};
