import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildProjections, validateProjections } from "../scripts/modules/skillpool/projections.ts";

describe("projection lifecycle selection", () => {
  let root: string;
  let sourceRoot: string;
  let outDir: string;
  let userRoot: string;

  beforeEach(() => {
    const scratch = path.resolve(".tmp/projection-lifecycle-tests");
    fs.mkdirSync(scratch, { recursive: true });
    root = fs.mkdtempSync(path.join(scratch, "case-"));
    sourceRoot = path.join(root, "source");
    outDir = path.join(root, "out");
    userRoot = path.join(root, "user");
    fs.cpSync(path.resolve("examples/minimal-skillpack"), sourceRoot, { recursive: true });
    fs.cpSync(path.resolve("providers"), path.join(sourceRoot, "providers"), { recursive: true });
    fs.mkdirSync(path.join(userRoot, "skills"), { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function writeSkill(name: string, frontmatter: string, skillRoot = sourceRoot): string {
    const dir = path.join(skillRoot, "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing lifecycle selection.\n${frontmatter}\n---\n# Lifecycle fixture\n`);
    return dir;
  }

  const providers = ["codex", "claude-code", "opencode"] as const;

  test.each([
    "deprecated: true", "archived: true", "compatibility_only: true", "category: compatibility",
    "metadata:\n  deprecated: true", "metadata:\n  archived: true",
    "metadata:\n  compatibility_only: 'yes'", "metadata:\n  category: compatibility",
  ])("omits %s from public and user projections without removing source", (frontmatter) => {
    const publicDir = writeSkill("retained-public", frontmatter);
    const userDir = writeSkill("retained-user", frontmatter, userRoot);
    writeSkill("active-user", "deprecated: false", userRoot);
    const result = buildProjections({ sourceRoot, outDir, providers: [...providers], clean: true, includeUser: true, userRoot });
    expect(result.projections.map((r) => r.skill)).not.toContain("retained-public");
    expect(result.projections.map((r) => r.skill)).not.toContain("retained-user");
    expect(result.projections).toHaveLength(6);
    for (const provider of providers) {
      expect(fs.existsSync(path.join(outDir, provider, "retained-public"))).toBe(false);
      expect(fs.existsSync(path.join(outDir, provider, "retained-user"))).toBe(false);
    }
    expect(validateProjections({ sourceRoot, outDir, providers: [...providers], includeUser: true, userRoot })).toEqual([]);
    expect(fs.existsSync(path.join(publicDir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(userDir, "SKILL.md"))).toBe(true);
  });

  test("honors skill.meta.json lifecycle while preserving experimental skills", () => {
    const retiredDir = writeSkill("retired", "");
    const activeDir = writeSkill("experimental", "deprecated: false\nmetadata:\n  compatibility_only: false");
    const template = JSON.parse(fs.readFileSync(path.join(sourceRoot, "skills/example-skill/skill.meta.json"), "utf8"));
    fs.writeFileSync(path.join(retiredDir, "skill.meta.json"), JSON.stringify({ ...template, name: "retired", lifecycle: "deprecated" }));
    fs.writeFileSync(path.join(activeDir, "skill.meta.json"), JSON.stringify({ ...template, name: "experimental", lifecycle: "experimental" }));
    const result = buildProjections({ sourceRoot, outDir, providers: ["codex"], clean: true });
    expect(result.projections.map((r) => r.skill)).toEqual(["example-skill", "experimental"]);
  });

  test("a clean cached rebuild drops newly retired content and validation rejects old output", () => {
    const dir = writeSkill("later-retired", "");
    const store = path.join(root, "store");
    buildProjections({ sourceRoot, outDir, providers: ["codex"], clean: true, projectionStoreDir: store });
    const oldFile = path.join(outDir, "codex/later-retired/SKILL.md");
    const oldContent = fs.readFileSync(oldFile, "utf8");
    writeSkill("later-retired", "metadata:\n  category: compatibility");
    expect(validateProjections({ sourceRoot, outDir, providers: ["codex"] }).length).toBeGreaterThan(0);
    expect(() => buildProjections({ sourceRoot, outDir, providers: ["codex"], clean: false })).toThrow("--clean");
    expect(fs.readFileSync(oldFile, "utf8")).toBe(oldContent);
    const result = buildProjections({ sourceRoot, outDir, providers: ["codex"], clean: true, projectionStoreDir: store });
    expect(result.projections.map((r) => r.skill)).toEqual(["example-skill"]);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(path.join(dir, "SKILL.md"))).toBe(true);
    expect(validateProjections({ sourceRoot, outDir, providers: ["codex"] })).toEqual([]);
  });

  test.each(["SKILL.md", "skill.meta.json"])("rejects symlinked %s before eligibility reads", (name) => {
    const dir = writeSkill("unsafe", "metadata:\n  category: compatibility");
    const target = path.join(root, "outside-fixture");
    fs.writeFileSync(target, "not metadata");
    fs.rmSync(path.join(dir, name), { force: true });
    fs.symlinkSync(target, path.join(dir, name));
    expect(() => buildProjections({ sourceRoot, outDir, providers: ["codex"], clean: true })).toThrow(/symlink/i);
  });

  test("retired public names do not collide with active user skills", () => {
    writeSkill("same-name", "deprecated: true");
    writeSkill("same-name", "deprecated: false", userRoot);
    const result = buildProjections({ sourceRoot, outDir, providers: ["codex"], clean: true, includeUser: true, userRoot });
    expect(result.projections.find((r) => r.skill === "same-name")?.origin).toBe("user");
  });

  test("prunes an unchanged retired user projection without removing its source", () => {
    const sourceDir = writeSkill("private-skill", "", userRoot);
    const options = { sourceRoot, outDir, providers: ["codex"] as ["codex"], includeUser: true, userRoot };
    buildProjections({ ...options, clean: true });
    writeSkill("private-skill", "deprecated: true", userRoot);
    const result = buildProjections({ ...options, clean: false });
    expect(result.projections.map((record) => record.skill)).not.toContain("private-skill");
    expect(fs.existsSync(path.join(outDir, "codex/private-skill"))).toBe(false);
    expect(fs.existsSync(path.join(sourceDir, "SKILL.md"))).toBe(true);
    expect(validateProjections(options)).toEqual([]);
  });

  test("does not prune manual edits when a user skill becomes retired", () => {
    writeSkill("private-skill", "", userRoot);
    const options = { sourceRoot, outDir, providers: ["codex"] as ["codex"], includeUser: true, userRoot };
    buildProjections({ ...options, clean: true });
    const manualFile = path.join(outDir, "codex/private-skill/manual-note.txt");
    fs.writeFileSync(manualFile, "Keep this manual content.");
    writeSkill("private-skill", "deprecated: true", userRoot);
    expect(() => buildProjections({ ...options, clean: false })).toThrow(/modified/i);
    expect(fs.readFileSync(manualFile, "utf8")).toBe("Keep this manual content.");
  });
});
