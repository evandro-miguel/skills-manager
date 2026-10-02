#!/usr/bin/env bun

const FULL_COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const SAFE_GIT_REF_PATTERN = /^[A-Za-z0-9._/@+-]+$/;
const MAX_GIT_REF_LENGTH = 256;

function isFullCommitSha(ref: string): boolean {
  return FULL_COMMIT_SHA_PATTERN.test(ref);
}

function assertSafeGitRef(ref: string, label = "Git ref"): string {
  if (typeof ref !== "string" || !ref.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }

  const trimmed = ref.trim();
  if (isFullCommitSha(trimmed)) {
    return trimmed;
  }

  const unsafe =
    trimmed.length > MAX_GIT_REF_LENGTH ||
    trimmed.startsWith("-") ||
    !SAFE_GIT_REF_PATTERN.test(trimmed) ||
    trimmed === "@" ||
    trimmed.includes("..") ||
    trimmed.includes("//") ||
    trimmed.includes("@{") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith(".") ||
    trimmed.includes("/.") ||
    trimmed.split("/").some((segment) => segment === "." || segment === ".." || segment.endsWith(".lock"));

  if (unsafe) {
    throw new Error(`Unsafe git ref '${ref}'`);
  }

  return trimmed;
}

export {
  assertSafeGitRef,
  isFullCommitSha,
};
