#!/usr/bin/env bun

import path from "node:path";
import { fileExists, readJson } from "../../lib/files.ts";
import { assertPathWithinProject } from "./entry.ts";

const DEFAULT_LOCKFILE_NAME = ".skills.lock.json";

interface LockfileArgs {
  project?: string;
  lockfile?: string;
}

function resolveProjectDir(args: LockfileArgs): string {
  return path.resolve(args.project ?? process.cwd());
}

function resolveLockfilePath(projectDir: string, args: LockfileArgs): string {
  if (args.lockfile !== undefined) {
    if (typeof args.lockfile !== "string" || !args.lockfile.trim()) {
      throw new Error("Lockfile path must be a non-empty string");
    }
    const lockfilePath = path.resolve(projectDir, args.lockfile.trim());
    assertPathWithinProject(projectDir, lockfilePath, "Lockfile path");
    return lockfilePath;
  }
  return path.join(projectDir, DEFAULT_LOCKFILE_NAME);
}

function loadLockfile(projectDir: string, args: LockfileArgs) {
  const lockfilePath = resolveLockfilePath(projectDir, args);
  if (!fileExists(lockfilePath)) {
    throw new Error(`Lockfile not found: ${lockfilePath}`);
  }
  const lock = readJson(lockfilePath);
  return { lockfilePath, lock };
}

export {
  loadLockfile,
  resolveLockfilePath,
  resolveProjectDir,
};
