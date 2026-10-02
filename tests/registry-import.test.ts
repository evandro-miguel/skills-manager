import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runRegistryExport, writeRegistryExportBundle } from "../scripts/modules/skillpool/registry-export.ts";
import {
  importRegistryBundle,
  normalizeRegistryImportArgs,
  runRegistryImport,
} from "../scripts/modules/skillpool/registry-import.ts";

const registryImportCommand = require("../scripts/commands/registry-import.ts") as typeof import("../scripts/commands/registry-import.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const repoRoot = path.resolve(__dirname, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-import-"));
  tempRoots.push(root);
  return root;
}

function exportBundle(root: string): { bundlePath: string; bundle: ReturnType<typeof runRegistryExport>["bundle"] } {
  const bundle = runRegistryExport({ source: repoRoot, strict: false }).bundle;
  const bundlePath = path.join(root, "bundle.json");
  writeRegistryExportBundle(bundlePath, bundle);
  return { bundlePath, bundle };
}

function writeBundle(root: string, bundle: ReturnType<typeof runRegistryExport>["bundle"]): string {
  const bundlePath = path.join(root, "bundle.json");
  fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundlePath;
}

describe("registry import — CLI wiring", () => {
  test("parses bundle/output and routes through the skill-sys facade", () => {
    const root = makeTempRoot();
    const bundlePath = path.join(root, "bundle.json");
    const output = path.join(root, "imported");
    const args = registryImportCommand.parseArgs(["bun", "registry-import", "--bundle", bundlePath, "--output", output, "--json", "--strict"]);

    expect(args.bundle).toBe(bundlePath);
    expect(args.output).toBe(output);
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);

    const plan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "registry-import", "--bundle", bundlePath, "--output", output, "--json", "--strict"]));
    expect(plan.argv).toEqual(["bun", path.join(repoRoot, "scripts", "commands", "registry-import.ts"), "--bundle", bundlePath, "--output", output, "--json", "--strict"]);
  });
});

describe("registry import — local deterministic adapter", () => {
  test("round-trips an export bundle into validated registry files", () => {
    const root = makeTempRoot();
    const { bundlePath, bundle } = exportBundle(root);
    const output = path.join(root, "imported");
    const result = importRegistryBundle(normalizeRegistryImportArgs({ bundle: bundlePath, output }));

    expect(result.status).toBe("PASS");
    expect(result.provenance).toBe("UNVERIFIED");
    expect(result.files).toEqual([
      "registry/advisories/security-status.json",
      "registry/index.json",
      "registry/metadata.json",
    ]);
    expect(runRegistryExport({ source: output, strict: false }).bundle).toEqual(bundle);
  });

  test("writes byte-identical outputs for repeated imports", () => {
    const root = makeTempRoot();
    const { bundlePath } = exportBundle(root);
    const firstOutput = path.join(root, "first");
    const secondOutput = path.join(root, "second");

    importRegistryBundle(normalizeRegistryImportArgs({ bundle: bundlePath, output: firstOutput }));
    importRegistryBundle(normalizeRegistryImportArgs({ bundle: bundlePath, output: secondOutput }));

    for (const relativePath of [
      "registry/advisories/security-status.json",
      "registry/index.json",
      "registry/metadata.json",
    ]) {
      expect(fs.readFileSync(path.join(firstOutput, relativePath), "utf8")).toBe(fs.readFileSync(path.join(secondOutput, relativePath), "utf8"));
    }
  });

  test("blocks remote taps instead of inventing a trust authority", () => {
    const root = makeTempRoot();
    const { bundle } = exportBundle(root);
    const bundlePath = writeBundle(root, {
      ...bundle,
      index: {
        ...bundle.index,
        taps: [{ name: "external", url: "https://example.invalid/registry", sha256: "a".repeat(64) }],
      },
    });
    const result = runRegistryImport({ bundle: bundlePath, output: path.join(root, "imported"), strict: false });

    expect(result.status).toBe("BLOCKED");
    expect(result.findings[0]?.code).toBe("REGISTRY_IMPORT_REMOTE_TAPS_UNSUPPORTED");
    expect(fs.existsSync(path.join(root, "imported"))).toBe(false);
  });

  test("blocks unverifiable signed/provenance metadata and digest drift", () => {
    const root = makeTempRoot();
    const { bundle } = exportBundle(root);
    const signedBundlePath = writeBundle(root, {
      ...bundle,
      metadata: { ...bundle.metadata, signed_provenance: { verified: true } },
    });
    const signed = runRegistryImport({ bundle: signedBundlePath, output: path.join(root, "signed-output"), strict: false });
    expect(signed.status).toBe("BLOCKED");
    expect(signed.findings[0]?.code).toBe("REGISTRY_IMPORT_PROVENANCE_UNVERIFIED");

    const drifted = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    drifted.artifacts = drifted.artifacts.map((artifact) => artifact.path === "registry/index.json" ? { ...artifact, sha256: "b".repeat(64) } : artifact);
    const driftedPath = writeBundle(root, drifted);
    const result = runRegistryImport({ bundle: driftedPath, output: path.join(root, "drifted-output"), strict: false });
    expect(result.status).toBe("BLOCKED");
    expect(result.findings[0]?.code).toBe("REGISTRY_IMPORT_DIGEST_MISMATCH");
  });

  test("rejects non-empty output directories before any registry files are written", () => {
    const root = makeTempRoot();
    const { bundlePath } = exportBundle(root);
    const output = path.join(root, "existing");
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, "keep.txt"), "unchanged\n");

    expect(() => normalizeRegistryImportArgs({ bundle: bundlePath, output })).toThrow("empty directory");
    expect(fs.readFileSync(path.join(output, "keep.txt"), "utf8")).toBe("unchanged\n");
  });
});
