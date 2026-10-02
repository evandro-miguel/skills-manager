/**
 * File-backed `ExternalEvidenceCache`.
 *
 * Evidence lives outside projects by contract: callers pass an explicit
 * directory (typically `<user-root>/cache/catalog/skills-sh/`). Entries are
 * small JSON documents recording fetch time and optional expiry; corrupt or
 * expired entries degrade to a miss instead of failing reads.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ExternalEvidenceCache } from "../../application/ports/external-catalog-provider.ts";

export type FileExternalEvidenceCacheOptions = Readonly<{
  /** Absolute directory outside any project. Created on first write. */
  dir: string;
  /** Default TTL applied when `set` receives no explicit ttlSeconds. */
  ttlSeconds?: number;
  now?: () => number;
}>;

type StoredEntry = {
  fetchedAtMs: number;
  expiresAtMs: number | null;
  value: string;
};

function keyToFileName(key: string): string {
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  return `${hash}.json`;
}

export class FileExternalEvidenceCache implements ExternalEvidenceCache {
  readonly #dir: string;
  readonly #defaultTtlSeconds: number | undefined;
  readonly #now: () => number;

  constructor(options: FileExternalEvidenceCacheOptions) {
    if (!path.isAbsolute(options.dir)) {
      throw new Error("evidence cache dir must be absolute (outside projects)");
    }
    this.#dir = options.dir;
    this.#defaultTtlSeconds =
      options.ttlSeconds !== undefined && options.ttlSeconds > 0
        ? Math.floor(options.ttlSeconds)
        : undefined;
    this.#now = options.now ?? (() => Date.now());
  }

  async get(key: string): Promise<string | null> {
    const filePath = path.join(this.#dir, keyToFileName(key));
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }

    let entry: StoredEntry;
    try {
      entry = JSON.parse(raw) as StoredEntry;
    } catch {
      // Corrupt entries are disposable evidence: drop quietly.
      fs.rmSync(filePath, { force: true });
      return null;
    }

    if (
      typeof entry.fetchedAtMs !== "number" ||
      typeof entry.value !== "string"
    ) {
      fs.rmSync(filePath, { force: true });
      return null;
    }

    if (
      entry.expiresAtMs !== null &&
      typeof entry.expiresAtMs === "number" &&
      this.#now() >= entry.expiresAtMs
    ) {
      fs.rmSync(filePath, { force: true });
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const effectiveTtl = ttlSeconds ?? this.#defaultTtlSeconds;
    const nowMs = this.#now();
    const entry: StoredEntry = {
      fetchedAtMs: nowMs,
      expiresAtMs:
        effectiveTtl !== undefined ? nowMs + effectiveTtl * 1000 : null,
      value,
    };

    fs.mkdirSync(this.#dir, { recursive: true });
    const finalPath = path.join(this.#dir, keyToFileName(key));
    const tempPath = `${finalPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tempPath, JSON.stringify(entry), "utf8");
    fs.renameSync(tempPath, finalPath);
  }
}
