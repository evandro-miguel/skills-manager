#!/usr/bin/env bun
/**
 * Verify release manifest and skill BOM artifacts against the current source.
 */

import path from "node:path";
import { fileExists, hashFile, readJson } from "../lib/files.ts";
import { verifySignedTag } from "../modules/skillpool/cache.ts";
import { verifyReleaseArtifactPolicy } from "../modules/skillpool/verify-artifacts.ts";
import { resolveSourceLayout } from "../modules/skillpool/source.ts";

interface ReleaseVerifyArgs {
  source: string;
  version: string | null;
  channel: string | null;
  help: boolean;
}

interface VerifyReleaseOptions {
  source: string;
  version: string;
  channel?: string | null;
  verifySignedTag?: (sourceRoot: string, ref: string) => void;
}

interface ReleaseChannelShape {
  version: 1;
  channel: string;
  releaseTag: string;
  commit: string;
  sourceSha256: string;
  releaseManifestSha256: string;
  skillBomSha256: string;
  policy: {
    requireSignedTag: boolean;
    requireReleaseManifest: boolean;
    requireSkillBom: boolean;
    requireSourceChecksum: boolean;
    allowFloatingRef: boolean;
  };
}

function help(): void {
  console.log(`
Verify release artifacts

Usage:
  bun scripts/commands/release-verify.ts --version <x.y.z|vx.y.z> [options]

Options:
  --source <dir>       Source root (default: .)
  --version <version>  Release version/tag to verify
  --ref <version>      Alias for --version
  --channel <name>     Verify releases/channels/<name>.json points at version
  --help               Show help
`);
}

function normalizeReleaseTag(value: string): string {
  const raw = value.trim();
  const match = raw.match(/^v?([0-9]+)\.([0-9]+)\.([0-9]+)$/);
  if (!match) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return `v${match[1]}.${match[2]}.${match[3]}`;
}

function parseArgs(argv: string[] = process.argv): ReleaseVerifyArgs {
  const args: ReleaseVerifyArgs = {
    source: ".",
    version: null,
    channel: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--source" || token === "--version" || token === "--ref" || token === "--channel") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      if (token === "--source") {
        args.source = value;
      } else if (token === "--channel") {
        args.channel = value;
      } else {
        args.version = value;
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), args.source);
  return args;
}

function assertHashEqual(actual: string, expected: string, label: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function verifyReleaseChannel(
  sourceRoot: string,
  channelName: string,
  releaseTag: string,
  verifySignedTagImpl: (sourceRoot: string, ref: string) => void = verifySignedTag
): ReleaseChannelShape {
  if (!/^[a-z][a-z0-9-]*$/.test(channelName)) {
    throw new Error(`Invalid release channel: ${channelName}`);
  }

  const channelPath = path.join(sourceRoot, "releases", "channels", `${channelName}.json`);
  if (!fileExists(channelPath)) {
    throw new Error(`Release channel not found: ${channelPath}`);
  }

  const channel = readJson<ReleaseChannelShape>(channelPath);
  if (channel.version !== 1 || channel.channel !== channelName) {
    throw new Error(`Invalid release channel metadata: ${channelPath}`);
  }
  if (channel.releaseTag !== releaseTag) {
    throw new Error(
      `Release channel ${channelName} points to ${channel.releaseTag}, expected ${releaseTag}`
    );
  }
  if (!channel.policy || channel.policy.allowFloatingRef !== false) {
    throw new Error(`Release channel ${channelName} must disable floating refs`);
  }
  if (channelName === "stable" && channel.policy.requireSignedTag !== true) {
    throw new Error(`Release channel ${channelName} must require signed tag verification`);
  }
  if (channelName === "stable" && channel.policy.requireSourceChecksum !== true) {
    throw new Error(`Release channel ${channelName} must require source checksum verification`);
  }
  if (!channel.policy.requireReleaseManifest || !channel.policy.requireSkillBom) {
    throw new Error(`Release channel ${channelName} must require release manifest and skill BOM`);
  }
  if (channel.policy.requireSourceChecksum && !/^[a-f0-9]{64}$/i.test(channel.sourceSha256)) {
    throw new Error(`Release channel ${channelName} has invalid sourceSha256`);
  }
  if (
    (channelName === "stable" || channelName === "candidate") &&
    channel.policy.requireSignedTag
  ) {
    try {
      verifySignedTagImpl(sourceRoot, releaseTag);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Release channel ${channelName} requires a verifiable signed tag for ${releaseTag}: ${message}`
      );
    }
  }

  assertHashEqual(
    hashFile(path.join(sourceRoot, "releases", "manifests", `${releaseTag}.json`)),
    channel.releaseManifestSha256,
    `Release channel ${channelName} manifest hash`
  );
  assertHashEqual(
    hashFile(path.join(sourceRoot, "releases", "boms", `${releaseTag}.skill-bom.json`)),
    channel.skillBomSha256,
    `Release channel ${channelName} skill BOM hash`
  );

  console.log(`Release channel verified: ${channelName} -> ${releaseTag}`);
  return channel;
}

function verifyReleaseArtifacts(options: VerifyReleaseOptions): { releaseTag: string; sourceRoot: string } {
  const sourceRoot = path.resolve(process.cwd(), options.source);
  const releaseTag = normalizeReleaseTag(options.version);
  const layout = resolveSourceLayout(sourceRoot, { requireSkills: false });

  verifyReleaseArtifactPolicy({
    sourceRoot,
    layout,
    ref: releaseTag,
    policy: {
      releaseTag,
      requireReleaseManifest: true,
      requireSkillBom: true,
    },
  });

  if (options.channel) {
    verifyReleaseChannel(sourceRoot, options.channel, releaseTag, options.verifySignedTag);
  }

  console.log(`Release artifacts verified: ${releaseTag}`);
  return { releaseTag, sourceRoot };
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  if (!args.version) {
    throw new Error("Missing required --version <x.y.z|vx.y.z>");
  }
  verifyReleaseArtifacts({
    source: args.source,
    version: args.version,
    channel: args.channel,
  });
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
  main,
  normalizeReleaseTag,
  parseArgs,
  verifyReleaseChannel,
  verifyReleaseArtifacts,
};
