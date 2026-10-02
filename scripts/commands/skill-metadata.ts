#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import type { ParsedFrontmatter, ParsedFrontmatterOk } from "../modules/skill-metadata-lib";

import {
  LEGACY_METADATA_KEYS,
  PROVIDER_IDS,
  bumpPatch,
  cloneParsedFrontmatter,
  isValidSemver,
  isValidUtcIso,
  listSkillDirs,
  normalizeManagedMetadata,
  normalizeProviderId,
  normalizeProviderList,
  normalizeSemverLoose,
  parseFrontmatter,
  serializeFrontmatter,
  stripQuotes,
  stripManagedMetadata,
  toUtcIso,
} from "../modules/skill-metadata-lib.ts";

type MetadataCommand = "help" | "audit" | "sync";
type SyncMode = "all" | "staged";
type DiffMode = SyncMode | "working";
type AuditLevel = "ERROR" | "WARN";

interface MetadataCLIOptions {
  command: MetadataCommand;
  skillsRoot: string;
  strict: boolean;
  write: boolean;
  all: boolean;
  staged: boolean;
  defaultProvider: string;
  help?: boolean;
}

interface GitOptions {
  cwd?: string;
  allowFailure?: boolean;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface AuditFinding {
  level: AuditLevel;
  code: string;
  skill: string;
  message: string;
}

interface CollectAuditOptions {
  strict: boolean;
  repoRoot: string | null;
  dirtySkillDirs: Set<string>;
}

interface SyncOptions {
  defaultProvider: string;
  mode: SyncMode;
  now: string | null;
  repoRoot: string | null;
  write: boolean;
}

interface SyncResult {
  ok: true;
  changed: boolean;
  path: string;
  version?: string;
}

interface SyncFailure {
  ok: false;
  changed: false;
  path: string;
  message: string;
}

interface ParsedMetadataFrontmatter extends ParsedFrontmatterOk {
  metadata: Record<string, string>;
}

type SyncOutcome = SyncResult | SyncFailure;

function help(): void {
  console.log(`
Skill metadata tools

Usage:
  bun scripts/commands/skill-metadata.ts audit [options]
  bun scripts/commands/skill-metadata.ts sync --all [options]
  bun scripts/commands/skill-metadata.ts sync --staged [options]

Commands:
  audit                     Validate skill metadata and detect pending git drift
  sync --all                Backfill every root SKILL.md
  sync --staged             Refresh metadata for changed skill directories

Options:
  --skills-root <dir>       Skills root directory (default: ./skills)
  --write                   Persist changes on sync (default: dry-run)
  --strict                  Treat warnings as blocking in audit
  --default-provider <id>   Fallback target provider (default: universal)
  --help                    Show help

Providers:
  ${PROVIDER_IDS.join(", ")}
`);
}

function parseArgs(argv: string[]): MetadataCLIOptions {
  const command: MetadataCommand = argv[2] && !argv[2].startsWith("--") ? (argv[2] as MetadataCommand) : "help";
  const options: MetadataCLIOptions = {
    command,
    skillsRoot: path.resolve(process.cwd(), "skills"),
    strict: false,
    write: false,
    all: false,
    staged: false,
    defaultProvider: "universal",
  };

  const startIndex = command === "help" ? 2 : 3;
  for (let i = startIndex; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--strict") {
      options.strict = true;
      continue;
    }
    if (token === "--write") {
      options.write = true;
      continue;
    }
    if (token === "--all") {
      options.all = true;
      continue;
    }
    if (token === "--staged") {
      options.staged = true;
      continue;
    }

    if (!token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }

    if (key === "skills-root") {
      options.skillsRoot = path.resolve(process.cwd(), value);
    } else if (key === "default-provider") {
      options.defaultProvider = value;
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
    i += 1;
  }

  if (!PROVIDER_IDS.includes(options.defaultProvider as typeof PROVIDER_IDS[number])) {
    throw new Error(
      `Invalid --default-provider '${options.defaultProvider}'. Use one of: ${PROVIDER_IDS.join(", ")}`
    );
  }

  if (command === "sync" && options.all === options.staged) {
    throw new Error("sync requires exactly one of --all or --staged");
  }

  return options;
}

function git(args: string[], opts: GitOptions = {}): GitResult {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: opts.cwd || process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = proc.stdout ? Buffer.from(proc.stdout).toString("utf8").trim() : "";
  const stderr = proc.stderr ? Buffer.from(proc.stderr).toString("utf8").trim() : "";

  if (proc.exitCode !== 0 && !opts.allowFailure) {
    throw new Error([`git ${args.join(" ")}`, stderr || stdout].filter(Boolean).join(": "));
  }

  return { code: proc.exitCode, stdout, stderr };
}

function resolveRepoRoot(startDir: string): string | null {
  const result = git(["rev-parse", "--show-toplevel"], {
    cwd: startDir,
    allowFailure: true,
  });
  return result.code === 0 ? result.stdout : null;
}

function toRepoRelative(filePath: string, repoRoot: string): string {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function loadHeadParsed(filePath: string, repoRoot: string | null): ParsedFrontmatterOk | null {
  if (!repoRoot) {
    return null;
  }
  const relPath = toRepoRelative(filePath, repoRoot);
  const result = git(["show", `HEAD:${relPath}`], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (result.code !== 0 || !result.stdout) {
    return null;
  }
  const parsed = parseFrontmatter(result.stdout);
  return parsed.ok ? parsed : null;
}

function getGitLastModified(filePath: string, repoRoot: string | null): string | null {
  if (!repoRoot) {
    return null;
  }
  const relPath = toRepoRelative(filePath, repoRoot);
  const result = git(["log", "-1", "--format=%cI", "--", relPath], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (result.code !== 0 || !result.stdout) {
    return null;
  }
  return toUtcIso(result.stdout);
}

function collectChangedSkillDirs(
  skillsRoot: string,
  repoRoot: string | null,
  mode: DiffMode
): string[] {
  if (!repoRoot) {
    return [];
  }

  const relSkillsRoot = toRepoRelative(skillsRoot, repoRoot);
  const args =
    mode === "staged"
      ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "--", relSkillsRoot]
      : ["diff", "--name-only", "HEAD", "--", relSkillsRoot];

  const result = git(args, { cwd: repoRoot, allowFailure: true });
  if (result.code !== 0 || !result.stdout) {
    return [];
  }

  return [
    ...new Set(
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((relPath) => relPath.replaceAll("\\", "/"))
        .filter((relPath) => relPath.startsWith(`${relSkillsRoot}/`))
        .map((relPath) => relPath.split("/").slice(0, 2).join("/"))
        .map((skillDirRel) => path.join(repoRoot, skillDirRel))
        .filter((skillDir) => fs.existsSync(path.join(skillDir, "SKILL.md")))
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function changedFilesForSkill(skillDir: string, repoRoot: string | null): string[] {
  if (!repoRoot) {
    return [];
  }
  const relSkillDir = toRepoRelative(skillDir, repoRoot);
  const result = git(["diff", "--name-only", "HEAD", "--", relSkillDir], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (result.code !== 0 || !result.stdout) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}

function hasSubstantiveSkillChange(
  skillDir: string,
  parsed: ParsedMetadataFrontmatter,
  options: { repoRoot: string | null }
): boolean {
  const files = changedFilesForSkill(skillDir, options.repoRoot);
  if (!files.length) {
    return false;
  }

  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    return false;
  }

  const relSkillFile = toRepoRelative(path.join(skillDir, "SKILL.md"), repoRoot);
  const nonRootSkillChanges = files.filter((filePath) => filePath !== relSkillFile);
  if (nonRootSkillChanges.length > 0) {
    return true;
  }

  const headParsed = loadHeadParsed(path.join(skillDir, "SKILL.md"), repoRoot);
  if (!headParsed) {
    return true;
  }

  const currentComparable = serializeFrontmatter(stripManagedMetadata(parsed));
  const headComparable = serializeFrontmatter(stripManagedMetadata(headParsed));
  return currentComparable.trimEnd() !== headComparable.trimEnd();
}

function validateCompatibleProviders(rawValue: unknown, targetProvider: string | null): string[] {
  const parsed = normalizeProviderList(rawValue, { exclude: [targetProvider] });
  const rawItems = String(rawValue || "")
    .split(",")
    .map((item) => stripQuotes(item))
    .filter(Boolean);
  const findings: string[] = [];

  if (rawItems.includes("universal")) {
    findings.push("metadata.compatible_providers must not include universal");
  }

  if (targetProvider && rawItems.includes(targetProvider)) {
    findings.push("metadata.compatible_providers must not repeat metadata.target_provider");
  }

  if (parsed.length !== rawItems.length) {
    findings.push("metadata.compatible_providers contains invalid or duplicate providers");
  }

  return findings;
}

function collectAuditFindings(skillDir: string, options: CollectAuditOptions): AuditFinding[] {
  const skillFile = path.join(skillDir, "SKILL.md");
  const relFile = path.relative(process.cwd(), skillFile).replaceAll("\\", "/");
  const content = fs.readFileSync(skillFile, "utf8");
  const parsed: ParsedFrontmatter = parseFrontmatter(content);
  const findings: AuditFinding[] = [];

  if (!parsed.ok) {
    findings.push({
      level: "ERROR",
      code: "FRONTMATTER_INVALID",
      skill: path.basename(skillDir),
      message: `${relFile}: ${parsed.error}`,
    });
    return findings;
  }

  const metadata = (parsed.metadata || {}) as Record<string, string>;
  const targetProvider = normalizeProviderId(metadata.target_provider);

  if (!metadata.version) {
    findings.push({
      level: "ERROR",
      code: "METADATA_VERSION_MISSING",
      skill: path.basename(skillDir),
      message: `${relFile}: missing metadata.version`,
    });
  } else if (!isValidSemver(metadata.version)) {
    findings.push({
      level: "ERROR",
      code: "METADATA_VERSION_INVALID",
      skill: path.basename(skillDir),
      message: `${relFile}: invalid metadata.version '${metadata.version}'`,
    });
  }

  if (!metadata.updated_at) {
    findings.push({
      level: "ERROR",
      code: "METADATA_UPDATED_AT_MISSING",
      skill: path.basename(skillDir),
      message: `${relFile}: missing metadata.updated_at`,
    });
  } else if (!isValidUtcIso(metadata.updated_at)) {
    findings.push({
      level: "ERROR",
      code: "METADATA_UPDATED_AT_INVALID",
      skill: path.basename(skillDir),
      message: `${relFile}: invalid metadata.updated_at '${metadata.updated_at}'`,
    });
  }

  if (!metadata.target_provider) {
    findings.push({
      level: "ERROR",
      code: "METADATA_TARGET_PROVIDER_MISSING",
      skill: path.basename(skillDir),
      message: `${relFile}: missing metadata.target_provider`,
    });
  } else if (!targetProvider) {
    findings.push({
      level: "ERROR",
      code: "METADATA_TARGET_PROVIDER_INVALID",
      skill: path.basename(skillDir),
      message: `${relFile}: invalid metadata.target_provider '${metadata.target_provider}'`,
    });
  }

  if (metadata.compatible_providers) {
    for (const message of validateCompatibleProviders(
      metadata.compatible_providers,
      targetProvider
    )) {
      findings.push({
        level: "ERROR",
        code: "METADATA_COMPATIBLE_PROVIDERS_INVALID",
        skill: path.basename(skillDir),
        message: `${relFile}: ${message}`,
      });
    }
  }

  for (const key of LEGACY_METADATA_KEYS) {
    if (!(key in metadata)) {
      continue;
    }
    findings.push({
      level: options.strict ? "ERROR" : "WARN",
      code: "LEGACY_METADATA_KEY",
      skill: path.basename(skillDir),
      message: `${relFile}: legacy metadata key '${key}' should be removed`,
    });
  }

  const headParsed = loadHeadParsed(skillFile, options.repoRoot);
  const dirty = options.dirtySkillDirs.has(skillDir);
  const substantiveChange = dirty && hasSubstantiveSkillChange(skillDir, parsed, options);
  if (substantiveChange && headParsed) {
    const currentVersion = normalizeSemverLoose(metadata.version);
    const headVersion = normalizeSemverLoose(headParsed.metadata.version);
    const currentUpdatedAt = stripQuotes(metadata.updated_at);
    const headUpdatedAt = stripQuotes(headParsed.metadata.updated_at);

    if (currentVersion && headVersion && currentVersion === headVersion) {
      findings.push({
        level: options.strict ? "ERROR" : "WARN",
        code: "PENDING_VERSION_BUMP",
        skill: path.basename(skillDir),
        message: `${relFile}: skill directory changed relative to HEAD without metadata.version bump`,
      });
    }

    if (currentUpdatedAt && headUpdatedAt && currentUpdatedAt === headUpdatedAt) {
      findings.push({
        level: options.strict ? "ERROR" : "WARN",
        code: "PENDING_UPDATED_AT_REFRESH",
        skill: path.basename(skillDir),
        message: `${relFile}: skill directory changed relative to HEAD without metadata.updated_at refresh`,
      });
    }
  }

  return findings;
}

function syncSkill(skillDir: string, options: SyncOptions): SyncOutcome {
  const skillFile = path.join(skillDir, "SKILL.md");
  const original = fs.readFileSync(skillFile, "utf8");
  const parsed: ParsedFrontmatter = parseFrontmatter(original);
  if (!parsed.ok) {
    return {
      ok: false,
      changed: false,
      path: skillFile,
      message: parsed.error,
    };
  }

  const next: ParsedMetadataFrontmatter = cloneParsedFrontmatter(parsed);
  const metadata = (next.metadata || {}) as Record<string, string>;
  const headParsed = loadHeadParsed(skillFile, options.repoRoot);
  const headVersion = headParsed ? normalizeSemverLoose(headParsed.metadata.version) : null;
  const currentVersion = normalizeSemverLoose(metadata.version);
  const hasLegacyMetadata = LEGACY_METADATA_KEYS.some((key: string) => key in metadata);
  const currentUpdatedAt = isValidUtcIso(metadata.updated_at) ? stripQuotes(metadata.updated_at) : null;
  const headUpdatedAt =
    headParsed && isValidUtcIso(headParsed.metadata.updated_at)
      ? stripQuotes(headParsed.metadata.updated_at)
      : null;

  let version = currentVersion || headVersion || "1.0.0";
  let updatedAt = currentUpdatedAt;

  if (options.mode === "all") {
    const legacyUpdatedAt =
      toUtcIso(metadata.last_update) || toUtcIso(metadata.created_on);
    const substantiveWorkingChange = hasSubstantiveSkillChange(skillDir, parsed, {
      repoRoot: options.repoRoot,
    });
    updatedAt =
      legacyUpdatedAt ||
      (substantiveWorkingChange
        ? currentUpdatedAt
        : getGitLastModified(skillFile, options.repoRoot)) ||
      currentUpdatedAt ||
      options.now;
  } else {
    const shouldBump =
      headParsed && headVersion && currentVersion && currentVersion === headVersion;
    if (shouldBump) {
      version = bumpPatch(headVersion) || version;
    }

    const needsRefresh =
      hasLegacyMetadata ||
      !currentUpdatedAt ||
      !normalizeProviderId(metadata.target_provider) ||
      (headUpdatedAt && currentUpdatedAt === headUpdatedAt) ||
      shouldBump;

    if (needsRefresh) {
      updatedAt = options.now;
    }
  }

  const normalizedUpdatedAt: string | number | Date | undefined = updatedAt === null ? undefined : updatedAt;
  const fallbackNow: string | number | Date | undefined = options.now === null ? undefined : options.now;
  const normalizeOpts: { version: string; defaultProvider: typeof PROVIDER_IDS[number]; updatedAt?: string | number | Date } = {
    version,
    defaultProvider: options.defaultProvider as typeof PROVIDER_IDS[number],
  };
  const resolvedUpdatedAt = normalizedUpdatedAt ?? fallbackNow;
  if (resolvedUpdatedAt !== undefined) normalizeOpts.updatedAt = resolvedUpdatedAt;
  next.metadata = normalizeManagedMetadata(metadata, normalizeOpts);

  const rendered = serializeFrontmatter(next);
  if (rendered === original) {
    const result: SyncResult = {
      ok: true,
      changed: false,
      path: skillFile,
    };
    if (next.metadata.version) result.version = next.metadata.version;
    return result;
  }

  if (options.write) {
    fs.writeFileSync(skillFile, rendered, "utf8");
  }

  const result2: SyncResult = {
    ok: true,
    changed: true,
    path: skillFile,
  };
  if (next.metadata.version) result2.version = next.metadata.version;
  return result2;
}

function auditCommand(options: MetadataCLIOptions): void {
  const repoRoot = resolveRepoRoot(path.dirname(options.skillsRoot));
  const dirtySkillDirs = new Set(
    collectChangedSkillDirs(options.skillsRoot, repoRoot, "working")
  );
  const findings: AuditFinding[] = [];

  for (const skillDir of listSkillDirs(options.skillsRoot)) {
    findings.push(
      ...collectAuditFindings(skillDir, {
        strict: options.strict,
        repoRoot,
        dirtySkillDirs,
      })
    );
  }

  const errors = findings.filter((finding) => finding.level === "ERROR");
  const warnings = findings.filter((finding) => finding.level === "WARN");

  if (!findings.length) {
    console.log("STATUS: PASS");
    console.log("Errors: 0  Warnings: 0");
    return;
  }

  const status = errors.length ? "BLOCKING" : "CONCERNS";
  console.log(`STATUS: ${status}`);
  console.log(`Errors: ${errors.length}  Warnings: ${warnings.length}`);
  console.log("\nFINDINGS:");
  for (const finding of findings) {
    console.log(`- [${finding.level} ${finding.code}] ${finding.message}`);
  }

  if (errors.length) {
    process.exit(1);
  }
}

function syncCommand(options: MetadataCLIOptions & { mode: SyncMode }): void {
  const repoRoot = resolveRepoRoot(path.dirname(options.skillsRoot));
  const now = toUtcIso(new Date());
  const targetSkillDirs =
    options.mode === "staged"
      ? collectChangedSkillDirs(options.skillsRoot, repoRoot, "staged")
      : listSkillDirs(options.skillsRoot);

  if (targetSkillDirs.length === 0) {
    console.log("No target skills found.");
    return;
  }

  const results: SyncOutcome[] = [];
  for (const skillDir of targetSkillDirs) {
    results.push(
      syncSkill(skillDir, {
        defaultProvider: options.defaultProvider,
        mode: options.mode,
        now,
        repoRoot,
        write: options.write,
      })
    );
  }

  const failures = results.filter((result): result is SyncFailure => !result.ok);
  const changed = results.filter((result): result is SyncResult => result.ok && result.changed);
  const unchanged = results.filter(
    (result): result is SyncResult => result.ok && !result.changed
  );

  for (const result of changed) {
    console.log(`updated: ${path.relative(process.cwd(), result.path).replaceAll("\\", "/")}`);
  }
  for (const result of unchanged) {
    console.log(`unchanged: ${path.relative(process.cwd(), result.path).replaceAll("\\", "/")}`);
  }
  for (const result of failures) {
    console.log(
      `error: ${path.relative(process.cwd(), result.path).replaceAll("\\", "/")}: ${result.message}`
    );
  }

  console.log(
    `done: mode=${options.mode} write=${options.write ? "yes" : "no"} updated=${changed.length} unchanged=${unchanged.length} errors=${failures.length}`
  );

  if (failures.length) {
    process.exit(1);
  }
}

function main(): void {
  let options: MetadataCLIOptions;
  try {
    options = parseArgs(process.argv);
  } catch (error: unknown) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    help();
    process.exit(1);
  }

  if (options.help || options.command === "help") {
    help();
    return;
  }

  if (options.command === "audit") {
    auditCommand(options);
    return;
  }

  if (options.command === "sync") {
    syncCommand({
      ...options,
      mode: options.staged ? "staged" : "all",
    });
    return;
  }

  console.error(`ERROR: Unknown command '${options.command}'`);
  help();
  process.exit(1);
}

if (require.main === module) {
  main();
}

export {
  auditCommand,
  collectAuditFindings,
  collectChangedSkillDirs,
  loadHeadParsed,
  main,
  parseArgs,
  resolveRepoRoot,
  syncCommand,
  syncSkill,
};
