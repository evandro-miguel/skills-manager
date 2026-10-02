#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { parseMeasuredEvalReceipt, type EvalReceiptBinding } from "../modules/skillpool/eval-receipt.ts";

interface ReceiptCliArgs {
  receipt?: string;
  sourceDigest?: string;
  fixtureDigest?: string;
  caseIds?: string;
  provider?: string;
  model?: string;
  json: boolean;
  help: boolean;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function help(): void {
  console.log(`
Validate a completed measured-eval receipt without executing a provider

Usage:
  bun scripts/commands/eval-receipt.ts --receipt <file> --source-digest <sha256> --fixture-digest <sha256> --case-ids <id,id> --provider <id> --model <id> [--json]
`);
}

export function parseArgs(argv: string[] = process.argv): ReceiptCliArgs {
  const args: ReceiptCliArgs = { json: false, help: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--help" || token === "-h") { args.help = true; continue; }
    if (token === "--json") { args.json = true; continue; }
    const option = new Map<string, keyof ReceiptCliArgs>([["--receipt", "receipt"], ["--source-digest", "sourceDigest"], ["--fixture-digest", "fixtureDigest"], ["--case-ids", "caseIds"], ["--provider", "provider"], ["--model", "model"]]).get(token);
    if (!option) throw new Error(`Unknown argument: ${token}`);
    args[option] = requireOptionValue(argv, index, token) as never;
    index += 1;
  }
  if (args.receipt) args.receipt = path.resolve(process.cwd(), args.receipt);
  return args;
}

function bindingFrom(args: ReceiptCliArgs): EvalReceiptBinding {
  if (!args.sourceDigest || !DIGEST_PATTERN.test(args.sourceDigest) || !args.fixtureDigest || !DIGEST_PATTERN.test(args.fixtureDigest) || !args.caseIds || !args.provider || !args.model) throw new Error("Usage: eval receipt requires receipt, source digest, fixture digest, case ids, provider, and model");
  const caseIds = args.caseIds.split(",").filter(Boolean);
  if (caseIds.length === 0) throw new Error("--case-ids must contain at least one case id");
  return { sourceDigest: args.sourceDigest, fixtureDigest: args.fixtureDigest, caseIds, provider: args.provider, model: args.model };
}

export function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) return help();
  const binding = bindingFrom(args);
  if (!args.receipt || !fs.existsSync(args.receipt) || fs.lstatSync(args.receipt).isSymbolicLink() || !fs.lstatSync(args.receipt).isFile() || fs.statSync(args.receipt).size > 64 * 1024) throw new Error("Receipt must be a regular JSON file no larger than 64 KiB");
  let candidate: unknown;
  try { candidate = JSON.parse(fs.readFileSync(args.receipt, "utf8")); } catch { throw new Error("Receipt must contain valid JSON"); }
  const result = parseMeasuredEvalReceipt(candidate, binding);
  console.log(args.json ? JSON.stringify(result) : result.accepted ? "STATUS: ACCEPTED" : `STATUS: REJECTED\nREASON: ${result.reason}`);
  if (!result.accepted) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}
