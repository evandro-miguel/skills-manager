#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

import { runCommand, type RunCommandOptions, type RunCommandResult } from "./command";

type Runner = (args: string[], options?: RunCommandOptions) => RunCommandResult;

type DetectRemoteOptions = {
  runner?: Runner;
};

type DetectDefaultRepoOptions = {
  universalRoot?: string;
  opencodeRoot?: string;
  detectRemote?: (repoPath: string) => string | null;
  exists?: (filePath: string) => boolean;
  runner?: Runner;
};

export function detectRemote(repoPath: string, options: DetectRemoteOptions = {}): string | null {
  const runner = options.runner || runCommand;
  const result = runner(["git", "-C", repoPath, "config", "--get", "remote.origin.url"], {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
  });
  if (result.code !== 0 || !result.stdout) {
    return null;
  }
  const value = String(result.stdout).trim();
  return value || null;
}

export function detectDefaultRepo(options: DetectDefaultRepoOptions = {}): string {
  const universalRoot = options.universalRoot;
  const opencodeRoot = options.opencodeRoot;
  if (!universalRoot || !opencodeRoot) {
    throw new Error("detectDefaultRepo requires universalRoot and opencodeRoot");
  }

  const detect = options.detectRemote || ((repoPath: string) => detectRemote(repoPath, options));
  const exists = options.exists || fs.existsSync;

  const universalRemote = detect(universalRoot);
  if (universalRemote) {
    return universalRemote;
  }

  if (exists(path.join(universalRoot, ".git"))) {
    return universalRoot;
  }

  const opencodeRemote = detect(opencodeRoot);
  if (opencodeRemote) {
    return opencodeRemote;
  }

  return opencodeRoot;
}
