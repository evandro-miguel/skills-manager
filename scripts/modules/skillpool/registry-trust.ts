import fs from "node:fs";
import path from "node:path";
import { validateRegistrySurface } from "../../commands/validate-registry-surface.ts";

export type RegistryTrustStatus = "PASS" | "CONCERNS" | "BLOCKED";
export type RegistryTrustSignalStatus = "pass" | "warn" | "fail";
export type RegistryTrustSignalCategory =
  | "signed-ref"
  | "digest"
  | "scan"
  | "sandbox"
  | "eval"
  | "source-trust"
  | "docs"
  /** Evidence received from third parties (e.g. partner audits). Soft signal only. */
  | "external-audit";

export type RegistryTrustFinding = {
  level: "WARN" | "ERROR";
  code: string;
  message: string;
  signal?: string;
};

export type RegistryTrustSignal = {
  id: string;
  category: RegistryTrustSignalCategory;
  status: RegistryTrustSignalStatus;
  weight: number;
  evidence: string;
};

export type RegistrySurfaceSummary = {
  status: "PASS";
  files: string[];
  channelDigests: Record<string, string>;
};

export type RegistryTrustResult = {
  schemaVersion: 1;
  command: "registry-trust";
  status: RegistryTrustStatus;
  source: string;
  scorecard: string;
  strict: boolean;
  scorecardName: string;
  score: number;
  threshold: number;
  registrySurface: RegistrySurfaceSummary;
  signals: RegistryTrustSignal[];
  findings: RegistryTrustFinding[];
};

export type RegistryTrustInput = {
  source: string;
  scorecard: string;
  strict: boolean;
};

export type RegistryTrustArgs = {
  source?: string;
  scorecard?: string;
  strict?: boolean;
};

type JsonObject = Record<string, unknown>;

const SAFE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SIGNAL_CATEGORIES = new Set<RegistryTrustSignalCategory>([
  "signed-ref",
  "digest",
  "scan",
  "sandbox",
  "eval",
  "source-trust",
  "docs",
  "external-audit",
]);
const SIGNAL_STATUSES = new Set<RegistryTrustSignalStatus>(["pass", "warn", "fail"]);

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExistingDirectory(dir: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`${label} does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${dir}`);
}

function assertExistingFile(file: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${label} does not exist: ${file}`);
  }
  if (!stat.isFile()) throw new Error(`${label} must be a file: ${file}`);
}

export function normalizeRegistryTrustArgs(args: RegistryTrustArgs): RegistryTrustInput {
  if (!args.source) throw new Error("Missing --source");
  if (!args.scorecard) throw new Error("Missing --scorecard");
  const source = path.resolve(args.source);
  const scorecard = path.resolve(args.scorecard);
  assertExistingDirectory(source, "--source");
  assertExistingFile(scorecard, "--scorecard");
  if (fs.lstatSync(scorecard).isSymbolicLink()) throw new Error("--scorecard must not be a symlink");
  return { source, scorecard, strict: args.strict === true };
}

function parseScorecard(input: RegistryTrustInput): JsonObject {
  const parsed = JSON.parse(fs.readFileSync(input.scorecard, "utf8")) as unknown;
  if (!isObject(parsed)) throw new Error("registry trust scorecard must be a JSON object");
  return parsed;
}

function normalizeThresholds(doc: JsonObject): number {
  const thresholds = isObject(doc.thresholds) ? doc.thresholds : {};
  const minScore = thresholds.minScore;
  if (typeof minScore !== "number" || !Number.isInteger(minScore) || minScore < 0 || minScore > 100) {
    throw new Error("thresholds.minScore must be an integer from 0 to 100");
  }
  return minScore;
}

function normalizeSignals(doc: JsonObject): RegistryTrustSignal[] {
  if (!Array.isArray(doc.signals) || doc.signals.length === 0) throw new Error("signals must be a non-empty array");
  return doc.signals.map((entry, index): RegistryTrustSignal => {
    if (!isObject(entry)) throw new Error(`signals[${index}] must be an object`);
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const category = typeof entry.category === "string" ? entry.category : "";
    const status = typeof entry.status === "string" ? entry.status : "";
    const weight = entry.weight;
    const evidence = typeof entry.evidence === "string" ? entry.evidence.trim() : "";
    if (!SAFE_NAME_PATTERN.test(id)) throw new Error(`signals[${index}].id must be a safe identifier`);
    if (!SIGNAL_CATEGORIES.has(category as RegistryTrustSignalCategory)) throw new Error(`signals[${index}].category is invalid`);
    if (!SIGNAL_STATUSES.has(status as RegistryTrustSignalStatus)) throw new Error(`signals[${index}].status is invalid`);
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 0 || weight > 100) throw new Error(`signals[${index}].weight must be an integer from 0 to 100`);
    if (!evidence) throw new Error(`signals[${index}].evidence must be a non-empty string`);
    return { id, category: category as RegistryTrustSignalCategory, status: status as RegistryTrustSignalStatus, weight, evidence };
  });
}

function sortFindings(findings: RegistryTrustFinding[]): RegistryTrustFinding[] {
  return [...findings].sort((a, b) =>
    [a.level, a.code, a.signal ?? "", a.message].join("\0").localeCompare(
      [b.level, b.code, b.signal ?? "", b.message].join("\0"),
    ),
  );
}

function scoreSignals(signals: RegistryTrustSignal[]): number {
  const total = signals.reduce((sum, signal) => sum + signal.weight, 0);
  if (total === 0) return 0;
  const earned = signals.reduce((sum, signal) => {
    if (signal.status === "pass") return sum + signal.weight;
    if (signal.status === "warn") return sum + signal.weight / 2;
    return sum;
  }, 0);
  return Math.round((earned / total) * 100);
}

export function runRegistryTrust(input: RegistryTrustInput): RegistryTrustResult {
  const registrySurface = validateRegistrySurface(input.source);
  const doc = parseScorecard(input);
  if (doc.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const scorecardName = typeof doc.name === "string" ? doc.name.trim() : "";
  if (!SAFE_NAME_PATTERN.test(scorecardName)) throw new Error("name must be a safe identifier");
  const threshold = normalizeThresholds(doc);
  const signals = normalizeSignals(doc);

  const findings: RegistryTrustFinding[] = [];
  for (const signal of signals) {
    if (signal.status === "warn") findings.push({ level: "WARN", code: "REGISTRY_TRUST_SIGNAL_WARNING", signal: signal.id, message: `${signal.id} is warning: ${signal.evidence}` });
    if (signal.status === "fail") findings.push({ level: "ERROR", code: "REGISTRY_TRUST_SIGNAL_FAILED", signal: signal.id, message: `${signal.id} failed: ${signal.evidence}` });
  }
  const score = scoreSignals(signals);
  if (score < threshold) findings.push({ level: "ERROR", code: "REGISTRY_TRUST_SCORE_BELOW_THRESHOLD", message: `registry trust score ${score} is below threshold ${threshold}` });

  const sortedFindings = sortFindings(findings);
  const hasError = sortedFindings.some((finding) => finding.level === "ERROR");
  const hasWarning = sortedFindings.some((finding) => finding.level === "WARN");
  const status: RegistryTrustStatus = hasError || (input.strict && hasWarning) ? "BLOCKED" : hasWarning ? "CONCERNS" : "PASS";

  return {
    schemaVersion: 1,
    command: "registry-trust",
    status,
    source: input.source,
    scorecard: input.scorecard,
    strict: input.strict,
    scorecardName,
    score,
    threshold,
    registrySurface,
    signals,
    findings: sortedFindings,
  };
}

export function renderRegistryTrustResult(result: RegistryTrustResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status}`,
    `Scorecard: ${result.scorecardName}`,
    `Source: ${result.source}`,
    `Scorecard file: ${result.scorecard}`,
    `Score: ${result.score}`,
    `Threshold: ${result.threshold}`,
    `Signals: ${result.signals.length}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const finding of result.findings) lines.push(`- [${finding.level} ${finding.code}] ${finding.message}`);
  return lines.join("\n");
}
