#!/usr/bin/env bun
// <!-- markdownlint-disable-file -->
/**
 * Deterministic skill card / catalog generator (PR09 safe slice).
 *
 * Reads `<source>/skills/<skill>/SKILL.md` frontmatter via the existing parser
 * and optional `<source>/skills/<skill>/skill.meta.json` risk metadata, then
 * renders deterministic `skill-cards.json` and/or `skill-cards.md` under
 * `--out-dir` only.
 *
 * Safety contract:
 * - Requires `--source <skillpack-root>` and `--out-dir <dir>` for write/check.
 * - Output is fully deterministic: no timestamps, no host absolute paths, no
 *   network. Re-running against the same source yields byte-identical output.
 * - Never writes root `SKILLS.*` files; it only writes into `--out-dir`.
 * - Skills with truthy `metadata.internal`/`metadata.experimental` are hidden by
 *   default (same truthy rule as list/inventory); reveal with the include flags.
 * - Deprecated/archived/compatibility-only skills are excluded (existing rule).
 */

import fs from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isCompatibilityArtifact,
  isHiddenByMetadataFlags,
  parseFrontmatter,
} from "./generate-skills-inventory.ts";

const GENERATOR_PATH = "scripts/commands/generate-skill-catalog.ts";
const JSON_FILE = "skill-cards.json";
const MARKDOWN_FILE = "skill-cards.md";

export type CatalogFormat = "markdown" | "json" | "both";

export interface CatalogArgs {
  source: string;
  outDir: string;
  format: CatalogFormat;
  check: boolean;
  includeInternal: boolean;
  includeExperimental: boolean;
  help: boolean;
}

type ParsedFrontmatter = NonNullable<ReturnType<typeof parseFrontmatter>>;

export interface ProviderSupport {
  targetProvider: string;
  compatible: string[];
}

export interface SkillCard {
  name: string;
  description: string;
  useWhen: string;
  category: string;
  tags: string[];
  triggers: string[];
  targetProvider: string;
  providerSupport: ProviderSupport;
  risk: Record<string, boolean>;
  examples: string[];
  sourcePath: string;
}

export interface SkillCardsCatalog {
  schemaVersion: 1;
  source: {
    generator: typeof GENERATOR_PATH;
    skillsRoot: string;
  };
  totalCards: number;
  cards: SkillCard[];
  notes: string[];
}

export function help(): void {
  console.log(`
Generate deterministic skill cards / catalog from a skillpack source

Usage:
  bun scripts/commands/generate-skill-catalog.ts --source <skillpack-root> --out-dir <dir> [options]

Required:
  --source <dir>       Skillpack source root containing skills/*/SKILL.md
  --out-dir <dir>      Output directory for generated catalog files

Options:
  --format <f>         markdown | json | both (default: both)
  --check              Verify generated output is in sync; exit 1 if not
  --include-internal   Include skills with metadata.internal set (hidden by default)
  --include-experimental Include skills with metadata.experimental set (hidden by default)
  --help               Show this help

Outputs (written under --out-dir only):
  skill-cards.json     Machine-readable catalog
  skill-cards.md       Human-readable catalog

The output is deterministic: no timestamps, host paths, or network results.
This command never writes root SKILLS.* files.
`);
}

export function parseArgs(argv: string[] = process.argv): CatalogArgs {
  const args: CatalogArgs = {
    source: "",
    outDir: "",
    format: "both",
    check: false,
    includeInternal: false,
    includeExperimental: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--check") {
      args.check = true;
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
    if (token === "--source") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --source");
      args.source = value;
      i += 1;
      continue;
    }
    if (token === "--out-dir") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --out-dir");
      args.outDir = value;
      i += 1;
      continue;
    }
    if (token === "--format") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --format");
      if (value !== "markdown" && value !== "json" && value !== "both") {
        throw new Error(`Invalid --format '${value}'. Expected markdown, json, or both.`);
      }
      args.format = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  return args;
}

function parseCsvList(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Build a single skill card from parsed frontmatter plus optional risk metadata.
 *
 * `useWhen` derives from `metadata.useWhen`, falling back to the description.
 * `providerSupport.compatible` derives from the `metadata.compatible_providers`
 * CSV. `risk` is the `risk` object from `skill.meta.json` when present, otherwise
 * an empty object (treated conservatively as unknown, not as safe).
 */
export function buildCard(
  meta: ParsedFrontmatter,
  skillFolder: string,
  risk: Record<string, boolean>,
): SkillCard {
  const tags = parseCsvList(meta.metadata?.tags);
  const triggers = parseCsvList(meta.metadata?.triggers);
  const category = String(meta.category || meta.metadata?.category || "");
  const targetProvider = String(meta.metadata?.target_provider || "");
  const compatible = parseCsvList(meta.metadata?.compatible_providers);
  const useWhen = String(meta.metadata?.useWhen || meta.description || "");

  return {
    name: meta.name!,
    description: String(meta.description || ""),
    useWhen,
    category,
    tags,
    triggers,
    targetProvider,
    providerSupport: {
      targetProvider,
      compatible,
    },
    risk,
    examples: [],
    sourcePath: `skills/${skillFolder}/SKILL.md`,
  };
}

async function loadRisk(skillDir: string): Promise<Record<string, boolean>> {
  try {
    const raw = await readFile(path.join(skillDir, "skill.meta.json"), "utf-8");
    const parsed = JSON.parse(raw) as { risk?: Record<string, boolean> };
    if (parsed.risk && typeof parsed.risk === "object") {
      return parsed.risk;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Collect skill cards from each `<source>/skills/<skill>/SKILL.md`.
 *
 * Excludes deprecated/archived/compatibility-only skills and, by default, skills
 * hidden by `metadata.internal`/`metadata.experimental`. Returns cards sorted by
 * name for deterministic output regardless of filesystem ordering.
 */
export async function collectCards(
  source: string,
  options: { includeInternal?: boolean; includeExperimental?: boolean } = {},
): Promise<SkillCard[]> {
  const skillsDir = path.join(source, "skills");
  if (!fs.existsSync(skillsDir)) {
    throw new Error(`Source skills directory not found: ${path.join(source, "skills")}`);
  }

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const cards: SkillCard[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue; // Skip archived

    const skillDir = path.join(skillsDir, entry.name);
    const skillMdPath = path.join(skillDir, "SKILL.md");

    let content: string;
    try {
      content = await readFile(skillMdPath, "utf-8");
    } catch {
      continue;
    }

    const meta = parseFrontmatter(content);
    if (!meta || !meta.name) continue;
    if (isCompatibilityArtifact(meta)) continue;
    if (isHiddenByMetadataFlags(meta, options)) continue;

    const risk = await loadRisk(skillDir);
    cards.push(buildCard(meta, entry.name, risk));
  }

  cards.sort((a, b) => a.name.localeCompare(b.name));
  return cards;
}

export function buildCatalog(cards: SkillCard[]): SkillCardsCatalog {
  return {
    schemaVersion: 1,
    source: {
      generator: GENERATOR_PATH,
      skillsRoot: "skills",
    },
    totalCards: cards.length,
    cards,
    notes: [
      "Skill cards are generated from skills/*/SKILL.md frontmatter and optional skill.meta.json risk metadata.",
      "Skills marked metadata.internal or metadata.experimental are excluded by default; regenerate with --include-internal/--include-experimental to include them.",
      "Deprecated, archived, and compatibility-only skills are excluded.",
      "Output is deterministic: no generated time values, host paths, or network results.",
    ],
  };
}

export function renderCatalogJson(cards: SkillCard[]): string {
  return `${JSON.stringify(buildCatalog(cards), null, 2)}\n`;
}

export function renderCatalogMarkdown(cards: SkillCard[]): string {
  const lines: string[] = [];
  lines.push("# Skill Catalog");
  lines.push("");
  lines.push("<!-- Generated by scripts/commands/generate-skill-catalog.ts. Do not edit by hand. -->");
  lines.push("");
  lines.push(`Total Skills: ${cards.length}`);
  lines.push("");

  for (const card of cards) {
    lines.push(`## ${card.name}`);
    lines.push("");
    lines.push(`- **Use when:** ${card.useWhen}`);
    if (card.category) {
      lines.push(`- **Category:** ${card.category}`);
    }
    if (card.tags.length) {
      lines.push(`- **Tags:** ${card.tags.join(", ")}`);
    }
    if (card.triggers.length) {
      lines.push(`- **Triggers:** ${card.triggers.join(", ")}`);
    }
    lines.push(`- **Target provider:** ${card.targetProvider}`);
    if (card.providerSupport.compatible.length) {
      lines.push(`- **Compatible providers:** ${card.providerSupport.compatible.join(", ")}`);
    }
    lines.push(`- **Path:** ${card.sourcePath}`);
    lines.push("");
  }

  lines.push("## Notes");
  lines.push("");
  for (const note of buildCatalog(cards).notes) {
    lines.push(`- ${note}`);
  }
  lines.push("");

  return lines.join("\n");
}

function wantsJson(format: CatalogFormat): boolean {
  return format === "json" || format === "both";
}

function wantsMarkdown(format: CatalogFormat): boolean {
  return format === "markdown" || format === "both";
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  if (!args.source) {
    throw new Error("Missing required option: --source <skillpack-root>");
  }
  if (!args.outDir) {
    throw new Error("Missing required option: --out-dir <dir>");
  }

  const cards = await collectCards(args.source, {
    includeInternal: args.includeInternal,
    includeExperimental: args.includeExperimental,
  });

  if (args.check) {
    let mismatch = false;
    if (wantsJson(args.format)) {
      const actual = await readIfExists(path.join(args.outDir, JSON_FILE));
      if (actual !== renderCatalogJson(cards)) mismatch = true;
    }
    if (wantsMarkdown(args.format)) {
      const actual = await readIfExists(path.join(args.outDir, MARKDOWN_FILE));
      if (actual !== renderCatalogMarkdown(cards)) mismatch = true;
    }
    if (mismatch) {
      throw new Error("skill catalog out of sync. Regenerate with scripts/commands/generate-skill-catalog.ts");
    }
    console.log("STATUS: PASS");
    console.log(`Skill catalog is in sync (${cards.length} cards).`);
    return;
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  if (wantsJson(args.format)) {
    await writeFile(path.join(args.outDir, JSON_FILE), renderCatalogJson(cards));
  }
  if (wantsMarkdown(args.format)) {
    await writeFile(path.join(args.outDir, MARKDOWN_FILE), renderCatalogMarkdown(cards));
  }
  console.log("STATUS: PASS");
  console.log(`Wrote ${cards.length} skill cards to ${args.outDir}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
