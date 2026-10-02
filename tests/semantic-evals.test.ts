import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildJsonInventory,
  calculateTier,
  isCompatibilityArtifact,
  isHiddenByMetadataFlags,
  isTruthy,
  loadLifecycleEntries,
  normalizeValue,
  parseArgs,
  parseFrontmatter,
  tableCell,
  wrapText,
} from "../scripts/commands/generate-skills-inventory.ts";
import {
  listSkills,
  parseArgs as parseListArgs,
} from "../scripts/commands/list-skills.ts";
import {
  buildCard,
  collectCards,
  main as catalogMain,
  parseArgs as parseCatalogArgs,
  renderCatalogJson,
  renderCatalogMarkdown,
} from "../scripts/commands/generate-skill-catalog.ts";

const tempDirs: string[] = [];

function tempRoot(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("skills inventory generation helpers", () => {
  test("parseArgs supports help only and rejects unknown options", () => {
    expect(parseArgs(["bun", "generate-skills-inventory.ts", "--help"])).toEqual({
      help: true,
      includeInternal: false,
      includeExperimental: false,
    });
    expect(parseArgs(["bun", "generate-skills-inventory.ts", "-h"])).toEqual({
      help: true,
      includeInternal: false,
      includeExperimental: false,
    });
    expect(parseArgs(["bun", "generate-skills-inventory.ts"])).toEqual({
      help: false,
      includeInternal: false,
      includeExperimental: false,
    });
    expect(() => parseArgs(["bun", "generate-skills-inventory.ts", "--json"])).toThrow("Unknown option: --json");
  });

  test("parseFrontmatter handles scalars, nested metadata, multiline values, quotes, and booleans", () => {
    const parsed = parseFrontmatter(`---
name: alpha
description: |
  Use when alpha is needed.
  Keeps wording wrapped.
deprecated: "false"
archived: true
compatibility_only: 0
category: general
metadata:
  version: '1.2.3'
  updated_at: 2026-06-08
  target_provider: universal
  deprecated: false
---
# Alpha
`);

    expect(parsed).toEqual({
      name: "alpha",
      description: "Use when alpha is needed.\nKeeps wording wrapped.",
      deprecated: "false",
      archived: true,
      compatibility_only: false,
      category: "general",
      metadata: {
        version: "1.2.3",
        updated_at: "2026-06-08",
        target_provider: "universal",
        deprecated: false,
      },
    });
    expect(parseFrontmatter("# no frontmatter")).toBeNull();
  });

  test("compatibility detection accepts deprecated, archived, compatibility_only, and category markers", () => {
    expect(isTruthy(true)).toBe(true);
    expect(isTruthy("YES")).toBe(true);
    expect(isTruthy("off")).toBe(false);
    expect(isCompatibilityArtifact({ deprecated: true })).toBe(true);
    expect(isCompatibilityArtifact({ archived: "1" })).toBe(true);
    expect(isCompatibilityArtifact({ compatibility_only: "on" })).toBe(true);
    expect(isCompatibilityArtifact({ category: "compatibility" })).toBe(true);
    expect(isCompatibilityArtifact({ metadata: { category: "compatibility" } })).toBe(true);
    expect(isCompatibilityArtifact({ metadata: { deprecated: "yes" } })).toBe(true);
    expect(isCompatibilityArtifact({ category: "general", metadata: { category: "general" } })).toBe(false);
  });

  test("calculateTier classifies by line count and references directory", () => {
    const root = tempRoot("inventory-tier");
    const plain = path.join(root, "plain");
    const referenced = path.join(root, "referenced");
    fs.mkdirSync(plain, { recursive: true });
    fs.mkdirSync(path.join(referenced, "references"), { recursive: true });

    expect(calculateTier(plain, 20)).toBe(1);
    expect(calculateTier(plain, 200)).toBe(2);
    expect(calculateTier(referenced, 20)).toBe(2);
    expect(calculateTier(referenced, 801)).toBe(3);
  });

  test("format helpers wrap descriptions, escape table cells, and normalize scalar values", () => {
    expect(wrapText("alpha beta gamma", 10)).toEqual(["alpha beta", "gamma"]);
    expect(wrapText("", 10)).toEqual(["Description unavailable."]);
    expect(tableCell("a | b\n c")).toBe("a \\| b c");
    expect(normalizeValue(" true ")).toBe(true);
    expect(normalizeValue("'quoted'")).toBe("quoted");
    expect(normalizeValue('"quoted"')).toBe("quoted");
  });

  test("buildJsonInventory creates name lookup, tier buckets, lifecycle redirects, and stable notes", () => {
    const skill = {
      name: "alpha",
      description: "Use when alpha.",
      version: "1.0.0",
      updatedAt: "2026-06-08",
      targetProvider: "universal",
      tier: 1,
      lineCount: 42,
      skillDir: "skills/alpha",
      skillFile: "skills/alpha/SKILL.md",
    };
    const inventory = buildJsonInventory(
      "2026-06-08",
      [skill],
      new Map([[1, [skill]], [2, []], [3, []]]),
      [
        {
          skill: "old-alpha",
          event: "renamed",
          date: "2026-01-01",
          replacements: ["alpha"],
          agent_action: "use replacement",
        },
      ]
    );

    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.totalSkills).toBe(1);
    expect(inventory.skillsByName.alpha).toEqual(skill);
    expect(inventory.tiers["1"]?.skillNames).toEqual(["alpha"]);
    expect(inventory.lifecycleRedirects).toEqual([
      {
        skill: "old-alpha",
        event: "renamed",
        date: "2026-01-01",
        replacements: ["alpha"],
        agentAction: "use replacement",
      },
    ]);
    expect(inventory.notes.join("\n")).toContain("SKILLS.json");
  });

  test("loadLifecycleEntries reads the checked-in lifecycle file as sorted redirect data", async () => {
    const entries = await loadLifecycleEntries();
    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) {
      expect(typeof entry).toBe("object");
    }
  });
});

function writeFlagSkill(root: string, skillsRoot: string, name: string, metadataExtra: string): void {
  const skillDir = path.join(skillsRoot, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const metadataBlock = metadataExtra ? `metadata:\n  ${metadataExtra}\n` : "metadata:\n  tags: demo\n";
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill.\n${metadataBlock}---\n# ${name}\n`,
  );
}

describe("PR08 metadata visibility flags (internal/experimental)", () => {
  test("isHiddenByMetadataFlags hides truthy internal/experimental by default and respects include flags", () => {
    // Truthy values (true, 1, yes, on) are hidden by default.
    expect(isHiddenByMetadataFlags({ metadata: { internal: true } }, {})).toBe(true);
    expect(isHiddenByMetadataFlags({ metadata: { internal: "1" } }, {})).toBe(true);
    expect(isHiddenByMetadataFlags({ metadata: { internal: "yes" } }, {})).toBe(true);
    expect(isHiddenByMetadataFlags({ metadata: { internal: "on" } }, {})).toBe(true);
    expect(isHiddenByMetadataFlags({ metadata: { experimental: true } }, {})).toBe(true);

    // Include flags reveal them.
    expect(isHiddenByMetadataFlags({ metadata: { internal: true } }, { includeInternal: true })).toBe(false);
    expect(isHiddenByMetadataFlags({ metadata: { experimental: true } }, { includeExperimental: true })).toBe(false);

    // Falsey / absent values are never hidden.
    expect(isHiddenByMetadataFlags({ metadata: { internal: false } }, {})).toBe(false);
    expect(isHiddenByMetadataFlags({ metadata: { internal: "off" } }, {})).toBe(false);
    expect(isHiddenByMetadataFlags({ metadata: { experimental: "0" } }, {})).toBe(false);
    expect(isHiddenByMetadataFlags({}, {})).toBe(false);
    expect(isHiddenByMetadataFlags({ metadata: {} }, {})).toBe(false);
  });

  test("inventory parseArgs accepts --include-internal and --include-experimental", () => {
    expect(parseArgs(["bun", "g", "--include-internal"])).toMatchObject({ includeInternal: true });
    expect(parseArgs(["bun", "g", "--include-experimental"])).toMatchObject({ includeExperimental: true });
    expect(parseArgs(["bun", "g"])).toMatchObject({ includeInternal: false, includeExperimental: false });
  });

  test("listSkills hides internal/experimental by default and reveals them with the include flags", () => {
    const root = tempRoot("list-flags");
    const skillsRoot = path.join(root, "skills");
    writeFlagSkill(root, skillsRoot, "normal", "tags: demo");
    writeFlagSkill(root, skillsRoot, "intern", "internal: true");
    writeFlagSkill(root, skillsRoot, "exper", "experimental: yes");

    const baseOptions = {
      skillsRoot,
      profilesRoot: path.join(root, "profiles"),
      categories: [] as string[],
      tags: [] as string[],
      queries: [] as string[],
      profiles: [] as string[],
      json: false,
      namesOnly: false,
    };
    const names = (overrides: Partial<Parameters<typeof listSkills>[0]>): string[] =>
      listSkills({ ...baseOptions, includeInternal: false, includeExperimental: false, ...overrides }).map(
        (skill) => skill.name,
      );

    // Default excludes internal and experimental.
    expect(names({})).toEqual(["normal"]);
    // Each include flag reveals only its own category.
    expect(names({ includeInternal: true })).toEqual(["intern", "normal"]);
    expect(names({ includeExperimental: true })).toEqual(["exper", "normal"]);
    // Both flags reveal everything.
    expect(names({ includeInternal: true, includeExperimental: true })).toEqual([
      "exper",
      "intern",
      "normal",
    ]);
  });

  test("list-skills parseArgs accepts --include-internal and --include-experimental", () => {
    expect(parseListArgs(["bun", "l", "--include-internal"])).toMatchObject({ includeInternal: true });
    expect(parseListArgs(["bun", "l", "--include-experimental"])).toMatchObject({ includeExperimental: true });
    const defaults = parseListArgs(["bun", "l"]);
    expect(defaults.includeInternal).toBe(false);
    expect(defaults.includeExperimental).toBe(false);
  });

  test("listSkills JSON records carry internal/experimental booleans when revealed", () => {
    const root = tempRoot("list-flags-json");
    const skillsRoot = path.join(root, "skills");
    writeFlagSkill(root, skillsRoot, "normal", "tags: demo");
    writeFlagSkill(root, skillsRoot, "intern", "internal: true");

    const skills = listSkills({
      skillsRoot,
      profilesRoot: path.join(root, "profiles"),
      categories: [],
      tags: [],
      queries: [],
      profiles: [],
      json: true,
      namesOnly: false,
      includeInternal: true,
      includeExperimental: false,
    });
    const intern = skills.find((skill) => skill.name === "intern");
    const normal = skills.find((skill) => skill.name === "normal");
    expect(intern?.internal).toBe(true);
    expect(intern?.experimental).toBe(false);
    expect(normal?.internal).toBe(false);
    expect(normal?.experimental).toBe(false);
  });
});

describe("PR09 skill card / catalog generator", () => {
  function writeCatalogSkill(
    root: string,
    name: string,
    frontmatter: string,
    risk?: Record<string, boolean>,
  ): void {
    const skillDir = path.join(root, "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n# ${name}\n`);
    if (risk) {
      fs.writeFileSync(path.join(skillDir, "skill.meta.json"), JSON.stringify({ risk }, null, 2));
    }
  }

  afterEach(() => {
    process.exitCode = undefined;
  });

  test("catalog parseArgs defaults both format and supports all flags", () => {
    const args = parseCatalogArgs(["bun", "gsc", "--source", "X", "--out-dir", "Y"]);
    expect(args).toMatchObject({
      source: "X",
      outDir: "Y",
      format: "both",
      check: false,
      includeInternal: false,
      includeExperimental: false,
      help: false,
    });
    const full = parseCatalogArgs([
      "bun",
      "gsc",
      "--source",
      "X",
      "--out-dir",
      "Y",
      "--format",
      "json",
      "--check",
      "--include-internal",
      "--include-experimental",
    ]);
    expect(full).toMatchObject({
      format: "json",
      check: true,
      includeInternal: true,
      includeExperimental: true,
    });
    expect(() => parseCatalogArgs(["bun", "gsc", "--format", "yaml"])).toThrow(
      "Invalid --format 'yaml'. Expected markdown, json, or both.",
    );
    expect(() => parseCatalogArgs(["bun", "gsc", "--unknown"])).toThrow("Unknown option: --unknown");
  });

  test("buildCard derives useWhen, providerSupport, risk, and sourcePath", () => {
    const meta = parseFrontmatter(`---
name: demo
description: Demo skill.
metadata:
  tags: a, b
  triggers: go, run
  target_provider: universal
  compatible_providers: codex, claude-code
  useWhen: Use when demonstrating.
---`);
    const card = buildCard(meta!, "demo", { destructive: false });
    expect(card.name).toBe("demo");
    expect(card.useWhen).toBe("Use when demonstrating.");
    expect(card.tags).toEqual(["a", "b"]);
    expect(card.triggers).toEqual(["go", "run"]);
    expect(card.targetProvider).toBe("universal");
    expect(card.providerSupport).toEqual({ targetProvider: "universal", compatible: ["codex", "claude-code"] });
    expect(card.risk).toEqual({ destructive: false });
    expect(card.examples).toEqual([]);
    expect(card.sourcePath).toBe("skills/demo/SKILL.md");
  });

  test("buildCard falls back useWhen to description when metadata.useWhen is absent", () => {
    const meta = parseFrontmatter(`---
name: demo
description: Fallback description.
metadata:
  tags: x
---`);
    const card = buildCard(meta!, "demo", {});
    expect(card.useWhen).toBe("Fallback description.");
  });

  test("collectCards hides internal/experimental by default and reveals them with include flags", async () => {
    const root = tempRoot("catalog-flags");
    writeCatalogSkill(root, "normal", "name: normal\ndescription: normal skill.\nmetadata:\n  tags: demo");
    writeCatalogSkill(
      root,
      "intern",
      "name: intern\ndescription: internal.\nmetadata:\n  tags: demo\n  internal: true",
    );
    writeCatalogSkill(
      root,
      "exper",
      "name: exper\ndescription: experimental.\nmetadata:\n  tags: demo\n  experimental: true",
    );

    const defaults = await collectCards(root);
    expect(defaults.map((card) => card.name)).toEqual(["normal"]);
    const withInternal = await collectCards(root, { includeInternal: true });
    expect(withInternal.map((card) => card.name)).toEqual(["intern", "normal"]);
    const withExperimental = await collectCards(root, { includeExperimental: true });
    expect(withExperimental.map((card) => card.name)).toEqual(["exper", "normal"]);
  });

  test("generator writes only to --out-dir and never root SKILLS.*", async () => {
    const root = tempRoot("catalog-outdir");
    writeCatalogSkill(root, "alpha", "name: alpha\ndescription: alpha skill.\nmetadata:\n  tags: demo");
    const outDir = path.join(root, "out");

    await catalogMain(["bun", "gsc", "--source", root, "--out-dir", outDir, "--format", "both"]);

    expect(fs.existsSync(path.join(outDir, "skill-cards.json"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "skill-cards.md"))).toBe(true);
    // No root SKILLS.* created anywhere in the source tree.
    expect(fs.existsSync(path.join(root, "SKILLS.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "SKILLS.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "skills", "alpha", "SKILLS.json"))).toBe(false);
    // Only the two catalog files plus the source skill exist under out-dir.
    expect(fs.readdirSync(outDir).sort()).toEqual(["skill-cards.json", "skill-cards.md"]);
  });

  test("catalog output is deterministic and free of timestamps/host paths", async () => {
    const root = tempRoot("catalog-determinism");
    writeCatalogSkill(root, "alpha", "name: alpha\ndescription: alpha skill.\nmetadata:\n  tags: demo");
    const outDir1 = path.join(root, "out1");
    const outDir2 = path.join(root, "out2");
    await catalogMain(["bun", "gsc", "--source", root, "--out-dir", outDir1, "--format", "both"]);
    await catalogMain(["bun", "gsc", "--source", root, "--out-dir", outDir2, "--format", "both"]);

    const json1 = fs.readFileSync(path.join(outDir1, "skill-cards.json"), "utf8");
    const json2 = fs.readFileSync(path.join(outDir2, "skill-cards.json"), "utf8");
    expect(json1).toBe(json2);
    const md1 = fs.readFileSync(path.join(outDir1, "skill-cards.md"), "utf8");
    const md2 = fs.readFileSync(path.join(outDir2, "skill-cards.md"), "utf8");
    expect(md1).toBe(md2);

    // No host absolute path or timestamp leakage into generated content.
    expect(json1).not.toContain(root);
    expect(json1).not.toContain(os.tmpdir());
    expect(md1).not.toContain(root);
    expect(md1).not.toContain(os.tmpdir());
    for (const key of ["generatedAt", "timestamp", "updatedAt", "createdAt", "generated_at"]) {
      expect(json1).not.toContain(key);
    }
  });

  test("renderCatalogJson and renderCatalogMarkdown are pure/deterministic", () => {
    const cards = [
      buildCard(
        parseFrontmatter(`---
name: alpha
description: alpha.
metadata:
  tags: x
  target_provider: universal
---`)!,
        "alpha",
        { destructive: false },
      ),
    ];
    expect(renderCatalogJson(cards)).toBe(renderCatalogJson(cards));
    expect(renderCatalogMarkdown(cards)).toBe(renderCatalogMarkdown(cards));
    const parsed = JSON.parse(renderCatalogJson(cards));
    expect(parsed.cards[0].sourcePath).toBe("skills/alpha/SKILL.md");
  });

  test("check mode passes in sync and fails when out of sync", async () => {
    const root = tempRoot("catalog-check");
    writeCatalogSkill(root, "alpha", "name: alpha\ndescription: alpha skill.\nmetadata:\n  tags: demo");
    const outDir = path.join(root, "out");
    await catalogMain(["bun", "gsc", "--source", root, "--out-dir", outDir, "--format", "json"]);

    await catalogMain(["bun", "gsc", "--source", root, "--out-dir", outDir, "--format", "json", "--check"]);

    fs.writeFileSync(path.join(outDir, "skill-cards.json"), "{}\n");
    await expect(
      catalogMain(["bun", "gsc", "--source", root, "--out-dir", outDir, "--format", "json", "--check"]),
    ).rejects.toThrow("skill catalog out of sync");
  });

  test("main rejects missing --source or --out-dir", async () => {
    await expect(catalogMain(["bun", "gsc", "--out-dir", "Y"])).rejects.toThrow(
      "Missing required option: --source",
    );
    await expect(catalogMain(["bun", "gsc", "--source", "X"])).rejects.toThrow(
      "Missing required option: --out-dir",
    );
  });
});
