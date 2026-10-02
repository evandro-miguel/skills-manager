import { describe, expect, test } from "bun:test";
import { parseMeasuredEvalReceipt, type EvalReceiptBinding } from "../scripts/modules/skillpool/eval-receipt.ts";

const DIGEST = "a".repeat(64);
const FIXTURE_DIGEST = "b".repeat(64);
const BINDING: EvalReceiptBinding = {
  sourceDigest: DIGEST,
  fixtureDigest: FIXTURE_DIGEST,
  caseIds: ["case-alpha", "case-beta"],
  provider: "example-provider",
  model: "example/model-v1",
};

function receipt(): Record<string, unknown> {
  return {
    schema_version: "measured-eval-receipt/v1",
    receipt_id: "receipt-0001",
    source: { digest: DIGEST },
    fixture: { digest: FIXTURE_DIGEST },
    cases: { selection_id: "selection-01", ids: ["case-beta", "case-alpha"] },
    execution: { provider: "example-provider", model: "example/model-v1", executor: "executor-01", config_digest: "c".repeat(64) },
    metrics: {
      pass_rate: { value: 0.9, unit: "ratio" },
      duration: { value: 1200, unit: "ms" },
      token_overhead: { value: 42, unit: "tokens" },
    },
    collection: { collected_at: "2026-08-17T13:30:00Z" },
    provenance: { kind: "observed-run", run_id: "run-000001", collector: "collector-01", evidence_digest: "d".repeat(64) },
  };
}

describe("measured eval receipt parser", () => {
  test("accepts a complete synthetic receipt deterministically", () => {
    const first = parseMeasuredEvalReceipt(receipt(), BINDING);
    const second = parseMeasuredEvalReceipt(receipt(), BINDING);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ accepted: true, receipt: { receipt_id: "receipt-0001" } });
  });

  test.each([
    ["unknown schema", (value: Record<string, unknown>) => { value.schema_version = "v2"; }, "RECEIPT_UNKNOWN_SCHEMA"],
    ["missing digest", (value: Record<string, unknown>) => { (value.source as Record<string, unknown>).digest = ""; }, "RECEIPT_INVALID_DIGEST"],
    ["source mismatch", (value: Record<string, unknown>) => { (value.source as Record<string, unknown>).digest = "e".repeat(64); }, "RECEIPT_SOURCE_DIGEST_MISMATCH"],
    ["fixture mismatch", (value: Record<string, unknown>) => { (value.fixture as Record<string, unknown>).digest = "e".repeat(64); }, "RECEIPT_FIXTURE_DIGEST_MISMATCH"],
    ["duplicate case", (value: Record<string, unknown>) => { (value.cases as Record<string, unknown>).ids = ["case-alpha", "case-alpha"]; }, "RECEIPT_INVALID_CASE_SET"],
    ["case mismatch", (value: Record<string, unknown>) => { (value.cases as Record<string, unknown>).ids = ["case-alpha"]; }, "RECEIPT_CASE_SET_MISMATCH"],
    ["provider mismatch", (value: Record<string, unknown>) => { (value.execution as Record<string, unknown>).provider = "other-provider"; }, "RECEIPT_PROVIDER_MISMATCH"],
    ["model mismatch", (value: Record<string, unknown>) => { (value.execution as Record<string, unknown>).model = "other/model"; }, "RECEIPT_MODEL_MISMATCH"],
    ["invalid metric", (value: Record<string, unknown>) => { ((value.metrics as Record<string, unknown>).duration as Record<string, unknown>).unit = "seconds"; }, "RECEIPT_INVALID_METRIC"],
    ["invalid provenance", (value: Record<string, unknown>) => { (value.provenance as Record<string, unknown>).kind = "fixture"; }, "RECEIPT_INVALID_PROVENANCE"],
  ] as const)("rejects %s with a sanitized stable code", (_name, mutate, reason) => {
    const value = receipt();
    mutate(value);
    expect(parseMeasuredEvalReceipt(value, BINDING)).toEqual({ accepted: false, reason });
  });
});
