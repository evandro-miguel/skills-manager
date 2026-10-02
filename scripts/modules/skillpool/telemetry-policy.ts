import fs from "node:fs";
import path from "node:path";
import { withFileLock, writeFileAtomicSafe } from "../../lib/files.ts";

export type TelemetryPolicyStatus = "PASS" | "CONCERNS" | "BLOCKED";

export type TelemetryPolicyFinding = {
  level: "WARN" | "ERROR";
  code: string;
  message: string;
  path?: string;
};

export type TelemetryPolicyCollection = {
  enabled: boolean;
  explicitOptIn: boolean;
  approvedBy: string;
};

export type TelemetryPolicyTransports = {
  remoteUrls: string[];
  localOnly: boolean;
};

export type TelemetryPolicyResult = {
  schemaVersion: 1;
  command: "telemetry-policy";
  status: TelemetryPolicyStatus;
  source: string;
  config: string;
  strict: boolean;
  policyName: string;
  collection: TelemetryPolicyCollection;
  transports: TelemetryPolicyTransports;
  allowedSkillCount: number;
  findings: TelemetryPolicyFinding[];
};

export type TelemetryPolicyInput = {
  source: string;
  config: string;
  strict: boolean;
};

export type TelemetryPolicyArgs = {
  source?: string;
  config?: string;
  strict?: boolean;
};

export type TelemetryCollectionEntry = { event: string; skill: string };

export type TelemetryCollectionResult = {
  schemaVersion: 1;
  command: "telemetry-policy";
  operation: "collect";
  status: "written" | "blocked" | "dry-run";
  written: boolean;
  source: string;
  config: string;
  outputPath: string;
  event: string;
  skill: string;
  approvedBy: string;
  dryRun: boolean;
  findings: TelemetryPolicyFinding[];
  output: string;
};

type JsonObject = Record<string, unknown>;

const SAFE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_CONFIG_PREFIXES = [".skill-sys/", ".agents/local/", ".agents/private/", ".private/skill-sys/"];
const SECRET_PATTERN = /(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/i;

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

export function normalizeTelemetryPolicyArgs(args: TelemetryPolicyArgs): TelemetryPolicyInput {
  if (!args.source) throw new Error("Missing --source");
  if (!args.config) throw new Error("Missing --config");
  const source = path.resolve(args.source);
  const config = path.resolve(args.config);
  assertExistingDirectory(source, "--source");
  assertExistingFile(config, "--config");
  if (fs.lstatSync(config).isSymbolicLink()) throw new Error("--config must not be a symlink");
  return { source, config, strict: args.strict === true };
}

function parsePolicy(input: TelemetryPolicyInput): { raw: string; doc: JsonObject } {
  const raw = fs.readFileSync(input.config, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isObject(parsed)) throw new Error("telemetry policy config must be a JSON object");
  return { raw, doc: parsed };
}

function normalizeCollection(value: unknown): TelemetryPolicyCollection {
  const collection = isObject(value) ? value : {};
  return {
    enabled: collection.enabled === true,
    explicitOptIn: collection.explicitOptIn === true,
    approvedBy: typeof collection.approvedBy === "string" ? collection.approvedBy.trim() : "",
  };
}

function normalizeTransports(value: unknown): TelemetryPolicyTransports {
  const transports = isObject(value) ? value : {};
  return {
    remoteUrls: Array.isArray(transports.remoteUrls) ? transports.remoteUrls.filter((entry): entry is string => typeof entry === "string") : [],
    localOnly: transports.localOnly === true,
  };
}

function relativeConfigPath(input: TelemetryPolicyInput): string {
  return path.relative(input.source, input.config).split(path.sep).join("/");
}

function isSafeConfigPath(relativePath: string): boolean {
  return SAFE_CONFIG_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) && !relativePath.startsWith("../") && !path.isAbsolute(relativePath);
}

function isSafeStoragePath(source: string, target: string): boolean {
  const relative = path.relative(source, target).split(path.sep).join("/");
  if (!isSafeConfigPath(relative)) return false;
  let current = source;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) return false;
  }
  return true;
}

function sortFindings(findings: TelemetryPolicyFinding[]): TelemetryPolicyFinding[] {
  return [...findings].sort((a, b) =>
    [a.level, a.code, a.path ?? "", a.message].join("\0").localeCompare([b.level, b.code, b.path ?? "", b.message].join("\0")),
  );
}

export function runTelemetryPolicy(input: TelemetryPolicyInput): TelemetryPolicyResult {
  const { raw, doc } = parsePolicy(input);
  const findings: TelemetryPolicyFinding[] = [];
  const policyName = typeof doc.name === "string" ? doc.name.trim() : "";
  const visibility = typeof doc.visibility === "string" ? doc.visibility : "";
  const collection = normalizeCollection(doc.collection);
  const transports = normalizeTransports(doc.transports);
  const allowedSkills = Array.isArray(doc.allowedSkills) ? doc.allowedSkills.filter((entry): entry is string => typeof entry === "string") : [];
  const relConfig = relativeConfigPath(input);

  if (doc.schemaVersion !== 1) findings.push({ level: "ERROR", code: "TELEMETRY_POLICY_SCHEMA_VERSION_UNSUPPORTED", message: "schemaVersion must be 1" });
  if (!SAFE_NAME_PATTERN.test(policyName)) findings.push({ level: "ERROR", code: "TELEMETRY_POLICY_NAME_INVALID", message: "name must be a safe identifier" });
  if (visibility !== "private" && visibility !== "local") findings.push({ level: "ERROR", code: "TELEMETRY_POLICY_PUBLIC_FORBIDDEN", message: "visibility must be private or local" });
  if (doc.packageSurface !== false) findings.push({ level: "ERROR", code: "TELEMETRY_POLICY_PACKAGE_SURFACE_FORBIDDEN", message: "packageSurface must be false" });
  if (!isSafeConfigPath(relConfig)) findings.push({ level: "ERROR", code: "TELEMETRY_POLICY_CONFIG_PATH_UNSAFE", path: relConfig, message: "config path must stay under a local/private prefix" });
  if (collection.enabled && !collection.explicitOptIn) findings.push({ level: "ERROR", code: "TELEMETRY_POLICY_ENABLED_WITHOUT_OPT_IN", message: "enabled telemetry requires explicit opt-in" });
  if (collection.enabled && !collection.approvedBy) findings.push({ level: "ERROR", code: "TELEMETRY_POLICY_ENABLED_WITHOUT_APPROVER", message: "enabled telemetry requires approvedBy" });
  if (transports.remoteUrls.length > 0) findings.push({ level: "ERROR", code: "TELEMETRY_POLICY_REMOTE_URLS_FORBIDDEN", message: "remote telemetry URLs are forbidden in the offline MVP" });
  if (!transports.localOnly) findings.push({ level: "ERROR", code: "TELEMETRY_POLICY_LOCAL_ONLY_REQUIRED", message: "transports.localOnly must be true" });
  if (allowedSkills.length === 0) findings.push({ level: "WARN", code: "TELEMETRY_POLICY_NO_ALLOWED_SKILLS", message: "policy should declare at least one allowed skill" });
  if (SECRET_PATTERN.test(raw)) findings.push({ level: "ERROR", code: "TELEMETRY_POLICY_SENSITIVE_TEXT", message: "config contains secret-looking text" });

  const sortedFindings = sortFindings(findings);
  const hasError = sortedFindings.some((finding) => finding.level === "ERROR");
  const hasWarning = sortedFindings.some((finding) => finding.level === "WARN");
  const status: TelemetryPolicyStatus = hasError || (input.strict && hasWarning) ? "BLOCKED" : hasWarning ? "CONCERNS" : "PASS";

  return {
    schemaVersion: 1,
    command: "telemetry-policy",
    status,
    source: input.source,
    config: input.config,
    strict: input.strict,
    policyName,
    collection,
    transports,
    allowedSkillCount: allowedSkills.length,
    findings: sortedFindings,
  };
}

export function renderTelemetryPolicyResult(result: TelemetryPolicyResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status}`,
    `Policy: ${result.policyName}`,
    `Source: ${result.source}`,
    `Config: ${result.config}`,
    `Collection enabled: ${result.collection.enabled}`,
    `Explicit opt-in: ${result.collection.explicitOptIn}`,
    `Local only: ${result.transports.localOnly}`,
    `Remote URLs: ${result.transports.remoteUrls.length}`,
    `Allowed skills: ${result.allowedSkillCount}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const finding of result.findings) lines.push(`- [${finding.level} ${finding.code}] ${finding.message}`);
  return lines.join("\n");
}

function collectionFinding(code: string, message: string): TelemetryPolicyFinding {
  return { level: "ERROR", code, message };
}

/** Explicit local collection only; records have no generated IDs or timestamps. */
export function applyTelemetryCollection(
  input: TelemetryPolicyInput,
  entry: TelemetryCollectionEntry,
  outputPath: string,
  options: { dryRun?: boolean } = {},
): TelemetryCollectionResult {
  const dryRun = options.dryRun === true;
  const validation = runTelemetryPolicy(input);
  const event = typeof entry.event === "string" ? entry.event.trim() : "";
  const skill = typeof entry.skill === "string" ? entry.skill.trim() : "";
  const resolvedOutput = path.resolve(outputPath);
  const blocked = (findings: TelemetryPolicyFinding[], output = ""): TelemetryCollectionResult => ({
    schemaVersion: 1, command: "telemetry-policy", operation: "collect", status: "blocked", written: false,
    source: input.source, config: input.config, outputPath: resolvedOutput, event, skill,
    approvedBy: validation.collection.approvedBy, dryRun, findings: sortFindings(findings), output,
  });

  if (validation.status === "BLOCKED") return blocked(validation.findings);
  if (!validation.collection.enabled) return blocked([collectionFinding("TELEMETRY_COLLECTION_DISABLED", "telemetry collection is disabled by policy")]);
  if (!validation.collection.explicitOptIn) return blocked([collectionFinding("TELEMETRY_COLLECTION_OPT_IN_REQUIRED", "telemetry collection requires explicit opt-in")]);
  if (!validation.collection.approvedBy) return blocked([collectionFinding("TELEMETRY_COLLECTION_APPROVER_REQUIRED", "telemetry collection requires approvedBy")]);
  if (!SAFE_NAME_PATTERN.test(event)) return blocked([collectionFinding("TELEMETRY_COLLECTION_EVENT_INVALID", "event must be a safe identifier")]);
  if (!SAFE_NAME_PATTERN.test(skill)) return blocked([collectionFinding("TELEMETRY_COLLECTION_SKILL_INVALID", "skill must be a safe identifier")]);

  const { doc } = parsePolicy(input);
  const allowedSkills = Array.isArray(doc.allowedSkills) ? doc.allowedSkills.filter((value): value is string => typeof value === "string") : [];
  if (!allowedSkills.includes(skill)) return blocked([collectionFinding("TELEMETRY_COLLECTION_SKILL_NOT_ALLOWED", "skill is not allowed by telemetry policy")]);
  if (!isSafeStoragePath(input.source, resolvedOutput)) return blocked([collectionFinding("TELEMETRY_COLLECTION_OUTPUT_PATH_UNSAFE", "output path must stay under a local/private prefix without symlinks")]);

  const output = `${JSON.stringify({ schemaVersion: 1, event, skill, approvedBy: validation.collection.approvedBy })}\n`;
  if (dryRun) return { ...blocked([], output), status: "dry-run", dryRun: true };

  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  const outcome = withFileLock<Error | null>(resolvedOutput, () => {
    try {
      let current = "";
      try { current = fs.readFileSync(resolvedOutput, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const next = current.length > 0 && !current.endsWith("\n") ? `${current}\n${output}` : `${current}${output}`;
      writeFileAtomicSafe(resolvedOutput, next);
      return null;
    } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  });
  if (outcome.status === "locked" || outcome.value !== null) {
    const writeError = outcome.status === "locked" ? null : outcome.value;
    const message = writeError === null ? "telemetry output is locked by another writer; retry" : `failed to write telemetry output: ${writeError.message}`;
    return blocked([collectionFinding("TELEMETRY_COLLECTION_WRITE_FAILED", message)], output);
  }
  return { ...blocked([], output), status: "written", written: true };
}

export function renderTelemetryCollectionResult(result: TelemetryCollectionResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [`STATUS: ${result.status.toUpperCase()}`, `Operation: ${result.operation}`, `Event: ${result.event}`, `Skill: ${result.skill}`, `Output: ${result.outputPath}`, `Dry run: ${result.dryRun}`, `Findings: ${result.findings.length}`];
  for (const finding of result.findings) lines.push(`- [${finding.level} ${finding.code}] ${finding.message}`);
  if (result.dryRun) lines.push("", "Output:", result.output);
  return lines.join("\n");
}
