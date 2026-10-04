#!/usr/bin/env bun
/**
 * skill-sys is the public command surface for the Universal Skills toolchain.
 * Existing skillpool commands remain available as compatibility backends.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCliOptions, type CliOptionSpec } from "../lib/args.ts";
import { listFilesRecursive } from "../lib/files.ts";
import { runCommand, type RunCommandResult } from "../lib/command.ts";
import { assertSafeGitRef } from "../lib/git-ref.ts";
import {
  assertNoCredentialedHttpSource,
  assertNoUnsafeHomeRefs,
  assertSafeRemoteUrl,
  isRemoteSpec,
} from "../lib/source-host.ts";
import {
  assertNoSensitiveFindings,
  scanSensitiveFiles,
} from "../modules/skillpool/sensitive-scan.ts";
import {
  fetchExactRef,
  resolveRemoteRef,
} from "../modules/skillpool/cache.ts";
import {
  publicSkillSysCommands,
  resolveSkillSysCommandName,
  SKILL_SYS_COMMANDS,
} from "../modules/skill-sys/command-registry.ts";
import {
  applyRemove,
  normalizeRemoveArgs,
  planRemove,
  renderRemoveApplyResult,
  renderRemovePlan,
} from "../modules/skillpool/remove.ts";
import {
  normalizeSandboxArgs,
  planSandbox,
  renderSandboxVerdict,
} from "../modules/skillpool/sandbox-plan.ts";
import {
  resolveSourceLayout,
} from "../modules/skillpool/source.ts";

type CliValue = boolean | string | string[];

type SkillSysArgs = {
  _: string[];
  [key: string]: CliValue | undefined;
};

export type ParsedSkillSysCli = {
  command: string;
  args: SkillSysArgs;
};

export type NormalizedSourceSpec = {
  kind: "source" | "repo";
  value: string;
  ref?: string;
  skillPath?: string;
};

export type SkillSysCommandPlan = {
  argv: string[];
};

export type ContextBundleTier = "quick" | "standard" | "deep";

export type ContextBundleFormat = "markdown" | "json";

export type ContextBundleFile = {
  path: string;
  chars: number;
  approxTokens: number;
  content: string;
};

export type ContextBundle = {
  skill: string;
  tier: ContextBundleTier;
  files: ContextBundleFile[];
  chars: number;
  approxTokens: number;
};

type SkillSysDeps = {
  run?: (argv: string[]) => RunCommandResult;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  cwd?: string;
};

const BOOLEAN_OPTIONS = new Set([
  "all",
  "delete",
  "delete-extra",
  "dry-run",
  "force",
  "global",
  "global-core",
  "verify-upstream",
  "apply",
  "globals",
  "hashes",
  "help",
  "include-experimental",
  "include-internal",
  "install",
  "include-user",
  "json",
  "local-ok",
  "names-only",
  "online",
  "clean",
  "check",
  "budget",
  "confirm-all",
  "plan",
  "explain",
  "repair",
  "run",
  "execute",
  "duplicates",
  "permissions",
  "no-contract-check",
  "no-global-sync",
  "no-install",
  "no-require-ref-exists",
  "refresh-cache",
  "require-cosign-bundles",
  "require-github-attestation",
  "require-ref-exists",
  "require-release-manifest",
  "require-signed-tag",
  "require-skill-bom",
  "require-source-checksum",
  "require-source-commit",
  "state-safety",
  "strict",
  "strict-hash",
  "verify-signed-tag",
  "yes-i-understand-overwrite",
  "debug-state",
  "allow-public-after-explicit-user-approval",
  "legacy-raw-install",
]);

const VALUE_OPTIONS = new Set([
  "agent",
  "adapter",
  "allowlist",
  "app",
  "apps",
  "bundle",
  "category",
  "case-ids",
  "config",
  "expected-release-manifest-sha256",
  "expected-skill-bom-sha256",
  "expected-source-sha256",
  "fixture-digest",
  "format",
  "from",
  "home",
  "manager",
  "reference",
  "id",
  "install-id",
  "install-mode",
  "learnings",
  "lockfile",
  "manifest",
  "mount",
  "max-budget",
  "memory",
  "name",
  "policy-file",
  "profile",
  "projection-dir",
  "projection-store-dir",
  "profiles-root",
  "project",
  "provider",
  "providers",
  "query",
  "rules",
  "ref",
  "release-manifest-path",
  "repo",
  "repository",
  "results",
  "scorecard",
  "skill",
  "skill-bom-path",
  "skills",
  "skills-root",
  "source",
  "source-digest",
  "source-commit",
  "source-entry",
  "source-lock",
  "stack",
  "summary",
  "surface",
  "sync-globals",
  "tag",
  "target",
  "tier",
  "to",
  "user-root",
  "receipt",
  "model",
  "version",
  "visibility",
  "workflow",
  "out-dir",
  "output",
  "policy",
]);

const SKILL_SYS_PARSE_SPEC: CliOptionSpec = {
  boolean: BOOLEAN_OPTIONS,
  value: VALUE_OPTIONS,
};

const REPO_ROOT = path.resolve(__dirname, "../..");
const COMMANDS_DIR = path.join(REPO_ROOT, "scripts", "commands");
const FRONTEND_HELP_COMMANDS = new Set([
  "add",
  "install",
  "update",
  "upgrade",
  "doctor",
  "validate",
  "scan-security",
  "context",
  "use",
  "remove",
  "verify-sandbox",
]);

function commandPath(scriptName: string): string {
  return path.join(COMMANDS_DIR, scriptName);
}

function cwdOption(cwd: string | undefined): { cwd?: string } {
  return cwd === undefined ? {} : { cwd };
}

export function parseCli(argv: string[]): ParsedSkillSysCli {
  const rawCommand = argv[2];
  const commandToken = rawCommand && !rawCommand.startsWith("-") ? rawCommand : "help";
  const resolvedCommand = commandToken === "help" ? "help" : resolveSkillSysCommandName(commandToken) || commandToken;
  const startIndex = rawCommand && !rawCommand.startsWith("-") ? 3 : 2;
  const args = parseCliOptions(argv, startIndex, SKILL_SYS_PARSE_SPEC, {
    repeat: "collect",
    strict: true,
  }) as SkillSysArgs;

  return { command: resolvedCommand, args };
}

function boolArg(args: SkillSysArgs, key: string): boolean {
  return args[key] === true;
}

function stringArg(args: SkillSysArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === false) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value[value.length - 1];
  }
  return String(value);
}

function appendValue(argv: string[], flag: string, value: string | undefined): void {
  if (value === undefined || value === "") {
    return;
  }
  argv.push(flag, value);
}

function appendBoolean(argv: string[], args: SkillSysArgs, key: string, flag = `--${key}`): void {
  if (boolArg(args, key)) {
    argv.push(flag);
  }
}

function appendPassthroughValues(argv: string[], args: SkillSysArgs, mappings: Array<[string, string]>): void {
  for (const [key, flag] of mappings) {
    appendValue(argv, flag, stringArg(args, key));
  }
}

function isGithubShorthand(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function normalizeSafeSourceRef(rawRef: string | undefined): string | undefined {
  if (rawRef === undefined || rawRef === "") {
    throw new Error("Source ref must be a non-empty string");
  }

  return assertSafeGitRef(rawRef, "Source ref");
}

function parseGithubTreeUrl(raw: string): { repo: string; ref: string; skillPath: string } | null {
  if (!raw.startsWith("https://github.com/") && !raw.startsWith("http://github.com/")) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.hostname !== "github.com") {
    return null;
  }

  const [rawPathRaw] = raw.split(/[?#]/);
  const rawPath = (rawPathRaw ?? raw).replace(/^https?:\/\/github\.com\//i, "");
  const rawSegments = rawPath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
  if (rawSegments[2] !== "tree") {
    return null;
  }

  if (rawSegments.length < 4) {
    throw new Error("Unsupported GitHub tree source format");
  }

  const [owner, repo, , ...rawTail] = rawSegments;
  if (!owner || !repo || rawTail.length === 0) {
    return null;
  }

  const skillPathCandidates = rawTail
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment === "skills")
    .map(({ index }) => index)
    .filter((pathStart) => pathStart > 0);

  if (skillPathCandidates.length === 0) {
    throw new Error("Unsupported GitHub tree source path: expected path starting with skills/");
  }

  const matchingCandidates = skillPathCandidates.filter((pathStart) => {
    const refCandidate = rawTail.slice(0, pathStart).join("/");
    try {
      return assertSafeGitRef(refCandidate, "tree ref") !== "";
    } catch {
      return false;
    }
  });

  if (matchingCandidates.length === 0) {
    throw new Error("Unsupported GitHub tree source path: unsafe ref or unsupported split");
  }

  if (matchingCandidates.length > 1) {
    throw new Error("Ambiguous GitHub tree source path: multiple possible slash-separated refs");
  }

  const pathStart = matchingCandidates[0] as number;
  const rawRef = rawTail.slice(0, pathStart).join("/");
  const rawSkillPathSegments = rawTail.slice(pathStart);

  const safeRef = assertSafeGitRef(rawRef, "tree ref");

  if (rawSkillPathSegments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(".."))) {
    throw new Error("Unsafe skill path in tree URL");
  }

  const rawSkillPath = rawSkillPathSegments.join("/");
  let decodedPath = "";
  try {
    decodedPath = decodeURIComponent(rawSkillPath);
  } catch {
    throw new Error("Unsafe skill path in tree URL");
  }

  if (decodedPath.includes("\\") || path.posix.isAbsolute(decodedPath) || decodedPath.startsWith(".")) {
    throw new Error("Unsafe skill path in tree URL");
  }

  const skillSegments = decodedPath.split("/");
  if (skillSegments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(".."))) {
    throw new Error("Unsafe skill path in tree URL");
  }

  return {
    repo: `https://github.com/${owner}/${repo}.git`,
    ref: safeRef,
    skillPath: decodedPath,
  };
}

function parseGitlabTreeUrl(raw: string): { repo: string; ref: string; skillPath: string } | null {
  if (!raw.startsWith("https://gitlab.com/") && !raw.startsWith("http://gitlab.com/")) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.hostname !== "gitlab.com") return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  const marker = parts.findIndex((part, index) => part === "-" && parts[index + 1] === "tree");
  if (marker < 2 || parts.length <= marker + 3) {
    throw new Error("Unsupported GitLab tree source format");
  }
  const skillIndex = parts.findIndex((part, index) => index > marker + 1 && part === "skills");
  if (skillIndex < 0) {
    throw new Error("Unsupported GitLab tree source path: expected path starting with skills/");
  }
  const refParts = parts.slice(marker + 2, skillIndex);
  const pathParts = parts.slice(skillIndex);
  if (!refParts.length || pathParts.length < 2) {
    throw new Error("Unsupported GitLab tree source format");
  }
  const safeRef = assertSafeGitRef(refParts.join("/"), "tree ref");
  let skillPath: string;
  try {
    skillPath = decodeURIComponent(pathParts.join("/"));
  } catch {
    throw new Error("Unsafe skill path in tree URL");
  }
  const segments = skillPath.split("/");
  if (skillPath.includes("\\") || path.posix.isAbsolute(skillPath) || segments.some((part) => !part || part === "." || part === ".." || part.includes(".."))) {
    throw new Error("Unsafe skill path in tree URL");
  }
  return {
    repo: `https://gitlab.com/${parts.slice(0, marker).join("/")}.git`,
    ref: safeRef,
    skillPath,
  };
}

function assertNoSymlinkSourcePath(localPath: string): void {
  let cursor = path.resolve(localPath);
  while (true) {
    if (fs.existsSync(cursor)) {
      const lstat = fs.lstatSync(cursor);
      if (lstat.isSymbolicLink()) {
        throw new Error("Source path traversal through symlinks is not allowed");
      }
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return;
    }

    cursor = parent;
  }
}

function assertSourcePathWithinRoot(spec: string, root: string): void {
  if (path.isAbsolute(spec)) {
    return;
  }

  if (spec === ".." || spec.startsWith(`..${path.sep}`) || path.normalize(spec).startsWith(`..${path.sep}`)) {
    const candidate = path.resolve(root, spec);
    const relative = path.relative(path.resolve(root), candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("Source path traversal is not allowed");
    }
  }
}

export function normalizeSourceSpec(raw: string, options: { cwd?: string } = {}): NormalizedSourceSpec {
  const cwd = options.cwd || process.cwd();
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Source must be a non-empty string");
  }

  assertNoUnsafeHomeRefs(trimmed);
  assertNoCredentialedHttpSource(trimmed);

  const hashIndex = trimmed.lastIndexOf("#");
  const spec = hashIndex > 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const ref = hashIndex > 0 ? normalizeSafeSourceRef(trimmed.slice(hashIndex + 1)) : undefined;
  assertSourcePathWithinRoot(spec, cwd);
  const localPath = path.resolve(cwd, spec);

  if (fs.existsSync(localPath)) {
    assertNoSymlinkSourcePath(localPath);
    const stats = fs.statSync(localPath);
    if (stats.isDirectory()) {
      const parent = path.dirname(localPath);
      if (path.basename(parent) === "skills") {
        const skillName = path.basename(localPath);
        const skillManifest = path.join(localPath, "SKILL.md");
        if (!fs.existsSync(skillManifest)) {
          throw new Error(`Local skill directory '${raw}' must include SKILL.md at ${path.join(localPath, "SKILL.md")}`);
        }

        const result: NormalizedSourceSpec = {
          kind: "source",
          value: path.dirname(parent),
          skillPath: `skills/${skillName}`,
        };
        if (ref) {
          result.ref = ref;
        }
        return result;
      }
    }

    const result: NormalizedSourceSpec = { kind: "source", value: localPath };
    if (ref) {
      result.ref = ref;
    }
    return result;
  }

  const tree = parseGithubTreeUrl(spec);
  if (tree !== null) {
    const result: NormalizedSourceSpec = { kind: "repo", value: tree.repo, skillPath: tree.skillPath, ref: ref ?? tree.ref };
    return result;
  }

  const gitlabTree = parseGitlabTreeUrl(spec);
  if (gitlabTree !== null) {
    return { kind: "repo", value: gitlabTree.repo, skillPath: gitlabTree.skillPath, ref: ref ?? gitlabTree.ref };
  }

  if (isGithubShorthand(spec)) {
    const result: NormalizedSourceSpec = { kind: "repo", value: `https://github.com/${spec}.git` };
    if (ref) {
      result.ref = ref;
    }
    return result;
  }

  if (isRemoteSpec(spec)) {
    assertSafeRemoteUrl(spec);
    const result: NormalizedSourceSpec = { kind: "repo", value: spec };
    if (ref) {
      result.ref = ref;
    }
    return result;
  }

  throw new Error(`Cannot classify source '${raw}'. Use a local path, Git URL, or owner/repo shorthand.`);
}

function buildSkillpoolInstallCommand(args: SkillSysArgs, mode: "add" | "install", cwd: string): SkillSysCommandPlan {
  const argv = ["bun", commandPath("skillpool.ts"), "install"];
  const sourceArg = mode === "add" ? args._[0] : undefined;

  if (sourceArg) {
    const source = normalizeSourceSpec(sourceArg, { cwd });
    argv.push(source.kind === "repo" ? "--repo" : "--source", source.value);
    if (source.ref && !stringArg(args, "ref")) {
      argv.push("--ref", source.ref);
    }
    if (source.skillPath) {
      argv.push("--skill-path", source.skillPath);

      const hasExplicitSkills =
        Object.prototype.hasOwnProperty.call(args, "skills") || Object.prototype.hasOwnProperty.call(args, "skill");
      if (!hasExplicitSkills) {
        const [, skillName] = source.skillPath.split("/");
        if (!skillName) {
          throw new Error(`Cannot derive skill name from skill-path '${source.skillPath}'`);
        }
        argv.push("--skills", skillName);
      }
    }
  }

  appendPassthroughValues(argv, args, [
    ["project", "--project"],
    ["lockfile", "--lockfile"],
    ["source", "--source"],
    ["repo", "--repo"],
    ["ref", "--ref"],
    ["app", "--app"],
    ["agent", "--app"],
    ["profile", "--profile"],
    ["projection-dir", "--projection-dir"],
    ["install-mode", "--install-mode"],
    ["skills", "--skills"],
    ["skill", "--skills"],
    ["expected-source-sha256", "--expected-source-sha256"],
  ]);
  appendBoolean(argv, args, "dry-run");
  appendBoolean(argv, args, "refresh-cache");
  appendBoolean(argv, args, "verify-signed-tag");
  appendBoolean(argv, args, "debug-state");

  const installMode = stringArg(args, "install-mode");
  if (installMode === "symlink") {
    throw new Error(
      "install-mode 'symlink' is dev/team-only and not allowed in public or release install"
    );
  }
  if (installMode && installMode !== "projection" && installMode !== "copy") {
    throw new Error(
      `Invalid install-mode '${installMode}'. Expected projection or copy.`
    );
  }

  // Map install-mode to legacy flag / projection-dir semantics
  if (installMode === "copy") {
    argv.push("--legacy-raw-install");
  } else if (installMode === "projection") {
    // projection-dir is already passed through via appendPassthroughValues
  } else {
    // No --install-mode specified: preserve existing --legacy-raw-install behavior
    appendBoolean(argv, args, "legacy-raw-install");
  }

  return { argv };
}

function buildSkillpoolUpgradeCommand(args: SkillSysArgs): SkillSysCommandPlan {
  const requestedSkill = args._[0];
  if (requestedSkill) {
    if (
      requestedSkill.includes("/") ||
      requestedSkill.includes("\\") ||
      requestedSkill === "." ||
      requestedSkill === ".." ||
      requestedSkill.includes("..")
    ) {
      throw new Error(
        `Invalid skill name '${requestedSkill}'. Use skill-sys update <skill> with a lock-declared skill name.`
      );
    }
  }
  const installMode = stringArg(args, "install-mode");
  if (installMode === "symlink") {
    throw new Error(
      "install-mode 'symlink' is dev/team-only and not allowed in public or release install"
    );
  }
  if (installMode && installMode !== "projection" && installMode !== "copy") {
    throw new Error(
      `Invalid install-mode '${installMode}'. Expected projection or copy.`
    );
  }
  const argv = ["bun", commandPath("skillpool.ts"), "upgrade"];
  appendPassthroughValues(argv, args, [
    ["project", "--project"],
    ["lockfile", "--lockfile"],
    ["source", "--source"],
    ["repo", "--repo"],
    ["ref", "--ref"],
    ["app", "--app"],
    ["agent", "--app"],
    ["projection-dir", "--projection-dir"],
    ["install-mode", "--install-mode"],
    ["expected-source-sha256", "--expected-source-sha256"],
    ["skills", "--skills"],
    ["skill", "--skills"],
  ]);
  if (requestedSkill) {
    argv.push("--skills", requestedSkill);
  }
  appendBoolean(argv, args, "dry-run");
  appendBoolean(argv, args, "no-install");
  appendBoolean(argv, args, "verify-signed-tag");

  // Map install-mode to legacy flag / projection-dir semantics (mirrors install)
  if (installMode === "copy") {
    argv.push("--legacy-raw-install");
  } else if (installMode === "projection") {
    // projection-dir is already passed through via appendPassthroughValues
  } else {
    // No --install-mode specified: preserve existing --legacy-raw-install behavior
    appendBoolean(argv, args, "legacy-raw-install");
  }
  return { argv };
}

function buildSkillpoolSimpleCommand(args: SkillSysArgs, command: "doctor" | "validate"): SkillSysCommandPlan {
  if (command === "doctor" && boolArg(args, "budget")) {
    const argv = ["bun", commandPath("budget-doctor.ts")];
    appendPassthroughValues(argv, args, [
      ["source", "--source"],
      ["provider", "--provider"],
      ["max-budget", "--budget"],
    ]);
    appendBoolean(argv, args, "global-core");
    appendBoolean(argv, args, "json");
    return { argv };
  }
  if (command === "doctor" && (boolArg(args, "duplicates") || boolArg(args, "permissions") || stringArg(args, "provider"))) {
    const argv = ["bun", commandPath("provider-doctor.ts")];
    appendPassthroughValues(argv, args, [
      ["source", "--source"],
      ["project", "--project"],
      ["provider", "--provider"],
    ]);
    appendBoolean(argv, args, "duplicates");
    appendBoolean(argv, args, "permissions");
    appendBoolean(argv, args, "json");
    return { argv };
  }

  const argv = ["bun", commandPath("skillpool.ts"), command];
  appendPassthroughValues(argv, args, [
    ["project", "--project"],
    ["lockfile", "--lockfile"],
    ["source", "--source"],
    ["expected-source-sha256", "--expected-source-sha256"],
  ]);
  appendBoolean(argv, args, "strict-hash");
  appendBoolean(argv, args, "state-safety");
  return { argv };
}

function buildListCommand(args: SkillSysArgs, searchMode: boolean): SkillSysCommandPlan {
  const argv = ["bun", commandPath("list-skills.ts")];
  const query = stringArg(args, "query") || (args._.length ? args._.join(" ") : undefined);
  appendPassthroughValues(argv, args, [
    ["skills-root", "--skills-root"],
    ["profiles-root", "--profiles-root"],
    ["stack", "--stack"],
    ["category", "--category"],
    ["tag", "--tag"],
    ["profile", "--profile"],
  ]);
  if (query || searchMode) {
    appendValue(argv, "--query", query || "");
  }
  appendBoolean(argv, args, "json");
  appendBoolean(argv, args, "names-only");
  appendBoolean(argv, args, "include-internal");
  appendBoolean(argv, args, "include-experimental");
  return { argv };
}

function buildSyncCommand(args: SkillSysArgs): SkillSysCommandPlan {
  if (boolArg(args, "global-core") || boolArg(args, "globals")) {
    const argv = ["bun", commandPath("sync-global-core.ts")];
    appendPassthroughValues(argv, args, [
      ["source", "--source"],
      ["manifest", "--manifest"],
      ["apps", "--apps"],
    ]);
    appendBoolean(argv, args, "dry-run");
    appendBoolean(argv, args, "no-contract-check");
    appendBoolean(argv, args, "delete-extra");
    return { argv };
  }

  if (
    stringArg(args, "project") ||
    boolArg(args, "plan") ||
    boolArg(args, "apply") ||
    boolArg(args, "explain") ||
    boolArg(args, "repair")
  ) {
    const argv = ["bun", commandPath("sync-plan.ts")];
    appendPassthroughValues(argv, args, [
      ["source", "--source"],
      ["project", "--project"],
      ["profile", "--profile"],
      ["app", "--app"],
      ["agent", "--app"],
    ]);
    appendBoolean(argv, args, "plan");
    appendBoolean(argv, args, "apply");
    appendBoolean(argv, args, "explain");
    appendBoolean(argv, args, "repair");
    appendBoolean(argv, args, "json");
    return { argv };
  }

  const argv = ["bun", commandPath("sync-skills.ts")];
  appendPassthroughValues(argv, args, [
    ["from", "--from"],
    ["to", "--to"],
    ["skills", "--skills"],
    ["skill", "--skills"],
  ]);
  appendBoolean(argv, args, "dry-run");
  appendBoolean(argv, args, "delete");
  appendBoolean(argv, args, "no-contract-check");
  return { argv };
}

function buildSetupCommand(args: SkillSysArgs): SkillSysCommandPlan {
  const argv = ["bun", commandPath("quick-install.ts")];
  appendPassthroughValues(argv, args, [
    ["repo", "--repo"],
    ["ref", "--ref"],
    ["target", "--target"],
    ["sync-globals", "--sync-globals"],
    ["project", "--project"],
    ["apps", "--apps"],
    ["app", "--apps"],
    ["agent", "--apps"],
    ["profile", "--profile"],
    ["skills", "--skills"],
    ["skill", "--skills"],
    ["expected-source-sha256", "--expected-source-sha256"],
  ]);
  appendBoolean(argv, args, "verify-signed-tag");
  appendBoolean(argv, args, "no-global-sync");
  return { argv };
}

function buildInitCommand(args: SkillSysArgs): SkillSysCommandPlan {
  const argv = ["bun", commandPath("bootstrap-skills.ts")];
  appendPassthroughValues(argv, args, [
    ["repo", "--repo"],
    ["project", "--project"],
    ["ref", "--ref"],
    ["lockfile", "--lockfile"],
    ["apps", "--apps"],
    ["app", "--apps"],
    ["agent", "--apps"],
    ["profile", "--profile"],
    ["skills", "--skills"],
    ["skill", "--skills"],
    ["source", "--source"],
    ["policy-file", "--policy-file"],
    ["source-lock", "--source-lock"],
    ["source-entry", "--source-entry"],
    ["projection-dir", "--projection-dir"],
  ]);
  appendBoolean(argv, args, "force");
  appendBoolean(argv, args, "refresh-cache");
  appendBoolean(argv, args, "strict-hash");
  appendBoolean(argv, args, "dry-run");
  return { argv };
}

export function buildCommand(parsed: ParsedSkillSysCli, options: { cwd?: string } = {}): SkillSysCommandPlan {
  const cwd = options.cwd || process.cwd();
  switch (parsed.command) {
    case "add":
      if (!parsed.args._[0] && !stringArg(parsed.args, "source") && !stringArg(parsed.args, "repo")) {
        throw new Error("Usage: skill-sys add <source> [--project <dir>] [--skill <name>] [--agent <app>]");
      }
      return buildSkillpoolInstallCommand(parsed.args, "add", cwd);
    case "install":
      return buildSkillpoolInstallCommand(parsed.args, "install", cwd);
    case "update":
    case "upgrade":
      return buildSkillpoolUpgradeCommand(parsed.args);
    case "update-check": {
      const argv = ["bun", commandPath("update-check.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["manifest", "--manifest"],
        ["lockfile", "--lockfile"],
      ]);
      appendBoolean(argv, parsed.args, "strict");
      return { argv };
    }
    case "inspect-skill": {
      const argv = ["bun", commandPath("inspect-skill.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["reference", "--reference"],
        ["home", "--home"],
      ]);
      appendBoolean(argv, parsed.args, "online");
      appendBoolean(argv, parsed.args, "strict");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "audit-installed": {
      const argv = ["bun", commandPath("audit-installed.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["project", "--project"],
        ["manager", "--manager"],
        ["lockfile", "--lockfile"],
        ["home", "--home"],
      ]);
      appendBoolean(argv, parsed.args, "global");
      appendBoolean(argv, parsed.args, "verify-upstream");
      appendBoolean(argv, parsed.args, "strict");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "adopt-installed": {
      const argv = ["bun", commandPath("adopt-installed.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["project", "--project"],
        ["manager", "--manager"],
        ["lockfile", "--lockfile"],
        ["home", "--home"],
      ]);
      appendBoolean(argv, parsed.args, "global");
      appendBoolean(argv, parsed.args, "apply");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "generate-lock": {
      const argv = ["bun", commandPath("generate-lock.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["manifest", "--manifest"],
        ["lockfile", "--lockfile"],
      ]);
      appendBoolean(argv, parsed.args, "dry-run");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "doctor":
      return buildSkillpoolSimpleCommand(parsed.args, "doctor");
    case "validate":
      return buildSkillpoolSimpleCommand(parsed.args, "validate");
    case "scan-sensitive": {
      const argv = ["bun", commandPath("scan-sensitive.ts")];
      appendValue(argv, "--source", stringArg(parsed.args, "source"));
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "scan-privacy": {
      const argv = ["bun", commandPath("scan-privacy.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["surface", "--surface"],
        ["allowlist", "--allowlist"],
        ["policy", "--policy"],
      ]);
      appendBoolean(argv, parsed.args, "strict");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "scan-security": {
      const source = stringArg(parsed.args, "source");
      if (!source) {
        throw new Error("Usage: skill-sys scan-security --source <dir> [--strict] [--json]");
      }
      const argv = ["bun", commandPath("scan-security.ts")];
      appendValue(argv, "--source", source);
      appendBoolean(argv, parsed.args, "strict");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "public-audit": {
      const argv = ["bun", commandPath("public-audit.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["surface", "--surface"],
        ["allowlist", "--allowlist"],
        ["policy", "--policy"],
      ]);
      appendBoolean(argv, parsed.args, "strict");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "packlist": {
      const argv = ["bun", commandPath("packlist.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["surface", "--surface"],
      ]);
      appendBoolean(argv, parsed.args, "hashes");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "npm-pack-audit": {
      const argv = ["bun", commandPath("npm-pack-audit.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["surface", "--surface"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "validate-registry-surface": {
      const argv = ["bun", commandPath("validate-registry-surface.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "registry-export": {
      const argv = ["bun", commandPath("registry-export.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["output", "--output"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      appendBoolean(argv, parsed.args, "strict");
      return { argv };
    }
    case "registry-import": {
      const argv = ["bun", commandPath("registry-import.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["bundle", "--bundle"],
        ["output", "--output"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      appendBoolean(argv, parsed.args, "strict");
      return { argv };
    }
    case "registry-trust": {
      const argv = ["bun", commandPath("registry-trust.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["scorecard", "--scorecard"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      appendBoolean(argv, parsed.args, "strict");
      return { argv };
    }
    case "telemetry-policy": {
      const argv = ["bun", commandPath("telemetry-policy.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["config", "--config"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      appendBoolean(argv, parsed.args, "strict");
      return { argv };
    }
    case "validate-skillpack": {
      const argv = ["bun", commandPath("validate-skillpack.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
      ]);
      appendBoolean(argv, parsed.args, "strict");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "create-skillpack": {
      const argv = ["bun", commandPath("create-skillpack.ts")];
      if (parsed.args._[0]) {
        argv.push(parsed.args._[0]);
      }
      appendPassthroughValues(argv, parsed.args, [
        ["target", "--target"],
        ["name", "--name"],
        ["visibility", "--visibility"],
        ["providers", "--providers"],
        ["profile", "--profile"],
      ]);
      appendBoolean(argv, parsed.args, "dry-run");
      appendBoolean(argv, parsed.args, "force");
      appendBoolean(argv, parsed.args, "yes-i-understand-overwrite");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "verify-origin": {
      const argv = ["bun", commandPath("verify-origin.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["repo", "--repo"],
        ["ref", "--ref"],
        ["version", "--version"],
        ["source-commit", "--source-commit"],
        ["expected-source-sha256", "--expected-source-sha256"],
        ["release-manifest-path", "--release-manifest-path"],
        ["expected-release-manifest-sha256", "--expected-release-manifest-sha256"],
        ["skill-bom-path", "--skill-bom-path"],
        ["expected-skill-bom-sha256", "--expected-skill-bom-sha256"],
      ]);
      appendBoolean(argv, parsed.args, "require-ref-exists");
      appendBoolean(argv, parsed.args, "no-require-ref-exists");
      appendBoolean(argv, parsed.args, "require-signed-tag");
      appendBoolean(argv, parsed.args, "require-source-commit");
      appendBoolean(argv, parsed.args, "require-source-checksum");
      appendBoolean(argv, parsed.args, "require-release-manifest");
      appendBoolean(argv, parsed.args, "require-skill-bom");
      appendBoolean(argv, parsed.args, "require-cosign-bundles");
      appendBoolean(argv, parsed.args, "require-github-attestation");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "build-projections": {
      const argv = ["bun", commandPath("build-projections.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["providers", "--providers"],
        ["out-dir", "--out-dir"],
        ["projection-store-dir", "--projection-store-dir"],
        ["user-root", "--user-root"],
      ]);
      appendBoolean(argv, parsed.args, "clean");
      appendBoolean(argv, parsed.args, "include-user");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "validate-projections": {
      const argv = ["bun", commandPath("validate-projections.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["providers", "--providers"],
        ["out-dir", "--out-dir"],
        ["user-root", "--user-root"],
      ]);
      appendBoolean(argv, parsed.args, "include-user");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "semantic-audit": {
      const argv = ["bun", commandPath("semantic-audit.ts")];
      appendValue(argv, "--source", stringArg(parsed.args, "source"));
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "docs-check": {
      const argv = ["bun", commandPath("docs-check.ts")];
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "provider-matrix": {
      const argv = ["bun", commandPath("generate-provider-matrix.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["output", "--output"],
      ]);
      appendBoolean(argv, parsed.args, "check");
      return { argv };
    }
    case "catalog": {
      const argv = ["bun", commandPath("generate-skill-catalog.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["out-dir", "--out-dir"],
        ["format", "--format"],
      ]);
      appendBoolean(argv, parsed.args, "check");
      appendBoolean(argv, parsed.args, "include-internal");
      appendBoolean(argv, parsed.args, "include-experimental");
      return { argv };
    }
    case "guard-repo-visibility": {
      const argv = ["bun", commandPath("guard-repo-visibility.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["repository", "--repository"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      appendBoolean(argv, parsed.args, "local-ok");
      appendBoolean(argv, parsed.args, "allow-public-after-explicit-user-approval");
      return { argv };
    }
    case "workflow-chain": {
      const argv = ["bun", commandPath("workflow-chain.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["workflow", "--workflow"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      appendBoolean(argv, parsed.args, "strict");
      appendBoolean(argv, parsed.args, "execute");
      appendPassthroughValues(argv, parsed.args, [["adapter", "--adapter"]]);
      return { argv };
    }
    case "route": {
      const argv = ["bun", commandPath("route.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["rules", "--rules"],
        ["query", "--query"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      appendBoolean(argv, parsed.args, "strict");
      appendBoolean(argv, parsed.args, "execute");
      appendPassthroughValues(argv, parsed.args, [["adapter", "--adapter"]]);
      return { argv };
    }
    case "team-mode": {
      const argv = ["bun", commandPath("team-mode.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["config", "--config"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      appendBoolean(argv, parsed.args, "strict");
      return { argv };
    }
    case "dev-mode": {
      const argv = ["bun", commandPath("dev-mode.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["config", "--config"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      appendBoolean(argv, parsed.args, "strict");
      return { argv };
    }
    case "project-learnings": {
      const subcommand = parsed.args._[0];
      if (subcommand && !subcommand.startsWith("-") && subcommand !== "validate" && subcommand !== "append" && subcommand !== "update") {
        throw new Error("Usage: skill-sys project-learnings [validate|append|update] --source <dir> --learnings <file> [--id <id> --summary <text> [--source-entry <text>]] [options]");
      }
      const argv = ["bun", commandPath("project-learnings.ts")];
      if (subcommand === "validate" || subcommand === "append" || subcommand === "update") {
        argv.push(subcommand);
      }
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["learnings", "--learnings"],
        ["id", "--id"],
        ["summary", "--summary"],
        ["source-entry", "--source-entry"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      appendBoolean(argv, parsed.args, "strict");
      appendBoolean(argv, parsed.args, "dry-run");
      return { argv };
    }
    case "memory-adapter": {
      const subcommand = parsed.args._[0];
      if (subcommand && !subcommand.startsWith("-") && subcommand !== "validate" && subcommand !== "read" && subcommand !== "write") {
        throw new Error("Usage: skill-sys memory-adapter [validate|read|write] --source <dir> --config <file> [--id <id> --memory <text> --source-entry <text>] [options]");
      }
      const argv = ["bun", commandPath("memory-adapter.ts")];
      if (subcommand === "validate" || subcommand === "read" || subcommand === "write") {
        argv.push(subcommand);
      }
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["config", "--config"],
        ["id", "--id"],
        ["memory", "--memory"],
        ["source-entry", "--source-entry"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      appendBoolean(argv, parsed.args, "strict");
      appendBoolean(argv, parsed.args, "dry-run");
      return { argv };
    }
    case "eval": {
      const subcommand = parsed.args._[0] || "triggers";
      if (subcommand === "harness") {
        const argv = ["bun", commandPath("eval-harness.ts")];
        appendPassthroughValues(argv, parsed.args, [
          ["source", "--source"],
          ["skill", "--skill"],
        ]);
        appendBoolean(argv, parsed.args, "json");
        appendBoolean(argv, parsed.args, "strict");
        return { argv };
      }
      if (subcommand === "value-gate") {
        const argv = ["bun", commandPath("value-gate.ts")];
        appendPassthroughValues(argv, parsed.args, [
          ["source", "--source"],
          ["results", "--results"],
          ["skill", "--skill"],
        ]);
        appendBoolean(argv, parsed.args, "json");
        appendBoolean(argv, parsed.args, "strict");
        return { argv };
      }
      if (subcommand === "receipt") {
        const argv = ["bun", commandPath("eval-receipt.ts")];
        appendPassthroughValues(argv, parsed.args, [
          ["receipt", "--receipt"],
          ["source-digest", "--source-digest"],
          ["fixture-digest", "--fixture-digest"],
          ["case-ids", "--case-ids"],
          ["provider", "--provider"],
          ["model", "--model"],
        ]);
        appendBoolean(argv, parsed.args, "json");
        return { argv };
      }
      if (subcommand !== "triggers" && subcommand !== "collisions") {
        throw new Error("Usage: skill-sys eval triggers|collisions|harness|value-gate|receipt [options]");
      }
      const argv = ["bun", commandPath("eval.ts"), subcommand];
      appendPassthroughValues(argv, parsed.args, [
        ["source", "--source"],
        ["provider", "--provider"],
      ]);
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "list":
      return buildListCommand(parsed.args, false);
    case "find":
      return buildListCommand(parsed.args, true);
    case "sync":
      return buildSyncCommand(parsed.args);
    case "rollback": {
      const argv = ["bun", commandPath("rollback.ts")];
      appendPassthroughValues(argv, parsed.args, [
        ["project", "--project"],
        ["target", "--target"],
        ["install-id", "--install-id"],
      ]);
      appendBoolean(argv, parsed.args, "dry-run");
      appendBoolean(argv, parsed.args, "json");
      return { argv };
    }
    case "setup":
      return buildSetupCommand(parsed.args);
    case "init":
      return buildInitCommand(parsed.args);
    case "remove": {
      // remove is an in-process command. buildCommand is the dispatch boundary:
      // it validates the request (fail-closed for bare, apply+plan, or
      // broad-without --all) and returns a descriptive marker. The real planner
      // or apply runs in-process from main(); this argv is never spawned.
      const input = normalizeRemoveArgs(parsed.args, { cwd });
      const argv = ["bun", "skill-sys", "remove", "--project", input.project];
      if (input.skill) {
        argv.push("--skill", input.skill);
      }
      if (input.app) {
        argv.push("--app", input.app);
      }
      if (input.all) {
        argv.push("--all");
      }
      if (input.apply) {
        argv.push("--apply");
        if (input.confirmAll) {
          argv.push("--confirm-all");
        }
        if (input.force) {
          argv.push("--force");
        }
      } else {
        argv.push(input.plan ? "--plan" : "--dry-run");
      }
      if (boolArg(parsed.args, "json")) {
        argv.push("--json");
      }
      return { argv };
    }
    case "verify-sandbox": {
      // PR13: verify-sandbox is a plan-only, in-process command. buildCommand is
      // the dispatch boundary: it validates the request (fail-closed for bare,
      // --apply/--run/--execute, or missing --plan/--dry-run) and returns a
      // descriptive marker. The real planner runs in-process from main(); this
      // argv is never spawned.
      const input = normalizeSandboxArgs(parsed.args, { cwd });
      const argv = ["bun", "skill-sys", "verify-sandbox", "--source", input.source];
      argv.push(input.mode === "plan" ? "--plan" : "--dry-run");
      for (const mount of input.mounts) {
        argv.push("--mount", `${mount.source}:${mount.target}`);
      }
      if (boolArg(parsed.args, "json")) {
        argv.push("--json");
      }
      return { argv };
    }
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}

function normalizeTier(value: string | undefined): ContextBundleTier {
  if (!value) {
    return "standard";
  }
  if (value === "quick" || value === "standard" || value === "deep") {
    return value;
  }
  throw new Error(`Invalid context tier '${value}'. Expected quick, standard, or deep.`);
}

function normalizeFormat(value: string | undefined): ContextBundleFormat {
  if (!value) {
    return "markdown";
  }
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new Error(`Invalid context format '${value}'. Expected markdown or json.`);
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function tierAllowsFile(relativePath: string, tier: ContextBundleTier): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  if (tier === "deep") {
    return normalized.endsWith(".md");
  }
  if (tier === "quick") {
    return normalized === "SKILL.md";
  }
  if (normalized === "SKILL.md" || normalized === "gotchas.md") {
    return true;
  }
  return /^references\/([^/]+\/)?README\.md$/.test(normalized);
}

function contextFilePriority(relativePath: string): number {
  if (relativePath === "SKILL.md") {
    return 0;
  }
  if (relativePath === "gotchas.md") {
    return 1;
  }
  if (/^references\/([^/]+\/)?README\.md$/.test(relativePath)) {
    return 2;
  }
  return 3;
}

export function buildContextBundle(args: SkillSysArgs, options: { cwd?: string } = {}): ContextBundle {
  const cwd = options.cwd || process.cwd();
  const skill = args._[0] || stringArg(args, "skill");
  if (!skill) {
    throw new Error("Usage: skill-sys context <skill> [--tier quick|standard|deep] [--format markdown|json]");
  }
  if (skill.includes("/") || skill.includes("\\") || skill === "." || skill === "..") {
    throw new Error(`Invalid skill name '${skill}'`);
  }

  const tier = normalizeTier(stringArg(args, "tier"));
  const skillsRoot = path.resolve(cwd, stringArg(args, "skills-root") || "skills");
  const skillDir = path.join(skillsRoot, skill);
  if (!fs.existsSync(skillDir)) {
    throw new Error(`Skill not found: ${skillDir}`);
  }

  const files = listFilesRecursive(skillDir)
    .map((filePath) => ({ filePath, relativePath: path.relative(skillDir, filePath).replaceAll("\\", "/") }))
    .filter(({ relativePath }) => tierAllowsFile(relativePath, tier))
    .sort((a, b) => contextFilePriority(a.relativePath) - contextFilePriority(b.relativePath) || a.relativePath.localeCompare(b.relativePath))
    .map(({ filePath, relativePath }) => {
      const content = fs.readFileSync(filePath, "utf8");
      return {
        path: relativePath,
        chars: content.length,
        approxTokens: approxTokens(content),
        content,
      };
    });

  const chars = files.reduce((total, file) => total + file.chars, 0);
  return {
    skill,
    tier,
    files,
    chars,
    approxTokens: approxTokens(files.map((file) => file.content).join("\n")),
  };
}

export function renderContextBundle(bundle: ContextBundle, format: ContextBundleFormat): string {
  if (format === "json") {
    return JSON.stringify(bundle, null, 2);
  }
  const lines = [
    `# skill-sys context: ${bundle.skill}`,
    "",
    `tier: ${bundle.tier}`,
    `files: ${bundle.files.length}`,
    `approx_tokens: ${bundle.approxTokens}`,
    "",
  ];
  for (const file of bundle.files) {
    lines.push(`## ${file.path}`);
    lines.push("");
    lines.push(file.content.trimEnd());
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function printHelp(stdout: (text: string) => void = console.log): void {
  const commandLines = publicSkillSysCommands()
    .map((command) => `  ${command.name.padEnd(10)} ${command.summary}`)
    .join("\n");
  const compatibilityLines = SKILL_SYS_COMMANDS
    .filter((command) => command.audience === "compatibility")
    .map((command) => command.name)
    .join(", ");

  stdout(`Skill-Sys\n\nUsage:\n  skill-sys <command> [options]\n\nCommands:\n${commandLines}\n\nCommon options:\n  --project <dir>       Target project directory\n  --skill <name>        Single skill selector\n  --agent <app>         Agent app label; forwarded as --app\n  --profile <name>      Restrict discovery to a named profile or stack pack\n  --dry-run             Preview without writing\n  --json                Emit machine-readable output when supported\n\nExamples:\n  skill-sys add vercel-labs/skills --project . --skill writing-skills --agent codex\n  skill-sys find react --json\n  skill-sys list --profile frontend --json\n  skill-sys context writing-skills --tier quick\n  skill-sys scan-sensitive --source .\n  skill-sys verify-origin --source . --version v1.4.0\n  skill-sys build-projections --providers codex,claude-code\n  skill-sys eval triggers --provider codex\n  skill-sys semantic-audit --source .\n  skill-sys docs-check\n  skill-sys doctor --budget --provider codex --global-core\n  skill-sys sync --project . --profile core --plan --json\n  skill-sys update --project . --ref v1.4.0\n\nCompatibility commands: ${compatibilityLines}.\nExisting skillpool commands remain supported.`);
}

export function printCommandHelp(command: string, stdout: (text: string) => void = console.log): void {
  const usage: Record<string, string> = {
    add: "skill-sys add <source> [--project <dir>] [--skill <name>] [--agent <app>]",
    install: "skill-sys install <source> [--project <dir>] [--skill <name>] [--agent <app>]",
    update: "skill-sys update [<skill>] --project <dir> [--ref <ref>] [--source <dir>] [--install-mode projection|copy]",
    upgrade: "skill-sys upgrade --project <dir> [--ref <ref>] [--install-mode projection|copy]",
    doctor: "skill-sys doctor [--source <dir>] [--budget] [--provider <id>] [--global-core]",
    validate: "skill-sys validate --source <dir> [--strict] [--json]",
    "scan-security": "skill-sys scan-security --source <dir> [--strict] [--json]",
    context: "skill-sys context <skill> [--skills-root <dir>] [--tier quick|standard|deep] [--format markdown|json]",
    use: "skill-sys use <source> --skill <name> [--format markdown|json] [--agent <app>]",
    remove: "skill-sys remove --project <dir> --skill <name> --plan|--dry-run|--apply [--app <app>] [--all] [--confirm-all] [--force] [--json]",
    "verify-sandbox": "skill-sys verify-sandbox --source <dir> --plan|--dry-run [--mount src:target] [--json]",
  };
  const resolved = resolveSkillSysCommandName(command) || command;
  const definition = SKILL_SYS_COMMANDS.find((entry) => entry.name === resolved);
  stdout(`Skill-Sys ${resolved}\n\nUsage:\n  ${usage[resolved] || `skill-sys ${resolved} [options]`}\n\nSummary:\n  ${definition?.summary || "See skill-sys --help for command overview."}`);
}

// ---------------------------------------------------------------------------
// skill-sys use — ephemeral read-only skill preview
// ---------------------------------------------------------------------------

export type UseResolved = {
  sourcePath: string;
  sourceDisplay: string;
  skillName: string;
  skillDir: string;
  skillMdPath: string;
  skillMdContent: string;
};

export type UseOutput = {
  source: string;
  skill: string;
  agent?: string;
  format: "json" | "markdown";
  sensitiveScan: { status: "clean"; findings: number };
  content: string;
};

type UseRemoteResolvedRef = {
  ref: string;
  commit: string;
  sourceRef: string;
};

export type UseCommandOptions = {
  cwd?: string;
  resolveRemoteRef?: (repo: string, ref: string) => UseRemoteResolvedRef;
  fetchExactRef?: (repo: string, ref: string, dest: string, expectedCommit?: string) => void;
};

export function resolveSkillFromSource(
  rawSource: string,
  skillName: string,
  options: { cwd?: string } = {}
): UseResolved {
  const cwd = options.cwd || process.cwd();
  const sourcePath = path.resolve(cwd, rawSource);
  const relativeSource = path.relative(cwd, sourcePath);
  const sourceDisplay =
    relativeSource && !relativeSource.startsWith("..") && !path.isAbsolute(relativeSource)
      ? relativeSource
      : rawSource;

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source not found: ${rawSource}`);
  }
  if (!fs.statSync(sourcePath).isDirectory()) {
    throw new Error(`Source is not a directory: ${rawSource}`);
  }

  const layout = resolveSourceLayout(sourcePath, { requireSkills: true });
  const skillsDir = layout.skillsDir;

  let resolvedName: string = skillName;
  if (!resolvedName) {
    const skillDirs = fs.readdirSync(skillsDir).filter((entry) => {
      const entryPath = path.join(skillsDir, entry);
      return (
        fs.statSync(entryPath).isDirectory() &&
        fs.existsSync(path.join(entryPath, "SKILL.md"))
      );
    });
    if (skillDirs.length === 1) {
      resolvedName = skillDirs[0] as string;
    } else {
      throw new Error(
        `--skill is required for sources with multiple or zero skills. Found: ${skillDirs.join(", ") || "none"}`
      );
    }
  }

  if (
    resolvedName.includes("/") ||
    resolvedName.includes("\\") ||
    resolvedName === "." ||
    resolvedName === ".."
  ) {
    throw new Error(`Invalid skill name '${resolvedName}'`);
  }

  const skillDir = path.join(skillsDir, resolvedName);
  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    throw new Error(`Skill not found: ${resolvedName}`);
  }
  if (fs.lstatSync(skillDir).isSymbolicLink()) {
    throw new Error("Refusing to follow symlinked skill directory in source");
  }

  const skillsReal = fs.realpathSync.native(skillsDir);
  const skillReal = fs.realpathSync.native(skillDir);
  const skillRelative = path.relative(skillsReal, skillReal);
  if (
    skillRelative === "" ||
    skillRelative === "." ||
    skillRelative.startsWith("..") ||
    path.isAbsolute(skillRelative)
  ) {
    throw new Error("Refusing to resolve skill directory outside source skills root");
  }

  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`Skill not found: ${resolvedName} (missing SKILL.md)`);
  }
  if (fs.lstatSync(skillMdPath).isSymbolicLink()) {
    throw new Error("Refusing to follow symlinked SKILL.md in source");
  }
  const fileReal = fs.realpathSync.native(skillMdPath);
  const fileRelative = path.relative(skillsReal, fileReal);
  if (
    fileRelative === "" ||
    fileRelative === "." ||
    fileRelative.startsWith("..") ||
    path.isAbsolute(fileRelative)
  ) {
    throw new Error("Refusing to read SKILL.md outside source skills root");
  }

  const skillMdContent = fs.readFileSync(skillMdPath, "utf8");

  return {
    sourcePath,
    sourceDisplay,
    skillName: resolvedName,
    skillDir,
    skillMdPath,
    skillMdContent,
  };
}

function resolveRemoteSkill(
  spec: NormalizedSourceSpec,
  skillName: string,
  checkoutRoot: string,
  sourceDisplay: string,
): UseResolved {
  const layout = resolveSourceLayout(checkoutRoot, { requireSkills: true });

  let skillDir: string;
  let resolvedName: string;

  if (spec.skillPath) {
    const segments = spec.skillPath.split("/");
    if (
      spec.skillPath.includes("\\") ||
      path.isAbsolute(spec.skillPath) ||
      path.posix.isAbsolute(spec.skillPath) ||
      segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(".."))
    ) {
      throw new Error("Unsafe skill path in remote source");
    }
    skillDir = path.join(checkoutRoot, ...segments);
    const relative = path.relative(checkoutRoot, skillDir);
    if (relative === "" || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Unsafe skill path in remote source");
    }
    resolvedName = skillName || path.basename(spec.skillPath);
  } else {
    const skillsDir = layout.skillsDir;
    resolvedName = skillName;
    if (!resolvedName) {
      const skillDirs = fs.readdirSync(skillsDir).filter((entry) => {
        const entryPath = path.join(skillsDir, entry);
        return (
          fs.statSync(entryPath).isDirectory() &&
          fs.existsSync(path.join(entryPath, "SKILL.md"))
        );
      });
      if (skillDirs.length === 1) {
        resolvedName = skillDirs[0] as string;
      } else {
        throw new Error(
          `--skill is required for sources with multiple or zero skills. Found: ${skillDirs.join(", ") || "none"}`
        );
      }
    }
    skillDir = path.join(skillsDir, resolvedName);
  }

  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    throw new Error(`Skill not found: ${resolvedName}`);
  }
  if (fs.lstatSync(skillDir).isSymbolicLink()) {
    throw new Error("Refusing to follow symlinked skill directory in remote source");
  }

  const checkoutReal = fs.realpathSync.native(checkoutRoot);
  const skillReal = fs.realpathSync.native(skillDir);
  const skillRelative = path.relative(checkoutReal, skillReal);
  if (
    skillRelative === "" ||
    skillRelative === "." ||
    skillRelative.startsWith("..") ||
    path.isAbsolute(skillRelative)
  ) {
    throw new Error("Refusing to resolve skill directory outside remote checkout");
  }

  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`Skill not found: ${resolvedName} (missing SKILL.md)`);
  }
  if (fs.lstatSync(skillMdPath).isSymbolicLink()) {
    throw new Error("Refusing to follow symlinked SKILL.md in remote source");
  }
  const fileReal = fs.realpathSync.native(skillMdPath);
  const fileRelative = path.relative(checkoutReal, fileReal);
  if (
    fileRelative === "" ||
    fileRelative === "." ||
    fileRelative.startsWith("..") ||
    path.isAbsolute(fileRelative)
  ) {
    throw new Error("Refusing to read SKILL.md outside remote checkout");
  }

  return {
    sourcePath: checkoutRoot,
    sourceDisplay,
    skillName: resolvedName,
    skillDir,
    skillMdPath,
    skillMdContent: fs.readFileSync(skillMdPath, "utf8"),
  };
}

function runLocalUse(
  rawSource: string,
  skillName: string,
  format: "markdown" | "json",
  agent: string | undefined,
  options: UseCommandOptions,
): string {
  const resolved = resolveSkillFromSource(rawSource, skillName, options);

  const findings = scanSensitiveFiles({ rootDir: resolved.skillDir });
  assertNoSensitiveFindings(findings, `skill-sys use '${resolved.skillName}'`);

  return buildUseOutput(resolved, format, agent);
}

function looksLikeRemoteSource(raw: string): boolean {
  const trimmed = raw.trim();
  if (isGithubShorthand(trimmed) || isRemoteSpec(trimmed)) {
    return true;
  }
  try {
    return parseGithubTreeUrl(trimmed) !== null;
  } catch {
    return true;
  }
}

function handleRemoteUse(
  rawSource: string,
  spec: NormalizedSourceSpec,
  skillName: string,
  format: "markdown" | "json",
  agent: string | undefined,
  options: UseCommandOptions,
): string {
  const resolveRef =
    options.resolveRemoteRef ?? ((repo: string, ref: string) => resolveRemoteRef(repo, ref));
  const fetchRemote =
    options.fetchExactRef ??
    ((repo: string, ref: string, dest: string, expectedCommit?: string) =>
      fetchExactRef(repo, ref, dest, expectedCommit));

  const ref = spec.ref ?? "HEAD";
  const resolvedRef = resolveRef(spec.value, ref);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-use-"));
  try {
    fetchRemote(spec.value, ref, tempRoot, resolvedRef.commit);

    const resolved = resolveRemoteSkill(spec, skillName, tempRoot, rawSource);

    const findings = scanSensitiveFiles({ rootDir: resolved.skillDir });
    assertNoSensitiveFindings(findings, `skill-sys use '${resolved.skillName}'`);

    return buildUseOutput(resolved, format, agent);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function buildUseOutput(
  resolved: UseResolved,
  format: "markdown" | "json",
  agent: string | undefined
): string {
  if (format === "json") {
    const output: UseOutput = {
      source: resolved.sourceDisplay,
      skill: resolved.skillName,
      format: "json",
      sensitiveScan: { status: "clean", findings: 0 },
      content: resolved.skillMdContent,
    };
    if (agent) {
      output.agent = agent;
    }
    return JSON.stringify(output, null, 2);
  }

  const agentLine = agent ? `\nagent: ${agent}` : "";
  return [
    `# skill-sys use: ${resolved.skillName}`,
    "",
    `source: ${resolved.sourceDisplay}`,
    `skill: ${resolved.skillName}${agentLine}`,
    "",
    "## SKILL.md",
    "",
    resolved.skillMdContent.trimEnd(),
    "",
  ].join("\n");
}

export function handleUseCommand(
  rawSource: string,
  skillName: string,
  format: "markdown" | "json",
  agent: string | undefined,
  options: UseCommandOptions = {}
): string {
  const cwd = options.cwd || process.cwd();
  const localPath = path.resolve(cwd, rawSource);

  if (fs.existsSync(localPath)) {
    return runLocalUse(rawSource, skillName, format, agent, options);
  }

  let spec: NormalizedSourceSpec;
  try {
    spec = normalizeSourceSpec(rawSource, { cwd });
  } catch (error) {
    if (!looksLikeRemoteSource(rawSource)) {
      return runLocalUse(rawSource, skillName, format, agent, options);
    }
    throw error;
  }

  if (spec.kind === "source") {
    return runLocalUse(rawSource, skillName, format, agent, options);
  }

  return handleRemoteUse(rawSource, spec, skillName, format, agent, options);
}

export function main(argv: string[] = process.argv, deps: SkillSysDeps = {}): number {
  const stdout = deps.stdout || console.log;
  const stderr = deps.stderr || console.error;

  try {
    const parsed = parseCli(argv);
    if (parsed.command === "help") {
      printHelp(stdout);
      return 0;
    }
    if (boolArg(parsed.args, "help") && FRONTEND_HELP_COMMANDS.has(parsed.command)) {
      printCommandHelp(parsed.command, stdout);
      return 0;
    }
    if (parsed.command === "use") {
      const sourceArg = parsed.args._[0];
      if (!sourceArg) {
        throw new Error("Usage: skill-sys use <source> --skill <name> [--format markdown|json] [--agent <app>]");
      }
      const skillName = stringArg(parsed.args, "skill") || "";
      const format = boolArg(parsed.args, "json")
        ? "json"
        : normalizeFormat(stringArg(parsed.args, "format"));
      const agent = stringArg(parsed.args, "agent");
      const result = handleUseCommand(sourceArg, skillName, format, agent, cwdOption(deps.cwd));
      stdout(result);
      return 0;
    }

    if (parsed.command === "context") {
      const format = normalizeFormat(stringArg(parsed.args, "format"));
      stdout(renderContextBundle(buildContextBundle(parsed.args, cwdOption(deps.cwd)), format));
      return 0;
    }

    const plan = buildCommand(parsed, cwdOption(deps.cwd));
    if (boolArg(parsed.args, "help")) {
      plan.argv.push("--help");
    }
    if (parsed.command === "remove") {
      // In-process planner/apply. The planner path never mutates; the apply
      // path backs up, deletes, and rewrites state through applyRemove.
      const input = normalizeRemoveArgs(parsed.args, cwdOption(deps.cwd));
      const json = boolArg(parsed.args, "json");
      const rendered = input.apply
        ? renderRemoveApplyResult(applyRemove(input), json ? "json" : "text")
        : renderRemovePlan(planRemove(input), json ? "json" : "text");
      stdout(rendered);
      return 0;
    }
    if (parsed.command === "verify-sandbox") {
      // PR13: plan-only, in-process, zero-mutation planner. Never spawns Docker.
      const input = normalizeSandboxArgs(parsed.args, cwdOption(deps.cwd));
      const verdict = planSandbox(input);
      stdout(renderSandboxVerdict(verdict, boolArg(parsed.args, "json") ? "json" : "text"));
      return verdict.status === "BLOCKED" ? 1 : 0;
    }
    const runner =
      deps.run ||
      ((commandArgv: string[]) =>
        runCommand(
          commandArgv,
          parsed.command === "inspect-skill" ? { allowFailure: true } : {},
        ));
    const result = runner(plan.argv);
    return result.code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`ERROR: ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}
