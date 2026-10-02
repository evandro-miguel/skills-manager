import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readSkillsCliLockFile,
} from "../scripts/modules/integrations/skills-cli/lock-reader.ts";

function tmpLockPath(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-lock-"));
  const filePath = path.join(dir, "skills-lock.json");
  if (content !== undefined) {
    fs.writeFileSync(filePath, content, "utf8");
  }
  return filePath;
}

describe("readSkillsCliLockFile", () => {
  test("treats a missing lockfile as present:false with no entries", () => {
    const result = readSkillsCliLockFile(tmpLockPath());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.present).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("parses an array-shaped skills container", () => {
    const filePath = tmpLockPath(
      JSON.stringify({
        skills: [
          { name: "alpha", sourceUrl: "https://github.com/o/r.git", skillPath: "skills/alpha", installedAt: "2026-08-21" },
          { name: "beta", url: "https://github.com/o/r2.git", installed_at: "2026-08-20" },
        ],
      }),
    );
    const result = readSkillsCliLockFile(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      name: "alpha",
      sourceUrl: "https://github.com/o/r.git",
      skillPath: "skills/alpha",
      installedAt: "2026-08-21",
    });
    // Field aliases normalize onto the canonical shape.
    expect(result.entries[1]?.sourceUrl).toBe("https://github.com/o/r2.git");
    expect(result.entries[1]?.installedAt).toBe("2026-08-20");
    expect(result.warnings).toEqual([]);
  });

  test("parses a record-shaped skills container keyed by name", () => {
    const filePath = tmpLockPath(
      JSON.stringify({
        skills: {
          gamma: { source: "https://example.test/r.git", path: "s/gamma" },
        },
      }),
    );
    const result = readSkillsCliLockFile(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]?.name).toBe("gamma");
    expect(result.entries[0]?.sourceUrl).toBe("https://example.test/r.git");
    expect(result.entries[0]?.skillPath).toBe("s/gamma");
  });

  test("falls back to a record-style root without a container key", () => {
    const filePath = tmpLockPath(
      JSON.stringify({
        delta: { name: "delta", sourceUrl: "git+ssh://example.test/r.git" },
      }),
    );
    const result = readSkillsCliLockFile(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe("delta");
  });

  test("skips malformed entries and reports warnings instead of failing", () => {
    const filePath = tmpLockPath(
      JSON.stringify({
        skills: [{ noNameHere: true }, "just-a-string", { name: "ok-entry" }],
      }),
    );
    const result = readSkillsCliLockFile(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((entry) => entry.name)).toEqual(["ok-entry"]);
    expect(result.warnings.length).toBe(2);
  });

  test("treats an empty root object as present with zero entries", () => {
    const result = readSkillsCliLockFile(tmpLockPath("{}"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.present).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("treats prototype-shaped keys as inert data entries", () => {
    const result = readSkillsCliLockFile(
      tmpLockPath(JSON.stringify({ __proto__: { sourceUrl: "https://x.test/r" } })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Engine-agnostic guarantee: whether or not the runtime enumerates the
    // own "__proto__" key, it must stay plain inert data, never special.
    const names = result.entries.map((entry) => entry.name);
    expect(names.every((name) => name === "__proto__")).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test("rejects invalid JSON with LOCK_PARSE_INVALID", () => {
    const result = readSkillsCliLockFile(tmpLockPath("{ not json"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("LOCK_PARSE_INVALID");
  });

  test("rejects non-object roots", () => {
    const result = readSkillsCliLockFile(tmpLockPath("[1,2,3]"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("LOCK_PARSE_INVALID");
    expect(result.error.message).toContain("JSON object");
  });

  test("reports unreadable locks with LOCK_UNREADABLE", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-lock-dir-"));
    const result = readSkillsCliLockFile(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("LOCK_UNREADABLE");
  });
});
