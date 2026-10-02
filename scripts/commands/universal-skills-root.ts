#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");

function candidateRoots(): string[] {
  const values = [
    process.env.UNIVERSAL_SKILLS_ROOT || null,
    REPO_ROOT,
    path.join(os.homedir(), "apps", "universal-skills"),
    path.join(REPO_ROOT, "apps", "universal-skills"),
  ];

  return [...new Set(values.filter(Boolean).map((value) => path.resolve(value as string)))];
}

function isUniversalSkillsRoot(rootDir: string): boolean {
  return (
    fs.existsSync(path.join(rootDir, "skills")) &&
    fs.existsSync(path.join(rootDir, "scripts")) &&
    fs.existsSync(path.join(rootDir, "README.md"))
  );
}

function resolveUniversalSkillsRoot(): string {
  const candidates = candidateRoots();
  for (const candidate of candidates) {
    if (isUniversalSkillsRoot(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve universal-skills root. Tried: ${candidates.join(", ")}`);
}

function resolveUniversalSkillsPath(...segments: string[]): string {
  return path.join(resolveUniversalSkillsRoot(), ...segments);
}

function printHelp(): void {
  console.log(`
Resolve the universal-skills root used by automation

Usage:
  bun scripts/commands/universal-skills-root.ts [option]

Options:
  --root              Print resolved universal-skills root
  --skills-dir        Print resolved skills directory
  --tests-dir         Print resolved tests directory
  --script <name>     Print resolved path under scripts/
  --path <relpath>    Print resolved path under root
  --help              Show this help
`);
}

function main(argv: string[] = process.argv): void {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (!args.length || args.includes("--root")) {
    console.log(resolveUniversalSkillsRoot());
    return;
  }

  if (args.includes("--skills-dir")) {
    console.log(resolveUniversalSkillsPath("skills"));
    return;
  }

  if (args.includes("--tests-dir")) {
    console.log(resolveUniversalSkillsPath("tests"));
    return;
  }

  const scriptIndex = args.indexOf("--script");
  if (scriptIndex !== -1) {
    const value = args[scriptIndex + 1];
    if (!value) {
      throw new Error("Missing value for --script");
    }
    console.log(resolveUniversalSkillsPath("scripts", value));
    return;
  }

  const pathIndex = args.indexOf("--path");
  if (pathIndex !== -1) {
    const value = args[pathIndex + 1];
    if (!value) {
      throw new Error("Missing value for --path");
    }
    console.log(resolveUniversalSkillsPath(value));
    return;
  }

  throw new Error(`Unknown arguments: ${args.join(" ")}`);
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
  REPO_ROOT,
  candidateRoots,
  isUniversalSkillsRoot,
  main,
  resolveUniversalSkillsRoot,
  resolveUniversalSkillsPath,
};
