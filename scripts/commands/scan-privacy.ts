#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { fileExists } from "../lib/files.ts";
import { resolvePublicSurface } from "../modules/skillpool/public-surface.ts";
import {
  countBlockingPrivacyFindings,
  formatPrivacyFindings,
  scanPrivacy,
  type PrivacyFinding,
} from "../modules/skillpool/privacy-scan.ts";

interface ScanPrivacyArgs {
  source: string;
  surface?: string;
  allowlist?: string;
  policy?: string;
  json: boolean;
  strict: boolean;
  help?: boolean;
}

function help(): void {
  console.log(`
Scan source trees for privacy leakage and private workflow markers

Usage:
  bun scripts/commands/scan-privacy.ts --source <dir> [options]

Options:
  --source <dir>       Source root (default: current directory)
  --surface <name|json>  Restrict scan to a surface file. A bare name resolves
                       to artifact-surfaces/<name>.json
  --allowlist <json>   Controlled allowlist file for intentional fixture hits
  --policy <json>      Optional private marker policy; keep private policies out
                       of public artifact surfaces
  --strict             Treat WARN findings as blocking
  --json               Emit machine-readable findings
  --help               Show help
`);
}

function parseArgs(argv: string[]): ScanPrivacyArgs {
  const args: ScanPrivacyArgs = {
    source: process.cwd(),
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
    if (token === "--surface") {
      args.surface = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--allowlist") {
      args.allowlist = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--policy") {
      args.policy = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), args.source);
  if (args.allowlist) {
    args.allowlist = path.resolve(args.source, args.allowlist);
  }
  if (args.policy) {
    args.policy = path.resolve(args.source, args.policy);
  }
  return args;
}

function runPrivacyScan(args: ScanPrivacyArgs): {
  findings: PrivacyFinding[];
  scanned: string;
  surfacePath?: string;
  blockingFindingCount: number;
} {
  if (!fileExists(args.source) || !fs.statSync(args.source).isDirectory()) {
    throw new Error(`Privacy scan source not found or not a directory: ${args.source}`);
  }
  const surface = resolvePublicSurface(args.source, args.surface);
  const findings = scanPrivacy({
    rootDir: args.source,
    baseDir: args.source,
    includePaths: surface.includePaths,
    forbiddenPaths: surface.forbiddenInSourcePaths,
    allowedInForbiddenSourcePaths: surface.allowedInForbiddenSourcePaths,
    ...(surface.surfacePath ? { excludePaths: [surface.surfacePath] } : {}),
    ...(args.allowlist ? { allowlistPath: args.allowlist } : {}),
    ...(args.policy ? { policyPath: args.policy } : {}),
    strictAllowlist: args.strict,
  });
  return {
    findings,
    scanned: surface.scanned,
    ...(surface.surfacePath ? { surfacePath: path.relative(args.source, surface.surfacePath).split(path.sep).join("/") } : {}),
    blockingFindingCount: countBlockingPrivacyFindings(findings, args.strict),
  };
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const result = runPrivacyScan(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.findings.length) {
    console.log("STATUS: PASS");
    console.log("Findings: 0");
    console.log(`Scanned: ${result.scanned}`);
  } else {
    const warnOnly = result.blockingFindingCount === 0;
    console.log(warnOnly ? "STATUS: WARN" : "STATUS: BLOCKING");
    console.log(`Findings: ${result.findings.length}`);
    console.log(`Blocking findings: ${result.blockingFindingCount}`);
    console.log(`Scanned: ${result.scanned}`);
    console.log("\nFINDINGS:");
    console.log(formatPrivacyFindings(result.findings));
  }

  if (result.blockingFindingCount) {
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
  resolvePublicSurface as resolvePrivacySurface,
  runPrivacyScan,
};
