#!/usr/bin/env bun
/**
 * markdown-link-guard.ts
 *
 * Scans markdown files for:
 * - local links pointing to non-existent paths
 * - ambiguous directory links (should point to explicit README.md/SKILL.md)
 * - raw wiki links [[...]] outside code blocks/inline code
 */

import fs from "node:fs";
import path from "node:path";

const LINK_PATTERN = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const WIKILINK_PATTERN = /(?<!!)\[\[([^\]\n]+)\]\]/g;
const INLINE_CODE_PATTERN = /`[^`]*`/g;
const FENCE_PATTERN = /^\s*(```|~~~)/;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

interface GuardOptions {
  roots: string[];
  includeCodex: boolean;
  checkWikilinks: boolean;
  help: boolean;
}

interface Finding {
  level: string;
  code: string;
  filePath: string;
  line: number;
  col: number;
  message: string;
}

function renderScriptPath(argv: string[], fallback: string): string {
  const raw = argv[1];
  if (!raw) {
    return fallback;
  }
  const normalized = String(raw).replaceAll("\\", "/");
  const marker = "/scripts/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex !== -1) {
    return normalized.slice(markerIndex + 1);
  }
  return path.basename(normalized);
}

function parseArgs(argv: string[]): GuardOptions {
  const args = argv.slice(2);
  const opts: GuardOptions = {
    roots: [],
    includeCodex: false,
    checkWikilinks: true,
    help: false,
  };

  for (const token of args) {
    if (token === "--help" || token === "-h") {
      opts.help = true;
      continue;
    }
    if (token === "--include-codex") {
      opts.includeCodex = true;
      continue;
    }
    if (token === "--no-wikilinks") {
      opts.checkWikilinks = false;
      continue;
    }
    if (token.startsWith("--") || (token.startsWith("-") && token !== "-")) {
      throw new Error(`Unknown argument: ${token}`);
    }
    opts.roots.push(token);
  }

  if (opts.roots.length === 0) {
    opts.roots = ["skills"];
  }

  if (opts.includeCodex) {
    opts.roots.push(path.join(process.env.HOME || "", ".codex/skills"));
  }

  return opts;
}

function printHelp(scriptPath: string): void {
  console.log(`
Markdown Link Guard

Usage:
  bun ${scriptPath} [roots...]

Options:
  --include-codex   Include $HOME/.codex/skills in scan
  --no-wikilinks    Skip [[...]] validation
  --help            Show this help
`);
}

function addFinding(
  findings: Finding[],
  level: string,
  code: string,
  filePath: string,
  line: number,
  col: number,
  message: string
): void {
  findings.push({ level, code, filePath, line, col, message });
}

function shouldSkipTarget(raw: string): boolean {
  return (
    raw.startsWith("#") ||
    raw.startsWith("http://") ||
    raw.startsWith("https://") ||
    raw.startsWith("mailto:") ||
    raw.startsWith("skill://") ||
    raw.startsWith("app://") ||
    raw.startsWith("apps://")
  );
}

function normalizeTarget(raw: string): string {
  const noFragment = raw.split("#", 1)[0]!;
  const noQuery = noFragment.split("?", 1)[0]!;
  return noQuery.trim();
}

function toExplicitRelative(raw: string, filename: string): string {
  const base = raw.endsWith("/") ? raw : `${raw}/`;
  let out = `${base}${filename}`;
  if (!out.startsWith("./") && !out.startsWith("../") && !out.startsWith("/")) {
    out = `./${out}`;
  }
  return out;
}

function collectMarkdownFiles(rootDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(rootDir)) {
    return out;
  }

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && full.endsWith(".md")) {
        out.push(full);
      }
    }
  }

  walk(rootDir);
  return out;
}

function scanMarkdownLinks(
  findings: Finding[],
  filePath: string,
  lineText: string,
  lineNumber: number
): void {
  let match: RegExpExecArray | null;
  while ((match = LINK_PATTERN.exec(lineText)) !== null) {
    const rawTarget = String(match[1] || "").trim();
    if (!rawTarget || shouldSkipTarget(rawTarget)) {
      continue;
    }

    const target = normalizeTarget(rawTarget);
    if (!target) {
      continue;
    }

    const absolute = path.resolve(path.dirname(filePath), target);
    const exists = fs.existsSync(absolute);
    const isDir = exists && fs.statSync(absolute).isDirectory();
    const dirLike = target.endsWith("/") || isDir;
    const col = match.index + 1;

    if (dirLike) {
      if (isDir) {
        const hasSkill = fs.existsSync(path.join(absolute, "SKILL.md"));
        const hasReadme = fs.existsSync(path.join(absolute, "README.md"));
        if (hasSkill || hasReadme) {
          const suggestion = hasSkill
            ? toExplicitRelative(target, "SKILL.md")
            : toExplicitRelative(target, "README.md");
          addFinding(
            findings,
            "ERROR",
            "MD_LINK_AMBIG_DIR",
            filePath,
            lineNumber,
            col,
            `Ambiguous directory link "${rawTarget}". Use explicit "${suggestion}".`
          );
          continue;
        }
      }
      addFinding(
        findings,
        "ERROR",
        "MD_LINK_DIR_TARGET_INVALID",
        filePath,
        lineNumber,
        col,
        `Directory link target does not resolve to a document: "${rawTarget}".`
      );
      continue;
    }

    if (!exists) {
      addFinding(
        findings,
        "ERROR",
        "MD_LINK_MISSING",
        filePath,
        lineNumber,
        col,
        `Link target does not exist: "${rawTarget}".`
      );
    }
  }
}

function isLikelyShellBracketExpr(inner: string): boolean {
  const s = inner.trim();
  if (!s) {
    return false;
  }
  if (s.includes("$")) {
    return true;
  }
  if (/[<>=;{}()]/.test(s)) {
    return true;
  }
  if (/\s-[a-zA-Z]/.test(s)) {
    return true;
  }
  return false;
}

function scanWikiLinks(findings: Finding[], filePath: string, lineText: string, lineNumber: number): void {
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_PATTERN.exec(lineText)) !== null) {
    const inner = String(match[1] || "");
    if (isLikelyShellBracketExpr(inner)) {
      continue;
    }
    const wikilink = match[0];
    const col = match.index + 1;
    addFinding(
      findings,
      "ERROR",
      "MD_WIKILINK_UNSUPPORTED",
      filePath,
      lineNumber,
      col,
      `Raw wikilink detected ${wikilink}. Convert to markdown link or wrap as code.`
    );
  }
}

function scanFile(findings: Finding[], filePath: string, checkWikilinks: boolean): void {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const line = lines[i]!;

    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const sanitized = line.replace(INLINE_CODE_PATTERN, "");
    LINK_PATTERN.lastIndex = 0;
    WIKILINK_PATTERN.lastIndex = 0;
    scanMarkdownLinks(findings, filePath, sanitized, lineNumber);
    if (checkWikilinks) {
      scanWikiLinks(findings, filePath, sanitized, lineNumber);
    }
  }
}

function main(argv: string[] = process.argv): void {
  const scriptPath = renderScriptPath(argv, "scripts/commands/markdown-link-guard.ts");

  let opts: GuardOptions;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nError: ${message}\n`);
    printHelp(scriptPath);
    process.exit(1);
  }

  if (opts.help) {
    printHelp(scriptPath);
    return;
  }

  const roots = opts.roots.map((root) => path.resolve(root));
  const files: string[] = [];
  for (const root of roots) {
    files.push(...collectMarkdownFiles(root));
  }

  if (files.length === 0) {
    console.log("No markdown files found in provided roots.");
    return;
  }

  const findings: Finding[] = [];
  for (const filePath of files) {
    scanFile(findings, filePath, opts.checkWikilinks);
  }

  if (findings.length === 0) {
    console.log(`OK: scanned ${files.length} markdown files, no link issues found.`);
    return;
  }

  for (const finding of findings) {
    console.log(
      `${finding.level} ${finding.code} ${finding.filePath}:${finding.line}:${finding.col} ${finding.message}`
    );
  }
  console.log(`\nFound ${findings.length} markdown link issue(s).`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

export {
  collectMarkdownFiles,
  main,
  parseArgs,
  scanFile,
};
