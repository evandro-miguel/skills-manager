import fs from "node:fs";
import path from "node:path";
import { withFileLock, writeFileAtomicSafe } from "../../lib/files.ts";

export type ProjectLearningsStatus = "PASS" | "CONCERNS" | "BLOCKED";
export type ProjectLearningsFindingLevel = "WARN" | "ERROR";

export type ProjectLearningsFinding = {
  level: ProjectLearningsFindingLevel;
  code: string;
  message: string;
  path?: string;
  entry?: string;
};

export type ProjectLearningsPolicy = {
  visibility: "private" | "local";
  packageSurface: boolean;
  localOnly: boolean;
};

export type ProjectLearningsResult = {
  schemaVersion: 1;
  command: "project-learnings";
  status: ProjectLearningsStatus;
  source: string;
  learnings: string;
  strict: boolean;
  learningsName: string;
  entryCount: number;
  policy: ProjectLearningsPolicy;
  findings: ProjectLearningsFinding[];
};

export type ProjectLearningsInput = {
  source: string;
  learnings: string;
  strict: boolean;
};

export type ProjectLearningsArgs = {
  source?: string;
  learnings?: string;
  strict?: boolean;
};

export type ProjectLearningsWriteStatus = "written" | "blocked" | "dry-run";

export type ProjectLearningsEntryInput = {
  id: string;
  summary: string;
  source?: string;
};

export type ProjectLearningsWriteOptions = {
  dryRun?: boolean;
  /** Injectable content reader; defaults to reading the learnings file. Used to test concurrent-writer aborts. */
  readFile?: () => string;
};

export type ProjectLearningsWriteResult = {
  schemaVersion: 1;
  command: "project-learnings";
  operation: "append" | "update";
  status: ProjectLearningsWriteStatus;
  written: boolean;
  source: string;
  learnings: string;
  path: string;
  name: string;
  id: string;
  entryCount: number;
  dryRun: boolean;
  findings: ProjectLearningsFinding[];
  output: string;
};

type JsonObject = Record<string, unknown>;

const SAFE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ALLOWED_PREFIXES = [".skill-sys/", ".agents/local/", ".agents/private/", ".private/skill-sys/"];
const SENSITIVE_TEXT_PATTERNS = [/sk-[A-Za-z0-9._-]{6,}/i, /api[_ -]?key/i, /secret/i, /token/i, /password/i];

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}

function addFinding(findings: ProjectLearningsFinding[], finding: ProjectLearningsFinding): void {
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

export function normalizeProjectLearningsArgs(args: ProjectLearningsArgs): ProjectLearningsInput {
  if (!args.source) throw new Error("Missing --source");
  if (!args.learnings) throw new Error("Missing --learnings");
  const source = path.resolve(args.source);
  const learnings = path.resolve(args.learnings);
  assertExistingDirectory(source, "--source");
  assertExistingFile(learnings, "--learnings");
  if (fs.lstatSync(learnings).isSymbolicLink()) throw new Error("--learnings must not be a symlink");
  return { source, learnings, strict: args.strict === true };
}

function parseLearnings(input: ProjectLearningsInput, findings: ProjectLearningsFinding[]): JsonObject | null {
  return readLearningsDoc(input, () => fs.readFileSync(input.learnings, "utf8"), findings).doc;
}

function readLearningsDoc(
  input: ProjectLearningsInput,
  readContent: () => string,
  findings: ProjectLearningsFinding[],
): { raw: string; doc: JsonObject | null } {
  let raw = "";
  try {
    raw = readContent();
  } catch (error) {
    addFinding(findings, { level: "ERROR", code: "PROJECT_LEARNINGS_INVALID_JSON", path: toRelative(input.source, input.learnings), message: error instanceof Error ? error.message : String(error) });
    return { raw, doc: null };
  }
  let doc: JsonObject | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      addFinding(findings, { level: "ERROR", code: "PROJECT_LEARNINGS_INVALID_SHAPE", path: toRelative(input.source, input.learnings), message: "Project learnings must be a JSON object" });
    } else {
      doc = parsed;
    }
  } catch (error) {
    addFinding(findings, { level: "ERROR", code: "PROJECT_LEARNINGS_INVALID_JSON", path: toRelative(input.source, input.learnings), message: error instanceof Error ? error.message : String(error) });
  }
  return { raw, doc };
}

function isSafeLearningsPath(relativePath: string): boolean {
  const normalized = path.posix.normalize(relativePath.split("\\").join("/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("~/") || normalized === "~") return false;
  return ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function containsSensitiveText(value: unknown): boolean {
  if (typeof value === "string") return SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(value));
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveText(entry));
  if (isObject(value)) return Object.values(value).some((entry) => containsSensitiveText(entry));
  return false;
}

function entryFinding(base: ProjectLearningsFinding, id: string): ProjectLearningsFinding {
  return id ? { ...base, entry: id } : base;
}

function validateEntries(doc: JsonObject, configPath: string, findings: ProjectLearningsFinding[]): number {
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
    addFinding(findings, { level: "WARN", code: "PROJECT_LEARNINGS_EMPTY", path: configPath, message: "project learnings should declare at least one entry" });
    return 0;
  }
  const seen = new Set<string>();
  let count = 0;
  for (const entry of doc.entries) {
    if (!isObject(entry)) {
      addFinding(findings, { level: "ERROR", code: "PROJECT_LEARNING_INVALID_SHAPE", path: configPath, message: "entries must be objects" });
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!SAFE_NAME_PATTERN.test(id)) {
      addFinding(findings, entryFinding({ level: "ERROR", code: "PROJECT_LEARNING_ID_INVALID", path: configPath, message: "entry.id must be a safe identifier" }, id));
    } else if (seen.has(id)) {
      addFinding(findings, entryFinding({ level: "ERROR", code: "PROJECT_LEARNING_DUPLICATE_ID", path: configPath, message: `Duplicate learning id: ${id}` }, id));
    }
    seen.add(id);
    if (typeof entry.summary !== "string" || !entry.summary.trim()) {
      addFinding(findings, entryFinding({ level: "ERROR", code: "PROJECT_LEARNING_SUMMARY_INVALID", path: configPath, message: "entry.summary must be a non-empty string" }, id));
    }
    if (containsSensitiveText(entry)) {
      addFinding(findings, entryFinding({ level: "ERROR", code: "PROJECT_LEARNINGS_SENSITIVE_TEXT", path: configPath, message: "project learnings must not contain secret-looking text" }, id));
    }
    count += 1;
  }
  return count;
}

function sortFindings(findings: ProjectLearningsFinding[]): ProjectLearningsFinding[] {
  return [...findings].sort((a, b) =>
    [a.level, a.code, a.entry ?? "", a.path ?? "", a.message].join("\0").localeCompare(
      [b.level, b.code, b.entry ?? "", b.path ?? "", b.message].join("\0"),
    ),
  );
}

function computeProjectLearningsResult(doc: JsonObject | null, input: ProjectLearningsInput, findings: ProjectLearningsFinding[]): ProjectLearningsResult {
  const configPath = toRelative(input.source, input.learnings);

  let learningsName = "";
  let visibility: ProjectLearningsPolicy["visibility"] = "private";
  let packageSurface = false;
  let entryCount = 0;

  if (doc) {
    if (doc.schemaVersion !== 1) addFinding(findings, { level: "ERROR", code: "PROJECT_LEARNINGS_SCHEMA_VERSION_UNSUPPORTED", path: configPath, message: "schemaVersion must be 1" });
    learningsName = typeof doc.name === "string" ? doc.name.trim() : "";
    if (!SAFE_NAME_PATTERN.test(learningsName)) addFinding(findings, { level: "ERROR", code: "PROJECT_LEARNINGS_NAME_INVALID", path: configPath, message: "name must be a safe identifier" });

    if (doc.visibility === "local" || doc.visibility === "private") visibility = doc.visibility;
    else addFinding(findings, { level: "ERROR", code: "PROJECT_LEARNINGS_PUBLIC_FORBIDDEN", path: configPath, message: "project learnings must remain private/local" });

    packageSurface = doc.packageSurface === true;
    if (packageSurface) addFinding(findings, { level: "ERROR", code: "PROJECT_LEARNINGS_PACKAGE_SURFACE_FORBIDDEN", path: configPath, message: "project learnings must not enter package surfaces" });
    if (!isSafeLearningsPath(configPath)) addFinding(findings, { level: "ERROR", code: "PROJECT_LEARNINGS_PATH_UNSAFE", path: configPath, message: "project learnings must live under a local/private project path" });

    entryCount = validateEntries(doc, configPath, findings);
  }

  const sortedFindings = sortFindings(findings);
  const hasError = sortedFindings.some((finding) => finding.level === "ERROR");
  const hasWarning = sortedFindings.some((finding) => finding.level === "WARN");
  const status: ProjectLearningsStatus = hasError || (input.strict && hasWarning) ? "BLOCKED" : hasWarning ? "CONCERNS" : "PASS";

  return {
    schemaVersion: 1,
    command: "project-learnings",
    status,
    source: input.source,
    learnings: input.learnings,
    strict: input.strict,
    learningsName,
    entryCount,
    policy: { visibility, packageSurface, localOnly: visibility === "private" || visibility === "local" },
    findings: sortedFindings,
  };
}

export function runProjectLearningsValidation(input: ProjectLearningsInput): ProjectLearningsResult {
  const findings: ProjectLearningsFinding[] = [];
  const doc = parseLearnings(input, findings);
  return computeProjectLearningsResult(doc, input, findings);
}

export function validateProjectLearningsDocument(doc: JsonObject, input: ProjectLearningsInput): ProjectLearningsResult {
  return computeProjectLearningsResult(doc, input, []);
}

export function renderProjectLearningsResult(result: ProjectLearningsResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status}`,
    `Learnings: ${result.learningsName || "<invalid>"}`,
    `Source: ${result.source}`,
    `Learnings file: ${result.learnings}`,
    `Visibility: ${result.policy.visibility}`,
    `Package surface: ${result.policy.packageSurface}`,
    `Entries: ${result.entryCount}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const finding of result.findings) lines.push(`- [${finding.level} ${finding.code}] ${finding.message}`);
  return lines.join("\n");
}

function serializeProjectLearningsDoc(doc: JsonObject): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function learningIdNotFoundFinding(configPath: string, id: string): ProjectLearningsFinding {
  return { level: "ERROR", code: "PROJECT_LEARNING_ID_NOT_FOUND", path: configPath, message: `Learning id not found: ${id}`, entry: id };
}

const PROJECT_LEARNINGS_SCHEMA_PATH = path.resolve(__dirname, "../../..", "schema", "project-learnings.schema.json");

let cachedProjectLearningsSchema: JsonObject | null | undefined;

function loadProjectLearningsSchema(): JsonObject | null {
  if (cachedProjectLearningsSchema !== undefined) return cachedProjectLearningsSchema;
  try {
    const parsed = JSON.parse(fs.readFileSync(PROJECT_LEARNINGS_SCHEMA_PATH, "utf8")) as unknown;
    cachedProjectLearningsSchema = isObject(parsed) ? parsed : null;
  } catch {
    cachedProjectLearningsSchema = null;
  }
  return cachedProjectLearningsSchema;
}

function validateSchemaValue(schema: JsonObject, value: unknown, path: string, errors: string[]): void {
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.join(", ")}`);
  }

  const schemaType = schema.type;
  if (schemaType === "object") {
    if (!isObject(value)) {
      errors.push(`${path}: expected object`);
      return;
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === "string" && !Object.hasOwn(value, key)) {
        errors.push(`${path}: missing required field "${key}"`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${path}: unexpected field "${key}"`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateSchemaValue(child as JsonObject, value[key], `${path}.${key}`, errors);
    }
    return;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return;
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchemaValue(schema.items as JsonObject, item, `${path}[${index}]`, errors));
    }
    if (schema.uniqueItems === true) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) errors.push(`${path}: duplicate items`);
    }
    return;
  }
  if (schemaType === "string") {
    if (typeof value !== "string") {
      errors.push(`${path}: expected string`);
      return;
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
    return;
  }
  if (schemaType === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
    return;
  }
  if (schemaType === "integer" && !Number.isInteger(value)) {
    errors.push(`${path}: expected integer`);
  }
}

function schemaInvalidFindings(proposed: JsonObject, configPath: string, id: string): ProjectLearningsFinding[] {
  const schema = loadProjectLearningsSchema();
  if (!schema) {
    return [{ level: "ERROR", code: "PROJECT_LEARNINGS_SCHEMA_INVALID", path: configPath, entry: id, message: "could not load authoritative schema project-learnings.schema.json" }];
  }
  const errors: string[] = [];
  validateSchemaValue(schema, proposed, "$", errors);
  if (errors.length === 0) return [];
  return [{
    level: "ERROR",
    code: "PROJECT_LEARNINGS_SCHEMA_INVALID",
    path: configPath,
    entry: id,
    message: `proposed document violates project-learnings.schema.json: ${errors.join("; ")}`,
  }];
}

function lockedFinding(configPath: string): ProjectLearningsFinding {
  return { level: "ERROR", code: "PROJECT_LEARNINGS_LOCKED", path: configPath, message: "learnings file is locked by another writer; retry" };
}

function writeFailedFinding(configPath: string, error: unknown): ProjectLearningsFinding {
  const message = error instanceof Error ? error.message : String(error);
  return { level: "ERROR", code: "PROJECT_LEARNINGS_WRITE_FAILED", path: configPath, message: `failed to write learnings file: ${message}` };
}

function entriesShapeFinding(configPath: string): ProjectLearningsFinding {
  return { level: "ERROR", code: "PROJECT_LEARNINGS_ENTRIES_INVALID", path: configPath, message: "entries must be an array when present" };
}

function sourceInvalidFinding(configPath: string, id: string, message: string): ProjectLearningsFinding {
  return { level: "ERROR", code: "PROJECT_LEARNING_SOURCE_INVALID", path: configPath, entry: id, message };
}

function writeResultBase(
  operation: "append" | "update",
  input: ProjectLearningsInput,
  doc: JsonObject | null,
  entry: ProjectLearningsEntryInput,
  status: ProjectLearningsWriteStatus,
  findings: ProjectLearningsFinding[],
  entryCount: number,
  output: string,
  dryRun: boolean,
): ProjectLearningsWriteResult {
  return {
    schemaVersion: 1,
    command: "project-learnings",
    operation,
    status,
    written: status === "written",
    source: input.source,
    learnings: input.learnings,
    path: toRelative(input.source, input.learnings),
    name: doc && typeof doc.name === "string" ? doc.name.trim() : "",
    id: entry.id,
    entryCount,
    dryRun,
    findings,
    output,
  };
}

type LearningsProposal =
  | { kind: "blocked"; findings: ProjectLearningsFinding[]; entryCount: number }
  | { kind: "proposed"; proposed: JsonObject };

/**
 * Build the proposed next document for append/update, preserving the exact
 * guard findings and ordering of the previous per-operation implementations.
 */
function proposeLearningsChange(
  operation: "append" | "update",
  input: ProjectLearningsInput,
  entry: ProjectLearningsEntryInput,
  doc: JsonObject,
): LearningsProposal {
  const configPath = toRelative(input.source, input.learnings);

  if (operation === "append") {
    if (typeof entry.source !== "string" || !entry.source.trim()) {
      return { kind: "blocked", findings: [sourceInvalidFinding(configPath, entry.id, "entry.source must be a non-empty string")], entryCount: 0 };
    }
    if (doc.entries !== undefined && !Array.isArray(doc.entries)) {
      return { kind: "blocked", findings: [entriesShapeFinding(configPath)], entryCount: 0 };
    }
    const entries = Array.isArray(doc.entries) ? [...doc.entries] : [];
    return { kind: "proposed", proposed: { ...doc, entries: [...entries, { id: entry.id, summary: entry.summary, source: entry.source }] } };
  }

  if (!Array.isArray(doc.entries)) {
    return { kind: "blocked", findings: [learningIdNotFoundFinding(configPath, entry.id)], entryCount: 0 };
  }
  const index = doc.entries.findIndex((candidate) => isObject(candidate) && candidate.id === entry.id);
  if (index === -1) {
    return { kind: "blocked", findings: [learningIdNotFoundFinding(configPath, entry.id)], entryCount: 0 };
  }
  const existing = doc.entries[index]!;
  if (!isObject(existing) || typeof existing.source !== "string" || !existing.source.trim()) {
    return { kind: "blocked", findings: [sourceInvalidFinding(configPath, entry.id, "existing entry must declare a valid source before update")], entryCount: 0 };
  }
  const entries = [...doc.entries];
  entries[index] = { ...existing, summary: entry.summary };
  return { kind: "proposed", proposed: { ...doc, entries } };
}

/**
 * Full read -> propose -> validate/schema-check -> atomic-write pipeline.
 * Callers must already hold the learnings file lock (except for dry-run,
 * which never writes and never locks). The authoritative content read happens
 * here, inside the caller's critical section, so a snapshot taken before the
 * lock was acquired can never be committed over a competing writer's change.
 */
function runLearningsWritePipeline(
  operation: "append" | "update",
  input: ProjectLearningsInput,
  entry: ProjectLearningsEntryInput,
  readContent: () => string,
  dryRun: boolean,
): ProjectLearningsWriteResult {
  const findings: ProjectLearningsFinding[] = [];
  const { doc } = readLearningsDoc(input, readContent, findings);
  if (!doc) {
    return writeResultBase(operation, input, null, entry, "blocked", sortFindings(findings), 0, "", dryRun);
  }

  const configPath = toRelative(input.source, input.learnings);
  const proposal = proposeLearningsChange(operation, input, entry, doc);
  if (proposal.kind === "blocked") {
    return writeResultBase(operation, input, doc, entry, "blocked", proposal.findings, proposal.entryCount, "", dryRun);
  }

  const validation = validateProjectLearningsDocument(proposal.proposed, input);
  if (validation.status === "BLOCKED") {
    return writeResultBase(operation, input, doc, entry, "blocked", validation.findings, validation.entryCount, "", dryRun);
  }

  const schemaFindings = schemaInvalidFindings(proposal.proposed, configPath, entry.id);
  if (schemaFindings.length > 0) {
    return writeResultBase(operation, input, doc, entry, "blocked", schemaFindings, validation.entryCount, "", dryRun);
  }

  const output = serializeProjectLearningsDoc(proposal.proposed);
  if (dryRun) {
    return writeResultBase(operation, input, doc, entry, "dry-run", [], validation.entryCount, output, true);
  }
  try {
    writeFileAtomicSafe(input.learnings, output);
  } catch (error) {
    return writeResultBase(operation, input, doc, entry, "blocked", [writeFailedFinding(configPath, error)], validation.entryCount, "", false);
  }
  return writeResultBase(operation, input, doc, entry, "written", [], validation.entryCount, output, false);
}

function defaultLearningsReader(input: ProjectLearningsInput): () => string {
  return () => fs.readFileSync(input.learnings, "utf8");
}

function lockedWriteResult(
  operation: "append" | "update",
  input: ProjectLearningsInput,
  entry: ProjectLearningsEntryInput,
): ProjectLearningsWriteResult {
  return writeResultBase(
    operation,
    input,
    null,
    entry,
    "blocked",
    [lockedFinding(toRelative(input.source, input.learnings))],
    0,
    "",
    false,
  );
}

export function applyProjectLearningsAppend(
  input: ProjectLearningsInput,
  entry: ProjectLearningsEntryInput,
  options: ProjectLearningsWriteOptions = {},
): ProjectLearningsWriteResult {
  const dryRun = options.dryRun === true;
  const readContent = options.readFile ?? defaultLearningsReader(input);
  // Dry-run is planning-only: it never writes and never takes the lock.
  if (dryRun) {
    return runLearningsWritePipeline("append", input, entry, readContent, true);
  }
  // The entire mutation — including the content read — happens under the
  // canonical `<learnings>.lock` so concurrent writers cannot lose updates.
  const outcome = withFileLock<ProjectLearningsWriteResult>(input.learnings, () =>
    runLearningsWritePipeline("append", input, entry, readContent, false),
  );
  if (outcome.status === "locked") {
    return lockedWriteResult("append", input, entry);
  }
  return outcome.value;
}

export function applyProjectLearningsUpdate(
  input: ProjectLearningsInput,
  entry: ProjectLearningsEntryInput,
  options: ProjectLearningsWriteOptions = {},
): ProjectLearningsWriteResult {
  const dryRun = options.dryRun === true;
  const readContent = options.readFile ?? defaultLearningsReader(input);
  if (dryRun) {
    return runLearningsWritePipeline("update", input, entry, readContent, true);
  }
  const outcome = withFileLock<ProjectLearningsWriteResult>(input.learnings, () =>
    runLearningsWritePipeline("update", input, entry, readContent, false),
  );
  if (outcome.status === "locked") {
    return lockedWriteResult("update", input, entry);
  }
  return outcome.value;
}

export function renderProjectLearningsWriteResult(result: ProjectLearningsWriteResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status.toUpperCase()}`,
    `Operation: ${result.operation}`,
    `Learnings: ${result.name || "<invalid>"}`,
    `Source: ${result.source}`,
    `Learnings file: ${result.learnings}`,
    `Path: ${result.path}`,
    `ID: ${result.id}`,
    `Entries: ${result.entryCount}`,
    `Dry run: ${result.dryRun}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const finding of result.findings) lines.push(`- [${finding.level} ${finding.code}] ${finding.message}`);
  if (result.dryRun) {
    lines.push("", "Output:");
    lines.push(result.output);
  }
  return lines.join("\n");
}
