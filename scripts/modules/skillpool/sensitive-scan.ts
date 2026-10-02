#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SKIP_ENTRY_NAMES, fileExists, listFilesRecursive } from "../../lib/files.ts";

type SensitiveFindingCode = "SENSITIVE_FILE" | "SENSITIVE_SECRET" | "FILE_SKIPPED_OVERSIZE" | "FILE_SKIPPED_BINARY";

export interface SensitiveFinding {
  level: "ERROR" | "WARN";
  code: SensitiveFindingCode;
  path: string;
  rule: string;
  line?: number;
  message: string;
}

export interface SensitiveScanOptions {
  rootDir: string;
  includePaths?: string[];
  baseDir?: string;
  skipNames?: Iterable<string> | Set<string>;
  maxFileBytes?: number;
}

interface FileRule {
  id: string;
  match: (fileName: string) => boolean;
}

interface SecretRule {
  id: string;
  pattern: RegExp;
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

const FILE_RULES: FileRule[] = [
  { id: ".env", match: (fileName) => fileName === ".env" },
  { id: ".env.*", match: (fileName) => /^\.env\..+/.test(fileName) },
  { id: "*.pem", match: (fileName) => fileName.toLowerCase().endsWith(".pem") },
  { id: "*.key", match: (fileName) => fileName.toLowerCase().endsWith(".key") },
  { id: "id_rsa", match: (fileName) => fileName === "id_rsa" },
  { id: "id_ed25519", match: (fileName) => fileName === "id_ed25519" },
  { id: "auth-state.json", match: (fileName) => fileName === "auth-state.json" },
  { id: "*-auth-state.json", match: (fileName) => fileName.endsWith("-auth-state.json") },
  { id: "oauth-state.json", match: (fileName) => fileName === "oauth-state.json" },
  { id: "2fa-state.json", match: (fileName) => fileName === "2fa-state.json" },
  { id: "my-auth.json", match: (fileName) => fileName === "my-auth.json" },
  { id: "*.kdbx", match: (fileName) => fileName.toLowerCase().endsWith(".kdbx") },
  { id: "*.p12", match: (fileName) => fileName.toLowerCase().endsWith(".p12") },
  { id: "*.pfx", match: (fileName) => fileName.toLowerCase().endsWith(".pfx") },
  { id: "*.sqlite", match: (fileName) => fileName.toLowerCase().endsWith(".sqlite") },
  { id: "*.db", match: (fileName) => fileName.toLowerCase().endsWith(".db") },
];

const SECRET_RULES: SecretRule[] = [
  { id: "ghp_", pattern: /\bghp_[A-Za-z0-9_]{20,}\b/ },
  { id: "github_pat_", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: "AKIA", pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { id: "ASIA", pattern: /\bASIA[A-Z0-9]{16}\b/ },
  { id: "xoxb-", pattern: /\bxoxb-[A-Za-z0-9-]{10,}\b/ },
  { id: "sk-", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: "AIza", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { id: "private-key-header", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
];

function toRelativePath(baseDir: string, filePath: string): string {
  const relativePath = path.relative(baseDir, filePath) || path.basename(filePath);
  return relativePath.split(path.sep).join("/");
}

function normalizeRelativePath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

function collectFiles(candidatePath: string, skipNames?: Iterable<string> | Set<string>): string[] {
  if (!fileExists(candidatePath)) {
    return [];
  }
  const stat = fs.lstatSync(candidatePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to scan symlinked sensitive path: ${candidatePath}`);
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

function fileRuleFor(fileName: string): FileRule | null {
  for (const rule of FILE_RULES) {
    if (rule.match(fileName)) {
      return rule;
    }
  }
  return null;
}

function scanFileContents(filePath: string, relativePath: string, maxFileBytes: number): SensitiveFinding[] {
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
  const findings: SensitiveFinding[] = [];
  for (const rule of SECRET_RULES) {
    const match = rule.pattern.exec(content);
    if (!match) {
      continue;
    }
    findings.push({
      level: "ERROR",
      code: "SENSITIVE_SECRET",
      path: relativePath,
      rule: rule.id,
      line: lineNumberForMatch(content, match.index),
      message: `${relativePath} matches secret pattern '${rule.id}'`,
    });
  }
  return findings;
}

export function scanSensitiveFiles(options: SensitiveScanOptions): SensitiveFinding[] {
  const rootDir = path.resolve(options.rootDir);
  const baseDir = path.resolve(options.baseDir || rootDir);
  const maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  if (!fileExists(rootDir)) {
    throw new Error(`Sensitive scan root not found: ${rootDir}`);
  }
  if (fs.lstatSync(rootDir).isSymbolicLink()) {
    throw new Error(`Refusing to scan symlinked root: ${rootDir}`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Sensitive scan root is not a directory: ${rootDir}`);
  }

  const findings: SensitiveFinding[] = [];
  const includePaths = options.includePaths?.length ? options.includePaths : ["."];
  const files = [
    ...new Set(
      includePaths.flatMap((relativePath) =>
        collectFiles(path.resolve(rootDir, normalizeRelativePath(relativePath)), options.skipNames)
      )
    ),
  ].sort((a, b) => a.localeCompare(b));

  for (const filePath of files) {
    const relativePath = toRelativePath(baseDir, filePath);
    const fileRule = fileRuleFor(path.basename(filePath));
    if (fileRule) {
      findings.push({
        level: "ERROR",
        code: "SENSITIVE_FILE",
        path: relativePath,
        rule: fileRule.id,
        message: `${relativePath} matches sensitive file rule '${fileRule.id}'`,
      });
    }
    findings.push(...scanFileContents(filePath, relativePath, maxFileBytes));
  }

  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || a.rule.localeCompare(b.rule));
}

export function formatSensitiveFindings(findings: SensitiveFinding[]): string {
  return findings
    .map((finding) => {
      const lineSuffix = finding.line ? `:${finding.line}` : "";
      return `- [${finding.level} ${finding.code}] ${finding.path}${lineSuffix} ${finding.message}`;
    })
    .join("\n");
}

export function assertNoSensitiveFindings(findings: SensitiveFinding[], label: string): void {
  if (!findings.length) {
    return;
  }
  throw new Error(`${label} failed sensitive scan:\n${formatSensitiveFindings(findings)}`);
}
