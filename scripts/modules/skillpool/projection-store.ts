#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  copyDirectory,
  ensureDir,
  fileExists,
  hashFile,
  listFilesRecursive,
  writeFileAtomicSafe,
} from "../../lib/files.ts";
import { resolveSkillpoolHome } from "./cache.ts";
import type { ConcreteProviderId } from "./providers.ts";
import type { SkillOrigin } from "./projection-sources.ts";

const PROJECTION_STORE_SCHEMA_VERSION = "v1";
// Single source of truth for the projection renderer version: it feeds both
// the renderer metadata (projection records and manifest) and the store
// content key. Bumping the renderer changes every content key, so old store
// entries become unreachable (harmless) instead of being reused for
// differently-rendered content.
export const RENDERER_VERSION = 1;
const PROJECTION_META_FILE = "projection.meta.json";
// Store metadata lives OUTSIDE the payload dir as a sibling file so the
// payload dir never reserves names that skill content may legitimately use.
// The payload dir is keyed `<contentKey>/` and its metadata is
// `<contentKey>.meta.json` next to it.
const PROJECTION_STORE_META_SUFFIX = ".meta.json";
// The payload dir contains ONLY rendered projection content: the whole
// projection tree except projection.meta.json (the renderer's per-projection
// record, which is never stored). No store-owned names are reserved inside
// the payload dir, so real skill content with any file name survives a store
// round-trip byte-identically.
const STORE_COPY_SKIP_NAMES = new Set([PROJECTION_META_FILE]);

// Full-content digest of a store entry: every file in the payload dir except
// projection.meta.json (which is never stored). The skip set is EXPLICITLY the
// store's own (STORE_COPY_SKIP_NAMES == {projection.meta.json}) so the
// lib/files default skip names (node_modules, .git, dist, ...) can never leak
// in and silently exclude payload content from the digest. Mirrors
// digestDirectoryExcludingMeta in projections.ts (basename filter, no
// stat-based caching), minus that helper's default-skip exposure.
function storeContentDigest(entryDir: string): string {
  const files = listFilesRecursive(entryDir, { skipNames: STORE_COPY_SKIP_NAMES })
    .filter((filePath) => path.basename(filePath) !== PROJECTION_META_FILE)
    .map((filePath) => {
      const rel = path.relative(entryDir, filePath).replaceAll("\\", "/");
      return `${rel}\0${hashFile(filePath)}`;
    })
    .join("\n");
  return crypto.createHash("sha256").update(files).digest("hex");
}

function storeTempEntryPath(storeRoot: string, key: string): string {
  return path.join(storeRoot, `.tmp-${key}-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
}

/**
 * Input-key descriptor for one store entry, persisted as the sibling
 * `<entryDir>.meta.json` file and verified on read before reuse. A foreign or
 * colliding entry (whose directory name no longer matches the inputs that
 * produced it) is rejected so the caller falls back to a full rebuild instead
 * of reusing the wrong content.
 */
export interface ProjectionStoreDescriptor {
  schemaVersion: string;
  rendererVersion: number;
  provider: ConcreteProviderId;
  origin: SkillOrigin;
  canonicalDigest: string;
  manualOnly: boolean;
  contentKey: string;
}

/**
 * Full metadata record persisted for a store entry: the input-key descriptor
 * plus the full-content digest of the payload dir. All store metadata lives in
 * this single sibling file; nothing store-owned is written inside the payload
 * dir.
 */
export interface ProjectionStoreMeta extends ProjectionStoreDescriptor {
  digest: string;
}

function contentKeyFromParts(parts: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Content key for one provider projection. The canonical digest is the full
 * dirDigest of the skill source; hashing is never skipped. The full 64-hex
 * sha256 digest is used as the store directory name so a truncated key can
 * never alias different inputs.
 */
export function projectionContentKey(
  provider: ConcreteProviderId,
  origin: SkillOrigin,
  canonicalDigest: string,
  manualOnly: boolean
): string {
  return contentKeyFromParts([
    PROJECTION_STORE_SCHEMA_VERSION,
    String(RENDERER_VERSION),
    provider,
    origin,
    canonicalDigest,
    manualOnly ? "1" : "0",
  ]);
}

export function projectionStoreEntryPath(
  provider: ConcreteProviderId,
  contentKey: string,
  storeRoot: string = path.join(resolveSkillpoolHome(), "projection-store")
): string {
  return path.join(
    path.resolve(storeRoot),
    PROJECTION_STORE_SCHEMA_VERSION,
    provider,
    contentKey
  );
}

export function projectionStoreMetaPath(entryDir: string): string {
  return `${entryDir}${PROJECTION_STORE_META_SUFFIX}`;
}

function readProjectionStoreMeta(entryDir: string): ProjectionStoreMeta | null {
  try {
    const meta = JSON.parse(
      fs.readFileSync(projectionStoreMetaPath(entryDir), "utf8")
    ) as Partial<ProjectionStoreMeta>;
    if (typeof meta.schemaVersion !== "string") return null;
    if (typeof meta.rendererVersion !== "number") return null;
    if (typeof meta.provider !== "string") return null;
    if (typeof meta.origin !== "string") return null;
    if (typeof meta.canonicalDigest !== "string" || !/^[a-f0-9]{64}$/i.test(meta.canonicalDigest)) {
      return null;
    }
    if (typeof meta.manualOnly !== "boolean") return null;
    if (typeof meta.contentKey !== "string" || !/^[a-f0-9]{64}$/i.test(meta.contentKey)) {
      return null;
    }
    if (typeof meta.digest !== "string" || !/^[a-f0-9]{64}$/i.test(meta.digest)) {
      return null;
    }
    return meta as ProjectionStoreMeta;
  } catch {
    // Missing or unreadable metadata: not a recognized store entry.
    return null;
  }
}

export function projectionStoreEntryValid(entryDir: string, expectedContentKey: string): boolean {
  try {
    if (!fileExists(entryDir)) {
      return false;
    }
    const entryStat = fs.lstatSync(entryDir);
    if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
      return false;
    }
    const meta = readProjectionStoreMeta(entryDir);
    if (!meta) {
      return false;
    }
    if (meta.schemaVersion !== PROJECTION_STORE_SCHEMA_VERSION) {
      return false;
    }
    if (meta.rendererVersion !== RENDERER_VERSION) {
      return false;
    }
    // The persisted metadata must claim the expected content key...
    if (meta.contentKey !== expectedContentKey) {
      return false;
    }
    // ...and the inputs stored in the metadata must re-derive that key.
    const derivedKey = contentKeyFromParts([
      meta.schemaVersion,
      String(meta.rendererVersion),
      meta.provider,
      meta.origin,
      meta.canonicalDigest,
      meta.manualOnly ? "1" : "0",
    ]);
    if (derivedKey !== expectedContentKey) {
      return false;
    }
    // Full-content digest of the payload dir (only projection.meta.json is
    // excluded, and it is never in the store) must match the persisted digest.
    return storeContentDigest(entryDir) === meta.digest.toLowerCase();
  } catch {
    // Any read failure is treated as an invalid entry so the caller falls
    // back to a full rebuild.
    return false;
  }
}

export function readProjectionFromStore(entryDir: string, targetDir: string): void {
  copyDirectory(entryDir, targetDir, { skipNames: STORE_COPY_SKIP_NAMES });
}

/**
 * Publishes a rendered projection into the store. Content is rendered into a
 * temp dir under the store root, the final payload dir is reserved with atomic
 * exclusive creation, and only then the temp dir is renamed into place and the
 * sibling metadata file is written. On POSIX, rename replaces an existing
 * EMPTY directory, so without the exclusive reservation a foreign empty entry
 * would be silently clobbered; the mkdir reservation guarantees an existing
 * entry (empty or not) is never overwritten — the temp payload is discarded
 * and the existing entry is kept.
 */
export function writeProjectionToStore(
  sourceTargetDir: string,
  entryDir: string,
  descriptor: ProjectionStoreDescriptor
): void {
  const storeRoot = path.dirname(entryDir);
  ensureDir(storeRoot);
  const tempDir = storeTempEntryPath(storeRoot, path.basename(entryDir));
  try {
    copyDirectory(sourceTargetDir, tempDir, { skipNames: STORE_COPY_SKIP_NAMES });
    const digest = storeContentDigest(tempDir);
    // Reserve the final payload dir with atomic exclusive creation BEFORE
    // renaming: EEXIST means an entry (empty or not) already occupies the key,
    // so discard the temp payload and keep the existing entry. On success the
    // empty dir is exclusively ours, so the rename below only ever replaces
    // our own reservation — a foreign entry can never be clobbered.
    try {
      fs.mkdirSync(entryDir);
    } catch (error) {
      const cause = error as NodeJS.ErrnoException;
      if (cause.code === "EEXIST") {
        if (fileExists(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
        return;
      }
      throw error;
    }
    // The payload dir is now ours; rename temp over it (POSIX atomically
    // replaces the empty reservation dir).
    fs.renameSync(tempDir, entryDir);
    // All store metadata is written OUTSIDE the payload dir as a sibling
    // file, written last: an entry without a metadata file is invalid, so a
    // crash between the payload rename and the metadata write fails closed
    // (the next read falls back to a full rebuild).
    try {
      writeFileAtomicSafe(
        projectionStoreMetaPath(entryDir),
        `${JSON.stringify({ ...descriptor, digest } satisfies ProjectionStoreMeta, null, 2)}\n`
      );
    } catch (error) {
      // The payload dir is exclusively ours (we reserved it above), so roll
      // it back instead of leaving a permanently invalid entry that a later
      // write would refuse to replace.
      fs.rmSync(entryDir, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    if (fileExists(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    const cause = error as NodeJS.ErrnoException;
    if (cause.code === "ENOTEMPTY" || cause.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

export { PROJECTION_STORE_SCHEMA_VERSION };
