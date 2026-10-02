#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import {
  LEGACY_METADATA_KEYS,
  normalizeProviderId,
  normalizeProviderList,
  normalizeSemverLoose,
  orderedMetadataKeys,
  toUtcIso,
} from "../modules/skill-metadata-lib.ts";

interface CliArgs {
  root: string;
  write: boolean;
  help: boolean;
}

interface ParsedFrontmatter {
  top: Record<string, string>;
  topOrder: string[];
  metadata: Record<string, string>;
  metadataOrder: string[];
  body: string;
}

interface NormalizeResult {
  changed: boolean;
  reason: "no-frontmatter" | "already-normalized" | "updated";
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

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    root: path.resolve(process.cwd(), "skills"),
    write: true,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--root") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --root");
      }
      args.root = path.resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    if (token === "--dry-run") {
      args.write = false;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function listSkillFiles(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "SKILL.md"))
    .filter((filePath) => fs.existsSync(filePath));
}

function stripQuotes(value: unknown): string {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function toCsvFromName(name: string): string {
  return name
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

function quote(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, "'")}"`;
}

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!lines.length || lines[0]!.trim() !== "---") {
    return null;
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return null;
  }

  const fmLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");
  const top: Record<string, string> = {};
  const topOrder: string[] = [];
  const metadata: Record<string, string> = {};
  const metadataOrder: string[] = [];
  let inMetadata = false;

  for (const line of fmLines) {
    const topMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (topMatch) {
      const key = topMatch[1]!;
      const value = stripQuotes(topMatch[2]!);
      if (key === "metadata") {
        inMetadata = true;
      } else {
        inMetadata = false;
        if (!(key in top)) {
          topOrder.push(key);
        }
        top[key] = value;
      }
      continue;
    }

    const metadataMatch = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (inMetadata && metadataMatch) {
      const key = metadataMatch[1]!;
      const value = stripQuotes(metadataMatch[2]!);
      if (!(key in metadata)) {
        metadataOrder.push(key);
      }
      metadata[key] = value;
    }
  }

  return { top, topOrder, metadata, metadataOrder, body };
}

function normalizeOne(filePath: string, options: { write?: boolean } = {}): NormalizeResult {
  const write = options.write !== false;
  const original = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(original);
  if (!parsed) {
    return { changed: false, reason: "no-frontmatter" };
  }

  const top = { ...parsed.top };
  const metadata = { ...parsed.metadata };
  const topOrder = [...parsed.topOrder];
  const metadataOrder = [...parsed.metadataOrder];

  const dirName = path.basename(path.dirname(filePath));
  const name = top.name || dirName;
  top.name = name;
  if (!topOrder.includes("name")) {
    topOrder.unshift("name");
  }

  const defaultDescription = `Use when working with ${name.replace(/-/g, " ")} tasks.`;
  let description = top.description || defaultDescription;
  description = description.replace(/\s+/g, " ").trim();
  if (!/^Use when\b/.test(description) && description) {
    description = `Use when ${description.charAt(0).toLowerCase()}${description.slice(1)}`;
  }
  top.description = description;
  if (!topOrder.includes("description")) {
    const nameIndex = topOrder.indexOf("name");
    topOrder.splice(nameIndex + 1, 0, "description");
  }

  if (!metadata.tags || !metadata.tags.trim()) {
    metadata.tags = `${name}, skill`;
  }
  if (!metadata.triggers || !metadata.triggers.trim()) {
    metadata.triggers = toCsvFromName(name);
  }
  if (!metadataOrder.includes("tags")) {
    metadataOrder.push("tags");
  }
  if (!metadataOrder.includes("triggers")) {
    metadataOrder.push("triggers");
  }

  metadata.version = normalizeSemverLoose(metadata.version) || "1.0.0";
  if (!metadataOrder.includes("version")) {
    metadataOrder.push("version");
  }

  metadata.updated_at = toUtcIso(metadata.updated_at) || toUtcIso(new Date())!;
  if (!metadataOrder.includes("updated_at")) {
    metadataOrder.push("updated_at");
  }

  metadata.target_provider = normalizeProviderId(metadata.target_provider) || "universal";
  if (!metadataOrder.includes("target_provider")) {
    metadataOrder.push("target_provider");
  }

  const compatibleProviders = normalizeProviderList(metadata.compatible_providers, {
    exclude: [metadata.target_provider],
  });
  if (compatibleProviders.length) {
    metadata.compatible_providers = compatibleProviders.join(", ");
    if (!metadataOrder.includes("compatible_providers")) {
      metadataOrder.push("compatible_providers");
    }
  } else {
    delete metadata.compatible_providers;
  }

  for (const key of LEGACY_METADATA_KEYS) {
    delete metadata[key];
  }

  const normalizedMetadataOrder = orderedMetadataKeys(metadataOrder, metadata);

  const out: string[] = [];
  out.push("---");
  for (const key of topOrder) {
    if (key === "metadata") {
      continue;
    }
    if (!(key in top)) {
      continue;
    }
    out.push(`${key}: ${top[key]}`);
  }
  out.push("metadata:");
  for (const key of normalizedMetadataOrder) {
    if (!(key in metadata)) {
      continue;
    }
    const value = metadata[key];
    if (
      key === "tags" ||
      key === "triggers" ||
      key === "references" ||
      key === "compatible_providers" ||
      key === "version" ||
      key === "updated_at"
    ) {
      out.push(`  ${key}: ${quote(value)}`);
    } else {
      out.push(`  ${key}: ${value}`);
    }
  }
  out.push("---");
  out.push(parsed.body.startsWith("\n") ? parsed.body.slice(1) : parsed.body);
  const next = `${out.join("\n")}\n`;

  if (next === original) {
    return { changed: false, reason: "already-normalized" };
  }

  if (write) {
    fs.writeFileSync(filePath, next, "utf8");
  }
  return { changed: true, reason: "updated" };
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  const scriptPath = renderScriptPath(argv, "scripts/commands/normalize-skill-frontmatter.ts");
  if (args.help) {
    console.log(`Usage: bun ${scriptPath} [--root skills] [--dry-run]`);
    return;
  }

  const files = listSkillFiles(args.root);
  let changed = 0;
  let skipped = 0;

  for (const file of files) {
    const result = normalizeOne(file, { write: args.write });
    if (result.changed) {
      changed += 1;
      console.log(`updated: ${path.relative(process.cwd(), file)}`);
    } else {
      skipped += 1;
    }
  }

  console.log(`done: updated=${changed} skipped=${skipped} total=${files.length}`);
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
  listSkillFiles,
  main,
  normalizeOne,
  parseArgs,
  parseFrontmatter,
  quote,
  stripQuotes,
  toCsvFromName,
};
