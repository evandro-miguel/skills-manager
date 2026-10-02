import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeEvalHarnessArgs,
  runEvalHarness,
  renderEvalHarnessResult,
  type EvalHarnessInput,
} from "../scripts/modules/skillpool/eval-harness.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(
  root: string,
  name: string,
  options: { tools?: string[] } = {},
): string {
  const skillDir = path.join(root, "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  const toolsLine = options.tools ? `  tools: ${options.tools.join(",")}\n` : "";
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill.\nmetadata:\n  tags: demo\n${toolsLine}---\n# ${name}\n`,
  );
  return skillDir;
}

function writeEvals(root: string, skillName: string, data: unknown): string {
  const evalsDir = path.join(root, "skills", skillName, "evals");
  fs.mkdirSync(evalsDir, { recursive: true });
  const filePath = path.join(evalsDir, "evals.json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

const VALID_FIXTURE = {
  schemaVersion: 1,
  cases: [
    {
      id: "case-positive-1",
      category: "positive",
      prompt: "Run example-skill for me.",
      assertions: [{ kind: "regex", pattern: "example", target: "output" }],
    },
    {
      id: "case-negative-1",
      category: "negative",
      prompt: "Do something unrelated.",
    },
  ],
};

describe("eval harness — normalizeEvalHarnessArgs", () => {
  test("rejects missing --source", () => {
    expect(() => normalizeEvalHarnessArgs({})).toThrow("Usage: skill-sys eval harness");
  });

  test("rejects non-existent source", () => {
    expect(() =>
      normalizeEvalHarnessArgs({ source: path.join(tempRoot("missing"), "nope") }),
    ).toThrow("not found");
  });

  test("rejects symlinked source root", () => {
    const real = tempRoot("real-source");
    const link = path.join(tempRoot("link-source"), "link");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
    expect(() => normalizeEvalHarnessArgs({ source: link })).toThrow("symlink");
  });

  test("accepts valid source and parses flags", () => {
    const root = tempRoot("args-ok");
    const input = normalizeEvalHarnessArgs(
      { source: root, skill: "alpha", strict: true },
    );
    expect(input.source).toBe(root);
    expect(input.skillFilter).toBe("alpha");
    expect(input.strict).toBe(true);
  });

  test("rejects skill filter with path separators", () => {
    const root = tempRoot("args-bad-skill");
    expect(() =>
      normalizeEvalHarnessArgs({ source: root, skill: "../etc" }),
    ).toThrow("Invalid --skill");
  });
});

describe("eval harness — runEvalHarness", () => {
  test("valid fixture PASSES", () => {
    const root = tempRoot("valid-pass");
    writeSkill(root, "example-skill");
    writeEvals(root, "example-skill", VALID_FIXTURE);

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.status).toBe("PASS");
    expect(result.fixtureCount).toBe(1);
    expect(result.caseCount).toBe(2);
    expect(result.findings.filter((f) => f.level === "ERROR")).toEqual([]);
  });

  test("duplicate case IDs ERROR", () => {
    const root = tempRoot("dup-ids");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", {
      schemaVersion: 1,
      cases: [
        { id: "dup", category: "positive", prompt: "one" },
        { id: "dup", category: "positive", prompt: "two" },
      ],
    });

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.status).toBe("BLOCKED");
    expect(
      result.findings.some(
        (f) => f.code === "EVAL_CASE_DUPLICATE_ID" && f.level === "ERROR",
      ),
    ).toBe(true);
  });

  test("invalid regex pattern ERROR", () => {
    const root = tempRoot("bad-regex");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", {
      schemaVersion: 1,
      cases: [
        {
          id: "c1",
          category: "positive",
          prompt: "go",
          assertions: [{ kind: "regex", pattern: "(", target: "output" }],
        },
      ],
    });

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.status).toBe("BLOCKED");
    expect(
      result.findings.some(
        (f) => f.code === "EVAL_ASSERTION_INVALID_REGEX" && f.level === "ERROR",
      ),
    ).toBe(true);
  });

  test("symlinked fixture file ERROR", () => {
    const root = tempRoot("symlink-fixture");
    const skillDir = writeSkill(root, "alpha");
    const evalsDir = path.join(skillDir, "evals");
    fs.mkdirSync(evalsDir, { recursive: true });
    const realFile = path.join(root, "real-evals.json");
    fs.writeFileSync(realFile, JSON.stringify(VALID_FIXTURE));
    fs.symlinkSync(realFile, path.join(evalsDir, "evals.json"));

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.status).toBe("BLOCKED");
    expect(
      result.findings.some(
        (f) => f.code === "EVAL_FIXTURE_SYMLINK" && f.level === "ERROR",
      ),
    ).toBe(true);
  });

  test("invalid fixture shape ERROR (missing schemaVersion)", () => {
    const root = tempRoot("bad-shape");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", { cases: [] });

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.status).toBe("BLOCKED");
    expect(
      result.findings.some(
        (f) => f.code === "EVAL_FIXTURE_INVALID_SHAPE" && f.level === "ERROR",
      ),
    ).toBe(true);
  });

  test("invalid fixture shape ERROR (missing cases array)", () => {
    const root = tempRoot("bad-shape-2");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", { schemaVersion: 1 });

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.status).toBe("BLOCKED");
    expect(
      result.findings.some(
        (f) => f.code === "EVAL_FIXTURE_INVALID_SHAPE" && f.level === "ERROR",
      ),
    ).toBe(true);
  });

  test("unknown skill reference WARN", () => {
    const root = tempRoot("unknown-skill-ref");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", {
      schemaVersion: 1,
      references: { skills: ["nonexistent-skill"] },
      cases: [{ id: "c1", category: "positive", prompt: "go" }],
    });

    const result = runEvalHarness({ source: root, strict: false });

    // WARN is non-blocking without --strict.
    expect(result.status).toBe("PASS");
    expect(
      result.findings.some(
        (f) =>
          f.code === "EVAL_REFERENCE_UNKNOWN_SKILL" && f.level === "WARN",
      ),
    ).toBe(true);
  });

  test("unknown tool reference WARN", () => {
    const root = tempRoot("unknown-tool-ref");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", {
      schemaVersion: 1,
      references: { tools: ["nonexistent-tool"] },
      cases: [{ id: "c1", category: "positive", prompt: "go" }],
    });

    const result = runEvalHarness({ source: root, strict: false });

    expect(
      result.findings.some(
        (f) =>
          f.code === "EVAL_REFERENCE_UNKNOWN_TOOL" && f.level === "WARN",
      ),
    ).toBe(true);
  });

  test("known tool reference does not WARN", () => {
    const root = tempRoot("known-tool-ref");
    writeSkill(root, "alpha", { tools: ["file-read"] });
    writeEvals(root, "alpha", {
      schemaVersion: 1,
      references: { tools: ["file-read"] },
      cases: [{ id: "c1", category: "positive", prompt: "go" }],
    });

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.status).toBe("PASS");
    expect(
      result.findings.some((f) => f.code === "EVAL_REFERENCE_UNKNOWN_TOOL"),
    ).toBe(false);
  });

  test("baseline minCases violation ERROR", () => {
    const root = tempRoot("baseline-min");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", {
      schemaVersion: 1,
      baselines: { minCases: 3, maxCases: 10 },
      cases: [{ id: "c1", category: "positive", prompt: "go" }],
    });

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.status).toBe("BLOCKED");
    expect(
      result.findings.some(
        (f) => f.code === "EVAL_BASELINE_MIN_CASES" && f.level === "ERROR",
      ),
    ).toBe(true);
  });

  test("baseline maxCases violation ERROR", () => {
    const root = tempRoot("baseline-max");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", {
      schemaVersion: 1,
      baselines: { maxCases: 1 },
      cases: [
        { id: "c1", category: "positive", prompt: "go" },
        { id: "c2", category: "positive", prompt: "run" },
      ],
    });

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.status).toBe("BLOCKED");
    expect(
      result.findings.some(
        (f) => f.code === "EVAL_BASELINE_MAX_CASES" && f.level === "ERROR",
      ),
    ).toBe(true);
  });

  test("--skill filter restricts to one skill", () => {
    const root = tempRoot("skill-filter");
    writeSkill(root, "alpha");
    writeSkill(root, "beta");
    writeEvals(root, "alpha", VALID_FIXTURE);
    // beta has no evals

    const result = runEvalHarness({
      source: root,
      skillFilter: "alpha",
      strict: false,
    });

    expect(result.skillFilter).toBe("alpha");
    expect(result.fixtureCount).toBe(1);
    expect(result.caseCount).toBe(2);
    expect(result.status).toBe("PASS");
  });

  test("--skill filter that matches nothing still warns about missing fixtures", () => {
    const root = tempRoot("skill-filter-empty");
    writeSkill(root, "alpha");

    const result = runEvalHarness({
      source: root,
      skillFilter: "alpha",
      strict: false,
    });

    expect(result.fixtureCount).toBe(0);
    expect(
      result.findings.some((f) => f.code === "EVAL_FIXTURES_MISSING"),
    ).toBe(true);
  });

  test("no fixtures WARN", () => {
    const root = tempRoot("no-fixtures");
    writeSkill(root, "alpha");

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.fixtureCount).toBe(0);
    expect(result.status).toBe("PASS"); // WARN does not block without --strict
    expect(
      result.findings.some(
        (f) =>
          f.code === "EVAL_FIXTURES_MISSING" && f.level === "WARN",
      ),
    ).toBe(true);
  });

  test("--strict promotes WARN to BLOCKED", () => {
    const root = tempRoot("strict-warn");
    writeSkill(root, "alpha");

    const result = runEvalHarness({ source: root, strict: true });

    expect(result.status).toBe("BLOCKED");
    expect(result.strict).toBe(true);
  });

  test("invalid JSON fixture ERROR", () => {
    const root = tempRoot("bad-json");
    const skillDir = writeSkill(root, "alpha");
    const evalsDir = path.join(skillDir, "evals");
    fs.mkdirSync(evalsDir, { recursive: true });
    fs.writeFileSync(path.join(evalsDir, "evals.json"), "{not valid json");

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.status).toBe("BLOCKED");
    expect(
      result.findings.some(
        (f) => f.code === "EVAL_FIXTURE_INVALID_JSON" && f.level === "ERROR",
      ),
    ).toBe(true);
  });

  test("fixture with unknown top-level key ERROR", () => {
    const root = tempRoot("unknown-key");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", {
      schemaVersion: 1,
      cases: [],
      unknownKey: true,
    });

    const result = runEvalHarness({ source: root, strict: false });

    expect(
      result.findings.some(
        (f) =>
          f.code === "EVAL_FIXTURE_UNKNOWN_KEY" && f.level === "ERROR",
      ),
    ).toBe(true);
  });

  test("case with invalid category ERROR", () => {
    const root = tempRoot("bad-category");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", {
      schemaVersion: 1,
      cases: [{ id: "c1", category: "bogus", prompt: "go" }],
    });

    const result = runEvalHarness({ source: root, strict: false });

    expect(
      result.findings.some(
        (f) => f.code === "EVAL_FIXTURE_INVALID_SHAPE" && f.level === "ERROR",
      ),
    ).toBe(true);
  });

  test("case and assertion unknown keys ERROR", () => {
    const root = tempRoot("unknown-nested-key");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", {
      schemaVersion: 1,
      cases: [
        {
          id: "c1",
          category: "positive",
          prompt: "go",
          unexpectedCaseKey: true,
          assertions: [{ kind: "contains", target: "output", value: "ok", unexpectedAssertionKey: true }],
        },
      ],
    });

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.findings.filter((f) => f.code === "EVAL_FIXTURE_UNKNOWN_KEY").length).toBe(2);
  });

  test("invalid baseline metric types ERROR", () => {
    const root = tempRoot("bad-baseline-metrics");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", {
      schemaVersion: 1,
      baselines: { passRate: 1.5, maxTokenOverhead: -1, maxDurationMs: "fast" },
      cases: [{ id: "c1", category: "positive", prompt: "go" }],
    });

    const result = runEvalHarness({ source: root, strict: false });

    expect(result.findings.filter((f) => f.code === "EVAL_FIXTURE_INVALID_SHAPE").length).toBeGreaterThanOrEqual(3);
  });

  test("result has the documented JSON shape", () => {
    const root = tempRoot("json-shape");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", VALID_FIXTURE);

    const result = runEvalHarness({ source: root, strict: false });

    expect(result).toMatchObject({
      schemaVersion: 1,
      command: "eval-harness",
      status: "PASS",
      fixtureCount: 1,
      caseCount: 2,
    });
    expect(Array.isArray(result.findings)).toBe(true);
    expect(typeof result.source).toBe("string");
    expect(result.source.length).toBeGreaterThan(0);
  });

  test("deterministic result across runs", () => {
    const root = tempRoot("determinism");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", VALID_FIXTURE);

    const a = runEvalHarness({ source: root, strict: false });
    const b = runEvalHarness({ source: root, strict: false });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("eval harness — renderEvalHarnessResult", () => {
  function baseResult(): EvalHarnessInput {
    return { source: "/tmp/x", strict: false };
  }

  test("text format emits STATUS, counts, and findings", () => {
    const root = tempRoot("render-text");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", VALID_FIXTURE);

    const result = runEvalHarness({ source: root, strict: false });
    const text = renderEvalHarnessResult(result, "text");

    expect(text).toContain("STATUS: PASS");
    expect(text).toContain("Fixtures: 1");
    expect(text).toContain("Cases: 2");
  });

  test("text format lists findings with severity", () => {
    const root = tempRoot("render-findings");
    writeSkill(root, "alpha");

    const result = runEvalHarness({ source: root, strict: false });
    const text = renderEvalHarnessResult(result, "text");

    expect(text).toContain("STATUS: PASS");
    expect(text).toContain("WARN");
    expect(text).toContain("EVAL_FIXTURES_MISSING");
  });

  test("json format is valid JSON with documented keys", () => {
    const root = tempRoot("render-json");
    writeSkill(root, "alpha");
    writeEvals(root, "alpha", VALID_FIXTURE);

    const result = runEvalHarness({ source: root, strict: false });
    const json = renderEvalHarnessResult(result, "json");
    const parsed = JSON.parse(json);

    expect(parsed.command).toBe("eval-harness");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.status).toBe("PASS");
    expect(Array.isArray(parsed.findings)).toBe(true);
  });

  test("text format for empty base result does not throw", () => {
    const result = runEvalHarness({ ...baseResult() });
    expect(() => renderEvalHarnessResult(result, "text")).not.toThrow();
    expect(() => renderEvalHarnessResult(result, "json")).not.toThrow();
  });
});
