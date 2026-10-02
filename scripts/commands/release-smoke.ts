#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPaths, prepareRelease } from "./release-prepare.ts";
import { verifyReleaseArtifacts } from "./release-verify.ts";
import { verifyOrigin } from "./verify-origin.ts";
import { ensureDir, hashFile, writeJson } from "../lib/files.ts";

interface ReleaseSmokeArgs {
  keepTemp: boolean;
  json: boolean;
  help: boolean;
}

interface ReleaseSmokeResult {
  status: "PASS";
  tempRoot: string;
  tempRemoved: boolean;
  releaseTag: string;
  manifestSha256: string;
  skillBomSha256: string;
  sourceChecksum: string;
  verifyOriginChecks: string[];
}

const REPO_ROOT = path.resolve(__dirname, "../..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "minimal-skillpack");
const SMOKE_VERSION = "9.9.9";
const SMOKE_DATE = "2099-01-01";

function help(): void {
  console.log(`
Release prepare/verify smoke gate

Usage:
  bun scripts/commands/release-smoke.ts [options]

Options:
  --keep-temp   Keep the temporary release fixture for debugging
  --json        Emit machine-readable output
  --help        Show help

The smoke gate copies the public minimal skillpack into an OS temporary directory,
adds only the package metadata needed by release-prepare, writes release artifacts
there, verifies them, and deletes the temp directory by default. It never writes
tracked releases/ artifacts in this checkout.
`);
}

function parseArgs(argv: string[] = process.argv): ReleaseSmokeArgs {
  const args: ReleaseSmokeArgs = { keepTemp: false, json: false, help: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === "--help" || token === "-h") { args.help = true; continue; }
    if (token === "--keep-temp") { args.keepTemp = true; continue; }
    if (token === "--json") { args.json = true; continue; }
    throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function copyFixtureDir(relativePath: string, tempRoot: string): void {
  const source = path.join(FIXTURE_ROOT, relativePath);
  const target = path.join(tempRoot, relativePath);
  fs.cpSync(source, target, { recursive: true });
}

function createTempReleaseFixture(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-release-smoke-"));
  copyFixtureDir("skills", tempRoot);
  copyFixtureDir("profiles", tempRoot);
  fs.copyFileSync(path.join(FIXTURE_ROOT, "skillpack.json"), path.join(tempRoot, "skillpack.json"));

  writeJson(path.join(tempRoot, "package.json"), {
    name: "@skill-sys/release-smoke-fixture",
    version: "0.0.0",
    private: true,
    license: "MIT",
  });
  ensureDir(path.join(tempRoot, "releases"));
  return tempRoot;
}

function withOptionalLogSuppression<T>(suppress: boolean, callback: () => T): T {
  if (!suppress) {
    return callback();
  }
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return callback();
  } finally {
    console.log = originalLog;
  }
}

function runReleaseSmoke(args: ReleaseSmokeArgs): ReleaseSmokeResult {
  const tempRoot = createTempReleaseFixture();
  let result: ReleaseSmokeResult | null = null;
  try {
    const prepared = prepareRelease(
      {
        version: SMOKE_VERSION,
        date: SMOKE_DATE,
        checksum: true,
        commit: false,
        tag: false,
        signTag: false,
        push: false,
        allowDirty: true,
      },
      {
        paths: createPaths(tempRoot),
        log: args.json ? () => undefined : console.log,
      }
    );

    withOptionalLogSuppression(args.json, () => {
      verifyReleaseArtifacts({
        source: tempRoot,
        version: prepared.tag,
      });
    });

    const origin = verifyOrigin(
      {
        source: tempRoot,
        repo: null,
        ref: prepared.tag,
        version: prepared.tag,
        sourceCommit: null,
        expectedSourceSha256: prepared.releaseArtifacts.sourceChecksum,
        releaseManifestPath: null,
        expectedReleaseManifestSha256: null,
        skillBomPath: null,
        expectedSkillBomSha256: null,
        requireRefExists: false,
        requireSignedTag: false,
        requireSourceCommit: false,
        requireSourceChecksum: true,
        requireReleaseManifest: true,
        requireSkillBom: true,
        requireCosignBundles: false,
        requireGithubAttestation: false,
        json: args.json,
        help: false,
      },
      { log: args.json ? () => undefined : console.log }
    );

    result = {
      status: "PASS",
      tempRoot,
      tempRemoved: false,
      releaseTag: prepared.tag,
      manifestSha256: hashFile(prepared.releaseArtifacts.manifestFile),
      skillBomSha256: hashFile(prepared.releaseArtifacts.skillBomFile),
      sourceChecksum: prepared.releaseArtifacts.sourceChecksum,
      verifyOriginChecks: origin.checks,
    };
    return result;
  } finally {
    if (!args.keepTemp) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      if (result) {
        result.tempRemoved = true;
      }
    }
  }
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const result = runReleaseSmoke(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log("STATUS: PASS");
  console.log(`Release: ${result.releaseTag}`);
  console.log(`Source checksum: ${result.sourceChecksum}`);
  console.log(`Manifest SHA-256: ${result.manifestSha256}`);
  console.log(`Skill BOM SHA-256: ${result.skillBomSha256}`);
  console.log(`Temp fixture removed: ${result.tempRemoved}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export { createTempReleaseFixture, main, parseArgs, runReleaseSmoke };
export type { ReleaseSmokeArgs, ReleaseSmokeResult };
