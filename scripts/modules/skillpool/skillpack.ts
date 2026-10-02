#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { ensureDir, fileExists, readJson, writeJson } from "../../lib/files.ts";
import { validateSkill as validateUniversalSkillContract } from "../../commands/universal-contract.ts";

export type SkillpackFindingLevel = "ERROR" | "WARN" | "INFO";

export type SkillpackFindingCode =
  | "MANIFEST"
  | "MISSING_FILE"
  | "CONTRACT"
  | "EVAL"
  | "PRIVACY"
  | "RISK"
  | "PATH";

export interface SkillpackFinding {
  level: SkillpackFindingLevel;
  code: SkillpackFindingCode;
  path: string;
  message: string;
}

export interface SkillpackManifest {
  $schema?: string;
  name?: unknown;
  version?: unknown;
  visibility?: unknown;
  engine?: {
    skillSys?: unknown;
    [key: string]: unknown;
  };
  skills?: unknown;
  profiles?: unknown;
  providers?: unknown;
  privacy?: {
    containsPersonalData?: unknown;
    containsLocalPaths?: unknown;
    containsCompanyData?: unknown;
    [key: string]: unknown;
  };
  security?: {
    requiresRiskProfiles?: unknown;
    requiresTriggerEvalsForRiskySkills?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SkillMetaRisk {
  readsFiles?: unknown;
  writesProject?: unknown;
  writesGlobal?: unknown;
  executesShell?: unknown;
  networkAccess?: unknown;
  externalDirectory?: unknown;
  credentialSensitive?: unknown;
  destructive?: unknown;
  browserAuthState?: unknown;
  repoMutation?: unknown;
}

export interface SkillMetaFile {
  name?: unknown;
  version?: unknown;
  contractVersion?: unknown;
  lifecycle?: unknown;
  risk?: SkillMetaRisk;
  invocation?: {
    implicitAllowed?: unknown;
    manualOnly?: unknown;
    requiresConfirmation?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ValidateSkillpackOptions {
  source: string;
  strict?: boolean;
}

export interface ValidateSkillpackResult {
  source: string;
  manifestPath: string;
  findings: SkillpackFinding[];
  blockingFindingCount: number;
}

export interface CreateSkillpackOptions {
  targetDir: string;
  name?: string;
  visibility?: "public" | "private";
  providers?: string[];
  profile?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface CreateSkillpackPlan {
  targetDir: string;
  files: string[];
  dryRun: boolean;
}

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const LOCAL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const RISKY_FLAGS: Array<keyof SkillMetaRisk> = [
  "executesShell",
  "writesProject",
  "writesGlobal",
  "networkAccess",
  "credentialSensitive",
  "destructive",
  "externalDirectory",
  "browserAuthState",
  "repoMutation",
];
const SKILL_META_RISK_KEYS: Array<keyof SkillMetaRisk> = [
  "readsFiles",
  "writesProject",
  "writesGlobal",
  "executesShell",
  "networkAccess",
  "externalDirectory",
  "credentialSensitive",
  "destructive",
  "browserAuthState",
  "repoMutation",
];
const SKILL_META_INVOCATION_KEYS = ["implicitAllowed", "manualOnly", "requiresConfirmation"] as const;
const LIFECYCLE_VALUES = new Set(["active", "deprecated", "experimental"]);

function toPosixRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/") || path.basename(filePath);
}

function normalizeSource(source: string): string {
  const sourceDir = path.resolve(source);
  if (!fileExists(sourceDir)) {
    throw new Error(`Skillpack source not found: ${sourceDir}`);
  }
  if (fs.lstatSync(sourceDir).isSymbolicLink()) {
    throw new Error(`Refusing to validate symlinked skillpack source: ${sourceDir}`);
  }
  if (!fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`Skillpack source is not a directory: ${sourceDir}`);
  }
  return sourceDir;
}

function pushFinding(findings: SkillpackFinding[], level: SkillpackFindingLevel, code: SkillpackFindingCode, findingPath: string, message: string): void {
  findings.push({ level, code, path: findingPath, message });
}

function requireString(findings: SkillpackFinding[], value: unknown, field: string, findingPath = "skillpack.json"): string | null {
  if (typeof value !== "string" || !value.trim()) {
    pushFinding(findings, "ERROR", "MANIFEST", findingPath, `${field} must be a non-empty string`);
    return null;
  }
  return value.trim();
}

function requireBoolean(findings: SkillpackFinding[], value: unknown, field: string, findingPath = "skillpack.json"): boolean | null {
  if (typeof value !== "boolean") {
    pushFinding(findings, "ERROR", "MANIFEST", findingPath, `${field} must be a boolean`);
    return null;
  }
  return value;
}

function requireStringArray(findings: SkillpackFinding[], value: unknown, field: string, options: { minItems?: number } = {}): string[] {
  if (!Array.isArray(value)) {
    pushFinding(findings, "ERROR", "MANIFEST", "skillpack.json", `${field} must be an array`);
    return [];
  }
  if ((options.minItems || 0) > value.length) {
    pushFinding(findings, "ERROR", "MANIFEST", "skillpack.json", `${field} must contain at least ${options.minItems} item(s)`);
  }
  const seen = new Set<string>();
  const output: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      pushFinding(findings, "ERROR", "MANIFEST", "skillpack.json", `${field}[${index}] must be a non-empty string`);
      return;
    }
    const normalized = item.trim();
    if (!LOCAL_NAME_PATTERN.test(normalized)) {
      pushFinding(findings, "ERROR", "PATH", "skillpack.json", `${field}[${index}] must be a relative identifier without path traversal`);
      return;
    }
    if (seen.has(normalized)) {
      pushFinding(findings, "ERROR", "MANIFEST", "skillpack.json", `${field} contains duplicate value '${normalized}'`);
      return;
    }
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}

function isTruthy(value: unknown): boolean {
  return value === true;
}

function riskyFlags(meta: SkillMetaFile): string[] {
  const risk = meta.risk || {};
  return RISKY_FLAGS.filter((flag) => isTruthy(risk[flag])).map(String);
}

function validateSkillMarkdownContract(findings: SkillpackFinding[], sourceDir: string, skill: string, skillRoot: string): void {
  const skillMdPath = path.join(skillRoot, "SKILL.md");
  for (const issue of validateUniversalSkillContract(skill, skillRoot)) {
    pushFinding(findings, "ERROR", "CONTRACT", toPosixRelative(sourceDir, skillMdPath), issue);
  }
}

function validateSkillMetaContract(findings: SkillpackFinding[], meta: SkillMetaFile, relativeMetaPath: string, skill: string): void {
  if (meta.name !== skill) {
    pushFinding(findings, "ERROR", "RISK", relativeMetaPath, `skill.meta.json.name must match skill directory '${skill}'`);
  }
  if (typeof meta.version !== "string" || !VERSION_PATTERN.test(meta.version)) {
    pushFinding(findings, "ERROR", "RISK", relativeMetaPath, "skill.meta.json.version must be semver-like (for example 1.0.0)");
  }
  if (typeof meta.contractVersion !== "string" || !meta.contractVersion.trim()) {
    pushFinding(findings, "ERROR", "RISK", relativeMetaPath, "skill.meta.json.contractVersion must be a non-empty string");
  }
  if (meta.lifecycle !== undefined && (typeof meta.lifecycle !== "string" || !LIFECYCLE_VALUES.has(meta.lifecycle))) {
    pushFinding(findings, "ERROR", "RISK", relativeMetaPath, "skill.meta.json.lifecycle must be active, deprecated, or experimental");
  }
  if (!meta.risk || typeof meta.risk !== "object" || Array.isArray(meta.risk)) {
    pushFinding(findings, "ERROR", "RISK", relativeMetaPath, "skill.meta.json.risk must be an object");
  } else {
    for (const key of SKILL_META_RISK_KEYS) {
      if (typeof meta.risk[key] !== "boolean") {
        pushFinding(findings, "ERROR", "RISK", relativeMetaPath, `skill.meta.json.risk.${key} must be boolean`);
      }
    }
  }
  if (!meta.invocation || typeof meta.invocation !== "object" || Array.isArray(meta.invocation)) {
    pushFinding(findings, "ERROR", "RISK", relativeMetaPath, "skill.meta.json.invocation must be an object");
  } else {
    for (const key of SKILL_META_INVOCATION_KEYS) {
      if (typeof meta.invocation[key] !== "boolean") {
        pushFinding(findings, "ERROR", "RISK", relativeMetaPath, `skill.meta.json.invocation.${key} must be boolean`);
      }
    }
  }
}

function validateTriggerEvalContract(findings: SkillpackFinding[], sourceDir: string, triggersPath: string, skill: string): void {
  const relativeTriggersPath = toPosixRelative(sourceDir, triggersPath);
  const triggers = readJson<Record<string, unknown>>(triggersPath);
  const positive = triggers.positive;
  const negative = triggers.negative;
  if (!Array.isArray(positive)) {
    pushFinding(findings, "ERROR", "EVAL", relativeTriggersPath, "triggers.positive must be an array");
  } else {
    positive.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        pushFinding(findings, "ERROR", "EVAL", relativeTriggersPath, `triggers.positive[${index}] must be an object`);
        return;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.prompt !== "string" || !record.prompt.trim()) {
        pushFinding(findings, "ERROR", "EVAL", relativeTriggersPath, `triggers.positive[${index}].prompt must be a non-empty string`);
      }
      if (record.expectedSkill !== skill) {
        pushFinding(findings, "ERROR", "EVAL", relativeTriggersPath, `triggers.positive[${index}].expectedSkill must be '${skill}'`);
      }
    });
  }
  if (!Array.isArray(negative)) {
    pushFinding(findings, "ERROR", "EVAL", relativeTriggersPath, "triggers.negative must be an array");
  } else {
    negative.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        pushFinding(findings, "ERROR", "EVAL", relativeTriggersPath, `triggers.negative[${index}] must be an object`);
        return;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.prompt !== "string" || !record.prompt.trim()) {
        pushFinding(findings, "ERROR", "EVAL", relativeTriggersPath, `triggers.negative[${index}].prompt must be a non-empty string`);
      }
      if (record.mustNotTrigger !== skill) {
        pushFinding(findings, "ERROR", "EVAL", relativeTriggersPath, `triggers.negative[${index}].mustNotTrigger must be '${skill}'`);
      }
    });
  }
}

function validateSkillMeta(findings: SkillpackFinding[], sourceDir: string, skill: string, options: { requiresRiskProfiles: boolean; requiresTriggerEvalsForRiskySkills: boolean }): void {
  const skillRoot = path.join(sourceDir, "skills", skill);
  const skillMetaPath = path.join(skillRoot, "skill.meta.json");
  const relativeMetaPath = toPosixRelative(sourceDir, skillMetaPath);
  if (!fileExists(skillMetaPath)) {
    if (options.requiresRiskProfiles) {
      pushFinding(findings, "ERROR", "RISK", relativeMetaPath, `${skill} is missing required risk metadata`);
    }
    return;
  }
  const meta = readJson<SkillMetaFile>(skillMetaPath);
  validateSkillMetaContract(findings, meta, relativeMetaPath, skill);
  const triggersPath = path.join(skillRoot, "evals", "triggers.json");
  if (fileExists(triggersPath)) {
    validateTriggerEvalContract(findings, sourceDir, triggersPath, skill);
  }
  const flags = riskyFlags(meta);
  if (!flags.length) {
    return;
  }
  if (meta.invocation?.implicitAllowed !== false) {
    pushFinding(
      findings,
      "ERROR",
      "RISK",
      relativeMetaPath,
      `${skill} declares risky capabilities (${flags.join(", ")}) but invocation.implicitAllowed is not false`
    );
  }
  if (meta.invocation?.manualOnly !== true) {
    pushFinding(
      findings,
      "WARN",
      "RISK",
      relativeMetaPath,
      `${skill} declares risky capabilities (${flags.join(", ")}) but invocation.manualOnly is not true`
    );
  }
  if (options.requiresTriggerEvalsForRiskySkills && !fileExists(triggersPath)) {
    pushFinding(findings, "ERROR", "RISK", toPosixRelative(sourceDir, triggersPath), `${skill} is risky and missing trigger eval fixtures`);
  }
}

export function validateSkillpack(options: ValidateSkillpackOptions): ValidateSkillpackResult {
  const sourceDir = normalizeSource(options.source);
  const manifestPath = path.join(sourceDir, "skillpack.json");
  const findings: SkillpackFinding[] = [];
  if (!fileExists(manifestPath)) {
    pushFinding(findings, "ERROR", "MISSING_FILE", "skillpack.json", "skillpack.json is required");
    return {
      source: sourceDir,
      manifestPath,
      findings,
      blockingFindingCount: findings.length,
    };
  }

  const manifest = readJson<SkillpackManifest>(manifestPath);
  const name = requireString(findings, manifest.name, "name");
  if (name && !PACKAGE_NAME_PATTERN.test(name)) {
    pushFinding(findings, "ERROR", "MANIFEST", "skillpack.json", "name must be a package-like lowercase identifier");
  }
  const version = requireString(findings, manifest.version, "version");
  if (version && !VERSION_PATTERN.test(version)) {
    pushFinding(findings, "ERROR", "MANIFEST", "skillpack.json", "version must be semver-like (for example 1.0.0)");
  }
  const visibility = requireString(findings, manifest.visibility, "visibility");
  if (visibility && visibility !== "public" && visibility !== "private") {
    pushFinding(findings, "ERROR", "MANIFEST", "skillpack.json", "visibility must be public or private");
  }
  if (!manifest.engine || typeof manifest.engine !== "object") {
    pushFinding(findings, "ERROR", "MANIFEST", "skillpack.json", "engine.skillSys is required");
  } else {
    requireString(findings, manifest.engine.skillSys, "engine.skillSys");
  }

  const skills = requireStringArray(findings, manifest.skills, "skills", { minItems: 1 });
  const profiles = requireStringArray(findings, manifest.profiles, "profiles");
  requireStringArray(findings, manifest.providers, "providers");

  const containsPersonalData = requireBoolean(findings, manifest.privacy?.containsPersonalData, "privacy.containsPersonalData");
  const containsLocalPaths = requireBoolean(findings, manifest.privacy?.containsLocalPaths, "privacy.containsLocalPaths");
  const containsCompanyData = requireBoolean(findings, manifest.privacy?.containsCompanyData, "privacy.containsCompanyData");
  if (visibility === "public" && (containsPersonalData || containsLocalPaths || containsCompanyData)) {
    pushFinding(findings, "ERROR", "PRIVACY", "skillpack.json", "public skillpacks must declare no personal, local-path, or company data");
  }

  const requiresRiskProfiles = requireBoolean(findings, manifest.security?.requiresRiskProfiles, "security.requiresRiskProfiles") === true;
  const requiresTriggerEvalsForRiskySkills = requireBoolean(
    findings,
    manifest.security?.requiresTriggerEvalsForRiskySkills,
    "security.requiresTriggerEvalsForRiskySkills"
  ) === true;

  for (const skill of skills) {
    const skillMdPath = path.join(sourceDir, "skills", skill, "SKILL.md");
    if (!fileExists(skillMdPath)) {
      pushFinding(findings, "ERROR", "MISSING_FILE", toPosixRelative(sourceDir, skillMdPath), `${skill} is listed but SKILL.md is missing`);
      continue;
    }
    validateSkillMarkdownContract(findings, sourceDir, skill, path.dirname(skillMdPath));
    validateSkillMeta(findings, sourceDir, skill, { requiresRiskProfiles, requiresTriggerEvalsForRiskySkills });
  }

  for (const profile of profiles) {
    const profilePath = path.join(sourceDir, "profiles", `${profile}.json`);
    if (!fileExists(profilePath)) {
      pushFinding(findings, "ERROR", "MISSING_FILE", toPosixRelative(sourceDir, profilePath), `${profile} profile is listed but missing`);
    }
  }

  const blockingFindingCount = findings.filter((finding) => finding.level === "ERROR" || (options.strict && finding.level === "WARN")).length;
  return {
    source: sourceDir,
    manifestPath,
    findings: findings.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message)),
    blockingFindingCount,
  };
}

export function formatSkillpackFindings(findings: SkillpackFinding[]): string {
  return findings.map((finding) => `- [${finding.level} ${finding.code}] ${finding.path} ${finding.message}`).join("\n");
}

function defaultSkillpackName(targetDir: string): string {
  return path.basename(path.resolve(targetDir)).replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase() || "my-skillpack";
}

function normalizeLocalIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!LOCAL_NAME_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a lowercase identifier without slashes or path traversal`);
  }
  return normalized;
}

function normalizeProviderList(providers: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  providers.forEach((provider, index) => {
    const value = normalizeLocalIdentifier(provider, `providers[${index}]`);
    if (seen.has(value)) {
      throw new Error(`providers contains duplicate value '${value}'`);
    }
    seen.add(value);
    normalized.push(value);
  });
  return normalized;
}

function normalizeSkillpackName(value: string): string {
  const normalized = value.trim();
  if (!PACKAGE_NAME_PATTERN.test(normalized)) {
    throw new Error("name must be a package-like lowercase identifier");
  }
  return normalized;
}

function normalizeVisibility(value: unknown): "public" | "private" {
  if (value === undefined) {
    return "public";
  }
  if (value === "public" || value === "private") {
    return value;
  }
  throw new Error("visibility must be public or private");
}

export function createSkillpack(options: CreateSkillpackOptions): CreateSkillpackPlan {
  const targetDir = path.resolve(options.targetDir);
  const profile = normalizeLocalIdentifier(options.profile || "default", "profile");
  const providers = normalizeProviderList(options.providers?.length ? options.providers : ["codex", "opencode"]);
  const visibility = normalizeVisibility(options.visibility);
  const packageName = normalizeSkillpackName(options.name || defaultSkillpackName(targetDir));
  const exampleSkill = "example-skill";
  const files = [
    "skillpack.json",
    `profiles/${profile}.json`,
    `skills/${exampleSkill}/SKILL.md`,
    `skills/${exampleSkill}/skill.meta.json`,
    `skills/${exampleSkill}/evals/triggers.json`,
  ];

  if (options.dryRun) {
    return { targetDir, files, dryRun: true };
  }

  if (fileExists(targetDir)) {
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      throw new Error(`Skillpack target already exists and is not a directory: ${targetDir}`);
    }
    const entries = fs.readdirSync(targetDir).filter((entry) => entry !== ".DS_Store");
    if (entries.length && !options.force) {
      throw new Error(`Skillpack target already exists and is not empty: ${targetDir}`);
    }
  }

  ensureDir(targetDir);
  writeJson(path.join(targetDir, "skillpack.json"), {
    $schema: "https://skill-sys.dev/schemas/skillpack.schema.json",
    name: packageName,
    version: "0.1.0",
    visibility,
    engine: {
      skillSys: ">=0.4.0",
    },
    skills: [exampleSkill],
    profiles: [profile],
    providers,
    privacy: {
      containsPersonalData: visibility === "private",
      containsLocalPaths: false,
      containsCompanyData: false,
    },
    security: {
      requiresRiskProfiles: true,
      requiresTriggerEvalsForRiskySkills: true,
    },
  });
  writeJson(path.join(targetDir, "profiles", `${profile}.json`), {
    name: profile,
    description: "Example skillpack profile",
    skills: [exampleSkill],
  });
  ensureDir(path.join(targetDir, "skills", exampleSkill));
  fs.writeFileSync(
    path.join(targetDir, "skills", exampleSkill, "SKILL.md"),
    `---\nname: ${exampleSkill}\ndescription: Use when demonstrating a sanitized Skill-Sys skillpack.\nmetadata:\n  category: examples\n  tags: "example-skill, skillpack"\n  triggers: "example skillpack, sanitized skillpack"\n  version: "0.1.0"\n  updated_at: "2026-06-06T00:00:00Z"\n  target_provider: universal\n---\n# Example Skill\n\nUse this synthetic skill as a safe placeholder when validating the skillpack\ncontract. Replace it with real public content only after privacy and risk review.\n`,
    "utf8"
  );
  writeJson(path.join(targetDir, "skills", exampleSkill, "skill.meta.json"), {
    name: exampleSkill,
    version: "0.1.0",
    contractVersion: "1.0",
    lifecycle: "active",
    risk: {
      readsFiles: false,
      writesProject: false,
      writesGlobal: false,
      executesShell: false,
      networkAccess: false,
      externalDirectory: false,
      credentialSensitive: false,
      destructive: false,
      browserAuthState: false,
      repoMutation: false,
    },
    invocation: {
      implicitAllowed: true,
      manualOnly: false,
      requiresConfirmation: false,
    },
  });
  writeJson(path.join(targetDir, "skills", exampleSkill, "evals", "triggers.json"), {
    positive: [
      {
        prompt: "Validate this example skillpack.",
        expectedSkill: exampleSkill,
      },
    ],
    negative: [
      {
        prompt: "Operate my private workflow.",
        mustNotTrigger: exampleSkill,
      },
    ],
  });
  return { targetDir, files, dryRun: false };
}
