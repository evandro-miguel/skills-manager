#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dirDigest as dirDigestBase, fileExists } from "../../lib/files.ts";
import { resolveSourceRootForPlan } from "./cache.ts";
import { assertPathWithinProject, readAdapter, resolveSkillsForEntry } from "./entry.ts";
import { loadLockfile, resolveLockfilePath, resolveProjectDir } from "./lockfile.ts";
import { validateLockShape } from "./plan.ts";
import { resolveSourceLayout } from "./source.ts";
import { assertNotHomeAgentsSkillsTarget } from "../home-agents-guard.ts";

interface SkillpoolDoctorArgs {
  project?: string;
  lockfile?: string;
  source?: string;
  strictHash?: boolean;
  "strict-hash"?: boolean;
  stateSafety?: boolean;
  "state-safety"?: boolean;
  refreshCache?: boolean;
  "refresh-cache"?: boolean;
  [key: string]: string | boolean | string[] | undefined;
}

interface DoctorOptions {
  toolRoot: string;
}

interface Finding {
  level: "ERROR" | "WARN";
  code: string;
  message: string;
}

interface LockfileInstallEntry {
  app: string;
  profile?: string;
  skills?: string[];
}

interface LockfileShape {
  repo: string;
  ref: string;
  installs: LockfileInstallEntry[];
  policy?: Record<string, unknown>;
}

function dirDigest(dirPath: string): string {
  return dirDigestBase(dirPath);
}

function addPartialInstallFindings(targetBase: string, app: string, findings: Finding[]): void {
  const tmpPath = path.join(targetBase, ".skill-sys-tmp");
  if (fileExists(tmpPath)) {
    const entries = fs.readdirSync(tmpPath, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isFile());
    if (entries.length) {
      findings.push({
        level: "ERROR",
        code: "PARTIAL_INSTALL_TMP",
        message: `${app} has leftover install transaction data at ${tmpPath}`,
      });
    }
  }

  const backupPath = path.join(targetBase, ".skill-sys-backup");
  if (!fileExists(backupPath)) {
    return;
  }
  for (const entry of fs.readdirSync(backupPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      findings.push({
        level: "ERROR",
        code: "PARTIAL_INSTALL_BACKUP",
        message: `${app} has pending install backup data at ${path.join(backupPath, entry.name)}`,
      });
      continue;
    }
    const backupRoot = path.join(backupPath, entry.name);
    if (fileExists(path.join(backupRoot, ".complete"))) {
      continue;
    }
    findings.push({
      level: "ERROR",
      code: "PARTIAL_INSTALL_BACKUP",
      message: `${app} has pending install backup data at ${backupRoot}`,
    });
  }
}

function gitWorkTreeRoot(projectDir: string): string | null {
  const inside = spawnSync("git", ["-C", projectDir, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return null;
  }
  const root = spawnSync("git", ["-C", projectDir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (root.status !== 0 || !root.stdout.trim()) {
    return null;
  }
  return path.resolve(root.stdout.trim());
}

function isGitIgnored(projectDir: string, workTreeRoot: string, relativePath: string): boolean {
  const result = spawnSync("git", ["-C", projectDir, "check-ignore", "-v", "--", relativePath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return false;
  }
  const ruleSource = result.stdout.split(":")[0];
  if (!ruleSource) {
    return false;
  }
  const absoluteRuleSource = path.resolve(projectDir, ruleSource);
  const relativeRuleSource = path.relative(workTreeRoot, absoluteRuleSource);
  return (
    !relativeRuleSource.startsWith("..") &&
    !path.isAbsolute(relativeRuleSource) &&
    path.basename(absoluteRuleSource) === ".gitignore"
  );
}

function isLocalAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function stateMode(state: unknown): string {
  if (!state || typeof state !== "object") {
    return "legacy";
  }
  const stateObject = state as Record<string, unknown>;
  if (typeof stateObject.mode === "string") {
    return stateObject.mode;
  }
  return "legacy";
}

function isPathLikeField(prefix: string): boolean {
  const match = /(?:\.|^)([^.[\]]+)(?:\[\d+\])?$/.exec(prefix);
  const fieldName = match?.[1]?.toLowerCase() || "";
  return [
    "archive_path",
    "from",
    "path",
    "sourcepath",
    "target",
    "to",
  ].includes(fieldName);
}

function normalizedPathEscapesProject(value: string): boolean {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized === ".." || normalized.startsWith("../");
}

function isHomePath(value: string): boolean {
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    return true;
  }
  const home = process.env.HOME;
  if (!home) {
    return false;
  }
  const resolvedHome = path.resolve(home);
  if (!isLocalAbsolutePath(value)) {
    return false;
  }
  const relative = path.relative(resolvedHome, path.resolve(value));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface StatePathFindings {
  absolute: string[];
  escape: string[];
  home: string[];
}

function collectPathFindings(
  value: unknown,
  prefix = "$",
  output: StatePathFindings = { absolute: [], escape: [], home: [] }
): StatePathFindings {
  if (typeof value === "string") {
    if (isLocalAbsolutePath(value)) {
      output.absolute.push(prefix);
    }
    if (isPathLikeField(prefix) && normalizedPathEscapesProject(value)) {
      output.escape.push(prefix);
    }
    if (isPathLikeField(prefix) && isHomePath(value)) {
      output.home.push(prefix);
    }
    return output;
  }
  if (!value || typeof value !== "object") {
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPathFindings(item, `${prefix}[${index}]`, output));
    return output;
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    collectPathFindings(item, `${prefix}.${key}`, output);
  });
  return output;
}

function addStateSafetyFindings(projectDir: string, findings: Finding[]): void {
  const stateRelativePath = ".skills.state.json";
  const statePath = path.join(projectDir, stateRelativePath);
  const workTreeRoot = gitWorkTreeRoot(projectDir);

  if (workTreeRoot && !isGitIgnored(projectDir, workTreeRoot, stateRelativePath)) {
    findings.push({
      level: "ERROR",
      code: "STATE_NOT_GITIGNORED",
      message: `${stateRelativePath} must be ignored by git before skill-sys writes local install state`,
    });
  }

  if (!fileExists(statePath)) {
    return;
  }

  let state: unknown;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    findings.push({
      level: "ERROR",
      code: "STATE_INVALID_JSON",
      message: `${stateRelativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const mode = stateMode(state);
  if (!state || typeof state !== "object" || (state as Record<string, unknown>).schemaVersion !== 2) {
    findings.push({
      level: "ERROR",
      code: "STATE_SCHEMA_VERSION",
      message: `${stateRelativePath} must declare schemaVersion: 2`,
    });
  }
  if (mode !== "minimal" && mode !== "debug") {
    findings.push({
      level: "ERROR",
      code: "STATE_MODE_INVALID",
      message: `${stateRelativePath} must declare mode: minimal or mode: debug`,
    });
  }

  const pathFindings = collectPathFindings(state);
  if (pathFindings.absolute.length && mode !== "debug") {
    findings.push({
      level: "ERROR",
      code: "STATE_ABSOLUTE_PATH",
      message: `${stateRelativePath} contains local absolute paths at ${pathFindings.absolute.join(", ")}`,
    });
  } else if (pathFindings.absolute.length) {
    findings.push({
      level: "WARN",
      code: "STATE_DEBUG_ABSOLUTE_PATH",
      message: `${stateRelativePath} is in debug mode and contains absolute paths at ${pathFindings.absolute.join(", ")}`,
    });
  }
  if (pathFindings.escape.length) {
    findings.push({
      level: "ERROR",
      code: "STATE_ESCAPE_PATH",
      message: `${stateRelativePath} contains project-escaping relative paths at ${pathFindings.escape.join(", ")}`,
    });
  }
  if (pathFindings.home.length) {
    findings.push({
      level: "ERROR",
      code: "STATE_HOME_PATH",
      message: `${stateRelativePath} contains home-directory paths at ${pathFindings.home.join(", ")}`,
    });
  }
}

function printFindings(findings: Finding[]): void {
  const errors = findings.filter((item) => item.level === "ERROR");
  const warns = findings.filter((item) => item.level === "WARN");

  if (!findings.length) {
    console.log("STATUS: PASS");
    console.log("Errors: 0  Warnings: 0");
    return;
  }

  const status = errors.length ? "BLOCKING" : "CONCERNS";
  console.log(`STATUS: ${status}`);
  console.log(`Errors: ${errors.length}  Warnings: ${warns.length}`);
  console.log("\nFINDINGS:");
  findings.forEach((finding) => {
    console.log(`- [${finding.level} ${finding.code}] ${finding.message}`);
  });

  if (errors.length) {
    process.exitCode = 1;
  }
}

function doctorCommand(args: SkillpoolDoctorArgs, options: DoctorOptions): void {
  const projectDir = resolveProjectDir(args);
  const strictHash = Boolean(args["strict-hash"] || args.strictHash);
  const stateSafety = Boolean(args["state-safety"] || args.stateSafety);
  const refreshCache = Boolean(args["refresh-cache"] || args.refreshCache);
  const findings: Finding[] = [];

  if (stateSafety) {
    addStateSafetyFindings(projectDir, findings);
  }

  const lockfilePath = resolveLockfilePath(projectDir, args);
  if (stateSafety && !fileExists(lockfilePath)) {
    printFindings(findings);
    return;
  }

  const loaded = loadLockfile(projectDir, args);
  const lockErrors = validateLockShape(loaded.lock);
  const explicitSource = typeof args.source === "string" && Boolean(args.source.trim());
  const shouldUsePlanSource = strictHash || explicitSource;

  if (lockErrors.length) {
    throw new Error(`Invalid lockfile (${loaded.lockfilePath}):\n- ${lockErrors.join("\n- ")}`);
  }

  const lock = loaded.lock as LockfileShape;

  const sourceLayout = shouldUsePlanSource
    ? resolveSourceLayout(
        resolveSourceRootForPlan(
          {
            repo: lock.repo,
            ref: lock.ref,
            source: args.source,
            installs: lock.installs,
          },
          refreshCache
        ),
        { requireSkills: true }
      )
    : resolveSourceLayout(path.resolve(options.toolRoot), { requireSkills: false });

  for (const installEntry of lock.installs) {
    const adapter = readAdapter(sourceLayout, installEntry.app);
    const targetBase = path.resolve(projectDir, adapter.targetPath);
    assertPathWithinProject(projectDir, targetBase, `Adapter '${installEntry.app}' targetPath`);
    assertNotHomeAgentsSkillsTarget(targetBase, `Adapter '${installEntry.app}' targetPath`);
    const expectedSkills = resolveSkillsForEntry(sourceLayout, installEntry) as string[];
    if (fileExists(targetBase)) {
      addPartialInstallFindings(targetBase, installEntry.app, findings);
    }

    if (!fileExists(targetBase)) {
      findings.push({
        level: "ERROR",
        code: "TARGET_MISSING",
        message: `Target path missing for app '${installEntry.app}': ${targetBase}`,
      });
      continue;
    }

    const expectedSet = new Set(expectedSkills);
    const presentSkills = fs
      .readdirSync(targetBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => fileExists(path.join(targetBase, name, "SKILL.md")));

    for (const skillName of expectedSkills) {
      const installedSkillPath = path.join(targetBase, skillName);
      const installedSkillEntry = path.join(installedSkillPath, "SKILL.md");
      if (!fileExists(installedSkillEntry)) {
        findings.push({
          level: "ERROR",
          code: "SKILL_MISSING",
          message: `${installEntry.app}/${skillName} not installed at ${installedSkillPath}`,
        });
        continue;
      }

      if (strictHash) {
        const sourceSkillPath = path.join(sourceLayout.skillsDir, skillName);
        if (!fileExists(path.join(sourceSkillPath, "SKILL.md"))) {
          findings.push({
            level: "ERROR",
            code: "SOURCE_SKILL_MISSING",
            message: `Skill missing in source for strict hash check: ${sourceSkillPath}`,
          });
        } else {
          const sourceDigest = dirDigest(sourceSkillPath);
          const installedDigest = dirDigest(installedSkillPath);
          if (sourceDigest !== installedDigest) {
            findings.push({
              level: "ERROR",
              code: "SKILL_DRIFT",
              message: `${installEntry.app}/${skillName} differs from lock source content`,
            });
          }
        }
      }
    }

    for (const existingSkill of presentSkills) {
      if (!expectedSet.has(existingSkill)) {
        findings.push({
          level: "WARN",
          code: "EXTRA_SKILL",
          message: `${installEntry.app}/${existingSkill} exists locally but not in lockfile`,
        });
      }
    }
  }

  printFindings(findings);
}

export {
  collectPathFindings,
  doctorCommand,
  isHomePath,
  isLocalAbsolutePath,
  isPathLikeField,
  normalizedPathEscapesProject,
  printFindings,
  stateMode,
};
