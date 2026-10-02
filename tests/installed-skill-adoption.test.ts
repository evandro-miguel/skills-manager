import { describe, expect, test } from "bun:test";
import {
  classifyInstalledSkills,
  type AdoptionInstallEntry,
  type AdoptionLockEntry,
} from "../scripts/modules/application/services/installed-skill-adoption.ts";

function install(
  name: string,
  overrides: Partial<AdoptionInstallEntry> = {},
): AdoptionInstallEntry {
  return {
    targetId: "project",
    name,
    dirPath: `/tmp/${name}`,
    isSymlink: false,
    ...overrides,
  };
}

function lock(
  name: string,
  overrides: Partial<AdoptionLockEntry> = {},
): AdoptionLockEntry {
  return { name, ...overrides };
}

describe("classifyInstalledSkills", () => {
  test("clean install with matching digests and upstream match is SAFE_TO_ADOPT", () => {
    const result = classifyInstalledSkills({
      locks: [lock("alpha", { sourceUrl: "https://github.com/o/r.git" })],
      installs: [install("alpha", { contentDigest: "digest-1" })],
      upstreamChecks: [
        { name: "alpha", status: "UPSTREAM_MATCH", upstreamDigest: "digest-1" },
      ],
    });
    expect(result.summary.safeToAdopt).toBe(1);
    const finding = result.findings[0];
    expect(finding?.verdict).toBe("SAFE_TO_ADOPT");
    expect(finding?.states).toEqual(["STRUCTURAL_MATCH"]);
  });

  test("structurally clean install without upstream check needs verification", () => {
    const result = classifyInstalledSkills({
      locks: [lock("alpha")],
      installs: [install("alpha")],
    });
    expect(result.findings[0]?.states).toEqual([]);
    expect(result.findings[0]?.verdict).toBe("NEEDS_UPSTREAM_VERIFICATION");
    expect(result.summary.needsUpstreamVerification).toBe(1);
  });

  test("symlinked installs are BLOCKED with FOREIGN_SYMLINK", () => {
    const result = classifyInstalledSkills({
      locks: [lock("linked")],
      installs: [
        install("linked", { isSymlink: true, linkEscapesTarget: true }),
      ],
    });
    const finding = result.findings[0];
    expect(finding?.states).toContain("FOREIGN_SYMLINK");
    expect(finding?.verdict).toBe("BLOCKED");
    expect(result.summary.blocked).toBe(1);
  });

  test("names owned by Universall collide", () => {
    const result = classifyInstalledSkills({
      locks: [lock("mine")],
      installs: [install("mine")],
      managedNames: ["mine"],
    });
    expect(result.findings[0]?.states).toContain("NAME_COLLISION");
    expect(result.findings[0]?.verdict).toBe("BLOCKED");
  });

  test("same name installed in two targets collides in both findings", () => {
    const result = classifyInstalledSkills({
      locks: [lock("dup")],
      installs: [
        install("dup", { targetId: "project" }),
        install("dup", { targetId: "global" }),
      ],
    });
    expect(result.findings).toHaveLength(2);
    for (const finding of result.findings) {
      expect(finding.states).toContain("NAME_COLLISION");
      expect(finding.verdict).toBe("BLOCKED");
    }
  });

  test("installs without lock entries report LOCK_ENTRY_MISSING", () => {
    const result = classifyInstalledSkills({
      locks: [],
      installs: [install("orphan")],
    });
    expect(result.findings[0]?.states).toContain("LOCK_ENTRY_MISSING");
    expect(result.findings[0]?.verdict).toBe("BLOCKED");
  });

  test("upstream drift marks DRIFTED; missing/ambiguous sources block", () => {
    const drifted = classifyInstalledSkills({
      locks: [lock("a"), lock("b"), lock("c")],
      installs: [
        install("a", { contentDigest: "aaa" }),
        install("b"),
        install("c"),
      ],
      upstreamChecks: [
        { name: "a", status: "UPSTREAM_MATCH", upstreamDigest: "zzz" },
        { name: "b", status: "SOURCE_MISSING" },
        { name: "c", status: "SOURCE_AMBIGUOUS" },
      ],
    });
    const byName = new Map(drifted.findings.map((f) => [f.name, f]));
    expect(byName.get("a")?.states).toContain("DRIFTED");
    expect(byName.get("b")?.states).toContain("SOURCE_MISSING");
    expect(byName.get("c")?.states).toContain("SOURCE_AMBIGUOUS");
    expect(drifted.summary.blocked).toBe(3);
  });

  test("duplicate lock entries on an installed name surface as LOCK_ENTRY_DUPLICATE", () => {
    const result = classifyInstalledSkills({
      locks: [lock("dup-entry"), lock("dup-entry")],
      installs: [install("dup-entry")],
    });
    const finding = result.findings[0];
    expect(finding?.states).toContain("LOCK_ENTRY_DUPLICATE");
    expect(finding?.verdict).toBe("BLOCKED");
    expect(finding?.detail).toContain("conflicting entries");
  });

  test("cross-target collision blocks even with a matching upstream check", () => {
    const result = classifyInstalledSkills({
      locks: [lock("shared")],
      installs: [
        install("shared", { targetId: "project", contentDigest: "d" }),
        install("shared", { targetId: "global", contentDigest: "d" }),
      ],
      upstreamChecks: [
        { name: "shared", status: "UPSTREAM_MATCH", upstreamDigest: "d" },
      ],
    });
    for (const finding of result.findings) {
      expect(finding.states).toContain("NAME_COLLISION");
      expect(finding.states).toContain("STRUCTURAL_MATCH");
      expect(finding.verdict).toBe("BLOCKED");
    }
    expect(result.summary.safeToAdopt).toBe(0);
  });

  test("lock-only entries become LOCK_ENTRY_STALE with count detail", () => {
    const result = classifyInstalledSkills({
      locks: [lock("ghost-a"), lock("ghost-b"), lock("ghost-b")],
      installs: [],
    });
    expect(result.summary.staleLockEntries).toBe(2);
    const ghostB = result.findings.filter((f) => f.name === "ghost-b");
    expect(ghostB).toHaveLength(1);
    expect(ghostB[0]?.detail).toContain("conflicting entries");
    expect(ghostB[0]?.targetId).toBe("lock-only");
  });

  test("summary counts stay consistent across mixed findings", () => {
    const result = classifyInstalledSkills({
      locks: [lock("safe"), lock("drift"), lock("ghost")],
      installs: [
        install("safe", { contentDigest: "d" }),
        install("drift", { contentDigest: "d" }),
      ],
      upstreamChecks: [
        { name: "safe", status: "UPSTREAM_MATCH", upstreamDigest: "d" },
        { name: "drift", status: "UPSTREAM_DRIFT", upstreamDigest: "other" },
      ],
    });
    expect(result.summary).toEqual({
      installs: 2,
      staleLockEntries: 1,
      safeToAdopt: 1,
      blocked: 2,
      needsUpstreamVerification: 0,
    });
  });
});
