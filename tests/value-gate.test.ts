import { describe, expect, test } from "bun:test";
import { evaluateValueGate } from "../scripts/modules/skillpool/value-gate.ts";

const digest = (suffix: string) => `${"a".repeat(63)}${suffix}`;
const binding = { sourceDigest: digest("1"), fixtureDigest: digest("2"), caseIds: ["case-id-0001"], provider: "offline", model: "test-model" };
const receipt = (id: string, passRate = 0.9, duration = 100, tokens = 10) => ({
  schema_version: "measured-eval-receipt/v1", receipt_id: id,
  source: { digest: binding.sourceDigest }, fixture: { digest: binding.fixtureDigest },
  cases: { selection_id: "selection-01", ids: binding.caseIds },
  execution: { provider: binding.provider, model: binding.model, executor: "executor-01", config_digest: digest("3") },
  metrics: { pass_rate: { value: passRate, unit: "ratio" }, duration: { value: duration, unit: "ms" }, token_overhead: { value: tokens, unit: "tokens" } },
  collection: { collected_at: "2026-08-16T20:00:00Z" },
  provenance: { kind: "observed-run", run_id: "run-id-0001", collector: "collector-01", evidence_digest: digest("4") },
});
const policy = () => ({ schema_version: "value-gate-policy/v1", policy_id: "policy-id-01", policy_version: "policy-v-01", binding, tolerances: { pass_rate: { unit: "ratio", max_regression: 0.1 }, duration: { unit: "ms", max_regression: 10 }, token_overhead: { unit: "tokens", max_regression: 2 } } });
const baseline = (value = receipt("baseline-01")) => ({ schema_version: "value-gate-baseline/v1", baseline_id: "baseline-01", policy_version: "policy-v-01", receipt: value });
const paths = { receipt: "candidate.json", baseline: "baseline.json", policy: "policy.json" };

describe("value gate receipt contract", () => {
  test("passes exact and tolerance-boundary comparable evidence", () => {
    const result = evaluateValueGate(receipt("candidate-01", 0.8, 110, 12), baseline(), policy(), paths);
    expect(result).toMatchObject({ status: "PASS", compared_metrics: ["duration", "pass_rate", "token_overhead"], release_authorized: false });
  });

  test("blocks each metric regression", () => {
    const result = evaluateValueGate(receipt("candidate-02", 0.79, 111, 13), baseline(), policy(), paths);
    expect(result.status).toBe("BLOCKED");
    expect(result.findings.filter((item) => item.code === "VALUE_GATE_REGRESSION").map((item) => item.metric)).toEqual(["duration", "pass_rate", "token_overhead"]);
  });

  test("blocks missing or forged fixture-only evidence", () => {
    const missing = evaluateValueGate({}, baseline(), policy(), paths);
    const fixtureOnly = evaluateValueGate({ schemaVersion: 1, results: [{ skill: "fixture", passRate: 1 }] }, baseline(), policy(), paths);
    expect(missing.findings.some((item) => item.code === "VALUE_GATE_RECEIPT_INVALID")).toBe(true);
    expect(fixtureOnly.findings.some((item) => item.code === "VALUE_GATE_RECEIPT_INVALID")).toBe(true);
    expect(fixtureOnly.status).toBe("BLOCKED");
  });

  test("blocks policy, baseline, identity, and duplicate-input mismatches", () => {
    const unsupported = evaluateValueGate(receipt("candidate-03"), baseline(), { ...policy(), policy_version: "bad" }, paths);
    const incomparable = evaluateValueGate({ ...receipt("candidate-04"), execution: { ...receipt("candidate-04").execution, model: "other-model" } }, baseline(), policy(), paths);
    const duplicate = evaluateValueGate(receipt("baseline-01"), baseline(), policy(), paths);
    expect(unsupported.findings.some((item) => item.code === "VALUE_GATE_BASELINE_INVALID")).toBe(true);
    expect(incomparable.findings.some((item) => item.code === "VALUE_GATE_RECEIPT_INVALID")).toBe(true);
    expect(duplicate.findings.some((item) => item.code === "VALUE_GATE_DUPLICATE_INPUT")).toBe(true);
  });

  test("is deterministic and never authorizes release", () => {
    const first = JSON.stringify(evaluateValueGate(receipt("candidate-05"), baseline(), policy(), paths));
    const second = JSON.stringify(evaluateValueGate(receipt("candidate-05"), baseline(), policy(), paths));
    expect(second).toBe(first);
    expect(JSON.parse(first).release_authorized).toBe(false);
  });
});
