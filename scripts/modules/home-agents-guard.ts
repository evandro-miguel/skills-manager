#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function currentHomeDir(): string {
  return path.resolve(process.env.HOME || os.homedir());
}

function existingOrResolved(candidatePath: string): string {
  const resolved = path.resolve(candidatePath);
  if (!fs.existsSync(resolved)) {
    return resolved;
  }
  return fs.realpathSync.native(resolved);
}

function homeAgentsSkillsPath(): string {
  return path.join(currentHomeDir(), ".agents", "skills");
}

/**
 * This guard is intentionally narrow: it rejects targets that resolve to the
 * user-global legacy surface at `${HOME}/.agents/skills`.
 *
 * Do not broaden it to reject project-local targets such as
 * `${HOME}/apps/my-project/.agents/skills`. Project `.agents/skills` folders
 * are the supported install target for repo-local skills.
 */
function isHomeAgentsSkillsTarget(targetPath: string): boolean {
  const expected = homeAgentsSkillsPath();
  return existingOrResolved(targetPath) === existingOrResolved(expected);
}

function assertNotHomeAgentsSkillsTarget(targetPath: string, label: string): void {
  if (!isHomeAgentsSkillsTarget(targetPath)) {
    return;
  }

  throw new Error(
    `${label} resolves to user-level .agents/skills (${homeAgentsSkillsPath()}). ` +
      "Only targets resolving to that user-global path are blocked; " +
      "project-local <repo>/.agents/skills is allowed and expected. " +
      "Use sync-global-core for app-owned user-global skill folders."
  );
}

export {
  assertNotHomeAgentsSkillsTarget,
  homeAgentsSkillsPath,
  isHomeAgentsSkillsTarget,
};
