#!/usr/bin/env bun

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireOptionValue } from "../lib/args.ts";
import { fileExists, readJson } from "../lib/files.ts";
import { parseFrontmatter } from "../modules/skill-metadata-lib.ts";
import { normalizeSkillNameStrict } from "../modules/skillpool/entry.ts";
import { parseProviderList, type ConcreteProviderId } from "../modules/skillpool/providers.ts";
import { hasDangerousRisk, readSkillMeta } from "../modules/skillpool/skill-meta.ts";
import { resolvePoolRoot, resolveSourceLayout } from "../modules/skillpool/source.ts";

type ProviderDoctorProvider = ConcreteProviderId | "all";

interface ProviderDoctorArgs {
  source: string;
  project: string;
  provider: ProviderDoctorProvider;
  duplicates: boolean;
  permissions: boolean;
  json: boolean;
  help: boolean;
}

interface ProviderDoctorFinding {
  level: "WARN" | "ERROR";
  code: string;
  message: string;
  paths?: string[];
}

interface ProviderDoctorDeps {
  listSkillNames?: (dirPath: string) => string[];
}

interface StrictSkillListing {
  valid: string[];
  invalid: { name: string; reason: string }[];
}

interface ProviderDoctorResult {
  provider: ProviderDoctorProvider;
  findings: ProviderDoctorFinding[];
}

function help(): void {
  console.log(`
Run provider-specific skill diagnostics

Usage:
  bun scripts/commands/provider-doctor.ts [options]

Options:
  --source <dir>       Source root (default: .)
  --project <dir>      Target project directory (default: .)
  --provider <id>      Provider to diagnose (required)
  --duplicates         Check duplicate skill names across visible scopes
  --permissions        Check provider permission footguns
  --json               Emit machine-readable output
  --help               Show help

Findings:
  CODEX_DUPLICATE_SKILL (WARN)     Same strict-normalized skill name in multiple Codex scopes
  CODEX_INVALID_SKILL_NAME (ERROR) Skill directory name rejected by the strict name policy
  SOURCE_INVALID_SKILL_NAME (ERROR) Source pool skill directory name rejected by the strict policy
`);
}

function parseProvider(value: string): ProviderDoctorProvider {
  if (value === "all") {
    return "all";
  }
  const providers = parseProviderList(value);
  if (providers.length !== 1) {
    throw new Error("--provider expects one provider id");
  }
  return providers[0]!;
}

function parseArgs(argv: string[] = process.argv): ProviderDoctorArgs {
  const args: ProviderDoctorArgs = {
    source: ".",
    project: ".",
    provider: "codex",
    duplicates: false,
    permissions: false,
    json: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--duplicates") {
      args.duplicates = true;
      continue;
    }
    if (token === "--permissions") {
      args.permissions = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--source") {
      args.source = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--project") {
      args.project = requireOptionValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--provider") {
      args.provider = parseProvider(requireOptionValue(argv, i, token));
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.source = path.resolve(process.cwd(), args.source);
  args.project = path.resolve(process.cwd(), args.project);
  if (!args.duplicates && !args.permissions) {
    args.duplicates = args.provider === "codex" || args.provider === "all";
    args.permissions = args.provider !== "codex";
  }
  return args;
}

function listSkillNames(dirPath: string): string[] {
  if (!fileExists(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

// Skill-name identity uses the same strict normalizer as install/sync. It is
// case-preserving: names that differ only by case stay distinct identities and
// are never folded together. Names rejected by the normalizer are reported as
// deterministic findings instead of being skipped silently or thrown unhandled.
function strictListSkillNames(
  dirPath: string,
  listSkillNamesFn: (dirPath: string) => string[]
): StrictSkillListing {
  const valid: string[] = [];
  const invalid: { name: string; reason: string }[] = [];
  for (const rawName of listSkillNamesFn(dirPath)) {
    try {
      valid.push(normalizeSkillNameStrict(rawName));
    } catch (error) {
      invalid.push({
        name: rawName,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { valid, invalid };
}

function invalidSkillNameFindings(
  code: "CODEX_INVALID_SKILL_NAME" | "SOURCE_INVALID_SKILL_NAME",
  dirPath: string,
  invalid: StrictSkillListing["invalid"]
): ProviderDoctorFinding[] {
  return invalid.map(({ name, reason }) => ({
    level: "ERROR" as const,
    code,
    message: reason,
    paths: [path.join(dirPath, name)],
  }));
}

function visibleCodexSkillScopes(projectDir: string): string[] {
  const scopes: string[] = [];
  let current = path.resolve(projectDir);
  while (true) {
    scopes.push(path.join(current, ".agents", "skills"));
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  scopes.push(path.join(os.homedir(), ".agents", "skills"));
  scopes.push(path.join(path.sep, "etc", "codex", "skills"));
  return [...new Set(scopes)];
}

function checkCodexDuplicates(
  projectDir: string,
  deps: ProviderDoctorDeps = {}
): ProviderDoctorFinding[] {
  const listSkillNamesFn = deps.listSkillNames ?? listSkillNames;
  const seen = new Map<string, string[]>();
  const invalidFindings: ProviderDoctorFinding[] = [];
  for (const scope of visibleCodexSkillScopes(projectDir)) {
    const listing = strictListSkillNames(scope, listSkillNamesFn);
    invalidFindings.push(...invalidSkillNameFindings("CODEX_INVALID_SKILL_NAME", scope, listing.invalid));
    for (const skillName of listing.valid) {
      const entries = seen.get(skillName) || [];
      entries.push(scope);
      seen.set(skillName, entries);
    }
  }
  const duplicateFindings = [...seen.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([skill, paths]) => ({
      level: "WARN" as const,
      code: "CODEX_DUPLICATE_SKILL",
      message: `Duplicate Codex skill name: ${skill}`,
      paths,
    }));
  return [...invalidFindings, ...duplicateFindings];
}

function projectHasClaudeDenyBaseline(projectDir: string): boolean {
  for (const relative of [".claude/settings.json", ".claude/settings.local.json"]) {
    const settingsPath = path.join(projectDir, relative);
    if (!fileExists(settingsPath)) {
      continue;
    }
    const parsed = readJson(settingsPath) as { permissions?: { deny?: unknown } };
    if (Array.isArray(parsed.permissions?.deny) && parsed.permissions.deny.length > 0) {
      return true;
    }
  }
  return false;
}

function checkClaudePermissions(
  sourceRoot: string,
  projectDir: string,
  deps: ProviderDoctorDeps = {}
): ProviderDoctorFinding[] {
  const layout = resolveSourceLayout(sourceRoot, { requireSkills: true });
  const poolRoot = resolvePoolRoot(sourceRoot, layout);
  const hasDeny = projectHasClaudeDenyBaseline(projectDir);
  const findings: ProviderDoctorFinding[] = [];
  const listing = strictListSkillNames(layout.skillsDir, deps.listSkillNames ?? listSkillNames);
  findings.push(...invalidSkillNameFindings("SOURCE_INVALID_SKILL_NAME", layout.skillsDir, listing.invalid));
  for (const skillName of listing.valid) {
    const skillPath = path.join(layout.skillsDir, skillName, "SKILL.md");
    const parsed = parseFrontmatter(fs.readFileSync(skillPath, "utf8"));
    if (!parsed.ok || !("allowed-tools" in parsed.top)) {
      continue;
    }
    if (!hasDeny) {
      findings.push({
        level: "WARN",
        code: "CLAUDE_ALLOWED_TOOLS_WITHOUT_DENY",
        message: `${skillName} declares allowed-tools but project has no Claude deny baseline`,
        paths: [path.relative(poolRoot, skillPath).replaceAll("\\", "/")],
      });
    }
  }
  return findings;
}

function checkOpenCodePermissions(sourceRoot: string, deps: ProviderDoctorDeps = {}): ProviderDoctorFinding[] {
  const layout = resolveSourceLayout(sourceRoot, { requireSkills: true });
  const findings: ProviderDoctorFinding[] = [];
  const listing = strictListSkillNames(layout.skillsDir, deps.listSkillNames ?? listSkillNames);
  findings.push(...invalidSkillNameFindings("SOURCE_INVALID_SKILL_NAME", layout.skillsDir, listing.invalid));
  for (const skillName of listing.valid) {
    const meta = readSkillMeta(path.join(layout.skillsDir, skillName), skillName);
    if (hasDangerousRisk(meta)) {
      findings.push({
        level: "WARN",
        code: "OPENCODE_RISKY_SKILL_NEEDS_PERMISSION_REVIEW",
        message: `${skillName} has risky metadata and should render ask/deny OpenCode permissions`,
      });
    }
  }
  return findings;
}

function providerDoctor(args: ProviderDoctorArgs, deps: ProviderDoctorDeps = {}): ProviderDoctorResult {
  const findings: ProviderDoctorFinding[] = [];
  if ((args.provider === "codex" || args.provider === "all") && args.duplicates) {
    findings.push(...checkCodexDuplicates(args.project, deps));
  }
  if ((args.provider === "claude-code" || args.provider === "all") && args.permissions) {
    findings.push(...checkClaudePermissions(args.source, args.project, deps));
  }
  if ((args.provider === "opencode" || args.provider === "all") && args.permissions) {
    findings.push(...checkOpenCodePermissions(args.source, deps));
  }
  return {
    provider: args.provider,
    findings,
  };
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  const result = providerDoctor(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.findings.length ? "STATUS: WARN" : "STATUS: PASS");
  console.log(`Provider: ${result.provider}`);
  console.log(`Findings: ${result.findings.length}`);
  for (const finding of result.findings) {
    console.log(`- [${finding.level} ${finding.code}] ${finding.message}`);
    for (const item of finding.paths || []) {
      console.log(`  - ${item}`);
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
}

export {
  checkClaudePermissions,
  checkCodexDuplicates,
  checkOpenCodePermissions,
  help,
  main,
  parseArgs,
  providerDoctor,
};
export type {
  ProviderDoctorDeps,
  ProviderDoctorFinding,
  ProviderDoctorResult,
};
