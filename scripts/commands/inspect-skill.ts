#!/usr/bin/env bun
/**
 * inspect-skill: resolve a skills.sh catalog reference to its canonical
 * source, offline only.
 *
 * Parses the reference and reports the canonical Git hint plus a
 * ready-to-paste `skill-sys.sources.json` manifest hint. `--online` evidence
 * lookup is disabled in this release and fails closed without network access.
 */

import { CatalogIntegrationError } from "../modules/integrations/skills-sh/errors.ts";
import {
  parseSkillsShReference,
} from "../modules/integrations/skills-sh/reference-parser.ts";
import {
  skillsShReferenceToManifestHint,
} from "../modules/integrations/skills-sh/provider.ts";

interface InspectSkillArgs {
  reference: string | null;
  json: boolean;
  help: boolean;
}

export type InspectSkillReport = Readonly<{
  checkedAt: string;
  reference: string;
  owner: string;
  repo: string;
  skillPathHint?: readonly string[];
  sourceType: "github";
  canonicalSourceHint: string;
  installable: boolean;
  manifestHint: Readonly<{ source: string; skillPathHint?: readonly string[] }>;
}>;

export type InspectSkillOptions = Readonly<{
  reference: string;
  now?: () => Date;
}>;

const HELP_TEXT = `Inspect a catalog reference (read-only).

Usage:
  bun scripts/commands/inspect-skill.ts --reference <ref> [options]

Options:
  --reference <ref>   skills.sh reference, e.g. skills.sh:owner/repo/skill
  --json              Emit the JSON report to stdout (default behavior)
  --help              Show this help

Resolution is offline-only: this command never opens the network, performs
provider evidence lookups, or uses a cache. Legacy --online, --strict, and
--home options are deprecated and rejected.
`;

function help(stdout: (line: string) => void): void {
  stdout(HELP_TEXT);
}

function requireOptionValue(argv: string[], index: number, token: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${token}`);
  }
  return value;
}

export function parseArgs(argv: string[] = process.argv): InspectSkillArgs {
  const args: InspectSkillArgs = {
    reference: null,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--online" || token === "--strict" || token === "--home") {
      throw new Error(
        `${token} is deprecated and rejected: inspect-skill is offline-only`,
      );
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token.startsWith("--")) {
      const value = requireOptionValue(argv, i, token);
      if (token === "--reference") {
        args.reference = value;
      } else {
        throw new Error(`Unknown option: ${token}`);
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

export async function runInspect(
  options: InspectSkillOptions,
): Promise<InspectSkillReport> {
  const parsed = parseSkillsShReference(options.reference);
  return {
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    reference: options.reference.trim(),
    owner: parsed.owner,
    repo: parsed.repo,
    ...(parsed.skillPathHint ? { skillPathHint: parsed.skillPathHint } : {}),
    sourceType: "github",
    canonicalSourceHint: parsed.canonicalGitUrl,
    installable: true,
    manifestHint: skillsShReferenceToManifestHint(parsed),
  };
}

export interface InspectSkillMainDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => Date;
}

export async function main(
  argv: string[] = process.argv,
  deps: InspectSkillMainDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));

  let args: InspectSkillArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr(`inspect-skill: ${(error as Error).message}`);
    return 2;
  }

  if (args.help) {
    help(stdout);
    return 0;
  }

  if (!args.reference) {
    stderr("inspect-skill: --reference is required");
    return 2;
  }

  let report: InspectSkillReport;
  try {
    report = await runInspect({
      reference: args.reference,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
  } catch (error) {
    if (error instanceof CatalogIntegrationError) {
      stderr(`inspect-skill: ${error.code}: ${error.message}`);
    } else {
      stderr(`inspect-skill: ${(error as Error).message}`);
    }
    return 2;
  }

  stdout(JSON.stringify(report, null, 2));
  stderr(`inspect-skill: ${report.repo} -> ${report.canonicalSourceHint}`);

  return 0;
}

if (require.main === module) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(
        `inspect-skill: unhandled error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
