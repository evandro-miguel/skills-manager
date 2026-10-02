import { describe, expect, test } from "bun:test";

const gitRef = require("../scripts/lib/git-ref.ts") as typeof import("../scripts/lib/git-ref.ts");

describe("git ref safety", () => {
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

  test("trims safe refs before returning them", () => {
    expect(gitRef.assertSafeGitRef("  main  ")).toBe("main");
  });

  test("rejects refs that could alter git command semantics or escape ref syntax", () => {
    for (const unsafeRef of [
      "",
      "   ",
      "--all",
      "--upload-pack=sh",
      "feature..main",
      "refs/heads/main:refs/heads/pwn",
      "topic with space",
      "feature//branch",
      "feature@{upstream}",
      "feature/",
      "feature.",
      "feature/.",
      "feature/..",
      "feature/name.lock",
      "@",
      "feature/" + "x".repeat(300),
    ]) {
      expect(() => gitRef.assertSafeGitRef(unsafeRef)).toThrow(/Git ref must be a non-empty string|Unsafe git ref/);
    }
  });

  test("recognizes only full forty-character commit SHAs", () => {
    expect(gitRef.isFullCommitSha("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(gitRef.isFullCommitSha("0123456789abcdef0123456789abcdef0123456")).toBe(false);
    expect(gitRef.isFullCommitSha("0123456789abcdef0123456789abcdef0123456g")).toBe(false);
  });
});
