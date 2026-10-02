#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { parseCsv, parseFrontmatter } from "../skill-metadata-lib.ts";

const EVAL_FIXTURE_PATH = path.join("evals", "evals.json");
const VALID_CATEGORIES = new Set(["positive", "negative", "ambiguous", "collision", "behavioral", "output-shape", "safety", "boundary"]);
const VALID_ASSERTION_KINDS = new Set(["contains", "not-contains", "regex", "matches-regex", "required-tool", "forbidden-tool", "max-output-chars"]);

type FindingLevel = "ERROR" | "WARN";
export type EvalHarnessStatus = "PASS" | "BLOCKED";

export interface EvalHarnessFinding {
  level: FindingLevel;
  code: string;
  skill?: string | undefined;
  path?: string | undefined;
  caseId?: string | undefined;
  message: string;
}

export interface EvalHarnessInput {
  source: string;
  skillFilter?: string | undefined;
  strict: boolean;
}

export interface EvalHarnessResult {
  schemaVersion: 1;
  command: "eval-harness";
  status: EvalHarnessStatus;
  source: string;
  skillFilter?: string | undefined;
  strict: boolean;
  skillCount: number;
  fixtureCount: number;
  caseCount: number;
  findings: EvalHarnessFinding[];
}

type EvalCase = {
  id?: unknown;
  category?: unknown;
  prompt?: unknown;
  assertions?: unknown;
};

type Fixture = {
  schemaVersion?: unknown;
  $schema?: unknown;
  references?: unknown;
  baselines?: unknown;
  cases?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toRelative(base: string, filePath: string): string {
  const rel = path.relative(base, filePath).replaceAll("\\", "/");
  return rel || ".";
}

function hasBlocking(findings: EvalHarnessFinding[], strict: boolean): boolean {
  return findings.some((finding) => finding.level === "ERROR" || (strict && finding.level === "WARN"));
}

function addFinding(findings: EvalHarnessFinding[], finding: EvalHarnessFinding): void {
  findings.push(finding);
}

function validateSourcePath(source: string): string {
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Source not found: ${source}`);
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error(`Source must not be a symlink: ${source}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Source must be a directory: ${source}`);
  }
  return resolved;
}

export function normalizeEvalHarnessArgs(args: Record<string, unknown>): EvalHarnessInput {
  if (args.help === true || args.h === true) {
    throw new Error("Usage: skill-sys eval harness --source <dir> [--skill <name>] [--json] [--strict]");
  }
  if (typeof args.source !== "string" || !args.source.trim()) {
    throw new Error("Usage: skill-sys eval harness --source <dir> [--skill <name>] [--json] [--strict]");
  }
  const source = validateSourcePath(args.source);
  let skillFilter: string | undefined;
  if (args.skill !== undefined) {
    if (typeof args.skill !== "string" || !/^[A-Za-z0-9._-]+$/.test(args.skill)) {
      throw new Error("Invalid --skill value");
    }
    skillFilter = args.skill;
  }
  return { source, skillFilter, strict: args.strict === true };
}

function collectSkillRecords(source: string, findings: EvalHarnessFinding[]): { name: string; dir: string; tools: string[] }[] {
  const skillsDir = path.join(source, "skills");
  if (!fs.existsSync(skillsDir)) {
    addFinding(findings, {
      level: "WARN",
      code: "EVAL_SKILLS_DIR_MISSING",
      path: toRelative(source, skillsDir),
      message: "No skills directory found under source",
    });
    return [];
  }
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(skillsDir, entry.name);
      const skillPath = path.join(dir, "SKILL.md");
      let name = entry.name;
      let tools: string[] = [];
      if (fs.existsSync(skillPath)) {
        const parsed = parseFrontmatter(fs.readFileSync(skillPath, "utf8"));
        if (parsed.ok) {
          name = String(parsed.top.name || entry.name);
          tools = parseCsv((parsed.top as Record<string, unknown>).tools).concat(parseCsv((parsed.metadata as Record<string, unknown>).tools));
        }
      } else {
        addFinding(findings, {
          level: "ERROR",
          code: "EVAL_SKILL_MANIFEST_MISSING",
          skill: entry.name,
          path: toRelative(source, skillPath),
          message: "Skill directory is missing SKILL.md",
        });
      }
      return { name, dir, tools };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeFixtureShape(value: unknown, skill: string, fixturePath: string, source: string, findings: EvalHarnessFinding[]): Fixture | undefined {
  const relPath = toRelative(source, fixturePath);
  if (!isRecord(value)) {
    addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: "Eval fixture must be an object" });
    return undefined;
  }
  const allowed = new Set(["$schema", "schemaVersion", "references", "baselines", "cases"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_UNKNOWN_KEY", skill, path: relPath, message: `Unsupported eval fixture key: ${key}` });
    }
  }
  if (value.schemaVersion !== 1) {
    addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: "schemaVersion must be 1" });
  }
  if (value.$schema !== undefined && (typeof value.$schema !== "string" || !value.$schema.trim())) {
    addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: "$schema must be a non-empty string" });
  }
  if (!Array.isArray(value.cases)) {
    addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: "cases must be an array" });
  }
  return value as Fixture;
}

function validateReferences(fixture: Fixture, skillNames: Set<string>, knownTools: Set<string>, skill: string, fixturePath: string, source: string, findings: EvalHarnessFinding[]): void {
  if (fixture.references === undefined) return;
  const relPath = toRelative(source, fixturePath);
  if (!isRecord(fixture.references)) {
    addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: "references must be an object" });
    return;
  }
  const refs = fixture.references;
  for (const [key, code, known] of [
    ["skills", "EVAL_REFERENCE_UNKNOWN_SKILL", skillNames] as const,
    ["tools", "EVAL_REFERENCE_UNKNOWN_TOOL", knownTools] as const,
  ]) {
    const values = refs[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !item.trim())) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: `references.${key} must be an array of strings` });
      continue;
    }
    for (const item of values as string[]) {
      if (!known.has(item)) {
        addFinding(findings, { level: "WARN", code, skill, path: relPath, message: `Unknown referenced ${key.slice(0, -1)}: ${item}` });
      }
    }
  }
}

function validateBaselines(fixture: Fixture, caseCount: number, skill: string, fixturePath: string, source: string, findings: EvalHarnessFinding[]): void {
  if (fixture.baselines === undefined) return;
  const relPath = toRelative(source, fixturePath);
  if (!isRecord(fixture.baselines)) {
    addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: "baselines must be an object" });
    return;
  }
  const baselines = fixture.baselines;
  const allowed = new Set(["minCases", "maxCases", "passRate", "maxTokenOverhead", "maxDurationMs"]);
  for (const key of Object.keys(baselines)) {
    if (!allowed.has(key)) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_UNKNOWN_KEY", skill, path: relPath, message: `Unsupported baseline key: ${key}` });
    }
  }
  if (baselines.minCases !== undefined) {
    if (!Number.isInteger(baselines.minCases) || (baselines.minCases as number) < 0) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: "baselines.minCases must be a non-negative integer" });
    } else if (caseCount < (baselines.minCases as number)) {
      addFinding(findings, { level: "ERROR", code: "EVAL_BASELINE_MIN_CASES", skill, path: relPath, message: `Fixture has ${caseCount} case(s), below minCases ${baselines.minCases}` });
    }
  }
  if (baselines.maxCases !== undefined) {
    if (!Number.isInteger(baselines.maxCases) || (baselines.maxCases as number) < 0) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: "baselines.maxCases must be a non-negative integer" });
    } else if (caseCount > (baselines.maxCases as number)) {
      addFinding(findings, { level: "ERROR", code: "EVAL_BASELINE_MAX_CASES", skill, path: relPath, message: `Fixture has ${caseCount} case(s), above maxCases ${baselines.maxCases}` });
    }
  }
  if (baselines.passRate !== undefined && (typeof baselines.passRate !== "number" || baselines.passRate < 0 || baselines.passRate > 1)) {
    addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: "baselines.passRate must be a number between 0 and 1" });
  }
  for (const key of ["maxTokenOverhead", "maxDurationMs"] as const) {
    const value = baselines[key];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: `baselines.${key} must be a non-negative integer` });
    }
  }
}

function validateAssertions(caseRecord: EvalCase, skill: string, fixturePath: string, source: string, findings: EvalHarnessFinding[]): void {
  if (caseRecord.assertions === undefined) return;
  const relPath = toRelative(source, fixturePath);
  if (!Array.isArray(caseRecord.assertions)) {
    addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, caseId: typeof caseRecord.id === "string" ? caseRecord.id : undefined, message: "case.assertions must be an array" });
    return;
  }
  caseRecord.assertions.forEach((assertion, index) => {
    if (!isRecord(assertion)) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, caseId: typeof caseRecord.id === "string" ? caseRecord.id : undefined, message: `assertions[${index}] must be an object` });
      return;
    }
    const allowedAssertionKeys = new Set(["kind", "target", "value", "pattern"]);
    for (const key of Object.keys(assertion)) {
      if (!allowedAssertionKeys.has(key)) {
        addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_UNKNOWN_KEY", skill, path: relPath, caseId: typeof caseRecord.id === "string" ? caseRecord.id : undefined, message: `Unsupported assertion key: ${key}` });
      }
    }
    const kind = assertion.kind;
    if (typeof kind !== "string" || !VALID_ASSERTION_KINDS.has(kind)) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, caseId: typeof caseRecord.id === "string" ? caseRecord.id : undefined, message: `assertions[${index}].kind is invalid` });
    }
    const regexPattern = typeof assertion.pattern === "string" ? assertion.pattern : typeof assertion.value === "string" && (kind === "regex" || kind === "matches-regex") ? assertion.value : undefined;
    if ((kind === "regex" || kind === "matches-regex") && regexPattern !== undefined) {
      try {
        new RegExp(regexPattern);
      } catch {
        addFinding(findings, { level: "ERROR", code: "EVAL_ASSERTION_INVALID_REGEX", skill, path: relPath, caseId: typeof caseRecord.id === "string" ? caseRecord.id : undefined, message: `Invalid regex in assertions[${index}]` });
      }
    }
  });
}

function validateCases(fixture: Fixture, skill: string, fixturePath: string, source: string, findings: EvalHarnessFinding[]): number {
  if (!Array.isArray(fixture.cases)) return 0;
  const relPath = toRelative(source, fixturePath);
  const seen = new Set<string>();
  let caseCount = 0;
  fixture.cases.forEach((item, index) => {
    if (!isRecord(item)) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: `cases[${index}] must be an object` });
      return;
    }
    const record = item as EvalCase;
    const id = record.id;
    if (typeof id !== "string" || !id.trim()) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, message: `cases[${index}].id must be a non-empty string` });
    } else if (seen.has(id)) {
      addFinding(findings, { level: "ERROR", code: "EVAL_CASE_DUPLICATE_ID", skill, path: relPath, caseId: id, message: `Duplicate eval case id: ${id}` });
    } else {
      seen.add(id);
    }
    if (typeof record.prompt !== "string" || !record.prompt.trim()) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, caseId: typeof id === "string" ? id : undefined, message: `cases[${index}].prompt must be a non-empty string` });
    }
    if (record.category !== undefined && (typeof record.category !== "string" || !VALID_CATEGORIES.has(record.category))) {
      addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_SHAPE", skill, path: relPath, caseId: typeof id === "string" ? id : undefined, message: `cases[${index}].category is invalid` });
    }
    const allowedCaseKeys = new Set(["id", "description", "category", "prompt", "assertions"]);
    for (const key of Object.keys(item)) {
      if (!allowedCaseKeys.has(key)) {
        addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_UNKNOWN_KEY", skill, path: relPath, caseId: typeof id === "string" ? id : undefined, message: `Unsupported case key: ${key}` });
      }
    }
    validateAssertions(record, skill, fixturePath, source, findings);
    caseCount += 1;
  });
  return caseCount;
}

export function runEvalHarness(input: EvalHarnessInput): EvalHarnessResult {
  const source = path.resolve(input.source);
  const findings: EvalHarnessFinding[] = [];
  let skillCount = 0;
  let fixtureCount = 0;
  let caseCount = 0;
  try {
    const skills = collectSkillRecords(source, findings).filter((skill) => !input.skillFilter || skill.name === input.skillFilter || path.basename(skill.dir) === input.skillFilter);
    skillCount = skills.length;
    const skillNames = new Set(skills.map((skill) => skill.name));
    for (const skill of skills) {
      skillNames.add(path.basename(skill.dir));
    }
    const knownTools = new Set(skills.flatMap((skill) => skill.tools));
    for (const skill of skills) {
      const fixturePath = path.join(skill.dir, EVAL_FIXTURE_PATH);
      if (!fs.existsSync(fixturePath)) continue;
      const relPath = toRelative(source, fixturePath);
      if (fs.lstatSync(fixturePath).isSymbolicLink()) {
        fixtureCount += 1;
        addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_SYMLINK", skill: skill.name, path: relPath, message: "Eval fixture must not be a symlink" });
        continue;
      }
      fixtureCount += 1;
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
      } catch {
        addFinding(findings, { level: "ERROR", code: "EVAL_FIXTURE_INVALID_JSON", skill: skill.name, path: relPath, message: "Eval fixture is not valid JSON" });
        continue;
      }
      const fixture = normalizeFixtureShape(raw, skill.name, fixturePath, source, findings);
      if (!fixture) continue;
      validateReferences(fixture, skillNames, knownTools, skill.name, fixturePath, source, findings);
      const cases = validateCases(fixture, skill.name, fixturePath, source, findings);
      caseCount += cases;
      validateBaselines(fixture, cases, skill.name, fixturePath, source, findings);
    }
    if (fixtureCount === 0) {
      addFinding(findings, { level: "WARN", code: "EVAL_FIXTURES_MISSING", message: input.skillFilter ? `No eval fixtures found for ${input.skillFilter}` : "No eval fixtures found" });
    }
  } catch (error) {
    addFinding(findings, { level: "ERROR", code: "EVAL_HARNESS_FAILED", message: error instanceof Error ? error.message : String(error) });
  }
  findings.sort((a, b) => `${a.level}:${a.code}:${a.skill ?? ""}:${a.path ?? ""}:${a.caseId ?? ""}:${a.message}`.localeCompare(`${b.level}:${b.code}:${b.skill ?? ""}:${b.path ?? ""}:${b.caseId ?? ""}:${b.message}`));
  return {
    schemaVersion: 1,
    command: "eval-harness",
    status: hasBlocking(findings, input.strict) ? "BLOCKED" : "PASS",
    source,
    ...(input.skillFilter ? { skillFilter: input.skillFilter } : {}),
    strict: input.strict,
    skillCount,
    fixtureCount,
    caseCount,
    findings,
  };
}

export function renderEvalHarnessResult(result: EvalHarnessResult, format: "text" | "json" = "text"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const lines = [
    `STATUS: ${result.status}`,
    `Source: ${result.source}`,
    `Skills: ${result.skillCount}`,
    `Fixtures: ${result.fixtureCount}`,
    `Cases: ${result.caseCount}`,
  ];
  if (result.skillFilter) {
    lines.push(`Skill: ${result.skillFilter}`);
  }
  if (result.findings.length === 0) {
    lines.push("Findings: 0");
  } else {
    lines.push(`Findings: ${result.findings.length}`);
    for (const finding of result.findings) {
      const location = [finding.skill, finding.path, finding.caseId].filter(Boolean).join(" ");
      lines.push(`- ${finding.level} ${finding.code}${location ? ` ${location}` : ""}: ${finding.message}`);
    }
  }
  return lines.join("\n");
}
