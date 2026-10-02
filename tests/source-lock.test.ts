import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type SourceLockEntry,
  type SourceLock,
  type SourceLockResolution,
  validateSourceLock,
  loadSourceLock,
  writeSourceLock,
  buildSourceLock,
  SOURCE_LOCK_VERSION,
} from "../scripts/modules/skill-sys/source-lock.ts";
import {
  type SourceManifest,
  type SourceManifestEntry,
  SOURCE_MANIFEST_VERSION,
} from "../scripts/modules/skill-sys/source-manifest.ts";

const VALID_ENTRY: SourceLockEntry = {
  name: "example-skill",
  source: "https://github.com/example/skills.git",
  ref: "v1.0.0",
  resolvedCommit: "a".repeat(40),
  skillPath: "skills/example-skill",
  manifestPath: "skills/example-skill/SKILL.md",
  resolvedAt: "2026-06-09T12:00:00.000Z",
};

const VALID_LOCK: SourceLock = {
  version: SOURCE_LOCK_VERSION,
  generatedAt: "2026-06-09T12:00:00.000Z",
  sources: [VALID_ENTRY],
};

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "source-lock-test-"));
}

describe("source lock", () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    lockPath = path.join(tmpDir, "skill-sys.sources.lock.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("write and load round trip preserves structure", () => {
    writeSourceLock(lockPath, VALID_LOCK);
    const loaded = loadSourceLock(lockPath);
    expect(loaded).toEqual(VALID_LOCK);
  });

  test("write produces deterministic key ordering", () => {
    writeSourceLock(lockPath, VALID_LOCK);
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);

    // Top-level keys: version, generatedAt, sources
    const topKeys = Object.keys(parsed);
    expect(topKeys.indexOf("version")).toBeLessThan(topKeys.indexOf("generatedAt"));
    expect(topKeys.indexOf("generatedAt")).toBeLessThan(topKeys.indexOf("sources"));

    // Entry keys order
    const entryKeys = Object.keys(parsed.sources[0]);
    expect(entryKeys).toEqual([
      "name",
      "source",
      "ref",
      "resolvedCommit",
      "skillPath",
      "manifestPath",
      "resolvedAt",
    ]);
  });

  test("round trip is byte-identical for same data", () => {
    writeSourceLock(lockPath, VALID_LOCK);
    const first = fs.readFileSync(lockPath, "utf8");

    const loaded = loadSourceLock(lockPath);
    writeSourceLock(lockPath, loaded);
    const second = fs.readFileSync(lockPath, "utf8");

    expect(second).toBe(first);
  });

  test("validate accepts a valid lock", () => {
    expect(() => validateSourceLock(VALID_LOCK)).not.toThrow();
  });

  test("validate rejects unknown version", () => {
    const lock = { ...VALID_LOCK, version: 99 };
    expect(() => validateSourceLock(lock)).toThrow(/version/);
  });

  test("validate rejects missing version", () => {
    const { version: _, ...noVersion } = VALID_LOCK;
    expect(() => validateSourceLock(noVersion)).toThrow(/version/);
  });

  test("validate rejects missing generatedAt", () => {
    const { generatedAt: _, ...noGen } = VALID_LOCK;
    expect(() => validateSourceLock(noGen)).toThrow(/generatedAt/);
  });

  test("validate rejects missing sources array", () => {
    const { sources: _, ...noSources } = VALID_LOCK;
    expect(() => validateSourceLock(noSources)).toThrow(/sources/);
  });

  test("validate rejects empty sources array", () => {
    expect(() =>
      validateSourceLock({
        version: SOURCE_LOCK_VERSION,
        generatedAt: "2026-06-09T12:00:00.000Z",
        sources: [],
      }),
    ).toThrow(/sources/);
  });

  test("validate rejects entry with missing resolvedCommit", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...VALID_ENTRY } as any;
    delete bad.resolvedCommit;
    expect(() =>
      validateSourceLock({
        version: SOURCE_LOCK_VERSION,
        generatedAt: "2026-06-09T12:00:00.000Z",
        sources: [bad],
      }),
    ).toThrow(/resolvedCommit/);
  });

  test("validate rejects entry with invalid resolvedCommit length", () => {
    const bad = { ...VALID_ENTRY, resolvedCommit: "abc" };
    expect(() =>
      validateSourceLock({
        version: SOURCE_LOCK_VERSION,
        generatedAt: "2026-06-09T12:00:00.000Z",
        sources: [bad],
      }),
    ).toThrow(/resolvedCommit/);
  });

  test("validate rejects entry with missing manifestPath", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...VALID_ENTRY } as any;
    delete bad.manifestPath;
    expect(() =>
      validateSourceLock({
        version: SOURCE_LOCK_VERSION,
        generatedAt: "2026-06-09T12:00:00.000Z",
        sources: [bad],
      }),
    ).toThrow(/manifestPath/);
  });

  test("validate rejects entry with missing resolvedAt", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...VALID_ENTRY } as any;
    delete bad.resolvedAt;
    expect(() =>
      validateSourceLock({
        version: SOURCE_LOCK_VERSION,
        generatedAt: "2026-06-09T12:00:00.000Z",
        sources: [bad],
      }),
    ).toThrow(/resolvedAt/);
  });

  test("validate rejects unknown entry fields", () => {
    const bad = { ...VALID_ENTRY, extra: true } as unknown as SourceLockEntry;
    expect(() =>
      validateSourceLock({
        version: SOURCE_LOCK_VERSION,
        generatedAt: "2026-06-09T12:00:00.000Z",
        sources: [bad],
      }),
    ).toThrow(/unexpected.*extra/i);
  });

  test("load throws on missing file", () => {
    expect(() => loadSourceLock(path.join(tmpDir, "no-such.json"))).toThrow();
  });

  test("load throws on invalid JSON", () => {
    fs.writeFileSync(lockPath, "not-json");
    expect(() => loadSourceLock(lockPath)).toThrow();
  });
});

describe("buildSourceLock", () => {
  const MANIFEST_ENTRY: SourceManifestEntry = {
    name: "example-skill",
    source: "https://github.com/example/skills.git",
    ref: "v1.0.0",
    skillPath: "skills/example-skill",
  };

  const MANIFEST: SourceManifest = {
    version: SOURCE_MANIFEST_VERSION,
    sources: [MANIFEST_ENTRY],
  };

  const NOW = "2026-06-14T00:00:00.000Z";

  const RESOLUTION: SourceLockResolution = {
    resolvedCommit: "a".repeat(40),
    manifestPath: "skills/example-skill/SKILL.md",
  };

  test("manifest + resolution map yields a valid SourceLock", () => {
    const lock = buildSourceLock(MANIFEST, { "example-skill": RESOLUTION }, NOW);
    // buildSourceLock validates internally, so the result must round-trip.
    expect(() => validateSourceLock(lock)).not.toThrow();
    expect(lock.version).toBe(SOURCE_LOCK_VERSION);
    expect(lock.generatedAt).toBe(NOW);
    expect(lock.sources).toHaveLength(1);
    expect(lock.sources[0]).toEqual({
      name: "example-skill",
      source: "https://github.com/example/skills.git",
      ref: "v1.0.0",
      resolvedCommit: "a".repeat(40),
      skillPath: "skills/example-skill",
      manifestPath: "skills/example-skill/SKILL.md",
      resolvedAt: NOW,
    });
  });

  test("carries skillPath from manifest when present", () => {
    const lock = buildSourceLock(MANIFEST, { "example-skill": RESOLUTION }, NOW);
    expect(lock.sources[0]!.skillPath).toBe("skills/example-skill");
  });

  test("omits skillPath when manifest entry has none", () => {
    const manifest: SourceManifest = {
      version: SOURCE_MANIFEST_VERSION,
      sources: [
        { name: "example-skill", source: MANIFEST_ENTRY.source, ref: MANIFEST_ENTRY.ref },
      ],
    };
    const lock = buildSourceLock(manifest, { "example-skill": RESOLUTION }, NOW);
    expect(lock.sources[0]!.skillPath).toBeUndefined();
  });

  test("uses injected now for generatedAt and resolvedAt", () => {
    const lock = buildSourceLock(MANIFEST, { "example-skill": RESOLUTION }, NOW);
    expect(lock.generatedAt).toBe(NOW);
    expect(lock.sources[0]!.resolvedAt).toBe(NOW);
  });

  test("throws when a manifest entry has no resolution", () => {
    expect(() => buildSourceLock(MANIFEST, {}, NOW)).toThrow(/example-skill/);
  });

  test("throws when resolution has an invalid resolvedCommit", () => {
    expect(() =>
      buildSourceLock(
        MANIFEST,
        { "example-skill": { ...RESOLUTION, resolvedCommit: "abc" } },
        NOW,
      ),
    ).toThrow(/resolvedCommit/);
  });

  test("throws when resolution has an empty manifestPath", () => {
    expect(() =>
      buildSourceLock(
        MANIFEST,
        { "example-skill": { ...RESOLUTION, manifestPath: "" } },
        NOW,
      ),
    ).toThrow(/manifestPath/);
  });
});
