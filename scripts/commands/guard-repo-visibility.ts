#!/usr/bin/env bun

import { requireOptionValue } from "../lib/args.ts";
import { runCommand, type RunCommandResult } from "../lib/command.ts";

export const DEFAULT_REPOSITORY = "evandro-miguel/skills-manager";
export const OWNER_APPROVED_PUBLIC_REPOSITORY = "evandro-miguel/skills-manager";
export const ARCHITECTURE = "public-engine/base";
export const POLICY_NOTICE = "requires verified GitHub PRIVATE visibility, except the owner-approved public Skills Manager repository";
export const ALLOW_PUBLIC_AFTER_EXPLICIT_USER_APPROVAL_FLAG = "--allow-public-after-explicit-user-approval";

export type RepoVisibilityGuardStatus = "PASS" | "PASS_OWNER_APPROVED_PUBLIC" | "PASS_LOCAL_UNVERIFIED" | "PASS_WITH_EXPLICIT_USER_APPROVAL" | "BLOCKING";

export type RepoVisibilityGuardArgs = {
  json: boolean;
  help: boolean;
  repository?: string;
  localOk: boolean;
  allowPublicAfterExplicitUserApproval: boolean;
};

export type RepoVisibilityGuardResult = {
  repository: string;
  visibility: string;
  isPrivate: boolean | null;
  status: RepoVisibilityGuardStatus;
  localOk: boolean;
  allowPublicAfterExplicitUserApproval: boolean;
};

export type RepoVisibilityRunner = (argv: string[]) => RunCommandResult;

type RepoVisibilityGuardDeps = {
  run?: RepoVisibilityRunner;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

type ObservedVisibility = {
  visibility: string;
  isPrivate: boolean | null;
  valid: boolean;
};

function defaultRepository(): string {
  return process.env.GITHUB_REPOSITORY || process.env.SKILL_SYS_REPOSITORY || DEFAULT_REPOSITORY;
}

export function help(stdout: (text: string) => void = console.log): void {
  stdout(`
Repo visibility guard for ${defaultRepository()}

Usage:
  bun scripts/commands/guard-repo-visibility.ts [options]

Options:
  --repository <owner/repo>                            Repository to verify (default: GITHUB_REPOSITORY, SKILL_SYS_REPOSITORY, or ${DEFAULT_REPOSITORY})
  --local-ok                                           Pass local/dev validation if GitHub visibility cannot be verified
  --json                                               Emit machine-readable guard result
  ${ALLOW_PUBLIC_AFTER_EXPLICIT_USER_APPROVAL_FLAG}    Loud override for explicit owner-approved publication
  --help                                               Show help

Policy:
  GitHub visibility ${POLICY_NOTICE}
`);
}

export function parseArgs(argv: string[]): RepoVisibilityGuardArgs {
  const args: RepoVisibilityGuardArgs = {
    json: false,
    help: false,
    localOk: false,
    allowPublicAfterExplicitUserApproval: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === "--help" || token === "-h") { args.help = true; continue; }
    if (token === "--json") { args.json = true; continue; }
    if (token === "--local-ok") { args.localOk = true; continue; }
    if (token === "--repository") { args.repository = requireOptionValue(argv, index, token); index += 1; continue; }
    if (token === ALLOW_PUBLIC_AFTER_EXPLICIT_USER_APPROVAL_FLAG) {
      args.allowPublicAfterExplicitUserApproval = true;
      continue;
    }
    if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function normalizeVisibility(value: string): string {
  const normalized = value.trim().toUpperCase();
  return normalized || "UNKNOWN";
}

function parseGhRepoViewOutput(commandResult: RunCommandResult): ObservedVisibility {
  if (commandResult.code !== 0) return { visibility: "UNKNOWN", isPrivate: null, valid: false };

  let parsed: unknown;
  try { parsed = JSON.parse(commandResult.stdout); } catch { return { visibility: "UNKNOWN", isPrivate: null, valid: false }; }
  if (!parsed || typeof parsed !== "object") return { visibility: "UNKNOWN", isPrivate: null, valid: false };

  const payload = parsed as Record<string, unknown>;
  const visibility = payload.visibility;
  const isPrivate = payload.isPrivate;
  if (typeof visibility !== "string" || !visibility.trim() || typeof isPrivate !== "boolean") {
    return { visibility: "UNKNOWN", isPrivate: null, valid: false };
  }

  return { visibility: normalizeVisibility(visibility), isPrivate, valid: true };
}

function statusForObservation(observation: ObservedVisibility, args: RepoVisibilityGuardArgs): RepoVisibilityGuardStatus {
  if (observation.valid && observation.visibility === "PRIVATE" && observation.isPrivate === true) return "PASS";
  const repository = args.repository || defaultRepository();
  if (repository === OWNER_APPROVED_PUBLIC_REPOSITORY && observation.valid && observation.visibility === "PUBLIC" && observation.isPrivate === false) return "PASS_OWNER_APPROVED_PUBLIC";
  if (observation.valid && observation.visibility === "PUBLIC" && observation.isPrivate === false && args.allowPublicAfterExplicitUserApproval) {
    return "PASS_WITH_EXPLICIT_USER_APPROVAL";
  }
  if (!observation.valid && args.localOk) return "PASS_LOCAL_UNVERIFIED";
  return "BLOCKING";
}

export function runRepoVisibilityGuard(
  args: RepoVisibilityGuardArgs,
  runner: RepoVisibilityRunner = (argv) =>
    runCommand(argv, { stdout: "pipe", stderr: "pipe", allowFailure: true })
): RepoVisibilityGuardResult {
  const repository = args.repository || defaultRepository();
  const ghResult = runner(["gh", "repo", "view", repository, "--json", "visibility,isPrivate"]);
  const observation = parseGhRepoViewOutput(ghResult);

  return {
    repository,
    visibility: observation.visibility,
    isPrivate: observation.isPrivate,
    status: statusForObservation(observation, args),
    localOk: args.localOk,
    allowPublicAfterExplicitUserApproval: args.allowPublicAfterExplicitUserApproval,
  };
}

export function renderRepoVisibilityGuardResult(result: RepoVisibilityGuardResult): string {
  const lines = [
    `STATUS: ${result.status === "BLOCKING" ? "BLOCKING" : result.status}`,
    `Repository: ${result.repository}`,
    `Architecture: ${ARCHITECTURE}`,
    `GitHub visibility: ${result.visibility}`,
    `Policy: ${POLICY_NOTICE}`,
  ];

  if (result.localOk) lines.push("Local validation override: enabled for unverifiable GitHub visibility only");
  if (result.allowPublicAfterExplicitUserApproval) {
    lines.push(`OVERRIDE: ${ALLOW_PUBLIC_AFTER_EXPLICIT_USER_APPROVAL_FLAG} was provided; public visibility is allowed only after explicit repository owner approval.`);
  } else {
    lines.push(`Override: not provided (${ALLOW_PUBLIC_AFTER_EXPLICIT_USER_APPROVAL_FLAG} absent)`);
  }

  return lines.join("\n");
}

export function main(argv: string[] = process.argv, deps: RepoVisibilityGuardDeps = {}): number {
  const stdout = deps.stdout || console.log;
  const stderr = deps.stderr || console.error;
  try {
    const args = parseArgs(argv);
    if (args.help) { help(stdout); return 0; }
    const result = runRepoVisibilityGuard(args, deps.run);
    stdout(args.json ? JSON.stringify(result, null, 2) : renderRepoVisibilityGuardResult(result));
    return result.status === "BLOCKING" ? 1 : 0;
  } catch (error) {
    stderr(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
