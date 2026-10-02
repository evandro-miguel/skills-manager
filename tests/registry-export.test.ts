import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  renderRegistryExportResult,
  runRegistryExport,
  writeRegistryExportBundle,
} from "../scripts/modules/skillpool/registry-export.ts";

const registryExportCommand = require("../scripts/commands/registry-export.ts") as typeof import("../scripts/commands/registry-export.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const repoRoot = path.resolve(__dirname, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-export-"));
  tempRoots.push(root);
  return root;
}

describe("registry export — CLI wiring", () => {
  test("parseArgs normalizes source/output and skill-sys dispatch routes to command", () => {
    const output = path.join(repoRoot, ".tmp", "registry-export-test.json");
    const args = registryExportCommand.parseArgs(["bun", "registry-export", "--source", repoRoot, "--output", output, "--json", "--strict"]);
    expect(args.source).toBe(repoRoot);
    expect(args.output).toBe(output);
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);

    const plan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "registry-export", "--source", repoRoot, "--output", output, "--json", "--strict"]));
    expect(plan.argv).toEqual(["bun", path.join(repoRoot, "scripts", "commands", "registry-export.ts"), "--source", repoRoot, "--output", output, "--json", "--strict"]);
  });
});

describe("registry export — runRegistryExport", () => {
  test("emits a deterministic read-only export bundle for the public registry surface", () => {
    const before = fs.readdirSync(path.join(repoRoot, "registry"), { recursive: true }).map(String).sort();
    const first = runRegistryExport({ source: repoRoot, strict: false });
    const second = runRegistryExport({ source: repoRoot, strict: false });
    const after = fs.readdirSync(path.join(repoRoot, "registry"), { recursive: true }).map(String).sort();

    expect(first.status).toBe("PASS");
    expect(first.bundle.format).toBe("skill-sys-registry-export");
    expect(first.bundle.artifacts.map((artifact) => artifact.path)).toEqual([
      "registry/advisories/security-status.json",
      "registry/index.json",
      "registry/metadata.json",
    ]);
    expect(first.bundle.index.channels).toEqual({});
    expect(first.bundle.channels).toEqual({});
    expect(first.findings).toEqual([]);
    expect(renderRegistryExportResult(first, "json")).toBe(renderRegistryExportResult(second, "json"));
    expect(after).toEqual(before);
  });

  test("fails closed when the registry surface is missing", () => {
    const root = makeTempRoot();
    expect(() => runRegistryExport({ source: root, strict: false })).toThrow("Missing registry surface file");
  });

  test("renders stable JSON and text output", () => {
    const result = runRegistryExport({ source: repoRoot, strict: false });

    expect(JSON.parse(renderRegistryExportResult(result, "json"))).toEqual(result);
    expect(renderRegistryExportResult(result, "text")).toContain("STATUS: PASS");
  });

  test("writes the portable bundle atomically without changing the source registry", () => {
    const root = makeTempRoot();
    const output = path.join(root, "nested", "registry-bundle.json");
    const result = runRegistryExport({ source: repoRoot, strict: false });

    expect(writeRegistryExportBundle(output, result.bundle)).toBe(output);
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual(result.bundle);
    expect(fs.readdirSync(path.dirname(output)).some((name) => name.startsWith(".tmp-"))).toBe(false);
  });
});
