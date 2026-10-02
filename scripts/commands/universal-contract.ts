#!/usr/bin/env bun
/**
 * Cross-platform SKILL.md contract checker/fixer (Codex + OpenCode safe subset)
 *
 * Contract:
 * - SKILL.md must have YAML frontmatter
 * - required top-level keys: name, description
 * - allowed top-level keys: name, description, metadata, license, allowed-tools
 * - metadata.tags/triggers/references/compatible_providers must be CSV string when present
 *   (arrays/multiline list syntax are rejected)
 * - metadata.version/updated_at/target_provider are required for root skills
 */

import fs from "node:fs";
import path from "node:path";
import {
  CSV_METADATA_KEYS,
  LEGACY_METADATA_KEYS,
  PROVIDER_IDS,
  isValidSemver,
  isValidUtcIso,
  normalizeProviderId,
  normalizeProviderList,
  quoteFrontmatterScalarIfNeeded,
  stripQuotes,
  validateFrontmatterScalarSyntax,
} from "../modules/skill-metadata-lib.ts";

interface ContractOptions {
  skillsRoot: string;
  onlyWithSkillMd: boolean;
  fix: boolean;
  help: boolean;
}

interface ParsedFrontmatterOk {
  ok: true;
  lines: string[];
  start: number;
  end: number;
}

interface ParsedFrontmatterError {
  ok: false;
  error: string;
}

type ParsedFrontmatterLines = ParsedFrontmatterOk | ParsedFrontmatterError;

interface FixFrontmatterResult {
  fixed: boolean;
  content: string;
  changed: boolean;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_TOP_LEVEL = new Set([
  "name",
  "description",
  "metadata",
  "license",
  "allowed-tools",
]);
const CSV_KEYS = CSV_METADATA_KEYS;
const CSV_KEY_PATTERN = "(tags|triggers|references|compatible_providers)";

function help(): void {
  console.log(`
Universal skill contract checker

Usage:
  bun scripts/commands/universal-contract.ts [options]

Options:
  --skills-root <dir>   Skills root directory (default: ./skills)
  --only-with-skill-md  Ignore subfolders that do not contain SKILL.md
  --fix                 Auto-fix CSV array/list syntax for CSV metadata fields
  --help                Show help

Examples:
  bun scripts/commands/universal-contract.ts
  bun scripts/commands/universal-contract.ts --skills-root /path/to/skills
  bun scripts/commands/universal-contract.ts --skills-root /path/to/skills --only-with-skill-md
  bun scripts/commands/universal-contract.ts --fix
`);
}

function parseArgs(argv: string[]): ContractOptions {
  const options: ContractOptions = {
    skillsRoot: path.resolve(process.cwd(), "skills"),
    onlyWithSkillMd: false,
    fix: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--fix") {
      options.fix = true;
      continue;
    }
    if (token === "--only-with-skill-md") {
      options.onlyWithSkillMd = true;
      continue;
    }

    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      if (key === "skills-root") {
        options.skillsRoot = path.resolve(process.cwd(), value);
      } else {
        throw new Error(`Unknown option: ${token}`);
      }
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function listSkillDirs(skillsRoot: string, onlyWithSkillMd: boolean): string[] {
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      if (!onlyWithSkillMd) {
        return true;
      }
      return fs.existsSync(path.join(skillsRoot, name, "SKILL.md"));
    })
    .sort((a: string, b: string) => a.localeCompare(b));
}

function parseFrontmatterLines(content: string): ParsedFrontmatterLines {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!lines.length || lines[0]!.trim() !== "---") {
    return { ok: false, error: "missing YAML frontmatter" };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { ok: false, error: "missing closing frontmatter delimiter" };
  }
  return { ok: true, lines, start: 1, end };
}

function unquote(value: string): string {
  return value.replace(/^\s*/, "").replace(/^['"]|['"]$/g, "").trim();
}

function fixFrontmatter(content: string): FixFrontmatterResult {
  const parsed = parseFrontmatterLines(content);
  if (!parsed.ok) {
    return { fixed: false, content, changed: false };
  }

  const { lines, start, end } = parsed;
  const fm = lines.slice(start, end);
  const body = lines.slice(end + 1);
  const out: string[] = [];
  let changed = false;

  for (let i = 0; i < fm.length; i += 1) {
    const line = fm[i]!;

    const scalar = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.+)$/);
    if (scalar && scalar[2] !== "metadata") {
      const nextValue = quoteFrontmatterScalarIfNeeded(scalar[3]!);
      if (nextValue !== scalar[3]) {
        out.push(`${scalar[1]}${scalar[2]}: ${nextValue}`);
        changed = true;
        continue;
      }
    }

    const inline = line.match(new RegExp(`^(\\s*)${CSV_KEY_PATTERN}:\\s*\\[(.*)\\]\\s*$`));
    if (inline) {
      const indent = inline[1]!;
      const key = inline[2]!;
      const items = inline[3]!
        .split(",")
        .map((x: string) => unquote(x))
        .filter(Boolean)
        .join(", ");
      out.push(`${indent}${key}: "${items}"`);
      changed = true;
      continue;
    }

    const listStart = line.match(new RegExp(`^(\\s*)${CSV_KEY_PATTERN}:\\s*$`));
    if (listStart) {
      const indent = listStart[1]!;
      const key = listStart[2]!;
      const items: string[] = [];
      let j = i + 1;
      while (j < fm.length) {
        const m = fm[j]!.match(/^\s+-\s+(.*)$/);
        if (!m) {
          break;
        }
        items.push(unquote(m[1]!));
        j += 1;
      }
      if (items.length) {
        out.push(`${indent}${key}: "${items.filter(Boolean).join(", ")}"`);
        i = j - 1;
        changed = true;
        continue;
      }
    }

    out.push(line);
  }

  if (!changed) {
    return { fixed: false, content, changed: false };
  }

  const merged = ["---", ...out, "---", ...body].join("\n");
  return { fixed: true, content: merged, changed: true };
}

function validateSkill(skillName: string, skillPath: string): string[] {
  const issues: string[] = [];
  const skillMd = path.join(skillPath, "SKILL.md");

  if (!fs.existsSync(skillMd)) {
    issues.push(`missing SKILL.md`);
    return issues;
  }

  const content = fs.readFileSync(skillMd, "utf8");
  const parsed = parseFrontmatterLines(content);
  if (!parsed.ok) {
    issues.push(parsed.error);
    return issues;
  }

  const { lines, start, end } = parsed;
  const fmLines = lines.slice(start, end);
  for (const scalarIssue of validateFrontmatterScalarSyntax(fmLines)) {
    issues.push(scalarIssue);
  }

  const topKeys = new Set<string>();
  let inMetadata = false;
  let nameValue: string | null = null;
  let descriptionValue: string | null = null;
  const metadata: Record<string, string> = {};

  for (let i = 0; i < fmLines.length; i += 1) {
    const line = fmLines[i]!;

    if (/\|-$|>-|^\s*description:\s*[>|]/.test(line)) {
      issues.push("description must be a single-line scalar");
    }

    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (top) {
      const key = top[1]!;
      const value = top[2]!;
      topKeys.add(key);
      inMetadata = key === "metadata";

      if (key === "name") {
        nameValue = unquote(value);
      }
      if (key === "description") {
        descriptionValue = unquote(value);
      }

      if (!ALLOWED_TOP_LEVEL.has(key)) {
        issues.push(`unexpected top-level key: ${key}`);
      }
      continue;
    }

    const nested = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nested && inMetadata) {
      const key = nested[1]!;
      const value = nested[2]!;
      metadata[key] = unquote(value);
      if (CSV_KEYS.has(key)) {
        if (value.startsWith("[")) {
          issues.push(`metadata.${key} must be CSV string (array found)`);
        } else if (value.trim() === "") {
          let hasList = false;
          for (let j = i + 1; j < fmLines.length; j += 1) {
            if (/^\s+-\s+/.test(fmLines[j]!)) {
              hasList = true;
            } else {
              break;
            }
          }
          if (hasList) {
            issues.push(`metadata.${key} must be CSV string (list syntax found)`);
          }
        }
      }
    }
  }

  if (!topKeys.has("name")) {
    issues.push("missing frontmatter key: name");
  }
  if (!topKeys.has("description")) {
    issues.push("missing frontmatter key: description");
  }

  if (nameValue) {
    if (!NAME_PATTERN.test(nameValue)) {
      issues.push(`invalid name format: ${nameValue}`);
    }
    if (nameValue !== skillName) {
      issues.push(`name mismatch: frontmatter '${nameValue}' vs folder '${skillName}'`);
    }
  }

  if (descriptionValue !== null && !descriptionValue) {
    issues.push("description must be non-empty string");
  }

  if (!metadata.version) {
    issues.push("missing metadata.version");
  } else if (!isValidSemver(metadata.version)) {
    issues.push(`metadata.version must be semver x.y.z: ${metadata.version}`);
  }

  if (!metadata.updated_at) {
    issues.push("missing metadata.updated_at");
  } else if (!isValidUtcIso(metadata.updated_at)) {
    issues.push(`metadata.updated_at must be UTC ISO timestamp: ${metadata.updated_at}`);
  }

  const targetProvider = normalizeProviderId(metadata.target_provider);
  if (!metadata.target_provider) {
    issues.push("missing metadata.target_provider");
  } else if (!targetProvider) {
    issues.push(
      `metadata.target_provider must be one of ${PROVIDER_IDS.join(", ")}: ${metadata.target_provider}`
    );
  }

  if (metadata.compatible_providers) {
    const rawProviders = String(metadata.compatible_providers)
      .split(",")
      .map((provider: string) => stripQuotes(provider))
      .filter(Boolean);
    const normalizedProviders = normalizeProviderList(metadata.compatible_providers, {
      exclude: [targetProvider],
    });
    if (rawProviders.includes("universal")) {
      issues.push("metadata.compatible_providers must not include universal");
    }
    if (targetProvider && rawProviders.includes(targetProvider)) {
      issues.push("metadata.compatible_providers must not repeat metadata.target_provider");
    }
    if (normalizedProviders.length !== rawProviders.length) {
      issues.push("metadata.compatible_providers contains invalid or duplicate providers");
    }
  }

  for (const key of LEGACY_METADATA_KEYS) {
    if (key in metadata) {
      issues.push(`legacy metadata key is no longer allowed: metadata.${key}`);
    }
  }

  return issues;
}

function main(): void {
  let options: ContractOptions;
  try {
    options = parseArgs(process.argv);
  } catch (error: unknown) {
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
    help();
    process.exit(1);
  }

  if (options.help) {
    help();
    return;
  }

  const skills = listSkillDirs(options.skillsRoot, options.onlyWithSkillMd);
  if (!skills.length) {
    console.log("STATUS: BLOCKING");
    console.log("Errors: 1  Warnings: 0");
    console.log(`\nFINDINGS:\n- [ERROR SKILLS_ROOT_EMPTY] ${options.skillsRoot}`);
    process.exit(1);
  }

  let fixedCount = 0;
  if (options.fix) {
    for (const skill of skills) {
      const p = path.join(options.skillsRoot, skill, "SKILL.md");
      if (!fs.existsSync(p)) {
        continue;
      }
      const original = fs.readFileSync(p, "utf8");
      const { changed, content } = fixFrontmatter(original);
      if (changed) {
        fs.writeFileSync(p, content, "utf8");
        fixedCount += 1;
      }
    }
  }

  const findings: string[] = [];
  for (const skill of skills) {
    const skillPath = path.join(options.skillsRoot, skill);
    const issues = validateSkill(skill, skillPath);
    for (const msg of issues) {
      findings.push(`[ERROR ${skill}] ${msg}`);
    }
  }

  const status = findings.length ? "BLOCKING" : "PASS";
  console.log(`STATUS: ${status}`);
  console.log(`Errors: ${findings.length}  Warnings: 0`);
  if (options.fix) {
    console.log(`Fixed: ${fixedCount}`);
  }
  if (findings.length) {
    console.log("\nFINDINGS:");
    for (const f of findings.slice(0, 200)) {
      console.log(`- ${f}`);
    }
    if (findings.length > 200) {
      console.log(`- ... (${findings.length - 200} more)`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export {
  ALLOWED_TOP_LEVEL,
  CSV_KEY_PATTERN,
  CSV_KEYS,
  NAME_PATTERN,
  fixFrontmatter,
  help,
  listSkillDirs,
  main,
  parseArgs,
  parseFrontmatterLines,
  validateSkill,
};
