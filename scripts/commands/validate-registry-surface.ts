#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { runCommand } from "../lib/command.ts";

type JsonObject = Record<string, any>;

type RegistrySurfaceResult = {
  status: "PASS";
  files: string[];
  channelDigests: Record<string, string>;
};

type RegistryArgs = {
  source: string;
  json: boolean;
  help?: boolean;
};

const REQUIRED_FILES = [
  "registry/advisories/security-status.json",
  "registry/index.json",
  "registry/metadata.json",
] as const;

const FLOATING_REF_NAMES = new Set(["HEAD", "head", "main", "master", "trunk", "latest", "next", "stable"]);

function help(): void {
  console.log(`
Validate the static public registry surface

Usage:
  bun scripts/commands/validate-registry-surface.ts --source <dir> [--json]

Checks registry metadata, channel/index digest pins, taps, and advisory/security
status fixtures that are intentionally published with the npm artifact surface.
`);
}

function parseArgs(argv: string[] = process.argv): RegistryArgs {
  const args: RegistryArgs = { source: process.cwd(), json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") { args.help = true; continue; }
    if (token === "--json") { args.json = true; continue; }
    if (token === "--source") { args.source = requireOptionValue(argv, i, token); i += 1; continue; }
    if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    throw new Error(`Unknown argument: ${token}`);
  }
  args.source = path.resolve(process.cwd(), args.source);
  return args;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(root: string, relativePath: string): JsonObject {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing registry surface file: ${relativePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertSha256(value: unknown, label: string): string {
  const text = assertString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new Error(`${label} must be a 64-char SHA-256 hex string`);
  }
  return text;
}

function assertRelativePath(value: unknown, label: string): string {
  const text = assertString(value, label);
  if (path.isAbsolute(text) || text.includes("\\") || text.split("/").includes("..")) {
    throw new Error(`${label} must be a safe relative POSIX path`);
  }
  return text;
}

function isImmutableRef(ref: string): boolean {
  return /^v\d+\.\d+\.\d+([+-].*)?$/.test(ref) || /^[a-f0-9]{40}$/i.test(ref);
}

function validateDigestPointer(root: string, pointer: JsonObject, label: string): { path: string; sha256: string } {
  const relativePath = assertRelativePath(pointer.path, `${label}.path`);
  const expected = assertSha256(pointer.sha256, `${label}.sha256`);
  const actual = sha256File(path.join(root, relativePath));
  if (actual !== expected) {
    throw new Error(`${label} digest mismatch for ${relativePath}: expected ${expected}, got ${actual}`);
  }
  return { path: relativePath, sha256: expected };
}

function validateChannelGitBinding(root: string, name: string, pointer: JsonObject, channel: JsonObject): void {
  const releaseTag = assertString(channel.releaseTag, `registry channel ${name}.releaseTag`);
  if (!/^v\d+\.\d+\.\d+$/.test(releaseTag)) {
    throw new Error(`registry channel ${name}.releaseTag must be a version tag`);
  }
  const commit = assertString(channel.commit, `registry channel ${name}.commit`).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`registry channel ${name}.commit must be a 40-char Git commit SHA`);
  }
  if (pointer.ref !== undefined) {
    const indexedRef = assertString(pointer.ref, `registry index channel ${name}.ref`);
    if (indexedRef !== releaseTag && indexedRef.toLowerCase() !== commit) {
      throw new Error(`registry index channel ${name}.ref must match its releaseTag or commit`);
    }
  }

  const git = (args: string[], description: string): string => {
    const result = runCommand(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      allowFailure: true,
    });
    if (result.code !== 0 || !result.stdout.trim()) {
      throw new Error(`registry channel ${name} ${description} is unavailable in the source Git repository`);
    }
    return result.stdout.trim();
  };

  const gitRoot = git(["rev-parse", "--show-toplevel"], "Git root");
  if (fs.realpathSync(gitRoot) !== fs.realpathSync(root)) {
    throw new Error(`registry channel ${name} source must be the exact Git repository root`);
  }

  const taggedCommit = git(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/tags/${releaseTag}^{commit}`],
    `tag ${releaseTag}`,
  ).toLowerCase();
  if (taggedCommit !== commit) {
    throw new Error(`registry channel ${name} tag does not resolve to its declared commit`);
  }
}

function validateRegistryIndex(index: JsonObject): void {
  if (index.version !== 1) throw new Error("registry index version must be 1");
  if (!index.channels || typeof index.channels !== "object" || Array.isArray(index.channels)) {
    throw new Error("registry index must define channels");
  }
  for (const [name, rawPointer] of Object.entries(index.channels as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`registry index channel name is invalid: ${name}`);
    if (!rawPointer || typeof rawPointer !== "object" || Array.isArray(rawPointer)) {
      throw new Error(`registry index channel ${name} must be an object`);
    }
    const pointer = rawPointer as JsonObject;
    assertRelativePath(pointer.path, `registry index channel ${name}.path`);
    const hasDigest = typeof pointer.sha256 === "string" && /^[a-f0-9]{64}$/i.test(pointer.sha256);
    if (pointer.ref !== undefined) {
      const ref = assertString(pointer.ref, `registry index channel ${name}.ref`);
      if (!hasDigest && (!isImmutableRef(ref) || FLOATING_REF_NAMES.has(ref))) {
        throw new Error(`registry index channel ${name} uses mutable ref '${ref}' without sha256`);
      }
    }
    if (!hasDigest) throw new Error(`registry index channel ${name}.sha256 must be present`);
  }
  if (!Array.isArray(index.taps)) throw new Error("registry index taps must be an array");
  for (const [i, rawTap] of index.taps.entries()) {
    if (!rawTap || typeof rawTap !== "object" || Array.isArray(rawTap)) {
      throw new Error(`registry index tap ${i} must be an object`);
    }
    const tap = rawTap as JsonObject;
    assertString(tap.name, `registry index tap ${i}.name`);
    assertString(tap.url, `registry index tap ${i}.url`);
    const hasDigest = typeof tap.sha256 === "string" && /^[a-f0-9]{64}$/i.test(tap.sha256);
    if (tap.ref !== undefined) {
      const ref = assertString(tap.ref, `registry index tap ${i}.ref`);
      if (!hasDigest && (!isImmutableRef(ref) || FLOATING_REF_NAMES.has(ref))) {
        throw new Error(`registry index tap ${tap.name} uses mutable ref '${ref}' without sha256`);
      }
    }
    if (!hasDigest) throw new Error(`registry index tap ${tap.name}.sha256 must be present`);
  }
}

function validateRegistrySurface(rootDir: string): RegistrySurfaceResult {
  const root = path.resolve(rootDir);
  const metadata = readJson(root, "registry/metadata.json");
  if (metadata.version !== 1) throw new Error("registry metadata version must be 1");
  validateDigestPointer(root, metadata.index, "registry metadata index");
  validateDigestPointer(root, metadata.advisories, "registry metadata advisories");

  const index = readJson(root, "registry/index.json");
  validateRegistryIndex(index);

  const files = new Set<string>(REQUIRED_FILES);
  const channelDigests: Record<string, string> = {};
  for (const [name, pointer] of Object.entries(index.channels as Record<string, JsonObject>)) {
    const validated = validateDigestPointer(root, pointer, `registry index channel ${name}`);
    files.add(validated.path);
    const channel = readJson(root, validated.path);
    if (channel.version !== 1 || channel.channel !== name) {
      throw new Error(`registry channel ${name} must be a matching release channel document`);
    }
    if (channel.policy?.allowFloatingRef !== false) {
      throw new Error(`registry channel ${name} must set policy.allowFloatingRef=false`);
    }
    const artifactDigests = [
      assertSha256(channel.sourceSha256, `registry channel ${name}.sourceSha256`),
      assertSha256(channel.releaseManifestSha256, `registry channel ${name}.releaseManifestSha256`),
      assertSha256(channel.skillBomSha256, `registry channel ${name}.skillBomSha256`),
    ];
    if (new Set(artifactDigests).size !== artifactDigests.length) {
      throw new Error(`registry channel ${name} artifact digests must be pairwise distinct`);
    }
    validateChannelGitBinding(root, name, pointer, channel);
    channelDigests[name] = validated.sha256;
  }

  const advisory = readJson(root, "registry/advisories/security-status.json");
  if (advisory.version !== 1) throw new Error("security advisory status version must be 1");
  if (!["no-known-advisories", "advisories-present", "unknown"].includes(advisory.status)) {
    throw new Error("security advisory status is invalid");
  }
  if (!Array.isArray(advisory.advisories)) throw new Error("security advisory advisories must be an array");

  return { status: "PASS", files: [...files].sort(), channelDigests };
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) { help(); return; }
  const result = validateRegistrySurface(args.source);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log("STATUS: PASS");
    for (const file of result.files) console.log(`- ${file}`);
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
}

export { help, main, parseArgs, validateRegistryIndex, validateRegistrySurface };
