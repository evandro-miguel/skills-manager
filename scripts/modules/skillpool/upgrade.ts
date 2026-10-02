#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { parseCsv, unique } from "../../lib/args.ts";
import { readJson, writeFileAtomicSafe } from "../../lib/files.ts";
import { loadLockfile, resolveProjectDir } from "./lockfile.ts";
import { validateLockShape } from "./plan.ts";
import { readProfile } from "./entry.ts";
import { resolveSourceLayout } from "./source.ts";

interface SkillpoolUpgradeArgs {
  project?: string;
  lockfile?: string;
  skills?: string;
  repo?: string;
  ref?: string;
  source?: string;
  app?: string;
  install?: boolean;
  dryRun?: boolean;
  "dry-run"?: boolean;
  "refresh-cache"?: boolean;
  refreshCache?: boolean;
  [key: string]: string | boolean | string[] | undefined;
}

interface UpgradeOptions {
  installCommand: (args: SkillpoolUpgradeArgs) => void;
  writeLockfile?: (lockfilePath: string, lock: LockfileShape) => void;
  temporaryLockfilePath?: (lockfilePath: string) => string;
}

interface LockfileShape {
  repo: string;
  ref: string;
  policy?: Record<string, unknown>;
  installs?: Array<Record<string, unknown>>;
}

function writeLockfile(lockfilePath: string, lock: LockfileShape): void {
  writeFileAtomicSafe(lockfilePath, `${JSON.stringify(lock, null, 2)}\n`);
}

function recoveryMarkerPath(lockfilePath: string): string {
  return `${lockfilePath}.upgrade-recovery.json`;
}

function assertNoRecoveryMarker(markerPath: string): void {
  try {
    const stat = fs.lstatSync(markerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Upgrade recovery marker is unsafe: ${markerPath}`);
    }
    throw new Error(`Upgrade recovery marker already exists: ${markerPath}. Restore the prior lock before retrying.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeRecoveryMarker(
  markerPath: string,
  lockfilePath: string,
  priorLock: LockfileShape,
  installError: unknown,
  recoveryError: unknown,
): void {
  writeFileAtomicSafe(markerPath, `${JSON.stringify({
    schemaVersion: 1,
    lockfile: lockfilePath,
    priorLock,
    installError: errorMessage(installError),
    recoveryError: errorMessage(recoveryError),
  }, null, 2)}\n`);
}

function writeTemporaryLockfileExclusive(lockfilePath: string, lock: LockfileShape): void {
  const parent = path.dirname(lockfilePath);
  fs.mkdirSync(parent, { recursive: true });
  const descriptor = fs.openSync(lockfilePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveRequestedSkills(args: SkillpoolUpgradeArgs): string[] {
  if (args.skills === undefined) {
    return [];
  }
  if (typeof args.skills !== "string") {
    throw new Error("Invalid --skills: expected a comma-separated list");
  }
  return unique(parseCsv(args.skills));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface StateSkillResolution {
  skills: Set<string>;
  skillsByApp: Map<string, Set<string>>;
}

function readStateSkillResolution(projectDir: string): StateSkillResolution {
  const skills = new Set<string>();
  const skillsByApp = new Map<string, Set<string>>();
  const statePath = path.join(projectDir, ".skills.state.json");
  if (!fs.existsSync(statePath)) {
    return { skills, skillsByApp };
  }

  let state: unknown;
  try {
    state = readJson(statePath);
  } catch {
    return { skills, skillsByApp };
  }

  const installed = isRecord(state) && Array.isArray(state.installed) ? state.installed : [];
  for (const raw of installed) {
    if (!isRecord(raw) || raw.managedBy !== "skill-sys") {
      continue;
    }
    const skill = typeof raw.skill === "string" ? raw.skill.trim() : "";
    if (!skill) {
      continue;
    }
    const app = typeof raw.app === "string" ? raw.app.trim() : "";
    skills.add(skill);
    const appSkills = skillsByApp.get(app) ?? new Set<string>();
    appSkills.add(skill);
    skillsByApp.set(app, appSkills);
  }

  return { skills, skillsByApp };
}

interface ProfileResolution {
  skillsByProfile: Map<string, Set<string>>;
  unresolved: boolean;
}

function resolveProfileSkills(
  lock: LockfileShape,
  args: SkillpoolUpgradeArgs,
  projectDir: string,
): ProfileResolution {
  const profileNames = new Set<string>();
  for (const entry of lock.installs ?? []) {
    if (isRecord(entry) && typeof entry.profile === "string" && entry.profile.trim()) {
      profileNames.add(entry.profile.trim());
    }
  }

  const skillsByProfile = new Map<string, Set<string>>();
  if (profileNames.size === 0) {
    return { skillsByProfile, unresolved: false };
  }

  const source = typeof args.source === "string" && args.source.trim() ? args.source.trim() : undefined;
  if (!source) {
    return { skillsByProfile, unresolved: true };
  }

  const sourcePath = path.resolve(projectDir, source);
  if (!fs.existsSync(sourcePath)) {
    return { skillsByProfile, unresolved: true };
  }

  try {
    const layout = resolveSourceLayout(sourcePath, { requireSkills: false });
    for (const profileName of profileNames) {
      const profile = readProfile(layout, profileName);
      const profileSkills = new Set<string>();
      for (const skill of profile.skills ?? []) {
        const trimmed = String(skill).trim();
        if (trimmed) {
          profileSkills.add(trimmed);
        }
      }
      skillsByProfile.set(profileName, profileSkills);
    }
    return { skillsByProfile, unresolved: false };
  } catch {
    return { skillsByProfile, unresolved: true };
  }
}

function assertRequestedSkillsKnown(
  lock: LockfileShape,
  requestedSkills: string[],
  stateSkills: Set<string>,
  profileResolution: ProfileResolution,
): void {
  const declared = new Set<string>();
  for (const entry of lock.installs ?? []) {
    if (entry && Array.isArray(entry.skills)) {
      for (const skill of entry.skills) {
        if (typeof skill === "string" && skill.trim()) {
          declared.add(skill.trim());
        }
      }
    }
  }
  for (const skill of stateSkills) {
    declared.add(skill);
  }
  for (const profileSkills of profileResolution.skillsByProfile.values()) {
    for (const skill of profileSkills) {
      declared.add(skill);
    }
  }

  const unknown = requestedSkills.filter((skill) => !declared.has(skill));
  if (unknown.length > 0) {
    if (profileResolution.unresolved) {
      throw new Error(
        `Unknown skill(s) for upgrade --skills: ${unknown.join(", ")}. Cannot resolve profile-declared skills without --source; pass --source <dir> to refresh a profile-managed skill.`,
      );
    }
    throw new Error(
      `Unknown skill(s) for upgrade --skills: ${unknown.join(", ")}. Skill not declared in lock installs.`,
    );
  }
}

function scopedLock(
  lock: LockfileShape,
  requestedSkills: string[],
  stateSkillsByApp: Map<string, Set<string>>,
  profileResolution: ProfileResolution,
): LockfileShape {
  const requested = new Set(requestedSkills);
  const installs = (lock.installs ?? []).flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const app = typeof entry.app === "string" ? entry.app.trim() : "";
    const profile = typeof entry.profile === "string" ? entry.profile.trim() : undefined;
    const matched = new Set<string>();

    if (Array.isArray(entry.skills)) {
      for (const skill of entry.skills) {
        if (typeof skill === "string" && requested.has(skill.trim())) {
          matched.add(skill.trim());
        }
      }
    }

    if (profile) {
      const profileSkills = profileResolution.skillsByProfile.get(profile) ?? new Set<string>();
      for (const skill of profileSkills) {
        if (requested.has(skill)) {
          matched.add(skill);
        }
      }
      for (const skill of stateSkillsByApp.get(app) ?? []) {
        if (requested.has(skill)) {
          matched.add(skill);
        }
      }
    }

    if (matched.size === 0) {
      return [];
    }

    const scoped: Record<string, unknown> = { ...entry, skills: [...matched] };
    if (profile) {
      delete scoped.profile;
    }
    return [scoped];
  });

  if (installs.length === 0) {
    throw new Error(`Upgrade --skills matched no lock installs: ${requestedSkills.join(", ")}`);
  }
  return { ...lock, installs };
}

function upgradeCommand(args: SkillpoolUpgradeArgs, options: UpgradeOptions): void {
  const projectDir = resolveProjectDir(args);
  const dryRun = Boolean(args["dry-run"] || args.dryRun);
  const installAfterUpgrade = args.install !== false;
  const loaded = loadLockfile(projectDir, args);
  const lock = loaded.lock as LockfileShape;
  const lockErrors = validateLockShape(loaded.lock);

  if (lockErrors.length) {
    throw new Error(`Invalid lockfile (${loaded.lockfilePath}):\n- ${lockErrors.join("\n- ")}`);
  }

  const hasRefOrRepo = Boolean(args.ref || args.repo);
  const requestedSkills = resolveRequestedSkills(args);

  if (!hasRefOrRepo && requestedSkills.length === 0) {
    throw new Error("upgrade requires --ref and/or --repo");
  }

  // A skill-scoped refresh without --ref/--repo must never rewrite lock.repo/ref.
  const refreshOnly = requestedSkills.length > 0 && !hasRefOrRepo;
  const stateSkillResolution = readStateSkillResolution(projectDir);
  const profileResolution = resolveProfileSkills(lock, args, projectDir);
  if (installAfterUpgrade && requestedSkills.length > 0) {
    assertRequestedSkillsKnown(lock, requestedSkills, stateSkillResolution.skills, profileResolution);
  }

  const oldRef = lock.ref;
  const oldRepo = lock.repo;
  const previousLock = structuredClone(lock) as LockfileShape;
  const writeLockfileFn = options.writeLockfile ?? writeLockfile;
  const markerPath = recoveryMarkerPath(loaded.lockfilePath);
  if (!dryRun) {
    assertNoRecoveryMarker(markerPath);
  }

  if (args.ref) {
    lock.ref = args.ref as string;
  }
  if (args.repo) {
    lock.repo = args.repo as string;
  }

  if (installAfterUpgrade) {
    console.log(refreshOnly ? "-> Refreshing requested skills" : "-> Reinstalling with upgraded lockfile");
    if (!dryRun && !refreshOnly) {
      // Promote the lock before mutating installed content. A failed promotion
      // therefore leaves the old install and state untouched.
      writeLockfileFn(loaded.lockfilePath, lock);
    }
    // Keep the temp name hidden, but never let it start with ".." — the path
    // guard reads a leading ".." as parent traversal, and lockfile basenames
    // are dotfiles already.
    const lockfileBaseName = path.basename(loaded.lockfilePath);
    const hiddenTempBase = lockfileBaseName.startsWith(".") ? lockfileBaseName : `.${lockfileBaseName}`;
    const temporaryLockfilePath = options.temporaryLockfilePath?.(loaded.lockfilePath) || path.join(
      path.dirname(loaded.lockfilePath),
      `${hiddenTempBase}.upgrade-${process.pid}-${Date.now()}.tmp`,
    );
    const scopedInstall = requestedSkills.length > 0;
    const installLock = scopedInstall
      ? scopedLock(lock, requestedSkills, stateSkillResolution.skillsByApp, profileResolution)
      : lock;
    let temporaryLockfileCreated = false;
    if (dryRun || scopedInstall) {
      writeTemporaryLockfileExclusive(temporaryLockfilePath, installLock);
      temporaryLockfileCreated = true;
    }
    const installArgs: SkillpoolUpgradeArgs = {
      ...args,
      ...(dryRun || scopedInstall ? { lockfile: path.relative(projectDir, temporaryLockfilePath) } : {}),
      "refresh-cache": true,
      refreshCache: true,
    };
    delete installArgs.app;
    try {
      options.installCommand(installArgs);
    } catch (error) {
      if (!dryRun && !refreshOnly) {
        try {
          writeLockfileFn(loaded.lockfilePath, previousLock);
        } catch (recoveryError) {
          try {
            writeRecoveryMarker(markerPath, loaded.lockfilePath, previousLock, error, recoveryError);
          } catch (markerError) {
            throw new AggregateError(
              [error, recoveryError, markerError],
              `Upgrade reinstall failed: ${errorMessage(error)}; lock recovery failed: ${errorMessage(recoveryError)}; recovery marker write failed: ${errorMessage(markerError)}`,
            );
          }
          throw new AggregateError(
            [error, recoveryError],
            `Upgrade reinstall failed: ${errorMessage(error)}; lock recovery failed: ${errorMessage(recoveryError)}. Recovery marker: ${markerPath}`,
          );
        }
      }
      throw error;
    } finally {
      if (temporaryLockfileCreated) {
        // The scoped/dry-run installer must read a candidate lock without touching the canonical lock.
        fs.rmSync(temporaryLockfilePath, { force: true });
      }
    }
  }

  if (!dryRun && !installAfterUpgrade && !refreshOnly) {
    writeLockfileFn(loaded.lockfilePath, lock);
  }

  if (refreshOnly) {
    if (!installAfterUpgrade) {
      console.log("Skill refresh skipped (--no-install); lockfile unchanged");
      return;
    }
    console.log(`Skills refreshed from lockfile: ${loaded.lockfilePath}${dryRun ? " (dry-run)" : ""}`);
    console.log(`- skills: ${requestedSkills.join(", ")}`);
    return;
  }
  console.log(`Lockfile updated: ${loaded.lockfilePath}${dryRun ? " (dry-run)" : ""}`);
  console.log(`- repo: ${oldRepo} -> ${lock.repo}`);
  console.log(`- ref:  ${oldRef} -> ${lock.ref}`);
}

export {
  upgradeCommand,
};
