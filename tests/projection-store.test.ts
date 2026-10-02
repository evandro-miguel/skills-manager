import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProjections, validateProjections } from "../scripts/modules/skillpool/projections.ts";
import {
  projectionContentKey,
  projectionStoreEntryPath,
  projectionStoreEntryValid,
  projectionStoreMetaPath,
} from "../scripts/modules/skillpool/projection-store.ts";
import { dirDigest, listFilesRecursive } from "../scripts/lib/files.ts";

const repoRoot = path.resolve(__dirname, "..");

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

function writeSkill(root: string, name: string, description: string): void {
  const skillDir = path.join(root, "skills", name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\nvisibility: user-private\nexport_policy: never\n---\n\n# ${name}\n`,
    "utf8"
  );
}

function defaultRisk(overrides: Partial<Record<string, boolean>> = {}): Record<string, boolean> {
  return {
    readsFiles: false,
    writesProject: false,
    writesGlobal: false,
    executesShell: false,
    networkAccess: false,
    externalDirectory: false,
    credentialSensitive: false,
    destructive: false,
    browserAuthState: false,
    repoMutation: false,
    ...overrides,
  };
}

function writeSkillWithMeta(
  root: string,
  name: string,
  description: string,
  risk: Record<string, boolean>,
  invocation: { implicitAllowed: boolean; manualOnly: boolean; requiresConfirmation: boolean }
): void {
  writeSkill(root, name, description);
  const skillDir = path.join(root, "skills", name);
  fs.writeFileSync(
    path.join(skillDir, "skill.meta.json"),
    `${JSON.stringify(
      {
        name,
        version: "1.0.0",
        contractVersion: "1.0",
        lifecycle: "active",
        risk,
        invocation,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function createFixtureSource(): string {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-store-source-"));
  fs.mkdirSync(path.join(sourceRoot, "adapters"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "profiles"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "providers"), path.join(sourceRoot, "providers"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, "skillpack.json"),
    `${JSON.stringify(
      {
        name: "projection-store-fixture",
        version: "1.0.0",
        providers: ["codex"],
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeSkillWithMeta(sourceRoot, "alpha", "Use when testing projection store hits.", defaultRisk(), {
    implicitAllowed: true,
    manualOnly: false,
    requiresConfirmation: false,
  });
  writeSkillWithMeta(sourceRoot, "beta", "Use when testing projection store invalidation.", defaultRisk(), {
    implicitAllowed: true,
    manualOnly: false,
    requiresConfirmation: false,
  });
  return sourceRoot;
}

function storeEntryDirs(skillpoolHome: string, provider: string): string[] {
  const providerDir = path.join(skillpoolHome, "projection-store", "v1", provider);
  if (!fs.existsSync(providerDir)) {
    return [];
  }
  return fs
    .readdirSync(providerDir)
    .filter((name) => !name.startsWith(".tmp-") && fs.statSync(path.join(providerDir, name)).isDirectory())
    .sort((a, b) => a.localeCompare(b));
}

describe("content-addressable projection store", () => {
  test("an explicit project-scoped store never writes to the global Skillpool home", () => {
    withTempDir("projection-store-scoped-", (root) => {
      const globalSkillpoolHome = path.join(root, "global-skillpool");
      const projectStoreDir = path.join(root, "project", ".tmp", "projection-store");
      const sourceRoot = createFixtureSource();
      const outDir = path.join(root, "out");
      try {
        withSkillpoolHome(globalSkillpoolHome, () => {
          const result = buildProjections({
            sourceRoot,
            providers: ["codex"],
            outDir,
            clean: true,
            projectionStoreDir: projectStoreDir,
          });
          expect(result.manifest.cache.rebuiltCount).toBe(2);
          expect(fs.existsSync(path.join(globalSkillpoolHome, "projection-store"))).toBe(false);
          expect(fs.readdirSync(path.join(projectStoreDir, "v1", "codex"))).toHaveLength(4);
        });
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test("an explicit store must not overlap projection output", () => {
    withTempDir("projection-store-overlap-", (root) => {
      const sourceRoot = createFixtureSource();
      const outDir = path.join(root, "out");
      try {
        expect(() =>
          buildProjections({
            sourceRoot,
            providers: ["codex"],
            outDir,
            clean: true,
            projectionStoreDir: path.join(outDir, "store"),
          })
        ).toThrow(/projection store.*must not overlap.*output/i);
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test("clean rebuild restores every projection from the store with identical digests", () => {
    withTempDir("projection-store-clean-", (root) => {
      const skillpoolHome = path.join(root, "skillpool");
      const sourceRoot = createFixtureSource();
      const outDir1 = path.join(root, "out1");
      const outDir2 = path.join(root, "out2");
      try {
        withSkillpoolHome(skillpoolHome, () => {
          const first = buildProjections({ sourceRoot, providers: ["codex"], outDir: outDir1, clean: true });
          expect(first.manifest.cache.storeHitCount).toBe(0);
          expect(first.manifest.cache.rebuiltCount).toBe(2);
          expect(storeEntryDirs(skillpoolHome, "codex")).toHaveLength(2);
          const firstDigests = first.projections.map((projection) => projection.projectionDigest).sort();

          const second = buildProjections({ sourceRoot, providers: ["codex"], outDir: outDir2, clean: true });
          expect(second.manifest.cache.storeHitCount).toBe(2);
          expect(second.manifest.cache.rebuiltCount).toBe(0);
          expect(second.manifest.cache.cachedCount).toBe(0);
          expect(second.projections.map((projection) => projection.projectionDigest).sort()).toEqual(firstDigests);

          // Byte-identical output contract: restored projections must equal
          // freshly rendered ones.
          for (const skillName of ["alpha", "beta"]) {
            const fresh = fs.readFileSync(path.join(outDir1, "codex", skillName, "SKILL.md"), "utf8");
            const restored = fs.readFileSync(path.join(outDir2, "codex", skillName, "SKILL.md"), "utf8");
            expect(restored).toBe(fresh);
          }
          const onDiskManifest = readJson<{ cache: { storeHitCount: number } }>(second.manifestPath);
          expect(onDiskManifest.cache.storeHitCount).toBe(2);
          expect(validateProjections({ sourceRoot, providers: ["codex"], outDir: outDir2 })).toEqual([]);
        });
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test("mutating one skill rebuilds only that projection", () => {
    withTempDir("projection-store-mutate-", (root) => {
      const skillpoolHome = path.join(root, "skillpool");
      const sourceRoot = createFixtureSource();
      const outDir = path.join(root, "out");
      try {
        withSkillpoolHome(skillpoolHome, () => {
          const first = buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
          const firstBetaDigest = first.projections.find((projection) => projection.skill === "beta")?.projectionDigest;
          const firstAlphaDigest = first.projections.find((projection) => projection.skill === "alpha")?.projectionDigest;

          fs.writeFileSync(path.join(sourceRoot, "skills", "beta", "SKILL.md"), "# Beta v2\n", "utf8");

          const second = buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
          expect(second.manifest.cache.storeHitCount).toBe(1); // alpha unchanged -> store hit
          expect(second.manifest.cache.rebuiltCount).toBe(1); // beta mutated -> rebuilt
          const secondBeta = second.projections.find((projection) => projection.skill === "beta");
          const secondAlpha = second.projections.find((projection) => projection.skill === "alpha");
          expect(secondBeta?.projectionDigest).not.toBe(firstBetaDigest);
          expect(secondAlpha?.projectionDigest).toBe(firstAlphaDigest);
          expect(validateProjections({ sourceRoot, providers: ["codex"], outDir })).toEqual([]);
        });
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test("user-origin projections are never written to the store", () => {
    withTempDir("projection-store-privacy-", (root) => {
      const skillpoolHome = path.join(root, "skillpool");
      const sourceRoot = createFixtureSource();
      const userRoot = path.join(root, "user-root");
      const outDir = path.join(root, "out");
      try {
        writeSkill(userRoot, "private-note", "Use when testing store privacy for user skills.");
        withSkillpoolHome(skillpoolHome, () => {
          const result = buildProjections({
            sourceRoot,
            providers: ["codex"],
            outDir,
            clean: true,
            userRoot,
            includeUser: true,
          });
          expect(result.projections.map((projection) => projection.skill).sort()).toEqual([
            "alpha",
            "beta",
            "private-note",
          ]);

          // Only public-origin entries are stored: one per public skill.
          expect(storeEntryDirs(skillpoolHome, "codex")).toHaveLength(2);

          // The user skill's would-be content key must not exist as an entry.
          const userSkillDir = path.join(userRoot, "skills", "private-note");
          const userKey = projectionContentKey("codex", "user", dirDigest(userSkillDir), false);
          expect(fs.existsSync(projectionStoreEntryPath("codex", userKey))).toBe(false);

          // A second clean build must still rebuild the user projection (never
          // a store read), while public ones store-hit.
          const second = buildProjections({
            sourceRoot,
            providers: ["codex"],
            outDir,
            clean: true,
            userRoot,
            includeUser: true,
          });
          expect(second.manifest.cache.storeHitCount).toBe(2);
          expect(second.manifest.cache.rebuiltCount).toBe(1); // private-note rebuilt every time
          expect(
            validateProjections({ sourceRoot, providers: ["codex"], outDir, userRoot, includeUser: true })
          ).toEqual([]);
        });
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test("corrupted store entry falls back to a full rebuild without error", () => {
    withTempDir("projection-store-corrupt-", (root) => {
      const skillpoolHome = path.join(root, "skillpool");
      const sourceRoot = createFixtureSource();
      const outDir = path.join(root, "out");
      try {
        withSkillpoolHome(skillpoolHome, () => {
          buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
          const entryDirs = storeEntryDirs(skillpoolHome, "codex");
          expect(entryDirs).toHaveLength(2);

          // Delete a file inside one store entry to corrupt it.
          const providerDir = path.join(skillpoolHome, "projection-store", "v1", "codex");
          fs.rmSync(path.join(providerDir, entryDirs[0]!, "SKILL.md"), { force: true });

          const result = buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
          expect(result.manifest.cache.storeHitCount).toBe(1); // intact entry still hits
          expect(result.manifest.cache.rebuiltCount).toBe(1); // corrupted entry rebuilt
          expect(validateProjections({ sourceRoot, providers: ["codex"], outDir })).toEqual([]);
        });
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test("store entry tampered under a default-skipped directory name is invalid and rebuilds", () => {
    withTempDir("projection-store-tamper-skip-name-", (root) => {
      const skillpoolHome = path.join(root, "skillpool");
      const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-store-tamper-source-"));
      const outDir = path.join(root, "out");
      try {
        // Single-skill public source: after publish, tamper the store payload
        // with extra content under a name the lib/files DEFAULT skip set would
        // ignore (node_modules). The store digest must still see it, so the
        // entry is rejected instead of being restored.
        fs.mkdirSync(path.join(sourceRoot, "adapters"), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, "profiles"), { recursive: true });
        fs.cpSync(path.join(repoRoot, "providers"), path.join(sourceRoot, "providers"), { recursive: true });
        fs.writeFileSync(
          path.join(sourceRoot, "skillpack.json"),
          `${JSON.stringify(
            { name: "projection-store-tamper-fixture", version: "1.0.0", providers: ["codex"] },
            null,
            2
          )}\n`,
          "utf8"
        );
        writeSkillWithMeta(sourceRoot, "alpha", "Use when testing store tamper detection.", defaultRisk(), {
          implicitAllowed: true,
          manualOnly: false,
          requiresConfirmation: false,
        });

        withSkillpoolHome(skillpoolHome, () => {
          const first = buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
          expect(first.manifest.cache.storeHitCount).toBe(0);
          expect(first.manifest.cache.rebuiltCount).toBe(1);
          const entryDirs = storeEntryDirs(skillpoolHome, "codex");
          expect(entryDirs).toHaveLength(1);

          // Tamper: drop extra content under a default-skipped directory name.
          const alphaKey = projectionContentKey(
            "codex",
            "public",
            dirDigest(path.join(sourceRoot, "skills", "alpha")),
            false
          );
          const tamperedEntryDir = projectionStoreEntryPath("codex", alphaKey);
          expect(entryDirs).toContain(alphaKey);
          fs.mkdirSync(path.join(tamperedEntryDir, "node_modules"), { recursive: true });
          fs.writeFileSync(path.join(tamperedEntryDir, "node_modules", "evil.txt"), "tampered\n", "utf8");

          // The extra payload content is part of the store digest -> invalid.
          expect(projectionStoreEntryValid(tamperedEntryDir, alphaKey)).toBe(false);

          const second = buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
          // Tampered entry rejected -> no store hit, full rebuild fallback.
          expect(second.manifest.cache.storeHitCount).toBe(0);
          expect(second.manifest.cache.rebuiltCount).toBe(1);
          expect(validateProjections({ sourceRoot, providers: ["codex"], outDir })).toEqual([]);

          // The rebuilt output must not contain the tampered content.
          expect(fs.existsSync(path.join(outDir, "codex", "alpha", "node_modules", "evil.txt"))).toBe(false);
        });
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test("foreign entry with mismatched metadata is rejected and never clobbered", () => {
    withTempDir("projection-store-foreign-", (root) => {
      const skillpoolHome = path.join(root, "skillpool");
      const sourceRoot = createFixtureSource();
      const outDir = path.join(root, "out");
      try {
        withSkillpoolHome(skillpoolHome, () => {
          buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
          const entryDirs = storeEntryDirs(skillpoolHome, "codex");
          expect(entryDirs).toHaveLength(2);

          // Rewrite one entry's sibling metadata so it claims a different
          // content key than the directory it lives in. The content digest
          // lives in the sibling metadata file (outside the payload dir), so
          // it still matches the payload; only the content-key verification
          // can reject it (a simulated collision / foreign entry).
          const providerDir = path.join(skillpoolHome, "projection-store", "v1", "codex");
          const foreignEntryDir = path.join(providerDir, entryDirs[0]!);
          const metaPath = projectionStoreMetaPath(foreignEntryDir);
          const originalMeta = readJson<Record<string, unknown>>(metaPath);
          const originalSkillMd = fs.readFileSync(path.join(foreignEntryDir, "SKILL.md"), "utf8");
          fs.writeFileSync(
            metaPath,
            `${JSON.stringify({ ...originalMeta, contentKey: "f".repeat(64) }, null, 2)}\n`,
            "utf8"
          );

          const result = buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
          // The foreign entry is rejected -> that skill is rebuilt from source;
          // the other skill's intact entry still store-hits.
          expect(result.manifest.cache.storeHitCount).toBe(1);
          expect(result.manifest.cache.rebuiltCount).toBe(1);
          expect(validateProjections({ sourceRoot, providers: ["codex"], outDir })).toEqual([]);

          // No clobber: the foreign entry keeps its content and its mismatched
          // metadata. The rebuild write refuses to overwrite the existing
          // directory, so a colliding entry can never displace real content.
          const foreignMeta = readJson<Record<string, unknown>>(metaPath);
          expect(foreignMeta.contentKey).toBe("f".repeat(64));
          expect(fs.readFileSync(path.join(foreignEntryDir, "SKILL.md"), "utf8")).toBe(originalSkillMd);
        });
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test("a foreign EMPTY entry dir is never clobbered by a rebuild", () => {
    withTempDir("projection-store-foreign-empty-", (root) => {
      const skillpoolHome = path.join(root, "skillpool");
      const sourceRoot = createFixtureSource();
      const outDir = path.join(root, "out");
      try {
        withSkillpoolHome(skillpoolHome, () => {
          buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });

          // Compute alpha's content key and verify it names one store entry,
          // then replace that entry with a foreign EMPTY directory. On POSIX a
          // plain rename would silently replace an empty dir; the exclusive
          // mkdir reservation must prevent that clobber.
          const alphaKey = projectionContentKey(
            "codex",
            "public",
            dirDigest(path.join(sourceRoot, "skills", "alpha")),
            false
          );
          const providerDir = path.join(skillpoolHome, "projection-store", "v1", "codex");
          const entryDirs = storeEntryDirs(skillpoolHome, "codex");
          expect(entryDirs).toContain(alphaKey);
          const foreignEmptyDir = path.join(providerDir, alphaKey);
          fs.rmSync(foreignEmptyDir, { recursive: true, force: true });
          fs.rmSync(projectionStoreMetaPath(foreignEmptyDir), { force: true });
          fs.mkdirSync(foreignEmptyDir, { recursive: true });
          expect(fs.readdirSync(foreignEmptyDir)).toHaveLength(0);
          expect(fs.existsSync(projectionStoreMetaPath(foreignEmptyDir))).toBe(false);

          const result = buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
          // The empty foreign dir occupies alpha's key -> no store hit for it,
          // so alpha is rebuilt from source (publishes into outDir, not the
          // store); beta's intact entry still store-hits.
          expect(result.manifest.cache.storeHitCount).toBe(1);
          expect(result.manifest.cache.rebuiltCount).toBe(1);
          expect(validateProjections({ sourceRoot, providers: ["codex"], outDir })).toEqual([]);

          // No clobber: the foreign empty dir still exists, is still empty,
          // and no metadata was written next to it.
          expect(fs.existsSync(foreignEmptyDir)).toBe(true);
          expect(fs.readdirSync(foreignEmptyDir)).toHaveLength(0);
          expect(fs.existsSync(projectionStoreMetaPath(foreignEmptyDir))).toBe(false);
        });
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test("skill content literally named .store-digest survives a store round-trip byte-identically", () => {
    withTempDir("projection-store-reserved-name-", (root) => {
      const skillpoolHome = path.join(root, "skillpool");
      const sourceRoot = createFixtureSource();
      const outDir1 = path.join(root, "out1");
      const outDir2 = path.join(root, "out2");
      try {
        // Real skill content that happens to use a name the old store design
        // reserved for its own sidecars, nested one level deep.
        const digestContent = "real skill content, not a store sidecar\n";
        fs.mkdirSync(path.join(sourceRoot, "skills", "alpha", "assets"), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, "skills", "alpha", "assets", ".store-digest"), digestContent, "utf8");

        withSkillpoolHome(skillpoolHome, () => {
          const first = buildProjections({ sourceRoot, providers: ["codex"], outDir: outDir1, clean: true });
          expect(first.manifest.cache.storeHitCount).toBe(0);
          // The payload dir keeps the nested file: no reserved names inside.
          const firstNested = fs.readFileSync(path.join(outDir1, "codex", "alpha", "assets", ".store-digest"), "utf8");
          expect(firstNested).toBe(digestContent);

          const second = buildProjections({ sourceRoot, providers: ["codex"], outDir: outDir2, clean: true });
          expect(second.manifest.cache.storeHitCount).toBe(2);
          // Byte-identical after restore: the nested file was neither excluded
          // on write nor on read.
          const restoredNested = fs.readFileSync(
            path.join(outDir2, "codex", "alpha", "assets", ".store-digest"),
            "utf8"
          );
          expect(restoredNested).toBe(digestContent);
          expect(
            fs.readFileSync(path.join(outDir2, "codex", "alpha", "SKILL.md"), "utf8")
          ).toBe(fs.readFileSync(path.join(outDir1, "codex", "alpha", "SKILL.md"), "utf8"));
          expect(validateProjections({ sourceRoot, providers: ["codex"], outDir: outDir2 })).toEqual([]);
        });
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test("payload dirs contain no projection.meta.json and no store sidecars; sibling meta present", () => {
    withTempDir("projection-store-clean-payload-", (root) => {
      const skillpoolHome = path.join(root, "skillpool");
      const sourceRoot = createFixtureSource();
      const outDir = path.join(root, "out");
      try {
        withSkillpoolHome(skillpoolHome, () => {
          buildProjections({ sourceRoot, providers: ["codex"], outDir, clean: true });
          const providerDir = path.join(skillpoolHome, "projection-store", "v1", "codex");
          const entryDirs = storeEntryDirs(skillpoolHome, "codex");
          expect(entryDirs).toHaveLength(2);
          for (const entryName of entryDirs) {
            const entryDir = path.join(providerDir, entryName);
            // Payload contains rendered content and nothing store-owned.
            const payloadFiles = listFilesRecursive(entryDir).map((filePath) => path.basename(filePath));
            expect(payloadFiles).toContain("SKILL.md");
            expect(payloadFiles).not.toContain("projection.meta.json");
            for (const filePath of listFilesRecursive(entryDir)) {
              const base = path.basename(filePath);
              expect(base.startsWith(".store-")).toBe(false);
            }
            // Sibling metadata file exists per entry with the full record.
            const meta = readJson<Record<string, unknown>>(projectionStoreMetaPath(entryDir));
            for (const field of [
              "schemaVersion",
              "rendererVersion",
              "provider",
              "origin",
              "canonicalDigest",
              "manualOnly",
              "contentKey",
              "digest",
            ]) {
              expect(meta[field]).toBeDefined();
            }
            expect(typeof meta.contentKey).toBe("string");
            expect(/^[a-f0-9]{64}$/i.test(meta.contentKey as string)).toBe(true);
            expect(typeof meta.digest).toBe("string");
            expect(/^[a-f0-9]{64}$/i.test(meta.digest as string)).toBe(true);
          }
        });
      } finally {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test("store-hit manifest passes validate-projections with zero findings", () => {
    withTempDir("projection-store-validate-", (root) => {
      const skillpoolHome = path.join(root, "skillpool");
      const sourceRoot = path.join(repoRoot, "examples", "minimal-skillpack");
      const providers = ["codex", "opencode"] as const;
      const outDir = path.join(root, "out");
      try {
        withSkillpoolHome(skillpoolHome, () => {
          buildProjections({ sourceRoot, providers: [...providers], outDir, clean: true });
          const hit = buildProjections({ sourceRoot, providers: [...providers], outDir, clean: true });
          expect(hit.manifest.cache.storeHitCount).toBe(2);
          expect(hit.manifest.cache.rebuiltCount).toBe(0);
          expect(validateProjections({ sourceRoot, providers: [...providers], outDir })).toEqual([]);
        });
      } finally {
        // No fixture source to clean up; sourceRoot lives inside the repo.
      }
    });
  });
});
