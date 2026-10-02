#!/usr/bin/env bun
/**
 * universal-skills Git-only manager
 *
 * Commands:
 *   install   - install skills to project paths via lockfile or direct flags
 *   upgrade   - update lockfile ref/repo and optionally reinstall
 *   doctor    - verify installed skills match lockfile
 *   validate  - validate source pool structure and lockfile
 */

import path from "node:path";
import { parseCliOptions, type CliOptionSpec } from "../lib/args.ts";
import { doctorCommand } from "../modules/skillpool/doctor.ts";
import { installCommand } from "../modules/skillpool/install.ts";
import {
  buildInstallPlan,
  compareSemver,
  validateLockShape,
} from "../modules/skillpool/plan.ts";
import {
  computeSourceChecksum,
  resolveSourceLayout,
} from "../modules/skillpool/source.ts";
import {
  validateCommand,
  validateSourceStructure,
} from "../modules/skillpool/validate.ts";
import { upgradeCommand } from "../modules/skillpool/upgrade.ts";

const TOOL_ROOT = path.resolve(__dirname, "../..");
const UNIVERSAL_CONTRACT_SCRIPT = path.resolve(__dirname, "universal-contract.ts");
const SKILL_METADATA_SCRIPT = path.resolve(__dirname, "skill-metadata.ts");
const SKILL_LIFECYCLE_SCRIPT = path.resolve(__dirname, "skill-lifecycle.ts");

interface SkillpoolArgs {
  _: string[];
  project?: string;
  lockfile?: string;
  source?: string;
  repo?: string;
  ref?: string;
  app?: string;
  dryRun?: boolean;
  "dry-run"?: boolean;
  refreshCache?: boolean;
  "refresh-cache"?: boolean;
  verifySignedTag?: boolean;
  "verify-signed-tag"?: boolean;
  expectedSourceSha256?: string;
  "expected-source-sha256"?: string;
  strictHash?: boolean;
  "strict-hash"?: boolean;
  stateSafety?: boolean;
  "state-safety"?: boolean;
  install?: boolean;
  [key: string]: string | boolean | string[] | undefined;
}

interface ParsedCli {
  command: string;
  args: SkillpoolArgs;
}

interface SkillpoolDeps {
  doctorCommand?: typeof doctorCommand;
  installCommand?: typeof installCommand;
  printHelp?: typeof printHelp;
  upgradeCommand?: typeof upgradeCommand;
  validateCommand?: typeof validateCommand;
}

const CLI_PARSE_SPECS: Record<string, CliOptionSpec> = {
  install: {
    boolean: new Set(["dry-run", "refresh-cache", "verify-signed-tag", "allow-global-core-skills", "debug-state", "legacy-raw-install"]),
    value: new Set([
      "project",
      "lockfile",
      "source",
      "repo",
      "ref",
      "app",
      "profile",
      "skills",
      "skill-path",
      "expected-source-sha256",
      "projection-dir",
      "install-mode",
    ]),
  },
  upgrade: {
    boolean: new Set(["dry-run", "refresh-cache", "verify-signed-tag", "install", "legacy-raw-install"]),
    value: new Set([
      "project",
      "lockfile",
      "source",
      "repo",
      "ref",
      "app",
      "skills",
      "projection-dir",
      "install-mode",
      "expected-source-sha256",
    ]),
  },
  doctor: {
    boolean: new Set(["strict-hash", "state-safety", "refresh-cache"]),
    value: new Set(["project", "lockfile", "source"]),
  },
  validate: {
    boolean: new Set([]),
    value: new Set(["project", "lockfile", "source"]),
  },
};

function printHelp(): void {
  console.log(`
Universal Skills (Git-only)

Usage:
  bun scripts/commands/skillpool.ts <command> [options]

Commands:
  install    Install skills using lockfile or direct flags
  upgrade    Update lockfile ref/repo and optionally reinstall
  doctor     Check installed skills against lockfile
  validate   Validate source pool structure and lockfile
  help       Show this help

Common options:
  --project <dir>             Project directory (default: current directory)
  --lockfile <file>           Lockfile path (default: <project>/.skills.lock.json)
  --source <dir>              Use local source path instead of cloning from Git
  --repo <git-url-or-path>    Git repository for skills pool
  --ref <tag|branch|sha>      Git reference (required for remote installs; no default)
  --refresh-cache             Re-fetch source cache before install/doctor
  --verify-signed-tag         Require ref to be a valid signed git tag
  --expected-source-sha256    Require source checksum to match this SHA-256
  --dry-run                   Print actions without writing files
  --allow-global-core-skills  Allow intentional project-local alternatives for skills declared in globals/core.json
  --debug-state               Include local absolute paths in .skills.state.json for debugging
  --projection-dir <dir>      Install provider projection output after verifying projection.meta.json digests
  --install-mode <mode>       Explicit install mode: projection, copy, or symlink (symlink is rejected in public/release install)
  --legacy-raw-install        Explicitly allow canonical raw install as a compatibility fallback

install direct mode options:
  --app <opencode|codex|claude-code|antigravity>  Project app label; all project adapters target .agents/skills
  --skills <csv>
  --skill-path <skills/<name>>         Single skill path selector within source (backend-safe)
  --profile <profile-name>

upgrade options:
  --ref <new-ref>             Required unless --repo also changing only
  --repo <new-repo>
  --skills <csv>              Reinstall only these skills; without --ref/--repo, refresh them from the current lock
  --no-install                Update lockfile only, skip reinstall

doctor options:
  --strict-hash               Compare installed skill content hash with source
  --state-safety              Verify .skills.state.json privacy and git ignore safety

Examples:
  bun scripts/commands/skillpool.ts install --project .
  bun scripts/commands/skillpool.ts install --project . --app opencode --skills writing-skills,bun-skill --repo git@github.com:you/skills-pool.git --ref v1.3.0
  bun scripts/commands/skillpool.ts upgrade --project . --ref v1.4.0
  bun scripts/commands/skillpool.ts doctor --project . --strict-hash
`);
}

function parseCli(argv: string[]): ParsedCli {
  const command = argv[2] || "help";
  const spec = CLI_PARSE_SPECS[command] ?? null;
  const args = parseCliOptions(argv, 3, spec, {
    allowEquals: true,
    allowNoPrefix: true,
    repeat: "overwrite",
    strict: spec !== null,
  }) as SkillpoolArgs;

  return { command, args };
}

function main(argv: string[] = process.argv, deps: SkillpoolDeps = {}): void {
  const printHelpFn = deps.printHelp ?? printHelp;
  const installCommandFn = deps.installCommand ?? installCommand;
  const upgradeCommandFn = deps.upgradeCommand ?? upgradeCommand;
  const doctorCommandFn = deps.doctorCommand ?? doctorCommand;
  const validateCommandFn = deps.validateCommand ?? validateCommand;

  try {
    const { command, args } = parseCli(argv);

    if (command === "help" || command === "--help" || command === "-h") {
      const hasExtraPositionals = args._.length > 0;
      const hasUnexpectedOptions = Object.keys(args).some((key) => key !== "_");
      if (hasExtraPositionals || hasUnexpectedOptions) {
        throw new Error(`Unknown arguments for help: ${argv.slice(3).join(" ")}`);
      }
      printHelpFn();
      return;
    }

    if (args._.length > 0) {
      throw new Error(`Unknown argument: ${args._[0]}`);
    }

    if (command === "install") {
      installCommandFn(args, {
        universalContractScript: UNIVERSAL_CONTRACT_SCRIPT,
        skillMetadataScript: SKILL_METADATA_SCRIPT,
        skillLifecycleScript: SKILL_LIFECYCLE_SCRIPT,
      });
      return;
    }
    if (command === "upgrade") {
      upgradeCommandFn(args, {
        installCommand: (installArgs) =>
          installCommandFn(installArgs, {
            universalContractScript: UNIVERSAL_CONTRACT_SCRIPT,
            skillMetadataScript: SKILL_METADATA_SCRIPT,
            skillLifecycleScript: SKILL_LIFECYCLE_SCRIPT,
          }),
      });
      return;
    }
    if (command === "doctor") {
      doctorCommandFn(args, { toolRoot: TOOL_ROOT });
      return;
    }
    if (command === "validate") {
      validateCommandFn(args, {
        toolRoot: TOOL_ROOT,
        universalContractScript: UNIVERSAL_CONTRACT_SCRIPT,
        skillMetadataScript: SKILL_METADATA_SCRIPT,
        skillLifecycleScript: SKILL_LIFECYCLE_SCRIPT,
      });
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export {
  buildInstallPlan,
  computeSourceChecksum,
  compareSemver,
  main,
  parseCli,
  resolveSourceLayout,
  validateLockShape,
  validateSourceStructure,
};
