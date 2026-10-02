#!/usr/bin/env bun
/**
 * Standalone entry point for PR13 sandbox runtime verification (plan-only).
 *
 * This command builds and prints the sandbox command vector for a skill source
 * without executing anything. It runs the planner in-process: it never spawns
 * Docker, never runs a child process, and never evaluates skill code.
 *
 * `skill-sys verify-sandbox` is the primary surface; this script exists for
 * direct invocation and explicit docs references.
 */

import {
  normalizeSandboxArgs,
  planSandbox,
  renderSandboxVerdict,
  type SandboxRawArgs,
} from "../modules/skillpool/sandbox-plan.ts";

interface VerifySandboxArgs {
  raw: SandboxRawArgs;
  help: boolean;
}

function help(): void {
  console.log(`
Plan-only sandbox runtime verification (PR13)

Builds a deterministic sandbox command vector for a skill source and reports the
required runtime controls. It never executes Docker, runs a child process, or
evaluates skill code. Use the verdict to review the planned isolation before any
future runtime slice exists.

Usage:
  bun scripts/commands/verify-sandbox.ts --source <dir> --plan|--dry-run [options]
  skill-sys verify-sandbox --source <dir> --plan|--dry-run [options]

Options:
  --source <dir>          Skill source root (required; no implicit default)
  --plan                  Emit a plan verdict (required mode)
  --dry-run               Emit a dry-run verdict (required mode)
  --mount src:target      Extra read-only bind mount (repeatable)
  --json                  Emit machine-readable verdict
  --apply, --run, --execute   Fail closed: execution is not supported
  --help                  Show help
`);
}

function parseArgs(argv: string[]): VerifySandboxArgs {
  const raw: SandboxRawArgs = {};
  let help = false;

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--json") {
      raw.json = true;
      continue;
    }
    if (token === "--plan") {
      raw.plan = true;
      continue;
    }
    if (token === "--dry-run") {
      raw["dry-run"] = true;
      continue;
    }
    if (token === "--apply") {
      raw.apply = true;
      continue;
    }
    if (token === "--run") {
      raw.run = true;
      continue;
    }
    if (token === "--execute") {
      raw.execute = true;
      continue;
    }
    if (token === "--source") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --source");
      }
      raw.source = value;
      i += 1;
      continue;
    }
    if (token === "--mount") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --mount");
      }
      const existing = Array.isArray(raw.mount) ? raw.mount : typeof raw.mount === "string" ? [raw.mount] : [];
      raw.mount = [...existing, value];
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return { raw, help };
}

function main(argv: string[] = process.argv): number {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return 0;
  }

  const input = normalizeSandboxArgs(args.raw);
  const plan = planSandbox(input);
  const format = args.raw.json === true ? "json" : "text";
  console.log(renderSandboxVerdict(plan, format).trimEnd());
  return plan.status === "BLOCKED" ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
}

export { help, main, parseArgs };
