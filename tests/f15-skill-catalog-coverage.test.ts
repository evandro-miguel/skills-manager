import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCard,
  buildCatalog,
  collectCards,
  main,
  parseArgs,
  renderCatalogJson,
  renderCatalogMarkdown,
} from "../scripts/commands/generate-skill-catalog.ts";
import { parseFrontmatter } from "../scripts/commands/generate-skills-inventory.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "f15-skill-catalog-"));
  roots.push(root);
  await mkdir(path.join(root, "skills", "visible"), { recursive: true });
  await mkdir(path.join(root, "skills", "internal"), { recursive: true });
  await mkdir(path.join(root, "skills", "experimental"), { recursive: true });
  await mkdir(path.join(root, "skills", "_archived"), { recursive: true });
  await mkdir(path.join(root, "skills", "missing-markdown"), { recursive: true });
  await mkdir(path.join(root, "skills", "invalid"), { recursive: true });

  await writeFile(
    path.join(root, "skills", "visible", "SKILL.md"),
    `---
name: visible-skill
description: Use when the visible catalog fixture is needed.
category: testing
metadata:
  tags: "alpha, beta"
  triggers: "catalog fixture, visible skill"
  useWhen: Use when catalog generation is under test.
  target_provider: universal
  compatible_providers: "codex, claude-code"
---
# Visible skill
`,
  );
  await writeFile(
    path.join(root, "skills", "visible", "skill.meta.json"),
    `${JSON.stringify({ risk: { network: false, filesystem: true } })}\n`,
  );
  await writeFile(
    path.join(root, "skills", "internal", "SKILL.md"),
    `---
name: internal-skill
description: Use when internal catalog behavior is under test.
metadata:
  internal: true
  target_provider: codex
---
# Internal skill
`,
  );
  await writeFile(
    path.join(root, "skills", "experimental", "SKILL.md"),
    `---
name: experimental-skill
description: Use when experimental catalog behavior is under test.
metadata:
  experimental: true
  target_provider: opencode
---
# Experimental skill
`,
  );
  await writeFile(
    path.join(root, "skills", "_archived", "SKILL.md"),
    `---
name: archived-skill
description: Use when an archived fixture should remain hidden.
---
# Archived skill
`,
  );
  await writeFile(path.join(root, "skills", "invalid", "SKILL.md"), "# No frontmatter\n");
  return root;
}

async function captureLogs(action: () => Promise<void>): Promise<string[]> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await action();
    return lines;
  } finally {
    console.log = originalLog;
  }
}

describe("F-15 skill catalog characterization", () => {
  test("parses the complete CLI surface and rejects malformed options", () => {
    expect(
      parseArgs([
        "bun",
        "generate-skill-catalog.ts",
        "--source",
        "/source",
        "--out-dir",
        "/output",
        "--format",
        "json",
        "--check",
        "--include-internal",
        "--include-experimental",
      ]),
    ).toEqual({
      source: "/source",
      outDir: "/output",
      format: "json",
      check: true,
      includeInternal: true,
      includeExperimental: true,
      help: false,
    });
    expect(parseArgs(["bun", "script", "-h"]).help).toBe(true);
    expect(() => parseArgs(["bun", "script", "--source"])).toThrow("Missing value for --source");
    expect(() => parseArgs(["bun", "script", "--out-dir"])).toThrow("Missing value for --out-dir");
    expect(() => parseArgs(["bun", "script", "--format"])).toThrow("Missing value for --format");
    expect(() => parseArgs(["bun", "script", "--format", "xml"])).toThrow("Invalid --format");
    expect(() => parseArgs(["bun", "script", "--unknown"])).toThrow("Unknown option");
  });

  test("builds cards and deterministic human and machine catalogs", () => {
    const parsed = parseFrontmatter(`---
name: direct-card
description: Use when building a direct card.
metadata:
  category: tests
  tags: "one, two"
  triggers: "direct card, catalog"
  target_provider: universal
  compatible_providers: "codex, opencode"
---
# Direct
`);
    if (!parsed) throw new Error("fixture frontmatter did not parse");

    const card = buildCard(parsed, "direct-card", { network: false });
    const expectedCard = {
      name: "direct-card",
      description: "Use when building a direct card.",
      useWhen: "Use when building a direct card.",
      category: "tests",
      tags: ["one", "two"],
      triggers: ["direct card", "catalog"],
      targetProvider: "universal",
      providerSupport: { targetProvider: "universal", compatible: ["codex", "opencode"] },
      risk: { network: false },
      examples: [],
      sourcePath: "skills/direct-card/SKILL.md",
    };
    expect(card).toEqual(expectedCard);
    const expectedCatalog: ReturnType<typeof buildCatalog> = {
      schemaVersion: 1,
      source: {
        generator: "scripts/commands/generate-skill-catalog.ts",
        skillsRoot: "skills",
      },
      totalCards: 1,
      cards: [expectedCard],
      notes: [
        "Skill cards are generated from skills/*/SKILL.md frontmatter and optional skill.meta.json risk metadata.",
        "Skills marked metadata.internal or metadata.experimental are excluded by default; regenerate with --include-internal/--include-experimental to include them.",
        "Deprecated, archived, and compatibility-only skills are excluded.",
        "Output is deterministic: no generated time values, host paths, or network results.",
      ],
    };
    expect(buildCatalog([card])).toEqual(expectedCatalog);
    const json = renderCatalogJson([card]);
    const markdown = renderCatalogMarkdown([card]);
    expect(JSON.parse(json)).toEqual(expectedCatalog);
    expect(markdown).toBe(`# Skill Catalog

<!-- Generated by scripts/commands/generate-skill-catalog.ts. Do not edit by hand. -->

Total Skills: 1

## direct-card

- **Use when:** Use when building a direct card.
- **Category:** tests
- **Tags:** one, two
- **Triggers:** direct card, catalog
- **Target provider:** universal
- **Compatible providers:** codex, opencode
- **Path:** skills/direct-card/SKILL.md

## Notes

- Skill cards are generated from skills/*/SKILL.md frontmatter and optional skill.meta.json risk metadata.
- Skills marked metadata.internal or metadata.experimental are excluded by default; regenerate with --include-internal/--include-experimental to include them.
- Deprecated, archived, and compatibility-only skills are excluded.
- Output is deterministic: no generated time values, host paths, or network results.
`);
    expect(renderCatalogJson([card])).toBe(json);
    expect(renderCatalogMarkdown([card])).toBe(markdown);
  });

  test("collects sorted visible cards and honors visibility switches", async () => {
    const root = await fixtureRoot();
    const visible = await collectCards(root);
    expect(visible.map((card) => card.name)).toEqual(["visible-skill"]);
    expect(visible[0]).toMatchObject({
      category: "testing",
      tags: ["alpha", "beta"],
      risk: { network: false, filesystem: true },
    });
    const json = renderCatalogJson(visible);
    const markdown = renderCatalogMarkdown(visible);
    expect(renderCatalogJson(visible)).toBe(json);
    expect(renderCatalogMarkdown(visible)).toBe(markdown);
    expect(json).not.toContain(root);
    expect(markdown).not.toContain(root);

    const all = await collectCards(root, {
      includeInternal: true,
      includeExperimental: true,
    });
    expect(all.map((card) => card.name)).toEqual([
      "experimental-skill",
      "internal-skill",
      "visible-skill",
    ]);
    const allMarkdown = renderCatalogMarkdown(all);
    expect(allMarkdown.indexOf("## experimental-skill")).toBeLessThan(
      allMarkdown.indexOf("## internal-skill"),
    );
    expect(allMarkdown.indexOf("## internal-skill")).toBeLessThan(
      allMarkdown.indexOf("## visible-skill"),
    );
    expect(() => collectCards(path.join(root, "missing"))).toThrow(
      "Source skills directory not found",
    );
  });

  test("writes each format and check mode detects both parity and drift", async () => {
    const root = await fixtureRoot();
    const outDir = path.join(root, "catalog");

    const writeLogs = await captureLogs(() =>
      main(["bun", "script", "--source", root, "--out-dir", outDir, "--format", "both"]),
    );
    expect(writeLogs).toEqual(["STATUS: PASS", `Wrote 1 skill cards to ${outDir}`]);
    expect(JSON.parse(await readFile(path.join(outDir, "skill-cards.json"), "utf8"))).toMatchObject({
      totalCards: 1,
    });
    expect(await readFile(path.join(outDir, "skill-cards.md"), "utf8")).toContain(
      "Total Skills: 1",
    );

    const checkLogs = await captureLogs(() =>
      main([
        "bun",
        "script",
        "--source",
        root,
        "--out-dir",
        outDir,
        "--format",
        "both",
        "--check",
      ]),
    );
    expect(checkLogs).toEqual(["STATUS: PASS", "Skill catalog is in sync (1 cards)."]);

    await writeFile(path.join(outDir, "skill-cards.md"), "stale\n");
    expect(
      main([
        "bun",
        "script",
        "--source",
        root,
        "--out-dir",
        outDir,
        "--format",
        "markdown",
        "--check",
      ]),
    ).rejects.toThrow("skill catalog out of sync");

    const jsonOnly = path.join(root, "json-only");
    await captureLogs(() =>
      main([
        "bun",
        "script",
        "--source",
        root,
        "--out-dir",
        jsonOnly,
        "--format",
        "json",
      ]),
    );
    expect(await readFile(path.join(jsonOnly, "skill-cards.json"), "utf8")).toContain(
      '"schemaVersion": 1',
    );
    await expect(readFile(path.join(jsonOnly, "skill-cards.md"), "utf8")).rejects.toThrow();
  });

  test("help returns early and required paths fail closed", async () => {
    const helpLogs = await captureLogs(() => main(["bun", "script", "--help"]));
    expect(helpLogs.join("\n")).toContain("Generate deterministic skill cards");
    expect(main(["bun", "script"])).rejects.toThrow("Missing required option: --source");
    expect(main(["bun", "script", "--source", "/tmp/source-only"])).rejects.toThrow(
      "Missing required option: --out-dir",
    );
  });
});
