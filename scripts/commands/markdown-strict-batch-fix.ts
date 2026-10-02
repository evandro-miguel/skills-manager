#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

function help(): void {
  console.log(`
Normalize Markdown files for strict linting

Usage:
  bun scripts/commands/markdown-strict-batch-fix.ts [files...]

Options:
  --help, -h   Show help
`);
}

function listMarkdownFiles(cwd: string = process.cwd()): string[] {
  const root = path.resolve(cwd, "skills");
  const files: string[] = [];

  function walk(currentDir: string): void {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && absolutePath.endsWith(".md")) {
        files.push(path.relative(cwd, absolutePath));
      }
    }
  }

  walk(root);
  return files.sort();
}

function splitTableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith("|")) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed.split("|").map((cell) => cell.trim());
}

function isDelimiterCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell);
}

function isDelimiterRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return false;
  }
  const cells = splitTableCells(trimmed);
  return cells.length > 0 && cells.every(isDelimiterCell);
}

function normalizeDelimiterCell(cell: string): string {
  const trimmed = cell.trim();
  const leadingColon = trimmed.startsWith(":");
  const trailingColon = trimmed.endsWith(":");
  const hyphenCount = Math.max(3, (trimmed.match(/-/g) || []).length);
  return `${leadingColon ? ":" : ""}${"-".repeat(hyphenCount)}${trailingColon ? ":" : ""}`;
}

function normalizeTableRow(line: string, isDelimiter: boolean): string {
  const indentMatch = line.match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] : "";
  const cells = splitTableCells(line);
  const rendered = cells.map((cell) => (isDelimiter ? normalizeDelimiterCell(cell) : cell.trim()));
  return `${indent}| ${rendered.join(" | ")} |`;
}

function fixMissingFenceLanguages(lines: string[]): string[] {
  const result: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  for (const line of lines) {
    const match = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (!match) {
      result.push(line);
      continue;
    }

    const [, indent, marker, rest] = match;
    const info = rest!.trim();

    if (!inFence) {
      inFence = true;
      fenceChar = marker![0] || "";
      fenceLen = marker!.length;
      result.push(info ? line : `${indent}${marker}text`);
      continue;
    }

    if (marker![0] === fenceChar && marker!.length >= fenceLen && !info) {
      inFence = false;
      fenceChar = "";
      fenceLen = 0;
    }

    result.push(line);
  }

  return result;
}

function fixCompactTables(lines: string[]): string[] {
  const result: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let inFrontMatter = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    const trimmed = line.trim();

    if (i === 0 && trimmed === "---") {
      inFrontMatter = true;
      result.push(line);
      continue;
    }

    if (inFrontMatter) {
      result.push(line);
      if (trimmed === "---" || trimmed === "...") {
        inFrontMatter = false;
      }
      continue;
    }

    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[2] || "";
      const info = (fenceMatch[3] || "").trim();
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0] || "";
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen && !info) {
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
      }
      result.push(line);
      continue;
    }

    if (
      !inFence &&
      !trimmed.startsWith(">") &&
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      isDelimiterRow(lines[i + 1] || "")
    ) {
      const block = [normalizeTableRow(line, false)];
      block.push(normalizeTableRow(lines[i + 1] || "", true));
      let j = i + 2;
      while (
        j < lines.length &&
        (lines[j] || "").trim() &&
        (lines[j] || "").includes("|") &&
        !(lines[j] || "").trim().startsWith(">") &&
        !(lines[j] || "").match(/^(\s*)(`{3,}|~{3,})/)
      ) {
        block.push(normalizeTableRow(lines[j] || "", false));
        j += 1;
      }
      result.push(...block);
      i = j - 1;
      continue;
    }

    result.push(line);
  }

  return result;
}

function wrapText(text: string, width: number, firstPrefix = "", nextPrefix = ""): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [firstPrefix.trimEnd()];
  }

  const result: string[] = [];
  let current = firstPrefix;

  for (const word of words) {
    const separator = current.trim().length && !current.endsWith(" ") ? " " : "";
    if ((current + separator + word).length <= width) {
      current += `${separator}${word}`;
      continue;
    }

    result.push(current.trimEnd());
    current = `${nextPrefix}${word}`;
  }

  result.push(current.trimEnd());
  return result;
}

function isParagraphLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (
    trimmed.startsWith("#") ||
    trimmed === "---" ||
    trimmed === "***" ||
    trimmed === "___" ||
    trimmed.startsWith(">") ||
    trimmed.startsWith("|") ||
    trimmed.startsWith("```") ||
    trimmed.startsWith("~~~") ||
    trimmed.startsWith("<!--") ||
    trimmed.startsWith("<") ||
    /^[-*_]{3,}$/.test(trimmed)
  ) {
    return false;
  }
  if (/^\*\*[^*]+:\*\*/.test(trimmed)) {
    return false;
  }
  if (/^\s{4,}/.test(line)) {
    return false;
  }
  if (/^\s*([-+*])\s+/.test(line)) {
    return false;
  }
  if (/^\s*\d+\.\s+/.test(line)) {
    return false;
  }
  return true;
}

function isListLine(line: string): boolean {
  return /^\s*([-+*]|\d+\.)\s+/.test(line);
}

function wrapParagraphBlocks(lines: string[], width = 80): string[] {
  const result: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let inFrontMatter = false;

  function flushParagraph(buffer: string[]): void {
    if (!buffer.length) {
      return;
    }
    const indentMatch = buffer[0]?.match(/^\s*/);
    const indent = indentMatch ? indentMatch[0] : "";
    const text = buffer.map((line) => line.trim()).join(" ");
    result.push(...wrapText(text, width, indent, indent));
    buffer.length = 0;
  }

  function flushList(buffer: string[], indent: string, marker: string, bodyIndent: string): void {
    if (!buffer.length) {
      return;
    }
    const text = buffer.join(" ");
    result.push(...wrapText(text, width, `${indent}${marker}`, `${indent}${bodyIndent}`));
    buffer.length = 0;
  }

  const paragraphBuffer: string[] = [];
  const listBuffer: string[] = [];
  let listIndent = "";
  let listMarker = "";
  let listBodyIndent = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    const trimmed = line.trim();

    if (i === 0 && trimmed === "---") {
      inFrontMatter = true;
      result.push(line);
      continue;
    }

    if (inFrontMatter) {
      result.push(line);
      if (trimmed === "---" || trimmed === "...") {
        inFrontMatter = false;
      }
      continue;
    }

    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      flushParagraph(paragraphBuffer);
      flushList(listBuffer, listIndent, listMarker, listBodyIndent);
      const marker = fenceMatch[2] || "";
      const info = (fenceMatch[3] || "").trim();
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0] || "";
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen && !info) {
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
      }
      result.push(line);
      continue;
    }

    if (inFence || trimmed.includes("|")) {
      flushParagraph(paragraphBuffer);
      flushList(listBuffer, listIndent, listMarker, listBodyIndent);
      result.push(line);
      continue;
    }

    if (isListLine(line)) {
      flushParagraph(paragraphBuffer);
      const match = line.match(/^(\s*)([-+*]|\d+\.)\s+(.*)$/);
      if (!match) {
        result.push(line);
        continue;
      }
      const [, indent, marker, text] = match;
      const bodyIndent = " ".repeat(`${marker} `.length);
      const signature = `${indent}${marker}`;
      if (listBuffer.length && signature !== `${listIndent}${listMarker}`) {
        flushList(listBuffer, listIndent, listMarker, listBodyIndent);
      }
      listIndent = indent!;
      listMarker = marker!;
      listBodyIndent = bodyIndent;
      listBuffer.push(text!.trim());
      continue;
    }

    if (listBuffer.length) {
      if (trimmed && !line.match(/^\s{4,}/) && !line.match(/^\s*#/)) {
        listBuffer.push(trimmed);
        continue;
      }
      flushList(listBuffer, listIndent, listMarker, listBodyIndent);
    }

    if (isParagraphLine(line)) {
      paragraphBuffer.push(line);
      continue;
    }

    flushParagraph(paragraphBuffer);
    result.push(line);
  }

  flushParagraph(paragraphBuffer);
  flushList(listBuffer, listIndent, listMarker, listBodyIndent);
  return result;
}

function fixEmphasisOnlyLines(lines: string[]): string[] {
  return lines.map((line) => {
    const trimmed = line.trim();
    if (/^\*\*[^*].*[^*]\*\*$/.test(trimmed)) {
      const inner = trimmed.slice(2, -2).trim();
      if (inner && !inner.includes("**")) {
        const indentMatch = line.match(/^\s*/);
        const indent = indentMatch ? indentMatch[0] : "";
        return `${indent}${inner}`;
      }
    }
    if (/^\*[^*].*[^*]\*$/.test(trimmed)) {
      const inner = trimmed.slice(1, -1).trim();
      if (inner && !inner.includes("*")) {
        const indentMatch = line.match(/^\s*/);
        const indent = indentMatch ? indentMatch[0] : "";
        return `${indent}${inner}`;
      }
    }
    return line;
  });
}

function processFile(filePath: string, cwd: string = process.cwd()): boolean {
  const absolutePath = path.resolve(cwd, filePath);
  const original = fs.readFileSync(absolutePath, "utf8");
  const normalized = original.replace(/\r\n/g, "\n");
  const firstPass = fixMissingFenceLanguages(normalized.split("\n"));
  const secondPass = fixCompactTables(firstPass);
  const thirdPass = fixEmphasisOnlyLines(secondPass);
  const fourthPass = wrapParagraphBlocks(thirdPass);
  while (fourthPass.length && fourthPass[fourthPass.length - 1] === "") {
    fourthPass.pop();
  }
  const next = `${fourthPass.join("\n")}\n`;
  if (next !== normalized) {
    fs.writeFileSync(absolutePath, next, "utf8");
    return true;
  }
  return false;
}

function main(argv: string[] = process.argv): void {
  const files: string[] = [];
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      help();
      return;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    files.push(token);
  }

  const targets = files.length ? files : listMarkdownFiles();
  let changed = 0;
  for (const file of targets) {
    if (processFile(file)) {
      changed += 1;
    }
  }

  console.log(`Updated ${changed} Markdown file(s).`);
}

if (require.main === module) {
  main();
}

export {
  fixCompactTables,
  fixEmphasisOnlyLines,
  fixMissingFenceLanguages,
  listMarkdownFiles,
  main,
  processFile,
  wrapParagraphBlocks,
};
