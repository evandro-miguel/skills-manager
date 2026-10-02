#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { readJson } from "../lib/files.ts";
import { resolveSkillSysCommandName } from "../modules/skill-sys/command-registry.ts";

interface DocsCheckArgs {
  roots: string[];
  json: boolean;
  help: boolean;
}

interface DocsFinding {
  level: "ERROR";
  code: string;
  path: string;
  message: string;
}

interface DocsCheckResult {
  files: number;
  findings: DocsFinding[];
}

function help(): void {
  console.log(`
Validate documentation references and command examples

Usage:
  bun scripts/commands/docs-check.ts [roots...] [options]

Options:
  --json     Emit machine-readable output
  --help     Show help
`);
}

function parseArgs(argv: string[] = process.argv): DocsCheckArgs {
  const args: DocsCheckArgs = {
    roots: [],
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    }
    args.roots.push(token);
  }

  if (!args.roots.length) {
    args.roots = ["README.md", "docs"];
  }
  args.roots = args.roots.map((root) => path.resolve(process.cwd(), root));
  return args;
}

function listMarkdownFiles(rootPath: string): string[] {
  if (!fs.existsSync(rootPath)) {
    throw new Error(`Docs root not found: ${rootPath}`);
  }
  const stat = fs.statSync(rootPath);
  if (stat.isFile()) {
    return rootPath.endsWith(".md") ? [rootPath] : [];
  }
  const files: string[] = [];
  const stack = [rootPath];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function relativeToCwd(filePath: string): string {
  return path.relative(process.cwd(), filePath).replaceAll("\\", "/");
}

function normalizeMarkdownLinkTarget(rawTarget: string): string | null {
  const target = rawTarget.trim().replace(/^<|>$/g, "");
  if (!target || target.startsWith("#")) {
    return null;
  }
  if (/^(https?:|mailto:|tel:)/i.test(target)) {
    return null;
  }
  const withoutAnchor = target.split("#")[0]!.trim();
  return withoutAnchor || null;
}

function checkMarkdownLinks(filePath: string, content: string, findings: DocsFinding[]): void {
  const linkPattern = /(?<!!)\[[^\]]+\]\(([^)]+)\)|^\s*\[[^\]]+\]:\s*(\S+)/gm;
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1] || match[2] || "";
    const target = normalizeMarkdownLinkTarget(rawTarget);
    if (!target) {
      continue;
    }
    const resolved = path.resolve(path.dirname(filePath), target);
    if (!fs.existsSync(resolved)) {
      findings.push({
        level: "ERROR",
        code: "DOC_LINK_MISSING",
        path: relativeToCwd(filePath),
        message: `Missing local link target: ${target}`,
      });
    }
  }
}

function extractShellCommands(content: string): string[] {
  const commands: string[] = [];
  const blockPattern = /```(?:bash|sh|shell)\n([\s\S]*?)```/g;
  for (const match of content.matchAll(blockPattern)) {
    const block = match[1] || "";
    let pending = "";
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const next = pending ? `${pending} ${line}` : line;
      if (next.endsWith("\\")) {
        pending = next.slice(0, -1).trim();
        continue;
      }
      commands.push(next);
      pending = "";
    }
    if (pending) {
      commands.push(pending);
    }
  }
  return commands;
}

function packageScripts(): Set<string> {
  const packagePath = path.resolve(process.cwd(), "package.json");
  if (!fs.existsSync(packagePath)) {
    return new Set();
  }
  const parsed = readJson(packagePath) as { scripts?: Record<string, unknown> };
  return new Set(Object.keys(parsed.scripts || {}));
}

function checkCommandExamples(filePath: string, content: string, findings: DocsFinding[]): void {
  const scripts = packageScripts();
  for (const command of extractShellCommands(content)) {
    const scriptMatch = command.match(/\b(?:bun|node|sh|bash)\s+(scripts\/(?:commands|ops|bin)\/[^\s]+)/);
    if (scriptMatch) {
      const scriptPath = scriptMatch[1]!;
      if (!fs.existsSync(path.resolve(process.cwd(), scriptPath))) {
        findings.push({
          level: "ERROR",
          code: "DOC_COMMAND_SCRIPT_MISSING",
          path: relativeToCwd(filePath),
          message: `Command references missing script: ${scriptPath}`,
        });
      }
    }

    const runMatch = command.match(/\bbun\s+run\s+([A-Za-z0-9:_-]+)/);
    if (runMatch && !scripts.has(runMatch[1]!)) {
      findings.push({
        level: "ERROR",
        code: "DOC_PACKAGE_SCRIPT_MISSING",
        path: relativeToCwd(filePath),
        message: `Command references missing package script: ${runMatch[1]}`,
      });
    }
  }

  // Command-reference entries start with the dispatcher invocation. Mentions in
  // backlog/status prose are intentionally not current-surface declarations.
  const inlineCommands = content.matchAll(/^`(?:skill-sys|skillpool)\s+([A-Za-z][A-Za-z0-9-]*)\b/gm);
  for (const match of inlineCommands) {
    const command = match[1]!;
    if (resolveSkillSysCommandName(command)) {
      continue;
    }
    findings.push({
      level: "ERROR",
      code: "DOC_SKILL_SYS_COMMAND_UNKNOWN",
      path: relativeToCwd(filePath),
      message: `Command is not in the Skill-Sys registry: ${command}`,
    });
  }
}

function docsCheck(roots: string[]): DocsCheckResult {
  const files = roots.flatMap((root) => listMarkdownFiles(root));
  const findings: DocsFinding[] = [];
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    checkMarkdownLinks(filePath, content, findings);
    checkCommandExamples(filePath, content, findings);
  }
  return {
    files: files.length,
    findings,
  };
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const result = docsCheck(args.roots);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.findings.length) {
    console.log("STATUS: PASS");
    console.log(`Files: ${result.files}`);
    console.log("Findings: 0");
  } else {
    console.log("STATUS: BLOCKING");
    console.log(`Files: ${result.files}`);
    console.log(`Findings: ${result.findings.length}`);
    for (const finding of result.findings) {
      console.log(`- [${finding.code}] ${finding.path}: ${finding.message}`);
    }
  }

  if (result.findings.length) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
}

export {
  docsCheck,
  extractShellCommands,
  help,
  main,
  parseArgs,
};
export type {
  DocsCheckResult,
  DocsFinding,
};
