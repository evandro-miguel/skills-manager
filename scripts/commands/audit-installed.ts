#!/usr/bin/env bun
/**
 * audit-installed: read-only audit of skills installed by external managers.
 *
 * Currently supports the `skills` CLI layout: a project lockfile
 * (`skills-lock.json`) and/or the global user lock (`~/.agents/.skill-lock.json`)
 * are treated as source hints, while `.agents/skills` targets are scanned for
 * installed directories (symlinks flagged, escapes detected). Findings come
 * from the adoption classifier; nothing is ever written, modified, or adopted.
 *
 * Output: the full report is printed as JSON to stdout. A short human-readable
 * summary goes to stderr. Exit code is 0 even when findings exist; pass
 * `--strict` to exit non-zero when any finding is BLOCKED. Without an upstream
 * verifier, structurally clean installs report NEEDS_UPSTREAM_VERIFICATION —
 * SAFE_TO_ADOPT requires digest-proven upstream matches and never comes from
 * structure alone.
 */

import os from "node:os";
import path from "node:path";

import fs from "node:fs";

import type {
  AdoptionAuditResult,
  AdoptionInstallEntry,
  AdoptionLockEntry,
  AdoptionUpstreamCheck,
} from "../modules/application/services/installed-skill-adoption.ts";
import { digestTreeStrict } from "../lib/files.ts";
import type { UpstreamMaterializer } from "../modules/integrations/skills-cli/upstream-verifier.ts";
import { verifyUpstream } from "../modules/integrations/skills-cli/upstream-verifier.ts";
import { classifyInstalledSkills } from "../modules/application/services/installed-skill-adoption.ts";
import {
  readSkillsCliLockFile,
} from "../modules/integrations/skills-cli/lock-reader.ts";
import {
  scanInstalledSkillsTarget,
} from "../modules/integrations/skills-cli/install-scanner.ts";

const SUPPORTED_MANAGERS = ["skills"] as const;

interface AuditInstalledArgs {
  project: string;
  manager: string;
  lockfile: string | null;
  home: string | null;
  global: boolean;
  verifyUpstream: boolean;
  strict: boolean;
  json: boolean;
  help: boolean;
}

export type AuditInstalledReport = {
  checkedAt: string;
  manager: string;
  projectDir: string;
  /** Target directories actually scanned. */
  targetsScanned: string[];
  /** Warnings from defensive foreign-lock parsing (malformed entries skipped). */
  lockWarnings: readonly string[];
  /** Requested scopes whose lock or target was absent (visibility for --global). */
  absentScopes: readonly string[];
  audit: AdoptionAuditResult;
};

export type AuditInstalledOptions = {
  project: string;
  manager: string;
  /** Explicit project lockfile path; defaults to <project>/skills-lock.json. */
  lockfile: string | null;
  /** Home override for global paths (tests); defaults to os.homedir(). */
  home: string | null;
  includeGlobal: boolean;
  /** Verify lock-pinned sources upstream and feed digest checks. */
  verifyUpstream?: boolean;
  materialize?: UpstreamMaterializer;
  now?: () => string;
};

export type AuditInstalledResult = {
  report: AuditInstalledReport;
  exitCode: number;
};

const HELP_TEXT = `Audit skills installed by external managers (read-only).

Usage:
  bun scripts/commands/audit-installed.ts [options]

Options:
  --project <dir>       Project directory (default: current directory)
  --manager <id>        External manager to audit (default: skills)
  --lockfile <path>     Project lockfile path (default: <project>/skills-lock.json)
  --global              Also scan the global user target (~/.agents/skills) and lock
  --verify-upstream     Materialize lock-pinned Git sources and compare digests
                        (enables SAFE_TO_ADOPT verdicts; needs network)
  --strict              Exit non-zero when any finding is BLOCKED
  --json                Emit the JSON report to stdout (default behavior)
  --help                Show this help

Exit codes:
  0   audit completed (findings may exist; use --strict to fail on BLOCKED)
  1   --strict and at least one finding is BLOCKED
  2   usage or operational error (unreadable/corrupt locks, bad flags)

When invoked through the skill-sys front door, child non-zero exits are
surfaced as front-door failures.

Foreign locks are hints only; this command verifies filesystem structure and,
in future slices, pinned upstream digests. It never writes files.
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

export function parseArgs(argv: string[] = process.argv): AuditInstalledArgs {
  const args: AuditInstalledArgs = {
    project: ".",
    manager: "skills",
    lockfile: null,
    home: null,
    global: false,
    verifyUpstream: false,
    strict: false,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--global") {
      args.global = true;
      continue;
    }
    if (token === "--verify-upstream") {
      args.verifyUpstream = true;
      continue;
    }
    if (token === "--strict") {
      args.strict = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token.startsWith("--")) {
      const value = requireOptionValue(argv, i, token);
      if (token === "--project") {
        args.project = value;
      } else if (token === "--manager") {
        args.manager = value;
      } else if (token === "--lockfile") {
        args.lockfile = value;
      } else if (token === "--home") {
        args.home = value;
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

type LockReadOk = Extract<ReturnType<typeof readSkillsCliLockFile>, { ok: true }>;

function readLockOrThrow(lockPath: string, label: string): LockReadOk {
  const result = readSkillsCliLockFile(lockPath);
  if (!result.ok) {
    throw new Error(
      `Unable to read ${label} lock at '${lockPath}': ${result.error.code} ${result.error.message}`,
    );
  }
  return result;
}

type ScanOutcome = ReturnType<typeof scanInstalledSkillsTarget>;

function scanTargetOrThrow(targetId: string, targetDir: string): ScanOutcome {
  const result = scanInstalledSkillsTarget(targetId, targetDir);
  if (!result.ok && result.error.code !== "TARGET_MISSING") {
    throw new Error(
      `Unable to scan target '${targetDir}': ${result.error.code}` +
        (result.error.message ? ` (${result.error.message})` : ""),
    );
  }
  return result;
}

export async function runAuditInstalled(
  options: AuditInstalledOptions,
): Promise<AuditInstalledReport> {
  const projectDir = path.resolve(options.project);
  const projectLockPath = options.lockfile
    ? path.resolve(options.lockfile)
    : path.join(projectDir, "skills-lock.json");
  const projectLock = readLockOrThrow(projectLockPath, "project");

  const locks = [...projectLock.entries];
  let installs: AdoptionInstallEntry[] = [];
  const targetsScanned: string[] = [];
  const lockWarnings: string[] = [];
  const absentScopes: string[] = [];

  for (const warning of projectLock.warnings) {
    lockWarnings.push(`project: ${warning}`);
  }

  const projectTarget = path.join(projectDir, ".agents", "skills");
  const projectScan = scanTargetOrThrow("project", projectTarget);
  if (projectScan.ok) {
    installs.push(...projectScan.installs);
    targetsScanned.push(projectTarget);
  } else {
    absentScopes.push(`project target missing at '${projectTarget}'`);
  }
  if (!projectLock.present) {
    absentScopes.push(`project lock absent at '${projectLockPath}'`);
  }

  if (options.includeGlobal) {
    const home = options.home ?? os.homedir();
    const globalLockPath = path.join(home, ".agents", ".skill-lock.json");
    const globalLock = readLockOrThrow(globalLockPath, "global");
    locks.push(...globalLock.entries);
    for (const warning of globalLock.warnings) {
      lockWarnings.push(`global: ${warning}`);
    }

    const globalTarget = path.join(home, ".agents", "skills");
    const globalScan = scanTargetOrThrow("global", globalTarget);
    if (globalScan.ok) {
      installs.push(...globalScan.installs);
      targetsScanned.push(globalTarget);
    } else {
      absentScopes.push(`global target missing at '${globalTarget}'`);
    }
    if (!globalLock.present) {
      absentScopes.push(`global lock absent at '${globalLockPath}'`);
    }
  }

  let upstreamChecks: AdoptionUpstreamCheck[] | undefined;
  if (options.verifyUpstream === true) {
    upstreamChecks = [];
    const locksByName = new Map<string, AdoptionLockEntry>();
    for (const lock of locks) {
      if (!locksByName.has(lock.name)) locksByName.set(lock.name, lock);
    }
    const enriched = new Map<number, AdoptionInstallEntry>();
    for (const [index, install] of installs.entries()) {
      if (install.isSymlink) continue;
      const lock = locksByName.get(install.name);
      if (!lock?.sourceUrl) continue;
      let installedDigest: string;
      try {
        installedDigest = digestTreeStrict(install.dirPath);
      } catch {
        continue;
      }
      enriched.set(index, { ...install, contentDigest: installedDigest });
      const check = await verifyUpstream(
        {
          name: install.name,
          sourceUrl: lock.sourceUrl,
          ...(lock.ref !== undefined ? { ref: lock.ref } : {}),
          ...(lock.commit !== undefined ? { commit: lock.commit } : {}),
          ...(lock.skillPath !== undefined ? { skillPath: lock.skillPath } : {}),
          installedDigest,
        },
        options.materialize ? { materialize: options.materialize } : {},
      );
      if (check) upstreamChecks.push(check);
    }
    if (enriched.size > 0) {
      installs = installs.map((install, index) => enriched.get(index) ?? install);
    }
  }

  const audit = classifyInstalledSkills({
    locks,
    installs,
    ...(upstreamChecks !== undefined ? { upstreamChecks } : {}),
  });

  return {
    checkedAt: options.now ? options.now() : new Date().toISOString(),
    manager: options.manager,
    projectDir,
    targetsScanned,
    lockWarnings,
    absentScopes,
    audit,
  };
}

export interface AuditInstalledMainDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function main(
  argv: string[] = process.argv,
  deps: AuditInstalledMainDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));

  let args: AuditInstalledArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr(`audit-installed: ${(error as Error).message}`);
    return 2;
  }

  if (args.help) {
    help(stdout);
    return 0;
  }

  if (!SUPPORTED_MANAGERS.includes(args.manager as (typeof SUPPORTED_MANAGERS)[number])) {
    stderr(
      `audit-installed: unsupported manager '${args.manager}' (supported: ${SUPPORTED_MANAGERS.join(", ")})`,
    );
    return 2;
  }

  try {
    const report = await runAuditInstalled({
      project: args.project,
      manager: args.manager,
      lockfile: args.lockfile,
      home: args.home,
      includeGlobal: args.global,
      verifyUpstream: args.verifyUpstream,
    });

    stdout(JSON.stringify(report, null, 2));

    for (const scopeNote of report.absentScopes) {
      stderr(`audit-installed: note: ${scopeNote}`);
    }
    for (const warning of report.lockWarnings) {
      stderr(`audit-installed: lock warning: ${warning}`);
    }

    const summary = report.audit.summary;
    stderr(
      `audit-installed: ${summary.installs} install(s), ` +
        `${summary.safeToAdopt} safe-to-adopt, ` +
        `${summary.needsUpstreamVerification} need upstream verification, ` +
        `${summary.blocked} blocked, ${summary.staleLockEntries} stale lock entr(y/ies).`,
    );
    for (const finding of report.audit.findings) {
      stderr(
        `- ${finding.name} [${finding.targetId}] ${finding.verdict}` +
          (finding.states.length > 0 ? ` (${finding.states.join(", ")})` : ""),
      );
    }

    return args.strict && summary.blocked > 0 ? 1 : 0;
  } catch (error) {
    stderr(`audit-installed: ${(error as Error).message}`);
    return 2;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
