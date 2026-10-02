import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bumpPatch,
  cloneParsedFrontmatter,
  formatCsv,
  isValidSemver,
  isValidUtcIso,
  listSkillDirs,
  normalizeManagedMetadata,
  normalizeProviderId,
  normalizeProviderList,
  normalizeSemverLoose,
  orderedMetadataKeys,
  orderedTopKeys,
  parseCsv,
  parseFrontmatter,
  quoteFrontmatterScalarIfNeeded,
  serializeFrontmatter,
  stripManagedMetadata,
  stripQuotes,
  toUtcIso,
  validateFrontmatterScalarSyntax,
  yamlQuote,
} from "../scripts/modules/skill-metadata-lib.ts";

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

describe("markdown/frontmatter metadata helpers", () => {
  test("CSV, quoting, provider, semver, and UTC helpers normalize scalar metadata", () => {
    expect(stripQuotes(" 'alpha' ")).toBe("alpha");
    expect(yamlQuote('a "quoted" value')).toBe('"a \'quoted\' value"');
    expect(parseCsv("codex, 'opencode', , codex")).toEqual(["codex", "opencode", "codex"]);
    expect(formatCsv(["codex", "", "opencode", "codex"])).toBe("codex, opencode");
    expect(normalizeProviderId("'codex'")).toBe("codex");
    expect(normalizeProviderId("unknown")).toBeNull();
    expect(normalizeProviderList("universal, codex, qwen, codex", { exclude: ["qwen"] })).toEqual(["codex"]);
    expect(normalizeProviderList("universal, codex", { allowUniversal: true })).toEqual(["universal", "codex"]);
    expect(normalizeSemverLoose("v2")).toBe("2.0.0");
    expect(normalizeSemverLoose("2.3")).toBe("2.3.0");
    expect(normalizeSemverLoose("2.3.4")).toBe("2.3.4");
    expect(normalizeSemverLoose("2.x")).toBeNull();
    expect(isValidSemver("2.3.4")).toBe(true);
    expect(bumpPatch("2.3.4")).toBe("2.3.5");
    expect(bumpPatch("bad")).toBeNull();
    expect(toUtcIso("2026-06-08T01:02:03.000Z")).toBe("2026-06-08T01:02:03Z");
    expect(toUtcIso("not a date")).toBeNull();
    expect(toUtcIso(null)).toBeNull();
    expect(isValidUtcIso("2026-06-08T01:02:03Z")).toBe(true);
  });

  test("frontmatter parser rejects missing delimiters and unsafe unquoted colon scalars", () => {
    expect(parseFrontmatter("# nope")).toEqual({ ok: false, error: "missing YAML frontmatter" });
    expect(parseFrontmatter("---\nname: alpha\n")).toEqual({ ok: false, error: "missing closing frontmatter delimiter" });
    const scalarErrors = validateFrontmatterScalarSyntax([
      "description: Use when alpha: beta",
      "metadata:",
      "  tags: alpha: beta",
      "  triggers: 'unterminated",
    ]);
    expect(scalarErrors).toContain("description contains ': ' and must be quoted");
    expect(scalarErrors).toContain("metadata.tags contains ': ' and must be quoted");
    expect(scalarErrors).toContain("metadata.triggers quoted scalar must close with '");
    expect(parseFrontmatter("---\ndescription: Use when alpha: beta\n---\n# Body").ok).toBe(false);
  });

  test("frontmatter parser, ordering, serialization, clone, and managed metadata preserve behavior", () => {
    const parsed = parseFrontmatter(`---
description: "Use when alpha: beta"
name: alpha
extra: kept
metadata:
  triggers: trigger
  tags: tag
  target_provider: codex
  compatible_providers: opencode, codex, qwen
  version: v1.2
  updated_at: 2026-06-08T01:02:03.000Z
  created_on: old
  custom: value
---
# Body
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);

    expect(orderedTopKeys(parsed.topOrder, parsed.top)).toEqual(["name", "description", "extra"]);
    expect(orderedMetadataKeys(parsed.metadataOrder, parsed.metadata).slice(0, 6)).toEqual([
      "tags",
      "triggers",
      "version",
      "updated_at",
      "target_provider",
      "compatible_providers",
    ]);

    const normalized = normalizeManagedMetadata(parsed.metadata, {
      defaultProvider: "universal",
      compatibleProviders: "opencode, qwen, codex",
    });
    expect(normalized.version).toBe("1.2.0");
    expect(normalized.updated_at).toBe("2026-06-08T01:02:03Z");
    expect(normalized.target_provider).toBe("codex");
    expect(normalized.compatible_providers).toBe("opencode, qwen");
    expect(normalized.created_on).toBeUndefined();

    const clone = cloneParsedFrontmatter({ ...parsed, metadata: normalized });
    expect(clone).not.toBe(parsed);
    expect(clone.metadata).toEqual(normalized);

    const stripped = stripManagedMetadata({ ...parsed, metadata: normalized });
    expect(stripped.metadata.version).toBeUndefined();
    expect(stripped.metadata.updated_at).toBeUndefined();
    expect(stripped.metadata.target_provider).toBeUndefined();
    expect(stripped.metadata.compatible_providers).toBeUndefined();

    const serialized = serializeFrontmatter({ ...parsed, metadata: normalized, body: "# Body\n" });
    expect(serialized).toContain('description: "Use when alpha: beta"');
    expect(serialized).toContain('  tags: "tag"');
    expect(serialized).toContain('  compatible_providers: "opencode, qwen"');
    expect(serialized).toContain("# Body");
  });

  test("quoteFrontmatterScalarIfNeeded only quotes scalars that need YAML protection", () => {
    expect(quoteFrontmatterScalarIfNeeded("plain")).toBe("plain");
    expect(quoteFrontmatterScalarIfNeeded('"already"')).toBe('"already"');
    expect(quoteFrontmatterScalarIfNeeded("Use when a: b")).toBe('"Use when a: b"');
    expect(serializeFrontmatter({ top: { name: "alpha" }, metadata: {}, body: "" })).toBe("---\nname: alpha\nmetadata:\n---\n");
  });

  test("listSkillDirs returns sorted real skill directories only", () => {
    const root = tempRoot("metadata-list-skills");
    fs.mkdirSync(path.join(root, "beta"), { recursive: true });
    fs.writeFileSync(path.join(root, "beta", "SKILL.md"), "# Beta\n");
    fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
    fs.writeFileSync(path.join(root, "alpha", "SKILL.md"), "# Alpha\n");
    fs.mkdirSync(path.join(root, "missing-md"), { recursive: true });

    expect(listSkillDirs(path.join(root, "missing"))).toEqual([]);
    expect(listSkillDirs(root)).toEqual([path.join(root, "alpha"), path.join(root, "beta")]);
  });
});
