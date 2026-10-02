import fs from "node:fs";
import path from "node:path";

import { DEFAULT_SKIP_ENTRY_NAMES, fileExists, listFilesRecursive } from "../../lib/files.ts";
import { readSkillMetaResult } from "./skill-meta.ts";

// ---------------------------------------------------------------------------
// Security scan v2 — static, offline, never executes skill scripts.
//
// This module performs a read-only walk over a skill source root and reports
// security-relevant markers. It deliberately mirrors the shape and discipline
// of the sensitive/privacy scanners: relative paths only, matched values are
// never echoed, symlinked roots are refused, and binary/oversized files are
// reported as FILE_SKIPPED_* findings instead of being scanned silently.
// Nothing here runs, imports, or evaluates skill code.
// ---------------------------------------------------------------------------

export type SecurityFindingLevel = "ERROR" | "WARN";

export type SecurityFindingCode =
  | "NETWORK_MARKER"
  | "CREDENTIAL_MARKER"
  | "HIDDEN_SETUP_SCRIPT"
  | "PROMPT_INJECTION"
  | "METADATA_INCONSISTENCY"
  | "SKILL_META_MISSING"
  | "FILE_SKIPPED_OVERSIZE"
  | "FILE_SKIPPED_BINARY";

export interface SecurityFinding {
  level: SecurityFindingLevel;
  code: SecurityFindingCode;
  path: string;
  rule: string;
  line?: number;
  message: string;
}

export interface SecurityScanOptions {
  rootDir: string;
  baseDir?: string;
  maxFileBytes?: number;
  skipNames?: Iterable<string>;
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

const SECURITY_CODES: readonly SecurityFindingCode[] = [
  "NETWORK_MARKER",
  "CREDENTIAL_MARKER",
  "HIDDEN_SETUP_SCRIPT",
  "PROMPT_INJECTION",
  "METADATA_INCONSISTENCY",
  "SKILL_META_MISSING",
  "FILE_SKIPPED_OVERSIZE",
  "FILE_SKIPPED_BINARY",
];

type ObservedCategory = "network" | "credential" | "shell";

interface ContentRule {
  id: string;
  level: SecurityFindingLevel;
  code: SecurityFindingCode;
  category?: ObservedCategory;
  pattern: RegExp;
  message: string;
}

interface FilenameRule {
  id: string;
  level: SecurityFindingLevel;
  code: SecurityFindingCode;
  category?: ObservedCategory;
  match: (fileName: string) => boolean;
  message: string;
}

interface SkillEntry {
  name: string;
  dir: string;
  metaPath: string;
}

// Findings describe *categories* of risky content; matched text (which may be
// secret-shaped) is never copied into the message.
const CONTENT_RULES: ContentRule[] = [
  // Network / exfiltration markers — advisory unless --strict is set.
  {
    id: "curl-command",
    level: "WARN",
    code: "NETWORK_MARKER",
    category: "network",
    pattern: /\bcurl\b/i,
    message: "network command marker (curl)",
  },
  {
    id: "wget-command",
    level: "WARN",
    code: "NETWORK_MARKER",
    category: "network",
    pattern: /\bwget\b/i,
    message: "network command marker (wget)",
  },
  {
    id: "fetch-call",
    level: "WARN",
    code: "NETWORK_MARKER",
    category: "network",
    pattern: /\bfetch\s*\(/,
    message: "network fetch marker",
  },
  {
    id: "http-url",
    level: "WARN",
    code: "NETWORK_MARKER",
    category: "network",
    pattern: /https?:\/\//i,
    message: "network URL marker",
  },
  // Credential scraping markers — always blocking.
  {
    id: "ssh-path",
    level: "ERROR",
    code: "CREDENTIAL_MARKER",
    category: "credential",
    pattern: /~\/\.ssh\b|\.ssh\/(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|config|known_hosts|authorized_keys)\b/i,
    message: "SSH credential path marker",
  },
  {
    id: "aws-path",
    level: "ERROR",
    code: "CREDENTIAL_MARKER",
    category: "credential",
    pattern: /(?:~\/\.aws|\/\.aws\/)(?:credentials|config)\b/i,
    message: "AWS credential path marker",
  },
  {
    id: "browser-state",
    level: "ERROR",
    code: "CREDENTIAL_MARKER",
    category: "credential",
    pattern: /\b(?:Login Data|Login Data For Account|Local State|Cookies\.sqlite|cookies\.sqlite|places\.sqlite|keychain\.db|key4\.db|logins\.json)\b/i,
    message: "browser credential store marker",
  },
  {
    id: "env-secret",
    level: "ERROR",
    code: "CREDENTIAL_MARKER",
    category: "credential",
    pattern: /process\.env\.\w*(?:SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|API_?KEY|ACCESS_?KEY)\w*/i,
    message: "secret-shaped process.env read marker",
  },
  // Prompt injection markers — always blocking.
  {
    id: "ignore-instructions",
    level: "ERROR",
    code: "PROMPT_INJECTION",
    pattern: /\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above|the)\s+instructions\b/i,
    message: "prompt-injection phrase (ignore instructions)",
  },
  {
    id: "system-prompt",
    level: "ERROR",
    code: "PROMPT_INJECTION",
    pattern: /\b(?:reveal|expose|show|print|repeat)\s+(?:your\s+)?(?:system prompt|developer message)\b/i,
    message: "prompt-injection phrase (system prompt exfiltration)",
  },
  {
    id: "developer-message",
    level: "ERROR",
    code: "PROMPT_INJECTION",
    pattern: /\bdeveloper message\b/i,
    message: "prompt-injection phrase (developer message)",
  },
];

const FILENAME_RULES: FilenameRule[] = [
  // Hidden / supply-chain setup scripts — always blocking.
  {
    id: "postinstall",
    level: "ERROR",
    code: "HIDDEN_SETUP_SCRIPT",
    category: "shell",
    match: (fileName) => fileName.toLowerCase() === "postinstall" || /^postinstall\./i.test(fileName),
    message: "postinstall setup script",
  },
  {
    id: "preinstall",
    level: "ERROR",
    code: "HIDDEN_SETUP_SCRIPT",
    category: "shell",
    match: (fileName) => /^preinstall\./i.test(fileName),
    message: "preinstall setup script",
  },
  {
    id: "setup-script",
    level: "ERROR",
    code: "HIDDEN_SETUP_SCRIPT",
    category: "shell",
    match: (fileName) => /^setup\.(sh|js|ts|py|bash|zsh|fish|ps1)$/i.test(fileName),
    message: "setup script",
  },
  // Shell scripts under skill dirs — advisory unless --strict is set.
  {
    id: "shell-script",
    level: "WARN",
    code: "HIDDEN_SETUP_SCRIPT",
    category: "shell",
    match: (fileName) => /\.(sh|bash|zsh|fish)$/i.test(fileName),
    message: "shell script under skill directory",
  },
];

function toRelativePath(baseDir: string, filePath: string): string {
  const relativePath = path.relative(baseDir, filePath) || path.basename(filePath);
  return relativePath.split(path.sep).join("/");
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
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

function collectSkillEntries(rootDir: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  if (fileExists(path.join(rootDir, "SKILL.md"))) {
    const name = path.basename(rootDir) || ".";
    entries.push({ name, dir: rootDir, metaPath: path.join(rootDir, "skill.meta.json") });
    return entries;
  }
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return entries;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read skills root '${rootDir}': ${message}`);
  }
  for (const child of children) {
    if (!child.isDirectory()) {
      continue;
    }
    const childPath = path.join(rootDir, child.name);
    if (fs.lstatSync(childPath).isSymbolicLink()) {
      continue;
    }
    if (fileExists(path.join(childPath, "SKILL.md"))) {
      entries.push({ name: child.name, dir: childPath, metaPath: path.join(childPath, "skill.meta.json") });
    }
  }
  return entries;
}

function findOwningSkill(filePath: string, entries: SkillEntry[]): SkillEntry | null {
  let best: SkillEntry | null = null;
  let bestLen = -1;
  for (const entry of entries) {
    if (filePath.startsWith(entry.dir + path.sep) && entry.dir.length > bestLen) {
      best = entry;
      bestLen = entry.dir.length;
    }
  }
  return best;
}

function sortFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return findings.slice().sort((a, b) => {
    if (a.path !== b.path) {
      return a.path < b.path ? -1 : 1;
    }
    if ((a.line ?? 0) !== (b.line ?? 0)) {
      return (a.line ?? 0) - (b.line ?? 0);
    }
    if (a.code !== b.code) {
      return a.code < b.code ? -1 : 1;
    }
    return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
  });
}

export function scanSecurity(options: SecurityScanOptions): SecurityFinding[] {
  const rootDir = path.resolve(options.rootDir);
  const baseDir = path.resolve(options.baseDir || rootDir);
  const maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;

  if (!fileExists(rootDir)) {
    throw new Error(`Security scan source not found: ${rootDir}`);
  }
  if (fs.lstatSync(rootDir).isSymbolicLink()) {
    throw new Error(`Refusing to scan symlinked security source: ${rootDir}`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Security scan source is not a directory: ${rootDir}`);
  }

  const skillEntries = collectSkillEntries(rootDir);
  const observedBySkill = new Map<string, Set<ObservedCategory>>();
  for (const entry of skillEntries) {
    observedBySkill.set(entry.name, new Set());
  }
  const recordCategory = (entry: SkillEntry | null, category: ObservedCategory): void => {
    if (!entry) {
      return;
    }
    observedBySkill.get(entry.name)?.add(category);
  };

  const findings: SecurityFinding[] = [];
  const files = listFilesRecursive(rootDir, {
    skipNames: options.skipNames || DEFAULT_SKIP_ENTRY_NAMES,
  });

  for (const filePath of files) {
    const relativePath = toRelativePath(baseDir, filePath);
    const owningSkill = findOwningSkill(filePath, skillEntries);
    const fileName = path.basename(filePath);

    for (const rule of FILENAME_RULES) {
      if (rule.match(fileName)) {
        findings.push({
          level: rule.level,
          code: rule.code,
          path: relativePath,
          rule: rule.id,
          message: rule.message,
        });
        if (rule.category) {
          recordCategory(owningSkill, rule.category);
        }
      }
    }

    const stat = fs.statSync(filePath);
    if (stat.size > maxFileBytes) {
      findings.push({
        level: "WARN",
        code: "FILE_SKIPPED_OVERSIZE",
        path: relativePath,
        rule: "MAX_FILE_BYTES",
        message: `${relativePath} skipped: ${stat.size} bytes exceeds scan cap of ${maxFileBytes} bytes`,
      });
      continue;
    }
    const buffer = fs.readFileSync(filePath);
    if (isBinaryBuffer(buffer)) {
      findings.push({
        level: "WARN",
        code: "FILE_SKIPPED_BINARY",
        path: relativePath,
        rule: "BINARY_CONTENT",
        message: `${relativePath} skipped: binary content is not scanned`,
      });
      continue;
    }
    const content = buffer.toString("utf8");
    for (const rule of CONTENT_RULES) {
      const match = rule.pattern.exec(content);
      if (!match) {
        continue;
      }
      findings.push({
        level: rule.level,
        code: rule.code,
        path: relativePath,
        rule: rule.id,
        line: lineNumberForMatch(content, match.index),
        message: rule.message,
      });
      if (rule.category) {
        recordCategory(owningSkill, rule.category);
      }
    }
  }

  // Risk metadata consistency: undeclared risk profiles are reported when the
  // meta file is missing; declared profiles are checked against markers.
  for (const entry of skillEntries) {
    const { meta, source } = readSkillMetaResult(entry.dir, entry.name);
    if (source === "default") {
      findings.push({
        level: "ERROR",
        code: "SKILL_META_MISSING",
        path: toRelativePath(baseDir, entry.dir),
        rule: "META_FILE_REQUIRED",
        message: `${entry.name} is missing skill.meta.json; risk profile is undeclared`,
      });
      continue;
    }
    const observed = observedBySkill.get(entry.name);
    if (!observed) {
      continue;
    }
    const metaRelativePath = toRelativePath(baseDir, entry.metaPath);
    if (!meta.risk.executesShell && observed.has("shell")) {
      findings.push({
        level: "ERROR",
        code: "METADATA_INCONSISTENCY",
        path: metaRelativePath,
        rule: "SHELL_NOT_DECLARED",
        message: `${entry.name} declares executesShell:false but shell/setup scripts are present`,
      });
    }
    if (!meta.risk.networkAccess && observed.has("network")) {
      findings.push({
        level: "ERROR",
        code: "METADATA_INCONSISTENCY",
        path: metaRelativePath,
        rule: "NETWORK_NOT_DECLARED",
        message: `${entry.name} declares networkAccess:false but network markers are present`,
      });
    }
    if (!meta.risk.credentialSensitive && observed.has("credential")) {
      findings.push({
        level: "ERROR",
        code: "METADATA_INCONSISTENCY",
        path: metaRelativePath,
        rule: "CREDENTIAL_NOT_DECLARED",
        message: `${entry.name} declares credentialSensitive:false but credential markers are present`,
      });
    }
  }

  return sortFindings(findings);
}

export function formatSecurityFindings(findings: SecurityFinding[]): string {
  return findings
    .map((finding) => {
      const lineSuffix = finding.line ? `:${finding.line}` : "";
      return `- [${finding.level} ${finding.code}/${finding.rule}] ${finding.path}${lineSuffix} ${finding.message}`;
    })
    .join("\n");
}

export function countBlockingSecurityFindings(findings: SecurityFinding[], strict = false): number {
  return findings.filter((finding) => finding.level === "ERROR" || (strict && finding.level === "WARN")).length;
}

export function validateSecurityFinding(value: unknown): value is SecurityFinding {
  if (!value || typeof value !== "object") {
    return false;
  }
  const finding = value as Record<string, unknown>;
  if (finding.level !== "ERROR" && finding.level !== "WARN") {
    return false;
  }
  if (typeof finding.code !== "string" || !(SECURITY_CODES as readonly string[]).includes(finding.code)) {
    return false;
  }
  if (typeof finding.path !== "string" || finding.path.length === 0) {
    return false;
  }
  if (typeof finding.rule !== "string" || finding.rule.length === 0) {
    return false;
  }
  if (finding.line !== undefined && (typeof finding.line !== "number" || finding.line < 1 || !Number.isInteger(finding.line))) {
    return false;
  }
  if (typeof finding.message !== "string" || finding.message.length === 0) {
    return false;
  }
  return true;
}
