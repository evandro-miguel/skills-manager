#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { resolvePublicSurface } from "../modules/skillpool/public-surface.ts";
import {
  countBlockingPrivacyFindings,
  formatPrivacyFindings,
} from "../modules/skillpool/privacy-scan.ts";
import {
  formatSensitiveFindings,
  scanSensitiveFiles,
} from "../modules/skillpool/sensitive-scan.ts";
import {
  runPrivacyScan,
} from "./scan-privacy.ts";

interface PublicAuditArgs {
  source: string;
  surface: string;
  allowlist?: string;
  policy?: string;
  json: boolean;
  strict: boolean;
  help?: boolean;
}

function help(): void {
  console.log(`
Run public-release safety checks for an artifact surface

Usage:
  bun scripts/commands/public-audit.ts --source <dir> [options]

Options:
  --source <dir>       Source root (default: current directory)
  --surface <name|json>  Surface file to audit (default: engine-public)
  --allowlist <json>   Controlled privacy allowlist for intentional fixture hits
  --policy <json>      Optional private marker policy; keep private policies out
                       of public artifact surfaces
  --strict             Treat privacy WARN findings as blocking
  --json               Emit machine-readable findings
  --help               Show help
`);
}

function parseArgs(argv: string[]): PublicAuditArgs {
  const args: PublicAuditArgs = {
    source: process.cwd(),
    surface: "engine-public",
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

function runPublicAudit(args: PublicAuditArgs) {
  const surface = resolvePublicSurface(args.source, args.surface);
  const privacy = runPrivacyScan({
    source: args.source,
    surface: args.surface,
    json: false,
    strict: args.strict,
    ...(args.allowlist ? { allowlist: args.allowlist } : {}),
    ...(args.policy ? { policy: args.policy } : {}),
  });
  const sensitiveFindings = scanSensitiveFiles({
    rootDir: args.source,
    baseDir: args.source,
    includePaths: surface.includePaths,
  });
  const privacyBlockingFindingCount = countBlockingPrivacyFindings(privacy.findings, args.strict);
  const sensitiveBlockingFindingCount = sensitiveFindings.length;
  return {
    surface: privacy.scanned,
    ...(privacy.surfacePath ? { surfacePath: privacy.surfacePath } : {}),
    privacy: {
      findings: privacy.findings,
      blockingFindingCount: privacyBlockingFindingCount,
    },
    sensitive: {
      findings: sensitiveFindings,
      blockingFindingCount: sensitiveBlockingFindingCount,
    },
    blockingFindingCount: privacyBlockingFindingCount + sensitiveBlockingFindingCount,
  };
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const result = runPublicAudit(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.blockingFindingCount) {
    console.log("STATUS: PASS");
    console.log(`Surface: ${result.surface}`);
    console.log("Privacy findings: 0");
    console.log("Sensitive findings: 0");
  } else {
    console.log("STATUS: BLOCKING");
    console.log(`Surface: ${result.surface}`);
    console.log(`Privacy findings: ${result.privacy.findings.length}`);
    console.log(`Privacy blocking findings: ${result.privacy.blockingFindingCount}`);
    console.log(`Sensitive findings: ${result.sensitive.findings.length}`);
    console.log(`Blocking findings: ${result.blockingFindingCount}`);
    if (result.privacy.findings.length) {
      console.log("\nPRIVACY FINDINGS:");
      console.log(formatPrivacyFindings(result.privacy.findings));
    }
    if (result.sensitive.findings.length) {
      console.log("\nSENSITIVE FINDINGS:");
      console.log(formatSensitiveFindings(result.sensitive.findings));
    }
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
  runPublicAudit,
};
