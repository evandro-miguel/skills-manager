#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { fileExists, readJson } from "../../lib/files.ts";
import { parseFrontmatter, parseCsv } from "../skill-metadata-lib.ts";
import { parseProviderList, type ConcreteProviderId } from "./providers.ts";
import { resolvePoolRoot, resolveSourceLayout } from "./source.ts";

const TRIGGERS_FIXTURE_PATH = path.join("evals", "triggers.json");
const DEFAULT_CODEX_BUDGET = 8000;

type FindingLevel = "ERROR" | "WARN";

interface SemanticFinding {
  level: FindingLevel;
  code: string;
  skill?: string;
  path?: string;
  message: string;
}

interface SkillDescriptionRecord {
  name: string;
  relativePath: string;
  description: string;
  triggers: string[];
}

interface PositiveTriggerCase {
  prompt: string;
  expectedSkill: string;
}

interface NegativeTriggerCase {
  prompt: string;
  mustNotTrigger: string;
}

interface AmbiguousTriggerCase {
  prompt: string;
  expected: string;
}

interface CollisionTriggerCase {
  prompt: string;
  allowed: string[];
  preferred?: string;
}

interface TriggerEvalFixture {
  positive?: PositiveTriggerCase[];
  negative?: NegativeTriggerCase[];
  ambiguous?: AmbiguousTriggerCase[];
  collision?: CollisionTriggerCase[];
}

interface TriggerEvalResult {
  provider: ConcreteProviderId;
  fixtureCount: number;
  caseCount: number;
  findings: SemanticFinding[];
}

interface SemanticAuditResult {
  skillCount: number;
  findings: SemanticFinding[];
}

interface BudgetSkillRecord {
  skill: string;
  listingChars: number;
  descriptionChars: number;
  globalCore: boolean;
}

interface BudgetDoctorResult {
  provider: ConcreteProviderId;
  scope: "all" | "global-core";
  budget: number;
  current: number;
  skills: BudgetSkillRecord[];
  findings: SemanticFinding[];
}

function toRelative(baseDir: string, filePath: string): string {
  return path.relative(baseDir, filePath).replaceAll("\\", "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function listSkillDirs(sourceRoot: string): { poolRoot: string; skillsDir: string; names: string[] } {
  const layout = resolveSourceLayout(sourceRoot, { requireSkills: true });
  const poolRoot = resolvePoolRoot(sourceRoot, layout);
  const names = fs
    .readdirSync(layout.skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  return { poolRoot, skillsDir: layout.skillsDir, names };
}

function readSkillDescription(sourceRoot: string, skillsDir: string, skillName: string): SkillDescriptionRecord {
  const skillPath = path.join(skillsDir, skillName, "SKILL.md");
  if (!fileExists(skillPath)) {
    throw new Error(`Missing SKILL.md for ${skillName}`);
  }
  const parsed = parseFrontmatter(fs.readFileSync(skillPath, "utf8"));
  if (!parsed.ok) {
    throw new Error(`${toRelative(sourceRoot, skillPath)}: ${parsed.error}`);
  }
  return {
    name: String(parsed.top.name || skillName),
    relativePath: toRelative(sourceRoot, skillPath),
    description: String(parsed.top.description || ""),
    triggers: parseCsv(parsed.metadata.triggers),
  };
}

function readSkillDescriptions(sourceRoot: string): SkillDescriptionRecord[] {
  const { skillsDir, names } = listSkillDirs(sourceRoot);
  return names.map((name) => readSkillDescription(sourceRoot, skillsDir, name));
}

function stringField(value: unknown, label: string, findings: SemanticFinding[], context: Partial<SemanticFinding>): string {
  if (typeof value !== "string" || !value.trim()) {
    findings.push({
      level: "ERROR",
      code: "INVALID_TRIGGER_FIXTURE",
      ...context,
      message: `${label} must be a non-empty string`,
    });
    return "";
  }
  return value.trim();
}

function stringArrayField(value: unknown, label: string, findings: SemanticFinding[], context: Partial<SemanticFinding>): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    findings.push({
      level: "ERROR",
      code: "INVALID_TRIGGER_FIXTURE",
      ...context,
      message: `${label} must be an array of non-empty strings`,
    });
    return [];
  }
  return value.map((item) => item.trim());
}

function normalizeFixture(value: unknown, label: string, findings: SemanticFinding[], context: Partial<SemanticFinding>): TriggerEvalFixture {
  if (!isRecord(value)) {
    findings.push({
      level: "ERROR",
      code: "INVALID_TRIGGER_FIXTURE",
      ...context,
      message: `${label} must be an object`,
    });
    return {};
  }

  const allowedKeys = new Set(["positive", "negative", "ambiguous", "collision", "$schema"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      findings.push({
        level: "ERROR",
        code: "INVALID_TRIGGER_FIXTURE",
        ...context,
        message: `${label}.${key} is not supported`,
      });
    }
  }
  if (value.$schema !== undefined && (typeof value.$schema !== "string" || !value.$schema.trim())) {
    findings.push({
      level: "ERROR",
      code: "INVALID_TRIGGER_FIXTURE",
      ...context,
      message: `${label}.$schema must be a non-empty string`,
    });
  }

  const fixture: TriggerEvalFixture = {};
  if (value.positive !== undefined) {
    fixture.positive = normalizePositiveCases(value.positive, `${label}.positive`, findings, context);
  }
  if (value.negative !== undefined) {
    fixture.negative = normalizeNegativeCases(value.negative, `${label}.negative`, findings, context);
  }
  if (value.ambiguous !== undefined) {
    fixture.ambiguous = normalizeAmbiguousCases(value.ambiguous, `${label}.ambiguous`, findings, context);
  }
  if (value.collision !== undefined) {
    fixture.collision = normalizeCollisionCases(value.collision, `${label}.collision`, findings, context);
  }
  return fixture;
}

function normalizePositiveCases(value: unknown, label: string, findings: SemanticFinding[], context: Partial<SemanticFinding>): PositiveTriggerCase[] {
  if (!Array.isArray(value)) {
    findings.push({ level: "ERROR", code: "INVALID_TRIGGER_FIXTURE", ...context, message: `${label} must be an array` });
    return [];
  }
  return value.map((item, index) => {
    const itemContext = { ...context, message: "" };
    if (!isRecord(item)) {
      findings.push({ level: "ERROR", code: "INVALID_TRIGGER_FIXTURE", ...context, message: `${label}[${index}] must be an object` });
      return { prompt: "", expectedSkill: "" };
    }
    return {
      prompt: stringField(item.prompt, `${label}[${index}].prompt`, findings, itemContext),
      expectedSkill: stringField(item.expectedSkill, `${label}[${index}].expectedSkill`, findings, itemContext),
    };
  });
}

function normalizeNegativeCases(value: unknown, label: string, findings: SemanticFinding[], context: Partial<SemanticFinding>): NegativeTriggerCase[] {
  if (!Array.isArray(value)) {
    findings.push({ level: "ERROR", code: "INVALID_TRIGGER_FIXTURE", ...context, message: `${label} must be an array` });
    return [];
  }
  return value.map((item, index) => {
    const itemContext = { ...context, message: "" };
    if (!isRecord(item)) {
      findings.push({ level: "ERROR", code: "INVALID_TRIGGER_FIXTURE", ...context, message: `${label}[${index}] must be an object` });
      return { prompt: "", mustNotTrigger: "" };
    }
    return {
      prompt: stringField(item.prompt, `${label}[${index}].prompt`, findings, itemContext),
      mustNotTrigger: stringField(item.mustNotTrigger, `${label}[${index}].mustNotTrigger`, findings, itemContext),
    };
  });
}

function normalizeAmbiguousCases(value: unknown, label: string, findings: SemanticFinding[], context: Partial<SemanticFinding>): AmbiguousTriggerCase[] {
  if (!Array.isArray(value)) {
    findings.push({ level: "ERROR", code: "INVALID_TRIGGER_FIXTURE", ...context, message: `${label} must be an array` });
    return [];
  }
  return value.map((item, index) => {
    const itemContext = { ...context, message: "" };
    if (!isRecord(item)) {
      findings.push({ level: "ERROR", code: "INVALID_TRIGGER_FIXTURE", ...context, message: `${label}[${index}] must be an object` });
      return { prompt: "", expected: "" };
    }
    return {
      prompt: stringField(item.prompt, `${label}[${index}].prompt`, findings, itemContext),
      expected: stringField(item.expected, `${label}[${index}].expected`, findings, itemContext),
    };
  });
}

function normalizeCollisionCases(value: unknown, label: string, findings: SemanticFinding[], context: Partial<SemanticFinding>): CollisionTriggerCase[] {
  if (!Array.isArray(value)) {
    findings.push({ level: "ERROR", code: "INVALID_TRIGGER_FIXTURE", ...context, message: `${label} must be an array` });
    return [];
  }
  return value.map((item, index) => {
    const itemContext = { ...context, message: "" };
    if (!isRecord(item)) {
      findings.push({ level: "ERROR", code: "INVALID_TRIGGER_FIXTURE", ...context, message: `${label}[${index}] must be an object` });
      return { prompt: "", allowed: [] };
    }
    return {
      prompt: stringField(item.prompt, `${label}[${index}].prompt`, findings, itemContext),
      allowed: stringArrayField(item.allowed, `${label}[${index}].allowed`, findings, itemContext),
      ...(item.preferred === undefined
        ? {}
        : { preferred: stringField(item.preferred, `${label}[${index}].preferred`, findings, itemContext) }),
    };
  });
}

function meaningfulTokens(value: string): Set<string> {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "as",
    "com",
    "de",
    "do",
    "for",
    "in",
    "of",
    "or",
    "the",
    "to",
    "use",
    "using",
    "when",
    "with",
  ]);
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !stopWords.has(token))
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) {
    return 1;
  }
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) {
      intersection += 1;
    }
  }
  return intersection / new Set([...left, ...right]).size;
}

function countFixtureCases(fixture: TriggerEvalFixture): number {
  return (
    (fixture.positive?.length || 0) +
    (fixture.negative?.length || 0) +
    (fixture.ambiguous?.length || 0) +
    (fixture.collision?.length || 0)
  );
}

function validateFixtureSemantics(
  skillName: string,
  fixture: TriggerEvalFixture,
  skills: Map<string, SkillDescriptionRecord>,
  findings: SemanticFinding[],
  context: Partial<SemanticFinding>
): void {
  const description = skills.get(skillName);
  const descriptionTokens = meaningfulTokens(`${description?.description || ""} ${(description?.triggers || []).join(" ")}`);

  for (const item of fixture.positive || []) {
    if (item.expectedSkill && item.expectedSkill !== skillName) {
      findings.push({
        level: "ERROR",
        code: "TRIGGER_EXPECTED_SKILL_MISMATCH",
        ...context,
        message: `positive expectedSkill '${item.expectedSkill}' must match fixture skill '${skillName}'`,
      });
    }
    if (item.prompt && jaccard(meaningfulTokens(item.prompt), descriptionTokens) === 0) {
      findings.push({
        level: "WARN",
        code: "TRIGGER_PROMPT_LOW_OVERLAP",
        ...context,
        message: `positive prompt has no token overlap with ${skillName} description/triggers: ${item.prompt}`,
      });
    }
  }

  for (const item of fixture.negative || []) {
    if (item.mustNotTrigger && item.mustNotTrigger !== skillName) {
      findings.push({
        level: "ERROR",
        code: "TRIGGER_NEGATIVE_SKILL_MISMATCH",
        ...context,
        message: `negative mustNotTrigger '${item.mustNotTrigger}' must match fixture skill '${skillName}'`,
      });
    }
  }

  for (const item of fixture.ambiguous || []) {
    if (item.expected && item.expected !== "no_implicit_trigger" && item.expected !== "manual_review") {
      findings.push({
        level: "ERROR",
        code: "TRIGGER_AMBIGUOUS_EXPECTED_INVALID",
        ...context,
        message: `ambiguous expected '${item.expected}' must be no_implicit_trigger or manual_review`,
      });
    }
  }

  for (const item of fixture.collision || []) {
    if (item.allowed.length && !item.allowed.includes(skillName)) {
      findings.push({
        level: "ERROR",
        code: "TRIGGER_COLLISION_ALLOWED_MISMATCH",
        ...context,
        message: `collision allowed list must include fixture skill '${skillName}'`,
      });
    }
    for (const allowedSkill of item.allowed) {
      if (!skills.has(allowedSkill)) {
        findings.push({
          level: "ERROR",
          code: "TRIGGER_COLLISION_UNKNOWN_SKILL",
          ...context,
          message: `collision allowed skill does not exist: ${allowedSkill}`,
        });
      }
    }
    if (item.preferred && !item.allowed.includes(item.preferred)) {
      findings.push({
        level: "ERROR",
        code: "TRIGGER_COLLISION_PREFERRED_MISMATCH",
        ...context,
        message: `collision preferred skill '${item.preferred}' must be present in allowed`,
      });
    }
  }
}

function evaluateTriggerFixtures(options: {
  sourceRoot: string;
  provider: ConcreteProviderId;
  mode: "triggers" | "collisions";
}): TriggerEvalResult {
  const sourceRoot = path.resolve(options.sourceRoot);
  const { poolRoot, skillsDir, names } = listSkillDirs(sourceRoot);
  const skills = new Map<string, SkillDescriptionRecord>();
  for (const name of names) {
    skills.set(name, readSkillDescription(sourceRoot, skillsDir, name));
  }

  const findings: SemanticFinding[] = [];
  let fixtureCount = 0;
  let caseCount = 0;

  for (const skillName of names) {
    const fixturePath = path.join(skillsDir, skillName, TRIGGERS_FIXTURE_PATH);
    if (!fileExists(fixturePath)) {
      continue;
    }
    if (fs.lstatSync(fixturePath).isSymbolicLink()) {
      findings.push({
        level: "ERROR",
        code: "TRIGGER_FIXTURE_SYMLINK",
        skill: skillName,
        path: toRelative(poolRoot, fixturePath),
        message: `Refusing symlinked trigger fixture: ${toRelative(poolRoot, fixturePath)}`,
      });
      continue;
    }
    const context = {
      skill: skillName,
      path: toRelative(poolRoot, fixturePath),
    };
    const fixture = normalizeFixture(readJson(fixturePath), context.path, findings, context);
    fixtureCount += 1;
    caseCount += countFixtureCases(fixture);
    validateFixtureSemantics(skillName, fixture, skills, findings, context);
    if (options.mode === "collisions" && !(fixture.collision || []).length) {
      findings.push({
        level: "WARN",
        code: "TRIGGER_COLLISION_CASES_MISSING",
        ...context,
        message: `${context.path} has no collision cases`,
      });
    }
  }

  if (fixtureCount === 0) {
    findings.push({
      level: "WARN",
      code: "TRIGGER_FIXTURES_MISSING",
      message: `No ${TRIGGERS_FIXTURE_PATH} fixtures found`,
    });
  }

  return {
    provider: options.provider,
    fixtureCount,
    caseCount,
    findings,
  };
}

function semanticAudit(options: { sourceRoot: string; maxDescriptionSimilarity?: number }): SemanticAuditResult {
  const sourceRoot = path.resolve(options.sourceRoot);
  const skills = readSkillDescriptions(sourceRoot);
  const maxSimilarity = options.maxDescriptionSimilarity ?? 0.96;
  const findings: SemanticFinding[] = [];
  const promptInjection = /\b(ignore|disregard)\s+(all\s+)?(previous|prior|above)\s+instructions\b|\bsystem prompt\b|\bdeveloper message\b/i;
  const broadCapture = /\b(always use|must use|use this skill for any|for any task|for all tasks|for everything|every task)\b/i;

  for (const skill of skills) {
    if (promptInjection.test(skill.description)) {
      findings.push({
        level: "ERROR",
        code: "DESCRIPTION_PROMPT_INJECTION",
        skill: skill.name,
        path: skill.relativePath,
        message: `${skill.name} description contains prompt-injection-shaped language`,
      });
    }
    if (broadCapture.test(skill.description)) {
      findings.push({
        level: "ERROR",
        code: "DESCRIPTION_SCOPE_CAPTURE",
        skill: skill.name,
        path: skill.relativePath,
        message: `${skill.name} description over-captures activation scope`,
      });
    }
  }

  for (let leftIndex = 0; leftIndex < skills.length; leftIndex += 1) {
    const left = skills[leftIndex]!;
    const leftTokens = meaningfulTokens(left.description);
    if (leftTokens.size < 6) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < skills.length; rightIndex += 1) {
      const right = skills[rightIndex]!;
      const rightTokens = meaningfulTokens(right.description);
      if (rightTokens.size < 6) {
        continue;
      }
      const similarity = jaccard(leftTokens, rightTokens);
      if (similarity >= maxSimilarity) {
        findings.push({
          level: "WARN",
          code: "DESCRIPTION_NEAR_DUPLICATE",
          skill: left.name,
          path: left.relativePath,
          message: `${left.name} and ${right.name} descriptions are ${(similarity * 100).toFixed(1)}% similar`,
        });
      }
    }
  }

  return {
    skillCount: skills.length,
    findings,
  };
}

function providerDefaultBudget(provider: ConcreteProviderId): number {
  if (provider === "codex") {
    return DEFAULT_CODEX_BUDGET;
  }
  if (provider === "claude-code") {
    return 12000;
  }
  return 16000;
}

function readGlobalCoreSkillNames(poolRoot: string): Set<string> {
  const corePath = path.join(poolRoot, "globals", "core.json");
  if (!fileExists(corePath)) {
    return new Set();
  }
  const parsed = readJson(corePath);
  if (!isRecord(parsed) || !isRecord(parsed.sets)) {
    return new Set();
  }
  const names = new Set<string>();
  for (const value of Object.values(parsed.sets)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          names.add(item.trim());
        }
      }
    }
  }
  return names;
}

function estimateSkillListingChars(skill: SkillDescriptionRecord): number {
  return `name: ${skill.name}\ndescription: ${skill.description}\npath: skills/${skill.name}\n`.length;
}

function doctorBudget(options: {
  sourceRoot: string;
  provider: ConcreteProviderId;
  scope: "all" | "global-core";
  maxBudget?: number;
}): BudgetDoctorResult {
  const sourceRoot = path.resolve(options.sourceRoot);
  const { poolRoot, skillsDir, names } = listSkillDirs(sourceRoot);
  parseProviderList(options.provider);
  const globalCore = readGlobalCoreSkillNames(poolRoot);
  const selectedNames = options.scope === "global-core" ? names.filter((name) => globalCore.has(name)) : names;
  const skills = selectedNames.map((name) => {
    const record = readSkillDescription(sourceRoot, skillsDir, name);
    return {
      skill: name,
      listingChars: estimateSkillListingChars(record),
      descriptionChars: record.description.length,
      globalCore: globalCore.has(name),
    };
  });
  const current = skills.reduce((total, skill) => total + skill.listingChars, 0);
  const budget = options.maxBudget || providerDefaultBudget(options.provider);
  const findings: SemanticFinding[] = [];

  if (current > budget) {
    findings.push({
      level: "WARN",
      code: "SKILL_LISTING_BUDGET_EXCEEDED",
      message: `${options.provider} estimated listing is ${current} chars, over budget ${budget}`,
    });
  }
  if (options.scope === "global-core" && globalCore.size > 8) {
    findings.push({
      level: "WARN",
      code: "GLOBAL_CORE_TOO_LARGE",
      message: `global core has ${globalCore.size} skills; recommended maximum is 8`,
    });
  }

  return {
    provider: options.provider,
    scope: options.scope,
    budget,
    current,
    skills: skills.sort((a, b) => b.listingChars - a.listingChars),
    findings,
  };
}

function hasErrors(findings: SemanticFinding[]): boolean {
  return findings.some((finding) => finding.level === "ERROR");
}

function hasFindings(findings: SemanticFinding[]): boolean {
  return findings.length > 0;
}

function formatFindings(findings: SemanticFinding[]): string {
  if (!findings.length) {
    return "Findings: 0";
  }
  return findings
    .map((finding) => {
      const location = [finding.path, finding.skill && !finding.path ? finding.skill : ""].filter(Boolean).join(" ");
      return `- [${finding.level} ${finding.code}] ${location ? `${location}: ` : ""}${finding.message}`;
    })
    .join("\n");
}

export {
  DEFAULT_CODEX_BUDGET,
  TRIGGERS_FIXTURE_PATH,
  doctorBudget,
  evaluateTriggerFixtures,
  formatFindings,
  hasErrors,
  semanticAudit,
};
export type {
  BudgetDoctorResult,
  BudgetSkillRecord,
  SemanticAuditResult,
  SemanticFinding,
  TriggerEvalFixture,
  TriggerEvalResult,
};
