#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../../lib/files.ts";
import type { SourceManifest } from "./source-manifest.ts";

/** Current schema version for the source lock file. */
export const SOURCE_LOCK_VERSION = 1;

/** A single resolved source entry in skill-sys.sources.lock.json. */
export type SourceLockEntry = {
  /** Skill name (unique identifier). */
  name: string;
  /** Git URL of the remote source repository. */
  source: string;
  /** Git ref that was requested. */
  ref: string;
  /** Full 40-character SHA-1 commit that the ref resolved to. */
  resolvedCommit: string;
  /** Directory path within the repository containing the skill. */
  skillPath?: string;
  /** Relative path to SKILL.md within the repository. */
  manifestPath: string;
  /** ISO-8601 timestamp when this entry was resolved. */
  resolvedAt: string;
};

/** Top-level shape of skill-sys.sources.lock.json. */
export type SourceLock = {
  version: number;
  generatedAt: string;
  sources: SourceLockEntry[];
};

const KNOWN_ENTRY_KEYS = new Set([
  "name",
  "source",
  "ref",
  "resolvedCommit",
  "skillPath",
  "manifestPath",
  "resolvedAt",
]);

const COMMIT_SHA_PATTERN = /^[A-Fa-f0-9]{40}$/;

function sortEntryKeys(entry: SourceLockEntry): SourceLockEntry {
  const result: SourceLockEntry = {
    name: entry.name,
    source: entry.source,
    ref: entry.ref,
    resolvedCommit: entry.resolvedCommit,
    ...(entry.skillPath !== undefined ? { skillPath: entry.skillPath } : {}),
    manifestPath: entry.manifestPath,
    resolvedAt: entry.resolvedAt,
  };
  return result;
}

function validateEntry(entry: unknown, index: number): SourceLockEntry {
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
  if (typeof obj.resolvedCommit !== "string" || !COMMIT_SHA_PATTERN.test(obj.resolvedCommit)) {
    throw new Error(
      `sources[${index}]: resolvedCommit is required and must be a 40-character hex SHA-1`,
    );
  }
  if (obj.skillPath !== undefined && typeof obj.skillPath !== "string") {
    throw new Error(`sources[${index}]: skillPath must be a string when present`);
  }
  if (typeof obj.manifestPath !== "string" || obj.manifestPath.length === 0) {
    throw new Error(
      `sources[${index}]: manifestPath is required and must be a non-empty string`,
    );
  }
  if (typeof obj.resolvedAt !== "string" || obj.resolvedAt.length === 0) {
    throw new Error(`sources[${index}]: resolvedAt is required and must be a non-empty string`);
  }

  return {
    name: obj.name,
    source: obj.source,
    ref: obj.ref,
    resolvedCommit: obj.resolvedCommit,
    ...(obj.skillPath !== undefined ? { skillPath: obj.skillPath as string } : {}),
    manifestPath: obj.manifestPath,
    resolvedAt: obj.resolvedAt,
  };
}

/**
 * Validate a SourceLock object. Throws on any structural or type error.
 */
export function validateSourceLock(data: unknown): SourceLock {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Source lock must be an object");
  }
  const obj = data as Record<string, unknown>;

  if (obj.version !== SOURCE_LOCK_VERSION) {
    throw new Error(
      `Source lock version must be ${SOURCE_LOCK_VERSION}, got ${String(obj.version)}`,
    );
  }
  if (typeof obj.generatedAt !== "string" || obj.generatedAt.length === 0) {
    throw new Error("Source lock 'generatedAt' is required and must be a non-empty string");
  }
  if (!Array.isArray(obj.sources)) {
    throw new Error("Source lock 'sources' must be an array");
  }
  if (obj.sources.length === 0) {
    throw new Error("Source lock 'sources' must not be empty");
  }

  const validatedSources = obj.sources.map((entry, i) => validateEntry(entry, i));
  return {
    version: SOURCE_LOCK_VERSION,
    generatedAt: obj.generatedAt,
    sources: validatedSources,
  };
}

/**
 * Resolution metadata produced for a single manifest source entry, supplied by
 * the command/network layer. `buildSourceLock` is pure and performs no I/O.
 */
export type SourceLockResolution = {
  /** Full 40-character SHA-1 commit that the manifest ref resolved to. */
  resolvedCommit: string;
  /** Relative path to SKILL.md within the repository. */
  manifestPath: string;
};

/**
 * Assemble a `SourceLock` from a manifest and a resolution map without any
 * filesystem or network I/O.
 *
 * Each manifest entry must have a matching resolution keyed by skill name.
 * `now` is used for both the top-level `generatedAt` and every entry's
 * `resolvedAt`. The result is passed through `validateSourceLock`, so invalid
 * commits, empty manifest paths, or unknown fields are rejected.
 */
export function buildSourceLock(
  manifest: SourceManifest,
  resolutions: Record<string, SourceLockResolution>,
  now: string,
): SourceLock {
  const sources: SourceLockEntry[] = manifest.sources.map((entry, index) => {
    const resolution = resolutions[entry.name];
    if (resolution === undefined) {
      throw new Error(
        `sources[${index}]: no resolution provided for skill '${entry.name}'`,
      );
    }
    return {
      name: entry.name,
      source: entry.source,
      ref: entry.ref,
      resolvedCommit: resolution.resolvedCommit,
      ...(entry.skillPath !== undefined ? { skillPath: entry.skillPath } : {}),
      manifestPath: resolution.manifestPath,
      resolvedAt: now,
    };
  });

  return validateSourceLock({
    version: SOURCE_LOCK_VERSION,
    generatedAt: now,
    sources,
  });
}

/**
 * Load and validate a source lock file from disk.
 */
export function loadSourceLock(filePath: string): SourceLock {
  const raw = readJson<unknown>(filePath);
  return validateSourceLock(raw);
}

/**
 * Write a validated source lock file to disk with deterministic key ordering.
 */
export function writeSourceLock(filePath: string, lock: SourceLock): void {
  validateSourceLock(lock);
  const ordered: SourceLock = {
    version: lock.version,
    generatedAt: lock.generatedAt,
    sources: lock.sources.map(sortEntryKeys),
  };
  writeJson(filePath, ordered);
}
