#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  formatSensitiveFindings,
  scanSensitiveFiles,
  type SensitiveFinding,
} from "../modules/skillpool/sensitive-scan.ts";
import { resolveSourceLayout } from "../modules/skillpool/source.ts";

interface ScanSensitiveArgs {
  source: string;
  json: boolean;
  help?: boolean;
}

function help(): void {
  console.log(`
Scan skill payloads for sensitive files and secret-shaped content

Usage:
  bun scripts/commands/scan-sensitive.ts --source <dir> [options]

Options:
  --source <dir>   Skill source root (default: current directory)
  --json           Emit machine-readable findings
  --help           Show help
`);
}

function parseArgs(argv: string[]): ScanSensitiveArgs {
  const args: ScanSensitiveArgs = {
    source: process.cwd(),
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
    if (token === "--source") {
      args.source = requireOptionValue(argv, i, token);
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

function runSensitiveScan(args: ScanSensitiveArgs): { findings: SensitiveFinding[]; scanned: string } {
  const layout = resolveSourceLayout(args.source, { requireSkills: true });
  const findings = scanSensitiveFiles({
    rootDir: layout.skillsDir,
    baseDir: args.source,
  });
  return {
    findings,
    scanned: path.relative(args.source, layout.skillsDir).split(path.sep).join("/") || "skills",
  };
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const result = runSensitiveScan(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.findings.length) {
    console.log("STATUS: PASS");
    console.log("Findings: 0");
    console.log(`Scanned: ${result.scanned}`);
  } else {
    console.log("STATUS: BLOCKING");
    console.log(`Findings: ${result.findings.length}`);
    console.log("\nFINDINGS:");
    console.log(formatSensitiveFindings(result.findings));
  }

  if (result.findings.length) {
    process.exitCode = 1;
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
  runSensitiveScan,
};
