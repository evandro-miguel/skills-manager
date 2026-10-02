#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { parseMeasuredEvalReceipt, type EvalReceiptBinding, type MeasuredEvalReceipt } from "./eval-receipt.ts";

const BASELINE_SCHEMA = "value-gate-baseline/v1" as const;
const POLICY_SCHEMA = "value-gate-policy/v1" as const;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type ValueGateStatus = "PASS" | "BLOCKED";
export type ValueGateReason =
  | "VALUE_GATE_RECEIPT_INVALID" | "VALUE_GATE_BASELINE_INVALID" | "VALUE_GATE_POLICY_INVALID"
  | "VALUE_GATE_DUPLICATE_INPUT" | "VALUE_GATE_INCOMPARABLE" | "VALUE_GATE_UNSUPPORTED_POLICY"
  | "VALUE_GATE_REGRESSION";

export interface ValueGateFinding { code: ValueGateReason; metric?: string; message: string }
export interface ValueGateInput { receipt: string; baseline: string; policy: string }
export interface ValueGateResult {
  schema_version: "value-gate-verdict/v2";
  command: "value-gate";
  status: ValueGateStatus;
  receipt: string;
  baseline: string;
  policy: string;
  policy_version?: string;
  compared_metrics: string[];
  findings: ValueGateFinding[];
  release_authorized: false;
}

type Binding = EvalReceiptBinding;
type Policy = { schema_version: typeof POLICY_SCHEMA; policy_id: string; policy_version: string; binding: Binding; tolerances: Record<MetricName, { unit: Unit; max_regression: number }> };
type Baseline = { schema_version: typeof BASELINE_SCHEMA; baseline_id: string; policy_version: string; receipt: unknown };
type MetricName = "pass_rate" | "duration" | "token_overhead";
type Unit = "ratio" | "ms" | "tokens";

const METRICS: readonly MetricName[] = ["duration", "pass_rate", "token_overhead"];
const UNITS: Record<MetricName, Unit> = { pass_rate: "ratio", duration: "ms", token_overhead: "tokens" };

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function isIdentifier(value: unknown): value is string { return typeof value === "string" && IDENTIFIER_PATTERN.test(value); }
function isDigest(value: unknown): value is string { return typeof value === "string" && DIGEST_PATTERN.test(value); }
function readJson(filePath: string): unknown { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
function safePath(value: string): string { return path.resolve(value); }

function parseBinding(value: unknown): Binding | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["sourceDigest", "fixtureDigest", "caseIds", "provider", "model"]) || !isDigest(value.sourceDigest) || !isDigest(value.fixtureDigest) || !Array.isArray(value.caseIds) || value.caseIds.length === 0 || value.caseIds.some((id) => !isIdentifier(id)) || new Set(value.caseIds).size !== value.caseIds.length || typeof value.provider !== "string" || !value.provider || typeof value.model !== "string" || !value.model) return undefined;
  return { sourceDigest: value.sourceDigest, fixtureDigest: value.fixtureDigest, caseIds: [...value.caseIds].sort(), provider: value.provider, model: value.model };
}

function parsePolicy(candidate: unknown): Policy | undefined {
  if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["schema_version", "policy_id", "policy_version", "binding", "tolerances"]) || candidate.schema_version !== POLICY_SCHEMA || !isIdentifier(candidate.policy_id) || !isIdentifier(candidate.policy_version)) return undefined;
  const binding = parseBinding(candidate.binding);
  if (!binding || !isRecord(candidate.tolerances) || !hasOnlyKeys(candidate.tolerances, METRICS) || Object.keys(candidate.tolerances).length !== METRICS.length) return undefined;
  const tolerances = {} as Policy["tolerances"];
  for (const metric of METRICS) {
    const tolerance = candidate.tolerances[metric];
    if (!isRecord(tolerance) || !hasOnlyKeys(tolerance, ["unit", "max_regression"]) || tolerance.unit !== UNITS[metric] || typeof tolerance.max_regression !== "number" || !Number.isFinite(tolerance.max_regression) || tolerance.max_regression < 0) return undefined;
    tolerances[metric] = { unit: UNITS[metric], max_regression: tolerance.max_regression };
  }
  return { schema_version: POLICY_SCHEMA, policy_id: candidate.policy_id, policy_version: candidate.policy_version, binding, tolerances };
}

function parseBaseline(candidate: unknown, policy: Policy): { baseline: Baseline; receipt: MeasuredEvalReceipt } | undefined {
  if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["schema_version", "baseline_id", "policy_version", "receipt"]) || candidate.schema_version !== BASELINE_SCHEMA || !isIdentifier(candidate.baseline_id) || candidate.policy_version !== policy.policy_version) return undefined;
  const parsed = parseMeasuredEvalReceipt(candidate.receipt, policy.binding);
  return parsed.accepted ? { baseline: candidate as Baseline, receipt: parsed.receipt } : undefined;
}

function metricValue(receipt: MeasuredEvalReceipt, metric: MetricName): number { return receipt.metrics[metric].value; }
function regression(metric: MetricName, actual: number, baseline: number): number { return metric === "pass_rate" ? baseline - actual : actual - baseline; }
function finding(code: ValueGateReason, message: string, metric?: string): ValueGateFinding { return metric ? { code, metric, message } : { code, message }; }

/** Compares pre-collected receipts only. It does not execute models, write files, or authorize releases. */
export function evaluateValueGate(receiptCandidate: unknown, baselineCandidate: unknown, policyCandidate: unknown, paths: Pick<ValueGateResult, "receipt" | "baseline" | "policy">): ValueGateResult {
  const findings: ValueGateFinding[] = [];
  const policy = parsePolicy(policyCandidate);
  if (!policy) findings.push(finding("VALUE_GATE_POLICY_INVALID", "Policy does not match value-gate-policy/v1."));
  const receipt = policy ? parseMeasuredEvalReceipt(receiptCandidate, policy.binding) : { accepted: false as const };
  if (!receipt.accepted) findings.push(finding("VALUE_GATE_RECEIPT_INVALID", "Receipt is absent, malformed, or incomparable with the policy."));
  const baseline = policy ? parseBaseline(baselineCandidate, policy) : undefined;
  if (!baseline) findings.push(finding("VALUE_GATE_BASELINE_INVALID", "Baseline is absent, malformed, unverifiable, or bound to another policy."));
  if (receipt.accepted && baseline && receipt.receipt.receipt_id === baseline.receipt.receipt_id) findings.push(finding("VALUE_GATE_DUPLICATE_INPUT", "Candidate and baseline receipts must be distinct."));
  if (policy && receipt.accepted && baseline) {
    for (const metric of METRICS) {
      const actual = metricValue(receipt.receipt, metric);
      const reference = metricValue(baseline.receipt, metric);
      if (regression(metric, actual, reference) > policy.tolerances[metric].max_regression) findings.push(finding("VALUE_GATE_REGRESSION", `Metric exceeds its explicit regression tolerance.`, metric));
    }
  }
  findings.sort((a, b) => `${a.code}:${a.metric ?? ""}:${a.message}`.localeCompare(`${b.code}:${b.metric ?? ""}:${b.message}`));
  return { schema_version: "value-gate-verdict/v2", command: "value-gate", status: findings.length ? "BLOCKED" : "PASS", ...paths, ...(policy ? { policy_version: policy.policy_version } : {}), compared_metrics: policy && receipt.accepted && baseline ? [...METRICS] : [], findings, release_authorized: false };
}

export function normalizeValueGateArgs(args: Record<string, unknown>): ValueGateInput {
  if (typeof args.receipt !== "string" || !args.receipt.trim() || typeof args.baseline !== "string" || !args.baseline.trim() || typeof args.policy !== "string" || !args.policy.trim()) throw new Error("Usage: skill-sys eval value-gate --receipt <file> --baseline <file> --policy <file> [--json]");
  for (const [label, value] of Object.entries({ Receipt: args.receipt, Baseline: args.baseline, Policy: args.policy })) {
    const stat = fs.existsSync(value as string) ? fs.lstatSync(value as string) : undefined;
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  }
  const input = { receipt: safePath(args.receipt), baseline: safePath(args.baseline), policy: safePath(args.policy) };
  if (new Set(Object.values(input)).size !== 3) throw new Error("Receipt, baseline, and policy inputs must be distinct");
  return input;
}

export function runValueGate(input: ValueGateInput): ValueGateResult {
  const paths = { receipt: safePath(input.receipt), baseline: safePath(input.baseline), policy: safePath(input.policy) };
  try { return evaluateValueGate(readJson(paths.receipt), readJson(paths.baseline), readJson(paths.policy), paths); }
  catch { return { schema_version: "value-gate-verdict/v2", command: "value-gate", status: "BLOCKED", ...paths, compared_metrics: [], findings: [finding("VALUE_GATE_INCOMPARABLE", "One or more inputs are not valid JSON evidence.")], release_authorized: false }; }
}

export function renderValueGateResult(result: ValueGateResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  return [`STATUS: ${result.status}`, `Policy: ${result.policy}`, `Compared metrics: ${result.compared_metrics.join(", ") || "none"}`, `Release authorized: false`, `Findings: ${result.findings.length}`, ...result.findings.map((item) => `- ${item.code}${item.metric ? ` ${item.metric}` : ""}: ${item.message}`)].join("\n");
}
