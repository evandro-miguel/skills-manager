#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand as runCommandArray } from "../../lib/command.ts";
import { ensureDir, fileExists, hashFile, listFilesRecursive, writeFileAtomicSafe } from "../../lib/files.ts";
import { assertSafeGitRef, isFullCommitSha } from "../../lib/git-ref.ts";
import { redactRemoteForDiagnostics } from "../../lib/redact.ts";

const SOURCE_CACHE_COMPLETE_FILE = ".complete";
const SOURCE_CACHE_DIGEST_FILE = ".digest";
const SOURCE_CACHE_DIGEST_SKIP_NAMES = new Set([".git"]);
const SOURCE_CACHE_ROOT_SIDECARS = new Set([SOURCE_CACHE_COMPLETE_FILE, SOURCE_CACHE_DIGEST_FILE]);

type RunCommandOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  allowFailure?: boolean;
};

type RunCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

interface SourcePlan {
  source?: unknown;
  repo?: unknown;
  ref?: unknown;
  installs?: unknown;
}

interface ResolvedRemoteRef {
  ref: string;
  commit: string;
  sourceRef: string;
}

type SourceCacheIntegrity =
  | { status: "valid" }
  | { status: "incomplete"; reason: string }
  | { status: "mismatch"; reason: string };

function runCommand(
  command: string,
  commandArgs: string[],
  opts: RunCommandOptions = {}
): RunCommandResult {
  const runOpts: { cwd?: string; env?: Record<string, string | undefined>; stdout: "pipe"; stderr: "pipe"; allowFailure?: boolean } = {
    stdout: "pipe",
    stderr: "pipe",
  };
  if (opts.cwd !== undefined) runOpts.cwd = opts.cwd;
  if (opts.env !== undefined) runOpts.env = opts.env;
  if (opts.allowFailure !== undefined) runOpts.allowFailure = opts.allowFailure;
  return runCommandArray([command, ...commandArgs], runOpts);
}

function resolveHome(): string {
  return process.env.HOME || os.homedir();
}

function resolveSkillpoolHome(): string {
  return process.env.SKILLPOOL_HOME || path.join(resolveHome(), ".skillpool");
}

function cacheKey(repo: string, ref: string): string {
  const hash = crypto.createHash("sha256").update(`${repo}@@${ref}`).digest("hex").slice(0, 16);
  return `src-${hash}`;
}

function sourceCacheDigest(dest: string): string {
  const files = listFilesRecursive(dest, { skipNames: SOURCE_CACHE_DIGEST_SKIP_NAMES }).filter((filePath) => {
    const rel = path.relative(dest, filePath).replaceAll("\\", "/");
    return !SOURCE_CACHE_ROOT_SIDECARS.has(rel);
  });
  const manifest = files
    .map((filePath) => {
      const rel = path.relative(dest, filePath).replaceAll("\\", "/");
      return `${rel}\0${hashFile(filePath)}`;
    })
    .join("\n");
  return crypto.createHash("sha256").update(manifest).digest("hex");
}

function sourceCacheCompletePath(dest: string): string {
  return path.join(dest, SOURCE_CACHE_COMPLETE_FILE);
}

function sourceCacheDigestPath(dest: string): string {
  return path.join(dest, SOURCE_CACHE_DIGEST_FILE);
}

function verifySourceCacheIntegrity(dest: string): SourceCacheIntegrity {
  if (!fs.lstatSync(dest).isDirectory()) {
    return { status: "incomplete", reason: "cache path is not a directory" };
  }

  if (!fileExists(sourceCacheCompletePath(dest))) {
    return { status: "incomplete", reason: `missing ${SOURCE_CACHE_COMPLETE_FILE}` };
  }

  const digestPath = sourceCacheDigestPath(dest);
  if (!fileExists(digestPath)) {
    return { status: "incomplete", reason: `missing ${SOURCE_CACHE_DIGEST_FILE}` };
  }

  const expectedDigest = fs.readFileSync(digestPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/i.test(expectedDigest)) {
    return { status: "mismatch", reason: `invalid ${SOURCE_CACHE_DIGEST_FILE}` };
  }

  const actualDigest = sourceCacheDigest(dest);
  if (actualDigest !== expectedDigest.toLowerCase()) {
    return { status: "mismatch", reason: "digest mismatch" };
  }

  return { status: "valid" };
}

function ensureReusableSourceCache(dest: string): boolean {
  const integrity = verifySourceCacheIntegrity(dest);
  if (integrity.status === "valid") {
    return true;
  }
  if (integrity.status === "incomplete") {
    return false;
  }

  throw new Error(`Source cache integrity check failed for ${dest}: ${integrity.reason}`);
}

function writeSourceCacheIntegritySidecars(dest: string): void {
  const digest = sourceCacheDigest(dest);
  writeFileAtomicSafe(sourceCacheDigestPath(dest), `${digest}\n`);
  writeFileAtomicSafe(sourceCacheCompletePath(dest), `complete\n`);
}

function makeTempCachePath(sourcesRoot: string, key: string): string {
  return path.join(sourcesRoot, `.tmp-${key}-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
}

function readSourceCacheLockOwnerPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(lockPath, "owner"), "utf8").trim();
    if (!/^\d+$/.test(raw)) {
      return null;
    }
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (_error) {
    return null;
  }
}

function processAppearsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryRemoveStaleSourceCacheLock(lockPath: string): boolean {
  const ownerPid = readSourceCacheLockOwnerPid(lockPath);
  if (!ownerPid || processAppearsAlive(ownerPid)) {
    return false;
  }
  fs.rmSync(lockPath, { recursive: true, force: true });
  return true;
}

function withSourceCacheLock<T>(lockPath: string, callback: () => T): T {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (attempt === 0 && tryRemoveStaleSourceCacheLock(lockPath)) {
        continue;
      }
      throw new Error(`Source cache is locked: ${lockPath}`);
    }
  }

  try {
    writeFileAtomicSafe(path.join(lockPath, "owner"), `${process.pid}\n`);
    return callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

type FetchCandidate = {
  refspec: string;
  checkout: string;
};

function fetchCandidates(ref: string): FetchCandidate[] {
  if (ref.startsWith("refs/tags/")) {
    return [{ refspec: `${ref}:${ref}`, checkout: ref }];
  }
  if (ref.startsWith("refs/heads/")) {
    const branch = ref.slice("refs/heads/".length);
    return [{ refspec: `${ref}:refs/remotes/origin/${branch}`, checkout: `refs/remotes/origin/${branch}` }];
  }
  return [
    { refspec: `refs/tags/${ref}:refs/tags/${ref}`, checkout: `refs/tags/${ref}` },
    { refspec: `refs/heads/${ref}:refs/remotes/origin/${ref}`, checkout: `refs/remotes/origin/${ref}` },
    { refspec: ref, checkout: "FETCH_HEAD" },
  ];
}

function parseLsRemoteCommit(output: string, expectedRef: string): string | null {
  for (const line of output.split("\n")) {
    const [sha, remoteRef] = line.trim().split(/\s+/, 2);
    if (sha && remoteRef === expectedRef && /^[a-f0-9]{40}$/i.test(sha)) {
      return sha.toLowerCase();
    }
  }
  return null;
}

function resolveRemoteRef(repo: string, ref: string): ResolvedRemoteRef {
  ref = assertSafeGitRef(ref);
  if (isFullCommitSha(ref)) {
    return {
      ref,
      commit: ref.toLowerCase(),
      sourceRef: ref,
    };
  }

  const candidates = ref.startsWith("refs/tags/")
    ? [`${ref}^{}`, ref]
    : ref.startsWith("refs/heads/")
      ? [ref]
      : [`refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`, ref];

  for (const candidate of candidates) {
    const probe = runCommand("git", ["ls-remote", "--exit-code", repo, candidate], {
      allowFailure: true,
    });
    if (probe.code !== 0) {
      continue;
    }
    const commit = parseLsRemoteCommit(probe.stdout, candidate);
    if (commit) {
      return {
        ref,
        commit,
        sourceRef: candidate,
      };
    }
  }

  throw new Error(
    `Git ref '${ref}' was not found in repo '${redactRemoteForDiagnostics(repo)}'`
  );
}

function currentHeadCommit(dest: string): string {
  const result = runCommand("git", ["-C", dest, "rev-parse", "HEAD"]);
  const commit = result.stdout.trim().toLowerCase();
  if (!isFullCommitSha(commit)) {
    // Captured child output is never echoed; only the local cache path and a
    // static reason enter the error.
    throw new Error(`Unable to resolve fetched commit in ${dest}`);
  }
  return commit;
}

function fetchExactRef(repo: string, ref: string, dest: string, expectedCommit?: string): void {
  ref = assertSafeGitRef(ref);
  ensureDir(dest);
  runCommand("git", ["-C", dest, "init"]);
  runCommand("git", ["-C", dest, "remote", "add", "origin", repo]);

  const failures: string[] = [];
  for (const candidate of fetchCandidates(ref)) {
    const result = runCommand("git", ["-C", dest, "fetch", "--depth", "1", "origin", candidate.refspec], {
      allowFailure: true,
    });
    if (result.code === 0) {
      runCommand("git", ["-C", dest, "checkout", "--detach", candidate.checkout]);
      if (expectedCommit && currentHeadCommit(dest) !== expectedCommit.toLowerCase()) {
        throw new Error(`Fetched ref '${ref}' resolved to unexpected commit`);
      }
      return;
    }
    // Captured git stdout/stderr is never appended: arbitrary child output can
    // carry credentials. Failure lines stay limited to the safe stage (the
    // validated refspec) and the mapped exit code.
    failures.push(`${candidate.refspec}: exit ${result.code}`);
  }

  throw new Error(
    `Failed to fetch Git ref '${ref}' from '${redactRemoteForDiagnostics(repo)}'. Tried:\n- ${failures.join("\n- ")}`
  );
}

function cacheRepo(repo: string, ref: string, refreshCache = false): string {
  if (typeof ref !== "string" || !ref.trim()) {
    throw new Error("Remote source requires explicit ref; refusing to default to floating main");
  }
  const cacheHome = resolveSkillpoolHome();
  const sourcesRoot = path.join(cacheHome, "sources");
  const resolved = resolveRemoteRef(repo, ref);
  const key = cacheKey(repo, resolved.commit);
  const dest = path.join(sourcesRoot, key);
  const lockPath = `${dest}.lock`;

  ensureDir(sourcesRoot);

  if (!refreshCache && fileExists(dest) && ensureReusableSourceCache(dest)) {
    return dest;
  }

  return withSourceCacheLock(lockPath, () => {
    if (refreshCache && fileExists(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }

    if (fileExists(dest)) {
      if (ensureReusableSourceCache(dest)) {
        return dest;
      }
      fs.rmSync(dest, { recursive: true, force: true });
    }

    console.log(
      `-> Fetching ${redactRemoteForDiagnostics(repo)} (${ref}@${resolved.commit.slice(0, 12)}) into cache`
    );

    const tempDest = makeTempCachePath(sourcesRoot, key);
    try {
      fetchExactRef(repo, ref, tempDest, resolved.commit);
      writeSourceCacheIntegritySidecars(tempDest);
      fs.renameSync(tempDest, dest);
    } catch (error) {
      if (fileExists(tempDest)) {
        fs.rmSync(tempDest, { recursive: true, force: true });
      }
      throw error;
    }

    return dest;
  });
}

function verifyRepoRefExists(repo: string, ref: string): true {
  resolveRemoteRef(repo, ref);
  return true;
}

function resolveSourceRootForPlan(plan: SourcePlan, refreshCache: unknown): string {
  if (plan.source) {
    const sourcePath = path.resolve(plan.source as string);
    if (!fileExists(sourcePath)) {
      throw new Error(`Source path not found: ${sourcePath}`);
    }
    return sourcePath;
  }

  if (!plan.repo) {
    throw new Error("Missing source definition: provide --source or repo in lockfile/direct args");
  }

  const ref = typeof plan.ref === "string" && plan.ref.trim() ? plan.ref.trim() : null;
  if (!ref) {
    throw new Error("Remote source requires explicit ref; refusing to default to floating main");
  }

  return cacheRepo(plan.repo as string, ref, Boolean(refreshCache));
}

function verifySignedTag(sourceRoot: string, ref: string): void {
  ref = assertSafeGitRef(ref);
  const list = runCommand("git", ["-C", sourceRoot, "tag", "--list", ref], {
    allowFailure: true,
  });

  if (!list.stdout || !list.stdout.split("\n").includes(ref)) {
    throw new Error(`Signed tag verification requires ref '${ref}' to be a tag in source`);
  }

  runCommand("git", ["-C", sourceRoot, "tag", "-v", ref]);
}

export {
  cacheKey,
  cacheRepo,
  fetchCandidates,
  fetchExactRef,
  resolveRemoteRef,
  resolveHome,
  resolveSkillpoolHome,
  resolveSourceRootForPlan,
  verifyRepoRefExists,
  verifySignedTag,
};
