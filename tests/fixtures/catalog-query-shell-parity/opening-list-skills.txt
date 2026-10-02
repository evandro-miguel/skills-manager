#!/usr/bin/env bun
/**
 * List skills by stack, category, tag, query, or profile.
 */

import fs from "node:fs";
import path from "node:path";
import { listSkillDirs, parseCsv, parseFrontmatter } from "../modules/skill-metadata-lib.ts";

interface ListSkillsOptions {
  skillsRoot: string;
  profilesRoot: string;
  categories: string[];
  tags: string[];
  queries: string[];
  profiles: string[];
  json: boolean;
  namesOnly: boolean;
  includeInternal: boolean;
  includeExperimental: boolean;
  help?: boolean;
}

interface SkillRecord {
  name: string;
  description: string;
  category: string;
  tags: string[];
  triggers: string[];
  version: string;
  updated_at: string;
  target_provider: string;
  path: string;
  profiles: string[];
  profile_metadata: ProfileSummary[];
  internal: boolean;
  experimental: boolean;
}

interface ProfileRecord {
  name: string;
  description?: string;
  curation?: string;
  scope?: string;
  skills: string[];
}

type ProfileSummary = Omit<ProfileRecord, "skills">;

function renderScriptPath(argv: string[], fallback: string): string {
  const raw = argv[1];
  if (!raw) {
    return fallback;
  }
  const normalized = String(raw).replaceAll("\\", "/");
  const marker = "/scripts/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex !== -1) {
    return normalized.slice(markerIndex + 1);
  }
  return path.basename(normalized);
}

function help(scriptPath: string): void {
  console.log(`
List skills by stack, category, tag, query, or profile

Usage:
  bun ${scriptPath} [options]

Options:
  --stack <term>              Broad stack term, e.g. react, frontend, backend
  --query <term>              Broad text query across name, description, and metadata
  --category <name>           Match metadata.category exactly
  --tag <term>                Match metadata.tags or metadata.triggers token
  --profile <name>            Restrict to profiles/<name>.json
  --skills-root <dir>         Skills root directory (default: ./skills)
  --profiles-root <dir>       Profiles root directory (default: ./profiles)
  --include-internal          Include skills with metadata.internal set (hidden by default)
  --include-experimental      Include skills with metadata.experimental set (hidden by default)
  --json                      Emit JSON
  --names-only                Emit only skill names, one per line
  --help                      Show help

Examples:
  bun ${scriptPath} --stack frontend
  bun ${scriptPath} --tag react --names-only
  bun ${scriptPath} --profile frontend --json
`);
}

function addCsv(target: string[], value: string): void {
  target.push(...parseCsv(value));
}

function parseArgs(argv: string[]): ListSkillsOptions {
  const options: ListSkillsOptions = {
    skillsRoot: path.resolve(process.cwd(), "skills"),
    profilesRoot: path.resolve(process.cwd(), "profiles"),
    categories: [],
    tags: [],
    queries: [],
    profiles: [],
    json: false,
    namesOnly: false,
    includeInternal: false,
    includeExperimental: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--names-only") {
      options.namesOnly = true;
      continue;
    }
    if (token === "--include-internal") {
      options.includeInternal = true;
      continue;
    }
    if (token === "--include-experimental") {
      options.includeExperimental = true;
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
    } else if (key === "profiles-root") {
      options.profilesRoot = path.resolve(process.cwd(), value);
    } else if (key === "stack" || key === "query") {
      addCsv(options.queries, value);
    } else if (key === "category") {
      addCsv(options.categories, value);
    } else if (key === "tag") {
      addCsv(options.tags, value);
    } else if (key === "profile") {
      addCsv(options.profiles, value);
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
    i += 1;
  }

  return options;
}

function lc(value: unknown): string {
  return String(value || "").toLowerCase();
}

function splitTokens(value: string): string[] {
  return parseCsv(value)
    .flatMap((item) => String(item).split(/\s+/))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function assertSafeName(value: string, label: string): string {
  const trimmed = String(value).trim();
  if (!trimmed) {
    throw new Error(`Invalid ${label}: expected a non-empty string`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    throw new Error(`Invalid ${label} '${trimmed}': path separators are not allowed`);
  }
  return trimmed;
}

function readProfile(profilesRoot: string, profileName: string): ProfileRecord {
  const safeProfileName = assertSafeName(profileName, "profile");
  const profilePath = path.join(profilesRoot, `${safeProfileName}.json`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Profile not found: ${profilePath}`);
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  if (!Array.isArray(profile.skills)) {
    throw new Error(`Profile has no skills array: ${profilePath}`);
  }
  const record: ProfileRecord = {
    name: String(profile.name || safeProfileName),
    skills: profile.skills.map(String),
  };
  if (profile.description) {
    record.description = String(profile.description);
  }
  if (profile.curation) {
    record.curation = String(profile.curation);
  }
  if (profile.scope) {
    record.scope = String(profile.scope);
  }
  return record;
}

function collectSelectedProfiles(options: ListSkillsOptions): ProfileRecord[] {
  return options.profiles.map((profile) => readProfile(options.profilesRoot, profile));
}

function collectProfileSkillNames(selectedProfiles: ProfileRecord[]): Set<string> | null {
  if (!selectedProfiles.length) {
    return null;
  }
  const selected = new Set<string>();
  for (const profile of selectedProfiles) {
    for (const skill of profile.skills) {
      selected.add(skill);
    }
  }
  return selected;
}

function buildProfileLookup(selectedProfiles: ProfileRecord[]): Map<string, ProfileSummary[]> {
  const lookup = new Map<string, ProfileSummary[]>();
  for (const profile of selectedProfiles) {
    const summary: ProfileSummary = { name: profile.name };
    if (profile.description) {
      summary.description = profile.description;
    }
    if (profile.curation) {
      summary.curation = profile.curation;
    }
    if (profile.scope) {
      summary.scope = profile.scope;
    }
    for (const skillName of profile.skills) {
      const entries = lookup.get(skillName) || [];
      entries.push(summary);
      lookup.set(skillName, entries);
    }
  }
  return lookup;
}

function annotateSkillProfiles(skill: SkillRecord, lookup: Map<string, ProfileSummary[]>): SkillRecord {
  const metadata = lookup.get(skill.name) || [];
  return {
    ...skill,
    profiles: metadata.map((profile) => profile.name),
    profile_metadata: metadata,
  };
}

function collectProfileMetadata(options: ListSkillsOptions): {
  selectedProfiles: ProfileRecord[];
  profileSkillNames: Set<string> | null;
  profileLookup: Map<string, ProfileSummary[]>;
} {
  if (!options.profiles.length) {
    return {
      selectedProfiles: [],
      profileSkillNames: null,
      profileLookup: new Map<string, ProfileSummary[]>(),
    };
  }
  const selectedProfiles = collectSelectedProfiles(options);
  return {
    selectedProfiles,
    profileSkillNames: collectProfileSkillNames(selectedProfiles),
    profileLookup: buildProfileLookup(selectedProfiles),
  };
}

function isMetadataTruthy(metadata: Record<string, string>, key: string): boolean {
  const value = metadata[key];
  if (value === undefined) {
    return false;
  }
  return ["true", "1", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function readSkill(skillDir: string): SkillRecord | null {
  const skillFile = path.join(skillDir, "SKILL.md");
  const parsed = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
  if (!parsed.ok) {
    return null;
  }

  const name = parsed.top.name || path.basename(skillDir);
  const description = parsed.top.description || "";
  const metadata = parsed.metadata || {};
  const tags = parseCsv(metadata.tags);
  const triggers = parseCsv(metadata.triggers);

  return {
    name,
    description,
    category: metadata.category || "",
    tags,
    triggers,
    version: metadata.version || "",
    updated_at: metadata.updated_at || "",
    target_provider: metadata.target_provider || "",
    path: path.relative(process.cwd(), skillDir) || skillDir,
    profiles: [],
    profile_metadata: [],
    internal: isMetadataTruthy(metadata, "internal"),
    experimental: isMetadataTruthy(metadata, "experimental"),
  };
}

function isHiddenByFlags(skill: SkillRecord, options: ListSkillsOptions): boolean {
  if (!options.includeInternal && skill.internal) {
    return true;
  }
  if (!options.includeExperimental && skill.experimental) {
    return true;
  }
  return false;
}

function skillMatches(
  skill: SkillRecord,
  options: ListSkillsOptions,
  profileSkillNames: Set<string> | null
): boolean {
  if (profileSkillNames && !profileSkillNames.has(skill.name)) {
    return false;
  }

  if (options.categories.length) {
    const category = lc(skill.category);
    if (!options.categories.some((item) => lc(item) === category)) {
      return false;
    }
  }

  if (options.tags.length) {
    const tokens = new Set([
      ...splitTokens(skill.tags.join(",")),
      ...splitTokens(skill.triggers.join(",")),
    ]);
    if (!options.tags.some((tag) => tokens.has(lc(tag)))) {
      return false;
    }
  }

  if (options.queries.length) {
    const haystack = lc(
      [skill.name, skill.description, skill.category, skill.tags.join(" "), skill.triggers.join(" ")].join(" ")
    );
    if (!options.queries.some((query) => haystack.includes(lc(query)))) {
      return false;
    }
  }

  return true;
}

function listSkills(options: ListSkillsOptions): SkillRecord[] {
  const { profileSkillNames, profileLookup } = collectProfileMetadata(options);
  return listSkillDirs(options.skillsRoot)
    .map(readSkill)
    .filter((skill): skill is SkillRecord => Boolean(skill))
    .filter((skill) => !isHiddenByFlags(skill, options))
    .filter((skill) => skillMatches(skill, options, profileSkillNames))
    .map((skill) => annotateSkillProfiles(skill, profileLookup))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatSkill(skill: SkillRecord): string {
  const parts = [`- ${skill.name}`];
  if (skill.internal) {
    parts.push("[internal]");
  }
  if (skill.experimental) {
    parts.push("[experimental]");
  }
  if (skill.category) {
    parts.push(`[${skill.category}]`);
  }
  if (skill.tags.length) {
    parts.push(`tags: ${skill.tags.join(", ")}`);
  }
  if (skill.description) {
    parts.push(`- ${skill.description}`);
  }
  if (skill.profiles.length) {
    parts.push(`profiles: ${skill.profiles.join(", ")}`);
  }
  return parts.join(" ");
}

function main(argv: string[] = process.argv): void {
  const options = parseArgs(argv);
  const scriptPath = renderScriptPath(argv, "scripts/commands/list-skills.ts");
  if (options.help) {
    help(scriptPath);
    return;
  }

  const skills = listSkills(options);
  if (options.json) {
    console.log(JSON.stringify(skills, null, 2));
    return;
  }

  if (options.namesOnly) {
    console.log(skills.map((skill) => skill.name).join("\n"));
    return;
  }

  if (!skills.length) {
    console.log("No skills matched.");
    return;
  }

  for (const skill of skills) {
    console.log(formatSkill(skill));
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
  collectProfileSkillNames,
  collectProfileMetadata,
  collectSelectedProfiles,
  formatSkill,
  listSkills,
  main,
  parseArgs,
  readProfile,
  readSkill,
  skillMatches,
  splitTokens,
};
