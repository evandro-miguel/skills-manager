#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { fileExists, readJson } from "../../lib/files.ts";
import { readAdapter, resolveSkillsForEntry } from "./entry.ts";
import { resolveLockfilePath, resolveProjectDir } from "./lockfile.ts";
import { compareSemver, normalizeSemver, validateLockShape } from "./plan.ts";
import { formatSensitiveFindings, scanSensitiveFiles } from "./sensitive-scan.ts";
import { collectArtifactSurfaceEntries } from "./artifact-surface.ts";
import { readProviderCapabilities } from "./providers.ts";
import { readSkillMeta } from "./skill-meta.ts";
import { resolvePoolRoot, resolveSourceLayout } from "./source.ts";

const DEFAULT_LIFECYCLE_FILE = "skill-lifecycle.json";

interface SourceLayout {
  kind: "flat" | "monorepo-root" | "nested-app" | "skillpack";
  skillsDir: string;
  adaptersDir: string;
  profilesDir: string;
}

interface AuditResult {
  ok: boolean;
  message: string;
}

interface Finding {
  level: "ERROR" | "WARN";
  code: string;
  message: string;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface SkillpoolValidateArgs {
  project?: string;
  lockfile?: string;
  source?: string;
}

interface ValidateCommandOptions {
  toolRoot: string;
  universalContractScript: string;
  skillMetadataScript: string;
  skillLifecycleScript: string;
  runUniversalContract?: typeof runUniversalContract;
  runSkillMetadataAudit?: typeof runSkillMetadataAudit;
  runSkillLifecycleAudit?: typeof runSkillLifecycleAudit;
  runSensitiveScan?: typeof runSensitiveScan;
}

function runAuditScript(scriptPath: string, args: string[]): AuditResult {
  if (!fileExists(scriptPath)) {
    return {
      ok: false,
      message: `Script not found: ${scriptPath}`,
    };
  }

  const proc = Bun.spawnSync(["bun", scriptPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = proc.stdout ? Buffer.from(proc.stdout).toString("utf8").trim() : "";
  const stderr = proc.stderr ? Buffer.from(proc.stderr).toString("utf8").trim() : "";

  if (proc.exitCode === 0) {
    return { ok: true, message: stdout };
  }

  return {
    ok: false,
    message: [stdout, stderr].filter(Boolean).join("\n"),
  };
}

function runUniversalContract(skillsDir: string, scriptPath: string): AuditResult {
  if (!fileExists(scriptPath)) {
    return {
      ok: false,
      message: `Universal contract script not found: ${scriptPath}`,
    };
  }

  return runAuditScript(scriptPath, ["--skills-root", skillsDir]);
}

function runSkillMetadataAudit(skillsDir: string, scriptPath: string): AuditResult {
  if (!fileExists(scriptPath)) {
    return {
      ok: false,
      message: `Skill metadata script not found: ${scriptPath}`,
    };
  }

  return runAuditScript(scriptPath, ["audit", "--skills-root", skillsDir, "--strict"]);
}

function runSkillLifecycleAudit(
  poolRoot: string,
  skillsDir: string,
  scriptPath: string,
  lifecycleFile = DEFAULT_LIFECYCLE_FILE
): AuditResult {
  const lifecyclePath = path.join(poolRoot, lifecycleFile);
  if (!fileExists(lifecyclePath)) {
    return {
      ok: false,
      message: `Skill lifecycle changelog not found: ${lifecyclePath}`,
    };
  }
  if (!fileExists(scriptPath)) {
    return {
      ok: false,
      message: `Skill lifecycle script not found: ${scriptPath}`,
    };
  }

  return runAuditScript(scriptPath, [
    "audit",
    "--file",
    lifecyclePath,
    "--skills-root",
    skillsDir,
  ]);
}

function runSensitiveScan(sourceRoot: string, layout: SourceLayout): AuditResult {
  const findings = scanSensitiveFiles({
    rootDir: layout.skillsDir,
    baseDir: sourceRoot,
  });
  if (!findings.length) {
    return { ok: true, message: "ok" };
  }
  return {
    ok: false,
    message: formatSensitiveFindings(findings),
  };
}

function getPoolVersion(sourceRoot: string, layout: SourceLayout): string | null {
  const poolRoot = resolvePoolRoot(sourceRoot, layout);
  const packagePath = path.join(poolRoot, "package.json");
  if (!fileExists(packagePath)) {
    return null;
  }
  if (fs.lstatSync(packagePath).isSymbolicLink()) {
    throw new Error(`Refusing to read symlinked package.json file: ${packagePath}`);
  }
  const parsed = readJson(packagePath) as JsonRecord;
  return normalizeSemver(parsed.version);
}

function readValidationJson(fullPath: string, label: string): JsonRecord {
  if (fs.lstatSync(fullPath).isSymbolicLink()) {
    throw new Error(`Refusing to read symlinked ${label}: ${fullPath}`);
  }
  return readJson(fullPath) as JsonRecord;
}

function validateSourceStructure(sourceRoot: string): Finding[] {
  const findings: Finding[] = [];
  let layout: SourceLayout;

  try {
    layout = resolveSourceLayout(sourceRoot, { requireSkills: true }) as SourceLayout;
  } catch (error) {
    findings.push({
      level: "ERROR",
      code: "SOURCE_DIR_MISSING",
      message: error instanceof Error ? error.message : String(error),
    });
    return findings;
  }

  const requiredDirs = [layout.skillsDir, layout.adaptersDir, layout.profilesDir];

  for (const dirPath of requiredDirs) {
    if (!fileExists(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      findings.push({
        level: "ERROR",
        code: "SOURCE_DIR_MISSING",
        message: `Missing required directory: ${dirPath}`,
      });
    }
  }

  try {
    const poolRoot = resolvePoolRoot(sourceRoot, layout);
    collectArtifactSurfaceEntries(sourceRoot, poolRoot, layout);
    if (fileExists(path.join(poolRoot, "providers"))) {
      readProviderCapabilities(poolRoot);
    }
  } catch (error) {
    findings.push({
      level: "ERROR",
      code: "ARTIFACT_SURFACE_INVALID",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (fileExists(layout.skillsDir) && fs.statSync(layout.skillsDir).isDirectory()) {
    for (const entry of fs.readdirSync(layout.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        readSkillMeta(path.join(layout.skillsDir, entry.name), entry.name);
      } catch (error) {
        findings.push({
          level: "ERROR",
          code: "SKILL_META_INVALID",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const adaptersDir = layout.adaptersDir;
  if (fileExists(adaptersDir) && fs.statSync(adaptersDir).isDirectory()) {
    for (const fileName of fs.readdirSync(adaptersDir)) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const fullPath = path.join(adaptersDir, fileName);
      try {
        const adapter = readValidationJson(fullPath, "adapter JSON");
        if (!adapter.name || typeof adapter.name !== "string") {
          findings.push({
            level: "ERROR",
            code: "ADAPTER_NAME_INVALID",
            message: `${fullPath} missing adapter.name`,
          });
        }
        if (!adapter.targetPath || typeof adapter.targetPath !== "string") {
          findings.push({
            level: "ERROR",
            code: "ADAPTER_TARGET_INVALID",
            message: `${fullPath} missing adapter.targetPath`,
          });
        }
      } catch (error: unknown) {
        findings.push({
          level: "ERROR",
          code: "ADAPTER_JSON_INVALID",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const profilesDir = layout.profilesDir;
  if (fileExists(profilesDir) && fs.statSync(profilesDir).isDirectory()) {
    for (const fileName of fs.readdirSync(profilesDir)) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const fullPath = path.join(profilesDir, fileName);
      try {
        const profile = readValidationJson(fullPath, "profile JSON");
        if (!profile.name || typeof profile.name !== "string") {
          findings.push({
            level: "ERROR",
            code: "PROFILE_NAME_INVALID",
            message: `${fullPath} missing profile.name`,
          });
        }
        if (!Array.isArray(profile.skills) || profile.skills.length === 0) {
          findings.push({
            level: "ERROR",
            code: "PROFILE_SKILLS_INVALID",
            message: `${fullPath} requires non-empty skills[]`,
          });
        }

        const profileSkills = Array.isArray(profile.skills) ? profile.skills : [];
        const missingSkills = profileSkills.filter(
          (skillName: unknown) => !fileExists(path.join(layout.skillsDir, String(skillName), "SKILL.md"))
        );

        if (missingSkills.length) {
          findings.push({
            level: "ERROR",
            code: "PROFILE_SKILL_MISSING",
            message: `${fullPath} references missing skills: ${missingSkills.join(", ")}`,
          });
        }
      } catch (error: unknown) {
        findings.push({
          level: "ERROR",
          code: "PROFILE_JSON_INVALID",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return findings;
}

function validateCommand(args: SkillpoolValidateArgs, options: ValidateCommandOptions): void {
  const projectDir = resolveProjectDir(args);
  const sourceRoot = args.source ? path.resolve(args.source) : options.toolRoot;
  const findings = validateSourceStructure(sourceRoot);
  const sourceLayout = resolveSourceLayout(sourceRoot, { requireSkills: true }) as SourceLayout;
  const poolRoot = resolvePoolRoot(sourceRoot, sourceLayout);
  const universalContract = (options.runUniversalContract ?? runUniversalContract)(
    sourceLayout.skillsDir,
    options.universalContractScript
  );
  const metadataAudit = (options.runSkillMetadataAudit ?? runSkillMetadataAudit)(
    sourceLayout.skillsDir,
    options.skillMetadataScript
  );
  const lifecycleAudit = (options.runSkillLifecycleAudit ?? runSkillLifecycleAudit)(
    poolRoot,
    sourceLayout.skillsDir,
    options.skillLifecycleScript
  );
  const sensitiveScan = (options.runSensitiveScan ?? runSensitiveScan)(
    sourceRoot,
    sourceLayout
  );

  if (!universalContract.ok) {
    findings.push({
      level: "ERROR",
      code: "UNIVERSAL_CONTRACT_INVALID",
      message: universalContract.message,
    });
  }

  if (!metadataAudit.ok) {
    findings.push({
      level: "ERROR",
      code: "SKILL_METADATA_INVALID",
      message: metadataAudit.message,
    });
  }

  if (!lifecycleAudit.ok) {
    findings.push({
      level: "ERROR",
      code: "SKILL_LIFECYCLE_INVALID",
      message: lifecycleAudit.message,
    });
  }

  if (!sensitiveScan.ok) {
    findings.push({
      level: "ERROR",
      code: "SENSITIVE_SCAN_FAILED",
      message: sensitiveScan.message,
    });
  }

  const lockfilePath = resolveLockfilePath(projectDir, args);
  if (fileExists(lockfilePath)) {
    const lock = readJson(lockfilePath) as JsonRecord;
    const lockErrors = validateLockShape(lock);
    lockErrors.forEach((message: string) => {
      findings.push({
        level: "ERROR",
        code: "LOCKFILE_INVALID",
        message,
      });
    });

    if (lockErrors.length === 0) {
      const layout = resolveSourceLayout(sourceRoot, { requireSkills: true }) as SourceLayout;

      const lockPolicy = lock.policy as Record<string, unknown> | undefined;
      if (lockPolicy && typeof lockPolicy.minPoolVersion === "string") {
        const minVersion = normalizeSemver(lockPolicy.minPoolVersion);
        let poolVersion: string | null = null;
        try {
          poolVersion = getPoolVersion(sourceRoot, layout);
        } catch (error) {
          findings.push({
            level: "ERROR",
            code: "SOURCE_PACKAGE_INVALID",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (!poolVersion || !minVersion || compareSemver(poolVersion, minVersion) < 0) {
          findings.push({
            level: "ERROR",
            code: "LOCKFILE_POLICY_MIN_VERSION_FAILED",
            message: `Source version ${poolVersion || "unknown"} is below required ${minVersion || "invalid"}`,
          });
        }
      }

      const lockInstalls = lock.installs as Array<Record<string, unknown>> | undefined;
      for (const entry of lockInstalls ?? []) {
        try {
          readAdapter(layout, entry.app);
          resolveSkillsForEntry(layout, entry);
        } catch (error: unknown) {
          findings.push({
            level: "ERROR",
            code: "LOCKFILE_REFERENCE_INVALID",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

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

export {
  getPoolVersion,
  runSkillLifecycleAudit,
  runSkillMetadataAudit,
  runUniversalContract,
  validateCommand,
  validateSourceStructure,
};
