#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

export const PROVIDER_IDS = [
  "universal",
  "opencode",
  "codex",
  "claude-code",
  "antigravity",
  "qwen",
  "gemini-cli",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const CSV_METADATA_KEYS = new Set<string>([
  "tags",
  "triggers",
  "references",
  "compatible_providers",
]);

export const MANAGED_METADATA_KEYS = [
  "version",
  "updated_at",
  "target_provider",
  "compatible_providers",
] as const;

export const LEGACY_METADATA_KEYS = ["created_on", "last_update"] as const;

export const PREFERRED_METADATA_ORDER = [
  "category",
  "tags",
  "triggers",
  "references",
  "version",
  "updated_at",
  "target_provider",
  "compatible_providers",
] as const;

const QUOTED_METADATA_KEYS = new Set<string>([
  "tags",
  "triggers",
  "references",
  "version",
  "updated_at",
  "compatible_providers",
]);

export const STRICT_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
export const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export type FrontmatterMap = Record<string, string>;

export interface ParsedFrontmatterOk {
  ok: true;
  top: FrontmatterMap;
  topOrder: string[];
  metadata: FrontmatterMap;
  metadataOrder: string[];
  body: string;
  rawFrontmatterLines: string[];
}

export interface ParsedFrontmatterError {
  ok: false;
  error: string;
  rawFrontmatterLines?: string[];
}

export type ParsedFrontmatter = ParsedFrontmatterOk | ParsedFrontmatterError;

export interface NormalizeProviderListOptions {
  allowUniversal?: boolean;
  exclude?: Array<string | null | undefined>;
}

export interface NormalizeManagedMetadataOptions {
  version?: string;
  updatedAt?: string | number | Date;
  defaultProvider?: ProviderId;
  targetProvider?: string | null;
  compatibleProviders?: string | string[];
}

export function stripQuotes(value: unknown): string {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

export function yamlQuote(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, "'")}"`;
}

export function parseCsv(value: unknown): string[] {
  return String(value || "")
    .split(",")
    .map((entry) => stripQuotes(entry))
    .filter(Boolean);
}

export function formatCsv(items: unknown[] = []): string {
  return [...new Set(items.map((entry) => String(entry).trim()).filter(Boolean))].join(", ");
}

export function normalizeProviderId(value: unknown): ProviderId | null {
  const normalized = stripQuotes(value);
  return PROVIDER_IDS.includes(normalized as ProviderId) ? (normalized as ProviderId) : null;
}

export function normalizeProviderList(
  value: unknown,
  options: NormalizeProviderListOptions = {}
): ProviderId[] {
  const allowUniversal = options.allowUniversal === true;
  const excluded = new Set((options.exclude || []).filter(Boolean));
  const items = parseCsv(value)
    .map(normalizeProviderId)
    .filter((provider): provider is ProviderId => Boolean(provider))
    .filter((provider) => (allowUniversal ? true : provider !== "universal"))
    .filter((provider) => !excluded.has(provider));
  return [...new Set(items)];
}

export function normalizeSemverLoose(value: unknown): string | null {
  const clean = stripQuotes(value).replace(/^v/i, "");
  if (!clean) {
    return null;
  }
  if (/^\d+$/.test(clean)) {
    return `${clean}.0.0`;
  }
  if (/^\d+\.\d+$/.test(clean)) {
    return `${clean}.0`;
  }
  if (STRICT_SEMVER_PATTERN.test(clean)) {
    return clean;
  }
  return null;
}

export function isValidSemver(value: unknown): boolean {
  return STRICT_SEMVER_PATTERN.test(stripQuotes(value));
}

export function bumpPatch(version: unknown): string | null {
  const clean = normalizeSemverLoose(version);
  if (!clean) {
    return null;
  }
  const parts = clean.split(".").map((part) => Number(part));
  parts[2]! += 1;
  return parts.join(".");
}

export function toUtcIso(value: string | number | Date | null | undefined): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isValidUtcIso(value: unknown): boolean {
  return UTC_ISO_PATTERN.test(stripQuotes(value));
}

function isQuotedScalar(value: unknown): boolean {
  const trimmed = String(value || "").trim();
  return trimmed.startsWith('"') || trimmed.startsWith("'");
}

export function validateFrontmatterScalarSyntax(rawFrontmatterLines?: string[]): string[] {
  const errors: string[] = [];
  const lines = rawFrontmatterLines || [];
  let inMetadata = false;

  for (const line of lines) {
    const topMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (topMatch) {
      const key = topMatch[1]!;
      const value = topMatch[2]!.trim();
      inMetadata = key === "metadata";
      if (key !== "metadata") {
        const error = validateScalarValue(key, value);
        if (error) {
          errors.push(error);
        }
      }
      continue;
    }

    const nestedMatch = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nestedMatch && inMetadata) {
      const key = nestedMatch[1]!;
      const value = nestedMatch[2]!.trim();
      const error = validateScalarValue(`metadata.${key}`, value);
      if (error) {
        errors.push(error);
      }
    }
  }

  return errors;
}

function validateScalarValue(keyPath: string, value: string): string | null {
  if (!value) {
    return null;
  }

  if (isQuotedScalar(value)) {
    const quote = value[0]!;
    if (!value.endsWith(quote)) {
      return `${keyPath} quoted scalar must close with ${quote}`;
    }
    return null;
  }

  if (value.includes(": ")) {
    return `${keyPath} contains ': ' and must be quoted`;
  }

  return null;
}

export function quoteFrontmatterScalarIfNeeded(value: unknown): string {
  const raw = String(value ?? "");
  const trimmed = raw.trim();
  if (!trimmed || isQuotedScalar(trimmed)) {
    return raw;
  }
  if (trimmed.includes(": ")) {
    return yamlQuote(trimmed);
  }
  return raw;
}

export function parseFrontmatter(content: unknown): ParsedFrontmatter {
  const lines = String(content || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!lines.length || lines[0]!.trim() !== "---") {
    return { ok: false, error: "missing YAML frontmatter" };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }

  if (end === -1) {
    return { ok: false, error: "missing closing frontmatter delimiter" };
  }

  const fmLines = lines.slice(1, end);
  const scalarErrors = validateFrontmatterScalarSyntax(fmLines);
  if (scalarErrors.length) {
    return {
      ok: false,
      error: scalarErrors.join("; "),
      rawFrontmatterLines: fmLines,
    };
  }

  const body = lines.slice(end + 1).join("\n");
  const top: FrontmatterMap = {};
  const topOrder: string[] = [];
  const metadata: FrontmatterMap = {};
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

    const nestedMatch = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nestedMatch && inMetadata) {
      const key = nestedMatch[1]!;
      const value = stripQuotes(nestedMatch[2]!);
      if (!(key in metadata)) {
        metadataOrder.push(key);
      }
      metadata[key] = value;
    }
  }

  return {
    ok: true,
    top,
    topOrder,
    metadata,
    metadataOrder,
    body,
    rawFrontmatterLines: fmLines,
  };
}

export function orderedTopKeys(topOrder: string[] = [], top: FrontmatterMap = {}): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const key of ["name", "description"]) {
    if (key in top && !seen.has(key)) {
      output.push(key);
      seen.add(key);
    }
  }
  for (const key of topOrder) {
    if (key === "metadata" || seen.has(key) || !(key in top)) {
      continue;
    }
    output.push(key);
    seen.add(key);
  }
  for (const key of Object.keys(top)) {
    if (key === "metadata" || seen.has(key)) {
      continue;
    }
    output.push(key);
    seen.add(key);
  }
  return output;
}

export function orderedMetadataKeys(
  metadataOrder: string[] = [],
  metadata: FrontmatterMap = {}
): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const key of PREFERRED_METADATA_ORDER) {
    if (key in metadata && !seen.has(key)) {
      output.push(key);
      seen.add(key);
    }
  }
  for (const key of metadataOrder) {
    if (!(key in metadata) || seen.has(key)) {
      continue;
    }
    output.push(key);
    seen.add(key);
  }
  for (const key of Object.keys(metadata)) {
    if (seen.has(key)) {
      continue;
    }
    output.push(key);
    seen.add(key);
  }
  return output;
}

export function serializeFrontmatter(parsed: Partial<ParsedFrontmatterOk>): string {
  const top = { ...(parsed.top || {}) };
  const metadata = { ...(parsed.metadata || {}) };
  const topKeys = orderedTopKeys(parsed.topOrder || [], top);
  const metadataKeys = orderedMetadataKeys(parsed.metadataOrder || [], metadata);
  const out = ["---"];

  for (const key of topKeys) {
    out.push(`${key}: ${quoteFrontmatterScalarIfNeeded(top[key])}`);
  }

  out.push("metadata:");
  for (const key of metadataKeys) {
    const value = metadata[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (QUOTED_METADATA_KEYS.has(key)) {
      out.push(`  ${key}: ${yamlQuote(value)}`);
    } else {
      out.push(`  ${key}: ${quoteFrontmatterScalarIfNeeded(value)}`);
    }
  }

  out.push("---");
  const header = out.join("\n");
  if (parsed.body) {
    return `${header}\n${parsed.body}`;
  }
  return `${header}\n`;
}

export function cloneParsedFrontmatter(parsed: Partial<ParsedFrontmatterOk>): ParsedFrontmatterOk {
  return {
    ok: true,
    top: { ...(parsed.top || {}) },
    topOrder: [...(parsed.topOrder || [])],
    metadata: { ...(parsed.metadata || {}) },
    metadataOrder: [...(parsed.metadataOrder || [])],
    body: parsed.body || "",
    rawFrontmatterLines: [...(parsed.rawFrontmatterLines || [])],
  };
}

export function stripManagedMetadata(parsed: Partial<ParsedFrontmatterOk>): ParsedFrontmatterOk {
  const next = cloneParsedFrontmatter(parsed);
  for (const key of [...MANAGED_METADATA_KEYS, ...LEGACY_METADATA_KEYS]) {
    delete next.metadata[key];
  }
  next.metadataOrder = next.metadataOrder.filter(
    (key) => !MANAGED_METADATA_KEYS.includes(key as (typeof MANAGED_METADATA_KEYS)[number]) &&
      !LEGACY_METADATA_KEYS.includes(key as (typeof LEGACY_METADATA_KEYS)[number])
  );
  return next;
}

export function normalizeManagedMetadata(
  metadata: FrontmatterMap = {},
  options: NormalizeManagedMetadataOptions = {}
): FrontmatterMap {
  const next: FrontmatterMap = { ...(metadata || {}) };

  if (options.version) {
    next.version = options.version;
  } else if (next.version) {
    next.version = normalizeSemverLoose(next.version) || next.version;
  }

  if (options.updatedAt) {
    next.updated_at = toUtcIso(options.updatedAt) || next.updated_at || "";
  } else if (next.updated_at) {
    next.updated_at = toUtcIso(next.updated_at) || next.updated_at || "";
  }

  const fallbackProvider = options.defaultProvider || "universal";
  const provider = normalizeProviderId(options.targetProvider || next.target_provider);
  next.target_provider = provider || fallbackProvider;

  const compatible = normalizeProviderList(
    options.compatibleProviders ?? next.compatible_providers,
    { exclude: [next.target_provider] }
  );
  if (compatible.length > 0) {
    next.compatible_providers = formatCsv(compatible);
  } else {
    delete next.compatible_providers;
  }

  for (const key of LEGACY_METADATA_KEYS) {
    delete next[key];
  }

  return next;
}

export function listSkillDirs(skillsRoot: string): string[] {
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsRoot, entry.name))
    .filter((dirPath) => fs.existsSync(path.join(dirPath, "SKILL.md")))
    .sort((a, b) => a.localeCompare(b));
}
