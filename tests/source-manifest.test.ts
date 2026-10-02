import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type SourceManifestEntry,
  type SourceManifest,
  validateSourceManifest,
  loadSourceManifest,
  writeSourceManifest,
  findDuplicateSkills,
  SOURCE_MANIFEST_VERSION,
} from "../scripts/modules/skill-sys/source-manifest.ts";

const VALID_ENTRY: SourceManifestEntry = {
  name: "example-skill",
  source: "https://github.com/example/skills.git",
  ref: "v1.0.0",
  skillPath: "skills/example-skill",
};

const VALID_MANIFEST: SourceManifest = {
  version: SOURCE_MANIFEST_VERSION,
  sources: [VALID_ENTRY],
};

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "source-manifest-test-"));
}

describe("source manifest", () => {
  let tmpDir: string;
  let manifestPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    manifestPath = path.join(tmpDir, "skill-sys.sources.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("write and load round trip preserves structure", () => {
    writeSourceManifest(manifestPath, VALID_MANIFEST);
    const loaded = loadSourceManifest(manifestPath);
    expect(loaded).toEqual(VALID_MANIFEST);
  });

  test("write produces deterministic key ordering", () => {
    writeSourceManifest(manifestPath, VALID_MANIFEST);
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw);

    // Top-level keys: version before sources
    const topKeys = Object.keys(parsed);
    expect(topKeys.indexOf("version")).toBeLessThan(topKeys.indexOf("sources"));

    // Entry keys: name, source, ref, skillPath
    const entryKeys = Object.keys(parsed.sources[0]);
    expect(entryKeys).toEqual(["name", "source", "ref", "skillPath"]);
  });

  test("round trip is byte-identical for same data", () => {
    writeSourceManifest(manifestPath, VALID_MANIFEST);
    const first = fs.readFileSync(manifestPath, "utf8");

    const loaded = loadSourceManifest(manifestPath);
    writeSourceManifest(manifestPath, loaded);
    const second = fs.readFileSync(manifestPath, "utf8");

    expect(second).toBe(first);
  });

  test("validate accepts a valid manifest", () => {
    expect(() => validateSourceManifest(VALID_MANIFEST)).not.toThrow();
  });

  test("validate rejects unknown version", () => {
    const manifest = { ...VALID_MANIFEST, version: 99 };
    expect(() => validateSourceManifest(manifest)).toThrow(/version/);
  });

  test("validate rejects missing version", () => {
    const { version: _, ...noVersion } = VALID_MANIFEST;
    expect(() => validateSourceManifest(noVersion)).toThrow(/version/);
  });

  test("validate rejects missing sources array", () => {
    const { sources: _, ...noSources } = VALID_MANIFEST;
    expect(() => validateSourceManifest(noSources)).toThrow(/sources/);
  });

  test("validate rejects empty sources array", () => {
    expect(() => validateSourceManifest({ version: SOURCE_MANIFEST_VERSION, sources: [] })).toThrow(
      /sources/,
    );
  });

  test("validate rejects entry with missing name", () => {
    const entry = { ...VALID_ENTRY };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...entry } as any;
    delete bad.name;
    expect(() =>
      validateSourceManifest({ version: SOURCE_MANIFEST_VERSION, sources: [bad] }),
    ).toThrow(/name/);
  });

  test("validate rejects entry with missing source", () => {
    const entry = { ...VALID_ENTRY };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...entry } as any;
    delete bad.source;
    expect(() =>
      validateSourceManifest({ version: SOURCE_MANIFEST_VERSION, sources: [bad] }),
    ).toThrow(/source/);
  });

  test("validate rejects entry with missing ref", () => {
    const entry = { ...VALID_ENTRY };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...entry } as any;
    delete bad.ref;
    expect(() =>
      validateSourceManifest({ version: SOURCE_MANIFEST_VERSION, sources: [bad] }),
    ).toThrow(/ref/);
  });

  test("validate accepts entry without skillPath", () => {
    const entry: SourceManifestEntry = {
      name: "example-skill",
      source: "https://github.com/example/skills.git",
      ref: "v1.0.0",
    };
    expect(() =>
      validateSourceManifest({ version: SOURCE_MANIFEST_VERSION, sources: [entry] }),
    ).not.toThrow();
  });

  test("validate rejects unknown entry fields", () => {
    const bad = { ...VALID_ENTRY, extra: true } as unknown as SourceManifestEntry;
    expect(() =>
      validateSourceManifest({ version: SOURCE_MANIFEST_VERSION, sources: [bad] }),
    ).toThrow(/unexpected.*extra/i);
  });

  test("findDuplicateSkills returns empty for unique names", () => {
    const manifest: SourceManifest = {
      version: SOURCE_MANIFEST_VERSION,
      sources: [
        { name: "skill-a", source: "https://github.com/a.git", ref: "v1" },
        { name: "skill-b", source: "https://github.com/b.git", ref: "v2" },
      ],
    };
    expect(findDuplicateSkills(manifest)).toEqual([]);
  });

  test("findDuplicateSkills detects duplicate names", () => {
    const manifest: SourceManifest = {
      version: SOURCE_MANIFEST_VERSION,
      sources: [
        { name: "dup-skill", source: "https://github.com/a.git", ref: "v1" },
        { name: "dup-skill", source: "https://github.com/b.git", ref: "v2" },
      ],
    };
    const dupes = findDuplicateSkills(manifest);
    expect(dupes).toEqual(["dup-skill"]);
  });

  test("load throws on missing file", () => {
    expect(() => loadSourceManifest(path.join(tmpDir, "no-such.json"))).toThrow();
  });

  test("load throws on invalid JSON", () => {
    fs.writeFileSync(manifestPath, "not-json");
    expect(() => loadSourceManifest(manifestPath)).toThrow();
  });
});
