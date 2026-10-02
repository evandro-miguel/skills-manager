#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../../lib/files.ts";

/** Current schema version for the source manifest file. */
export const SOURCE_MANIFEST_VERSION = 1;

/** A single source entry in skill-sys.sources.json. */
export type SourceManifestEntry = {
  /** Skill name (unique identifier within the manifest). */
  name: string;
  /** Git URL of the remote source repository. */
  source: string;
  /** Git ref (branch, tag, or commit SHA) to resolve. */
  ref: string;
  /** Directory path within the repository containing the skill. */
  skillPath?: string;
};

/** Top-level shape of skill-sys.sources.json. */
export type SourceManifest = {
  version: number;
  sources: SourceManifestEntry[];
};

const KNOWN_ENTRY_KEYS = new Set(["name", "source", "ref", "skillPath"]);

function sortEntryKeys(entry: SourceManifestEntry): SourceManifestEntry {
  const result: SourceManifestEntry = { name: entry.name, source: entry.source, ref: entry.ref };
  if (entry.skillPath !== undefined) {
    result.skillPath = entry.skillPath;
  }
  return result;
}

function validateEntry(entry: unknown, index: number): SourceManifestEntry {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`sources[${index}] must be an object`);
  }
  const obj = entry as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_ENTRY_KEYS.has(key)) {
      throw new Error(`sources[${index}]: unexpected key '${key}'`);
    }
  }

  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new Error(`sources[${index}]: name is required and must be a non-empty string`);
  }
  if (typeof obj.source !== "string" || obj.source.length === 0) {
    throw new Error(`sources[${index}]: source is required and must be a non-empty string`);
  }
  if (typeof obj.ref !== "string" || obj.ref.length === 0) {
    throw new Error(`sources[${index}]: ref is required and must be a non-empty string`);
  }
  if (obj.skillPath !== undefined && typeof obj.skillPath !== "string") {
    throw new Error(`sources[${index}]: skillPath must be a string when present`);
  }

  return {
    name: obj.name,
    source: obj.source,
    ref: obj.ref,
    ...(obj.skillPath !== undefined ? { skillPath: obj.skillPath as string } : {}),
  };
}

/**
 * Validate a SourceManifest object. Throws on any structural or type error.
 * Enforces: correct version, non-empty sources, required fields, no unknown keys.
 */
export function validateSourceManifest(data: unknown): SourceManifest {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Source manifest must be an object");
  }
  const obj = data as Record<string, unknown>;

  if (obj.version !== SOURCE_MANIFEST_VERSION) {
    throw new Error(
      `Source manifest version must be ${SOURCE_MANIFEST_VERSION}, got ${String(obj.version)}`,
    );
  }
  if (!Array.isArray(obj.sources)) {
    throw new Error("Source manifest 'sources' must be an array");
  }
  if (obj.sources.length === 0) {
    throw new Error("Source manifest 'sources' must not be empty");
  }

  const validatedSources = obj.sources.map((entry, i) => validateEntry(entry, i));
  return { version: SOURCE_MANIFEST_VERSION, sources: validatedSources };
}

/**
 * Load and validate a source manifest from disk.
 */
export function loadSourceManifest(filePath: string): SourceManifest {
  const raw = readJson<unknown>(filePath);
  return validateSourceManifest(raw);
}

/**
 * Write a validated source manifest to disk with deterministic key ordering.
 */
export function writeSourceManifest(filePath: string, manifest: SourceManifest): void {
  validateSourceManifest(manifest);
  const ordered: SourceManifest = {
    version: manifest.version,
    sources: manifest.sources.map(sortEntryKeys),
  };
  writeJson(filePath, ordered);
}

/**
 * Find duplicate skill names in a manifest.
 * Returns an array of duplicated names (unique).
 */
export function findDuplicateSkills(manifest: SourceManifest): string[] {
  const seen = new Map<string, number>();
  for (const entry of manifest.sources) {
    seen.set(entry.name, (seen.get(entry.name) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
}
