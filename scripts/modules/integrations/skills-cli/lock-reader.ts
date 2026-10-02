/**
 * Defensive reader for foreign `skills` CLI lockfiles.
 *
 * The lock belongs to another manager and its schema has drifted across
 * versions, so this reader treats it as a hint source only: unknown shapes
 * degrade to warnings, malformed entries are skipped, and nothing here ever
 * writes back. See docs/specs/external-install-ownership.md.
 */

import fs from "node:fs";

import type { AdoptionLockEntry } from "../../application/services/installed-skill-adoption.ts";

export type SkillsCliLockReadResult =
  | Readonly<{
      ok: true;
      /** False when the lockfile simply does not exist yet. */
      present: boolean;
      entries: readonly AdoptionLockEntry[];
      warnings: readonly string[];
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: "LOCK_UNREADABLE" | "LOCK_PARSE_INVALID";
        message: string;
      }>;
    }>;

const CONTAINER_KEYS = ["skills", "installed", "entries"] as const;

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeLockEntry(
  rawName: string | undefined,
  value: unknown,
): AdoptionLockEntry | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `entry '${String(rawName)}' is not an object`;
  }
  const record = value as Record<string, unknown>;
  const name =
    typeof record.name === "string" && record.name.trim().length > 0
      ? record.name.trim()
      : typeof rawName === "string"
        ? rawName.trim()
        : undefined;
  if (!name) {
    return "entry without a usable name";
  }
  const sourceUrl = firstString(record, ["sourceUrl", "source", "url"]);
  const skillPath = firstString(record, ["skillPath", "path"]);
  const sourceType = firstString(record, ["sourceType"]);
  const installedAt = firstString(record, ["installedAt", "installed_at"]);
  const ref = firstString(record, ["ref"]);
  const commit = firstString(record, ["commit"]);
  return {
    name,
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    ...(skillPath !== undefined ? { skillPath } : {}),
    ...(sourceType !== undefined ? { sourceType } : {}),
    ...(installedAt !== undefined ? { installedAt } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(commit !== undefined ? { commit } : {}),
  };
}

function collectEntriesFromContainer(
  containerValue: unknown,
  warnings: string[],
): AdoptionLockEntry[] {
  const entries: AdoptionLockEntry[] = [];

  if (Array.isArray(containerValue)) {
    containerValue.forEach((item, index) => {
      const normalized = normalizeLockEntry(undefined, item);
      if (typeof normalized === "string") {
        warnings.push(`skills[${index}]: ${normalized}`);
        return;
      }
      entries.push(normalized);
    });
    return entries;
  }

  if (typeof containerValue === "object" && containerValue !== null) {
    for (const [key, value] of Object.entries(containerValue)) {
      const normalized = normalizeLockEntry(key, value);
      if (typeof normalized === "string") {
        warnings.push(`skills.${key}: ${normalized}`);
        continue;
      }
      entries.push(normalized);
    }
    return entries;
  }

  warnings.push("container is neither an array nor an object");
  return entries;
}

export function readSkillsCliLockFile(filePath: string): SkillsCliLockReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: true, present: false, entries: [], warnings: [] };
    }
    return {
      ok: false,
      error: {
        code: "LOCK_UNREADABLE",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "LOCK_PARSE_INVALID",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        code: "LOCK_PARSE_INVALID",
        message: "lock root must be a JSON object",
      },
    };
  }

  const warnings: string[] = [];
  const root = parsed as Record<string, unknown>;
  const containerKey = CONTAINER_KEYS.find((key) => key in root);

  const entries = containerKey
    ? collectEntriesFromContainer(root[containerKey], warnings)
    : // Record-style root: name -> entry.
      collectEntriesFromContainer(root, warnings);

  return { ok: true, present: true, entries, warnings };
}
