#!/usr/bin/env bun

import path from "node:path";
import { fileExists, hashFile, readJson } from "../../lib/files.ts";
import { buildReleaseArtifacts } from "./release-artifacts.ts";
import { collectPublicSurfacePacklist } from "./public-surface.ts";
import { computeSourceChecksum, resolvePoolRoot, resolveSourceLayout } from "./source.ts";

interface ArtifactPolicy {
  requireReleaseManifest?: unknown;
  releaseTag?: unknown;
  releaseManifestPath?: unknown;
  expectedReleaseManifestSha256?: unknown;
  requireSkillBom?: unknown;
  skillBomPath?: unknown;
  expectedSkillBomSha256?: unknown;
}

interface VerifyReleaseArtifactsOptions {
  sourceRoot: string;
  layout: ReturnType<typeof resolveSourceLayout>;
  ref?: unknown;
  policy: ArtifactPolicy;
}

interface ArtifactSurfaceDigestShape {
  surface?: unknown;
  fileCount?: unknown;
  totalBytes?: unknown;
  digest?: unknown;
}

interface ReleaseManifestShape {
  release?: unknown;
  releaseDate?: unknown;
  sourceChecksum?: unknown;
  artifactSurface?: unknown;
  contentSha256?: unknown;
}

interface SkillBomShape {
  release?: unknown;
  releaseDate?: unknown;
  sourceChecksum?: unknown;
  artifactSurface?: unknown;
  contentSha256?: unknown;
}

function isArtifactPolicyActive(policy: ArtifactPolicy): boolean {
  return Boolean(
    policy.requireReleaseManifest ||
      policy.expectedReleaseManifestSha256 ||
      policy.requireSkillBom ||
      policy.expectedSkillBomSha256
  );
}

function toExpectedHex(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a 64-character SHA-256 hex string`);
  }
  return value.toLowerCase();
}

function resolveReleaseTag(policy: ArtifactPolicy, ref: unknown): string {
  const raw = policy.releaseTag || ref;
  if (!raw || typeof raw !== "string") {
    throw new Error("Release artifact verification requires lockfile ref or policy.releaseTag");
  }
  return raw;
}

function assertPathWithin(basePath: string, candidatePath: string, label: string): void {
  const relative = path.relative(basePath, candidatePath);
  if (relative === "" || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay within pool root: ${candidatePath}`);
  }
}

function resolvePolicyPath(
  poolRoot: string,
  value: unknown,
  fallback: string,
  label: string
): string {
  const relativePath = value === undefined || value === null || value === "" ? fallback : value;
  if (typeof relativePath !== "string") {
    throw new Error(`${label} must be a relative path string`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative path string`);
  }
  const candidate = path.resolve(poolRoot, relativePath);
  assertPathWithin(poolRoot, candidate, label);
  return candidate;
}

function verifyExpectedFileHash(filePath: string, expectedHash: string | null, label: string): void {
  if (!expectedHash) {
    return;
  }
  const actualHash = hashFile(filePath).toLowerCase();
  if (actualHash !== expectedHash) {
    throw new Error(`${label} hash mismatch. expected=${expectedHash} actual=${actualHash}`);
  }
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

function parseArtifactSurfaceDigest(
  value: unknown,
  label: string
): ArtifactSurfaceDigestShape | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${label} is invalid`);
  }
  const digest = value as ArtifactSurfaceDigestShape;
  asString(digest.surface, `${label}.surface`);
  asString(digest.digest, `${label}.digest`);
  if (!/^[a-f0-9]{64}$/i.test(String(digest.digest))) {
    throw new Error(`${label}.digest must be a 64-character SHA-256 hex string`);
  }
  if (!Number.isInteger(digest.fileCount) || Number(digest.fileCount) < 0) {
    throw new Error(`${label}.fileCount is invalid`);
  }
  if (!Number.isInteger(digest.totalBytes) || Number(digest.totalBytes) < 0) {
    throw new Error(`${label}.totalBytes is invalid`);
  }
  return digest;
}

function verifyArtifactSurfaceDigest(
  sourceRoot: string,
  expected: ArtifactSurfaceDigestShape | null,
  label: string
): void {
  if (!expected) {
    return;
  }
  const surface = String(expected.surface);
  const actual = collectPublicSurfacePacklist(sourceRoot, surface);
  if (actual.digest !== String(expected.digest).toLowerCase()) {
    throw new Error(
      `${label} artifact surface digest mismatch. expected=${expected.digest} actual=${actual.digest}`
    );
  }
  if (actual.fileCount !== expected.fileCount) {
    throw new Error(
      `${label} artifact surface file count mismatch. expected=${expected.fileCount} actual=${actual.fileCount}`
    );
  }
  if (actual.totalBytes !== expected.totalBytes) {
    throw new Error(
      `${label} artifact surface byte count mismatch. expected=${expected.totalBytes} actual=${actual.totalBytes}`
    );
  }
}

function verifyReleaseManifest(
  sourceRoot: string,
  manifestPath: string,
  releaseTag: string,
  expectedHash: string | null
): ReleaseManifestShape {
  if (!fileExists(manifestPath)) {
    throw new Error(`Release manifest not found: ${manifestPath}`);
  }
  verifyExpectedFileHash(manifestPath, expectedHash, "Release manifest");

  const manifest = readJson<ReleaseManifestShape>(manifestPath);
  const release = asString(manifest.release, "Release manifest release");
  const releaseDate = asString(manifest.releaseDate, "Release manifest releaseDate");
  const sourceChecksum = asString(manifest.sourceChecksum, "Release manifest sourceChecksum");
  if (release !== releaseTag) {
    throw new Error(`Release manifest tag mismatch. expected=${releaseTag} actual=${release}`);
  }

  const artifactSurface = parseArtifactSurfaceDigest(manifest.artifactSurface, "Release manifest artifactSurface");
  verifyArtifactSurfaceDigest(sourceRoot, artifactSurface, "Release manifest");
  const rebuilt = buildReleaseArtifacts(releaseTag, {
    sourceRoot,
    releaseDate,
    sourceChecksum,
    artifactSurface: artifactSurface ? String(artifactSurface.surface) : null,
  });
  if (manifest.contentSha256 !== rebuilt.manifest.contentSha256) {
    throw new Error(
      `Release manifest content mismatch. expected=${rebuilt.manifest.contentSha256} actual=${manifest.contentSha256}`
    );
  }
  return manifest;
}

function sameArtifactSurfaceDigest(
  left: ArtifactSurfaceDigestShape | null,
  right: ArtifactSurfaceDigestShape | null
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.surface === right.surface &&
    String(left.digest).toLowerCase() === String(right.digest).toLowerCase() &&
    left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes
  );
}

function verifySkillBom(
  sourceRoot: string,
  bomPath: string,
  releaseTag: string,
  expectedHash: string | null,
  expectedSourceChecksum: string,
  expectedArtifactSurface: ArtifactSurfaceDigestShape | null
): void {
  if (!fileExists(bomPath)) {
    throw new Error(`Skill BOM not found: ${bomPath}`);
  }
  verifyExpectedFileHash(bomPath, expectedHash, "Skill BOM");

  const bom = readJson<SkillBomShape>(bomPath);
  const release = asString(bom.release, "Skill BOM release");
  const releaseDate = asString(bom.releaseDate, "Skill BOM releaseDate");
  const sourceChecksum = asString(bom.sourceChecksum, "Skill BOM sourceChecksum");
  if (release !== releaseTag) {
    throw new Error(`Skill BOM tag mismatch. expected=${releaseTag} actual=${release}`);
  }
  if (sourceChecksum !== expectedSourceChecksum) {
    throw new Error(
      `Skill BOM source checksum mismatch. expected=${expectedSourceChecksum} actual=${sourceChecksum}`
    );
  }

  const bomArtifactSurface = parseArtifactSurfaceDigest(bom.artifactSurface, "Skill BOM artifactSurface");
  if (!sameArtifactSurfaceDigest(bomArtifactSurface, expectedArtifactSurface)) {
    throw new Error("Skill BOM artifact surface does not match release manifest");
  }
  verifyArtifactSurfaceDigest(sourceRoot, bomArtifactSurface, "Skill BOM");

  const rebuilt = buildReleaseArtifacts(releaseTag, {
    sourceRoot,
    releaseDate,
    sourceChecksum,
    artifactSurface: bomArtifactSurface ? String(bomArtifactSurface.surface) : null,
  });
  if (bom.contentSha256 !== rebuilt.skillBom.contentSha256) {
    throw new Error(
      `Skill BOM content mismatch. expected=${rebuilt.skillBom.contentSha256} actual=${bom.contentSha256}`
    );
  }
}

function verifyReleaseArtifactPolicy(options: VerifyReleaseArtifactsOptions): void {
  const { sourceRoot, layout, policy } = options;
  if (!isArtifactPolicyActive(policy)) {
    return;
  }

  const releaseTag = resolveReleaseTag(policy, options.ref);
  const poolRoot = resolvePoolRoot(sourceRoot, layout);
  const expectedManifestHash = toExpectedHex(
    policy.expectedReleaseManifestSha256,
    "lockfile.policy.expectedReleaseManifestSha256"
  );
  const expectedSkillBomHash = toExpectedHex(
    policy.expectedSkillBomSha256,
    "lockfile.policy.expectedSkillBomSha256"
  );

  const manifestPath = resolvePolicyPath(
    poolRoot,
    policy.releaseManifestPath,
    path.join("releases", "manifests", `${releaseTag}.json`),
    "lockfile.policy.releaseManifestPath"
  );
  const bomPath = resolvePolicyPath(
    poolRoot,
    policy.skillBomPath,
    path.join("releases", "boms", `${releaseTag}.skill-bom.json`),
    "lockfile.policy.skillBomPath"
  );

  const manifest = verifyReleaseManifest(sourceRoot, manifestPath, releaseTag, expectedManifestHash);
  const manifestArtifactSurface = parseArtifactSurfaceDigest(
    manifest.artifactSurface,
    "Release manifest artifactSurface"
  );
  const actualSourceChecksum = computeSourceChecksum(sourceRoot, layout);
  if (manifest.sourceChecksum !== actualSourceChecksum) {
    throw new Error(
      `Release manifest source checksum mismatch. expected=${actualSourceChecksum} actual=${manifest.sourceChecksum}`
    );
  }

  if (policy.requireSkillBom || expectedSkillBomHash) {
    verifySkillBom(
      sourceRoot,
      bomPath,
      releaseTag,
      expectedSkillBomHash,
      actualSourceChecksum,
      manifestArtifactSurface
    );
  }

  console.log(`Verified release manifest: ${manifestPath}`);
  if (policy.requireSkillBom || expectedSkillBomHash) {
    console.log(`Verified skill BOM: ${bomPath}`);
  }
}

export {
  verifyReleaseArtifactPolicy,
};
