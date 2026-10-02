import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectProfileMetadata,
  collectProfileSkillNames,
  formatSkill,
  listSkills,
  main as listSkillsMain,
  parseArgs as parseListArgs,
  readProfile,
  readSkill,
  skillMatches,
  splitTokens,
} from "../scripts/commands/list-skills.ts";
import {
  ALLOWED_EVENTS,
  REPLACEMENT_REQUIRED_EVENTS,
  auditCommand,
  formatEntry,
  listActiveSkills,
  lookupCommand,
  lookupEntries,
  main as lifecycleMain,
  normalizeEntry,
  parseArgs as parseLifecycleArgs,
  recordCommand,
  resolveCommand,
  validateLifecycle,
} from "../scripts/commands/skill-lifecycle.ts";
import { formatLifecycleAdvice } from "../scripts/modules/skillpool/install.ts";
import { resolveLifecycle } from "../scripts/modules/skillpool/lifecycle-resolution.ts";

const tempDirs: string[] = [];
const repoRoot = path.resolve(__dirname, "..");

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(root);
  return root;
}

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeJson(filePath: string, data: unknown): void {
  writeText(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeSkill(
  skillsRoot: string,
  directory: string,
  {
    name = directory,
    description = `Use when ${name} is needed.`,
    metadata = "",
  }: { name?: string; description?: string; metadata?: string } = {},
): string {
  const skillDir = path.join(skillsRoot, directory);
  writeText(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
metadata:
  category: testing
  tags: "bun, cli"
  triggers: "wrapper command"
  version: 1.2.3
  updated_at: 2026-07-26T00:00:00Z
  target_provider: universal
${metadata}---
# ${name}
`,
  );
  return skillDir;
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

function capture(run: () => void): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let code = 0;

  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  process.exit = ((exitCode?: string | number | null) => {
    code = Number(exitCode ?? 0);
    throw new Error(`process.exit:${code}`);
  }) as typeof process.exit;

  try {
    run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("process.exit:")) {
      throw error;
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return {
    code,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}

function captureLifecycleMain(argv: string[]): Captured {
  const originalArgv = process.argv;
  process.argv = argv;
  try {
    return capture(() => lifecycleMain());
  } finally {
    process.argv = originalArgv;
  }
}

function validLifecycle(entries: unknown[] = []): Record<string, unknown> {
  return {
    $schema: "schema/skill-lifecycle.schema.json",
    version: 1,
    updated_at: "2026-07-26T00:00:00Z",
    entries,
  };
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makePackageTempRoot(): string {
  const scratchRoot = path.join(repoRoot, ".tmp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, "f15-cli-package-"));
  tempDirs.push(root);
  return root;
}

function runNpm(args: string[], cwd: string, cacheDir: string): string {
  return execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      npm_config_cache: cacheDir,
      npm_config_logs_dir: path.join(cacheDir, "_logs"),
    },
    maxBuffer: 2 * 1024 * 1024,
  });
}

describe("F-15 list-skills CLI wrapper characterization", () => {
  test("parses every supported option and rejects malformed CLI input", () => {
    const parsed = parseListArgs([
      "bun",
      "scripts/commands/list-skills.ts",
      "--skills-root",
      "fixture-skills",
      "--profiles-root",
      "fixture-profiles",
      "--stack",
      "frontend, backend",
      "--query",
      "agent",
      "--category",
      "testing, docs",
      "--tag",
      "bun, cli",
      "--profile",
      "core, docs",
      "--json",
      "--names-only",
      "--include-internal",
      "--include-experimental",
      "-h",
    ]);

    expect(parsed).toMatchObject({
      skillsRoot: path.resolve("fixture-skills"),
      profilesRoot: path.resolve("fixture-profiles"),
      queries: ["frontend", "backend", "agent"],
      categories: ["testing", "docs"],
      tags: ["bun", "cli"],
      profiles: ["core", "docs"],
      json: true,
      namesOnly: true,
      includeInternal: true,
      includeExperimental: true,
      help: true,
    });
    expect(() => parseListArgs(["bun", "list-skills.ts", "stray"])).toThrow("Unknown argument: stray");
    expect(() => parseListArgs(["bun", "list-skills.ts", "--tag"])).toThrow("Missing value for --tag");
    expect(() => parseListArgs(["bun", "list-skills.ts", "--tag", "--json"])).toThrow(
      "Missing value for --tag",
    );
    expect(() => parseListArgs(["bun", "list-skills.ts", "--unknown", "value"])).toThrow(
      "Unknown option: --unknown",
    );
  });

  test("reads profiles safely and builds selected profile metadata", () => {
    const root = makeTempRoot("f15-list-profiles");
    const profilesRoot = path.join(root, "profiles");
    writeJson(path.join(profilesRoot, "core.json"), {
      name: "Core curated",
      description: "Core profile",
      curation: "maintained",
      scope: "public",
      skills: ["alpha", "shared"],
    });
    writeJson(path.join(profilesRoot, "docs.json"), {
      skills: ["shared", "writer"],
    });

    expect(readProfile(profilesRoot, "core")).toEqual({
      name: "Core curated",
      description: "Core profile",
      curation: "maintained",
      scope: "public",
      skills: ["alpha", "shared"],
    });
    expect(readProfile(profilesRoot, "docs").name).toBe("docs");
    expect(collectProfileSkillNames([])).toBeNull();
    expect(collectProfileSkillNames([readProfile(profilesRoot, "core")])).toEqual(
      new Set(["alpha", "shared"]),
    );

    const metadata = collectProfileMetadata({
      ...parseListArgs(["bun", "list-skills.ts"]),
      profilesRoot,
      profiles: ["core", "docs"],
    });
    expect(metadata.selectedProfiles).toHaveLength(2);
    expect(metadata.profileSkillNames).toEqual(new Set(["alpha", "shared", "writer"]));
    expect(metadata.profileLookup.get("shared")).toEqual([
      {
        name: "Core curated",
        description: "Core profile",
        curation: "maintained",
        scope: "public",
      },
      { name: "docs" },
    ]);
    expect(collectProfileMetadata(parseListArgs(["bun", "list-skills.ts"]))).toMatchObject({
      selectedProfiles: [],
      profileSkillNames: null,
    });

    expect(() => readProfile(profilesRoot, "")).toThrow("expected a non-empty string");
    for (const unsafe of [".", "..", "../core", "nested/core", String.raw`nested\core`]) {
      expect(() => readProfile(profilesRoot, unsafe)).toThrow("path separators are not allowed");
    }
    expect(() => readProfile(profilesRoot, "missing")).toThrow("Profile not found");
    writeJson(path.join(profilesRoot, "invalid.json"), { name: "invalid" });
    expect(() => readProfile(profilesRoot, "invalid")).toThrow("Profile has no skills array");
  });

  test("reads skill metadata, ignores invalid frontmatter, and applies all match filters", () => {
    const root = makeTempRoot("f15-list-read");
    const skillsRoot = path.join(root, "skills");
    const alphaDir = writeSkill(skillsRoot, "alpha", {
      metadata: "  internal: yes\n  experimental: on\n",
    });
    const fallbackDir = path.join(skillsRoot, "fallback");
    writeText(
      path.join(fallbackDir, "SKILL.md"),
      `---
description: Minimal.
metadata:
---
# Fallback
`,
    );
    const invalidDir = path.join(skillsRoot, "invalid");
    writeText(path.join(invalidDir, "SKILL.md"), "# no frontmatter\n");

    const alpha = readSkill(alphaDir);
    expect(alpha).toMatchObject({
      name: "alpha",
      description: "Use when alpha is needed.",
      category: "testing",
      tags: ["bun", "cli"],
      triggers: ["wrapper command"],
      version: "1.2.3",
      updated_at: "2026-07-26T00:00:00Z",
      target_provider: "universal",
      internal: true,
      experimental: true,
    });
    expect(readSkill(fallbackDir)).toMatchObject({
      name: "fallback",
      category: "",
      tags: [],
      triggers: [],
      internal: false,
      experimental: false,
    });
    expect(readSkill(invalidDir)).toBeNull();
    expect(splitTokens(" Bun CLI, wrapper   command ,, ")).toEqual(["bun", "cli", "wrapper", "command"]);

    const base = {
      ...parseListArgs(["bun", "list-skills.ts"]),
      includeInternal: true,
      includeExperimental: true,
    };
    expect(skillMatches(alpha!, base, null)).toBe(true);
    expect(skillMatches(alpha!, { ...base, categories: ["TESTING"] }, null)).toBe(true);
    expect(skillMatches(alpha!, { ...base, categories: ["docs"] }, null)).toBe(false);
    expect(skillMatches(alpha!, { ...base, tags: ["COMMAND"] }, null)).toBe(true);
    expect(skillMatches(alpha!, { ...base, tags: ["missing"] }, null)).toBe(false);
    expect(skillMatches(alpha!, { ...base, queries: ["WRAPPER"] }, null)).toBe(true);
    expect(skillMatches(alpha!, { ...base, queries: ["missing"] }, null)).toBe(false);
    expect(skillMatches(alpha!, base, new Set(["alpha"]))).toBe(true);
    expect(skillMatches(alpha!, base, new Set(["other"]))).toBe(false);
  });

  test("lists, filters, annotates, sorts, and formats fixture skills", () => {
    const root = makeTempRoot("f15-list-skills");
    const skillsRoot = path.join(root, "skills");
    const profilesRoot = path.join(root, "profiles");
    writeSkill(skillsRoot, "zulu", {
      metadata: "  internal: true\n",
    });
    writeSkill(skillsRoot, "alpha");
    writeSkill(skillsRoot, "experiment", {
      metadata: "  experimental: 1\n",
    });
    writeText(path.join(skillsRoot, "broken", "SKILL.md"), "# broken\n");
    writeJson(path.join(profilesRoot, "core.json"), {
      name: "Core",
      description: "Core choices",
      skills: ["zulu", "alpha"],
    });

    const defaults = {
      ...parseListArgs(["bun", "list-skills.ts"]),
      skillsRoot,
      profilesRoot,
    };
    expect(listSkills(defaults).map((skill) => skill.name)).toEqual(["alpha"]);
    expect(
      listSkills({
        ...defaults,
        includeInternal: true,
        includeExperimental: true,
      }).map((skill) => skill.name),
    ).toEqual(["alpha", "experiment", "zulu"]);
    const profiled = listSkills({
      ...defaults,
      profiles: ["core"],
      includeInternal: true,
    });
    expect(profiled.map((skill) => skill.name)).toEqual(["alpha", "zulu"]);
    expect(profiled[0]?.profiles).toEqual(["Core"]);
    expect(profiled[0]?.profile_metadata).toEqual([
      { name: "Core", description: "Core choices" },
    ]);
    expect(
      listSkills({
        ...defaults,
        categories: ["docs"],
      }),
    ).toEqual([]);

    expect(
      formatSkill({
        ...profiled[1]!,
        internal: true,
        experimental: true,
      }),
    ).toBe(
      "- zulu [internal] [experimental] [testing] tags: bun, cli - Use when zulu is needed. profiles: Core",
    );
    expect(
      formatSkill({
        ...profiled[0]!,
        description: "",
        category: "",
        tags: [],
        profiles: [],
      }),
    ).toBe("- alpha");
  });

  test("main renders help, JSON, names-only, empty, and detailed output modes", () => {
    const root = makeTempRoot("f15-list-main");
    const skillsRoot = path.join(root, "skills");
    const profilesRoot = path.join(root, "profiles");
    writeSkill(skillsRoot, "alpha");

    const helpWithMarker = capture(() =>
      listSkillsMain(["bun", String.raw`C:\repo\scripts\commands\list-skills.ts`, "--help"]),
    );
    expect(helpWithMarker.stdout).toContain("bun scripts/commands/list-skills.ts [options]");
    const helpWithBasename = capture(() => listSkillsMain(["bun", "/tmp/custom-list.ts", "-h"]));
    expect(helpWithBasename.stdout).toContain("bun custom-list.ts [options]");
    const helpWithFallback = capture(() => listSkillsMain(["bun", "", "--help"]));
    expect(helpWithFallback.stdout).toContain("bun scripts/commands/list-skills.ts [options]");

    const common = [
      "--skills-root",
      skillsRoot,
      "--profiles-root",
      profilesRoot,
    ];
    const json = capture(() => listSkillsMain(["bun", "list-skills.ts", ...common, "--json"]));
    expect(JSON.parse(json.stdout)[0]).toMatchObject({ name: "alpha", profiles: [] });
    expect(
      capture(() => listSkillsMain(["bun", "list-skills.ts", ...common, "--names-only"])).stdout,
    ).toBe("alpha");
    expect(
      capture(() =>
        listSkillsMain(["bun", "list-skills.ts", ...common, "--query", "does-not-match"]),
      ).stdout,
    ).toBe("No skills matched.");
    expect(capture(() => listSkillsMain(["bun", "list-skills.ts", ...common])).stdout).toContain(
      "- alpha [testing] tags: bun, cli",
    );
  });
});

describe("F-15 packaged CLI wrapper characterization", () => {
  test("runs both npm bin symlinks after packing and installing the tarball", () => {
    const root = makePackageTempRoot();
    const packDir = path.join(root, "pack");
    const installRoot = path.join(root, "install");
    const cacheDir = path.join(root, "npm-cache");
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(installRoot, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });

    const packed = JSON.parse(
      runNpm(["pack", "--json", "--pack-destination", packDir], repoRoot, cacheDir),
    ) as Array<{ filename?: string }> | Record<string, { filename?: string }>;
    const entries = Array.isArray(packed) ? packed : Object.values(packed);
    expect(entries).toHaveLength(1);
    const filename = entries[0]?.filename;
    expect(filename).toMatch(/\.tgz$/);
    const tarball = path.join(packDir, filename!);
    expect(fs.existsSync(tarball)).toBe(true);

    runNpm(["init", "--yes"], installRoot, cacheDir);
    runNpm(["install", "--no-audit", "--no-fund", tarball], installRoot, cacheDir);

    for (const [binName, helpMarker] of [
      ["skill-sys", "Skill-Sys"],
      ["skillpool", "Universal Skills (Git-only)"],
    ] as const) {
      const binPath = path.join(installRoot, "node_modules", ".bin", binName);
      expect(fs.lstatSync(binPath).isSymbolicLink()).toBe(true);
      const help = execFileSync(binPath, ["--help"], {
        cwd: installRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      expect(help).toContain(helpMarker);
      expect(help).toContain("Usage:");
    }
  }, 120_000);
});

describe("F-15 skill-lifecycle CLI wrapper characterization", () => {
  test("exposes event contracts and parses all commands and options", () => {
    expect(ALLOWED_EVENTS).toEqual(
      new Set(["archived", "removed", "merged", "renamed", "deprecated"]),
    );
    expect(REPLACEMENT_REQUIRED_EVENTS).toEqual(new Set(["merged", "renamed", "deprecated"]));

    const parsed = parseLifecycleArgs([
      "bun",
      "skill-lifecycle.ts",
      "lookup",
      "old-skill",
      "--file",
      "tmp/lifecycle.json",
      "--skills-root",
      "tmp/skills",
      "--json",
      "--write",
      "--skill",
      "override",
      "--event",
      "renamed",
      "--date",
      "2026-07-26",
      "--replacement",
      "alpha,beta",
      "--replacements",
      "beta,gamma",
      "--reason",
      "Consolidated",
      "--agent-action",
      "Use alpha",
      "--reference",
      "docs/one.md",
      "--reference",
      "docs/two.md",
      "--archive-path",
      "archive/old-skill",
      "-h",
    ]);
    expect(parsed).toMatchObject({
      command: "lookup",
      file: path.resolve("tmp/lifecycle.json"),
      skillsRoot: path.resolve("tmp/skills"),
      json: true,
      write: true,
      skill: "override",
      event: "renamed",
      date: "2026-07-26",
      replacements: ["alpha", "beta", "beta", "gamma"],
      reason: "Consolidated",
      agentAction: "Use alpha",
      references: ["docs/one.md", "docs/two.md"],
      archivePath: "archive/old-skill",
      help: true,
    });
    expect(parseLifecycleArgs(["bun", "skill-lifecycle.ts", "--help"])).toMatchObject({
      command: "help",
      help: true,
    });
    expect(() =>
      parseLifecycleArgs(["bun", "skill-lifecycle.ts", "audit", "stray"]),
    ).toThrow("Unknown argument: stray");
    expect(() =>
      parseLifecycleArgs(["bun", "skill-lifecycle.ts", "audit", "--file"]),
    ).toThrow("Missing value for --file");
    expect(() =>
      parseLifecycleArgs(["bun", "skill-lifecycle.ts", "audit", "--wat", "value"]),
    ).toThrow("Unknown option: --wat");
  });

  test("normalizes lifecycle entries, sorts lookups, and formats human guidance", () => {
    expect(normalizeEntry({})).toEqual({
      skill: "",
      event: "",
      date: "",
      replacements: [],
      reason: "",
      agent_action: "",
    });
    const normalized = normalizeEntry({
      skill: " old-skill ",
      event: " renamed ",
      date: " 2026-07-26 ",
      replacements: "alpha, alpha, beta",
      reason: " Consolidated ",
      agentAction: " Use alpha ",
      archivePath: " archive/old-skill ",
      references: ["docs/one.md", "docs/one.md", "", " docs/two.md "],
    });
    expect(normalized).toEqual({
      skill: "old-skill",
      event: "renamed",
      date: "2026-07-26",
      replacements: ["alpha", "beta"],
      reason: "Consolidated",
      agent_action: "Use alpha",
      archive_path: "archive/old-skill",
      references: ["docs/one.md", "docs/two.md"],
    });
    expect(
      normalizeEntry({
        replacements: ["alpha", " alpha ", ""],
        agent_action: "keep",
        archive_path: "archive/path",
      }),
    ).toMatchObject({
      replacements: ["alpha"],
      agent_action: "keep",
      archive_path: "archive/path",
    });

    const entries = [
      normalizeEntry({
        skill: "zulu",
        event: "removed",
        date: "2026-01-01",
        reason: "old",
        agent_action: "stop",
      }),
      normalized,
      normalizeEntry({
        skill: "alpha-old",
        event: "removed",
        date: "2026-07-26",
        reason: "old",
        agent_action: "stop",
      }),
    ];
    expect(lookupEntries(validLifecycle(entries) as never, "old-skill")).toEqual([normalized]);
    expect(lookupEntries(validLifecycle(entries) as never, "missing")).toEqual([]);
    expect(formatEntry(normalized)).toContain("- replacement: `alpha`, `beta`");
    expect(formatEntry(entries[0]!)).toContain("- replacement: no direct replacement");
  });

  test("discovers active skills and validates both valid and malformed lifecycle shapes", () => {
    const root = makeTempRoot("f15-lifecycle-validate");
    const skillsRoot = path.join(root, "skills");
    writeSkill(skillsRoot, "alpha");
    writeSkill(skillsRoot, "zulu");
    fs.mkdirSync(path.join(skillsRoot, ".hidden"), { recursive: true });
    fs.mkdirSync(path.join(skillsRoot, "missing-file"), { recursive: true });
    writeText(path.join(skillsRoot, "plain-file"), "not a directory");

    expect(listActiveSkills(path.join(root, "missing"))).toEqual([]);
    expect(listActiveSkills(skillsRoot)).toEqual(["alpha", "zulu"]);
    expect(validateLifecycle(null, { skillsRoot })).toEqual([
      {
        level: "ERROR",
        code: "LIFECYCLE_INVALID",
        message: "lifecycle file must be a JSON object",
      },
    ]);
    expect(
      validateLifecycle(
        {
          version: 1,
          updated_at: "2026-07-26T00:00:00Z",
          entries: "invalid",
        },
        { skillsRoot },
      ).map((finding) => finding.code),
    ).toEqual(["LIFECYCLE_ENTRIES_INVALID"]);

    const valid = validLifecycle([
      {
        skill: "old-alpha",
        event: "renamed",
        date: "2026-07-26",
        replacements: ["alpha"],
        reason: "Renamed",
        agent_action: "Use alpha",
        archive_path: "archive/old-alpha",
        references: ["docs/migration.md"],
      },
      {
        skill: "alpha",
        event: "deprecated",
        date: "2026-07-25",
        replacements: ["zulu"],
        reason: "Phasing out",
        agent_action: "Use zulu",
      },
    ]);
    expect(validateLifecycle(valid, { skillsRoot })).toEqual([]);
  });

  test("reports every lifecycle validation finding class", () => {
    const root = makeTempRoot("f15-lifecycle-findings");
    const skillsRoot = path.join(root, "skills");
    writeSkill(skillsRoot, "alpha");

    const malformed = {
      version: 2,
      updated_at: "yesterday",
      entries: [
        {
          skill: "alpha",
          event: "removed",
          date: "2026-02-30",
          replacements: [],
          reason: "",
          agent_action: "",
          archive_path: "/absolute/archive",
          references: ["/absolute/reference"],
        },
        {
          skill: "alpha",
          event: "removed",
          date: "2026-02-30",
          replacements: [],
          reason: "duplicate",
          agent_action: "stop",
        },
        {
          skill: "legacy",
          event: "merged",
          date: "2026-07-26",
          replacements: ["Bad_Name", "legacy", "missing"],
          reason: "merged",
          agent_action: "migrate",
        },
        {
          skill: "Bad/Name",
          event: "invented",
          date: "not-a-date",
          replacements: [],
          reason: "invalid",
          agent_action: "stop",
        },
        {
          skill: "needs-replacement",
          event: "renamed",
          date: "2026-07-26",
          replacements: [],
          reason: "renamed",
          agent_action: "migrate",
        },
      ],
    };
    const codes = new Set(validateLifecycle(malformed, { skillsRoot }).map((finding) => finding.code));
    for (const code of [
      "LIFECYCLE_VERSION_INVALID",
      "LIFECYCLE_UPDATED_AT_INVALID",
      "LIFECYCLE_DUPLICATE_ENTRY",
      "LIFECYCLE_SKILL_INVALID",
      "LIFECYCLE_EVENT_INVALID",
      "LIFECYCLE_DATE_INVALID",
      "LIFECYCLE_REASON_MISSING",
      "LIFECYCLE_AGENT_ACTION_MISSING",
      "LIFECYCLE_REPLACEMENT_REQUIRED",
      "LIFECYCLE_REPLACEMENT_INVALID",
      "LIFECYCLE_REPLACEMENT_SELF",
      "LIFECYCLE_REPLACEMENT_MISSING",
      "LIFECYCLE_ARCHIVE_PATH_ABSOLUTE",
      "LIFECYCLE_REFERENCE_INVALID",
      "LIFECYCLE_SKILL_STILL_ACTIVE",
    ]) {
      expect(codes).toContain(code);
    }
  });

  test("audit command renders pass, warning, and blocking reports", () => {
    const root = makeTempRoot("f15-lifecycle-audit");
    const file = path.join(root, "skill-lifecycle.json");
    const skillsRoot = path.join(root, "skills");
    writeSkill(skillsRoot, "alpha");

    writeJson(file, validLifecycle());
    const pass = capture(() =>
      auditCommand({
        ...parseLifecycleArgs(["bun", "skill-lifecycle.ts", "audit"]),
        file,
        skillsRoot,
      }),
    );
    expect(pass.stdout).toBe("STATUS: PASS\nErrors: 0  Warnings: 0");

    writeJson(
      file,
      validLifecycle([
        {
          skill: "alpha",
          event: "removed",
          date: "2026-07-26",
          replacements: [],
          reason: "Removed",
          agent_action: "Stop using",
        },
      ]),
    );
    const warning = capture(() =>
      auditCommand({
        ...parseLifecycleArgs(["bun", "skill-lifecycle.ts", "audit"]),
        file,
        skillsRoot,
      }),
    );
    expect(warning.stdout).toContain("STATUS: CONCERNS");
    expect(warning.stdout).toContain("[WARN LIFECYCLE_SKILL_STILL_ACTIVE]");

    writeJson(file, { version: 99, updated_at: "invalid", entries: [] });
    const blocking = capture(() =>
      auditCommand({
        ...parseLifecycleArgs(["bun", "skill-lifecycle.ts", "audit"]),
        file,
        skillsRoot,
      }),
    );
    expect(blocking.code).toBe(1);
    expect(blocking.stdout).toContain("STATUS: BLOCKING");
    expect(blocking.stdout).toContain("[ERROR LIFECYCLE_VERSION_INVALID]");
  });

  test("lookup command supports text/JSON output and missing-entry exits", () => {
    const root = makeTempRoot("f15-lifecycle-lookup");
    const file = path.join(root, "skill-lifecycle.json");
    const entry = {
      skill: "old-alpha",
      event: "renamed",
      date: "2026-07-26",
      replacements: ["alpha"],
      reason: "Renamed",
      agent_action: "Use alpha",
    };
    writeJson(
      file,
      validLifecycle([
        { ...entry, date: "2026-01-01", reason: "Older rename" },
        entry,
      ]),
    );

    const base = {
      ...parseLifecycleArgs(["bun", "skill-lifecycle.ts", "lookup", "old-alpha"]),
      file,
    };
    const text = capture(() => lookupCommand(base));
    expect(text.stdout).toContain("old-alpha: renamed on 2026-07-26");
    expect(text.stdout.indexOf("2026-07-26")).toBeLessThan(text.stdout.indexOf("2026-01-01"));
    const json = capture(() => lookupCommand({ ...base, json: true }));
    expect(JSON.parse(json.stdout)).toHaveLength(2);

    const { skill: _skill, ...withoutSkill } = base;
    expect(() => lookupCommand(withoutSkill)).toThrow(
      "lookup requires <skill> or --skill <name>",
    );
    const missingText = capture(() => lookupCommand({ ...base, skill: "missing" }));
    expect(missingText.code).toBe(1);
    expect(missingText.stdout).toBe("No lifecycle entry found for 'missing'.");
    const missingJson = capture(() => lookupCommand({ ...base, skill: "missing", json: true }));
    expect(missingJson.code).toBe(1);
    expect(JSON.parse(missingJson.stdout)).toEqual([]);
  });

  test("resolves replacement chains to active and terminal lifecycle nodes", () => {
    const root = makeTempRoot("f15-lifecycle-resolve");
    const skillsRoot = path.join(root, "skills");
    writeSkill(skillsRoot, "alpha");
    const activeSkills = new Set(listActiveSkills(skillsRoot));
    const data = validLifecycle([
      {
        skill: "old-alpha",
        event: "renamed",
        date: "2026-07-26",
        replacements: ["legacy-alpha"],
        reason: "Renamed",
        agent_action: "Follow the replacement chain",
      },
      {
        skill: "legacy-alpha",
        event: "merged",
        date: "2026-07-25",
        replacements: ["alpha"],
        reason: "Merged",
        agent_action: "Use alpha",
      },
      {
        skill: "retired",
        event: "removed",
        date: "2026-07-24",
        replacements: [],
        reason: "Removed",
        agent_action: "Do not use retired",
      },
      {
        skill: "archived-with-alternatives",
        event: "archived",
        date: "2026-07-23",
        replacements: ["alpha"],
        reason: "Archived with an advisory alternative",
        agent_action: "Use the alternative when it matches the task",
      },
    ]);

    expect(resolveLifecycle(data as never, "old-alpha", { activeSkills })).toEqual({
      schema_version: "skill-lifecycle-resolution/v1",
      skill: "old-alpha",
      terminal: "alpha",
      terminal_event: "active",
      path: ["old-alpha", "legacy-alpha", "alpha"],
    });
    expect(resolveLifecycle(data as never, "retired", { activeSkills })).toEqual({
      schema_version: "skill-lifecycle-resolution/v1",
      skill: "retired",
      terminal: "retired",
      terminal_event: "removed",
      path: ["retired"],
    });
    expect(resolveLifecycle(data as never, "archived-with-alternatives", { activeSkills })).toEqual({
      schema_version: "skill-lifecycle-resolution/v1",
      skill: "archived-with-alternatives",
      terminal: "archived-with-alternatives",
      terminal_event: "archived",
      path: ["archived-with-alternatives"],
    });
    expect(validateLifecycle(data, { skillsRoot })).toEqual([]);

    const file = path.join(root, "skill-lifecycle.json");
    writeJson(file, data);
    const json = capture(() =>
      resolveCommand({
        ...parseLifecycleArgs(["bun", "skill-lifecycle.ts", "resolve", "old-alpha", "--json"]),
        file,
        skillsRoot,
      }),
    );
    expect(JSON.parse(json.stdout)).toEqual({
      schema_version: "skill-lifecycle-resolution/v1",
      skill: "old-alpha",
      terminal: "alpha",
      terminal_event: "active",
      path: ["old-alpha", "legacy-alpha", "alpha"],
    });
  });

  test("rejects missing, ambiguous, and cyclic lifecycle graph nodes", () => {
    const root = makeTempRoot("f15-lifecycle-graph-errors");
    const skillsRoot = path.join(root, "skills");
    writeSkill(skillsRoot, "alpha");
    writeSkill(skillsRoot, "beta");
    const activeSkills = new Set(listActiveSkills(skillsRoot));
    const missing = validLifecycle([
      {
        skill: "old",
        event: "renamed",
        date: "2026-07-26",
        replacements: ["gone"],
        reason: "Renamed",
        agent_action: "Use gone",
      },
    ]);
    expect(() => resolveLifecycle(missing as never, "old", { activeSkills })).toThrow(
      "LIFECYCLE_REPLACEMENT_MISSING",
    );

    const ambiguous = validLifecycle([
      {
        skill: "old",
        event: "merged",
        date: "2026-07-26",
        replacements: ["alpha", "beta"],
        reason: "Merged",
        agent_action: "Choose a replacement",
      },
    ]);
    expect(() => resolveLifecycle(ambiguous as never, "old", { activeSkills })).toThrow(
      "LIFECYCLE_REPLACEMENT_AMBIGUOUS",
    );

    const cyclic = validLifecycle([
      {
        skill: "first",
        event: "renamed",
        date: "2026-07-26",
        replacements: ["second"],
        reason: "Renamed",
        agent_action: "Use second",
      },
      {
        skill: "second",
        event: "renamed",
        date: "2026-07-25",
        replacements: ["first"],
        reason: "Renamed",
        agent_action: "Use first",
      },
    ]);
    expect(() => resolveLifecycle(cyclic as never, "first", { activeSkills })).toThrow(
      "LIFECYCLE_REPLACEMENT_CYCLE",
    );
    expect(validateLifecycle(cyclic, { skillsRoot }).map((finding) => finding.code)).toContain(
      "LIFECYCLE_REPLACEMENT_CYCLE",
    );

    const duplicateCurrent = validLifecycle([
      {
        skill: "old",
        event: "renamed",
        date: "2026-07-26",
        replacements: ["alpha"],
        reason: "Renamed",
        agent_action: "Use alpha",
      },
      {
        skill: "old",
        event: "removed",
        date: "2026-07-26",
        replacements: [],
        reason: "Removed",
        agent_action: "Stop using old",
      },
    ]);
    expect(validateLifecycle(duplicateCurrent, { skillsRoot }).map((finding) => finding.code)).toContain(
      "LIFECYCLE_NODE_AMBIGUOUS",
    );
  });

  test("installer advice uses the terminal resolution", () => {
    const entriesBySkill = new Map([
      [
        "old",
        [
          {
            skill: "old",
            event: "renamed",
            date: "2026-07-26",
            replacements: ["legacy"],
            reason: "Renamed",
            agent_action: "Follow the chain",
          },
        ],
      ],
      [
        "legacy",
        [
          {
            skill: "legacy",
            event: "merged",
            date: "2026-07-25",
            replacements: ["alpha"],
            reason: "Merged",
            agent_action: "Use alpha",
          },
        ],
      ],
    ]);
    const advice = formatLifecycleAdvice("old", { entriesBySkill }, new Set(["alpha"]));
    expect(advice).toContain("Use instead: alpha.");
    expect(advice).toContain("Resolution path: old -> legacy -> alpha.");
  });

  test("record command validates required fields, supports dry-run/write, and fails closed", () => {
    const root = makeTempRoot("f15-lifecycle-record");
    const file = path.join(root, "nested", "skill-lifecycle.json");
    const skillsRoot = path.join(root, "skills");
    writeSkill(skillsRoot, "alpha");
    const base = {
      ...parseLifecycleArgs(["bun", "skill-lifecycle.ts", "record"]),
      file,
      skillsRoot,
    };

    expect(() => recordCommand(base)).toThrow("record requires --skill <name>");
    expect(() => recordCommand({ ...base, skill: "old-alpha" })).toThrow(
      "record requires --event <event>",
    );
    expect(() => recordCommand({ ...base, skill: "old-alpha", event: "removed" })).toThrow(
      "record requires --reason <text>",
    );
    expect(() =>
      recordCommand({
        ...base,
        skill: "old-alpha",
        event: "removed",
        reason: "Removed",
      }),
    ).toThrow("record requires --agent-action <text>");

    const dryRun = capture(() =>
      recordCommand({
        ...base,
        skill: "old-alpha",
        event: "removed",
        date: "2026-07-26",
        reason: "Removed",
        agentAction: "Stop using",
        references: ["docs/removal.md"],
        archivePath: "archive/old-alpha",
      }),
    );
    expect(dryRun.stdout).toContain("dry-run: lifecycle entry not written");
    expect(dryRun.stdout).toContain('"skill": "old-alpha"');
    expect(fs.existsSync(file)).toBe(false);

    const written = capture(() =>
      recordCommand({
        ...base,
        skill: "old-alpha",
        event: "renamed",
        date: "2026-07-26",
        replacements: ["alpha", "alpha"],
        reason: "Renamed",
        agentAction: "Use alpha",
        write: true,
      }),
    );
    expect(written.stdout).toBe("recorded: old-alpha renamed");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).entries[0]).toMatchObject({
      skill: "old-alpha",
      event: "renamed",
      replacements: ["alpha"],
    });

    const invalid = capture(() =>
      recordCommand({
        ...base,
        file: path.join(root, "invalid.json"),
        skill: "old-beta",
        event: "merged",
        reason: "Merged",
        agentAction: "Migrate",
      }),
    );
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("[ERROR LIFECYCLE_REPLACEMENT_REQUIRED]");

    writeText(path.join(root, "bad.json"), "{not json");
    expect(() =>
      recordCommand({
        ...base,
        file: path.join(root, "bad.json"),
        skill: "old-beta",
        event: "removed",
        reason: "Removed",
        agentAction: "Stop",
      }),
    ).toThrow("Invalid lifecycle JSON");
  });

  test("main dispatches help/audit/lookup/record and reports parser and command errors", () => {
    const root = makeTempRoot("f15-lifecycle-main");
    const file = path.join(root, "skill-lifecycle.json");
    const skillsRoot = path.join(root, "skills");
    writeSkill(skillsRoot, "alpha");
    writeJson(
      file,
      validLifecycle([
        {
          skill: "old-alpha",
          event: "renamed",
          date: "2026-07-26",
          replacements: ["alpha"],
          reason: "Renamed",
          agent_action: "Use alpha",
        },
      ]),
    );

    expect(captureLifecycleMain(["bun", "skill-lifecycle.ts", "--help"]).stdout).toContain(
      "Skill lifecycle changelog tools",
    );
    expect(
      captureLifecycleMain([
        "bun",
        "skill-lifecycle.ts",
        "audit",
        "--file",
        file,
        "--skills-root",
        skillsRoot,
      ]).stdout,
    ).toContain("STATUS: PASS");
    expect(
      captureLifecycleMain([
        "bun",
        "skill-lifecycle.ts",
        "lookup",
        "old-alpha",
        "--file",
        file,
      ]).stdout,
    ).toContain("old-alpha: renamed");
    expect(
      captureLifecycleMain([
        "bun",
        "skill-lifecycle.ts",
        "record",
        "--file",
        file,
        "--skills-root",
        skillsRoot,
        "--skill",
        "retired",
        "--event",
        "removed",
        "--reason",
        "Retired",
        "--agent-action",
        "Stop",
      ]).stdout,
    ).toContain("dry-run: lifecycle entry not written");

    const parseError = captureLifecycleMain([
      "bun",
      "skill-lifecycle.ts",
      "audit",
      "--file",
    ]);
    expect(parseError.code).toBe(1);
    expect(parseError.stderr).toContain("ERROR: Missing value for --file");
    expect(parseError.stdout).toContain("Skill lifecycle changelog tools");

    const unknown = captureLifecycleMain(["bun", "skill-lifecycle.ts", "invented"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("ERROR: Unknown command 'invented'");
    const missingFile = captureLifecycleMain([
      "bun",
      "skill-lifecycle.ts",
      "audit",
      "--file",
      path.join(root, "missing.json"),
    ]);
    expect(missingFile.code).toBe(1);
    expect(missingFile.stderr).toContain("ERROR: Lifecycle file not found");
  });
});
