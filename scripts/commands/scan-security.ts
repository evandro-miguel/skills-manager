#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { fileExists } from "../lib/files.ts";
import {
  countBlockingSecurityFindings,
  formatSecurityFindings,
  scanSecurity,
  type SecurityFinding,
} from "../modules/skillpool/security-scan-v2.ts";

interface ScanSecurityArgs {
  source: string | null;
  json: boolean;
  strict: boolean;
  help?: boolean;
}

function help(): void {
  console.log(`
Static offline security scan for skill sources (security-scan-v2)

Performs a read-only walk over a skill source root and reports security-relevant
markers: network/exfiltration, credential scraping, hidden setup scripts,
prompt-injection phrases, and skill.meta.json risk inconsistencies. It never
executes, imports, or evaluates skill code.

Usage:
  bun scripts/commands/scan-security.ts --source <dir> [options]
  skill-sys scan-security --source <dir> [options]

Options:
  --source <dir>   Skill source root (required; no implicit default)
  --strict         Treat WARN-level findings as blocking (non-zero exit)
  --json           Emit machine-readable findings
  --help           Show help
`);
}

function parseArgs(argv: string[]): ScanSecurityArgs {
  const args: ScanSecurityArgs = {
    source: null,
    json: false,
    strict: false,
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
    if (token === "--strict") {
      args.strict = true;
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

  return args;
}

interface ResolvedSource {
  skillsDir: string;
  baseDir: string;
  scanned: string;
}

function resolveSkillsRoot(rawSource: string): ResolvedSource {
  const baseDir = path.resolve(process.cwd(), rawSource);
  if (!fileExists(baseDir)) {
    throw new Error(`Security scan source not found: ${rawSource}`);
  }
  const stat = fs.lstatSync(baseDir);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to scan symlinked source: ${rawSource}`);
  }
  if (!fs.statSync(baseDir).isDirectory()) {
    throw new Error(`Security scan source is not a directory: ${rawSource}`);
  }
  const skillsCandidate = path.join(baseDir, "skills");
  if (fileExists(skillsCandidate) && fs.statSync(skillsCandidate).isDirectory()) {
    return {
      skillsDir: skillsCandidate,
      baseDir,
      scanned: "skills",
    };
  }
  return { skillsDir: baseDir, baseDir, scanned: "." };
}

function runSecurityScan(args: ScanSecurityArgs): {
  findings: SecurityFinding[];
  scanned: string;
  blocking: number;
} {
  const resolved = resolveSkillsRoot(args.source!);
  const findings = scanSecurity({ rootDir: resolved.skillsDir, baseDir: resolved.baseDir });
  return {
    findings,
    scanned: resolved.scanned,
    blocking: countBlockingSecurityFindings(findings, args.strict),
  };
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  if (!args.source) {
    throw new Error("Usage: scan-security --source <dir> [--strict] [--json] [--help]");
  }

  const result = runSecurityScan(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.findings.length) {
    console.log("STATUS: PASS");
    console.log("Findings: 0");
    console.log(`Scanned: ${result.scanned}`);
  } else {
    console.log(result.blocking ? "STATUS: BLOCKING" : "STATUS: WARN");
    console.log(`Findings: ${result.findings.length}`);
    console.log(`Blocking findings: ${result.blocking}`);
    console.log(`Scanned: ${result.scanned}`);
    console.log("");
    console.log("FINDINGS:");
    console.log(formatSecurityFindings(result.findings));
  }

  if (result.blocking) {
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

export { help, main, parseArgs, runSecurityScan, resolveSkillsRoot };
