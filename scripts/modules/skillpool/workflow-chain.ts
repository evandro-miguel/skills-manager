import fs from "node:fs";
import path from "node:path";

export type WorkflowChainStatus = "PASS" | "CONCERNS" | "BLOCKED";
export type WorkflowChainFindingLevel = "WARN" | "ERROR";

export type WorkflowChainFinding = {
  level: WorkflowChainFindingLevel;
  code: string;
  message: string;
  path?: string;
  step?: string;
  gate?: string;
  skill?: string;
};

export type WorkflowChainGatePlan = {
  id: string;
  command: string[];
};

export type WorkflowChainStepPlan = {
  id: string;
  skill: string;
  requiredGates: string[];
};

export type WorkflowChainPlan = {
  gates: WorkflowChainGatePlan[];
  steps: WorkflowChainStepPlan[];
};

export type WorkflowChainResult = {
  schemaVersion: 1;
  command: "workflow-chain";
  status: WorkflowChainStatus;
  source: string;
  workflow: string;
  strict: boolean;
  workflowName: string;
  stepCount: number;
  gateCount: number;
  plan: WorkflowChainPlan;
  findings: WorkflowChainFinding[];
};

export type WorkflowChainInput = {
  source: string;
  workflow: string;
  strict: boolean;
};

export type WorkflowChainArgs = {
  source?: string;
  workflow?: string;
  strict?: boolean;
};

export type WorkflowChainAdapterInput = {
  schemaVersion: 1;
  workflowName: string;
  gates: Array<{ id: string }>;
  steps: Array<{ id: string; kind: "skill"; skill: string; requiredGates: string[] }>;
};

export type WorkflowChainAdapterResponse = {
  schemaVersion: 1;
  gates: Array<{ id: string; status: "passed" | "denied" }>;
  steps: Array<{ id: string; status: "completed" }>;
};

export type WorkflowChainAdapter = (input: WorkflowChainAdapterInput) => WorkflowChainAdapterResponse;

export type WorkflowChainExecutionResult = {
  schemaVersion: 1;
  command: "workflow-chain";
  status: "PASS" | "BLOCKED";
  adapter: string;
  execution: "executed" | "blocked";
  findings: WorkflowChainFinding[];
};

type JsonObject = Record<string, unknown>;

const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_SKILL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}

function addFinding(findings: WorkflowChainFinding[], finding: WorkflowChainFinding): void {
  findings.push(finding);
}

function assertExistingDirectory(dir: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`${label} does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${dir}`);
  }
}

function assertExistingFile(file: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${label} does not exist: ${file}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a file: ${file}`);
  }
}

export function normalizeWorkflowChainArgs(args: WorkflowChainArgs): WorkflowChainInput {
  if (!args.source) {
    throw new Error("Missing --source");
  }
  if (!args.workflow) {
    throw new Error("Missing --workflow");
  }
  const source = path.resolve(args.source);
  const workflow = path.resolve(args.workflow);
  assertExistingDirectory(source, "--source");
  assertExistingFile(workflow, "--workflow");
  if (fs.lstatSync(workflow).isSymbolicLink()) {
    throw new Error("--workflow must not be a symlink");
  }
  return { source, workflow, strict: args.strict === true };
}

function parseWorkflowJson(input: WorkflowChainInput, findings: WorkflowChainFinding[]): JsonObject | null {
  let raw: string;
  try {
    raw = fs.readFileSync(input.workflow, "utf8");
  } catch (error) {
    addFinding(findings, {
      level: "ERROR",
      code: "WORKFLOW_CHAIN_READ_FAILED",
      path: toRelative(input.source, input.workflow),
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      addFinding(findings, {
        level: "ERROR",
        code: "WORKFLOW_CHAIN_INVALID_SHAPE",
        path: toRelative(input.source, input.workflow),
        message: "Workflow chain must be a JSON object",
      });
      return null;
    }
    return parsed;
  } catch (error) {
    addFinding(findings, {
      level: "ERROR",
      code: "WORKFLOW_CHAIN_INVALID_JSON",
      path: toRelative(input.source, input.workflow),
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function validateName(value: unknown, findings: WorkflowChainFinding[], relPath: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  addFinding(findings, {
    level: "ERROR",
    code: "WORKFLOW_CHAIN_NAME_MISSING",
    path: relPath,
    message: "Workflow chain requires a non-empty name",
  });
  return "";
}

function parseStringArray(value: unknown, code: string, message: string, findings: WorkflowChainFinding[], context: Omit<WorkflowChainFinding, "level" | "code" | "message">): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    addFinding(findings, { ...context, level: "ERROR", code, message });
    return [];
  }
  return value.map((entry) => entry.trim());
}

function parseGates(workflow: JsonObject, findings: WorkflowChainFinding[], relPath: string): WorkflowChainGatePlan[] {
  const gatesValue = workflow.gates;
  if (gatesValue === undefined) return [];
  if (!Array.isArray(gatesValue)) {
    addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_GATES_INVALID", path: relPath, message: "gates must be an array" });
    return [];
  }

  const seen = new Set<string>();
  const gates: WorkflowChainGatePlan[] = [];
  for (const entry of gatesValue) {
    if (!isObject(entry)) {
      addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_GATE_INVALID_SHAPE", path: relPath, message: "gate entries must be objects" });
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!SAFE_ID_PATTERN.test(id)) {
      addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_GATE_INVALID_ID", path: relPath, gate: id, message: "gate.id must be a safe non-empty identifier" });
      continue;
    }
    if (seen.has(id)) {
      addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_GATE_DUPLICATE_ID", path: relPath, gate: id, message: `Duplicate gate id: ${id}` });
      continue;
    }
    seen.add(id);
    const command = parseStringArray(entry.command, "WORKFLOW_CHAIN_GATE_INVALID_COMMAND", "gate.command must be a non-empty command vector", findings, { path: relPath, gate: id });
    if (command.length === 0) {
      if (entry.command === undefined) {
        addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_GATE_INVALID_COMMAND", path: relPath, gate: id, message: "gate.command must be a non-empty command vector" });
      }
    }
    gates.push({ id, command });
  }
  return gates;
}

function skillExists(source: string, skill: string): boolean {
  const skillPath = path.join(source, "skills", skill, "SKILL.md");
  try {
    const stat = fs.statSync(skillPath);
    return stat.isFile() && !fs.lstatSync(skillPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function parseSteps(workflow: JsonObject, input: WorkflowChainInput, gateIds: Set<string>, findings: WorkflowChainFinding[], relPath: string): WorkflowChainStepPlan[] {
  const stepsValue = workflow.steps;
  if (!Array.isArray(stepsValue) || stepsValue.length === 0) {
    addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_STEPS_INVALID", path: relPath, message: "steps must be a non-empty array" });
    return [];
  }

  const seen = new Set<string>();
  const steps: WorkflowChainStepPlan[] = [];
  for (const entry of stepsValue) {
    if (!isObject(entry)) {
      addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_STEP_INVALID_SHAPE", path: relPath, message: "step entries must be objects" });
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!SAFE_ID_PATTERN.test(id)) {
      addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_STEP_INVALID_ID", path: relPath, step: id, message: "step.id must be a safe non-empty identifier" });
      continue;
    }
    if (seen.has(id)) {
      addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_STEP_DUPLICATE_ID", path: relPath, step: id, message: `Duplicate step id: ${id}` });
    }
    seen.add(id);

    const skill = typeof entry.skill === "string" ? entry.skill.trim() : "";
    if (entry.kind !== undefined && entry.kind !== "skill") {
      addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_STEP_KIND_UNSUPPORTED", path: relPath, step: id, message: "step.kind must be skill when provided" });
    }
    if (!SAFE_SKILL_PATTERN.test(skill)) {
      addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_SKILL_INVALID", path: relPath, step: id, skill, message: "step.skill must be a safe skill name" });
    } else if (!skillExists(input.source, skill)) {
      addFinding(findings, { level: "ERROR", code: "WORKFLOW_CHAIN_SKILL_MISSING", path: relPath, step: id, skill, message: `Step references missing skill: ${skill}` });
    }

    const requiredGates = parseStringArray(
      entry.requiredGates,
      "WORKFLOW_CHAIN_REQUIRED_GATES_INVALID",
      "step.requiredGates must be an array of gate ids",
      findings,
      { path: relPath, step: id, skill },
    );
    if (requiredGates.length === 0) {
      addFinding(findings, {
        level: "WARN",
        code: "WORKFLOW_CHAIN_STEP_UNGATED",
        path: relPath,
        step: id,
        skill,
        message: "Workflow step has no required gates",
      });
    }
    for (const gate of requiredGates) {
      if (!gateIds.has(gate)) {
        addFinding(findings, {
          level: "ERROR",
          code: "WORKFLOW_CHAIN_REQUIRED_GATE_MISSING",
          path: relPath,
          step: id,
          gate,
          skill,
          message: `Step requires missing gate: ${gate}`,
        });
      }
    }
    steps.push({ id, skill, requiredGates });
  }
  return steps;
}

function sortFindings(findings: WorkflowChainFinding[]): WorkflowChainFinding[] {
  return [...findings].sort((a, b) =>
    [a.level, a.code, a.step ?? "", a.gate ?? "", a.skill ?? "", a.path ?? "", a.message].join("\0").localeCompare(
      [b.level, b.code, b.step ?? "", b.gate ?? "", b.skill ?? "", b.path ?? "", b.message].join("\0"),
    ),
  );
}

export function runWorkflowChainPlan(input: WorkflowChainInput): WorkflowChainResult {
  const findings: WorkflowChainFinding[] = [];
  const relPath = toRelative(input.source, input.workflow);
  const workflow = parseWorkflowJson(input, findings);
  const workflowName = workflow ? validateName(workflow.name, findings, relPath) : "";

  if (workflow && workflow.schemaVersion !== 1) {
    addFinding(findings, {
      level: "ERROR",
      code: "WORKFLOW_CHAIN_SCHEMA_VERSION_UNSUPPORTED",
      path: relPath,
      message: "schemaVersion must be 1",
    });
  }

  const gates = workflow ? parseGates(workflow, findings, relPath) : [];
  const steps = workflow ? parseSteps(workflow, input, new Set(gates.map((gate) => gate.id)), findings, relPath) : [];
  const sortedFindings = sortFindings(findings);
  const hasError = sortedFindings.some((finding) => finding.level === "ERROR");
  const hasWarning = sortedFindings.some((finding) => finding.level === "WARN");
  const status: WorkflowChainStatus = hasError || (input.strict && hasWarning) ? "BLOCKED" : hasWarning ? "CONCERNS" : "PASS";

  return {
    schemaVersion: 1,
    command: "workflow-chain",
    status,
    source: input.source,
    workflow: input.workflow,
    strict: input.strict,
    workflowName,
    stepCount: steps.length,
    gateCount: gates.length,
    plan: { gates, steps },
    findings: sortedFindings,
  };
}

function executionFinding(code: string, message: string, extra: Pick<WorkflowChainFinding, "gate" | "step"> = {}): WorkflowChainFinding {
  return { level: "ERROR", code, message, ...extra };
}

function blockedExecution(adapter: string, finding: WorkflowChainFinding): WorkflowChainExecutionResult {
  return { schemaVersion: 1, command: "workflow-chain", status: "BLOCKED", adapter, execution: "blocked", findings: [finding] };
}

function adapterInput(plan: WorkflowChainResult): WorkflowChainAdapterInput {
  return {
    schemaVersion: 1,
    workflowName: plan.workflowName,
    gates: plan.plan.gates.map((gate) => ({ id: gate.id })),
    steps: plan.plan.steps.map((step) => ({ id: step.id, kind: "skill", skill: step.skill, requiredGates: [...step.requiredGates] })),
  };
}

function hasExactIds(values: Array<{ id: string }>, expected: string[]): boolean {
  return values.length === expected.length && values.every((value, index) => value.id === expected[index]);
}

/**
 * Executes only a declared in-process adapter. It never evaluates workflow text,
 * gate command vectors, or skill content; production adapters remain unsupported.
 */
export function runWorkflowChainExecution(plan: WorkflowChainResult, adapterName: string, adapter?: WorkflowChainAdapter): WorkflowChainExecutionResult {
  if (plan.status !== "PASS") {
    return blockedExecution(adapterName, executionFinding("WORKFLOW_CHAIN_EXECUTION_PLAN_BLOCKED", "Workflow validation must pass before adapter execution"));
  }
  if (!adapter) {
    return blockedExecution(adapterName, executionFinding("WORKFLOW_CHAIN_ADAPTER_UNAVAILABLE", `Workflow adapter is unavailable: ${adapterName}`));
  }

  let response: WorkflowChainAdapterResponse;
  try {
    response = adapter(adapterInput(plan));
  } catch {
    return blockedExecution(adapterName, executionFinding("WORKFLOW_CHAIN_ADAPTER_INVALID_RESPONSE", "Workflow adapter returned an invalid response"));
  }

  const expectedGateIds = plan.plan.gates.map((gate) => gate.id);
  const expectedStepIds = plan.plan.steps.map((step) => step.id);
  if (!response || response.schemaVersion !== 1 || !Array.isArray(response.gates) || !Array.isArray(response.steps) ||
      !hasExactIds(response.gates, expectedGateIds) || !hasExactIds(response.steps, expectedStepIds) ||
      response.gates.some((gate) => gate.status !== "passed" && gate.status !== "denied") ||
      response.steps.some((step) => step.status !== "completed")) {
    return blockedExecution(adapterName, executionFinding("WORKFLOW_CHAIN_ADAPTER_INVALID_RESPONSE", "Workflow adapter returned an invalid response"));
  }

  const deniedGate = response.gates.find((gate) => gate.status === "denied");
  if (deniedGate) {
    return blockedExecution(adapterName, executionFinding("WORKFLOW_CHAIN_GATE_DENIED", `Workflow gate denied: ${deniedGate.id}`, { gate: deniedGate.id }));
  }

  return { schemaVersion: 1, command: "workflow-chain", status: "PASS", adapter: adapterName, execution: "executed", findings: [] };
}

export const localTestWorkflowAdapter: WorkflowChainAdapter = (input) => ({
  schemaVersion: 1,
  gates: input.gates.map((gate) => ({ id: gate.id, status: "passed" })),
  steps: input.steps.map((step) => ({ id: step.id, status: "completed" })),
});

export function renderWorkflowChainPlan(result: WorkflowChainResult, format: "text" | "json" = "text"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  const lines = [
    `STATUS: ${result.status}`,
    `Workflow: ${result.workflowName || "<invalid>"}`,
    `Source: ${result.source}`,
    `Workflow file: ${result.workflow}`,
    `Steps: ${result.stepCount}`,
    `Gates: ${result.gateCount}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const finding of result.findings) {
    const parts = [finding.level, finding.code];
    if (finding.step) parts.push(`step=${finding.step}`);
    if (finding.gate) parts.push(`gate=${finding.gate}`);
    if (finding.skill) parts.push(`skill=${finding.skill}`);
    lines.push(`- [${parts.join(" ")}] ${finding.message}`);
  }
  return lines.join("\n");
}
