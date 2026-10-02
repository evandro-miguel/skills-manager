import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export type TeamModeStatus = "PASS" | "CONCERNS" | "BLOCKED";
export type TeamModeFindingLevel = "WARN" | "ERROR";

export type TeamModeFinding = {
  level: TeamModeFindingLevel;
  code: string;
  message: string;
  path?: string;
};

export type TeamModePolicy = {
  lockfile: string;
  installMode: "projection" | "copy";
  sharedConfig: boolean | null;
  adapters: string[];
  allowedProfiles: string[];
};

export type TeamModeResult = {
  schemaVersion: 1;
  command: "team-mode";
  status: TeamModeStatus;
  source: string;
  config: string;
  strict: boolean;
  teamName: string;
  policy: TeamModePolicy;
  findings: TeamModeFinding[];
};

export type TeamModeInput = {
  source: string;
  config: string;
  strict: boolean;
};

export type TeamModeArgs = {
  source?: string;
  config?: string;
  strict?: boolean;
};

export type TeamModeExecutionStatus = "PLANNED" | "APPLIED" | "UNCHANGED" | "BLOCKED";

export type TeamModeExecutionResult = {
  schemaVersion: 1;
  command: "team-mode";
  operation: "local-apply";
  status: TeamModeExecutionStatus;
  applied: boolean;
  source: string;
  config: string;
  outputPath: string;
  inputDigest: string;
  findings: TeamModeFinding[];
};

export type TeamModeExecutionOptions = {
  /** Explicit opt-in; omitting it is a deterministic, non-mutating plan. */
  apply?: boolean;
  /** Test seam that proves failed writes remove only invocation-created paths. */
  failAfterWrite?: boolean;
};

type JsonObject = Record<string, unknown>;

const SUPPORTED_ADAPTERS = new Set(["antigravity", "codex", "gemini-cli", "opencode", "qwen"]);
const SAFE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TEAM_OUTPUT_PREFIX = ".skill-sys/team";
const MAX_LOCKFILE_BYTES = 64 * 1024;
const SENSITIVE_TEXT_PATTERN = /(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/i;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}

function addFinding(findings: TeamModeFinding[], finding: TeamModeFinding): void {
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

export function normalizeTeamModeArgs(args: TeamModeArgs): TeamModeInput {
  if (!args.source) throw new Error("Missing --source");
  if (!args.config) throw new Error("Missing --config");
  const source = path.resolve(args.source);
  const config = path.resolve(args.config);
  assertExistingDirectory(source, "--source");
  assertExistingFile(config, "--config");
  if (fs.lstatSync(config).isSymbolicLink()) throw new Error("--config must not be a symlink");
  return { source, config, strict: args.strict === true };
}

function parseConfig(input: TeamModeInput, findings: TeamModeFinding[]): JsonObject | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(input.config, "utf8")) as unknown;
    if (!isObject(parsed)) {
      addFinding(findings, {
        level: "ERROR",
        code: "TEAM_MODE_CONFIG_INVALID_SHAPE",
        path: toRelative(input.source, input.config),
        message: "Team mode config must be a JSON object",
      });
      return null;
    }
    return parsed;
  } catch (error) {
    addFinding(findings, {
      level: "ERROR",
      code: "TEAM_MODE_CONFIG_INVALID_JSON",
      path: toRelative(input.source, input.config),
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function isSafeRelativeLockfile(lockfile: string): boolean {
  if (!lockfile || path.isAbsolute(lockfile)) return false;
  const normalized = lockfile.split("\\").join("/");
  if (normalized.startsWith("~/") || normalized === "~") return false;
  const resolved = path.posix.normalize(normalized);
  return resolved !== ".." && !resolved.startsWith("../") && !resolved.includes("/../") && !resolved.endsWith("/..");
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) return null;
  return value.map((entry) => String(entry).trim()).sort();
}

function sortFindings(findings: TeamModeFinding[]): TeamModeFinding[] {
  return [...findings].sort((a, b) =>
    [a.level, a.code, a.path ?? "", a.message].join("\0").localeCompare([b.level, b.code, b.path ?? "", b.message].join("\0")),
  );
}

function executionFinding(code: string, message: string, target?: string): TeamModeFinding {
  return target === undefined ? { level: "ERROR", code, message } : { level: "ERROR", code, message, path: target };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function hasSymlinkInExistingPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) return false;
    if (fs.lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function projectRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function teamOutputPath(input: TeamModeInput, teamName: string): string {
  return path.resolve(input.source, TEAM_OUTPUT_PREFIX, teamName, "team-lock.json");
}

export function runTeamModeValidation(input: TeamModeInput): TeamModeResult {
  const findings: TeamModeFinding[] = [];
  const configPath = toRelative(input.source, input.config);
  const doc = parseConfig(input, findings);

  let teamName = "";
  let lockfile = "";
  let installMode: TeamModePolicy["installMode"] = "projection";
  let sharedConfig: boolean | null = null;
  let adapters: string[] = [];
  let allowedProfiles: string[] = [];

  if (doc) {
    if (doc.schemaVersion !== 1) {
      addFinding(findings, { level: "ERROR", code: "TEAM_MODE_SCHEMA_VERSION_UNSUPPORTED", path: configPath, message: "schemaVersion must be 1" });
    }

    teamName = typeof doc.name === "string" ? doc.name.trim() : "";
    if (!SAFE_NAME_PATTERN.test(teamName)) {
      addFinding(findings, { level: "ERROR", code: "TEAM_MODE_NAME_INVALID", path: configPath, message: "name must be a safe non-empty identifier" });
    }

    lockfile = typeof doc.lockfile === "string" ? doc.lockfile.trim() : "";
    if (!isSafeRelativeLockfile(lockfile)) {
      addFinding(findings, { level: "ERROR", code: "TEAM_MODE_LOCKFILE_UNSAFE", path: configPath, message: "lockfile must be a safe project-relative path" });
    }

    if (doc.installMode === "projection" || doc.installMode === undefined) {
      installMode = "projection";
    } else if (doc.installMode === "copy") {
      installMode = "copy";
    } else if (doc.installMode === "symlink") {
      addFinding(findings, { level: "ERROR", code: "TEAM_MODE_SYMLINK_FORBIDDEN", path: configPath, message: "team mode config must not enable symlink installs" });
    } else {
      addFinding(findings, { level: "ERROR", code: "TEAM_MODE_INSTALL_MODE_INVALID", path: configPath, message: "installMode must be projection or copy" });
    }

    if (doc.sharedConfig === true || doc.sharedConfig === false) {
      sharedConfig = doc.sharedConfig;
    } else {
      addFinding(findings, { level: "WARN", code: "TEAM_MODE_SHARED_CONFIG_UNDECLARED", path: configPath, message: "sharedConfig should be explicit true or false" });
    }

    if (doc.skills !== undefined || doc.catalog !== undefined || doc.skillCatalog !== undefined) {
      addFinding(findings, { level: "ERROR", code: "TEAM_MODE_CATALOG_EMBEDDED", path: configPath, message: "team mode stores config and lockfile references, not embedded skill catalogs" });
    }

    const parsedAdapters = stringArray(doc.adapters);
    if (parsedAdapters === null) {
      addFinding(findings, { level: "ERROR", code: "TEAM_MODE_ADAPTERS_INVALID", path: configPath, message: "adapters must be an array of strings" });
    } else {
      adapters = parsedAdapters;
      for (const adapter of adapters) {
        if (!SUPPORTED_ADAPTERS.has(adapter)) {
          addFinding(findings, { level: "ERROR", code: "TEAM_MODE_ADAPTER_UNSUPPORTED", path: configPath, message: `Unsupported adapter: ${adapter}` });
        }
      }
    }

    const parsedProfiles = stringArray(doc.allowedProfiles);
    if (parsedProfiles === null) {
      addFinding(findings, { level: "ERROR", code: "TEAM_MODE_PROFILES_INVALID", path: configPath, message: "allowedProfiles must be an array of strings" });
    } else {
      allowedProfiles = parsedProfiles;
      for (const profile of allowedProfiles) {
        if (!SAFE_NAME_PATTERN.test(profile)) {
          addFinding(findings, { level: "ERROR", code: "TEAM_MODE_PROFILE_INVALID", path: configPath, message: `Unsafe profile: ${profile}` });
        }
      }
    }
  }

  const sortedFindings = sortFindings(findings);
  const hasError = sortedFindings.some((finding) => finding.level === "ERROR");
  const hasWarning = sortedFindings.some((finding) => finding.level === "WARN");
  const status: TeamModeStatus = hasError || (input.strict && hasWarning) ? "BLOCKED" : hasWarning ? "CONCERNS" : "PASS";

  return {
    schemaVersion: 1,
    command: "team-mode",
    status,
    source: input.source,
    config: input.config,
    strict: input.strict,
    teamName,
    policy: {
      lockfile,
      installMode,
      sharedConfig,
      adapters,
      allowedProfiles,
    },
    findings: sortedFindings,
  };
}

/**
 * Materialize one bounded, project-local team lockfile artifact. This is not
 * CLI-wired: callers must explicitly opt in with `apply`, and no provider,
 * network, package-manager, global, or symlink operation is reachable here.
 */
export function applyTeamModeLocal(
  input: TeamModeInput,
  options: TeamModeExecutionOptions = {},
): TeamModeExecutionResult {
  const validation = runTeamModeValidation(input);
  const outputPath = teamOutputPath(input, validation.teamName || "invalid");
  const blocked = (findings: TeamModeFinding[], inputDigest = ""): TeamModeExecutionResult => ({
    schemaVersion: 1,
    command: "team-mode",
    operation: "local-apply",
    status: "BLOCKED",
    applied: false,
    source: input.source,
    config: input.config,
    outputPath,
    inputDigest,
    findings: sortFindings(findings),
  });

  if (validation.status !== "PASS") return blocked(validation.findings);
  if (!isInside(input.source, input.config) || hasSymlinkInExistingPath(input.source, input.config)) {
    return blocked([executionFinding("TEAM_MODE_CONFIG_PATH_UNSAFE", "config must stay inside the project root without symlinks")]);
  }

  const lockfilePath = path.resolve(input.source, validation.policy.lockfile);
  if (!isInside(input.source, lockfilePath) || hasSymlinkInExistingPath(input.source, lockfilePath)) {
    return blocked([executionFinding("TEAM_MODE_LOCKFILE_PATH_UNSAFE", "lockfile must stay inside the project root without symlinks")]);
  }

  let lockfile: Buffer;
  try {
    const stat = fs.statSync(lockfilePath);
    if (!stat.isFile() || stat.size > MAX_LOCKFILE_BYTES) {
      return blocked([executionFinding("TEAM_MODE_LOCKFILE_BOUNDS_INVALID", `lockfile must be a regular file at most ${MAX_LOCKFILE_BYTES} bytes`)]);
    }
    lockfile = fs.readFileSync(lockfilePath);
  } catch {
    return blocked([executionFinding("TEAM_MODE_LOCKFILE_MISSING", "lockfile must be an existing regular project file")]);
  }
  if (SENSITIVE_TEXT_PATTERN.test(lockfile.toString("utf8"))) {
    return blocked([executionFinding("TEAM_MODE_LOCKFILE_SENSITIVE_TEXT", "lockfile contains sensitive-looking text")]);
  }
  const inputDigest = crypto.createHash("sha256").update(lockfile).digest("hex");
  const outputRelative = projectRelative(input.source, outputPath);
  if (!isInside(input.source, outputPath) || !outputRelative.startsWith(`${TEAM_OUTPUT_PREFIX}/`) || hasSymlinkInExistingPath(input.source, outputPath)) {
    return blocked([executionFinding("TEAM_MODE_OUTPUT_PATH_UNSAFE", "output must stay under the project-local team allowlist")], inputDigest);
  }

  const projected = `${JSON.stringify({
    schemaVersion: 1,
    team: validation.teamName,
    installMode: validation.policy.installMode,
    lockfile: {
      path: validation.policy.lockfile,
      sha256: inputDigest,
      bytes: lockfile.length,
    },
  }, null, 2)}\n`;
  const content = validation.policy.installMode === "copy" ? lockfile.toString("utf8") : projected;

  if (!options.apply) {
    return { ...blocked([], inputDigest), status: "PLANNED", findings: [] };
  }

  if (fs.existsSync(outputPath)) {
    if (fs.lstatSync(outputPath).isSymbolicLink() || !fs.statSync(outputPath).isFile()) {
      return blocked([executionFinding("TEAM_MODE_OUTPUT_CONFLICT", "existing output artifact is not a regular file", outputRelative)], inputDigest);
    }
    if (fs.readFileSync(outputPath, "utf8") === content) {
      return { ...blocked([], inputDigest), status: "UNCHANGED", findings: [] };
    }
    return blocked([executionFinding("TEAM_MODE_OUTPUT_CONFLICT", "existing output artifact differs from the requested local projection", outputRelative)], inputDigest);
  }

  const createdDirs: string[] = [];
  let createdOutput = false;
  try {
    let current = input.source;
    for (const segment of outputRelative.split("/").slice(0, -1)) {
      current = path.join(current, segment);
      if (!fs.existsSync(current)) {
        fs.mkdirSync(current);
        createdDirs.push(current);
      }
    }
    fs.writeFileSync(outputPath, content, { encoding: "utf8", flag: "wx" });
    createdOutput = true;
    if (options.failAfterWrite) throw new Error("injected local apply failure");
    return { ...blocked([], inputDigest), status: "APPLIED", applied: true, findings: [] };
  } catch {
    try { if (createdOutput && fs.existsSync(outputPath) && fs.lstatSync(outputPath).isFile()) fs.unlinkSync(outputPath); } catch { /* best-effort rollback of this invocation's artifact */ }
    for (const dir of createdDirs.reverse()) {
      try { fs.rmdirSync(dir); } catch { /* retain non-empty or concurrently-used directories */ }
    }
    return blocked([executionFinding("TEAM_MODE_LOCAL_APPLY_FAILED", "local apply failed; invocation-created artifacts were rolled back")], inputDigest);
  }
}

export function renderTeamModeResult(result: TeamModeResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status}`,
    `Team: ${result.teamName || "<invalid>"}`,
    `Source: ${result.source}`,
    `Config: ${result.config}`,
    `Install mode: ${result.policy.installMode}`,
    `Lockfile: ${result.policy.lockfile || "<invalid>"}`,
    `Shared config: ${result.policy.sharedConfig === null ? "<undeclared>" : String(result.policy.sharedConfig)}`,
    `Adapters: ${result.policy.adapters.length}`,
    `Profiles: ${result.policy.allowedProfiles.length}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const finding of result.findings) lines.push(`- [${finding.level} ${finding.code}] ${finding.message}`);
  return lines.join("\n");
}
