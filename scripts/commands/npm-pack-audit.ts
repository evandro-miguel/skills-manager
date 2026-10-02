#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { runCommand } from "../lib/command.ts";
import { childFailureMessage } from "../lib/redact.ts";
import { collectPublicSurfacePacklist } from "../modules/skillpool/public-surface.ts";

interface NpmPackAuditArgs {
  source: string;
  surface: string;
  json: boolean;
  help?: boolean;
}

type NpmPackEntry = { files?: Array<{ path?: string }> };

function help(): void {
  console.log(`
Compare npm pack output with a public artifact surface packlist

Usage:
  bun scripts/commands/npm-pack-audit.ts --source <dir> [options]

Options:
  --source <dir>         Source root (default: current directory)
  --surface <name|json>  Surface file to compare (default: engine-public)
  --json                 Emit machine-readable audit result
  --help                 Show help
`);
}

function parseArgs(argv: string[]): NpmPackAuditArgs {
  const args: NpmPackAuditArgs = { source: process.cwd(), surface: "engine-public", json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") { args.help = true; continue; }
    if (token === "--json") { args.json = true; continue; }
    if (token === "--source") { args.source = requireOptionValue(argv, i, token); i += 1; continue; }
    if (token === "--surface") { args.surface = requireOptionValue(argv, i, token); i += 1; continue; }
    if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    throw new Error(`Unknown argument: ${token}`);
  }
  args.source = path.resolve(process.cwd(), args.source);
  return args;
}

function parseNpmPackFiles(stdout: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("npm pack --dry-run --json did not emit valid JSON"); }
  let entry: NpmPackEntry;
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
      throw new Error("npm pack --dry-run --json emitted an unexpected shape");
    }
    entry = parsed[0] as NpmPackEntry;
  } else if (parsed && typeof parsed === "object") {
    const entries = Object.values(parsed as Record<string, unknown>);
    if (entries.length !== 1 || !entries[0] || typeof entries[0] !== "object") {
      throw new Error("npm pack --dry-run --json emitted an unexpected shape");
    }
    entry = entries[0] as NpmPackEntry;
  } else {
    throw new Error("npm pack --dry-run --json emitted an unexpected shape");
  }
  const files = entry.files;
  if (!Array.isArray(files)) throw new Error("npm pack JSON did not include a files array");
  return files.map((file) => file.path).filter((value): value is string => typeof value === "string").sort();
}

type NpmPackAuditDeps = {
  runCommand?: typeof runCommand;
};

function runNpmPackAudit(args: NpmPackAuditArgs, deps: NpmPackAuditDeps = {}) {
  const runCommandFn = deps.runCommand || runCommand;
  const packlist = collectPublicSurfacePacklist(args.source, args.surface);
  const expectedFiles = packlist.files.map((file) => file.path).sort();
  const npmArgs = ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"];
  const npmResult = runCommandFn(npmArgs, {
    cwd: args.source,
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
  });
  if (npmResult.code !== 0) {
    // Captured child output can carry secrets; report stage + exit code only.
    throw new Error(childFailureMessage(npmArgs, npmResult.code));
  }
  const npmFiles = parseNpmPackFiles(npmResult.stdout);
  const expected = new Set(expectedFiles);
  const actual = new Set(npmFiles);
  const missingFromNpm = expectedFiles.filter((file) => !actual.has(file));
  const extraInNpm = npmFiles.filter((file) => !expected.has(file));
  return {
    status: missingFromNpm.length || extraInNpm.length ? "BLOCKING" : "PASS",
    surface: packlist.surface,
    packlistFileCount: expectedFiles.length,
    npmFileCount: npmFiles.length,
    missingFromNpm,
    extraInNpm,
  };
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) { help(); return; }
  const result = runNpmPackAudit(args);
  if (args.json) { console.log(JSON.stringify(result, null, 2)); }
  else {
    console.log(`STATUS: ${result.status}`);
    console.log(`Surface: ${result.surface}`);
    console.log(`Packlist files: ${result.packlistFileCount}`);
    console.log(`npm pack files: ${result.npmFileCount}`);
    if (result.missingFromNpm.length) {
      console.log("\nMISSING FROM NPM:");
      for (const file of result.missingFromNpm) console.log(`- ${file}`);
    }
    if (result.extraInNpm.length) {
      console.log("\nEXTRA IN NPM:");
      for (const file of result.extraInNpm) console.log(`- ${file}`);
    }
  }
  if (result.status !== "PASS") process.exitCode = 1;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}

export { help, main, parseArgs, parseNpmPackFiles, runNpmPackAudit };
