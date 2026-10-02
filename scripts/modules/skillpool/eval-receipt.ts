const RECEIPT_SCHEMA_VERSION = "measured-eval-receipt/v1" as const;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type EvalReceiptRejectReason =
  | "RECEIPT_INVALID_SHAPE"
  | "RECEIPT_UNKNOWN_SCHEMA"
  | "RECEIPT_INVALID_DIGEST"
  | "RECEIPT_SOURCE_DIGEST_MISMATCH"
  | "RECEIPT_FIXTURE_DIGEST_MISMATCH"
  | "RECEIPT_INVALID_CASE_SET"
  | "RECEIPT_CASE_SET_MISMATCH"
  | "RECEIPT_PROVIDER_MISMATCH"
  | "RECEIPT_MODEL_MISMATCH"
  | "RECEIPT_INVALID_METRIC"
  | "RECEIPT_INVALID_PROVENANCE"
  | "RECEIPT_INVALID_COLLECTION";

export interface EvalReceiptBinding {
  sourceDigest: string;
  fixtureDigest: string;
  caseIds: readonly string[];
  provider: string;
  model: string;
}

export interface MeasuredEvalReceipt {
  schema_version: typeof RECEIPT_SCHEMA_VERSION;
  receipt_id: string;
  source: { digest: string };
  fixture: { digest: string };
  cases: { selection_id: string; ids: string[] };
  execution: { provider: string; model: string; executor: string; config_digest: string };
  metrics: {
    pass_rate: { value: number; unit: "ratio" };
    duration: { value: number; unit: "ms" };
    token_overhead: { value: number; unit: "tokens" };
  };
  collection: { collected_at: string };
  provenance: { kind: "observed-run"; run_id: string; collector: string; evidence_digest: string };
}

export type EvalReceiptParseResult =
  | { accepted: true; receipt: Readonly<MeasuredEvalReceipt> }
  | { accepted: false; reason: EvalReceiptRejectReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function matchingCaseSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function reject(reason: EvalReceiptRejectReason): EvalReceiptParseResult {
  return { accepted: false, reason };
}

/** Parses an already-collected receipt. It performs no execution, I/O, or metric generation. */
export function parseMeasuredEvalReceipt(candidate: unknown, binding: EvalReceiptBinding): EvalReceiptParseResult {
  if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["schema_version", "receipt_id", "source", "fixture", "cases", "execution", "metrics", "collection", "provenance"])) return reject("RECEIPT_INVALID_SHAPE");
  if (candidate.schema_version !== RECEIPT_SCHEMA_VERSION) return reject("RECEIPT_UNKNOWN_SCHEMA");
  if (!isIdentifier(candidate.receipt_id)) return reject("RECEIPT_INVALID_SHAPE");

  if (!isRecord(candidate.source) || !hasOnlyKeys(candidate.source, ["digest"]) || !isDigest(candidate.source.digest)) return reject("RECEIPT_INVALID_DIGEST");
  if (!isRecord(candidate.fixture) || !hasOnlyKeys(candidate.fixture, ["digest"]) || !isDigest(candidate.fixture.digest)) return reject("RECEIPT_INVALID_DIGEST");
  if (candidate.source.digest !== binding.sourceDigest) return reject("RECEIPT_SOURCE_DIGEST_MISMATCH");
  if (candidate.fixture.digest !== binding.fixtureDigest) return reject("RECEIPT_FIXTURE_DIGEST_MISMATCH");

  if (!isRecord(candidate.cases) || !hasOnlyKeys(candidate.cases, ["selection_id", "ids"]) || !isIdentifier(candidate.cases.selection_id) || !Array.isArray(candidate.cases.ids) || candidate.cases.ids.length === 0 || candidate.cases.ids.some((id) => !isIdentifier(id)) || new Set(candidate.cases.ids).size !== candidate.cases.ids.length) return reject("RECEIPT_INVALID_CASE_SET");
  const receiptCaseIds = [...candidate.cases.ids].sort();
  const expectedCaseIds = [...binding.caseIds].sort();
  if (new Set(expectedCaseIds).size !== expectedCaseIds.length || !matchingCaseSet(receiptCaseIds, expectedCaseIds)) return reject("RECEIPT_CASE_SET_MISMATCH");

  if (!isRecord(candidate.execution) || !hasOnlyKeys(candidate.execution, ["provider", "model", "executor", "config_digest"]) || typeof candidate.execution.provider !== "string" || !PROVIDER_PATTERN.test(candidate.execution.provider) || typeof candidate.execution.model !== "string" || !MODEL_PATTERN.test(candidate.execution.model) || !isIdentifier(candidate.execution.executor) || !isDigest(candidate.execution.config_digest)) return reject("RECEIPT_INVALID_SHAPE");
  if (candidate.execution.provider !== binding.provider) return reject("RECEIPT_PROVIDER_MISMATCH");
  if (candidate.execution.model !== binding.model) return reject("RECEIPT_MODEL_MISMATCH");

  if (!isRecord(candidate.metrics) || !hasOnlyKeys(candidate.metrics, ["pass_rate", "duration", "token_overhead"])) return reject("RECEIPT_INVALID_METRIC");
  const passRate = candidate.metrics.pass_rate;
  const duration = candidate.metrics.duration;
  const tokenOverhead = candidate.metrics.token_overhead;
  if (!isRecord(passRate) || !hasOnlyKeys(passRate, ["value", "unit"]) || passRate.unit !== "ratio" || typeof passRate.value !== "number" || !Number.isFinite(passRate.value) || passRate.value < 0 || passRate.value > 1 || !isRecord(duration) || !hasOnlyKeys(duration, ["value", "unit"]) || duration.unit !== "ms" || typeof duration.value !== "number" || !Number.isFinite(duration.value) || duration.value < 0 || !isRecord(tokenOverhead) || !hasOnlyKeys(tokenOverhead, ["value", "unit"]) || tokenOverhead.unit !== "tokens" || typeof tokenOverhead.value !== "number" || !Number.isFinite(tokenOverhead.value) || tokenOverhead.value < 0) return reject("RECEIPT_INVALID_METRIC");

  if (!isRecord(candidate.collection) || !hasOnlyKeys(candidate.collection, ["collected_at"]) || typeof candidate.collection.collected_at !== "string" || !RFC3339_PATTERN.test(candidate.collection.collected_at) || Number.isNaN(Date.parse(candidate.collection.collected_at))) return reject("RECEIPT_INVALID_COLLECTION");
  if (!isRecord(candidate.provenance) || !hasOnlyKeys(candidate.provenance, ["kind", "run_id", "collector", "evidence_digest"]) || candidate.provenance.kind !== "observed-run" || !isIdentifier(candidate.provenance.run_id) || !isIdentifier(candidate.provenance.collector) || !isDigest(candidate.provenance.evidence_digest)) return reject("RECEIPT_INVALID_PROVENANCE");

  return { accepted: true, receipt: Object.freeze(candidate as unknown as MeasuredEvalReceipt) };
}
