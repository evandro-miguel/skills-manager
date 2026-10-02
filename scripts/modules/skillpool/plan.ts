#!/usr/bin/env bun

import { parseCsv } from "../../lib/args.ts";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const ALLOWED_POLICY_KEYS = new Set([
  "minPoolVersion",
  "requireRefExists",
  "requireSignedTag",
  "requireSourceCommit",
  "sourceCommit",
  "expectedSourceSha256",
  "requireSourceChecksum",
  "requireReleaseManifest",
  "releaseTag",
  "releaseManifestPath",
  "expectedReleaseManifestSha256",
  "requireSkillBom",
  "skillBomPath",
  "expectedSkillBomSha256",
  "requireCosignBundles",
  "cosign",
  "requireGithubAttestation",
  "githubAttestation",
  "allowGlobalCoreProjectSkills",
  "requireProjectionDigests",
  "expectedProjectionDigests",
]);

interface InstallEntry {
  app?: unknown;
  profile?: unknown;
  skills?: unknown;
  installMode?: unknown;
}

interface LockPolicy {
  minPoolVersion?: unknown;
  requireRefExists?: unknown;
  requireSignedTag?: unknown;
  requireSourceCommit?: unknown;
  sourceCommit?: unknown;
  expectedSourceSha256?: unknown;
  requireSourceChecksum?: unknown;
  requireReleaseManifest?: unknown;
  releaseTag?: unknown;
  releaseManifestPath?: unknown;
  expectedReleaseManifestSha256?: unknown;
  requireSkillBom?: unknown;
  skillBomPath?: unknown;
  expectedSkillBomSha256?: unknown;
  requireCosignBundles?: unknown;
  cosign?: unknown;
  requireGithubAttestation?: unknown;
  githubAttestation?: unknown;
  allowGlobalCoreProjectSkills?: unknown;
  requireProjectionDigests?: unknown;
  expectedProjectionDigests?: unknown;
}

interface ExpectedProjectionDigest {
  provider?: unknown;
  app?: unknown;
  skill?: unknown;
  canonicalDigest?: unknown;
  projectionDigest?: unknown;
  rendererVersion?: unknown;
  projectionPath?: unknown;
}

interface SourceLockBindingShape {
  path?: unknown;
  sha256?: unknown;
  entryName?: unknown;
}

interface LockShape {
  repo?: unknown;
  ref?: unknown;
  installs?: unknown;
  policy?: unknown;
  sourceLock?: unknown;
}

interface DirectInstallArgs {
  app?: unknown;
  profile?: unknown;
  skills?: unknown;
  repo?: unknown;
  ref?: unknown;
  source?: unknown;
  skillPath?: unknown;
}

interface InstallPlan {
  repo: unknown;
  ref: unknown;
  source: unknown;
  policy: unknown;
  installs: unknown;
}

function normalizeSemver(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const clean = String(value).trim().replace(/^v/, "");
  if (!SEMVER_PATTERN.test(clean)) {
    return null;
  }
  return clean;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number(x));
  const pb = b.split(".").map((x) => Number(x));
  for (let i = 0; i < 3; i += 1) {
    const ai = pa[i]!;
    const bi = pb[i]!;
    if (ai > bi) {
      return 1;
    }
    if (ai < bi) {
      return -1;
    }
  }
  return 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function normalizeSkillPath(skillPath: string): string {
  const value = skillPath.trim();
  if (!value) {
    throw new Error("Invalid --skill-path: value must be non-empty");
  }
  if (value.includes("\\")) {
    throw new Error("Invalid --skill-path: backslashes are not allowed");
  }
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    throw new Error("Invalid --skill-path: must be a relative path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment)) {
    throw new Error("Invalid --skill-path: path segments must be non-empty");
  }
  if (segments[0] !== "skills") {
    throw new Error("Invalid --skill-path: must start with skills/");
  }
  if (segments.slice(1).some((segment) => segment === ".." || segment.includes(".."))) {
    throw new Error("Invalid --skill-path: path traversal is not allowed");
  }
  const skillsSegments = segments.filter((segment) => segment === "skills");
  if (skillsSegments.length > 1) {
    throw new Error("Invalid --skill-path: multiple skills segments are not allowed");
  }

  return segments[1]!;
}

function validateExpectedProjectionDigests(policy: LockPolicy, errors: string[]): Set<string> | null {
  const projectionEntries = policy.expectedProjectionDigests;
  if (projectionEntries === undefined) {
    return null;
  }
  if (!Array.isArray(projectionEntries) || projectionEntries.length === 0) {
    errors.push("lockfile.policy.expectedProjectionDigests must be a non-empty array when requireProjectionDigests=true");
    return null;
  }

  const keys = new Set<string>();
  projectionEntries.forEach((rawEntry: ExpectedProjectionDigest, index: number) => {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      errors.push(`lockfile.policy.expectedProjectionDigests[${index}] must be an object`);
      return;
    }
    const provider = isNonEmptyString(rawEntry.provider)
      ? rawEntry.provider.trim()
      : isNonEmptyString(rawEntry.app)
        ? rawEntry.app.trim()
        : null;
    if (!provider) {
      errors.push(`lockfile.policy.expectedProjectionDigests[${index}].provider must be a string`);
    }
    if (!isNonEmptyString(rawEntry.skill)) {
      errors.push(`lockfile.policy.expectedProjectionDigests[${index}].skill must be a string`);
    }
    if (!isSha256(rawEntry.canonicalDigest)) {
      errors.push(`lockfile.policy.expectedProjectionDigests[${index}].canonicalDigest must be 64-char hex string`);
    }
    if (!isSha256(rawEntry.projectionDigest)) {
      errors.push(`lockfile.policy.expectedProjectionDigests[${index}].projectionDigest must be 64-char hex string`);
    }
    if (!Number.isInteger(rawEntry.rendererVersion) || Number(rawEntry.rendererVersion) < 1) {
      errors.push(`lockfile.policy.expectedProjectionDigests[${index}].rendererVersion must be a positive integer`);
    }
    if (rawEntry.projectionPath !== undefined && !isNonEmptyString(rawEntry.projectionPath)) {
      errors.push(`lockfile.policy.expectedProjectionDigests[${index}].projectionPath must be string when provided`);
    }
    if (provider && isNonEmptyString(rawEntry.skill)) {
      keys.add(`${provider}/${rawEntry.skill.trim()}`);
    }
  });
  return keys;
}

function validateSourceLockBinding(lockObject: LockShape, errors: string[]): void {
  const binding = lockObject.sourceLock;
  if (binding === undefined) {
    return;
  }
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    errors.push("lockfile.sourceLock must be an object when provided");
    return;
  }
  const record = binding as SourceLockBindingShape;
  if (typeof record.path !== "string" || !record.path.trim()) {
    errors.push("lockfile.sourceLock.path must be a non-empty string");
  }
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.sha256)) {
    errors.push("lockfile.sourceLock.sha256 must be 64-char hex string");
  }
  if (typeof record.entryName !== "string" || !record.entryName.trim()) {
    errors.push("lockfile.sourceLock.entryName must be a non-empty string");
  }
}

function validateRemoteLockPolicy(
  lockObject: LockShape,
  policy: LockPolicy | null,
  projectionKeys: Set<string> | null,
  errors: string[]
): void {
  if (!isNonEmptyString(lockObject.repo)) {
    return;
  }

  if (!policy) {
    errors.push("lockfile.policy is required for remote lockfiles");
    return;
  }

  if (policy.requireSourceCommit !== true) {
    errors.push("lockfile.policy.requireSourceCommit must be true for remote lockfiles");
  }
  if (policy.requireSourceChecksum !== true) {
    errors.push("lockfile.policy.requireSourceChecksum must be true for remote lockfiles");
  }
  if (policy.requireProjectionDigests !== true) {
    errors.push("lockfile.policy.requireProjectionDigests must be true for remote lockfiles");
  }
  if (!Array.isArray(policy.expectedProjectionDigests) || policy.expectedProjectionDigests.length === 0) {
    errors.push("lockfile.policy.expectedProjectionDigests must be a non-empty array when requireProjectionDigests=true");
  }

  if (!projectionKeys || !Array.isArray(lockObject.installs)) {
    return;
  }
  for (const entry of lockObject.installs as InstallEntry[]) {
    if (!entry || typeof entry !== "object" || !isNonEmptyString(entry.app) || !Array.isArray(entry.skills)) {
      continue;
    }
    for (const rawSkill of entry.skills) {
      if (!isNonEmptyString(rawSkill)) {
        continue;
      }
      const key = `${entry.app.trim()}/${rawSkill.trim()}`;
      if (!projectionKeys.has(key)) {
        errors.push(`lockfile.policy.expectedProjectionDigests missing ${key}`);
      }
    }
  }
}

function validateLockShape(lock: unknown): string[] {
  const errors: string[] = [];
  const lockObject = lock as LockShape;
  let parsedPolicy: LockPolicy | null = null;
  let projectionKeys: Set<string> | null = null;

  if (!lock || typeof lock !== "object") {
    errors.push("lockfile must be a JSON object");
    return errors;
  }

  if (!lockObject.repo || typeof lockObject.repo !== "string") {
    errors.push("lockfile.repo must be a string");
  }

  if (!lockObject.ref || typeof lockObject.ref !== "string") {
    errors.push("lockfile.ref must be a string");
  }

  if (!Array.isArray(lockObject.installs) || lockObject.installs.length === 0) {
    errors.push("lockfile.installs must be a non-empty array");
  }

  if (Array.isArray(lockObject.installs)) {
    lockObject.installs.forEach((entry: InstallEntry, index: number) => {
      if (!entry || typeof entry !== "object") {
        errors.push(`installs[${index}] must be an object`);
        return;
      }
      if (!entry.app || typeof entry.app !== "string") {
        errors.push(`installs[${index}].app must be a string`);
      }
      if (!entry.profile && !Array.isArray(entry.skills)) {
        errors.push(`installs[${index}] must include profile or skills[]`);
      }
      if (entry.skills && !Array.isArray(entry.skills)) {
        errors.push(`installs[${index}].skills must be an array when provided`);
      }
      if (entry.profile && typeof entry.profile !== "string") {
        errors.push(`installs[${index}].profile must be a string when provided`);
      }
      if (
        entry.installMode !== undefined &&
        entry.installMode !== "projection" &&
        entry.installMode !== "copy"
      ) {
        errors.push(`installs[${index}].installMode must be projection or copy`);
      }
    });
  }

  if (lockObject.policy !== undefined) {
    if (
      !lockObject.policy ||
      typeof lockObject.policy !== "object" ||
      Array.isArray(lockObject.policy)
    ) {
      errors.push("lockfile.policy must be an object when provided");
    } else {
      const policy = lockObject.policy as LockPolicy;
      parsedPolicy = policy;

      for (const key of Object.keys(policy)) {
        if (!ALLOWED_POLICY_KEYS.has(key)) {
          errors.push(`lockfile.policy.${key} is not supported`);
        }
      }

      if (
        policy.minPoolVersion !== undefined &&
        (typeof policy.minPoolVersion !== "string" ||
          !normalizeSemver(policy.minPoolVersion))
      ) {
        errors.push("lockfile.policy.minPoolVersion must be semver string (x.y.z)");
      }

      if (
        policy.requireRefExists !== undefined &&
        typeof policy.requireRefExists !== "boolean"
      ) {
        errors.push("lockfile.policy.requireRefExists must be boolean");
      }

      if (
        policy.requireSignedTag !== undefined &&
        typeof policy.requireSignedTag !== "boolean"
      ) {
        errors.push("lockfile.policy.requireSignedTag must be boolean");
      }

      if (
        policy.requireSourceCommit !== undefined &&
        typeof policy.requireSourceCommit !== "boolean"
      ) {
        errors.push("lockfile.policy.requireSourceCommit must be boolean");
      }

      if (
        policy.sourceCommit !== undefined &&
        (typeof policy.sourceCommit !== "string" ||
          !/^[a-f0-9]{40}$/i.test(policy.sourceCommit))
      ) {
        errors.push("lockfile.policy.sourceCommit must be full 40-char git SHA");
      }
      if (policy.requireSourceCommit === true && policy.sourceCommit === undefined) {
        errors.push("lockfile.policy.requireSourceCommit requires lockfile.policy.sourceCommit");
      }

      if (
        policy.expectedSourceSha256 !== undefined &&
        (typeof policy.expectedSourceSha256 !== "string" ||
          !/^[a-f0-9]{64}$/i.test(policy.expectedSourceSha256))
      ) {
        errors.push("lockfile.policy.expectedSourceSha256 must be 64-char hex string");
      }

      if (
        policy.requireSourceChecksum !== undefined &&
        typeof policy.requireSourceChecksum !== "boolean"
      ) {
        errors.push("lockfile.policy.requireSourceChecksum must be boolean");
      }
      if (policy.requireSourceChecksum === true && policy.expectedSourceSha256 === undefined) {
        errors.push("lockfile.policy.requireSourceChecksum requires lockfile.policy.expectedSourceSha256");
      }

      if (
        policy.requireReleaseManifest !== undefined &&
        typeof policy.requireReleaseManifest !== "boolean"
      ) {
        errors.push("lockfile.policy.requireReleaseManifest must be boolean");
      }

      if (
        policy.releaseTag !== undefined &&
        (typeof policy.releaseTag !== "string" || !/^v\d+\.\d+\.\d+$/.test(policy.releaseTag))
      ) {
        errors.push("lockfile.policy.releaseTag must be release tag string (vX.Y.Z)");
      }

      if (
        policy.releaseManifestPath !== undefined &&
        (typeof policy.releaseManifestPath !== "string" || !policy.releaseManifestPath.trim())
      ) {
        errors.push("lockfile.policy.releaseManifestPath must be string when provided");
      }

      if (
        policy.expectedReleaseManifestSha256 !== undefined &&
        (typeof policy.expectedReleaseManifestSha256 !== "string" ||
          !/^[a-f0-9]{64}$/i.test(policy.expectedReleaseManifestSha256))
      ) {
        errors.push("lockfile.policy.expectedReleaseManifestSha256 must be 64-char hex string");
      }

      if (
        policy.requireSkillBom !== undefined &&
        typeof policy.requireSkillBom !== "boolean"
      ) {
        errors.push("lockfile.policy.requireSkillBom must be boolean");
      }

      if (
        policy.skillBomPath !== undefined &&
        (typeof policy.skillBomPath !== "string" || !policy.skillBomPath.trim())
      ) {
        errors.push("lockfile.policy.skillBomPath must be string when provided");
      }

      if (
        policy.expectedSkillBomSha256 !== undefined &&
        (typeof policy.expectedSkillBomSha256 !== "string" ||
          !/^[a-f0-9]{64}$/i.test(policy.expectedSkillBomSha256))
      ) {
        errors.push("lockfile.policy.expectedSkillBomSha256 must be 64-char hex string");
      }

      if (
        policy.allowGlobalCoreProjectSkills !== undefined &&
        typeof policy.allowGlobalCoreProjectSkills !== "boolean"
      ) {
        errors.push("lockfile.policy.allowGlobalCoreProjectSkills must be boolean");
      }

      if (
        policy.requireProjectionDigests !== undefined &&
        typeof policy.requireProjectionDigests !== "boolean"
      ) {
        errors.push("lockfile.policy.requireProjectionDigests must be boolean");
      }
      projectionKeys = validateExpectedProjectionDigests(policy, errors);
      if (policy.requireProjectionDigests === true && projectionKeys === null) {
        errors.push("lockfile.policy.expectedProjectionDigests must be a non-empty array when requireProjectionDigests=true");
      }

      if (
        policy.requireCosignBundles !== undefined &&
        typeof policy.requireCosignBundles !== "boolean"
      ) {
        errors.push("lockfile.policy.requireCosignBundles must be boolean");
      }
      if (policy.requireCosignBundles === true) {
        errors.push("UNSUPPORTED_PROVENANCE_POLICY: lockfile.policy.requireCosignBundles is not supported by the current local verifier");
      }
      if (policy.cosign !== undefined) {
        errors.push("lockfile.policy.cosign is not supported by the current local verifier");
      }
      if (
        policy.requireGithubAttestation !== undefined &&
        typeof policy.requireGithubAttestation !== "boolean"
      ) {
        errors.push("lockfile.policy.requireGithubAttestation must be boolean");
      }
      if (policy.requireGithubAttestation === true) {
        errors.push("UNSUPPORTED_PROVENANCE_POLICY: lockfile.policy.requireGithubAttestation is not supported by the current local verifier");
      }
      if (policy.githubAttestation !== undefined) {
        errors.push("lockfile.policy.githubAttestation is not supported by the current local verifier");
      }
    }
  }

  validateSourceLockBinding(lockObject, errors);

  validateRemoteLockPolicy(lockObject, parsedPolicy, projectionKeys, errors);

  return errors;
}

function buildInstallPlan(args: DirectInstallArgs, lock: LockShape | null): InstallPlan {
  if (args.app) {
    const directSkills = parseCsv(args.skills);
    const hasRemoteRepo = isNonEmptyString(args.repo) && !isNonEmptyString(args.source);
    const hasExplicitSkills = Object.prototype.hasOwnProperty.call(args, "skills") || Object.prototype.hasOwnProperty.call(args, "skill");
    let finalSkills = directSkills;

    if (isNonEmptyString(args.skillPath)) {
      const derivedSkill = normalizeSkillPath(args.skillPath);
      if (!hasExplicitSkills) {
        finalSkills = [derivedSkill];
      }
    } else if (args.skillPath !== undefined) {
      throw new Error("Invalid --skill-path: value must be a non-empty string");
    }

    if (hasRemoteRepo && !isNonEmptyString(args.ref)) {
      throw new Error("Remote install requires explicit --ref; refusing to default to floating main");
    }
    return {
      repo: args.repo,
      ref: isNonEmptyString(args.ref) ? args.ref.trim() : undefined,
      source: args.source,
      policy: null,
      installs: [
        {
          app: args.app,
          profile: args.profile,
          skills: finalSkills,
        },
      ],
    };
  }

  if (!lock) {
    throw new Error(
      "No install source provided. Use lockfile mode or pass --app with --skills/--profile and --repo."
    );
  }

  return {
    repo: lock.repo,
    ref: lock.ref,
    source: args.source,
    policy: lock.policy || null,
    installs: lock.installs,
  };
}

export {
  buildInstallPlan,
  compareSemver,
  normalizeSemver,
  validateLockShape,
};
