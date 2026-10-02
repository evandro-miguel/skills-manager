#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  evaluateTriggerFixtures,
  formatFindings,
  hasErrors,
} from "../modules/skillpool/semantic-evals.ts";
import { parseProviderList, type ConcreteProviderId } from "../modules/skillpool/providers.ts";

interface EvalArgs {
  command: "triggers" | "collisions";
  source: string;
  provider: ConcreteProviderId;
  json: boolean;
  help: boolean;
}

function help(): void {
  console.log(`
Evaluate semantic skill fixtures

Usage:
  bun scripts/commands/eval.ts triggers [options]
  bun scripts/commands/eval.ts collisions [options]

Options:
  --source <dir>       Source root (default: .)
  --provider <id>      Provider lens for the eval report (default: codex)
  --json               Emit machine-readable output
  --help               Show help
`);
}

function parseProvider(value: string): ConcreteProviderId {
  const providers = parseProviderList(value);
  if (providers.length !== 1) {
    throw new Error("--provider expects one provider id");
  }
  return providers[0]!;
}

function parseArgs(argv: string[] = process.argv): EvalArgs {
  const commandToken = argv[2];
  const args: EvalArgs = {
    command: commandToken === "collisions" ? "collisions" : "triggers",
    source: ".",
    provider: "codex",
    json: false,
    help: false,
  };

  if (commandToken === "--help" || commandToken === "-h") {
    args.help = true;
    return args;
  }
  if (commandToken && commandToken !== "triggers" && commandToken !== "collisions") {
    throw new Error(`Unknown eval command: ${commandToken}`);
  }

  for (let i = commandToken ? 3 : 2; i < argv.length; i += 1) {
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
    if (token === "--provider") {
      args.provider = parseProvider(requireOptionValue(argv, i, token));
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), args.source);
  return args;
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const result = evaluateTriggerFixtures({
    sourceRoot: args.source,
    provider: args.provider,
    mode: args.command,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(hasErrors(result.findings) ? "STATUS: BLOCKING" : "STATUS: PASS");
    console.log(`Provider: ${result.provider}`);
    console.log(`Fixtures: ${result.fixtureCount}`);
    console.log(`Cases: ${result.caseCount}`);
    console.log(formatFindings(result.findings));
  }

  if (hasErrors(result.findings)) {
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
};
