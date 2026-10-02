#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_SKIP_ENTRY_NAMES, fileExists, listFilesRecursive, readJson } from "../../lib/files.ts";

export type PrivacyFindingLevel = "ERROR" | "WARN" | "INFO";

export type PrivacyFindingCode =
  | "PRIVACY_CONTENT"
  | "PRIVACY_PATH"
  | "FORBIDDEN_PATH" | "FILE_SKIPPED_OVERSIZE" | "FILE_SKIPPED_BINARY";

export interface PrivacyFinding {
  level: PrivacyFindingLevel;
  code: PrivacyFindingCode;
  path: string;
  rule: string;
  line?: number;
  matchHash?: string;
  message: string;
}

export interface PrivacyScanOptions {
  rootDir: string;
  includePaths?: string[];
  forbiddenPaths?: string[];
  allowedInForbiddenSourcePaths?: string[];
  baseDir?: string;
  skipNames?: Iterable<string> | Set<string>;
  maxFileBytes?: number;
  allowlistPath?: string;
  policyPath?: string;
  excludePaths?: string[];
  strictAllowlist?: boolean;
  /** Scan content regardless of its filename extension (historical blobs only). */
  forceTextContentScan?: boolean;
}
interface PrivacyRule {
  id: string;
  level: PrivacyFindingLevel;
  pattern: RegExp;
  message: string;
}

interface PrivacyPathRule {
  id: string;
  level: PrivacyFindingLevel;
  pattern: RegExp;
  message: string;
}

interface PrivacyAllowlistEntry {
  path: string;
  rule?: string;
  code?: PrivacyFindingCode;
  line?: number;
  matchHash?: string;
  reason?: string;
  expires?: string;
}

interface PrivacyAllowlistFile {
  allowedFindings?: PrivacyAllowlistEntry[];
  findings?: PrivacyAllowlistEntry[];
}

interface PrivacyPolicyMarkers {
  personNames?: string[];
  localPaths?: string[];
  privateWorkflowTerms?: string[];
  emailHandles?: string[];
  companyTerms?: string[];
}

interface PrivacyPolicyFile {
  markers?: PrivacyPolicyMarkers;
}

interface TextSpan {
  start: number;
  end: number;
}

const ARTIFACT_SURFACE_FORBIDDEN_METADATA_FIELDS = [
  "forbiddenPaths",
  "forbiddenInArtifactPaths",
  "forbiddenInSourcePaths",
  "allowedInForbiddenSourcePaths",
];
const ARTIFACT_SURFACE_PATH_PATTERN = /^artifact-surfaces\/[^/]+\.json$/;
const AGENT_STATE_GITIGNORE_RULES = new Set([
  ["/.", "codex-", "map/"].join(""),
  ["auth", "-state.json"].join(""),
  ["*-", "auth", "-state.json"].join(""),
  ["oauth", "-state.json"].join(""),
]);

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

const TEXT_FILE_EXTENSIONS = new Set([
  "",
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".sh", ".ps1", ".bat",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const pathSeparator = "/";
const homePathPrefix = [pathSeparator, "home", pathSeparator].join("");
const usersPathPrefix = [pathSeparator, "Users", pathSeparator].join("");
const windowsPathSeparator = String.fromCharCode(92);
const windowsUsersPathPrefix = ["C:", windowsPathSeparator, "Users", windowsPathSeparator].join("");
const oneDriveMarker = ["One", "Drive"].join("");
const localPathPattern = new RegExp(
  `(?:${escapeRegExp(homePathPrefix)}[A-Za-z0-9._-]+(?:${escapeRegExp(pathSeparator)}|\\b)|${escapeRegExp(usersPathPrefix)}[A-Za-z0-9._-]+\\b|${escapeRegExp(windowsUsersPathPrefix)}|${escapeRegExp(oneDriveMarker)}\\b)`,
  "i",
);
const privateWorkflowTerms = [
  ["private", "repo"].join(" "),
  ["local", "machine"].join(" "),
  ["my", "workflow"].join(" "),
  ["minha", "rotina"].join(" "),
];
const privateWorkflowPattern = new RegExp(`\\b(?:${privateWorkflowTerms.map(escapeRegExp).join("|")})\\b`, "i");
const agentStateMarkers = [
  [".agents", pathSeparator, "log"].join(""),
  [".agents", pathSeparator, "wb"].join(""),
];
const codexMapMarker = [".codex", "-map"].join("");
const authStateMarker = ["auth", "-state"].join("");
const agentStatePattern = new RegExp(
  `(?:${agentStateMarkers.map(escapeRegExp).join("|")}|${escapeRegExp(codexMapMarker)}\\b|${escapeRegExp(authStateMarker)}\\b)`,
  "i",
);
const companyDataTerms = [
  ["cli", "ente"].join(""),
  ["contra", "to"].join(""),
  ["project", "codename"].join(" "),
  [["client", "secret"].join(" "), "name"].join(" "),
];
const companyDataPattern = new RegExp(`\\b(?:${companyDataTerms.map(escapeRegExp).join("|")})\\b`, "i");
const agentStateDirectory = [".", "agents"].join("");
const agentStatePathSegments = ["log", "wb"];
const codexMapDirectory = [".codex", "-map"].join("");
const pathBoundaryPattern = `(?:^|${escapeRegExp(pathSeparator)})`;
const pathEndPattern = `(?:${escapeRegExp(pathSeparator)}|$)`;
const agentStatePathPattern = new RegExp(
  `${pathBoundaryPattern}${escapeRegExp(agentStateDirectory)}${escapeRegExp(pathSeparator)}(?:${agentStatePathSegments.map(escapeRegExp).join("|")})${pathEndPattern}|${pathBoundaryPattern}${escapeRegExp(codexMapDirectory)}${pathEndPattern}`,
);
const authStateFilenameMarkers = [
  [authStateMarker, ".json"].join(""),
  [["oauth", "-state"].join(""), ".json"].join(""),
  [["2fa", "-state"].join(""), ".json"].join(""),
  [["my", "-auth"].join(""), ".json"].join(""),
];
const authStatePathPattern = new RegExp(`(?:${authStateFilenameMarkers.map(escapeRegExp).join("|")})$`);

const CONTENT_RULES: PrivacyRule[] = [
  {
    id: "LOCAL_PATH",
    level: "ERROR",
    // `~windows` is a public, portable target-path token supported by global-core.
    // Match resolved machine-specific paths here, not that documented syntax.
    pattern: localPathPattern,
    message: "contains a local-machine path marker",
  },
  {
    id: "PRIVATE_WORKFLOW",
    level: "ERROR",
    pattern: privateWorkflowPattern,
    message: "contains a private workflow marker",
  },
  {
    id: "AGENT_STATE",
    level: "ERROR",
    pattern: agentStatePattern,
    message: "contains an agent runtime state marker",
  },
  {
    id: "EMAIL_HANDLE",
    level: "ERROR",
    pattern: /\b[A-Z0-9._%+-]+@(?:gmail\.com|googlemail\.com)\b/i,
    message: "contains a personal email handle marker",
  },
  {
    id: "COMPANY_DATA",
    level: "WARN",
    pattern: companyDataPattern,
    message: "contains a possible company or client data marker",
  },
];

const PATH_RULES: PrivacyPathRule[] = [
  {
    id: "AGENT_STATE_PATH",
    level: "ERROR",
    pattern: agentStatePathPattern,
    message: "is under an agent runtime state path",
  },
  {
    id: "ARCHIVE_STATE_PATH",
    level: "ERROR",
    pattern: /(?:^|\/)\.arq(?:\/|$)/,
    message: "is under an archive/runtime state path",
  },
  {
    id: "AUTH_STATE_PATH",
    level: "ERROR",
    pattern: authStatePathPattern,
    message: "looks like auth or browser session state",
  },
];

function toRelativePath(baseDir: string, filePath: string): string {
  const relativePath = path.relative(baseDir, filePath) || path.basename(filePath);
  return relativePath.split(path.sep).join("/");
}

function normalizeRelativePath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

interface ForbiddenSourceException {
  path: string;
  recursive: boolean;
}

function normalizeContainedRelativePath(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const raw = value.trim().replaceAll("\\", "/");
  if (raw.split("/").includes("..")) {
    throw new Error(`${label} must stay inside the privacy root`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`${label} must stay inside the privacy root`);
  }
  return normalized;
}

function normalizeForbiddenSourceExceptions(
  values: string[] | undefined,
  forbiddenPaths: string[]
): ForbiddenSourceException[] {
  return (values || []).map((value, index) => {
    const label = `allowedInForbiddenSourcePaths[${index}]`;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${label} must be a non-empty relative path`);
    }
    const normalizedValue = value.trim().replaceAll("\\", "/");
    const recursive = normalizedValue.endsWith("/**");
    const wildcardIndex = normalizedValue.indexOf("*");
    if (wildcardIndex >= 0 && !(recursive && wildcardIndex === normalizedValue.length - 2)) {
      throw new Error(`${label} may use a wildcard only as a trailing /** subtree`);
    }
    const rawPath = recursive ? normalizedValue.slice(0, -3) : normalizedValue;
    const exceptionPath = normalizeContainedRelativePath(rawPath, label);
    if (!forbiddenPaths.some((forbiddenPath) => exceptionPath.startsWith(`${forbiddenPath}/`))) {
      throw new Error(`${label} must be below a forbidden source path`);
    }
    return { path: exceptionPath, recursive };
  });
}

function forbiddenPathFinding(relativePath: string): PrivacyFinding {
  return {
    level: "ERROR",
    code: "FORBIDDEN_PATH",
    path: relativePath,
    rule: "FORBIDDEN_PATH",
    message: `${relativePath} exists but is forbidden by the selected privacy surface`,
  };
}

function lstatIfPresent(candidatePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function scanForbiddenSourceRoot(
  rootDir: string,
  forbiddenPath: string,
  exceptions: ForbiddenSourceException[]
): PrivacyFinding[] {
  const absoluteRoot = path.resolve(rootDir, forbiddenPath);
  const rootStat = lstatIfPresent(absoluteRoot);
  if (!rootStat) {
    return [];
  }
  const relevantExceptions = exceptions.filter((exception) => exception.path.startsWith(`${forbiddenPath}/`));
  if (!relevantExceptions.length || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return [forbiddenPathFinding(forbiddenPath)];
  }

  const findings: PrivacyFinding[] = [];
  const visit = (absolutePath: string, relativePath: string): void => {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      findings.push(forbiddenPathFinding(relativePath));
      return;
    }

    const exactException = relevantExceptions.find(
      (exception) => !exception.recursive && exception.path === relativePath
    );
    const recursiveException = relevantExceptions.find(
      (exception) =>
        exception.recursive &&
        (exception.path === relativePath || relativePath.startsWith(`${exception.path}/`))
    );
    const exceptionAncestor = relevantExceptions.some((exception) =>
      exception.path.startsWith(`${relativePath}/`)
    );

    if (exactException) {
      if (!stat.isFile()) {
        findings.push(forbiddenPathFinding(relativePath));
      }
      return;
    }
    if (recursiveException) {
      if (recursiveException.path === relativePath && !stat.isDirectory()) {
        findings.push(forbiddenPathFinding(relativePath));
        return;
      }
      if (!stat.isDirectory() && !stat.isFile()) {
        findings.push(forbiddenPathFinding(relativePath));
        return;
      }
    } else if (!exceptionAncestor || !stat.isDirectory()) {
      findings.push(forbiddenPathFinding(relativePath));
      return;
    }

    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolutePath).sort((a, b) => a.localeCompare(b))) {
        visit(path.join(absolutePath, entry), `${relativePath}/${entry}`);
      }
    }
  };

  for (const entry of fs.readdirSync(absoluteRoot).sort((a, b) => a.localeCompare(b))) {
    visit(path.join(absoluteRoot, entry), `${forbiddenPath}/${entry}`);
  }
  return findings;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

function shouldScanContents(filePath: string): boolean {
  return TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizeRelativePath(glob);
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*\*/g, "::DOUBLE_STAR::").replace(/\*/g, "[^/]*").replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${pattern}$`);
}

function assertStrictAllowlistEntry(entry: PrivacyAllowlistEntry, index: number): void {
  if (!entry.rule) {
    throw new Error(`Privacy allowlist entry ${index}.rule is required in strict mode`);
  }
  if (!entry.code) {
    throw new Error(`Privacy allowlist entry ${index}.code is required in strict mode`);
  }
  if (typeof entry.reason !== "string" || !entry.reason.trim()) {
    throw new Error(`Privacy allowlist entry ${index}.reason is required in strict mode`);
  }
  if (!Number.isInteger(entry.line) || (entry.line || 0) < 1) {
    throw new Error(`Privacy allowlist entry ${index}.line must be a positive integer in strict mode`);
  }
  if (typeof entry.matchHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.matchHash)) {
    throw new Error(`Privacy allowlist entry ${index}.matchHash must be sha256:<64 hex chars> in strict mode`);
  }
  if (typeof entry.expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
    throw new Error(`Privacy allowlist entry ${index}.expires must be YYYY-MM-DD in strict mode`);
  }
  const expiry = Date.parse(`${entry.expires}T23:59:59Z`);
  if (!Number.isFinite(expiry) || expiry < Date.now()) {
    throw new Error(`Privacy allowlist entry ${index}.expires is expired or invalid: ${entry.expires}`);
  }
}

function readAllowlist(allowlistPath?: string, strictAllowlist = false): PrivacyAllowlistEntry[] {
  if (!allowlistPath) {
    return [];
  }
  if (!fileExists(allowlistPath)) {
    throw new Error(`Privacy allowlist not found: ${allowlistPath}`);
  }
  const parsed = readJson<PrivacyAllowlistFile>(allowlistPath);
  const entries = parsed.allowedFindings || parsed.findings || [];
  if (!Array.isArray(entries)) {
    throw new Error(`Privacy allowlist entries must be an array: ${allowlistPath}`);
  }
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Privacy allowlist entry ${index} must be an object`);
    }
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      throw new Error(`Privacy allowlist entry ${index}.path must be a non-empty string`);
    }
    const normalizedEntry: PrivacyAllowlistEntry = {
      path: normalizeRelativePath(entry.path.trim()),
      ...(typeof entry.rule === "string" && entry.rule.trim() ? { rule: entry.rule.trim() } : {}),
      ...(typeof entry.code === "string" && entry.code.trim() ? { code: entry.code.trim() as PrivacyFindingCode } : {}),
      ...(Number.isInteger(entry.line) ? { line: entry.line } : {}),
      ...(typeof entry.matchHash === "string" && entry.matchHash.trim() ? { matchHash: entry.matchHash.trim() } : {}),
      ...(typeof entry.reason === "string" && entry.reason.trim() ? { reason: entry.reason.trim() } : {}),
      ...(typeof entry.expires === "string" && entry.expires.trim() ? { expires: entry.expires.trim() } : {}),
    };
    if (strictAllowlist) {
      assertStrictAllowlistEntry(normalizedEntry, index);
    }
    return normalizedEntry;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMarkers(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Privacy policy ${label} must be an array`);
  }
  const markers = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Privacy policy ${label}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
  return [...new Set(markers)].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function markerPattern(markers: string[], wordBounded: boolean): RegExp | null {
  if (!markers.length) {
    return null;
  }
  const source = markers.map((marker) => escapeRegExp(marker)).join("|");
  return new RegExp(wordBounded ? `\\b(?:${source})\\b` : `(?:${source})`, "i");
}

function markerRule(
  id: string,
  markers: string[],
  message: string,
  options: { wordBounded?: boolean; level?: PrivacyFindingLevel } = {}
): PrivacyRule[] {
  const pattern = markerPattern(markers, options.wordBounded !== false);
  if (!pattern) {
    return [];
  }
  return [{ id, level: options.level || "ERROR", pattern, message }];
}

function readPolicyRules(policyPath?: string): PrivacyRule[] {
  if (!policyPath) {
    return [];
  }
  if (!fileExists(policyPath)) {
    throw new Error(`Privacy policy not found: ${policyPath}`);
  }
  const parsed = readJson<PrivacyPolicyFile>(policyPath);
  const markers = parsed.markers || {};
  return [
    ...markerRule(
      "PERSON_NAME",
      normalizeMarkers(markers.personNames, "markers.personNames"),
      "contains a configured personal name or username marker"
    ),
    ...markerRule(
      "LOCAL_PATH",
      normalizeMarkers(markers.localPaths, "markers.localPaths"),
      "contains a configured local-machine path marker",
      { wordBounded: false }
    ),
    ...markerRule(
      "PRIVATE_WORKFLOW",
      normalizeMarkers(markers.privateWorkflowTerms, "markers.privateWorkflowTerms"),
      "contains a configured private workflow marker"
    ),
    ...markerRule(
      "EMAIL_HANDLE",
      normalizeMarkers(markers.emailHandles, "markers.emailHandles"),
      "contains a configured personal email handle marker",
      { wordBounded: false }
    ),
    ...markerRule(
      "COMPANY_DATA",
      normalizeMarkers(markers.companyTerms, "markers.companyTerms"),
      "contains a configured company or client data marker",
      { level: "WARN" }
    ),
  ];
}

function isAllowed(finding: PrivacyFinding, allowlist: PrivacyAllowlistEntry[]): boolean {
  for (const entry of allowlist) {
    if (entry.rule && entry.rule !== finding.rule) {
      continue;
    }
    if (entry.code && entry.code !== finding.code) {
      continue;
    }
    if (entry.line !== undefined && entry.line !== finding.line) {
      continue;
    }
    if (entry.matchHash && entry.matchHash !== finding.matchHash) {
      continue;
    }
    if (!globToRegExp(entry.path).test(finding.path)) {
      continue;
    }
    return true;
  }
  return false;
}

function lineNumberForMatch(content: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

function contentMatchHash(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function findJsonArrayCloseIndex(content: string, openBracketIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = openBracketIndex; index < content.length; index += 1) {
    const char = content[index]!;
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
      continue;
    }
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function collectJsonStringSpans(content: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = [];
  const stringPattern = /"(?:\\.|[^"\\])*"/g;
  let match: RegExpExecArray | null;
  while ((match = stringPattern.exec(content)) !== null) {
    spans.push({
      start: offset + match.index + 1,
      end: offset + match.index + match[0].length - 1,
    });
  }
  return spans;
}

function collectArtifactSurfaceForbiddenMetadataSpans(relativePath: string, content: string): TextSpan[] {
  if (!ARTIFACT_SURFACE_PATH_PATTERN.test(relativePath)) {
    return [];
  }

  const spans: TextSpan[] = [];
  for (const field of ARTIFACT_SURFACE_FORBIDDEN_METADATA_FIELDS) {
    const fieldPattern = new RegExp(`"${field}"\\s*:\\s*\\[`, "g");
    let match: RegExpExecArray | null;
    while ((match = fieldPattern.exec(content)) !== null) {
      const openBracketIndex = fieldPattern.lastIndex - 1;
      const closeBracketIndex = findJsonArrayCloseIndex(content, openBracketIndex);
      if (closeBracketIndex < 0) {
        continue;
      }
      spans.push(...collectJsonStringSpans(content.slice(openBracketIndex + 1, closeBracketIndex), openBracketIndex + 1));
    }
  }
  return spans;
}

function collectGitignoreAgentStateRuleSpans(relativePath: string, content: string): TextSpan[] {
  if (relativePath !== ".gitignore") return [];

  const spans: TextSpan[] = [];
  let offset = 0;
  for (const line of content.split("\n")) {
    const completeLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (AGENT_STATE_GITIGNORE_RULES.has(completeLine)) {
      spans.push({ start: offset, end: offset + completeLine.length });
    }
    offset += line.length + 1;
  }
  return spans;
}

function indexWithinSpans(index: number, spans: TextSpan[]): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

function firstReportableRuleMatch(
  content: string,
  rule: PrivacyRule,
  agentStateDeclarationSpans: TextSpan[],
): RegExpExecArray | null {
  const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
  const pattern = new RegExp(rule.pattern.source, flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (rule.id !== "AGENT_STATE" || !indexWithinSpans(match.index, agentStateDeclarationSpans)) {
      return match;
    }
    if (!match[0].length) {
      pattern.lastIndex += 1;
    }
  }
  return null;
}

function collectFiles(candidatePath: string, skipNames?: Iterable<string> | Set<string>): string[] {
  if (!fileExists(candidatePath)) {
    return [];
  }
  const stat = fs.lstatSync(candidatePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to scan symlinked privacy path: ${candidatePath}`);
  }
  if (stat.isDirectory()) {
    return listFilesRecursive(candidatePath, {
      skipNames: skipNames || DEFAULT_SKIP_ENTRY_NAMES,
    });
  }
  if (stat.isFile()) {
    return [candidatePath];
  }
  return [];
}

function collectAllowedForbiddenSourceFiles(
  rootDir: string,
  exceptions: ForbiddenSourceException[],
  skipNames?: Iterable<string> | Set<string>
): string[] {
  return exceptions.flatMap((exception) => {
    const candidatePath = path.resolve(rootDir, exception.path);
    const stat = lstatIfPresent(candidatePath);
    if (!stat || stat.isSymbolicLink()) {
      return [];
    }
    if (exception.recursive && stat.isDirectory()) {
      return listFilesRecursive(candidatePath, { skipNames: skipNames || DEFAULT_SKIP_ENTRY_NAMES });
    }
    return stat.isFile() ? [candidatePath] : [];
  });
}

function scanPath(relativePath: string): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  for (const rule of PATH_RULES) {
    if (!rule.pattern.test(relativePath)) {
      continue;
    }
    findings.push({
      level: rule.level,
      code: "PRIVACY_PATH",
      path: relativePath,
      rule: rule.id,
      message: `${relativePath} ${rule.message}`,
    });
  }
  return findings;
}

function scanFileContents(
  filePath: string,
  relativePath: string,
  maxFileBytes: number,
  rules: PrivacyRule[],
  forceTextContentScan: boolean,
): PrivacyFinding[] {
  if (!forceTextContentScan && !shouldScanContents(filePath)) {
    return [];
  }

  const stat = fs.statSync(filePath);
  if (stat.size > maxFileBytes) {
    return [
      {
        level: "WARN",
        code: "FILE_SKIPPED_OVERSIZE",
        path: relativePath,
        rule: "MAX_FILE_BYTES",
        message: `${relativePath} skipped: ${stat.size} bytes exceeds scan cap of ${maxFileBytes} bytes`,
      },
    ];
  }

  const buffer = fs.readFileSync(filePath);
  if (isBinaryBuffer(buffer)) {
    return [
      {
        level: "WARN",
        code: "FILE_SKIPPED_BINARY",
        path: relativePath,
        rule: "BINARY_CONTENT",
        message: `${relativePath} skipped: binary content is not scanned`,
      },
    ];
  }

  const content = buffer.toString("utf8");
  const agentStateDeclarationSpans = [
    ...collectArtifactSurfaceForbiddenMetadataSpans(relativePath, content),
    ...collectGitignoreAgentStateRuleSpans(relativePath, content),
  ];
  const findings: PrivacyFinding[] = [];
  for (const rule of rules) {
    const match = firstReportableRuleMatch(content, rule, agentStateDeclarationSpans);
    if (!match) {
      continue;
    }
    findings.push({
      level: rule.level,
      code: "PRIVACY_CONTENT",
      path: relativePath,
      rule: rule.id,
      line: lineNumberForMatch(content, match.index),
      matchHash: contentMatchHash(match[0]),
      message: `${relativePath} ${rule.message}`,
    });
  }
  return findings;
}

function uniqSorted(files: string[]): string[] {
  return [...new Set(files.map((filePath) => path.resolve(filePath)))].sort((a, b) => a.localeCompare(b));
}

export function scanPrivacy(options: PrivacyScanOptions): PrivacyFinding[] {
  const rootDir = path.resolve(options.rootDir);
  const baseDir = path.resolve(options.baseDir || rootDir);
  const maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  if (!fileExists(rootDir)) {
    throw new Error(`Privacy scan root not found: ${rootDir}`);
  }
  if (fs.lstatSync(rootDir).isSymbolicLink()) {
    throw new Error(`Refusing to scan symlinked privacy root: ${rootDir}`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Privacy scan root is not a directory: ${rootDir}`);
  }

  const includePaths = options.includePaths?.length ? options.includePaths : ["."];
  const allowlist = readAllowlist(options.allowlistPath, options.strictAllowlist === true);
  const contentRules = [...CONTENT_RULES, ...readPolicyRules(options.policyPath)];
  const findings: PrivacyFinding[] = [];
  const forbiddenPaths = (options.forbiddenPaths || []).map((forbiddenPath, index) =>
    normalizeContainedRelativePath(forbiddenPath, `forbiddenPaths[${index}]`)
  );
  const forbiddenSourceExceptions = normalizeForbiddenSourceExceptions(
    options.allowedInForbiddenSourcePaths,
    forbiddenPaths
  );

  for (const forbiddenPath of forbiddenPaths) {
    findings.push(...scanForbiddenSourceRoot(rootDir, forbiddenPath, forbiddenSourceExceptions));
  }

  const excludedFiles = new Set(
    [
      options.allowlistPath,
      options.policyPath,
      ...(options.excludePaths || []),
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => path.resolve(rootDir, value))
  );
  const files = uniqSorted(
    [
      ...includePaths.flatMap((relativePath) =>
        collectFiles(path.resolve(rootDir, normalizeRelativePath(relativePath)), options.skipNames)
      ),
      ...collectAllowedForbiddenSourceFiles(rootDir, forbiddenSourceExceptions, options.skipNames),
    ]
  ).filter((filePath) => !excludedFiles.has(path.resolve(filePath)));

  for (const filePath of files) {
    const relativePath = toRelativePath(baseDir, filePath);
    findings.push(...scanPath(relativePath));
    findings.push(
      ...scanFileContents(
        filePath,
        relativePath,
        maxFileBytes,
        contentRules,
        options.forceTextContentScan === true,
      )
    );
  }

  return findings
    .filter((finding) => !isAllowed(finding, allowlist))
    .sort((a, b) =>
      a.path.localeCompare(b.path) ||
      (a.line || 0) - (b.line || 0) ||
      a.code.localeCompare(b.code) ||
      a.rule.localeCompare(b.rule)
    );
}

export function formatPrivacyFindings(findings: PrivacyFinding[]): string {
  return findings
    .map((finding) => {
      const lineSuffix = finding.line ? `:${finding.line}` : "";
      return `- [${finding.level} ${finding.code}/${finding.rule}] ${finding.path}${lineSuffix} ${finding.message}`;
    })
    .join("\n");
}

export function countBlockingPrivacyFindings(findings: PrivacyFinding[], strict = false): number {
  return findings.filter((finding) => finding.level === "ERROR" || (strict && finding.level === "WARN")).length;
}
