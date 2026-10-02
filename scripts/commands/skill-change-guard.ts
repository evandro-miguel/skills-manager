#!/usr/bin/env bun

import path from "node:path";

import { childFailureMessage } from "../lib/redact.ts";

interface GuardOptions {
  staged: boolean;
  fix: boolean;
  restage: boolean;
  base: string | null;
  head: string;
}

interface RunOptions {
  cwd?: string;
  stdio?: "inherit";
  allowFailure?: boolean;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

type Runner = (command: string, args: string[], opts?: RunOptions) => RunResult;

function renderScriptPath(argv: string[], fallback: string): string {
  const raw = argv[1];
  if (!raw) {
    return fallback;
  }
  const normalized = String(raw).replaceAll("\\", "/");
  const marker = "/scripts/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex !== -1) {
    return normalized.slice(markerIndex + 1);
  }
  return path.basename(normalized);
}

function parseArgs(argv: string[]): GuardOptions {
  const options: GuardOptions = {
    staged: false,
    fix: false,
    restage: false,
    base: null,
    head: "HEAD",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--staged") {
      options.staged = true;
      continue;
    }
    if (token === "--fix") {
      options.fix = true;
      continue;
    }
    if (token === "--restage") {
      options.restage = true;
      continue;
    }
    if (token === "--base") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --base");
      }
      options.base = value;
      i += 1;
      continue;
    }
    if (token === "--head") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --head");
      }
      options.head = value;
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return options;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function printHelp(scriptPath: string): void {
  console.log(`
Skill change guard

Usage:
  bun ${scriptPath} --staged [--fix] [--restage]
  bun ${scriptPath} --base <git-ref> [--head <git-ref>]

Behavior:
  - detects changed files under skills/
  - auto-fixes changed markdown files when --fix is set
  - lints changed markdown files with strict markdownlint
  - validates local links across skills/
  - runs universal contract + skillpool validation
  - runs check-skill.js for each changed skill directory
`);
}

function run(command: string, args: string[], opts: RunOptions = {}): RunResult {
  const proc = Bun.spawnSync([command, ...args], {
    cwd: opts.cwd || process.cwd(),
    stdout: opts.stdio === "inherit" ? "inherit" : "pipe",
    stderr: opts.stdio === "inherit" ? "inherit" : "pipe",
  });

  const stdout = proc.stdout ? Buffer.from(proc.stdout).toString("utf8") : "";
  const stderr = proc.stderr ? Buffer.from(proc.stderr).toString("utf8") : "";

  if (proc.exitCode !== 0 && !opts.allowFailure) {
    // Captured child output can carry secrets, so failures surface only the
    // redacted argv header and exit code; inherited streams still stream live
    // from the child itself.
    throw new Error(childFailureMessage([command, ...args], proc.exitCode));
  }

  return { status: proc.exitCode, stdout, stderr };
}

function getChangedFiles(options: GuardOptions, runFn: Runner = run): string[] {
  if (options.staged) {
    const result = runFn("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
      allowFailure: true,
    });
    return (result.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  if (!options.base) {
    throw new Error("Use --staged or provide --base <git-ref>.");
  }

  const baseRef = options.base;
  const headRef = options.head || "HEAD";
  const result = runFn(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...${headRef}`],
    { allowFailure: true }
  );

  if (result.status === 0) {
    return (result.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const fallback = runFn(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", baseRef, headRef],
    { allowFailure: true }
  );
  return (fallback.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function getSkillDir(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts[0] !== "skills" || parts.length < 3) {
    return null;
  }
  return path.posix.join(parts[0]!, parts[1]!);
}

function main(argv: string[] = process.argv, runFn: Runner = run): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp(renderScriptPath(argv, "scripts/commands/skill-change-guard.ts"));
    return;
  }

  const options = parseArgs(argv);
  const changedFiles = getChangedFiles(options, runFn);
  const skillFiles = changedFiles.filter((file) => file.startsWith("skills/"));

  if (skillFiles.length === 0) {
    console.log("No changed files under skills/. Skipping skill guard.");
    return;
  }

  let markdownFiles = skillFiles.filter((file) => file.endsWith(".md"));
  const skillDirs = unique(skillFiles.map(getSkillDir).filter((value): value is string => Boolean(value))).sort();
  const rootSkillFiles = skillDirs.map((skillDir) => path.posix.join(skillDir, "SKILL.md"));

  console.log(`Changed skill files: ${skillFiles.length}`);
  console.log(`Changed skill directories: ${skillDirs.length}`);

  if (options.fix && options.staged) {
    runFn(
      "bun",
      ["scripts/commands/skill-metadata.ts", "sync", "--staged", "--write", "--skills-root", "skills"],
      {
        stdio: "inherit",
      }
    );
    markdownFiles = unique([...markdownFiles, ...rootSkillFiles]);
  }

  if (options.fix && markdownFiles.length > 0) {
    runFn("bun", ["scripts/commands/markdown-strict-batch-fix.ts", ...markdownFiles], {
      stdio: "inherit",
    });
    runFn("bun", ["x", "markdownlint-cli2", "--fix", ...markdownFiles], {
      stdio: "inherit",
    });
    if (options.restage) {
      runFn("git", ["add", "--", ...markdownFiles], { stdio: "inherit" });
    }
  }

  if (markdownFiles.length > 0) {
    runFn("bun", ["x", "markdownlint-cli2", ...markdownFiles], { stdio: "inherit" });
  }

  for (const skillDir of skillDirs) {
    runFn("bun", ["skills/writing-skills/scripts/check-skill.js", skillDir], {
      stdio: "inherit",
    });
  }

  runFn("bun", ["scripts/commands/markdown-link-guard.ts", "--no-wikilinks", "skills"], {
    stdio: "inherit",
  });
  runFn("bun", ["scripts/commands/universal-contract.ts", "--skills-root", "skills"], {
    stdio: "inherit",
  });
  runFn("bun", ["scripts/commands/skillpool.ts", "validate", "--source", "."], {
    stdio: "inherit",
  });

  console.log("Skill change guard passed.");
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
  getChangedFiles,
  getSkillDir,
  main,
  parseArgs,
  run,
  unique,
};
