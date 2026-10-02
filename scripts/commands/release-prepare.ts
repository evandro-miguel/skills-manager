#!/usr/bin/env bun
/**
 * Prepare a release by updating package version and CHANGELOG entry.
 * Optional: commit and create annotated tag.
 */

import fs from "node:fs";
import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { runCommand } from "../lib/command.ts";
import { todayUtc } from "../lib/date.ts";
import { ensureDir, fileExists, hashFile, readJson, writeJson } from "../lib/files.ts";
import { childFailureMessage } from "../lib/redact.ts";
import {
  writeReleaseArtifacts,
  writeReleaseChannel,
} from "../modules/skillpool/release-artifacts.ts";
import {
  assertNoSensitiveFindings,
  scanSensitiveFiles,
} from "../modules/skillpool/sensitive-scan.ts";
import { resolveSourceLayout } from "../modules/skillpool/source.ts";

interface ReleaseArgs {
  version?: string;
  date?: string;
  checksum: boolean;
  commit: boolean;
  tag: boolean;
  signTag: boolean;
  push: boolean;
  allowDirty: boolean;
  channel?: string;
  surface?: string;
  help?: boolean;
  [key: string]: unknown;
}

interface ReleasePaths {
  repoRoot: string;
  packageJson: string;
  indexJson: string;
  changelog: string;
  checksumScript: string;
  checksumDir: string;
}

type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type RunDeps = {
  runCommand?: typeof runCommand;
};

type RunFn = (args: string[], options?: RunOptions, deps?: RunDeps) => string;

interface EnsureChangelogOptions {
  paths?: ReleasePaths;
  fs?: typeof fs;
}

interface UpdateChangelogOptions extends EnsureChangelogOptions {}

interface WriteChecksumOptions {
  paths?: ReleasePaths;
  fs?: typeof fs;
  run?: RunFn;
  checksum?: string;
}

interface PrepareReleaseOptions {
  paths?: ReleasePaths;
  run?: RunFn;
  log?: (line: string) => void;
  scanSensitiveSource?: (repoRoot: string) => void;
}

interface ChecksumInfo {
  checksum: string;
  file: string;
}

interface PrepareReleaseResult {
  version: string;
  tag: string;
  date: string;
  updatedIndex: boolean;
  checksumInfo: ChecksumInfo | null;
  releaseArtifacts: {
    sourceChecksum: string;
    manifestFile: string;
    skillBomFile: string;
  };
  channelInfo: {
    channel: string;
    file: string;
  } | null;
}

const REPO_ROOT = path.resolve(__dirname, "../..");

function createPaths(repoRoot: string = REPO_ROOT): ReleasePaths {
  return {
    repoRoot,
    packageJson: path.join(repoRoot, "package.json"),
    indexJson: path.join(repoRoot, "index.json"),
    changelog: path.join(repoRoot, "CHANGELOG.md"),
    checksumScript: path.join(__dirname, "source-checksum.ts"),
    checksumDir: path.join(repoRoot, "releases", "checksums"),
  };
}

const DEFAULT_PATHS = createPaths(REPO_ROOT);

function help(): void {
  console.log(`
Prepare release metadata

Usage:
  bun scripts/commands/release-prepare.ts --version <x.y.z|vx.y.z> [options]

Options:
  --version <value>    target version (required)
  --date <YYYY-MM-DD>  release date (default: today UTC)
  --no-checksum        skip release checksum file generation
  --commit             create git commit for package/changelog updates
  --tag                create annotated tag (vX.Y.Z)
  --sign-tag           create signed tag (implies --tag)
  --channel <name>     write releases/channels/<name>.json for an existing release checkout
  --surface <name|path> include public/release surface digest in manifest and BOM
  --push               push commit + tags to origin (implies --commit + --tag)
  --allow-dirty        allow running with uncommitted changes
  --help               show help
`);
}

function parseArgs(argv: string[]): ReleaseArgs {
  const args: ReleaseArgs = {
    checksum: true,
    commit: false,
    tag: false,
    signTag: false,
    push: false,
    allowDirty: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--commit") {
      args.commit = true;
      continue;
    }
    if (token === "--tag") {
      args.tag = true;
      continue;
    }
    if (token === "--sign-tag") {
      args.signTag = true;
      args.tag = true;
      continue;
    }
    if (token === "--no-checksum") {
      args.checksum = false;
      continue;
    }
    if (token === "--push") {
      args.push = true;
      args.commit = true;
      args.tag = true;
      continue;
    }
    if (token === "--allow-dirty") {
      args.allowDirty = true;
      continue;
    }
    if (token === "--version") {
      args.version = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--date") {
      args.date = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--channel") {
      args.channel = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--surface") {
      args.surface = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.help && !args.version) {
    throw new Error("Missing --version");
  }

  return args;
}

function run(args: string[], options: RunOptions = {}, deps: RunDeps = {}): string {
  const result = (deps.runCommand || runCommand)(args, {
    cwd: options.cwd || REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: options.env || process.env,
    allowFailure: true,
  });
  if (result.code !== 0) {
    // Captured child output can carry secrets, so failures surface only the
    // redacted argv header and exit code (same shape as runCommand's own
    // thrown header).
    throw new Error(childFailureMessage(args, result.code));
  }
  return result.stdout;
}

function normalizeVersion(version: string): { plain: string; tag: string } {
  const clean = String(version).trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(clean)) {
    throw new Error(`Invalid version '${version}'. Expected x.y.z or vx.y.z`);
  }
  return { plain: clean, tag: `v${clean}` };
}

function ensureCleanRepo(runFn: RunFn = run): void {
  const status = runFn(["git", "status", "--porcelain"]);
  if (status) {
    throw new Error("Repository has uncommitted changes. Use --allow-dirty to bypass.");
  }
}

function updatePackageVersion(versionPlain: string, paths: ReleasePaths = DEFAULT_PATHS): void {
  const pkg = readJson<Record<string, unknown>>(paths.packageJson);
  pkg.version = versionPlain;
  writeJson(paths.packageJson, pkg);
}

function updateIndexVersion(versionPlain: string, paths: ReleasePaths = DEFAULT_PATHS): boolean {
  if (!fileExists(paths.indexJson)) {
    return false;
  }
  const index = readJson<Record<string, unknown>>(paths.indexJson);
  index.version = versionPlain;
  writeJson(paths.indexJson, index);
  return true;
}

function ensureChangelogExists(options: EnsureChangelogOptions = {}): void {
  const paths = options.paths || DEFAULT_PATHS;
  const fsApi = options.fs || fs;
  if (fsApi.existsSync(paths.changelog)) {
    return;
  }
  const initial = [
    "# Changelog",
    "",
    "All notable changes to this project will be documented in this file.",
    "",
    "## [Unreleased]",
    "",
  ].join("\n");
  fsApi.writeFileSync(paths.changelog, initial, "utf8");
}

function updateChangelog(versionTag: string, date: string, options: UpdateChangelogOptions = {}): boolean {
  const paths = options.paths || DEFAULT_PATHS;
  const fsApi = options.fs || fs;
  ensureChangelogExists({ paths, fs: fsApi });
  const content = fsApi.readFileSync(paths.changelog, "utf8");

  if (content.includes(`## [${versionTag}]`)) {
    return false;
  }

  const entry = [
    `## [${versionTag}] - ${date}`,
    "",
    "### Added",
    "- TBD",
    "",
  ].join("\n");

  if (content.includes("## [Unreleased]")) {
    const updated = content.replace("## [Unreleased]\n", `## [Unreleased]\n\n${entry}`);
    fsApi.writeFileSync(paths.changelog, updated, "utf8");
    return true;
  }

  const prepend = `# Changelog\n\n## [Unreleased]\n\n${entry}`;
  fsApi.writeFileSync(paths.changelog, prepend, "utf8");
  return true;
}

function ensureTagAbsent(versionTag: string, runFn: RunFn = run): void {
  const tags = runFn(["git", "tag", "--list", versionTag]);
  if (tags.split("\n").includes(versionTag)) {
    throw new Error(`Tag already exists: ${versionTag}`);
  }
}

function writeReleaseChecksum(versionTag: string, options: WriteChecksumOptions = {}): ChecksumInfo {
  const paths = options.paths || DEFAULT_PATHS;
  const fsApi = options.fs || fs;
  const runFn = options.run || run;
  const providedChecksum = options.checksum ? String(options.checksum).trim().toLowerCase() : "";
  const checksum =
    providedChecksum ||
    runFn(["bun", paths.checksumScript, "--source", paths.repoRoot], {
      cwd: paths.repoRoot,
    })
      .trim()
      .toLowerCase();

  if (!/^[a-f0-9]{64}$/i.test(checksum)) {
    // Validation failure: never echo the raw captured stdout back.
    throw new Error("Checksum script did not emit a 64-char hex sha256 digest; refusing to pin unexpected output");
  }

  ensureDir(paths.checksumDir);
  const target = path.join(paths.checksumDir, `${versionTag}.sha256`);
  fsApi.writeFileSync(target, `${checksum}\n`, "utf8");
  return { checksum, file: target };
}

function currentCommit(runFn: RunFn = run): string {
  const commit = runFn(["git", "rev-parse", "HEAD"]).trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    // Validation failure: never echo the raw captured stdout back.
    throw new Error("Could not resolve current git commit: git rev-parse HEAD did not emit a 40-char hex sha");
  }
  return commit;
}

function scanSensitiveSource(repoRoot: string): void {
  const layout = resolveSourceLayout(repoRoot, { requireSkills: false });
  if (!fileExists(layout.skillsDir)) {
    return;
  }
  assertNoSensitiveFindings(
    scanSensitiveFiles({
      rootDir: layout.skillsDir,
      baseDir: repoRoot,
    }),
    "Release source"
  );
}

function prepareRelease(args: ReleaseArgs, options: PrepareReleaseOptions = {}): PrepareReleaseResult {
  const paths = options.paths || DEFAULT_PATHS;
  const runFn =
    options.run ||
    ((commandArgs: string[], runOptions: RunOptions = {}) =>
      run(commandArgs, {
        ...runOptions,
        cwd: runOptions.cwd || paths.repoRoot,
      }));
  const log = options.log || console.log;

  const { plain, tag } = normalizeVersion(String(args.version));
  const date = String(args.date || todayUtc());

  if (args.channel && (args.commit || args.tag || args.push)) {
    throw new Error("--channel must run after the release commit/tag exists; do not combine with --commit, --tag, or --push");
  }

  if (!args.allowDirty) {
    ensureCleanRepo(runFn);
  }

  (options.scanSensitiveSource || scanSensitiveSource)(paths.repoRoot);

  updatePackageVersion(plain, paths);
  const updatedIndex = updateIndexVersion(plain, paths);
  updateChangelog(tag, date, { paths });
  let checksumInfo: ChecksumInfo | null = null;
  if (args.checksum) {
    checksumInfo = writeReleaseChecksum(tag, { paths, run: runFn });
  }
  const releaseArtifacts = writeReleaseArtifacts(tag, {
    repoRoot: paths.repoRoot,
    sourceRoot: paths.repoRoot,
    releaseDate: date,
    artifactSurface: args.surface || null,
    ...(checksumInfo ? { sourceChecksum: checksumInfo.checksum } : {}),
  });
  let channelInfo: PrepareReleaseResult["channelInfo"] = null;

  if (args.channel) {
    const writtenChannel = writeReleaseChannel(
      {
        channel: args.channel,
        releaseTag: tag,
        commit: currentCommit(runFn),
        sourceSha256: releaseArtifacts.sourceChecksum,
        releaseManifestSha256: hashFile(releaseArtifacts.manifestFile),
        skillBomSha256: hashFile(releaseArtifacts.skillBomFile),
      },
      { repoRoot: paths.repoRoot }
    );
    channelInfo = {
      channel: writtenChannel.channel.channel,
      file: writtenChannel.channelFile,
    };
  }

  log(`Updated version metadata for ${tag}`);
  log(`- package.json version: ${plain}`);
  if (updatedIndex) {
    log(`- index.json version: ${plain}`);
  }
  log(`- changelog entry date: ${date}`);
  log(`- source checksum: ${checksumInfo?.checksum || releaseArtifacts.sourceChecksum}`);
  if (checksumInfo) {
    log(`- checksum file: ${checksumInfo.file}`);
  }
  log(`- release manifest: ${releaseArtifacts.manifestFile}`);
  log(`- skill BOM: ${releaseArtifacts.skillBomFile}`);
  if (channelInfo) {
    log(`- release channel ${channelInfo.channel}: ${channelInfo.file}`);
  }

  if (args.commit) {
    const addFiles = ["package.json", "CHANGELOG.md"];
    if (updatedIndex) {
      addFiles.push("index.json");
    }
    if (checksumInfo) {
      addFiles.push(path.relative(paths.repoRoot, checksumInfo.file));
    }
    addFiles.push(path.relative(paths.repoRoot, releaseArtifacts.manifestFile));
    addFiles.push(path.relative(paths.repoRoot, releaseArtifacts.skillBomFile));
    if (channelInfo) {
      addFiles.push(path.relative(paths.repoRoot, channelInfo.file));
    }
    runFn(["git", "add", ...addFiles]);
    runFn(["git", "commit", "-m", `chore(release): ${tag}`]);
    log(`Commit created: chore(release): ${tag}`);
  }

  if (args.tag) {
    ensureTagAbsent(tag, runFn);
    if (args.signTag) {
      runFn(["git", "tag", "-s", tag, "-m", `Release ${tag}`]);
      log(`Signed tag created: ${tag}`);
    } else {
      runFn(["git", "tag", "-a", tag, "-m", `Release ${tag}`]);
      log(`Tag created: ${tag}`);
    }
  }

  if (args.push) {
    runFn(["git", "push", "origin", "HEAD"]);
    runFn(["git", "push", "origin", "--tags"]);
    log("Pushed HEAD and tags to origin");
  }

  return {
    version: plain,
    tag,
    date,
    updatedIndex,
    checksumInfo,
    releaseArtifacts: {
      sourceChecksum: releaseArtifacts.sourceChecksum,
      manifestFile: releaseArtifacts.manifestFile,
      skillBomFile: releaseArtifacts.skillBomFile,
    },
    channelInfo,
  };
}

function main(argv: string[] = process.argv, options: PrepareReleaseOptions = {}): PrepareReleaseResult | void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  return prepareRelease(args, options);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
}

export {
  DEFAULT_PATHS,
  createPaths,
  ensureChangelogExists,
  ensureCleanRepo,
  ensureTagAbsent,
  help,
  main,
  normalizeVersion,
  parseArgs,
  prepareRelease,
  run,
  todayUtc,
  updateChangelog,
  updateIndexVersion,
  updatePackageVersion,
  currentCommit,
  scanSensitiveSource,
  writeReleaseChecksum,
  writeReleaseChannel,
};
