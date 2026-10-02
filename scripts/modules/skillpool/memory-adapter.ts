import fs from "node:fs";
import path from "node:path";
import { withFileLock, writeFileAtomicSafe } from "../../lib/files.ts";

export type MemoryAdapterStatus = "PASS" | "CONCERNS" | "BLOCKED";
export type MemoryAdapterReadStatus = "read" | "blocked";
export type MemoryAdapterWriteStatus = "written" | "blocked" | "dry-run";
export type MemoryAdapterFindingLevel = "WARN" | "ERROR";
export type MemoryAdapterMode = "read-only" | "read-write";
export type MemoryAdapterType = "jsonl" | "sqlite" | "mcp";

export type MemoryAdapterFinding = {
  level: MemoryAdapterFindingLevel;
  code: string;
  message: string;
  path?: string;
  skill?: string;
};

export type MemoryAdapterDescriptor = {
  type: MemoryAdapterType;
  mode: MemoryAdapterMode;
  path: string;
};

export type MemoryAdapterPolicy = {
  visibility: "private" | "local";
  packageSurface: boolean;
  readOptIn: boolean;
  writeOptIn: boolean;
  allowSensitiveMemory: boolean;
};

export type MemoryAdapterResult = {
  schemaVersion: 1;
  command: "memory-adapter";
  status: MemoryAdapterStatus;
  source: string;
  config: string;
  strict: boolean;
  adapterName: string;
  adapter: MemoryAdapterDescriptor;
  policy: MemoryAdapterPolicy;
  allowedSkillCount: number;
  findings: MemoryAdapterFinding[];
};

export type MemoryAdapterInput = {
  source: string;
  config: string;
  strict: boolean;
};

export type MemoryAdapterArgs = {
  source?: string;
  config?: string;
  strict?: boolean;
};

export type MemoryAdapterRecord = {
  id: string;
  memory: string;
  source: string;
  createdAt: string;
};

export type MemoryAdapterEntryInput = {
  id: string;
  memory: string;
  source: string;
};

export type MemoryAdapterReadOptions = {
  /** Injectable content reader; defaults to reading the JSONL file. Used to test malformed-line handling and failures. */
  readFile?: () => string;
};

export type MemoryAdapterWriteOptions = {
  dryRun?: boolean;
  /** Injectable content reader; defaults to reading the JSONL file. Used to test concurrent-writer aborts. */
  readFile?: () => string;
};

export type MemoryAdapterReadResult = {
  schemaVersion: 1;
  command: "memory-adapter";
  operation: "read";
  status: MemoryAdapterReadStatus;
  source: string;
  config: string;
  path: string;
  name: string;
  entryCount: number;
  entries: MemoryAdapterRecord[];
  findings: MemoryAdapterFinding[];
};

export type MemoryAdapterWriteResult = {
  schemaVersion: 1;
  command: "memory-adapter";
  operation: "write";
  status: MemoryAdapterWriteStatus;
  written: boolean;
  source: string;
  config: string;
  path: string;
  name: string;
  id: string;
  entryCount: number;
  dryRun: boolean;
  findings: MemoryAdapterFinding[];
  output: string;
};

type JsonObject = Record<string, unknown>;

const SAFE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ALLOWED_PREFIXES = [".skill-sys/", ".agents/local/", ".agents/private/", ".private/skill-sys/"];
const SENSITIVE_TEXT_PATTERNS = [/sk-[A-Za-z0-9._-]{6,}/i, /api[_ -]?key/i, /secret/i, /token/i, /password/i];
const ADAPTER_TYPES = new Set<MemoryAdapterType>(["jsonl", "sqlite", "mcp"]);
const ADAPTER_MODES = new Set<MemoryAdapterMode>(["read-only", "read-write"]);
const DEFAULT_ADAPTER: MemoryAdapterDescriptor = { type: "jsonl", mode: "read-only", path: "" };

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}

function addFinding(findings: MemoryAdapterFinding[], finding: MemoryAdapterFinding): void {
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

export function normalizeMemoryAdapterArgs(args: MemoryAdapterArgs): MemoryAdapterInput {
  if (!args.source) throw new Error("Missing --source");
  if (!args.config) throw new Error("Missing --config");
  const source = path.resolve(args.source);
  const config = path.resolve(args.config);
  assertExistingDirectory(source, "--source");
  assertExistingFile(config, "--config");
  if (fs.lstatSync(config).isSymbolicLink()) throw new Error("--config must not be a symlink");
  return { source, config, strict: args.strict === true };
}

function parseConfig(input: MemoryAdapterInput, findings: MemoryAdapterFinding[]): JsonObject | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(input.config, "utf8")) as unknown;
    if (!isObject(parsed)) {
      addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_INVALID_SHAPE", path: toRelative(input.source, input.config), message: "memory adapter config must be a JSON object" });
      return null;
    }
    return parsed;
  } catch (error) {
    addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_INVALID_JSON", path: toRelative(input.source, input.config), message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function isSafeLocalPath(relativePath: string): boolean {
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

function normalizeAdapter(value: unknown, configPath: string, findings: MemoryAdapterFinding[]): MemoryAdapterDescriptor {
  if (!isObject(value)) {
    addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_DESCRIPTOR_INVALID", path: configPath, message: "adapter must be an object" });
    return DEFAULT_ADAPTER;
  }
  const type = typeof value.type === "string" && ADAPTER_TYPES.has(value.type as MemoryAdapterType) ? value.type as MemoryAdapterType : "jsonl";
  const mode = typeof value.mode === "string" && ADAPTER_MODES.has(value.mode as MemoryAdapterMode) ? value.mode as MemoryAdapterMode : "read-only";
  const adapterPath = typeof value.path === "string" ? value.path.trim() : "";
  if (typeof value.type !== "string" || !ADAPTER_TYPES.has(value.type as MemoryAdapterType)) {
    addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_TYPE_INVALID", path: configPath, message: "adapter.type must be jsonl, sqlite, or mcp" });
  }
  if (typeof value.mode !== "string" || !ADAPTER_MODES.has(value.mode as MemoryAdapterMode)) {
    addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_MODE_INVALID", path: configPath, message: "adapter.mode must be read-only or read-write" });
  }
  if (!adapterPath) {
    addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_STORAGE_PATH_MISSING", path: configPath, message: "adapter.path must be a non-empty local/private path" });
  } else if (!isSafeLocalPath(adapterPath)) {
    addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_STORAGE_PATH_UNSAFE", path: configPath, message: "adapter.path must stay under a local/private path" });
  }
  return { type, mode, path: adapterPath };
}

function validateAllowedSkills(value: unknown, configPath: string, findings: MemoryAdapterFinding[]): number {
  if (!Array.isArray(value) || value.length === 0) {
    addFinding(findings, { level: "WARN", code: "MEMORY_ADAPTER_NO_ALLOWED_SKILLS", path: configPath, message: "memory adapter should declare at least one allowed skill" });
    return 0;
  }
  let count = 0;
  for (const skill of value) {
    const name = typeof skill === "string" ? skill.trim() : "";
    if (!SAFE_NAME_PATTERN.test(name)) {
      addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_SKILL_INVALID", path: configPath, ...(name ? { skill: name } : {}), message: "allowedSkills entries must be safe skill identifiers" });
      continue;
    }
    count += 1;
  }
  return count;
}

function sortFindings(findings: MemoryAdapterFinding[]): MemoryAdapterFinding[] {
  return [...findings].sort((a, b) =>
    [a.level, a.code, a.skill ?? "", a.path ?? "", a.message].join("\0").localeCompare(
      [b.level, b.code, b.skill ?? "", b.path ?? "", b.message].join("\0"),
    ),
  );
}

export function runMemoryAdapterValidation(input: MemoryAdapterInput): MemoryAdapterResult {
  const findings: MemoryAdapterFinding[] = [];
  const configPath = toRelative(input.source, input.config);
  const doc = parseConfig(input, findings);

  let adapterName = "";
  let visibility: MemoryAdapterPolicy["visibility"] = "private";
  let packageSurface = false;
  let readOptIn = false;
  let writeOptIn = false;
  let allowSensitiveMemory = false;
  let adapter = DEFAULT_ADAPTER;
  let allowedSkillCount = 0;

  if (doc) {
    if (doc.schemaVersion !== 1) addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_SCHEMA_VERSION_UNSUPPORTED", path: configPath, message: "schemaVersion must be 1" });
    adapterName = typeof doc.name === "string" ? doc.name.trim() : "";
    if (!SAFE_NAME_PATTERN.test(adapterName)) addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_NAME_INVALID", path: configPath, message: "name must be a safe identifier" });

    if (doc.visibility === "local" || doc.visibility === "private") visibility = doc.visibility;
    else addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_PUBLIC_FORBIDDEN", path: configPath, message: "memory adapter config must remain private/local" });

    packageSurface = doc.packageSurface === true;
    if (packageSurface) addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_PACKAGE_SURFACE_FORBIDDEN", path: configPath, message: "memory adapter config must not enter package surfaces" });
    if (!isSafeLocalPath(configPath)) addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_CONFIG_PATH_UNSAFE", path: configPath, message: "memory adapter config must live under a local/private project path" });

    adapter = normalizeAdapter(doc.adapter, configPath, findings);
    const trustPolicy = isObject(doc.trustPolicy) ? doc.trustPolicy : {};
    readOptIn = trustPolicy.readOptIn === true;
    writeOptIn = trustPolicy.writeOptIn === true;
    allowSensitiveMemory = trustPolicy.allowSensitiveMemory === true;

    if (!readOptIn) addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_READ_OPT_IN_REQUIRED", path: configPath, message: "memory adapters require explicit read opt-in" });
    if (adapter.mode === "read-write" && !writeOptIn) addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_WRITE_OPT_IN_REQUIRED", path: configPath, message: "read-write memory adapters require explicit write opt-in" });
    if (allowSensitiveMemory) addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_SENSITIVE_MEMORY_FORBIDDEN", path: configPath, message: "sensitive memory is not allowed in the public-engine adapter interface" });
    if (containsSensitiveText(doc)) addFinding(findings, { level: "ERROR", code: "MEMORY_ADAPTER_SENSITIVE_TEXT", path: configPath, message: "memory adapter config must not contain secret-looking text" });

    allowedSkillCount = validateAllowedSkills(doc.allowedSkills, configPath, findings);
  }

  const sortedFindings = sortFindings(findings);
  const hasError = sortedFindings.some((finding) => finding.level === "ERROR");
  const hasWarning = sortedFindings.some((finding) => finding.level === "WARN");
  const status: MemoryAdapterStatus = hasError || (input.strict && hasWarning) ? "BLOCKED" : hasWarning ? "CONCERNS" : "PASS";

  return {
    schemaVersion: 1,
    command: "memory-adapter",
    status,
    source: input.source,
    config: input.config,
    strict: input.strict,
    adapterName,
    adapter,
    policy: { visibility, packageSurface, readOptIn, writeOptIn, allowSensitiveMemory },
    allowedSkillCount,
    findings: sortedFindings,
  };
}

export function renderMemoryAdapterResult(result: MemoryAdapterResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status}`,
    `Adapter: ${result.adapterName || "<invalid>"}`,
    `Source: ${result.source}`,
    `Config file: ${result.config}`,
    `Adapter type: ${result.adapter.type}`,
    `Adapter mode: ${result.adapter.mode}`,
    `Visibility: ${result.policy.visibility}`,
    `Package surface: ${result.policy.packageSurface}`,
    `Allowed skills: ${result.allowedSkillCount}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const finding of result.findings) lines.push(`- [${finding.level} ${finding.code}] ${finding.message}`);
  return lines.join("\n");
}

function adapterRelativePath(source: string, adapterPath: string): string {
  return adapterPath ? toRelative(source, path.resolve(source, adapterPath)) : ".";
}

function readOptInRequiredFinding(configPath: string): MemoryAdapterFinding {
  return { level: "ERROR", code: "MEMORY_ADAPTER_READ_OPT_IN_REQUIRED", path: configPath, message: "memory adapters require explicit read opt-in" };
}

function writeModeRequiredFinding(configPath: string): MemoryAdapterFinding {
  return { level: "ERROR", code: "MEMORY_ADAPTER_WRITE_MODE_REQUIRED", path: configPath, message: "memory adapter writes require read-write mode" };
}

function writeOptInRequiredFinding(configPath: string): MemoryAdapterFinding {
  return { level: "ERROR", code: "MEMORY_ADAPTER_WRITE_OPT_IN_REQUIRED", path: configPath, message: "read-write memory adapters require explicit write opt-in" };
}

function typeUnsupportedFinding(configPath: string, adapterType: string): MemoryAdapterFinding {
  return { level: "ERROR", code: "MEMORY_ADAPTER_TYPE_UNSUPPORTED", path: configPath, message: `memory adapter type '${adapterType}' is not supported for memory adapter I/O` };
}

function idInvalidFinding(configPath: string, id: string): MemoryAdapterFinding {
  return id ? { level: "ERROR", code: "MEMORY_ADAPTER_ID_INVALID", path: configPath, message: "memory record id must be a safe identifier" } : { level: "ERROR", code: "MEMORY_ADAPTER_ID_INVALID", path: configPath, message: "memory record id must be a non-empty safe identifier" };
}

function memoryInvalidFinding(configPath: string): MemoryAdapterFinding {
  return { level: "ERROR", code: "MEMORY_ADAPTER_MEMORY_INVALID", path: configPath, message: "memory record memory must be a non-empty string" };
}

function sourceInvalidFinding(configPath: string): MemoryAdapterFinding {
  return { level: "ERROR", code: "MEMORY_ADAPTER_SOURCE_INVALID", path: configPath, message: "memory record source must be a non-empty string" };
}

function sensitiveTextFinding(configPath: string): MemoryAdapterFinding {
  return { level: "ERROR", code: "MEMORY_ADAPTER_SENSITIVE_TEXT", path: configPath, message: "memory records must not contain secret-looking text" };
}

function unsafeStoragePathFinding(configPath: string): MemoryAdapterFinding {
  return { level: "ERROR", code: "MEMORY_ADAPTER_STORAGE_PATH_UNSAFE", path: configPath, message: "memory adapter storage path must not traverse symlinks" };
}

function sensitiveRecordFinding(configPath: string): MemoryAdapterFinding {
  return { level: "ERROR", code: "MEMORY_ADAPTER_SENSITIVE_RECORD", path: configPath, message: "persisted memory records must not contain secret-looking text" };
}

function readFailedFinding(configPath: string, error: unknown): MemoryAdapterFinding {
  const message = error instanceof Error ? error.message : String(error);
  return { level: "ERROR", code: "MEMORY_ADAPTER_READ_FAILED", path: configPath, message: `failed to read memory adapter file: ${message}` };
}

function malformedLineFinding(configPath: string, lineNumber: number, message: string): MemoryAdapterFinding {
  return { level: "WARN", code: "MEMORY_ADAPTER_MALFORMED_LINE", path: configPath, message: `memory adapter line ${lineNumber} is not valid JSON: ${message}` };
}

function invalidRecordFinding(configPath: string, lineNumber: number): MemoryAdapterFinding {
  return { level: "WARN", code: "MEMORY_ADAPTER_INVALID_RECORD", path: configPath, message: `memory adapter line ${lineNumber} is not a valid memory record` };
}

function writeFailedFinding(configPath: string, error: unknown): MemoryAdapterFinding {
  const message = error instanceof Error ? error.message : String(error);
  return { level: "ERROR", code: "MEMORY_ADAPTER_WRITE_FAILED", path: configPath, message: `failed to write memory adapter file: ${message}` };
}

function parseMemoryRecord(value: unknown): MemoryAdapterRecord | null {
  if (!isObject(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const memory = typeof value.memory === "string" ? value.memory.trim() : "";
  const source = typeof value.source === "string" ? value.source.trim() : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt.trim() : "";
  if (!id || !memory || !source || !createdAt) return null;
  return { id, memory, source, createdAt };
}

function isSafeStoragePath(source: string, filePath: string): boolean {
  const relative = path.relative(source, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;

  let current = source;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function serializeMemoryRecord(record: MemoryAdapterRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function countMemoryRecords(readContent: () => string): number {
  let raw = "";
  try {
    raw = readContent();
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      if (parseMemoryRecord(JSON.parse(trimmed) as unknown)) count += 1;
    } catch {
      // malformed lines do not count as records
    }
  }
  return count;
}

export function applyMemoryAdapterRead(
  input: MemoryAdapterInput,
  options: MemoryAdapterReadOptions = {},
): MemoryAdapterReadResult {
  const validation = runMemoryAdapterValidation(input);
  const configPath = toRelative(input.source, input.config);
  const adapterPath = adapterRelativePath(input.source, validation.adapter.path);

  const blockedResult = (findings: MemoryAdapterFinding[], entries: MemoryAdapterRecord[] = []): MemoryAdapterReadResult => ({
    schemaVersion: 1,
    command: "memory-adapter",
    operation: "read",
    status: "blocked",
    source: input.source,
    config: input.config,
    path: adapterPath,
    name: validation.adapterName,
    entryCount: entries.length,
    entries,
    findings: sortFindings(findings),
  });

  // Validation runs first and its BLOCKED status is authoritative: invalid
  // configs (including missing opt-ins, which validation reports as
  // MEMORY_ADAPTER_READ_OPT_IN_REQUIRED) are surfaced with the validation
  // findings before any adapter I/O is attempted.
  if (validation.status === "BLOCKED") {
    return blockedResult(validation.findings);
  }
  if (!validation.policy.readOptIn) {
    return blockedResult([readOptInRequiredFinding(configPath)]);
  }
  if (validation.adapter.type !== "jsonl") {
    return blockedResult([typeUnsupportedFinding(configPath, validation.adapter.type)]);
  }

  const filePath = path.resolve(input.source, validation.adapter.path);
  if (!isSafeStoragePath(input.source, filePath)) {
    return blockedResult([unsafeStoragePathFinding(configPath)]);
  }
  const readContent = options.readFile ?? (() => fs.readFileSync(filePath, "utf8"));
  let raw = "";
  try {
    raw = readContent();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        schemaVersion: 1,
        command: "memory-adapter",
        operation: "read",
        status: "read",
        source: input.source,
        config: input.config,
        path: adapterPath,
        name: validation.adapterName,
        entryCount: 0,
        entries: [],
        findings: [],
      };
    }
    return blockedResult([readFailedFinding(configPath, error)]);
  }

  const entries: MemoryAdapterRecord[] = [];
  const findings: MemoryAdapterFinding[] = [];
  raw.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      findings.push(malformedLineFinding(configPath, index + 1, error instanceof Error ? error.message : String(error)));
      return;
    }
    const record = parseMemoryRecord(parsed);
    if (!record) {
      findings.push(invalidRecordFinding(configPath, index + 1));
      return;
    }
    if (containsSensitiveText(record)) {
      findings.push(sensitiveRecordFinding(configPath));
      return;
    }
    entries.push(record);
  });

  if (findings.some((finding) => finding.code === "MEMORY_ADAPTER_SENSITIVE_RECORD")) {
    return blockedResult(findings);
  }

  return {
    schemaVersion: 1,
    command: "memory-adapter",
    operation: "read",
    status: "read",
    source: input.source,
    config: input.config,
    path: adapterPath,
    name: validation.adapterName,
    entryCount: entries.length,
    entries,
    findings: sortFindings(findings),
  };
}

export function applyMemoryAdapterWrite(
  input: MemoryAdapterInput,
  entry: MemoryAdapterEntryInput,
  options: MemoryAdapterWriteOptions = {},
): MemoryAdapterWriteResult {
  const dryRun = options.dryRun === true;
  const validation = runMemoryAdapterValidation(input);
  const configPath = toRelative(input.source, input.config);
  const adapterPath = adapterRelativePath(input.source, validation.adapter.path);
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const memory = typeof entry.memory === "string" ? entry.memory.trim() : "";
  const source = typeof entry.source === "string" ? entry.source.trim() : "";

  const blockedResult = (findings: MemoryAdapterFinding[], entryCount = 0, output = ""): MemoryAdapterWriteResult => ({
    schemaVersion: 1,
    command: "memory-adapter",
    operation: "write",
    status: "blocked",
    written: false,
    source: input.source,
    config: input.config,
    path: adapterPath,
    name: validation.adapterName,
    id,
    entryCount,
    dryRun,
    findings: sortFindings(findings),
    output,
  });

  // Validation runs first and its BLOCKED status is authoritative: invalid
  // configs (including missing write opt-in, which validation reports as
  // MEMORY_ADAPTER_WRITE_OPT_IN_REQUIRED) are surfaced with the validation
  // findings before any adapter I/O is attempted.
  if (validation.status === "BLOCKED") {
    return blockedResult(validation.findings);
  }
  if (validation.adapter.mode !== "read-write") {
    return blockedResult([writeModeRequiredFinding(configPath)]);
  }
  if (!validation.policy.writeOptIn) {
    return blockedResult([writeOptInRequiredFinding(configPath)]);
  }
  if (validation.adapter.type !== "jsonl") {
    return blockedResult([typeUnsupportedFinding(configPath, validation.adapter.type)]);
  }

  if (!SAFE_NAME_PATTERN.test(id)) {
    return blockedResult([idInvalidFinding(configPath, id)]);
  }
  if (!memory) {
    return blockedResult([memoryInvalidFinding(configPath)]);
  }
  if (!source) {
    return blockedResult([sourceInvalidFinding(configPath)]);
  }
  if (containsSensitiveText(entry)) {
    return blockedResult([sensitiveTextFinding(configPath)]);
  }

  const record: MemoryAdapterRecord = { id, memory, source, createdAt: new Date().toISOString() };
  const output = serializeMemoryRecord(record);
  const filePath = path.resolve(input.source, validation.adapter.path);
  const readContent = options.readFile ?? (() => fs.readFileSync(filePath, "utf8"));
  const existingCount = countMemoryRecords(readContent);

  if (dryRun) {
    return {
      schemaVersion: 1,
      command: "memory-adapter",
      operation: "write",
      status: "dry-run",
      written: false,
      source: input.source,
      config: input.config,
      path: adapterPath,
      name: validation.adapterName,
      id,
      entryCount: existingCount + 1,
      dryRun: true,
      findings: [],
      output,
    };
  }

  // The advisory lock lives next to the JSONL file, so the storage directory
  // must exist before the lock can be acquired on a first write.
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const writeOutcome = withFileLock<Error | null>(filePath, () => {
    try {
      let current = "";
      try {
        current = fs.readFileSync(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next = current.length > 0 && !current.endsWith("\n") ? `${current}\n${output}` : `${current}${output}`;
      writeFileAtomicSafe(filePath, next);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  });

  const writeFailure = writeOutcome.status === "locked"
    ? new Error("memory adapter file is locked by another writer; retry")
    : writeOutcome.value;
  if (writeFailure !== null) {
    return blockedResult([writeFailedFinding(configPath, writeFailure)], existingCount);
  }

  return {
    schemaVersion: 1,
    command: "memory-adapter",
    operation: "write",
    status: "written",
    written: true,
    source: input.source,
    config: input.config,
    path: adapterPath,
    name: validation.adapterName,
    id,
    entryCount: existingCount + 1,
    dryRun: false,
    findings: [],
    output,
  };
}

export function renderMemoryAdapterReadResult(result: MemoryAdapterReadResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status.toUpperCase()}`,
    `Operation: ${result.operation}`,
    `Adapter: ${result.name || "<invalid>"}`,
    `Source: ${result.source}`,
    `Config file: ${result.config}`,
    `Path: ${result.path}`,
    `Entries: ${result.entryCount}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const finding of result.findings) lines.push(`- [${finding.level} ${finding.code}] ${finding.message}`);
  return lines.join("\n");
}

export function renderMemoryAdapterWriteResult(result: MemoryAdapterWriteResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status.toUpperCase()}`,
    `Operation: ${result.operation}`,
    `Adapter: ${result.name || "<invalid>"}`,
    `Source: ${result.source}`,
    `Config file: ${result.config}`,
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
