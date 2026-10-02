#!/usr/bin/env bun
/** Deterministic, local-only discovery across roots and plugin manifests. */
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../modules/skill-metadata-lib.ts";

type PluginManifest = { schemaVersion: 1; roots?: unknown; plugins?: unknown };
type Skill = { name: string; path: string; category: string };

function safeRelative(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return value;
}

function manifestRoots(file: string): string[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PluginManifest;
  if (!raw || raw.schemaVersion !== 1 || !Object.keys(raw).every((key) => key === "schemaVersion" || key === "roots" || key === "plugins")) {
    throw new Error("Plugin manifest must use schemaVersion 1 and known fields only");
  }
  if (!Array.isArray(raw.roots ?? []) || !Array.isArray(raw.plugins ?? [])) throw new Error("Plugin manifest roots and plugins must be arrays");
  const rootEntries = raw.roots as unknown[];
  const pluginEntries = raw.plugins as unknown[];
  const entries = [...rootEntries, ...pluginEntries];
  return entries.map((entry, index) => safeRelative(entry, `plugin manifest entry ${index}`));
}

function assertRoot(root: string): void {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Discovery root must be a real directory: ${root}`);
}

function collect(root: string, cwd: string): Skill[] {
  assertRoot(root);
  const skills: Skill[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlink during discovery: ${child}`);
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(child, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        if (fs.lstatSync(skillFile).isSymbolicLink()) throw new Error(`Refusing symlinked skill file: ${skillFile}`);
        const parsed = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
        if (parsed.ok) skills.push({ name: parsed.top.name || entry.name, path: path.relative(cwd, child).replaceAll("\\", "/"), category: parsed.metadata.category || "" });
        continue;
      }
      visit(child);
    }
  };
  visit(root);
  return skills;
}

function main(argv = process.argv): void {
  const cwd = process.cwd();
  const roots: string[] = [];
  let json = false;
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") { json = true; continue; }
    if (token === "--root" || token === "--plugin-manifest") {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${token}`);
      if (token === "--root") roots.push(path.resolve(cwd, value));
      else {
        const manifest = path.resolve(cwd, value);
        if (fs.lstatSync(manifest).isSymbolicLink()) throw new Error(`Refusing symlinked plugin manifest: ${manifest}`);
        const base = path.dirname(manifest);
        roots.push(...manifestRoots(manifest).map((root) => path.resolve(base, root)));
      }
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  if (!roots.length) throw new Error("At least one --root or --plugin-manifest is required");
  const byName = new Map<string, Skill>();
  for (const root of roots.sort()) for (const skill of collect(root, cwd)) {
    if (byName.has(skill.name)) throw new Error(`Duplicate discovered skill name: ${skill.name}`);
    byName.set(skill.name, skill);
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  console.log(json ? JSON.stringify(skills, null, 2) : skills.map((skill) => `${skill.name}\t${skill.category}\t${skill.path}`).join("\n"));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } }
export { collect, main, manifestRoots };
