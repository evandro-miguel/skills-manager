#!/usr/bin/env bun
/**
 * adopt-installed: build an adoption plan for foreign-managed skills whose
 * upstream digests verify against their installed trees.
 *
 * PLAN ONLY. Ownership transfer (`--apply`) is intentionally not implemented:
 * it mutates user targets and must land behind a governed ownership-state
 * specification first. This command proves the pipeline end-to-end and emits
 * exactly what a future `--apply` would execute.
 */

import os from "node:os";
import path from "node:path";

import type {
  AdoptionAuditResult,
  AdoptionInstallEntry,
  AdoptionLockEntry,
} from "../modules/application/services/installed-skill-adoption.ts";
import { classifyInstalledSkills } from "../modules/application/services/installed-skill-adoption.ts";
import { digestTreeStrict } from "../lib/files.ts";
import { readSkillsCliLockFile } from "../modules/integrations/skills-cli/lock-reader.ts";
import { scanInstalledSkillsTarget } from "../modules/integrations/skills-cli/install-scanner.ts";
import {
  verifyUpstream,
  type UpstreamMaterializer,
} from "../modules/integrations/skills-cli/upstream-verifier.ts";

const SUPPORTED_MANAGERS = ["skills"] as const;

interface AdoptInstalledArgs {
  project: string;
  manager: string;
  lockfile: string | null;
  home: string | null;
  global: boolean;
  apply: boolean;
  json: boolean;
  help: boolean;
}

export type AdoptionPlanAction = Readonly<{
  name: string;
  targetId: string;
  action: "adopt";
  steps: readonly string[];
  evidence?: Readonly<{
    installedDigest: string;
    upstreamDigest: string;
    sourceUrl: string;
    pinnedRef: string;
  }>;
}>;

export type AdoptionPlanReport = Readonly<{
  generatedAt: string;
  manager: string;
  projectDir: string;
  mode: "plan";
  actions: readonly AdoptionPlanAction[];
  audit: AdoptionAuditResult;
}>;

export type AdoptionPlanOptions = Readonly<{
  project: string;
  manager: string;
  lockfile: string | null;
  home: string | null;
  includeGlobal: boolean;
  materialize?: UpstreamMaterializer;
  now?: () => Date;
}>;

const HELP_TEXT = `Build an adoption plan for foreign-managed skills (read-only).

Usage:
  bun scripts/commands/adopt-installed.ts [options]

Options:
  --project <dir>       Project directory (default: current directory)
  --manager <id>        External manager to audit (default: skills)
  --lockfile <path>     Project lockfile path (default: <project>/skills-lock.json)
  --global              Also scan the global user target and lock
  --apply               NOT IMPLEMENTED: ownership transfer is gated behind a
                        governed ownership-state specification
  --json                Emit the JSON plan to stdout (default behavior)
  --help                Show this help

Only installs whose upstream digest matches the installed tree become
adoption actions. Everything else stays externally managed.
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

export function parseArgs(argv: string[] = process.argv): AdoptInstalledArgs {
  const args: AdoptInstalledArgs = {
    project: ".",
    manager: "skills",
    lockfile: null,
    home: null,
    global: false,
    apply: false,
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
    if (token === "--apply") {
      args.apply = true;
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

type DiscoveryResult = Readonly<{
  locks: readonly AdoptionLockEntry[];
  installs: readonly AdoptionInstallEntry[];
}>;

async function discover(options: AdoptionPlanOptions): Promise<DiscoveryResult> {
  const projectDir = path.resolve(options.project);
  const projectLockPath = options.lockfile
    ? path.resolve(options.lockfile)
    : path.join(projectDir, "skills-lock.json");
  const projectLock = readSkillsCliLockFile(projectLockPath);
  if (!projectLock.ok) {
    throw new Error(
      `unable to read project lock '${projectLockPath}': ${projectLock.error.code}`,
    );
  }

  const locks: AdoptionLockEntry[] = [...projectLock.entries];
  const installs: AdoptionInstallEntry[] = [];

  const projectScan = scanInstalledSkillsTarget(
    "project",
    path.join(projectDir, ".agents", "skills"),
  );
  if (projectScan.ok) installs.push(...projectScan.installs);

  if (options.includeGlobal) {
    const home = options.home ?? os.homedir();
    const globalLock = readSkillsCliLockFile(
      path.join(home, ".agents", ".skill-lock.json"),
    );
    if (globalLock.ok) locks.push(...globalLock.entries);
    const globalScan = scanInstalledSkillsTarget(
      "global",
      path.join(home, ".agents", "skills"),
    );
    if (globalScan.ok) installs.push(...globalScan.installs);
  }

  return { locks, installs };
}

async function verifyAllInstalls(
  locks: readonly AdoptionLockEntry[],
  installs: readonly AdoptionInstallEntry[],
  materialize: UpstreamMaterializer,
): Promise<import("../modules/application/services/installed-skill-adoption").AdoptionUpstreamCheck[]> {
  const checks: import("../modules/application/services/installed-skill-adoption").AdoptionUpstreamCheck[] = [];
  const locksByName = new Map<string, AdoptionLockEntry>();
  for (const lock of locks) {
    if (!locksByName.has(lock.name)) locksByName.set(lock.name, lock);
  }

  for (const install of installs) {
    if (install.isSymlink) continue;
    let installedDigest: string;
    try {
      installedDigest = digestTreeStrict(install.dirPath);
    } catch {
      continue;
    }
    const lock = locksByName.get(install.name);
    if (!lock?.sourceUrl || !lock.skillPath) continue;

    const check = await verifyUpstream(
      {
        name: install.name,
        sourceUrl: lock.sourceUrl,
        ...(lock.ref !== undefined ? { ref: lock.ref } : {}),
        ...(lock.commit !== undefined ? { commit: lock.commit } : {}),
        skillPath: lock.skillPath,
        installedDigest,
      },
      { materialize },
    );
    if (check) checks.push(check);
  }
  return checks;
}

export async function buildAdoptionPlan(
  options: AdoptionPlanOptions,
): Promise<AdoptionPlanReport> {
  const { locks, installs } = await discover(options);
  const locksByName = new Map<string, AdoptionLockEntry>();
  for (const lock of locks) {
    if (!locksByName.has(lock.name)) locksByName.set(lock.name, lock);
  }

  const digestsByName = new Map<string, string>();
  const digestByPath = new Map<string, string>();
  for (const install of installs) {
    if (install.isSymlink) continue;
    try {
      const digest = digestTreeStrict(install.dirPath);
      digestsByName.set(install.name, digest);
      digestByPath.set(install.dirPath, digest);
    } catch {
      // Undigestable trees stay structurally classified only.
    }
  }

  // The classifier compares upstream digests against per-install digests, so
  // feed the computed tree digests into the audited install entries.
  const auditedInstalls: readonly AdoptionInstallEntry[] =
    digestByPath.size > 0
      ? installs.map((install) => {
          const digest = digestByPath.get(install.dirPath);
          return digest === undefined ? install : { ...install, contentDigest: digest };
        })
      : installs;

  const upstreamChecks =
    options.materialize !== undefined
      ? await verifyAllInstalls(locks, installs, options.materialize)
      : undefined;

  const audit = classifyInstalledSkills({
    locks,
    installs: auditedInstalls,
    ...(upstreamChecks !== undefined ? { upstreamChecks } : {}),
  });

  const safeFindings = audit.findings.filter(
    (finding) => finding.verdict === "SAFE_TO_ADOPT",
  );

  const actions = safeFindings.map((finding) => {
    const lock = locksByName.get(finding.name);
    return {
      name: finding.name,
      targetId: finding.targetId,
      action: "adopt" as const,
      steps: [
        "declare source in skill-sys.sources.json",
        "pin resolved commit via skill-sys generate-lock",
        `record ownership receipt managedBy=skill-sys acquiredFrom=${options.manager}`,
      ],
      ...(digestsByName.has(finding.name) && lock?.sourceUrl
        ? {
            evidence: {
              installedDigest: digestsByName.get(finding.name) ?? "",
              upstreamDigest:
                upstreamChecks?.find((c) => c.name === finding.name)
                  ?.upstreamDigest ?? "",
              sourceUrl: lock.sourceUrl,
              pinnedRef: lock.commit ?? lock.ref ?? "HEAD",
            },
          }
        : {}),
    };
  });

  return {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    manager: options.manager,
    projectDir: path.resolve(options.project),
    mode: "plan",
    actions,
    audit,
  };
}

export interface AdoptInstalledMainDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  materialize?: UpstreamMaterializer;
  now?: () => Date;
}

export async function main(
  argv: string[] = process.argv,
  deps: AdoptInstalledMainDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));

  let args: AdoptInstalledArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr(`adopt-installed: ${(error as Error).message}`);
    return 2;
  }

  if (args.help) {
    help(stdout);
    return 0;
  }

  if (args.apply) {
    stderr(
      "adopt-installed: --apply is not implemented; ownership transfer awaits the governed ownership-state specification. Plan output only.",
    );
    return 2;
  }

  if (
    !SUPPORTED_MANAGERS.includes(
      args.manager as (typeof SUPPORTED_MANAGERS)[number],
    )
  ) {
    stderr(`adopt-installed: unsupported manager '${args.manager}'`);
    return 2;
  }

  try {
    const report = await buildAdoptionPlan({
      project: args.project,
      manager: args.manager,
      lockfile: args.lockfile,
      home: args.home,
      includeGlobal: args.global,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.materialize !== undefined
        ? { materialize: deps.materialize }
        : {}),
    });

    stdout(JSON.stringify(report, null, 2));
    stderr(
      `adopt-installed: ${report.actions.length} adoption action(s) planned; ` +
        `${report.audit.summary.blocked} finding(s) remain externally managed.`,
    );
    return 0;
  } catch (error) {
    stderr(`adopt-installed: ${(error as Error).message}`);
    return 2;
  }
}

if (require.main === module) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(
        `adopt-installed: unhandled error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
