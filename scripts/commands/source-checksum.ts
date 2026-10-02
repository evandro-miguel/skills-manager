#!/usr/bin/env bun
/**
 * Compute deterministic checksum for universal-skills source package.
 */

import path from "node:path";
import {
  computeSourceChecksum,
  resolvePoolRoot,
  resolveSourceLayout,
} from "../modules/skillpool/source.ts";

interface ChecksumArgs {
  source: string;
  json: boolean;
  help: boolean;
}

interface SourceLayout {
  kind: "flat" | "monorepo-root" | "nested-app" | "skillpack";
  sourceRoot: string;
  poolRoot: string;
  skillsDir: string;
  adaptersDir: string;
  profilesDir: string;
}

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

function help(scriptPath: string): void {
  console.log(`
Compute source checksum

Usage:
  bun ${scriptPath} [options]

Options:
  --source <dir>   Source root (default: .)
  --json           Output JSON
  --help           Show help
`);
}

function parseArgs(argv: string[]): ChecksumArgs {
  const args: ChecksumArgs = {
    source: ".",
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
    if (token.startsWith("--")) {
      if (token === "--source") {
        const value = argv[i + 1];
        if (!value || value.startsWith("--")) {
          throw new Error(`Missing value for ${token}`);
        }
        args.source = value;
        i += 1;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), String(args.source));
  return args;
}

function resolveLayout(sourceRoot: string): SourceLayout {
  const resolved = resolveSourceLayout(sourceRoot, { requireSkills: false });
  return {
    ...resolved,
    sourceRoot,
    poolRoot: resolvePoolRoot(sourceRoot, resolved),
  };
}

function computeChecksum(layout: SourceLayout): string {
  return computeSourceChecksum(layout.sourceRoot, layout);
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  const scriptPath = renderScriptPath(argv, "scripts/commands/source-checksum.ts");
  if (args.help) {
    help(scriptPath);
    return;
  }

  const layout = resolveLayout(args.source);
  const checksum = computeChecksum(layout);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          source: args.source,
          poolRoot: layout.poolRoot,
          checksum,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(checksum);
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
  computeChecksum,
  main,
  parseArgs,
  resolveLayout,
};
