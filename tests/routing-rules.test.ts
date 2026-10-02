import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  normalizeRouteArgs,
  renderRouteResult,
  runRouteExecution,
  runRouteQuery,
} from "../scripts/modules/skillpool/routing-rules.ts";

const routeCommand = require("../scripts/commands/route.ts") as typeof import("../scripts/commands/route.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const repoRoot = path.resolve(__dirname, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-rules-"));
  tempRoots.push(root);
  return root;
}

function writeSkill(root: string, name: string, meta: Record<string, unknown> = {}): void {
  const skillDir = path.join(root, "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Use when testing ${name}.\nmetadata:\n  tags: test\n---\n# ${name}\n`,
  );
  if (Object.keys(meta).length > 0) {
    fs.writeFileSync(path.join(skillDir, "skill.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }
}

function writeRules(root: string, value: unknown, filename = "routing-rules.json"): string {
  const rulesPath = path.join(root, filename);
  fs.writeFileSync(rulesPath, `${JSON.stringify(value, null, 2)}\n`);
  return rulesPath;
}

describe("routing rules — normalizeRouteArgs", () => {
  test("rejects missing source, rules, or query", () => {
    expect(() => normalizeRouteArgs({ rules: "/tmp/rules.json", query: "docs" })).toThrow("Missing --source");
    expect(() => normalizeRouteArgs({ source: "/tmp/source", query: "docs" })).toThrow("Missing --rules");
    expect(() => normalizeRouteArgs({ source: "/tmp/source", rules: "/tmp/rules.json" })).toThrow("Missing --query");
  });

  test("rejects symlinked rules files and accepts strict", () => {
    const root = makeTempRoot();
    writeSkill(root, "docs");
    const rules = writeRules(root, { schemaVersion: 1, name: "default", rules: [{ id: "docs", skill: "docs", triggers: ["docs"] }] });
    const link = path.join(root, "link.json");
    fs.symlinkSync(rules, link);

    expect(() => normalizeRouteArgs({ source: root, rules: link, query: "docs" })).toThrow("must not be a symlink");
    expect(normalizeRouteArgs({ source: root, rules, query: "docs", strict: true }).strict).toBe(true);
  });
});

describe("routing rules — CLI wiring", () => {
  test("parseArgs normalizes paths and skill-sys dispatch routes to command", () => {
    const root = makeTempRoot();
    writeSkill(root, "docs");
    const rules = writeRules(root, { schemaVersion: 1, name: "default", rules: [{ id: "docs", skill: "docs", triggers: ["docs"] }] });

    const args = routeCommand.parseArgs(["bun", "route", "--source", root, "--rules", rules, "--query", "write docs", "--json", "--strict"]);
    expect(args.source).toBe(root);
    expect(args.rules).toBe(rules);
    expect(args.query).toBe("write docs");
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);

    const executeArgs = routeCommand.parseArgs(["bun", "route", "--source", root, "--rules", rules, "--query", "write docs", "--execute", "--adapter", "local-test"]);
    expect(executeArgs.execute).toBe(true);
    expect(executeArgs.adapter).toBe("local-test");

    const plan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "route", "--source", root, "--rules", rules, "--query", "write docs", "--json", "--strict"]));
    expect(plan.argv).toEqual(["bun", path.join(repoRoot, "scripts", "commands", "route.ts"), "--source", root, "--rules", rules, "--query", "write docs", "--json", "--strict"]);

    const executionPlan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "route", "--source", root, "--rules", rules, "--query", "write docs", "--execute", "--adapter", "local-test"]));
    expect(executionPlan.argv).toEqual(["bun", path.join(repoRoot, "scripts", "commands", "route.ts"), "--source", root, "--rules", rules, "--query", "write docs", "--execute", "--adapter", "local-test"]);
  });
});

describe("routing rules — runRouteQuery", () => {
  test("returns deterministic candidates for matching triggers", () => {
    const root = makeTempRoot();
    writeSkill(root, "docs");
    writeSkill(root, "code");
    const rules = writeRules(root, {
      schemaVersion: 1,
      name: "default",
      rules: [
        { id: "code", skill: "code", triggers: ["typescript", "code"], priority: 1 },
        { id: "docs", skill: "docs", triggers: ["docs", "documentation"], priority: 5 },
      ],
    });

    const result = runRouteQuery(normalizeRouteArgs({ source: root, rules, query: "write documentation for typescript" }));

    expect(result.status).toBe("PASS");
    expect(result.ruleCount).toBe(2);
    expect(result.candidates.map((candidate) => candidate.skill)).toEqual(["docs", "code"]);
    expect(result.candidates[0]).toEqual({ rule: "docs", skill: "docs", score: 6, matchedTriggers: ["documentation"], manualOnly: false });
    expect(result.findings).toEqual([]);
  });

  test("blocks missing skills, duplicate rule ids, invalid triggers, and dangerous implicit routes", () => {
    const root = makeTempRoot();
    writeSkill(root, "danger", {
      risk: { destructive: true },
      invocation: { implicitAllowed: true, manualOnly: false, requiresConfirmation: false },
    });
    const rules = writeRules(root, {
      schemaVersion: 1,
      name: "broken",
      rules: [
        { id: "same", skill: "missing", triggers: ["missing"] },
        { id: "same", skill: "danger", triggers: [], manualOnly: false },
      ],
    });

    const result = runRouteQuery(normalizeRouteArgs({ source: root, rules, query: "missing danger" }));

    expect(result.status).toBe("BLOCKED");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "ROUTE_RULE_DANGEROUS_IMPLICIT",
      "ROUTE_RULE_DUPLICATE_ID",
      "ROUTE_RULE_SKILL_MISSING",
      "ROUTE_RULE_TRIGGERS_INVALID",
    ]);
  });

  test("warns when there are no matches and strict blocks warnings", () => {
    const root = makeTempRoot();
    writeSkill(root, "docs");
    const rules = writeRules(root, { schemaVersion: 1, name: "default", rules: [{ id: "docs", skill: "docs", triggers: ["docs"] }] });

    const loose = runRouteQuery(normalizeRouteArgs({ source: root, rules, query: "unrelated" }));
    const strict = runRouteQuery(normalizeRouteArgs({ source: root, rules, query: "unrelated", strict: true }));

    expect(loose.status).toBe("CONCERNS");
    expect(strict.status).toBe("BLOCKED");
    expect(loose.findings[0]?.code).toBe("ROUTE_NO_MATCH");
  });

  test("renders stable JSON and text output", () => {
    const root = makeTempRoot();
    writeSkill(root, "docs");
    const rules = writeRules(root, { schemaVersion: 1, name: "default", rules: [{ id: "docs", skill: "docs", triggers: ["docs"] }] });
    const result = runRouteQuery(normalizeRouteArgs({ source: root, rules, query: "docs" }));

    expect(JSON.parse(renderRouteResult(result, "json"))).toEqual(result);
    expect(renderRouteResult(result, "text")).toContain("STATUS: PASS");
  });

  test("keeps the default route report unchanged and passes a bounded redacted candidate set", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    writeSkill(root, "beta");
    const rules = writeRules(root, {
      schemaVersion: 1,
      name: "adapter",
      rules: [
        { id: "alpha", skill: "alpha", triggers: ["private-query-value"], priority: 0 },
        { id: "beta", skill: "beta", triggers: ["private-query-value"], priority: 0 },
      ],
    });
    const result = runRouteQuery(normalizeRouteArgs({ source: root, rules, query: "private-query-value" }));
    expect(result.candidates.map((candidate) => candidate.skill)).toEqual(["alpha", "beta"]);
    expect(renderRouteResult(result, "json")).toContain("private-query-value");

    let calls = 0;
    const execution = runRouteExecution(result, "fixture", (input) => {
      calls += 1;
      expect(input).toEqual({
        schemaVersion: 1,
        candidates: [
          { rule: "alpha", skill: "alpha", score: 1, manualOnly: false },
          { rule: "beta", skill: "beta", score: 1, manualOnly: false },
        ],
      });
      expect(JSON.stringify(input)).not.toContain("private-query-value");
      return { schemaVersion: 1, selected: { rule: "alpha", skill: "alpha" } };
    });
    expect(calls).toBe(2);
    expect(execution).toEqual({ schemaVersion: 1, command: "route", status: "PASS", adapter: "fixture", execution: "executed", decision: "selected", selected: { rule: "alpha", skill: "alpha" }, findings: [] });
  });

  test("fails closed for no match, unsupported, invalid, non-deterministic, forbidden, and manual-only selections", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    writeSkill(root, "manual");
    const noMatchRules = writeRules(root, { schemaVersion: 1, name: "none", rules: [{ id: "alpha", skill: "alpha", triggers: ["alpha"] }] }, "none.json");
    const noMatch = runRouteQuery(normalizeRouteArgs({ source: root, rules: noMatchRules, query: "other" }));
    expect(runRouteExecution(noMatch, "local-test").findings[0]?.code).toBe("ROUTE_ADAPTER_NO_MATCH");

    const rules = writeRules(root, {
      schemaVersion: 1,
      name: "blocked",
      rules: [
        { id: "alpha", skill: "alpha", triggers: ["go"] },
        { id: "manual", skill: "manual", triggers: ["manual"], priority: 1, manualOnly: true },
      ],
    });
    const result = runRouteQuery(normalizeRouteArgs({ source: root, rules, query: "go" }));
    expect(runRouteExecution(result, "missing").findings[0]?.code).toBe("ROUTE_ADAPTER_UNAVAILABLE");
    expect(runRouteExecution({ ...result, candidates: Array.from({ length: 33 }, () => result.candidates[0]!) }, "local-test", () => ({ schemaVersion: 1, selected: { rule: "alpha", skill: "alpha" } })).findings[0]?.code).toBe("ROUTE_ADAPTER_CANDIDATE_LIMIT");
    expect(runRouteExecution(result, "bad", () => ({ schemaVersion: 1, selected: { rule: 1 as unknown as string, skill: "alpha" } })).findings[0]?.code).toBe("ROUTE_ADAPTER_INVALID_RESPONSE");
    let toggled = false;
    expect(runRouteExecution(result, "unstable", () => ({ schemaVersion: 1, selected: { rule: toggled ? "alpha" : (toggled = true, "other"), skill: "alpha" } })).findings[0]?.code).toBe("ROUTE_ADAPTER_NONDETERMINISTIC");
    expect(runRouteExecution(result, "forbidden", () => ({ schemaVersion: 1, selected: { rule: "other", skill: "alpha" } })).findings[0]?.code).toBe("ROUTE_ADAPTER_CANDIDATE_FORBIDDEN");

    const manualResult = runRouteQuery(normalizeRouteArgs({ source: root, rules, query: "manual" }));
    expect(runRouteExecution(manualResult, "manual", () => ({ schemaVersion: 1, selected: { rule: "manual", skill: "manual" } })).findings[0]?.code).toBe("ROUTE_ADAPTER_MANUAL_ONLY");
  });
});
