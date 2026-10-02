import fs from "node:fs";
import path from "node:path";

export type RouteStatus = "PASS" | "CONCERNS" | "BLOCKED";
export type RouteFindingLevel = "WARN" | "ERROR";

export type RouteFinding = {
  level: RouteFindingLevel;
  code: string;
  message: string;
  path?: string;
  rule?: string;
  skill?: string;
};

export type RouteCandidate = {
  rule: string;
  skill: string;
  score: number;
  matchedTriggers: string[];
  manualOnly: boolean;
};

export type RouteResult = {
  schemaVersion: 1;
  command: "route";
  status: RouteStatus;
  source: string;
  rules: string;
  query: string;
  strict: boolean;
  rulesName: string;
  ruleCount: number;
  candidateCount: number;
  candidates: RouteCandidate[];
  findings: RouteFinding[];
};

export type RouteInput = {
  source: string;
  rules: string;
  query: string;
  strict: boolean;
};

export type RouteArgs = {
  source?: string;
  rules?: string;
  query?: string;
  strict?: boolean;
};

export type RouteAdapterCandidate = Pick<RouteCandidate, "rule" | "skill" | "score" | "manualOnly">;
export type RouteAdapterInput = { schemaVersion: 1; candidates: RouteAdapterCandidate[] };
export type RouteAdapterResponse = { schemaVersion: 1; selected: { rule: string; skill: string } };
export type RouteAdapter = (input: RouteAdapterInput) => RouteAdapterResponse;
export type RouteExecutionFinding = { level: "ERROR"; code: string; message: string };
export type RouteExecutionResult = {
  schemaVersion: 1;
  command: "route";
  status: "PASS" | "BLOCKED";
  adapter: string;
  execution: "executed" | "blocked";
  decision: "selected" | "blocked";
  selected?: { rule: string; skill: string };
  findings: RouteExecutionFinding[];
};

type JsonObject = Record<string, unknown>;
type ParsedRule = { id: string; skill: string; triggers: string[]; priority: number; manualOnly: boolean };

const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_SKILL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RISKY_FLAGS = [
  "writesProject",
  "writesGlobal",
  "executesShell",
  "networkAccess",
  "externalDirectory",
  "credentialSensitive",
  "destructive",
  "browserAuthState",
  "repoMutation",
] as const;
const MAX_ADAPTER_CANDIDATES = 32;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}

function addFinding(findings: RouteFinding[], finding: RouteFinding): void {
  findings.push(finding);
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

export function normalizeRouteArgs(args: RouteArgs): RouteInput {
  if (!args.source) throw new Error("Missing --source");
  if (!args.rules) throw new Error("Missing --rules");
  if (!args.query || !args.query.trim()) throw new Error("Missing --query");
  const source = path.resolve(args.source);
  const rules = path.resolve(args.rules);
  assertExistingDirectory(source, "--source");
  assertExistingFile(rules, "--rules");
  if (fs.lstatSync(rules).isSymbolicLink()) throw new Error("--rules must not be a symlink");
  return { source, rules, query: args.query.trim(), strict: args.strict === true };
}

function parseRulesJson(input: RouteInput, findings: RouteFinding[]): JsonObject | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(input.rules, "utf8")) as unknown;
    if (!isObject(parsed)) {
      addFinding(findings, { level: "ERROR", code: "ROUTE_RULES_INVALID_SHAPE", path: toRelative(input.source, input.rules), message: "Routing rules must be a JSON object" });
      return null;
    }
    return parsed;
  } catch (error) {
    addFinding(findings, { level: "ERROR", code: "ROUTE_RULES_INVALID_JSON", path: toRelative(input.source, input.rules), message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function skillPath(source: string, skill: string): string {
  return path.join(source, "skills", skill, "SKILL.md");
}

function skillExists(source: string, skill: string): boolean {
  try {
    const file = skillPath(source, skill);
    return fs.statSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function riskySkillRequiresManual(source: string, skill: string): boolean {
  const metaPath = path.join(source, "skills", skill, "skill.meta.json");
  if (!fs.existsSync(metaPath) || fs.lstatSync(metaPath).isSymbolicLink()) return false;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as unknown;
    if (!isObject(meta) || !isObject(meta.risk)) return false;
    const risk = meta.risk as Record<string, unknown>;
    return RISKY_FLAGS.some((flag) => risk[flag] === true);
  } catch {
    return false;
  }
}

function parseRules(rulesDoc: JsonObject, input: RouteInput, findings: RouteFinding[]): { name: string; rules: ParsedRule[] } {
  const relPath = toRelative(input.source, input.rules);
  const name = typeof rulesDoc.name === "string" && rulesDoc.name.trim() ? rulesDoc.name.trim() : "";
  if (!name) addFinding(findings, { level: "ERROR", code: "ROUTE_RULES_NAME_MISSING", path: relPath, message: "Routing rules require a non-empty name" });
  if (rulesDoc.schemaVersion !== 1) addFinding(findings, { level: "ERROR", code: "ROUTE_RULES_SCHEMA_VERSION_UNSUPPORTED", path: relPath, message: "schemaVersion must be 1" });
  if (!Array.isArray(rulesDoc.rules) || rulesDoc.rules.length === 0) {
    addFinding(findings, { level: "ERROR", code: "ROUTE_RULES_EMPTY", path: relPath, message: "rules must be a non-empty array" });
    return { name, rules: [] };
  }

  const seen = new Set<string>();
  const rules: ParsedRule[] = [];
  for (const entry of rulesDoc.rules) {
    if (!isObject(entry)) {
      addFinding(findings, { level: "ERROR", code: "ROUTE_RULE_INVALID_SHAPE", path: relPath, message: "rule entries must be objects" });
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!SAFE_ID_PATTERN.test(id)) {
      addFinding(findings, { level: "ERROR", code: "ROUTE_RULE_INVALID_ID", path: relPath, rule: id, message: "rule.id must be a safe non-empty identifier" });
      continue;
    }
    if (seen.has(id)) addFinding(findings, { level: "ERROR", code: "ROUTE_RULE_DUPLICATE_ID", path: relPath, rule: id, message: `Duplicate rule id: ${id}` });
    seen.add(id);

    const skill = typeof entry.skill === "string" ? entry.skill.trim() : "";
    if (!SAFE_SKILL_PATTERN.test(skill)) {
      addFinding(findings, { level: "ERROR", code: "ROUTE_RULE_SKILL_INVALID", path: relPath, rule: id, skill, message: "rule.skill must be a safe skill name" });
    } else if (!skillExists(input.source, skill)) {
      addFinding(findings, { level: "ERROR", code: "ROUTE_RULE_SKILL_MISSING", path: relPath, rule: id, skill, message: `Rule references missing skill: ${skill}` });
    }

    const triggers = Array.isArray(entry.triggers) && entry.triggers.length > 0 && entry.triggers.every((trigger) => typeof trigger === "string" && trigger.trim())
      ? entry.triggers.map((trigger) => String(trigger).trim())
      : [];
    if (triggers.length === 0) addFinding(findings, { level: "ERROR", code: "ROUTE_RULE_TRIGGERS_INVALID", path: relPath, rule: id, skill, message: "rule.triggers must be a non-empty array of strings" });

    const priority = entry.priority === undefined ? 0 : typeof entry.priority === "number" && Number.isInteger(entry.priority) ? entry.priority : 0;
    if (entry.priority !== undefined && (typeof entry.priority !== "number" || !Number.isInteger(entry.priority))) {
      addFinding(findings, { level: "ERROR", code: "ROUTE_RULE_PRIORITY_INVALID", path: relPath, rule: id, skill, message: "rule.priority must be an integer" });
    }
    const manualOnly = entry.manualOnly === true;
    if (skill && riskySkillRequiresManual(input.source, skill) && !manualOnly) {
      addFinding(findings, { level: "ERROR", code: "ROUTE_RULE_DANGEROUS_IMPLICIT", path: relPath, rule: id, skill, message: "Risky skills must be routed as manualOnly" });
    }
    rules.push({ id, skill, triggers, priority, manualOnly });
  }
  return { name, rules };
}

function routeCandidates(query: string, rules: ParsedRule[]): RouteCandidate[] {
  const normalized = query.toLowerCase();
  return rules
    .map((rule) => {
      const matchedTriggers = rule.triggers.filter((trigger) => normalized.includes(trigger.toLowerCase())).sort();
      return { rule: rule.id, skill: rule.skill, score: rule.priority + matchedTriggers.length, matchedTriggers, manualOnly: rule.manualOnly };
    })
    .filter((candidate) => candidate.matchedTriggers.length > 0)
    .sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill) || a.rule.localeCompare(b.rule));
}

function sortFindings(findings: RouteFinding[]): RouteFinding[] {
  return [...findings].sort((a, b) =>
    [a.level, a.code, a.rule ?? "", a.skill ?? "", a.path ?? "", a.message].join("\0").localeCompare(
      [b.level, b.code, b.rule ?? "", b.skill ?? "", b.path ?? "", b.message].join("\0"),
    ),
  );
}

export function runRouteQuery(input: RouteInput): RouteResult {
  const findings: RouteFinding[] = [];
  const doc = parseRulesJson(input, findings);
  const parsed = doc ? parseRules(doc, input, findings) : { name: "", rules: [] };
  const candidates = routeCandidates(input.query, parsed.rules);
  if (doc && candidates.length === 0) {
    addFinding(findings, { level: "WARN", code: "ROUTE_NO_MATCH", path: toRelative(input.source, input.rules), message: "No routing rule matched the query" });
  }
  const sortedFindings = sortFindings(findings);
  const hasError = sortedFindings.some((finding) => finding.level === "ERROR");
  const hasWarning = sortedFindings.some((finding) => finding.level === "WARN");
  const status: RouteStatus = hasError || (input.strict && hasWarning) ? "BLOCKED" : hasWarning ? "CONCERNS" : "PASS";
  return {
    schemaVersion: 1,
    command: "route",
    status,
    source: input.source,
    rules: input.rules,
    query: input.query,
    strict: input.strict,
    rulesName: parsed.name,
    ruleCount: parsed.rules.length,
    candidateCount: candidates.length,
    candidates,
    findings: sortedFindings,
  };
}

function executionFinding(code: string, message: string): RouteExecutionFinding {
  return { level: "ERROR", code, message };
}

function blockedExecution(adapter: string, finding: RouteExecutionFinding): RouteExecutionResult {
  return { schemaVersion: 1, command: "route", status: "BLOCKED", adapter, execution: "blocked", decision: "blocked", findings: [finding] };
}

function adapterInput(result: RouteResult): RouteAdapterInput {
  return {
    schemaVersion: 1,
    // Never transfer query text, paths, or matched trigger text to adapters.
    candidates: result.candidates.map(({ rule, skill, score, manualOnly }) => ({ rule, skill, score, manualOnly })),
  };
}

function isRouteAdapterResponse(value: unknown): value is RouteAdapterResponse {
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.selected)) return false;
  return typeof value.selected.rule === "string" && typeof value.selected.skill === "string";
}

/** Runs only an in-process adapter over a bounded, sanitized candidate list. */
export function runRouteExecution(result: RouteResult, adapterName: string, adapter?: RouteAdapter): RouteExecutionResult {
  if (result.candidates.length === 0) return blockedExecution(adapterName, executionFinding("ROUTE_ADAPTER_NO_MATCH", "No route candidate is available for adapter execution"));
  if (result.status !== "PASS") return blockedExecution(adapterName, executionFinding("ROUTE_ADAPTER_PLAN_BLOCKED", "Routing validation must pass before adapter execution"));
  if (result.candidates.length > MAX_ADAPTER_CANDIDATES) return blockedExecution(adapterName, executionFinding("ROUTE_ADAPTER_CANDIDATE_LIMIT", "Routing candidate set exceeds the adapter limit"));
  if (!adapter) return blockedExecution(adapterName, executionFinding("ROUTE_ADAPTER_UNAVAILABLE", `Routing adapter is unavailable: ${adapterName}`));

  const input = adapterInput(result);
  let first: RouteAdapterResponse;
  let second: RouteAdapterResponse;
  try {
    first = adapter(input);
    second = adapter(input);
  } catch {
    return blockedExecution(adapterName, executionFinding("ROUTE_ADAPTER_INVALID_RESPONSE", "Routing adapter returned an invalid response"));
  }
  if (!isRouteAdapterResponse(first) || !isRouteAdapterResponse(second)) return blockedExecution(adapterName, executionFinding("ROUTE_ADAPTER_INVALID_RESPONSE", "Routing adapter returned an invalid response"));
  if (JSON.stringify(first) !== JSON.stringify(second)) return blockedExecution(adapterName, executionFinding("ROUTE_ADAPTER_NONDETERMINISTIC", "Routing adapter returned a non-deterministic response"));

  const selected = result.candidates.find((candidate) => candidate.rule === first.selected.rule && candidate.skill === first.selected.skill);
  if (!selected) return blockedExecution(adapterName, executionFinding("ROUTE_ADAPTER_CANDIDATE_FORBIDDEN", "Routing adapter selected a candidate outside the validated set"));
  if (selected.manualOnly) return blockedExecution(adapterName, executionFinding("ROUTE_ADAPTER_MANUAL_ONLY", "Routing adapter cannot select a manual-only candidate"));
  return { schemaVersion: 1, command: "route", status: "PASS", adapter: adapterName, execution: "executed", decision: "selected", selected: { rule: selected.rule, skill: selected.skill }, findings: [] };
}

export const localTestRouteAdapter: RouteAdapter = (input) => ({
  schemaVersion: 1,
  selected: { rule: input.candidates[0]!.rule, skill: input.candidates[0]!.skill },
});

export function renderRouteResult(result: RouteResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status}`,
    `Rules: ${result.rulesName || "<invalid>"}`,
    `Source: ${result.source}`,
    `Rules file: ${result.rules}`,
    `Query: ${result.query}`,
    `Rules checked: ${result.ruleCount}`,
    `Candidates: ${result.candidateCount}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const candidate of result.candidates) {
    lines.push(`- candidate rule=${candidate.rule} skill=${candidate.skill} score=${candidate.score} manualOnly=${candidate.manualOnly} triggers=${candidate.matchedTriggers.join(",")}`);
  }
  for (const finding of result.findings) {
    const parts = [finding.level, finding.code];
    if (finding.rule) parts.push(`rule=${finding.rule}`);
    if (finding.skill) parts.push(`skill=${finding.skill}`);
    lines.push(`- [${parts.join(" ")}] ${finding.message}`);
  }
  return lines.join("\n");
}
