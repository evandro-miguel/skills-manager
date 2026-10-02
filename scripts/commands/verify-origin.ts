#!/usr/bin/env bun
/**
 * Verify release/source origin policy for a resolved universal-skills checkout.
 */

import path from "node:path";
import { runCommand } from "../lib/command.ts";
import { hashFile } from "../lib/files.ts";
import { verifyRepoRefExists, verifySignedTag } from "../modules/skillpool/cache.ts";
import { computeSourceChecksum, resolvePoolRoot, resolveSourceLayout } from "../modules/skillpool/source.ts";
import { verifyReleaseArtifactPolicy } from "../modules/skillpool/verify-artifacts.ts";
import { normalizeReleaseTag } from "./release-verify.ts";

interface VerifyOriginArgs {
  source: string;
  repo: string | null;
  ref: string | null;
  version: string | null;
  sourceCommit: string | null;
  expectedSourceSha256: string | null;
  releaseManifestPath: string | null;
  expectedReleaseManifestSha256: string | null;
  skillBomPath: string | null;
  expectedSkillBomSha256: string | null;
  requireRefExists: boolean;
  requireSignedTag: boolean;
  requireSourceCommit: boolean;
  requireSourceChecksum: boolean;
  requireReleaseManifest: boolean;
  requireSkillBom: boolean;
  requireCosignBundles: boolean;
  requireGithubAttestation: boolean;
  json: boolean;
  help: boolean;
}

interface VerifyOriginDeps {
  verifyRepoRefExists?: typeof verifyRepoRefExists;
  verifySignedTag?: typeof verifySignedTag;
  runGit?: typeof runGit;
  log?: (message: string) => void;
}

interface VerifyOriginResult {
  sourceRoot: string;
  repo: string | null;
  ref: string | null;
  commit: string | null;
  sourceChecksum: string;
  releaseTag: string | null;
  releaseManifestSha256: string | null;
  skillBomSha256: string | null;
  localIntegrity: "PASS";
  origin: "PASS";
  provenance: "NOT_REQUESTED";
  checks: string[];
}

function help(): void {
  console.log(`
Verify source/release origin policy

Usage:
  bun scripts/commands/verify-origin.ts --source <dir> --version <vX.Y.Z> [options]

Options:
  --source <dir>                         Source root (default: .)
  --repo <url-or-path>                   Optional Git remote/path used for ref existence checks
  --ref <ref>                            Git ref to verify
  --version <version>                    Release tag; also used as ref when --ref is omitted
  --source-commit <sha>                  Expected full 40-character source commit
  --expected-source-sha256 <sha256>      Expected source package checksum
  --release-manifest-path <path>         Optional manifest path inside the pool root
  --expected-release-manifest-sha256 <sha256>
  --skill-bom-path <path>                Optional Skill BOM path inside the pool root
  --expected-skill-bom-sha256 <sha256>
  --require-ref-exists                   Require ref to exist locally/remotely (default true)
  --require-signed-tag                   Require a verifiable signed tag
  --require-source-commit                Require --source-commit and compare it to the ref commit
  --require-source-checksum              Require --expected-source-sha256
  --require-release-manifest             Require release manifest verification
  --require-skill-bom                    Require Skill BOM verification
  --require-cosign-bundles               Fail closed; not implemented in this local baseline
  --require-github-attestation           Fail closed; not implemented in this local baseline
  --json                                 Emit machine-readable output
  --help                                 Show help
`);
}

function requireOptionValue(argv: string[], index: number, token: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${token}`);
  }
  return value;
}

function parseArgs(argv: string[] = process.argv): VerifyOriginArgs {
  const args: VerifyOriginArgs = {
    source: ".",
    repo: null,
    ref: null,
    version: null,
    sourceCommit: null,
    expectedSourceSha256: null,
    releaseManifestPath: null,
    expectedReleaseManifestSha256: null,
    skillBomPath: null,
    expectedSkillBomSha256: null,
    requireRefExists: true,
    requireSignedTag: false,
    requireSourceCommit: false,
    requireSourceChecksum: false,
    requireReleaseManifest: false,
    requireSkillBom: false,
    requireCosignBundles: false,
    requireGithubAttestation: false,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--require-ref-exists") {
      args.requireRefExists = true;
      continue;
    }
    if (token === "--no-require-ref-exists") {
      args.requireRefExists = false;
      continue;
    }
    if (token === "--require-signed-tag") {
      args.requireSignedTag = true;
      continue;
    }
    if (token === "--require-source-commit") {
      args.requireSourceCommit = true;
      continue;
    }
    if (token === "--require-source-checksum") {
      args.requireSourceChecksum = true;
      continue;
    }
    if (token === "--require-release-manifest") {
      args.requireReleaseManifest = true;
      continue;
    }
    if (token === "--require-skill-bom") {
      args.requireSkillBom = true;
      continue;
    }
    if (token === "--require-cosign-bundles") {
      args.requireCosignBundles = true;
      continue;
    }
    if (token === "--require-github-attestation") {
      args.requireGithubAttestation = true;
      continue;
    }
    if (token.startsWith("--")) {
      const value = requireOptionValue(argv, i, token);
      if (token === "--source") {
        args.source = value;
      } else if (token === "--repo") {
        args.repo = value;
      } else if (token === "--ref") {
        args.ref = value;
      } else if (token === "--version") {
        args.version = value;
      } else if (token === "--source-commit") {
        args.sourceCommit = value;
      } else if (token === "--expected-source-sha256") {
        args.expectedSourceSha256 = value;
      } else if (token === "--release-manifest-path") {
        args.releaseManifestPath = value;
      } else if (token === "--expected-release-manifest-sha256") {
        args.expectedReleaseManifestSha256 = value;
      } else if (token === "--skill-bom-path") {
        args.skillBomPath = value;
      } else if (token === "--expected-skill-bom-sha256") {
        args.expectedSkillBomSha256 = value;
      } else {
        throw new Error(`Unknown option: ${token}`);
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), args.source);
  return args;
}

function normalizeSha256(value: string | null, label: string): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 64-character SHA-256 hex string`);
  }
  return normalized;
}

function normalizeCommit(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error("--source-commit must be a full 40-character git SHA");
  }
  return normalized;
}

function runGit(sourceRoot: string, args: string[], allowFailure = false): { stdout: string; stderr: string; code: number } {
  return runCommand(["git", "-C", sourceRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure,
  });
}

function resolveRefCommit(
  sourceRoot: string,
  ref: string,
  runGitImpl: typeof runGit = runGit
): string {
  const result = runGitImpl(sourceRoot, ["rev-parse", "--verify", `${ref}^{commit}`], true);
  if (result.code !== 0 || !result.stdout) {
    throw new Error(`Git ref not found in source checkout: ${ref}`);
  }
  return result.stdout.trim().toLowerCase();
}

function assertUnsupportedProvenance(args: VerifyOriginArgs): void {
  if (args.requireCosignBundles) {
    throw new Error(
      "UNSUPPORTED_PROVENANCE_POLICY: requireCosignBundles is not implemented by skill-sys verify-origin; this command only verifies git ref/commit and local release artifacts"
    );
  }
  if (args.requireGithubAttestation) {
    throw new Error(
      "UNSUPPORTED_PROVENANCE_POLICY: requireGithubAttestation is conditional on release workflow support; skill-sys verify-origin cannot assert it yet"
    );
  }
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

function verifyOrigin(args: VerifyOriginArgs, deps: VerifyOriginDeps = {}): VerifyOriginResult {
  assertUnsupportedProvenance(args);

  const log = deps.log || console.log;
  const releaseTag = args.version ? normalizeReleaseTag(args.version) : null;
  const ref = args.ref || releaseTag;
  if (!ref) {
    throw new Error("verify-origin requires --ref or --version");
  }

  const expectedSourceSha256 = normalizeSha256(
    args.expectedSourceSha256,
    "--expected-source-sha256"
  );
  const expectedManifestSha256 = normalizeSha256(
    args.expectedReleaseManifestSha256,
    "--expected-release-manifest-sha256"
  );
  const expectedSkillBomSha256 = normalizeSha256(
    args.expectedSkillBomSha256,
    "--expected-skill-bom-sha256"
  );
  const expectedCommit = normalizeCommit(args.sourceCommit);

  if (args.requireSourceCommit && !expectedCommit) {
    throw new Error("--require-source-commit requires --source-commit <full-sha>");
  }
  if (args.requireSourceChecksum && !expectedSourceSha256) {
    throw new Error("--require-source-checksum requires --expected-source-sha256 <sha256>");
  }

  const layout = resolveSourceLayout(args.source, { requireSkills: false });
  const poolRoot = resolvePoolRoot(args.source, layout);
  const checks: string[] = [];
  let resolvedCommit: string | null = null;

  if (args.requireRefExists && args.repo) {
    (deps.verifyRepoRefExists || verifyRepoRefExists)(args.repo, ref);
    checks.push("remote-ref");
    log(`Verified remote ref exists: ${ref}`);
  }

  if (args.requireRefExists || args.requireSignedTag || expectedCommit) {
    resolvedCommit = resolveRefCommit(args.source, ref, deps.runGit || runGit);
    checks.push("local-ref");
    log(`Verified local ref exists: ${ref}`);
  }

  if (args.requireSignedTag) {
    (deps.verifySignedTag || verifySignedTag)(args.source, ref);
    checks.push("signed-tag");
    log(`Verified signed tag: ${ref}`);
  }

  if (expectedCommit && resolvedCommit !== expectedCommit) {
    throw new Error(`Source commit mismatch. expected=${expectedCommit} actual=${resolvedCommit}`);
  }
  if (expectedCommit) {
    checks.push("source-commit");
    log(`Verified source commit: ${resolvedCommit}`);
  }

  const sourceChecksum = computeSourceChecksum(args.source, layout);
  if (expectedSourceSha256 && sourceChecksum.toLowerCase() !== expectedSourceSha256) {
    throw new Error(
      `Source checksum mismatch. expected=${expectedSourceSha256} actual=${sourceChecksum}`
    );
  }
  checks.push("source-checksum");
  log(`Verified source checksum: ${sourceChecksum}`);

  const verifyArtifacts =
    Boolean(releaseTag) ||
    args.requireReleaseManifest ||
    args.requireSkillBom ||
    Boolean(expectedManifestSha256) ||
    Boolean(expectedSkillBomSha256);

  if (verifyArtifacts) {
    withOptionalLogSuppression(args.json, () => {
      verifyReleaseArtifactPolicy({
        sourceRoot: args.source,
        layout,
        ref,
        policy: {
          releaseTag: releaseTag || ref,
          releaseManifestPath: args.releaseManifestPath || undefined,
          expectedReleaseManifestSha256: expectedManifestSha256 || undefined,
          requireReleaseManifest: true,
          skillBomPath: args.skillBomPath || undefined,
          expectedSkillBomSha256: expectedSkillBomSha256 || undefined,
          requireSkillBom: true,
        },
      });
    });
    checks.push("release-manifest", "skill-bom");
  }

  const manifestPath = releaseTag
    ? path.resolve(poolRoot, args.releaseManifestPath || path.join("releases", "manifests", `${releaseTag}.json`))
    : null;
  const bomPath = releaseTag
    ? path.resolve(poolRoot, args.skillBomPath || path.join("releases", "boms", `${releaseTag}.skill-bom.json`))
    : null;

  return {
    sourceRoot: args.source,
    repo: args.repo,
    ref,
    commit: resolvedCommit,
    sourceChecksum,
    releaseTag,
    releaseManifestSha256: manifestPath ? hashFile(manifestPath) : null,
    skillBomSha256: bomPath ? hashFile(bomPath) : null,
    localIntegrity: "PASS",
    origin: "PASS",
    provenance: "NOT_REQUESTED",
    checks,
  };
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const result = verifyOrigin(args, {
    log: args.json ? () => undefined : console.log,
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log("LOCAL_INTEGRITY: PASS");
  console.log("ORIGIN: PASS");
  console.log("PROVENANCE: NOT_REQUESTED");
  console.log("STATUS: PASS");
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
  help,
  main,
  parseArgs,
  resolveRefCommit,
  runGit,
  verifyOrigin,
};
export type {
  VerifyOriginArgs,
  VerifyOriginResult,
};
