import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  scanInstalledSkillsTarget,
} from "../scripts/modules/integrations/skills-cli/install-scanner.ts";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skills-scan-"));
}

describe("scanInstalledSkillsTarget", () => {
  test("reports TARGET_MISSING for a nonexistent target", () => {
    const missing = path.join(makeTempRoot(), "nope");
    const result = scanInstalledSkillsTarget("project", missing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TARGET_MISSING");
  });

  test("a symlink resolving to the target directory itself escapes", () => {
    const root = makeTempRoot();
    const target = path.join(root, "target");
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, path.join(target, "self-link"));

    const result = scanInstalledSkillsTarget("project", target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selfLink = result.installs.find((i) => i.name === "self-link");
    expect(selfLink?.isSymlink).toBe(true);
    expect(selfLink?.linkEscapesTarget).toBe(true);
  });

  test("reports TARGET_NOT_DIRECTORY when the path is a file", () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "skills-lock.json");
    fs.writeFileSync(filePath, "{}", "utf8");
    const result = scanInstalledSkillsTarget("project", filePath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TARGET_NOT_DIRECTORY");
  });

  test("lists skill directories sorted by name and ignores stray files", () => {
    const root = makeTempRoot();
    const target = path.join(root, ".agents", "skills");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(target, "zeta"));
    fs.mkdirSync(path.join(target, "alpha"));
    fs.writeFileSync(path.join(target, "stray.txt"), "x", "utf8");

    const result = scanInstalledSkillsTarget("project", target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.installs.map((install) => install.name)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(result.installs.every((install) => !install.isSymlink)).toBe(true);
    expect(result.installs[0]?.targetId).toBe("project");
  });

  test("flags symlinks and detects boundary escapes", () => {
    const root = makeTempRoot();
    const target = path.join(root, "project-skills");
    const outside = path.join(root, "elsewhere");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(outside);

    // Internal symlink: points at a sibling inside the same target.
    const internalReal = path.join(target, "real-internal");
    fs.mkdirSync(internalReal);
    fs.symlinkSync(internalReal, path.join(target, "internal-link"));

    // Escaping symlink: points outside the target directory.
    const externalReal = path.join(root, "real-external-source");
    fs.mkdirSync(externalReal);
    fs.symlinkSync(externalReal, path.join(target, "escaping-link"));

    const result = scanInstalledSkillsTarget("project", target);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byName = new Map(result.installs.map((i) => [i.name, i]));
    const internal = byName.get("internal-link");
    expect(internal?.isSymlink).toBe(true);
    expect(internal?.linkEscapesTarget).toBeUndefined();

    const escaping = byName.get("escaping-link");
    expect(escaping?.isSymlink).toBe(true);
    expect(escaping?.linkEscapesTarget).toBe(true);
  });
});
