import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  normalizeWorkflowChainArgs,
  renderWorkflowChainPlan,
  runWorkflowChainExecution,
  runWorkflowChainPlan,
} from "../scripts/modules/skillpool/workflow-chain.ts";

const workflowChainCommand = require("../scripts/commands/workflow-chain.ts") as typeof import("../scripts/commands/workflow-chain.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const repoRoot = path.resolve(__dirname, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-chain-"));
  tempRoots.push(root);
  return root;
}

function writeSkill(root: string, name: string): void {
  const skillDir = path.join(root, "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Use when testing ${name}.\nmetadata:\n  tags: test\n---\n# ${name}\n`,
  );
}

function writeWorkflow(root: string, value: unknown, filename = "workflow-chain.json"): string {
  const workflowPath = path.join(root, filename);
  fs.writeFileSync(workflowPath, `${JSON.stringify(value, null, 2)}\n`);
  return workflowPath;
}

describe("workflow chain — normalizeWorkflowChainArgs", () => {
  test("rejects missing source or workflow", () => {
    expect(() => normalizeWorkflowChainArgs({ workflow: "/tmp/workflow.json" })).toThrow("Missing --source");
    expect(() => normalizeWorkflowChainArgs({ source: "/tmp/source" })).toThrow("Missing --workflow");
  });

  test("rejects symlinked workflow files and accepts dry-run flags", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const workflow = writeWorkflow(root, { schemaVersion: 1, name: "demo", steps: [{ id: "one", skill: "alpha" }] });
    const link = path.join(root, "link.json");
    fs.symlinkSync(workflow, link);

    expect(() => normalizeWorkflowChainArgs({ source: root, workflow: link })).toThrow("must not be a symlink");
    expect(normalizeWorkflowChainArgs({ source: root, workflow, strict: true }).strict).toBe(true);
  });
});

describe("workflow chain — CLI wiring", () => {
  test("parseArgs normalizes workflow path and skill-sys dispatch routes to command", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const workflow = writeWorkflow(root, { schemaVersion: 1, name: "demo", steps: [{ id: "one", skill: "alpha" }] });

    const args = workflowChainCommand.parseArgs(["bun", "workflow-chain", "--source", root, "--workflow", workflow, "--json", "--strict", "--execute", "--adapter", "local-test"]);
    expect(args.source).toBe(root);
    expect(args.workflow).toBe(workflow);
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);
    expect(args.execute).toBe(true);
    expect(args.adapter).toBe("local-test");

    const plan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "workflow-chain", "--source", root, "--workflow", workflow, "--json", "--strict", "--execute", "--adapter", "local-test"]));
    expect(plan.argv).toEqual(["bun", path.join(repoRoot, "scripts", "commands", "workflow-chain.ts"), "--source", root, "--workflow", workflow, "--json", "--strict", "--execute", "--adapter", "local-test"]);
  });
});

describe("workflow chain — runWorkflowChainPlan", () => {
  test("passes for declarative dry-run workflow with existing skills and gates", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const workflow = writeWorkflow(root, {
      schemaVersion: 1,
      name: "release-readiness",
      description: "Plan release readiness steps.",
      gates: [{ id: "validate", command: ["bun", "run", "validate:local"] }],
      steps: [{ id: "review", skill: "alpha", prompt: "Review release readiness.", requiredGates: ["validate"] }],
    });

    const result = runWorkflowChainPlan(normalizeWorkflowChainArgs({ source: root, workflow }));

    expect(result.status).toBe("PASS");
    expect(result.workflowName).toBe("release-readiness");
    expect(result.stepCount).toBe(1);
    expect(result.gateCount).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.plan.steps[0]).toEqual({ id: "review", skill: "alpha", requiredGates: ["validate"] });
  });

  test("blocks missing skills, missing required gates, duplicate ids, and invalid gate commands", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const workflow = writeWorkflow(root, {
      schemaVersion: 1,
      name: "broken",
      gates: [{ id: "bad-gate", command: [] }],
      steps: [
        { id: "same", skill: "alpha", requiredGates: ["missing-gate"] },
        { id: "same", skill: "missing-skill", requiredGates: ["bad-gate"] },
      ],
    });

    const result = runWorkflowChainPlan(normalizeWorkflowChainArgs({ source: root, workflow }));

    expect(result.status).toBe("BLOCKED");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "WORKFLOW_CHAIN_GATE_INVALID_COMMAND",
      "WORKFLOW_CHAIN_REQUIRED_GATE_MISSING",
      "WORKFLOW_CHAIN_SKILL_MISSING",
      "WORKFLOW_CHAIN_STEP_DUPLICATE_ID",
    ]);
  });

  test("blocks unsupported step kinds before an adapter can run", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const workflow = writeWorkflow(root, { schemaVersion: 1, name: "unsupported", steps: [{ id: "one", kind: "shell", skill: "alpha" }] });
    const plan = runWorkflowChainPlan(normalizeWorkflowChainArgs({ source: root, workflow }));

    expect(plan.status).toBe("BLOCKED");
    expect(plan.findings.map((finding) => finding.code)).toContain("WORKFLOW_CHAIN_STEP_KIND_UNSUPPORTED");
    expect(runWorkflowChainExecution(plan, "fixture").findings[0]?.code).toBe("WORKFLOW_CHAIN_EXECUTION_PLAN_BLOCKED");
  });

  test("warns when workflow steps have no required gates and strict blocks warnings", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const workflow = writeWorkflow(root, {
      schemaVersion: 1,
      name: "concerns",
      steps: [{ id: "ungated", skill: "alpha" }],
    });

    const loose = runWorkflowChainPlan(normalizeWorkflowChainArgs({ source: root, workflow }));
    const strict = runWorkflowChainPlan(normalizeWorkflowChainArgs({ source: root, workflow, strict: true }));

    expect(loose.status).toBe("CONCERNS");
    expect(strict.status).toBe("BLOCKED");
    expect(loose.findings[0]?.code).toBe("WORKFLOW_CHAIN_STEP_UNGATED");
  });

  test("is deterministic across runs and renders JSON/text", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const workflow = writeWorkflow(root, {
      schemaVersion: 1,
      name: "deterministic",
      gates: [{ id: "validate", command: ["bun", "run", "validate:local"] }],
      steps: [{ id: "review", skill: "alpha", requiredGates: ["validate"] }],
    });

    const first = runWorkflowChainPlan(normalizeWorkflowChainArgs({ source: root, workflow }));
    const second = runWorkflowChainPlan(normalizeWorkflowChainArgs({ source: root, workflow }));

    expect(first).toEqual(second);
    expect(renderWorkflowChainPlan(first, "text")).toContain("STATUS: PASS");
    expect(JSON.parse(renderWorkflowChainPlan(first, "json"))).toEqual(first);
  });

  test("does not invoke an adapter without explicit execution and passes bounded data in declared order", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    writeSkill(root, "beta");
    const workflow = writeWorkflow(root, {
      schemaVersion: 1,
      name: "adapter-contract",
      gates: [{ id: "first", command: ["not", "run"] }, { id: "second", command: ["also", "not", "run"] }],
      steps: [{ id: "one", skill: "alpha", requiredGates: ["first"] }, { id: "two", skill: "beta", requiredGates: ["first", "second"] }],
    });
    const plan = runWorkflowChainPlan(normalizeWorkflowChainArgs({ source: root, workflow }));
    let calls = 0;
    expect(plan.status).toBe("PASS");
    expect(calls).toBe(0);

    const result = runWorkflowChainExecution(plan, "fixture", (input) => {
      calls += 1;
      expect(input).toEqual({
        schemaVersion: 1,
        workflowName: "adapter-contract",
        gates: [{ id: "first" }, { id: "second" }],
        steps: [
          { id: "one", kind: "skill", skill: "alpha", requiredGates: ["first"] },
          { id: "two", kind: "skill", skill: "beta", requiredGates: ["first", "second"] },
        ],
      });
      return { schemaVersion: 1, gates: input.gates.map((gate) => ({ ...gate, status: "passed" as const })), steps: input.steps.map((step) => ({ id: step.id, status: "completed" as const })) };
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ schemaVersion: 1, command: "workflow-chain", status: "PASS", adapter: "fixture", execution: "executed", findings: [] });
  });

  test("fails closed for unavailable adapters, invalid responses, denied gates, and blocked plans", () => {
    const root = makeTempRoot();
    writeSkill(root, "alpha");
    const workflow = writeWorkflow(root, { schemaVersion: 1, name: "blocked", gates: [{ id: "validate", command: ["not", "run"] }], steps: [{ id: "one", skill: "alpha", requiredGates: ["validate"] }] });
    const plan = runWorkflowChainPlan(normalizeWorkflowChainArgs({ source: root, workflow }));

    expect(runWorkflowChainExecution(plan, "missing").findings[0]?.code).toBe("WORKFLOW_CHAIN_ADAPTER_UNAVAILABLE");
    expect(runWorkflowChainExecution(plan, "bad", () => ({ schemaVersion: 1, gates: [], steps: [] })).findings[0]?.code).toBe("WORKFLOW_CHAIN_ADAPTER_INVALID_RESPONSE");
    expect(runWorkflowChainExecution(plan, "denied", (input) => ({ schemaVersion: 1, gates: input.gates.map((gate) => ({ ...gate, status: "denied" })), steps: input.steps.map((step) => ({ id: step.id, status: "completed" })) })).findings[0]?.code).toBe("WORKFLOW_CHAIN_GATE_DENIED");
    expect(runWorkflowChainExecution({ ...plan, status: "CONCERNS" }, "fixture").findings[0]?.code).toBe("WORKFLOW_CHAIN_EXECUTION_PLAN_BLOCKED");
  });
});
