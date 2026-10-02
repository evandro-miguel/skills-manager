import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashFile } from "../scripts/lib/files.ts";
import { buildReleaseArtifacts, writeReleaseArtifacts, writeReleaseChannel } from "../scripts/modules/skillpool/release-artifacts.ts";
import { resolveSourceLayout } from "../scripts/modules/skillpool/source.ts";
import { verifyReleaseArtifactPolicy } from "../scripts/modules/skillpool/verify-artifacts.ts";

const tempDirs: string[] = [];
const RELEASE_DATE = "2026-06-08T00:00:00.000Z";
const GOOD_SHA = "a".repeat(64);
const GOOD_COMMIT = "b".repeat(40);

function tempRoot(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeSkillpackFixture(): string {
  const root = tempRoot("release-artifacts");
  writeJson(path.join(root, "skillpack.json"), { name: "fixture-pack", version: "0.0.0" });
  writeJson(path.join(root, "profiles", "core.json"), { name: "core", skills: ["alpha"] });
  const skillDir = path.join(root, "skills", "alpha");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: alpha\ndescription: Use when testing release artifact fixtures.\nmetadata: {}\n---\n# Alpha\n"
  );
  fs.writeFileSync(path.join(skillDir, "notes.md"), "fixture note\n");
  return root;
}

function captureConsole(run: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("release artifact smoke contracts", () => {
  test("buildReleaseArtifacts creates deterministic manifest and skill BOM for a skillpack fixture", () => {
    const root = makeSkillpackFixture();

    const artifacts = buildReleaseArtifacts("v1.2.3", {
      sourceRoot: root,
      releaseDate: RELEASE_DATE,
    });

    expect(artifacts.sourceChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(artifacts.manifest.release).toBe("v1.2.3");
    expect(artifacts.manifest.sourceLayout).toEqual({ kind: "skillpack", poolRoot: "." });
    expect(artifacts.manifest.directories.map((entry) => entry.path)).toContain("skills");
    expect(artifacts.manifest.directories.map((entry) => entry.path)).toContain("profiles");
    expect(artifacts.manifest.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifacts.skillBom.skillCount).toBe(1);
    expect(artifacts.skillBom.skills[0]?.skill).toBe("alpha");
    expect(artifacts.skillBom.skills[0]?.files.map((entry) => entry.path)).toContain("skills/alpha/SKILL.md");
    expect(artifacts.skillBom.contentSha256).toMatch(/^[a-f0-9]{64}$/);

    const rebuilt = buildReleaseArtifacts("v1.2.3", {
      sourceRoot: root,
      releaseDate: RELEASE_DATE,
      sourceChecksum: artifacts.sourceChecksum,
    });
    expect(rebuilt.manifest.contentSha256).toBe(artifacts.manifest.contentSha256);
    expect(rebuilt.skillBom.contentSha256).toBe(artifacts.skillBom.contentSha256);
  });

  test("writeReleaseArtifacts writes manifest and BOM under releases and verifier accepts the matching policy", () => {
    const root = makeSkillpackFixture();
    const written = writeReleaseArtifacts("v1.2.3", {
      sourceRoot: root,
      repoRoot: root,
      releaseDate: RELEASE_DATE,
    });
    const layout = resolveSourceLayout(root);

    expect(fs.existsSync(written.manifestFile)).toBe(true);
    expect(fs.existsSync(written.skillBomFile)).toBe(true);
    const output = captureConsole(() =>
      verifyReleaseArtifactPolicy({
        sourceRoot: root,
        layout,
        ref: "v1.2.3",
        policy: {
          requireReleaseManifest: true,
          requireSkillBom: true,
          expectedReleaseManifestSha256: hashFile(written.manifestFile),
          expectedSkillBomSha256: hashFile(written.skillBomFile),
        },
      })
    );

    expect(output).toContain("Verified release manifest:");
    expect(output).toContain("Verified skill BOM:");
  });

  test("verifier is a no-op when artifact policy is inactive but fails closed for missing release tag", () => {
    const root = makeSkillpackFixture();
    const layout = resolveSourceLayout(root);

    expect(() => verifyReleaseArtifactPolicy({ sourceRoot: root, layout, policy: {} })).not.toThrow();
    expect(() =>
      verifyReleaseArtifactPolicy({
        sourceRoot: root,
        layout,
        policy: { requireReleaseManifest: true },
      })
    ).toThrow("requires lockfile ref or policy.releaseTag");
  });

  test("verifier rejects digest mismatch, unsafe policy path, missing files, and tampered content", () => {
    const root = makeSkillpackFixture();
    const written = writeReleaseArtifacts("v1.2.3", {
      sourceRoot: root,
      repoRoot: root,
      releaseDate: RELEASE_DATE,
    });
    const layout = resolveSourceLayout(root);

    expect(() =>
      verifyReleaseArtifactPolicy({
        sourceRoot: root,
        layout,
        ref: "v1.2.3",
        policy: {
          requireReleaseManifest: true,
          expectedReleaseManifestSha256: "f".repeat(64),
        },
      })
    ).toThrow("Release manifest hash mismatch");

    expect(() =>
      verifyReleaseArtifactPolicy({
        sourceRoot: root,
        layout,
        ref: "v1.2.3",
        policy: {
          requireReleaseManifest: true,
          releaseManifestPath: "../outside.json",
        },
      })
    ).toThrow("must stay within pool root");

    expect(() =>
      verifyReleaseArtifactPolicy({
        sourceRoot: root,
        layout,
        ref: "v9.9.9",
        policy: { requireReleaseManifest: true },
      })
    ).toThrow("Release manifest not found");

    const tampered = JSON.parse(fs.readFileSync(written.manifestFile, "utf8"));
    tampered.release = "v9.9.9";
    writeJson(written.manifestFile, tampered);
    expect(() =>
      verifyReleaseArtifactPolicy({
        sourceRoot: root,
        layout,
        ref: "v1.2.3",
        policy: { requireReleaseManifest: true },
      })
    ).toThrow("Release manifest tag mismatch");
  });

  test("verifier rejects skill BOM mismatch and invalid expected hash values", () => {
    const root = makeSkillpackFixture();
    const written = writeReleaseArtifacts("v1.2.3", {
      sourceRoot: root,
      repoRoot: root,
      releaseDate: RELEASE_DATE,
    });
    const layout = resolveSourceLayout(root);

    expect(() =>
      verifyReleaseArtifactPolicy({
        sourceRoot: root,
        layout,
        ref: "v1.2.3",
        policy: {
          requireReleaseManifest: true,
          requireSkillBom: true,
          expectedSkillBomSha256: "not-a-sha",
        },
      })
    ).toThrow("expectedSkillBomSha256");

    const bom = JSON.parse(fs.readFileSync(written.skillBomFile, "utf8"));
    bom.sourceChecksum = crypto.createHash("sha256").update("different").digest("hex");
    writeJson(written.skillBomFile, bom);
    expect(() =>
      verifyReleaseArtifactPolicy({
        sourceRoot: root,
        layout,
        ref: "v1.2.3",
        policy: { requireReleaseManifest: true, requireSkillBom: true },
      })
    ).toThrow("Skill BOM source checksum mismatch");
  });

  test("writeReleaseChannel normalizes valid channels and rejects unsafe release metadata", () => {
    const root = tempRoot("release-channel");

    const written = writeReleaseChannel(
      {
        channel: "stable",
        releaseTag: "1.2.3",
        commit: GOOD_COMMIT,
        sourceSha256: GOOD_SHA.toUpperCase(),
        releaseManifestSha256: GOOD_SHA,
        skillBomSha256: GOOD_SHA,
      },
      { repoRoot: root }
    );

    expect(written.channel.releaseTag).toBe("v1.2.3");
    expect(written.channel.sourceSha256).toBe(GOOD_SHA);
    expect(fs.existsSync(path.join(root, "releases", "channels", "stable.json"))).toBe(true);

    expect(() =>
      writeReleaseChannel(
        {
          channel: "Stable",
          releaseTag: "v1.2.3",
          commit: GOOD_COMMIT,
          sourceSha256: GOOD_SHA,
          releaseManifestSha256: GOOD_SHA,
          skillBomSha256: GOOD_SHA,
        },
        { repoRoot: root }
      )
    ).toThrow("Invalid release channel");
    expect(() =>
      writeReleaseChannel(
        {
          channel: "stable",
          releaseTag: "v1.2",
          commit: GOOD_COMMIT,
          sourceSha256: GOOD_SHA,
          releaseManifestSha256: GOOD_SHA,
          skillBomSha256: GOOD_SHA,
        },
        { repoRoot: root }
      )
    ).toThrow("Invalid release tag");
    expect(() =>
      writeReleaseChannel(
        {
          channel: "stable",
          releaseTag: "v1.2.3",
          commit: "abc",
          sourceSha256: GOOD_SHA,
          releaseManifestSha256: GOOD_SHA,
          skillBomSha256: GOOD_SHA,
        },
        { repoRoot: root }
      )
    ).toThrow("full 40-char git SHA");
    expect(() =>
      writeReleaseChannel(
        {
          channel: "stable",
          releaseTag: "v1.2.3",
          commit: GOOD_COMMIT,
          sourceSha256: GOOD_SHA,
          releaseManifestSha256: GOOD_SHA,
          skillBomSha256: GOOD_SHA,
          policy: { requireSignedTag: false },
        },
        { repoRoot: root }
      )
    ).toThrow("stable must require policy.requireSignedTag=true");
  });
});
