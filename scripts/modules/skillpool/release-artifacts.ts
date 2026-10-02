#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  dirDigest,
  ensureDir,
  fileExists,
  hashFile,
  listFilesRecursive,
  writeFileAtomicSafe,
} from "../../lib/files.ts";
import {
  computeSourceChecksum,
  resolvePoolRoot,
  resolveSourceLayout,
} from "./source.ts";
import {
  collectArtifactSurfaceEntries,
  type ArtifactSurfaceDirectoryEntry,
  type ArtifactSurfaceFileEntry,
} from "./artifact-surface.ts";
import { collectPublicSurfacePacklist } from "./public-surface.ts";

const RELEASE_MANIFEST_SCHEMA = "../../schema/release-manifest.schema.json";
const SKILL_BOM_SCHEMA = "../../schema/skill-bom.schema.json";
const RELEASE_CHANNEL_SCHEMA = "../../schema/release-channel.schema.json";

interface DirectoryDigestEntry {
  path: string;
  sha256: string;
  fileCount: number;
}

interface FileDigestEntry {
  path: string;
  sha256: string;
}

interface ArtifactSurfaceDigest {
  surface: string;
  fileCount: number;
  totalBytes: number;
  digest: string;
}

interface ReleaseManifest {
  $schema: string;
  version: 1;
  release: string;
  releaseDate: string;
  sourceLayout: {
    kind: "flat" | "monorepo-root" | "nested-app" | "skillpack";
    poolRoot: string;
  };
  sourceChecksum: string;
  directories: DirectoryDigestEntry[];
  files: FileDigestEntry[];
  artifactSurface?: ArtifactSurfaceDigest;
  contentSha256: string;
}

interface SkillBomSkillEntry {
  skill: string;
  path: string;
  sha256: string;
  fileCount: number;
  files: FileDigestEntry[];
}

interface SkillBom {
  $schema: string;
  version: 1;
  release: string;
  releaseDate: string;
  sourceChecksum: string;
  skillCount: number;
  skills: SkillBomSkillEntry[];
  artifactSurface?: ArtifactSurfaceDigest;
  contentSha256: string;
}

interface ReleaseChannelPolicy {
  requireSignedTag: boolean;
  requireReleaseManifest: boolean;
  requireSkillBom: boolean;
  requireSourceChecksum: boolean;
  allowFloatingRef: boolean;
}

interface ReleaseChannel {
  $schema: string;
  version: 1;
  channel: string;
  releaseTag: string;
  commit: string;
  sourceSha256: string;
  releaseManifestSha256: string;
  skillBomSha256: string;
  policy: ReleaseChannelPolicy;
}

interface BuildArtifactsOptions {
  sourceRoot?: string;
  sourceChecksum?: string;
  releaseDate: string;
  artifactSurface?: string | null;
}

interface WriteArtifactsOptions extends BuildArtifactsOptions {
  repoRoot?: string;
  fs?: typeof fs;
}

interface BuildChannelOptions {
  channel: string;
  releaseTag: string;
  commit: string;
  sourceSha256: string;
  releaseManifestSha256: string;
  skillBomSha256: string;
  policy?: Partial<ReleaseChannelPolicy>;
}

interface WriteChannelOptions {
  repoRoot?: string;
  fs?: typeof fs;
}

interface ReleaseArtifacts {
  sourceChecksum: string;
  manifest: ReleaseManifest;
  skillBom: SkillBom;
}

interface WrittenReleaseArtifacts extends ReleaseArtifacts {
  manifestFile: string;
  skillBomFile: string;
}

interface WrittenReleaseChannel {
  channel: ReleaseChannel;
  channelFile: string;
}

function toPosixRelative(rootDir: string, targetPath: string): string {
  const relative = path.relative(rootDir, targetPath);
  if (!relative || relative === ".") {
    return ".";
  }
  return relative.split(path.sep).join("/");
}

function sortByPath<T extends { path: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.path.localeCompare(b.path));
}

function toContentHash(lines: string[]): string {
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

function artifactSurfaceHashLines(artifactSurface?: ArtifactSurfaceDigest): string[] {
  if (!artifactSurface) {
    return [];
  }
  return [
    `surface:${artifactSurface.surface}\0${artifactSurface.digest}\0${artifactSurface.fileCount}\0${artifactSurface.totalBytes}`,
  ];
}

function buildArtifactSurfaceDigest(sourceRoot: string, surface?: string | null): ArtifactSurfaceDigest | undefined {
  if (!surface) {
    return undefined;
  }
  const packlist = collectPublicSurfacePacklist(sourceRoot, surface);
  return {
    surface: packlist.surface,
    fileCount: packlist.fileCount,
    totalBytes: packlist.totalBytes,
    digest: packlist.digest,
  };
}

function readDirectoryDigest(entry: ArtifactSurfaceDirectoryEntry): DirectoryDigestEntry {
  const files = listFilesRecursive(entry.absolutePath);
  return {
    path: entry.path,
    sha256: dirDigest(entry.absolutePath),
    fileCount: files.length,
  };
}

function readFileDigest(sourceRoot: string, absolutePath: string): FileDigestEntry;
function readFileDigest(entry: ArtifactSurfaceFileEntry): FileDigestEntry;
function readFileDigest(
  sourceRootOrEntry: string | ArtifactSurfaceFileEntry,
  absolutePath?: string
): FileDigestEntry {
  if (typeof sourceRootOrEntry !== "string") {
    return {
      path: sourceRootOrEntry.path,
      sha256: hashFile(sourceRootOrEntry.absolutePath),
    };
  }
  if (!absolutePath) {
    throw new Error("readFileDigest requires an absolute path");
  }
  return {
    path: toPosixRelative(sourceRootOrEntry, absolutePath),
    sha256: hashFile(absolutePath),
  };
}

function collectRequiredDirectories(
  sourceRoot: string,
  poolRoot: string,
  layout: ReturnType<typeof resolveSourceLayout>
): DirectoryDigestEntry[] {
  const entries = collectArtifactSurfaceEntries(sourceRoot, poolRoot, layout);
  return sortByPath(entries.directories.map((entry) => readDirectoryDigest(entry)));
}

function collectRequiredFiles(
  sourceRoot: string,
  poolRoot: string,
  layout: ReturnType<typeof resolveSourceLayout>
): FileDigestEntry[] {
  const entries = collectArtifactSurfaceEntries(sourceRoot, poolRoot, layout);
  return sortByPath(entries.files.map((entry) => readFileDigest(entry)));
}

function listSkillDirectories(skillsDir: string): string[] {
  if (!fileExists(skillsDir)) {
    return [];
  }
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function buildSkillBom(
  sourceRoot: string,
  release: string,
  releaseDate: string,
  sourceChecksum: string,
  layout: ReturnType<typeof resolveSourceLayout>,
  artifactSurface?: ArtifactSurfaceDigest
): SkillBom {
  const skills = listSkillDirectories(layout.skillsDir).map((skillName) => {
    const skillDir = path.join(layout.skillsDir, skillName);
    const files = listFilesRecursive(skillDir).map((filePath) =>
      readFileDigest(sourceRoot, filePath)
    );
    return {
      skill: skillName,
      path: toPosixRelative(sourceRoot, skillDir),
      sha256: dirDigest(skillDir),
      fileCount: files.length,
      files: sortByPath(files),
    };
  });

  const contentHashLines = [
    ...skills.map((skill) => `${skill.skill}\0${skill.sha256}\0${skill.fileCount}`),
    ...artifactSurfaceHashLines(artifactSurface),
  ];
  return {
    $schema: SKILL_BOM_SCHEMA,
    version: 1,
    release,
    releaseDate,
    sourceChecksum,
    skillCount: skills.length,
    skills,
    ...(artifactSurface ? { artifactSurface } : {}),
    contentSha256: toContentHash(contentHashLines),
  };
}

function buildReleaseManifest(
  sourceRoot: string,
  poolRoot: string,
  release: string,
  releaseDate: string,
  sourceChecksum: string,
  layout: ReturnType<typeof resolveSourceLayout>,
  artifactSurface?: ArtifactSurfaceDigest
): ReleaseManifest {
  const directories = collectRequiredDirectories(sourceRoot, poolRoot, layout);
  const files = collectRequiredFiles(sourceRoot, poolRoot, layout);
  const contentHashLines = [
    ...directories.map((entry) => `dir:${entry.path}\0${entry.sha256}\0${entry.fileCount}`),
    ...files.map((entry) => `file:${entry.path}\0${entry.sha256}`),
    ...artifactSurfaceHashLines(artifactSurface),
  ];

  return {
    $schema: RELEASE_MANIFEST_SCHEMA,
    version: 1,
    release,
    releaseDate,
    sourceLayout: {
      kind: layout.kind,
      poolRoot: toPosixRelative(sourceRoot, poolRoot),
    },
    sourceChecksum,
    directories,
    files,
    ...(artifactSurface ? { artifactSurface } : {}),
    contentSha256: toContentHash(contentHashLines),
  };
}

function buildReleaseArtifacts(
  versionTag: string,
  options: BuildArtifactsOptions
): ReleaseArtifacts {
  const sourceRoot = path.resolve(options.sourceRoot || process.cwd());
  const layout = resolveSourceLayout(sourceRoot, { requireSkills: false });
  const poolRoot = resolvePoolRoot(sourceRoot, layout);
  const sourceChecksum = options.sourceChecksum || computeSourceChecksum(sourceRoot, layout);
  const artifactSurface = buildArtifactSurfaceDigest(sourceRoot, options.artifactSurface);
  const manifest = buildReleaseManifest(
    sourceRoot,
    poolRoot,
    versionTag,
    options.releaseDate,
    sourceChecksum,
    layout,
    artifactSurface
  );
  const skillBom = buildSkillBom(
    sourceRoot,
    versionTag,
    options.releaseDate,
    sourceChecksum,
    layout,
    artifactSurface
  );
  return {
    sourceChecksum,
    manifest,
    skillBom,
  };
}

function writeReleaseArtifacts(
  versionTag: string,
  options: WriteArtifactsOptions
): WrittenReleaseArtifacts {
  const repoRoot = path.resolve(options.repoRoot || options.sourceRoot || process.cwd());
  const artifacts = buildReleaseArtifacts(versionTag, options);
  const manifestFile = path.join(repoRoot, "releases", "manifests", `${versionTag}.json`);
  const skillBomFile = path.join(repoRoot, "releases", "boms", `${versionTag}.skill-bom.json`);

  ensureDir(path.dirname(manifestFile));
  ensureDir(path.dirname(skillBomFile));
  writeFileAtomicSafe(manifestFile, `${JSON.stringify(artifacts.manifest, null, 2)}\n`);
  writeFileAtomicSafe(skillBomFile, `${JSON.stringify(artifacts.skillBom, null, 2)}\n`);

  return {
    ...artifacts,
    manifestFile,
    skillBomFile,
  };
}

function normalizeChannelName(channel: string): string {
  const normalized = channel.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    throw new Error(`Invalid release channel: ${channel}`);
  }
  return normalized;
}

function normalizeReleaseTag(value: string): string {
  const raw = value.trim();
  const match = raw.match(/^v?([0-9]+)\.([0-9]+)\.([0-9]+)$/);
  if (!match) {
    throw new Error(`Invalid release tag: ${value}`);
  }
  return `v${match[1]}.${match[2]}.${match[3]}`;
}

function normalizeSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 64-char SHA-256 hex string`);
  }
  return normalized;
}

function normalizeCommit(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error("release channel commit must be a full 40-char git SHA");
  }
  return normalized;
}

function buildReleaseChannel(options: BuildChannelOptions): ReleaseChannel {
  const channelName = normalizeChannelName(options.channel);
  const policy: ReleaseChannelPolicy = {
    requireSignedTag: true,
    requireReleaseManifest: true,
    requireSkillBom: true,
    requireSourceChecksum: true,
    allowFloatingRef: false,
    ...(options.policy || {}),
  };
  if (channelName === "stable") {
    if (policy.requireSignedTag !== true) {
      throw new Error("Release channel stable must require policy.requireSignedTag=true");
    }
    if (policy.requireSourceChecksum !== true) {
      throw new Error("Release channel stable must require policy.requireSourceChecksum=true");
    }
  }

  return {
    $schema: RELEASE_CHANNEL_SCHEMA,
    version: 1,
    channel: channelName,
    releaseTag: normalizeReleaseTag(options.releaseTag),
    commit: normalizeCommit(options.commit),
    sourceSha256: normalizeSha256(options.sourceSha256, "release channel sourceSha256"),
    releaseManifestSha256: normalizeSha256(
      options.releaseManifestSha256,
      "release channel releaseManifestSha256"
    ),
    skillBomSha256: normalizeSha256(options.skillBomSha256, "release channel skillBomSha256"),
    policy,
  };
}

function writeReleaseChannel(
  options: BuildChannelOptions,
  writeOptions: WriteChannelOptions = {}
): WrittenReleaseChannel {
  const repoRoot = path.resolve(writeOptions.repoRoot || process.cwd());
  const channel = buildReleaseChannel(options);
  const channelFile = path.join(repoRoot, "releases", "channels", `${channel.channel}.json`);

  ensureDir(path.dirname(channelFile));
  writeFileAtomicSafe(channelFile, `${JSON.stringify(channel, null, 2)}\n`);

  return {
    channel,
    channelFile,
  };
}

export {
  buildReleaseArtifacts,
  writeReleaseChannel,
  writeReleaseArtifacts,
};
