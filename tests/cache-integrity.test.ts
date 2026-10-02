import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cache = require("../scripts/modules/skillpool/cache.ts") as typeof import("../scripts/modules/skillpool/cache.ts");
const gitRef = require("../scripts/lib/git-ref.ts") as typeof import("../scripts/lib/git-ref.ts");

const COMPLETE_FILE = ".complete";
const DIGEST_FILE = ".digest";
const REMOTE_TOKEN_CANARY = "CACHE-REMOTE-TOKEN-CANARY";

function thrownMessage(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected callback to throw");
}

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

function outputToString(output: Uint8Array | null | undefined): string {
  return output ? Buffer.from(output).toString("utf8") : "";
}

function run(args: string[], cwd: string): string {
  const result = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = outputToString(result.stdout);
  const stderr = outputToString(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${args.join(" ")}\n${stdout}\n${stderr}`);
  }
  return stdout.trim();
}

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createGitRepo(repo: string, options: { nestedSidecars?: boolean } = {}): { repo: string; commit: string } {
  fs.mkdirSync(repo, { recursive: true });
  run(["git", "init", "-b", "main"], repo);
  run(["git", "config", "user.email", "cache-integrity@example.test"], repo);
  run(["git", "config", "user.name", "Cache Integrity Test"], repo);
  writeText(path.join(repo, "README.md"), "# cached source\n");
  writeText(path.join(repo, "skills", "alpha", "SKILL.md"), "# Alpha\n");
  if (options.nestedSidecars) {
    writeText(path.join(repo, "skills", "alpha", "fixtures", DIGEST_FILE), "nested digest\n");
    writeText(path.join(repo, "skills", "alpha", "fixtures", COMPLETE_FILE), "nested complete\n");
  }
  run(["git", "add", "."], repo);
  run(["git", "commit", "-m", "initial"], repo);
  return { repo, commit: run(["git", "rev-parse", "HEAD"], repo).toLowerCase() };
}

function expectedCachePath(skillpoolHome: string, repo: string, commit: string): string {
  return path.join(skillpoolHome, "sources", cache.cacheKey(repo, commit));
}

describe("source cache integrity", () => {
  test("accepts normal branch, tag, scoped ref, and full SHA names", () => {
    for (const safeRef of [
      "main",
      "feature/user-root-hardening",
      "refs/heads/feature/user-root-hardening",
      "refs/tags/v1.2.3+build.5",
      "0123456789abcdef0123456789abcdef01234567",
    ]) {
      expect(gitRef.assertSafeGitRef(safeRef)).toBe(safeRef);
    }
  });

  test("rejects unsafe remote refs before invoking git", () => {
    for (const unsafeRef of ["--upload-pack=sh", "feature..main", "refs/heads/main:refs/heads/pwn", "topic with space", "feature/" + "x".repeat(300)]) {
      expect(() => cache.resolveRemoteRef("https://example.invalid/skills.git", unsafeRef)).toThrow("Unsafe git ref");
    }
  });

  test("signed tag verification rejects unsafe refs before invoking git", () => {
    expect(() => cache.verifySignedTag(path.join(os.tmpdir(), "missing-skill-cache-source"), "--all")).toThrow("Unsafe git ref");
  });

  test("fetch failures report stage and mapped exit code without captured git output", () => {
    withTempDir("source-cache-fetch-failure-", (root) => {
      // A plain directory is not a git repository: every fetch candidate exits
      // non-zero and git's captured stderr would otherwise echo the remote.
      const notARepo = path.join(root, "not-a-repo");
      fs.mkdirSync(notARepo, { recursive: true });
      const dest = path.join(root, "dest");

      const message = thrownMessage(() => cache.fetchExactRef(notARepo, "missing-ref", dest));
      expect(message).toContain("Failed to fetch Git ref 'missing-ref'");
      expect(message).toContain(`from '${notARepo}'`);
      expect(message).toContain("refs/tags/missing-ref:refs/tags/missing-ref: exit 128");
      expect(message).toContain("refs/heads/missing-ref:refs/remotes/origin/missing-ref: exit 128");
      expect(message).toContain("- missing-ref: exit 128");
      expect(message).not.toContain("fatal:");
      expect(message).not.toContain("does not appear to be a git repository");
    });
  });

  test("remote resolution errors render credentialed repos via diagnostics redaction", () => {
    const message = thrownMessage(() =>
      cache.resolveRemoteRef(
        `https://ci:${REMOTE_TOKEN_CANARY}@example.invalid/skills.git`,
        "v1",
      )
    );
    expect(message).toContain("Git ref 'v1' was not found in repo");
    expect(message).toContain("[REDACTED]@example.invalid");
    expect(message).not.toContain(REMOTE_TOKEN_CANARY);
  });

  test("writes integrity sidecars and reuses a complete source cache", () => {
    withTempDir("source-cache-complete-", (root) => {
      const { repo, commit } = createGitRepo(path.join(root, "repo"));
      const skillpoolHome = path.join(root, "skillpool");

      withSkillpoolHome(skillpoolHome, () => {
        const cached = cache.cacheRepo(repo, "main");

        expect(cached).toBe(expectedCachePath(skillpoolHome, repo, commit));
        expect(fs.existsSync(path.join(cached, COMPLETE_FILE))).toBe(true);
        expect(fs.readFileSync(path.join(cached, DIGEST_FILE), "utf8").trim()).toMatch(/^[a-f0-9]{64}$/);

        expect(cache.cacheRepo(repo, "main")).toBe(cached);
      });
    });
  });

  test("treats caches missing required sidecars as incomplete and refetches", () => {
    withTempDir("source-cache-incomplete-", (root) => {
      const { repo, commit } = createGitRepo(path.join(root, "repo"));
      const skillpoolHome = path.join(root, "skillpool");

      withSkillpoolHome(skillpoolHome, () => {
        const cached = cache.cacheRepo(repo, "main");
        expect(cached).toBe(expectedCachePath(skillpoolHome, repo, commit));

        for (const missingSidecar of [COMPLETE_FILE, DIGEST_FILE]) {
          fs.rmSync(path.join(cached, missingSidecar), { force: true });
          const tamperPath = path.join(cached, `tamper-${missingSidecar.slice(1)}.txt`);
          writeText(tamperPath, "tamper\n");

          expect(cache.cacheRepo(repo, "main")).toBe(cached);
          expect(fs.existsSync(path.join(cached, COMPLETE_FILE))).toBe(true);
          expect(fs.existsSync(path.join(cached, DIGEST_FILE))).toBe(true);
          expect(fs.existsSync(tamperPath)).toBe(false);
        }
      });
    });
  });

  test("recovers cache locks left by dead owner processes", () => {
    withTempDir("source-cache-stale-lock-", (root) => {
      const { repo, commit } = createGitRepo(path.join(root, "repo"));
      const skillpoolHome = path.join(root, "skillpool");
      const expected = expectedCachePath(skillpoolHome, repo, commit);
      const lockPath = `${expected}.lock`;
      fs.mkdirSync(lockPath, { recursive: true });
      writeText(path.join(lockPath, "owner"), "999999999\n");

      withSkillpoolHome(skillpoolHome, () => {
        expect(cache.cacheRepo(repo, "main")).toBe(expected);
        expect(fs.existsSync(lockPath)).toBe(false);
        expect(fs.existsSync(path.join(expected, COMPLETE_FILE))).toBe(true);
      });
    });
  });

  test("rejects complete source caches when the digest mismatches", () => {
    withTempDir("source-cache-digest-mismatch-", (root) => {
      const { repo } = createGitRepo(path.join(root, "repo"));
      const skillpoolHome = path.join(root, "skillpool");

      withSkillpoolHome(skillpoolHome, () => {
        const cached = cache.cacheRepo(repo, "main");
        const readmePath = path.join(cached, "README.md");
        writeText(readmePath, "tampered\n");

        expect(() => cache.cacheRepo(repo, "main")).toThrow("digest mismatch");
        expect(fs.readFileSync(readmePath, "utf8")).toBe("tampered\n");
      });
    });
  });

  test("hashes nested sidecar-named files in source cache integrity", () => {
    withTempDir("source-cache-nested-sidecar-", (root) => {
      const { repo } = createGitRepo(path.join(root, "repo"), { nestedSidecars: true });
      const skillpoolHome = path.join(root, "skillpool");

      withSkillpoolHome(skillpoolHome, () => {
        const cached = cache.cacheRepo(repo, "main");
        const nestedDigestPath = path.join(cached, "skills", "alpha", "fixtures", DIGEST_FILE);

        expect(fs.readFileSync(nestedDigestPath, "utf8")).toBe("nested digest\n");
        writeText(nestedDigestPath, "tampered nested digest\n");

        expect(() => cache.cacheRepo(repo, "main")).toThrow("digest mismatch");
      });
    });
  });
});
