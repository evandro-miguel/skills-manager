import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const command = path.resolve(__dirname, "../scripts/commands/discover-skills.ts");
const roots: string[] = [];

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f09-discovery-"));
  roots.push(root);
  for (const [relative, name, category] of [
    ["skills/alpha", "alpha", "docs"],
    ["categories/ops/beta", "beta", "ops"],
    ["plugins/acme/skills/gamma", "gamma", "plugin"],
  ] as const) {
    const dir = path.join(root, relative);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when ${name}\nmetadata:\n  category: ${category}\n---\n`);
  }
  fs.writeFileSync(path.join(root, "plugins.json"), JSON.stringify({ schemaVersion: 1, roots: ["skills", "categories"], plugins: ["plugins/acme/skills"] }));
  return root;
}

function run(root: string, args: string[]) {
  return Bun.spawnSync({ cmd: ["bun", command, ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
}

describe("F-09 multi-root and plugin-manifest discovery", () => {
  test("discovers category and plugin roots in deterministic order", () => {
    const root = fixture();
    const result = run(root, ["--plugin-manifest", "plugins.json", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(Buffer.from(result.stdout).toString("utf8"))).toEqual([
      { name: "alpha", path: "skills/alpha", category: "docs" },
      { name: "beta", path: "categories/ops/beta", category: "ops" },
      { name: "gamma", path: "plugins/acme/skills/gamma", category: "plugin" },
    ]);
  });

  test("rejects unsafe plugin paths and duplicate identities", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "unsafe.json"), JSON.stringify({ schemaVersion: 1, roots: ["../outside"] }));
    expect(run(root, ["--plugin-manifest", "unsafe.json"]).exitCode).toBe(1);
    fs.mkdirSync(path.join(root, "second", "alpha"), { recursive: true });
    fs.copyFileSync(path.join(root, "skills", "alpha", "SKILL.md"), path.join(root, "second", "alpha", "SKILL.md"));
    expect(Buffer.from(run(root, ["--root", "skills", "--root", "second"]).stderr).toString("utf8")).toContain("Duplicate discovered skill name");
  });
});
