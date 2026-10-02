/**
 * Scanner for skill directories installed by an external manager.
 *
 * Read-only: it never follows, rewrites, or deletes symlinks. Symlinked
 * installs are reported with an escape flag so the adoption classifier can
 * block them; the `skills` CLI legitimately uses symlinks in some modes, so
 * a symlink alone is a finding, not proof of tampering.
 */

import fs from "node:fs";
import path from "node:path";

import type { AdoptionInstallEntry } from "../../application/services/installed-skill-adoption.ts";

export type InstalledSkillsScanResult =
  | Readonly<{ ok: true; installs: readonly AdoptionInstallEntry[] }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: "TARGET_MISSING" | "TARGET_NOT_DIRECTORY" | "TARGET_UNREADABLE";
        path: string;
        message?: string;
      }>;
    }>;

export function scanInstalledSkillsTarget(
  targetId: string,
  targetDir: string,
): InstalledSkillsScanResult {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: false, error: { code: "TARGET_MISSING", path: targetDir } };
    }
    return {
      ok: false,
      error: {
        code: "TARGET_UNREADABLE",
        path: targetDir,
        ...(error instanceof Error ? { message: error.message } : {}),
      },
    };
  }

  if (!stats.isDirectory()) {
    return {
      ok: false,
      error: { code: "TARGET_NOT_DIRECTORY", path: targetDir },
    };
  }

  const resolvedTarget = path.resolve(targetDir);
  const installs: AdoptionInstallEntry[] = [];

  for (const entry of fs.readdirSync(resolvedTarget, { withFileTypes: true })) {
    const entryPath = path.join(resolvedTarget, entry.name);
    const linkStat = fs.lstatSync(entryPath);

    if (linkStat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(entryPath);
      const resolvedLink = path.resolve(resolvedTarget, linkTarget);
      const escapes = !resolvedLink.startsWith(`${resolvedTarget}${path.sep}`);
      installs.push({
        targetId,
        name: entry.name,
        dirPath: entryPath,
        isSymlink: true,
        ...(escapes ? { linkEscapesTarget: true } : {}),
      });
      continue;
    }

    if (!linkStat.isDirectory()) {
      // Stray files in the target are not installs; ignore them here so
      // downstream classification stays focused on skill directories.
      continue;
    }

    installs.push({
      targetId,
      name: entry.name,
      dirPath: entryPath,
      isSymlink: false,
    });
  }

  installs.sort((left, right) => left.name.localeCompare(right.name));
  return { ok: true, installs };
}
