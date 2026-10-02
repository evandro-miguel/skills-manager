#!/usr/bin/env bun

import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import {
  doctorBudget,
  formatFindings,
} from "../modules/skillpool/semantic-evals.ts";
import { parseProviderList, type ConcreteProviderId } from "../modules/skillpool/providers.ts";

interface BudgetDoctorArgs {
  source: string;
  provider: ConcreteProviderId;
  globalCore: boolean;
  budget?: number;
  json: boolean;
  help: boolean;
}

function help(): void {
  console.log(`
Estimate provider initial skill listing budget

Usage:
  bun scripts/commands/budget-doctor.ts [options]

Options:
  --source <dir>       Source root (default: .)
  --provider <id>      Provider budget lens (default: codex)
  --global-core        Limit estimate to globals/core.json skills
  --budget <chars>     Override provider default budget
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

function parseArgs(argv: string[] = process.argv): BudgetDoctorArgs {
  const args: BudgetDoctorArgs = {
    source: ".",
    provider: "codex",
    globalCore: false,
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
    if (token === "--global-core") {
      args.globalCore = true;
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
    if (token === "--budget") {
      const value = Number(requireOptionValue(argv, i, token));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--budget must be a positive integer");
      }
      args.budget = value;
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

  const result = doctorBudget({
    sourceRoot: args.source,
    provider: args.provider,
    scope: args.globalCore ? "global-core" : "all",
    ...(args.budget === undefined ? {} : { maxBudget: args.budget }),
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result.findings.length ? "STATUS: WARN" : "STATUS: PASS");
  console.log(`Provider: ${result.provider}`);
  console.log(`Scope: ${result.scope}`);
  console.log(`Initial skill listing budget: ${result.budget} chars`);
  console.log(`Current: ${result.current} chars`);
  console.log(formatFindings(result.findings));
  if (result.findings.length) {
    console.log("Suggested:");
    console.log("- Keep global core small and provider-relevant");
    console.log("- Move low-priority skills out of implicit global scope");
    console.log("- Shorten descriptions that are broad or redundant");
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
