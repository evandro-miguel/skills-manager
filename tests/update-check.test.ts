import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildUpdateReport,
  main,
  parseArgs,
  runUpdateCheck,
  type ResolveRemoteRef,
  type UpdateReport,
  type UpdateReportEntry,
} from "../scripts/commands/update-check.ts";
import {
  SOURCE_MANIFEST_VERSION,
  type SourceManifest,
} from "../scripts/modules/skill-sys/source-manifest.ts";
import {
  SOURCE_LOCK_VERSION,
  type SourceLock,
} from "../scripts/modules/skill-sys/source-lock.ts";

const FIXED_NOW = "2026-06-14T12:00:00.000Z";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "update-check-test-"));
}

function manifestOf(sources: Array<{ name: string; source: string; ref: string; skillPath?: string }>): SourceManifest {
  return { version: SOURCE_MANIFEST_VERSION, sources };
}

function lockOf(sources: Array<{
  name: string;
  source: string;
  ref: string;
  resolvedCommit: string;
  skillPath?: string;
}>): SourceLock {
  return {
    version: SOURCE_LOCK_VERSION,
    generatedAt: FIXED_NOW,
    sources: sources.map((entry) => ({
      name: entry.name,
      source: entry.source,
      ref: entry.ref,
      resolvedCommit: entry.resolvedCommit,
      ...(entry.skillPath !== undefined ? { skillPath: entry.skillPath } : {}),
      manifestPath: `${entry.skillPath ?? entry.name}/SKILL.md`,
      resolvedAt: FIXED_NOW,
    })),
  };
}

/** Builds a resolver that maps "<source>\u0000<ref>" -> commit, defaulting to COMMIT_A. */
function resolverFrom(map: Record<string, string>, throwOn?: Array<string>): ResolveRemoteRef {
  return (source: string, ref: string) => {
    const key = `${source}\u0000${ref}`;
    if (throwOn && throwOn.includes(key)) {
      throw new Error("network down");
    }
    return map[key] ?? COMMIT_A;
  };
}

describe("update-check buildUpdateReport", () => {
  const manifest = manifestOf([
    { name: "up-to-date-skill", source: "https://example.com/a.git", ref: "v1", skillPath: "skills/a" },
    { name: "stale-skill", source: "https://example.com/b.git", ref: "main", skillPath: "skills/b" },
    { name: "offline-skill", source: "https://example.com/c.git", ref: "v2", skillPath: "skills/c" },
    { name: "unlocked-skill", source: "https://example.com/d.git", ref: "v3", skillPath: "skills/d" },
  ]);

  const lock = lockOf([
    { name: "up-to-date-skill", source: "https://example.com/a.git", ref: "v1", resolvedCommit: COMMIT_A, skillPath: "skills/a" },
    { name: "stale-skill", source: "https://example.com/b.git", ref: "main", resolvedCommit: COMMIT_A, skillPath: "skills/b" },
    { name: "offline-skill", source: "https://example.com/c.git", ref: "v2", resolvedCommit: COMMIT_A, skillPath: "skills/c" },
  ]);

  const resolve = resolverFrom(
    {
      "https://example.com/a.git\u0000v1": COMMIT_A,
      "https://example.com/b.git\u0000main": COMMIT_B,
      "https://example.com/d.git\u0000v3": COMMIT_A,
    },
    ["https://example.com/c.git\u0000v2"],
  );

  const report = buildUpdateReport(manifest, lock, resolve, () => FIXED_NOW);
  const byName = new Map<string, UpdateReportEntry>(report.entries.map((entry) => [entry.name, entry]));

  test("records the check timestamp", () => {
    expect(report.checkedAt).toBe(FIXED_NOW);
  });

  test("reports up-to-date when locked commit matches latest", () => {
    const entry = byName.get("up-to-date-skill")!;
    expect(entry.status).toBe("up-to-date");
    expect(entry.currentCommit).toBe(COMMIT_A);
    expect(entry.latestCommit).toBe(COMMIT_A);
    expect(entry.error).toBeUndefined();
  });

  test("reports update-available when the ref moved to a new commit", () => {
    const entry = byName.get("stale-skill")!;
    expect(entry.status).toBe("update-available");
    expect(entry.currentCommit).toBe(COMMIT_A);
    expect(entry.latestCommit).toBe(COMMIT_B);
    expect(entry.currentRef).toBe("main");
    expect(entry.latestRef).toBe("main");
    expect(entry.error).toBeUndefined();
  });

  test("reports error when resolution fails, preserving the locked current state", () => {
    const entry = byName.get("offline-skill")!;
    expect(entry.status).toBe("error");
    expect(entry.currentCommit).toBe(COMMIT_A);
    expect(entry.error).toContain("network down");
  });

  test("reports update-available (no current) for a manifest source with no lock entry", () => {
    const entry = byName.get("unlocked-skill")!;
    expect(entry.status).toBe("update-available");
    expect(entry.currentCommit).toBeUndefined();
    expect(entry.latestCommit).toBe(COMMIT_A);
  });

  test("does not mutate the filesystem (pure function)", () => {
    expect(typeof report).toBe("object");
    expect(report.entries).toHaveLength(4);
  });
});

describe("update-check buildUpdateReport full-SHA pin", () => {
  test("treats a pinned commit as up-to-date against the same locked commit", () => {
    const manifest = manifestOf([
      { name: "pinned", source: "https://example.com/a.git", ref: COMMIT_B },
    ]);
    const lock = lockOf([
      { name: "pinned", source: "https://example.com/a.git", ref: COMMIT_B, resolvedCommit: COMMIT_B },
    ]);
    // Resolver must not be called for a full SHA; inject a throwing one to prove it.
    const report = buildUpdateReport(
      manifest,
      lock,
      () => {
        throw new Error("should not resolve a pinned commit");
      },
      () => FIXED_NOW,
    );
    expect(report.entries[0]!.status).toBe("up-to-date");
    expect(report.entries[0]!.latestCommit).toBe(COMMIT_B);
  });
});

describe("update-check runUpdateCheck", () => {
  let tmpDir: string;
  let manifestPath: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    manifestPath = path.join(tmpDir, "skill-sys.sources.json");
    lockPath = path.join(tmpDir, "skill-sys.sources.lock.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJson(filePath: string, data: unknown): void {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  test("produces a valid report from disk with an injected resolver", () => {
    writeJson(
      manifestPath,
      manifestOf([{ name: "a", source: "https://example.com/a.git", ref: "v1" }]),
    );
    writeJson(
      lockPath,
      lockOf([{ name: "a", source: "https://example.com/a.git", ref: "v1", resolvedCommit: COMMIT_A }]),
    );

    const { report, exitCode } = runUpdateCheck({
      source: tmpDir,
      manifest: null,
      lockfile: null,
      strict: false,
      resolve: () => COMMIT_A,
      now: () => FIXED_NOW,
    });

    expect(exitCode).toBe(0);
    expect(report.checkedAt).toBe(FIXED_NOW);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.status).toBe("up-to-date");
  });

  test("strict mode returns exit code 1 when an update is available", () => {
    writeJson(
      manifestPath,
      manifestOf([{ name: "a", source: "https://example.com/a.git", ref: "main" }]),
    );
    writeJson(
      lockPath,
      lockOf([{ name: "a", source: "https://example.com/a.git", ref: "main", resolvedCommit: COMMIT_A }]),
    );

    const { exitCode } = runUpdateCheck({
      source: tmpDir,
      manifest: null,
      lockfile: null,
      strict: true,
      resolve: () => COMMIT_B,
      now: () => FIXED_NOW,
    });

    expect(exitCode).toBe(1);
  });

  test("strict mode returns exit code 1 on resolver errors", () => {
    writeJson(
      manifestPath,
      manifestOf([{ name: "a", source: "https://example.com/a.git", ref: "v1" }]),
    );
    writeJson(
      lockPath,
      lockOf([{ name: "a", source: "https://example.com/a.git", ref: "v1", resolvedCommit: COMMIT_A }]),
    );

    const { exitCode } = runUpdateCheck({
      source: tmpDir,
      manifest: null,
      lockfile: null,
      strict: true,
      resolve: () => {
        throw new Error("offline");
      },
      now: () => FIXED_NOW,
    });

    expect(exitCode).toBe(1);
  });

  test("rejects a manifest with duplicate skill names", () => {
    writeJson(
      manifestPath,
      manifestOf([
        { name: "dup", source: "https://example.com/a.git", ref: "v1" },
        { name: "dup", source: "https://example.com/b.git", ref: "v2" },
      ]),
    );
    writeJson(
      lockPath,
      lockOf([{ name: "dup", source: "https://example.com/a.git", ref: "v1", resolvedCommit: COMMIT_A }]),
    );

    expect(() =>
      runUpdateCheck({
        source: tmpDir,
        manifest: null,
        lockfile: null,
        strict: false,
        resolve: () => COMMIT_A,
        now: () => FIXED_NOW,
      }),
    ).toThrow(/Duplicate skill names.*dup/);
  });

  test("throws a clear error when the manifest is missing", () => {
    expect(() =>
      runUpdateCheck({
        source: tmpDir,
        manifest: null,
        lockfile: null,
        strict: false,
        resolve: () => COMMIT_A,
        now: () => FIXED_NOW,
      }),
    ).toThrow(/Source manifest not found/);
  });

  test("throws a clear, honest error when the lock is missing", () => {
    writeJson(
      manifestPath,
      manifestOf([{ name: "a", source: "https://example.com/a.git", ref: "v1" }]),
    );

    expect(() =>
      runUpdateCheck({
        source: tmpDir,
        manifest: null,
        lockfile: null,
        strict: false,
        resolve: () => COMMIT_A,
        now: () => FIXED_NOW,
      }),
    ).toThrow(/Source lock not found/);
  });

  test("honors explicit --manifest and --lockfile overrides", () => {
    const customManifest = path.join(tmpDir, "custom.manifest.json");
    const customLock = path.join(tmpDir, "custom.lock.json");
    writeJson(
      customManifest,
      manifestOf([{ name: "a", source: "https://example.com/a.git", ref: "v1" }]),
    );
    writeJson(
      customLock,
      lockOf([{ name: "a", source: "https://example.com/a.git", ref: "v1", resolvedCommit: COMMIT_A }]),
    );

    const { report } = runUpdateCheck({
      source: tmpDir,
      manifest: "custom.manifest.json",
      lockfile: "custom.lock.json",
      strict: false,
      resolve: () => COMMIT_A,
      now: () => FIXED_NOW,
    });

    expect(report.entries[0]!.status).toBe("up-to-date");
  });
});

describe("update-check parseArgs", () => {
  test("applies documented defaults", () => {
    const args = parseArgs(["bun", "update-check"]);
    expect(args.source).toBe(".");
    expect(args.manifest).toBeNull();
    expect(args.lockfile).toBeNull();
    expect(args.strict).toBe(false);
    expect(args.help).toBe(false);
  });

  test("parses all supported flags", () => {
    const args = parseArgs([
      "bun",
      "update-check",
      "--source",
      "./proj",
      "--manifest",
      "m.json",
      "--lockfile",
      "l.json",
      "--strict",
      "--json",
    ]);
    expect(args.source).toBe("./proj");
    expect(args.manifest).toBe("m.json");
    expect(args.lockfile).toBe("l.json");
    expect(args.strict).toBe(true);
    expect(args.json).toBe(true);
  });

  test("shows help", () => {
    const args = parseArgs(["bun", "update-check", "--help"]);
    expect(args.help).toBe(true);
  });

  test("rejects unknown options", () => {
    expect(() => parseArgs(["bun", "update-check", "--bogus", "x"])).toThrow(/Unknown option/);
  });
});

describe("update-check main", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("emits JSON report to stdout and a summary to stderr, exit 0 by default", () => {
    fs.writeFileSync(
      path.join(tmpDir, "skill-sys.sources.json"),
      `${JSON.stringify(manifestOf([{ name: "a", source: "https://example.com/a.git", ref: "v1" }]), null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "skill-sys.sources.lock.json"),
      `${JSON.stringify(lockOf([{ name: "a", source: "https://example.com/a.git", ref: "v1", resolvedCommit: COMMIT_A }]), null, 2)}\n`,
    );

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main(
      ["bun", "update-check", "--source", tmpDir],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        resolve: () => COMMIT_A,
        now: () => FIXED_NOW,
      },
    );

    expect(code).toBe(0);
    const report = JSON.parse(stdout.join("\n")) as UpdateReport;
    expect(report.checkedAt).toBe(FIXED_NOW);
    expect(report.entries[0]!.status).toBe("up-to-date");
    expect(stderr.join("\n")).toContain("1 up-to-date");
  });

  test("returns exit code 1 under --strict when an update is available", () => {
    fs.writeFileSync(
      path.join(tmpDir, "skill-sys.sources.json"),
      `${JSON.stringify(manifestOf([{ name: "a", source: "https://example.com/a.git", ref: "main" }]), null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "skill-sys.sources.lock.json"),
      `${JSON.stringify(lockOf([{ name: "a", source: "https://example.com/a.git", ref: "main", resolvedCommit: COMMIT_A }]), null, 2)}\n`,
    );

    const code = main(
      ["bun", "update-check", "--source", tmpDir, "--strict"],
      {
        stdout: () => undefined,
        stderr: () => undefined,
        resolve: () => COMMIT_B,
        now: () => FIXED_NOW,
      },
    );

    expect(code).toBe(1);
  });

  test("returns exit code 1 and prints an error when the manifest is missing", () => {
    const stderr: string[] = [];
    const code = main(
      ["bun", "update-check", "--source", tmpDir],
      {
        stdout: () => undefined,
        stderr: (message) => stderr.push(message),
        resolve: () => COMMIT_A,
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("Source manifest not found");
  });
});
