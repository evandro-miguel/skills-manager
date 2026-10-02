import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProjections, validateProjections } from "../scripts/modules/skillpool/projections.ts";
import { parseProviderListForSource } from "../scripts/modules/skillpool/providers.ts";

const repoRoot = path.resolve(__dirname, "..");

type JsonRecord = Record<string, unknown>;

function withTempDir<T>(prefix: string, callback: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withSkillpoolHome<T>(skillpoolHome: string, callback: () => T): T {
  const previousSkillpoolHome = process.env.SKILLPOOL_HOME;
  process.env.SKILLPOOL_HOME = skillpoolHome;
  try {
    return callback();
  } finally {
    if (previousSkillpoolHome === undefined) {
      delete process.env.SKILLPOOL_HOME;
    } else {
      process.env.SKILLPOOL_HOME = previousSkillpoolHome;
    }
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function stableManifestShape(manifest: JsonRecord): JsonRecord {
  const projections = manifest.projections as JsonRecord[];
  return {
    schemaVersion: manifest.schemaVersion,
    rendererVersion: manifest.rendererVersion,
    providers: manifest.providers,
    origins: manifest.origins,
    projectionCount: manifest.projectionCount,
    cache: manifest.cache,
    projectionKeys: projections.map((record) => ({
      provider: record.provider,
      skill: record.skill,
      origin: record.origin,
      canonicalPath: record.canonicalPath,
      projectionPath: record.projectionPath,
      rendererVersion: record.rendererVersion,
      manualOnly: record.manualOnly,
    })),
  };
}

describe("projection refactor characterization", () => {
  test("clean and cached projection manifests preserve output shape and validation contract", () => {
    const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
    const providers = parseProviderListForSource("all", sourceRoot);

    withTempDir("projection-refactor-characterization-", (outDir) => {
      const skillpoolHome = fs.mkdtempSync(path.join(os.tmpdir(), "projection-refactor-skillpool-"));
      try {
        withSkillpoolHome(skillpoolHome, () => {
          const fresh = buildProjections({ sourceRoot, providers, outDir, clean: true });
          const freshManifest = readJson<JsonRecord>(fresh.manifestPath);

          expect(stableManifestShape(freshManifest)).toEqual({
            schemaVersion: 1,
            rendererVersion: 1,
            providers: ["codex", "opencode"],
            origins: ["public"],
            projectionCount: 2,
            cache: { cachedCount: 0, rebuiltCount: 2, storeHitCount: 0 },
            projectionKeys: [
              {
                provider: "codex",
                skill: "example-skill",
                origin: "public",
                canonicalPath: "skills/example-skill",
                projectionPath: "codex/example-skill",
                rendererVersion: 1,
                manualOnly: false,
              },
              {
                provider: "opencode",
                skill: "example-skill",
                origin: "public",
                canonicalPath: "skills/example-skill",
                projectionPath: "opencode/example-skill",
                rendererVersion: 1,
                manualOnly: false,
              },
            ],
          });
          expect(JSON.stringify(fresh.manifest)).toBe(JSON.stringify(freshManifest));
          expect(validateProjections({ sourceRoot, providers, outDir })).toEqual([]);

          const cached = buildProjections({ sourceRoot, providers, outDir, clean: false });
          const cachedManifest = readJson<JsonRecord>(cached.manifestPath);

          expect(stableManifestShape(cachedManifest)).toEqual({
            schemaVersion: 1,
            rendererVersion: 1,
            providers: ["codex", "opencode"],
            origins: ["public"],
            projectionCount: 2,
            cache: { cachedCount: 2, rebuiltCount: 0, storeHitCount: 0 },
            projectionKeys: [
              {
                provider: "codex",
                skill: "example-skill",
                origin: "public",
                canonicalPath: "skills/example-skill",
                projectionPath: "codex/example-skill",
                rendererVersion: 1,
                manualOnly: false,
              },
              {
                provider: "opencode",
                skill: "example-skill",
                origin: "public",
                canonicalPath: "skills/example-skill",
                projectionPath: "opencode/example-skill",
                rendererVersion: 1,
                manualOnly: false,
              },
            ],
          });
          expect(JSON.stringify(cached.manifest)).toBe(JSON.stringify(cachedManifest));
          expect(cached.projections.every((record) => record.cached === true)).toBe(true);
          expect(validateProjections({ sourceRoot, providers, outDir })).toEqual([]);
        });
      } finally {
        fs.rmSync(skillpoolHome, { recursive: true, force: true });
      }
    });
  });
});
