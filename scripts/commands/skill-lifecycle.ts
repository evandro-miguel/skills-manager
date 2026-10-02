#!/usr/bin/env bun
/**
 * Maintains the skill lifecycle changelog for removed, archived, merged, and
 * renamed skills.
 */

import fs from "node:fs";
import path from "node:path";
import {
  isValidUtcIso,
  toUtcIso,
} from "../modules/skill-metadata-lib.ts";
import {
  LIFECYCLE_RESOLUTION_SCHEMA,
  LifecycleResolutionError,
  resolveLifecycle,
} from "../modules/skillpool/lifecycle-resolution.ts";

const DEFAULT_LIFECYCLE_FILE = "skill-lifecycle.json";
const ALLOWED_EVENTS = new Set([
  "archived",
  "removed",
  "merged",
  "renamed",
  "deprecated",
]);
const REPLACEMENT_REQUIRED_EVENTS = new Set(["merged", "renamed", "deprecated"]);
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type LifecycleCommand = "help" | "audit" | "lookup" | "resolve" | "record";
type LifecycleLevel = "ERROR" | "WARN";

type LifecycleResolution = ReturnType<typeof resolveLifecycle>;

interface LifecycleCLIOptions {
  command: LifecycleCommand;
  file: string;
  skillsRoot: string;
  json: boolean;
  write: boolean;
  references: string[];
  replacements: string[];
  help?: boolean;
  skill?: string;
  event?: string;
  date?: string;
  reason?: string;
  agentAction?: string;
  archivePath?: string;
}

interface LifecycleFinding {
  level: LifecycleLevel;
  code: string;
  message: string;
}

interface LifecycleEntry {
  skill: string;
  event: string;
  date: string;
  replacements: string[];
  reason: string;
  agent_action: string;
  archive_path?: string;
  references?: string[];
}

interface LifecycleFile {
  $schema?: string;
  version: number;
  updated_at: string;
  entries: LifecycleEntry[];
}

interface NormalizeEntryInput {
  skill?: unknown;
  event?: unknown;
  date?: unknown;
  replacements?: unknown;
  reason?: unknown;
  agent_action?: unknown;
  agentAction?: unknown;
  archive_path?: unknown;
  archivePath?: unknown;
  references?: unknown;
}

interface ValidateLifecycleOptions {
  skillsRoot?: string;
}

function help(): void {
  console.log(`
Skill lifecycle changelog tools

Usage:
  bun scripts/commands/skill-lifecycle.ts audit [options]
  bun scripts/commands/skill-lifecycle.ts lookup <skill> [options]
  bun scripts/commands/skill-lifecycle.ts resolve <skill> [options]
  bun scripts/commands/skill-lifecycle.ts record [options]

Commands:
  audit                         Validate skill-lifecycle.json
  lookup <skill>                Show redirects/actions for a missing skill
  resolve <skill>               Resolve a missing skill to one terminal target
  record                        Append a lifecycle event

Options:
  --file <path>                 Lifecycle file (default: ./skill-lifecycle.json)
  --skills-root <dir>           Active skills root (default: ./skills)
  --json                        Emit JSON where supported
  --write                       Persist record changes (default: dry-run)
  --skill <name>                Legacy skill name for record
  --event <event>               archived|removed|merged|renamed|deprecated
  --date <YYYY-MM-DD>           Event date (default: today UTC)
  --replacement <csv>           Replacement skill(s)
  --reason <text>               Why the lifecycle event happened
  --agent-action <text>         What agents should do when the skill is missing
  --reference <path>            Related repo-relative doc; can be repeated
  --archive-path <path>         Repo-relative archive path when applicable
  --help                        Show help
`);
}

function parseCsv(value: unknown): string[] {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): LifecycleCLIOptions {
  const command: LifecycleCommand = argv[2] && !argv[2].startsWith("--") ? (argv[2] as LifecycleCommand) : "help";
  const options: LifecycleCLIOptions = {
    command,
    file: path.resolve(process.cwd(), DEFAULT_LIFECYCLE_FILE),
    skillsRoot: path.resolve(process.cwd(), "skills"),
    json: false,
    write: false,
    references: [],
    replacements: [],
  };

  let startIndex = command === "help" ? 2 : 3;
  if ((command === "lookup" || command === "resolve") && argv[startIndex] !== undefined && !argv[startIndex]!.startsWith("--")) {
    options.skill = argv[startIndex]!;
    startIndex += 1;
  }

  for (let i = startIndex; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--write") {
      options.write = true;
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

    if (key === "file") {
      options.file = path.resolve(process.cwd(), value);
    } else if (key === "skills-root") {
      options.skillsRoot = path.resolve(process.cwd(), value);
    } else if (key === "skill") {
      options.skill = value;
    } else if (key === "event") {
      options.event = value;
    } else if (key === "date") {
      options.date = value;
    } else if (key === "replacement" || key === "replacements") {
      options.replacements.push(...parseCsv(value));
    } else if (key === "reason") {
      options.reason = value;
    } else if (key === "agent-action") {
      options.agentAction = value;
    } else if (key === "reference") {
      options.references.push(value);
    } else if (key === "archive-path") {
      options.archivePath = value;
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
    i += 1;
  }

  return options;
}

function readLifecycle(filePath: string): LifecycleFile {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Lifecycle file not found: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error: unknown) {
    throw new Error(
      `Invalid lifecycle JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function writeLifecycle(filePath: string, data: LifecycleFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function listActiveSkills(skillsRoot: string): string[] {
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry: { isDirectory(): boolean }) => entry.isDirectory())
    .map((entry: { name: string }) => entry.name)
    .filter((name: string) => !name.startsWith("."))
    .filter((name: string) => fs.existsSync(path.join(skillsRoot, name, "SKILL.md")))
    .sort((a: string, b: string) => a.localeCompare(b));
}

function isValidDateOnly(value: unknown): boolean {
  if (!DATE_ONLY_PATTERN.test(String(value || ""))) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeEntry(entry: NormalizeEntryInput): LifecycleEntry {
  const replacements = Array.isArray(entry.replacements)
    ? entry.replacements
    : parseCsv(entry.replacements);
  const next: LifecycleEntry = {
    skill: String(entry.skill || "").trim(),
    event: String(entry.event || "").trim(),
    date: String(entry.date || "").trim(),
    replacements: unique(replacements.map((item) => String(item).trim()).filter(Boolean)),
    reason: String(entry.reason || "").trim(),
    agent_action: String(entry.agent_action || entry.agentAction || "").trim(),
  };

  if (entry.archive_path || entry.archivePath) {
    next.archive_path = String(entry.archive_path || entry.archivePath).trim();
  }
  if (Array.isArray(entry.references) && entry.references.length) {
    next.references = unique(entry.references.map((item) => String(item).trim()).filter(Boolean));
  }
  return next;
}

function sortEntries(entries: LifecycleEntry[]): LifecycleEntry[] {
  return [...entries].sort((a, b) => {
    const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
    if (dateCompare !== 0) {
      return dateCompare;
    }
    return String(a.skill || "").localeCompare(String(b.skill || ""));
  });
}

function lifecycleEntriesBySkill(entries: readonly LifecycleEntry[]): Map<string, LifecycleEntry[]> {
  const entriesBySkill = new Map<string, LifecycleEntry[]>();
  for (const entry of entries) {
    const skillEntries = entriesBySkill.get(entry.skill) || [];
    skillEntries.push(entry);
    entriesBySkill.set(entry.skill, skillEntries);
  }
  return entriesBySkill;
}

function currentLifecycleEntries(
  entriesBySkill: ReadonlyMap<string, readonly LifecycleEntry[]>,
): Map<string, LifecycleEntry[]> {
  const current = new Map<string, LifecycleEntry[]>();
  for (const [skill, entries] of entriesBySkill.entries()) {
    if (!entries.length) {
      continue;
    }
    const latestDate = String(entries[0]!.date || "");
    current.set(skill, entries.filter((entry) => String(entry.date || "") === latestDate));
  }
  return current;
}

function validateLifecycle(data: unknown, options: ValidateLifecycleOptions = {}): LifecycleFinding[] {
  const findings: LifecycleFinding[] = [];
  const activeSkills = new Set(listActiveSkills(options.skillsRoot || path.resolve("skills")));

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [{
      level: "ERROR",
      code: "LIFECYCLE_INVALID",
      message: "lifecycle file must be a JSON object",
    }] as LifecycleFinding[];
  }

  const file = data as Partial<LifecycleFile>;

  if (file.version !== 1) {
    findings.push({
      level: "ERROR",
      code: "LIFECYCLE_VERSION_INVALID",
      message: "version must be 1",
    });
  }

  if (!file.updated_at || !isValidUtcIso(file.updated_at)) {
    findings.push({
      level: "ERROR",
      code: "LIFECYCLE_UPDATED_AT_INVALID",
      message: "updated_at must be a UTC ISO timestamp",
    });
  }

  if (!Array.isArray(file.entries)) {
    findings.push({
      level: "ERROR",
      code: "LIFECYCLE_ENTRIES_INVALID",
      message: "entries must be an array",
    });
    return findings;
  }

  const normalizedEntries = file.entries.map((rawEntry) =>
    normalizeEntry(rawEntry && typeof rawEntry === "object" ? rawEntry : {}),
  );
  const entriesBySkill = lifecycleEntriesBySkill(sortEntries(normalizedEntries));
  const currentEntriesBySkill = currentLifecycleEntries(entriesBySkill);
  const seen = new Set<string>();
  file.entries.forEach((_rawEntry: LifecycleEntry, index: number) => {
    const entry = normalizedEntries[index]!;
    const where = `entries[${index}]`;
    const dedupeKey = `${entry.skill}:${entry.event}:${entry.date}`;

    if (seen.has(dedupeKey)) {
      findings.push({
        level: "ERROR",
        code: "LIFECYCLE_DUPLICATE_ENTRY",
        message: `${where} duplicates ${dedupeKey}`,
      });
    }
    seen.add(dedupeKey);

    if (!SKILL_NAME_PATTERN.test(entry.skill)) {
      findings.push({
        level: "ERROR",
        code: "LIFECYCLE_SKILL_INVALID",
        message: `${where}.skill must be kebab-case skill name`,
      });
    }

    if (!ALLOWED_EVENTS.has(entry.event)) {
      findings.push({
        level: "ERROR",
        code: "LIFECYCLE_EVENT_INVALID",
        message: `${where}.event must be one of ${[...ALLOWED_EVENTS].join(", ")}`,
      });
    }

    if (!isValidDateOnly(entry.date)) {
      findings.push({
        level: "ERROR",
        code: "LIFECYCLE_DATE_INVALID",
        message: `${where}.date must be YYYY-MM-DD`,
      });
    }

    if (!entry.reason) {
      findings.push({
        level: "ERROR",
        code: "LIFECYCLE_REASON_MISSING",
        message: `${where}.reason is required`,
      });
    }

    if (!entry.agent_action) {
      findings.push({
        level: "ERROR",
        code: "LIFECYCLE_AGENT_ACTION_MISSING",
        message: `${where}.agent_action is required`,
      });
    }

    if (REPLACEMENT_REQUIRED_EVENTS.has(entry.event) && entry.replacements.length === 0) {
      findings.push({
        level: "ERROR",
        code: "LIFECYCLE_REPLACEMENT_REQUIRED",
        message: `${where}.${entry.event} requires at least one replacement`,
      });
    }

    for (const replacement of entry.replacements) {
      if (!SKILL_NAME_PATTERN.test(replacement)) {
        findings.push({
          level: "ERROR",
          code: "LIFECYCLE_REPLACEMENT_INVALID",
          message: `${where}.replacements contains invalid skill name: ${replacement}`,
        });
        continue;
      }
      if (replacement === entry.skill) {
        findings.push({
          level: "ERROR",
          code: "LIFECYCLE_REPLACEMENT_SELF",
          message: `${where}.replacements must not point back to ${entry.skill}`,
        });
      }
      const replacementEntries = currentEntriesBySkill.get(replacement) || [];
      if (!activeSkills.has(replacement) && !replacementEntries.length) {
        findings.push({
          level: "ERROR",
          code: "LIFECYCLE_REPLACEMENT_MISSING",
          message: `${where}.replacements references inactive skill: ${replacement}`,
        });
      }
      if (!activeSkills.has(replacement) && replacementEntries.length > 1) {
        findings.push({
          level: "ERROR",
          code: "LIFECYCLE_REPLACEMENT_AMBIGUOUS",
          message: `${where}.replacements references ambiguous lifecycle skill: ${replacement}`,
        });
      }
    }

    if (entry.archive_path && path.isAbsolute(entry.archive_path)) {
      findings.push({
        level: "ERROR",
        code: "LIFECYCLE_ARCHIVE_PATH_ABSOLUTE",
        message: `${where}.archive_path must be repo-relative`,
      });
    }

    for (const reference of entry.references || []) {
      if (!reference || path.isAbsolute(reference)) {
        findings.push({
          level: "ERROR",
          code: "LIFECYCLE_REFERENCE_INVALID",
          message: `${where}.references must be repo-relative strings`,
        });
      }
    }

    if (activeSkills.has(entry.skill) && entry.event !== "deprecated") {
      findings.push({
        level: "WARN",
        code: "LIFECYCLE_SKILL_STILL_ACTIVE",
        message: `${where}.skill is still active: ${entry.skill}`,
      });
    }
  });

  for (const [skill, currentEntries] of currentEntriesBySkill.entries()) {
    if (activeSkills.has(skill)) {
      continue;
    }
    if (currentEntries.length > 1) {
      findings.push({
        level: "ERROR",
        code: "LIFECYCLE_NODE_AMBIGUOUS",
        message: `lifecycle node '${skill}' has multiple current entries`,
      });
      continue;
    }
    if (currentEntries.length !== 1) {
      continue;
    }
    const entry = currentEntries[0]!;
    if (!SKILL_NAME_PATTERN.test(skill) || !ALLOWED_EVENTS.has(entry.event)) {
      continue;
    }
    if (!entry.replacements.length && REPLACEMENT_REQUIRED_EVENTS.has(entry.event)) {
      continue;
    }
    try {
      resolveLifecycle(entriesBySkill, skill, { activeSkills });
    } catch (error: unknown) {
      if (!(error instanceof LifecycleResolutionError)) {
        throw error;
      }
      if (
        error.code === "LIFECYCLE_REPLACEMENT_MISSING" ||
        error.code === "LIFECYCLE_REPLACEMENT_SELF"
      ) {
        continue;
      }
      if (
        !findings.some(
          (finding) => finding.code === error.code && finding.message.includes(`'${skill}'`),
        )
      ) {
        findings.push({
          level: "ERROR",
          code: error.code,
          message: error.message,
        });
      }
    }
  }

  return findings;
}

function formatEntry(entry: LifecycleEntry): string {
  const replacements = entry.replacements?.length
    ? entry.replacements.map((skill) => `\`${skill}\``).join(", ")
    : "no direct replacement";
  return [
    `${entry.skill}: ${entry.event} on ${entry.date}`,
    `- replacement: ${replacements}`,
    `- reason: ${entry.reason}`,
    `- agent action: ${entry.agent_action}`,
  ].join("\n");
}

function auditCommand(options: LifecycleCLIOptions): void {
  const data = readLifecycle(options.file);
  const findings = validateLifecycle(data, options);
  const errors = findings.filter((finding) => finding.level === "ERROR");
  const warnings = findings.filter((finding) => finding.level === "WARN");

  if (!findings.length) {
    console.log("STATUS: PASS");
    console.log("Errors: 0  Warnings: 0");
    return;
  }

  console.log(`STATUS: ${errors.length ? "BLOCKING" : "CONCERNS"}`);
  console.log(`Errors: ${errors.length}  Warnings: ${warnings.length}`);
  console.log("\nFINDINGS:");
  for (const finding of findings) {
    console.log(`- [${finding.level} ${finding.code}] ${finding.message}`);
  }
  if (errors.length) {
    process.exit(1);
  }
}

function lookupEntries(data: LifecycleFile, skill: string): LifecycleEntry[] {
  return sortEntries(data.entries || []).filter((entry) => entry.skill === skill);
}

function lookupCommand(options: LifecycleCLIOptions): void {
  if (!options.skill) {
    throw new Error("lookup requires <skill> or --skill <name>");
  }

  const data = readLifecycle(options.file);
  const entries = lookupEntries(data, options.skill);

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    if (!entries.length) {
      process.exit(1);
    }
    return;
  }

  if (!entries.length) {
    console.log(`No lifecycle entry found for '${options.skill}'.`);
    process.exit(1);
  }

  for (const entry of entries) {
    console.log(formatEntry(entry));
  }
}

function formatResolution(resolution: LifecycleResolution): string {
  return [
    `${resolution.skill}: ${resolution.terminal_event} at ${resolution.terminal}`,
    `- path: ${resolution.path.join(" -> ")}`,
  ].join("\n");
}

function resolveCommand(options: LifecycleCLIOptions): void {
  if (!options.skill) {
    throw new Error("resolve requires <skill> or --skill <name>");
  }

  const data = readLifecycle(options.file);
  const activeSkills = new Set(listActiveSkills(options.skillsRoot || path.resolve("skills")));
  const resolution = resolveLifecycle(data, options.skill, { activeSkills });
  if (options.json) {
    console.log(JSON.stringify(resolution, null, 2));
    return;
  }
  console.log(formatResolution(resolution));
}

function recordCommand(options: LifecycleCLIOptions): void {
  if (!options.skill) {
    throw new Error("record requires --skill <name>");
  }
  if (!options.event) {
    throw new Error("record requires --event <event>");
  }
  if (!options.reason) {
    throw new Error("record requires --reason <text>");
  }
  if (!options.agentAction) {
    throw new Error("record requires --agent-action <text>");
  }

  const data: LifecycleFile = fs.existsSync(options.file)
    ? readLifecycle(options.file)
    : {
        $schema: "schema/skill-lifecycle.schema.json",
        version: 1,
        updated_at: toUtcIso(new Date()) || "",
        entries: [] as LifecycleEntry[],
      };

  const nextEntry = normalizeEntry({
    skill: options.skill,
    event: options.event,
    date: options.date || todayUtc(),
    replacements: unique(options.replacements),
    reason: options.reason,
    agent_action: options.agentAction,
    references: options.references,
    archive_path: options.archivePath,
  });

  const next: LifecycleFile = {
    ...data,
    updated_at: toUtcIso(new Date()) || "",
    entries: sortEntries([...(data.entries || []), nextEntry]),
  };

  const findings = validateLifecycle(next, options);
  const errors = findings.filter((finding) => finding.level === "ERROR");
  if (errors.length) {
    for (const finding of findings) {
      console.error(`[${finding.level} ${finding.code}] ${finding.message}`);
    }
    process.exit(1);
  }

  if (options.write) {
    writeLifecycle(options.file, next);
    console.log(`recorded: ${nextEntry.skill} ${nextEntry.event}`);
    return;
  }

  console.log("dry-run: lifecycle entry not written");
  console.log(JSON.stringify(nextEntry, null, 2));
}

function main(): void {
  let options: LifecycleCLIOptions;
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

  try {
    if (options.command === "audit") {
      auditCommand(options);
      return;
    }
    if (options.command === "lookup") {
      lookupCommand(options);
      return;
    }
    if (options.command === "resolve") {
      resolveCommand(options);
      return;
    }
    if (options.command === "record") {
      recordCommand(options);
      return;
    }
    throw new Error(`Unknown command '${options.command}'`);
  } catch (error: unknown) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export {
  ALLOWED_EVENTS,
  LIFECYCLE_RESOLUTION_SCHEMA,
  LifecycleResolutionError,
  REPLACEMENT_REQUIRED_EVENTS,
  auditCommand,
  formatEntry,
  formatResolution,
  listActiveSkills,
  lookupCommand,
  lookupEntries,
  main,
  normalizeEntry,
  parseArgs,
  recordCommand,
  resolveCommand,
  resolveLifecycle,
  validateLifecycle,
};
