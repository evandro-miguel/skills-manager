#!/usr/bin/env bun
// <!-- markdownlint-disable-file -->
/**
 * Generate skills inventory from SKILL.md files
 * Output: SKILLS.md and SKILLS.json with name, description, tier, and metadata for each skill
 */

import fs from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SKILLS_DIR = path.join(__dirname, "..", "..", "skills");
const OUTPUT_MARKDOWN_FILE = path.join(__dirname, "..", "..", "SKILLS.md");
const OUTPUT_JSON_FILE = path.join(__dirname, "..", "..", "SKILLS.json");
const LIFECYCLE_FILE = path.join(__dirname, "..", "..", "skill-lifecycle.json");
const GENERATOR_PATH = "scripts/commands/generate-skills-inventory.ts";

interface GenerateInventoryArgs {
  help: boolean;
  includeInternal: boolean;
  includeExperimental: boolean;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  deprecated?: string | boolean;
  metadata?: Record<string, string | boolean>;
  archived?: string | boolean;
  compatibility_only?: string | boolean;
  category?: string;
}

interface SkillInventoryEntry {
  name: string;
  description: string;
  version: string;
  updatedAt: string;
  targetProvider: string;
  tier: number;
  lineCount: number;
  skillDir: string;
  skillFile: string;
}

interface LifecycleEntry {
  skill?: string;
  event?: string;
  date?: string;
  replacements?: string[];
  agent_action?: string;
}

interface JsonLifecycleRedirect {
  skill: string;
  event: string;
  date: string;
  replacements: string[];
  agentAction: string;
}

interface JsonTierInventory {
  definition: string;
  skillNames: string[];
}

interface JsonSkillsInventory {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    skillsDir: "skills";
    lifecycleFile: "skill-lifecycle.json";
    generator: typeof GENERATOR_PATH;
  };
  totalSkills: number;
  skills: SkillInventoryEntry[];
  skillsByName: Record<string, SkillInventoryEntry>;
  tiers: Record<string, JsonTierInventory>;
  lifecycleRedirects: JsonLifecycleRedirect[];
  notes: string[];
}

function wrapText(text: unknown, width: number): string[] {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ");

  if (!words[0]) return ["Description unavailable."];

  const lines: string[] = [];
  let line = words[0];

  for (const word of words.slice(1)) {
    if ((line + " " + word).length <= width) {
      line += " " + word;
    } else {
      lines.push(line);
      line = word;
    }
  }

  lines.push(line);
  return lines;
}

function help(): void {
  console.log(`
Generate skills inventory from checked-in skills/

Usage:
  bun scripts/commands/generate-skills-inventory.ts [options]

Options:
  --help                  Show help
  --include-internal      Include skills with metadata.internal set (hidden by default)
  --include-experimental  Include skills with metadata.experimental set (hidden by default)

Outputs:
  SKILLS.md and SKILLS.json in repositories that contain a canonical skills/ catalog.
`);
}

function parseArgs(argv: string[] = process.argv): GenerateInventoryArgs {
  const args: GenerateInventoryArgs = { help: false, includeInternal: false, includeExperimental: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--include-internal") {
      args.includeInternal = true;
      continue;
    }
    if (token === "--include-experimental") {
      args.includeExperimental = true;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return args;
}

function normalizeValue(value: string): string | boolean {
  const trimmed = value.trim();
  if (trimmed === "true" || trimmed === "1") return true;
  if (trimmed === "false" || trimmed === "0") return false;
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

function isCompatibilityArtifact(meta: ParsedFrontmatter): boolean {
  const metadataCategory = meta.metadata?.category;
  const hasDeprecated = isTruthy(meta.deprecated) || isTruthy(meta.metadata?.deprecated);
  const hasArchived = isTruthy(meta.archived) || isTruthy(meta.metadata?.archived);
  const isCompatibilityOnly =
    isTruthy(meta.compatibility_only) ||
    isTruthy(meta.metadata?.compatibility_only);
  const isCompatibilityCategory =
    String(meta.category || "").toLowerCase() === "compatibility" ||
    String(metadataCategory || "").toLowerCase() === "compatibility";

  return hasDeprecated || hasArchived || isCompatibilityOnly || isCompatibilityCategory;
}

/**
 * PR08 metadata visibility flags.
 *
 * Skills with a truthy `metadata.internal` or `metadata.experimental` value are
 * hidden from public discovery outputs (inventory / list) unless the caller
 * explicitly opts in. Truthy values: boolean true, and the strings "true",
 * "1", "yes", "on". Compatibility/deprecated/archived filtering is independent
 * and keeps its existing behavior.
 */
function isHiddenByMetadataFlags(
  meta: ParsedFrontmatter,
  options: { includeInternal?: boolean; includeExperimental?: boolean }
): boolean {
  if (!options.includeInternal && isTruthy(meta.metadata?.internal)) {
    return true;
  }
  if (!options.includeExperimental && isTruthy(meta.metadata?.experimental)) {
    return true;
  }
  return false;
}

function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1]!;
  const result: ParsedFrontmatter = {};

  // Parse YAML-like frontmatter
  const lines = frontmatter.split("\n");
  let i = 0;
  result.metadata = {};

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) {
      i += 1;
      continue;
    }

    const [, key, rawValue] = keyMatch;

    if (rawValue === "|" || rawValue === ">") {
      const nestedValue: string[] = [];
      i += 1;
      while (i < lines.length && /^ {2,}/.test(lines[i]!)) {
        nestedValue.push(lines[i]!.replace(/^ {2}/, ""));
        i += 1;
      }
      (result as Record<string, string | boolean | Record<string, string | boolean>>)[key!] = nestedValue.join("\n");
      continue;
    }

    if (key === "metadata" && rawValue === "") {
      const metadata: Record<string, string | boolean> = {};
      i += 1;
      while (i < lines.length) {
        const nestedLine = lines[i]!;
        const nestedMatch = nestedLine.match(/^ {2}([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!nestedMatch) break;

        const [, nestedKey, nestedVal] = nestedMatch;
        metadata[nestedKey!] = normalizeValue(nestedVal!);
        i += 1;
      }
      result[key!] = metadata;
      continue;
    }

    (result as Record<string, string | boolean | Record<string, string | boolean>>)[key!] = normalizeValue(rawValue!);
    i += 1;
  }

  const out: ParsedFrontmatter = {
    name: result.name!,
    description: result.description!,
  };
  if (result.deprecated !== undefined) out.deprecated = result.deprecated;
  if (result.metadata) out.metadata = result.metadata;
  if (result.archived !== undefined) out.archived = result.archived;
  if (result.compatibility_only !== undefined) out.compatibility_only = result.compatibility_only;
  if (result.category !== undefined) out.category = result.category;
  return out;
}

function calculateTier(skillDir: string, lineCount: number): number {
  // Check for references/ folder
  const referencesPath = path.join(skillDir, "references");
  let hasReferences = false;

  try {
    hasReferences = fs.existsSync(referencesPath);
  } catch (_error) {
    hasReferences = false;
  }

  if (lineCount > 800 && hasReferences) {
    return 3;
  }

  if (lineCount >= 200 || hasReferences) {
    return 2;
  }
  return 1;
}

async function loadLifecycleEntries(): Promise<LifecycleEntry[]> {
  try {
    const lifecycle = JSON.parse(await readFile(LIFECYCLE_FILE, "utf-8"));
    return Array.isArray(lifecycle.entries)
      ? [...lifecycle.entries].sort((a, b) => {
          const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
          if (dateCompare !== 0) return dateCompare;
          return String(a.skill || "").localeCompare(String(b.skill || ""));
        })
      : [];
  } catch (_error) {
    return [];
  }
}

function tableCell(value: unknown): string {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

const TIER_DEFINITIONS: Record<number, string> = {
  1: "Tier 1 (< 200 lines, no references/): Basic skills with minimal documentation",
  2: "Tier 2 (200-800 lines OR has references/): Standard skills with supporting docs",
  3: "Tier 3 (> 800 lines AND has references/): Complex skills with full documentation",
};

function normalizeLifecycleRedirect(entry: LifecycleEntry): JsonLifecycleRedirect {
  return {
    skill: String(entry.skill || ""),
    event: String(entry.event || ""),
    date: String(entry.date || ""),
    replacements: Array.isArray(entry.replacements) ? entry.replacements.map(String) : [],
    agentAction: String(entry.agent_action || ""),
  };
}

function buildJsonInventory(
  generatedAt: string,
  skills: SkillInventoryEntry[],
  skillsByTier: Map<number, SkillInventoryEntry[]>,
  lifecycleEntries: LifecycleEntry[]
): JsonSkillsInventory {
  const tiers: Record<string, JsonTierInventory> = {};
  for (const tier of [1, 2, 3]) {
    tiers[String(tier)] = {
      definition: TIER_DEFINITIONS[tier]!,
      skillNames: (skillsByTier.get(tier) || []).map((skill) => skill.name),
    };
  }

  const skillsByName: Record<string, SkillInventoryEntry> = {};
  for (const skill of skills) {
    skillsByName[skill.name] = skill;
  }

  return {
    schemaVersion: 1,
    generatedAt,
    source: {
      skillsDir: "skills",
      lifecycleFile: "skill-lifecycle.json",
      generator: GENERATOR_PATH,
    },
    totalSkills: skills.length,
    skills,
    skillsByName,
    tiers,
    lifecycleRedirects: lifecycleEntries.map(normalizeLifecycleRedirect),
    notes: [
      "Deprecated skills are excluded from this inventory.",
      "Removed, archived, merged, and renamed skill redirects are sourced from skill-lifecycle.json.",
      "SKILLS.json is the machine-readable inventory; SKILLS.md is kept for human browsing.",
      "Skills marked metadata.internal or metadata.experimental are excluded by default; regenerate with --include-internal/--include-experimental to include them.",
    ],
  };
}

async function generateInventory(
  options: { includeInternal?: boolean; includeExperimental?: boolean } = {}
): Promise<void> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const skills: SkillInventoryEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue; // Skip archived

    const skillPath = path.join(SKILLS_DIR, entry.name);
    const skillMdPath = path.join(skillPath, "SKILL.md");

    try {
      const content = await readFile(skillMdPath, "utf-8");
      const meta = parseFrontmatter(content);

      if (!meta || !meta.name) {
        console.warn(`⚠️  ${entry.name}: No valid frontmatter, skipping`);
        continue;
      }

      if (isCompatibilityArtifact(meta)) {
        console.log(`⏭️  ${entry.name}: deprecated, skipping`);
        continue;
      }

      if (isHiddenByMetadataFlags(meta, options)) {
        const flag = isTruthy(meta.metadata?.internal) ? "internal" : "experimental";
        console.log(
          `🙈  ${entry.name}: ${flag}, skipping (use --include-${flag} to include)`,
        );
        continue;
      }

      const lineCount = content.split("\n").length;
      const tier = calculateTier(skillPath, lineCount);

      skills.push({
        name: meta.name,
        description: meta.description || "",
        version: String(meta.metadata?.version || "unknown"),
        updatedAt: String(meta.metadata?.updated_at || "unknown"),
        targetProvider: String(meta.metadata?.target_provider || "unknown"),
        tier,
        lineCount,
        skillDir: `skills/${entry.name}`,
        skillFile: `skills/${entry.name}/SKILL.md`,
      });

      console.log(`✓ ${entry.name}: Tier ${tier} (${lineCount} lines)`);
    } catch (err) {
      console.warn(`⚠️  ${entry.name}: ${err}`);
    }
  }

  // Sort by tier then name
  skills.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.name.localeCompare(b.name);
  });

  // Generate markdown
  const timestamp = new Date().toISOString().slice(0, 10);
  const skillsByTier = new Map<number, SkillInventoryEntry[]>([
    [1, []],
    [2, []],
    [3, []],
  ]);

  for (const skill of skills) {
    skillsByTier.get(skill.tier)?.push(skill);
  }

  let md = `# Skills Inventory

Generated: ${timestamp}
Total Skills: ${skills.length}

`;

  for (const tier of [1, 2, 3]) {
    const tierSkills = skillsByTier.get(tier) || [];

    if (!tierSkills.length) continue;

    md += `## Tier ${tier}

`;

    for (const skill of tierSkills) {
      md += `* \`${skill.name}\` (version: ${skill.version}; provider: ${skill.targetProvider}; updated: ${skill.updatedAt})
`;

      for (const line of wrapText(skill.description, 76)) {
        md += `  ${line}
`;
      }

      md += `
`;
    }
  }

  md += `## Tier Definitions

`;

  const tierDefinitions = [
    `**${TIER_DEFINITIONS[1]!.replace(":", "**:")}`,
    `**${TIER_DEFINITIONS[2]!.replace(":", "**:")}`,
    `**${TIER_DEFINITIONS[3]!.replace(":", "**:")}`,
  ];

  for (const definition of tierDefinitions) {
    const lines = wrapText(definition, 76);
    md += `* ${lines[0]}
`;

    for (const line of lines.slice(1)) {
      md += `  ${line}
`;
    }

    md += `
`;
  }

  const lifecycleEntries = await loadLifecycleEntries();
  if (lifecycleEntries.length) {
    md += `## Lifecycle Redirects

Use this table when a requested skill is not present in the active catalog.

| Legacy Skill | Event | Date | Replacement | Agent Action |
|---|---|---|---|---|
`;

    for (const entry of lifecycleEntries) {
      const replacements = Array.isArray(entry.replacements) && entry.replacements.length
        ? entry.replacements.map((skill) => `\`${skill}\``).join(", ")
        : "none";
      md += `| \`${tableCell(entry.skill)}\` | ${tableCell(entry.event)} | ${tableCell(entry.date)} | ${replacements} | ${tableCell(entry.agent_action)} |
`;
    }

    md += `
`;
  }

  md += `## Notes

* Deprecated skills are excluded from this inventory
* Removed, archived, merged, and renamed skill redirects are sourced from \`skill-lifecycle.json\`
* \`SKILLS.json\` is the machine-readable inventory for agents and automation
* Generated by \`${GENERATOR_PATH}\`
`;

  const json = buildJsonInventory(timestamp, skills, skillsByTier, lifecycleEntries);
  await writeFile(OUTPUT_MARKDOWN_FILE, md);
  await writeFile(OUTPUT_JSON_FILE, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`\n✅ Generated ${OUTPUT_MARKDOWN_FILE} with ${skills.length} skills`);
  console.log(`✅ Generated ${OUTPUT_JSON_FILE} with ${skills.length} skills`);
}

async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  await generateInventory({ includeInternal: args.includeInternal, includeExperimental: args.includeExperimental });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export {
  calculateTier,
  generateInventory,
  buildJsonInventory,
  help,
  isCompatibilityArtifact,
  isHiddenByMetadataFlags,
  isTruthy,
  loadLifecycleEntries,
  main,
  normalizeValue,
  parseArgs,
  parseFrontmatter,
  tableCell,
  wrapText,
};
