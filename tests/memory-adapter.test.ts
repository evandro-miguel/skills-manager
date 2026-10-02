import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyMemoryAdapterRead,
  applyMemoryAdapterWrite,
  normalizeMemoryAdapterArgs,
  renderMemoryAdapterReadResult,
  renderMemoryAdapterResult,
  renderMemoryAdapterWriteResult,
  runMemoryAdapterValidation,
} from "../scripts/modules/skillpool/memory-adapter.ts";

const memoryAdapterCommand = require("../scripts/commands/memory-adapter.ts") as typeof import("../scripts/commands/memory-adapter.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const repoRoot = path.resolve(__dirname, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-adapter-"));
  tempRoots.push(root);
  return root;
}

function writeConfig(root: string, value: unknown, filename = ".skill-sys/memory-adapter.json"): string {
  const configPath = path.join(root, filename);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
  return configPath;
}

function writeRawConfig(root: string, content: string, filename = ".skill-sys/memory-adapter.json"): string {
  const configPath = path.join(root, filename);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, content);
  return configPath;
}

function baseConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "local-memory",
    visibility: "private",
    packageSurface: false,
    adapter: {
      type: "jsonl",
      mode: "read-only",
      path: ".skill-sys/memory/local.jsonl",
    },
    trustPolicy: {
      readOptIn: true,
      writeOptIn: false,
      allowSensitiveMemory: false,
    },
    allowedSkills: ["code-discovery"],
    ...extra,
  };
}

function readWriteConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return baseConfig({
    adapter: {
      type: "jsonl",
      mode: "read-write",
      path: ".skill-sys/memory/local.jsonl",
    },
    trustPolicy: {
      readOptIn: true,
      writeOptIn: true,
      allowSensitiveMemory: false,
    },
    ...extra,
  });
}

function adapterFilePath(root: string): string {
  return path.join(root, ".skill-sys", "memory", "local.jsonl");
}

describe("memory adapter — normalizeMemoryAdapterArgs", () => {
  test("rejects missing source or config", () => {
    expect(() => normalizeMemoryAdapterArgs({ config: "/tmp/memory.json" })).toThrow("Missing --source");
    expect(() => normalizeMemoryAdapterArgs({ source: "/tmp/source" })).toThrow("Missing --config");
  });

  test("rejects symlinked config files and accepts strict", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig());
    const link = path.join(root, "link.json");
    fs.symlinkSync(config, link);

    expect(() => normalizeMemoryAdapterArgs({ source: root, config: link })).toThrow("must not be a symlink");
    expect(normalizeMemoryAdapterArgs({ source: root, config, strict: true }).strict).toBe(true);
  });
});

describe("memory adapter — CLI wiring", () => {
  test("parseArgs normalizes config and skill-sys dispatch routes to command", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig());

    const args = memoryAdapterCommand.parseArgs(["bun", "memory-adapter", "--source", root, "--config", config, "--json", "--strict"]);
    expect(args.source).toBe(root);
    expect(args.config).toBe(config);
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);

    const plan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "memory-adapter", "--source", root, "--config", config, "--json", "--strict"]));
    expect(plan.argv).toEqual(["bun", path.join(repoRoot, "scripts", "commands", "memory-adapter.ts"), "--source", root, "--config", config, "--json", "--strict"]);
  });

  test("skill-sys dispatch forwards read/write subcommands and write options", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    const command = path.join(repoRoot, "scripts", "commands", "memory-adapter.ts");

    const readPlan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "memory-adapter", "read", "--source", root, "--config", config, "--json"]));
    expect(readPlan.argv).toEqual(["bun", command, "read", "--source", root, "--config", config, "--json"]);

    const writePlan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "memory-adapter", "write", "--source", root, "--config", config, "--id", "note-1", "--memory", "Remember this.", "--source-entry", "cli", "--dry-run"]));
    expect(writePlan.argv).toEqual(["bun", command, "write", "--source", root, "--config", config, "--id", "note-1", "--memory", "Remember this.", "--source-entry", "cli", "--dry-run"]);
  });

  test("skill-sys dispatch rejects an unknown memory-adapter subcommand", () => {
    const result = skillSys.main(["bun", "skill-sys", "memory-adapter", "bogus", "--source", ".", "--config", "x.json"], {
      cwd: repoRoot,
      stderr: () => undefined,
    });
    expect(result).toBe(1);
  });
});

describe("memory adapter — runMemoryAdapterValidation", () => {
  test("passes for private local read-only adapters with explicit trust policy", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig());

    const result = runMemoryAdapterValidation(normalizeMemoryAdapterArgs({ source: root, config }));

    expect(result.status).toBe("PASS");
    expect(result.adapterName).toBe("local-memory");
    expect(result.adapter).toEqual({ type: "jsonl", mode: "read-only", path: ".skill-sys/memory/local.jsonl" });
    expect(result.policy).toEqual({ visibility: "private", packageSurface: false, readOptIn: true, writeOptIn: false, allowSensitiveMemory: false });
    expect(result.allowedSkillCount).toBe(1);
    expect(result.findings).toEqual([]);
  });

  test("blocks public/package exposure, unsafe paths, writes without opt-in, and sensitive text", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({
      visibility: "public",
      packageSurface: true,
      adapter: { type: "sqlite", mode: "read-write", path: "docs/memory.db" },
      trustPolicy: { readOptIn: false, writeOptIn: false, allowSensitiveMemory: false },
      allowedSkills: ["bad/skill"],
      notes: "contains a password marker",
    }), "docs/memory-adapter.json");

    const result = runMemoryAdapterValidation(normalizeMemoryAdapterArgs({ source: root, config }));

    expect(result.status).toBe("BLOCKED");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "MEMORY_ADAPTER_CONFIG_PATH_UNSAFE",
      "MEMORY_ADAPTER_PACKAGE_SURFACE_FORBIDDEN",
      "MEMORY_ADAPTER_PUBLIC_FORBIDDEN",
      "MEMORY_ADAPTER_READ_OPT_IN_REQUIRED",
      "MEMORY_ADAPTER_SENSITIVE_TEXT",
      "MEMORY_ADAPTER_SKILL_INVALID",
      "MEMORY_ADAPTER_STORAGE_PATH_UNSAFE",
      "MEMORY_ADAPTER_WRITE_OPT_IN_REQUIRED",
    ]);
  });

  test("warns when no skills are allowed and strict blocks warnings", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({ allowedSkills: [] }));

    const loose = runMemoryAdapterValidation(normalizeMemoryAdapterArgs({ source: root, config }));
    const strict = runMemoryAdapterValidation(normalizeMemoryAdapterArgs({ source: root, config, strict: true }));

    expect(loose.status).toBe("CONCERNS");
    expect(strict.status).toBe("BLOCKED");
    expect(loose.findings[0]?.code).toBe("MEMORY_ADAPTER_NO_ALLOWED_SKILLS");
  });

  test("renders stable JSON and text output", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig());
    const result = runMemoryAdapterValidation(normalizeMemoryAdapterArgs({ source: root, config }));

    expect(JSON.parse(renderMemoryAdapterResult(result, "json"))).toEqual(result);
    expect(renderMemoryAdapterResult(result, "text")).toContain("STATUS: PASS");
  });

  test("characterizes runtime acceptance that is broader than the input schema", () => {
    const root = makeTempRoot();
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "schema", "memory-adapter.schema.json"),
        "utf8",
      ),
    ) as {
      additionalProperties: boolean;
      properties: {
        adapter: { additionalProperties: boolean };
        trustPolicy: { additionalProperties: boolean };
        allowedSkills: { uniqueItems: boolean };
      };
    };
    const config = writeConfig(root, baseConfig({
      runtimeOnlyField: "ignored-by-observed-validator",
      adapter: {
        type: "jsonl",
        mode: "read-only",
        path: ".skill-sys/memory/local.jsonl",
        runtimeOnlyField: "ignored",
      },
      trustPolicy: {
        readOptIn: true,
        writeOptIn: false,
        allowSensitiveMemory: false,
        runtimeOnlyField: "ignored",
      },
    }));

    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.adapter.additionalProperties).toBe(false);
    expect(schema.properties.trustPolicy.additionalProperties).toBe(false);
    expect(schema.properties.allowedSkills.uniqueItems).toBe(true);

    const result = runMemoryAdapterValidation(
      normalizeMemoryAdapterArgs({ source: root, config }),
    );
    expect(result.status).toBe("PASS");
    expect(result.findings).toEqual([]);
  });

  test("characterizes duplicate allowed skills retained and counted by runtime", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({
      allowedSkills: ["code-discovery", "code-discovery"],
    }));

    const result = runMemoryAdapterValidation(
      normalizeMemoryAdapterArgs({ source: root, config }),
    );

    expect(result.status).toBe("PASS");
    expect(result.allowedSkillCount).toBe(2);
    expect(result.findings).toEqual([]);
  });

  test("characterizes permissive defaults for package, skills, and write opt-in fields", () => {
    const root = makeTempRoot();
    const withoutPackageSurface = baseConfig();
    delete withoutPackageSurface.packageSurface;
    const cases = [
      {
        value: withoutPackageSurface,
        status: "PASS",
        count: 1,
        packageSurface: false,
        writeOptIn: false,
        codes: [],
      },
      {
        value: baseConfig({ packageSurface: "not-a-boolean" }),
        status: "PASS",
        count: 1,
        packageSurface: false,
        writeOptIn: false,
        codes: [],
      },
      {
        value: baseConfig({ allowedSkills: undefined }),
        status: "CONCERNS",
        count: 0,
        packageSurface: false,
        writeOptIn: false,
        codes: ["MEMORY_ADAPTER_NO_ALLOWED_SKILLS"],
      },
      {
        value: baseConfig({ allowedSkills: "not-an-array" }),
        status: "CONCERNS",
        count: 0,
        packageSurface: false,
        writeOptIn: false,
        codes: ["MEMORY_ADAPTER_NO_ALLOWED_SKILLS"],
      },
      {
        value: baseConfig({
          trustPolicy: {
            readOptIn: true,
            writeOptIn: "not-a-boolean",
            allowSensitiveMemory: false,
          },
        }),
        status: "PASS",
        count: 1,
        packageSurface: false,
        writeOptIn: false,
        codes: [],
      },
    ] as const;

    for (const [index, observed] of cases.entries()) {
      const config = writeConfig(
        root,
        observed.value,
        `.skill-sys/memory-adapter-${index}.json`,
      );
      const result = runMemoryAdapterValidation(
        normalizeMemoryAdapterArgs({ source: root, config }),
      );
      expect(result.status).toBe(observed.status);
      expect(result.allowedSkillCount).toBe(observed.count);
      expect(result.policy.packageSurface).toBe(observed.packageSurface);
      expect(result.policy.writeOptIn).toBe(observed.writeOptIn);
      expect(result.findings.map((finding) => finding.code)).toEqual(
        [...observed.codes],
      );
    }
  });

  test("characterizes invalid adapter type and mode as blocked safe defaults", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({
      adapter: {
        type: "unsupported",
        mode: "execute",
        path: ".skill-sys/memory/local.jsonl",
      },
    }));

    const result = runMemoryAdapterValidation(
      normalizeMemoryAdapterArgs({ source: root, config }),
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.adapter).toEqual({
      type: "jsonl",
      mode: "read-only",
      path: ".skill-sys/memory/local.jsonl",
    });
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "MEMORY_ADAPTER_MODE_INVALID",
      "MEMORY_ADAPTER_TYPE_INVALID",
    ]);
  });

  test("characterizes local path policy enforced by runtime but absent from schema", () => {
    const root = makeTempRoot();
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "schema", "memory-adapter.schema.json"),
        "utf8",
      ),
    ) as {
      properties: {
        adapter: {
          properties: {
            path: { type: string; minLength: number; pattern?: string };
          };
        };
      };
    };
    const config = writeConfig(root, baseConfig({
      adapter: {
        type: "jsonl",
        mode: "read-only",
        path: "public/memory.jsonl",
      },
    }));

    expect(schema.properties.adapter.properties.path).toEqual({
      type: "string",
      minLength: 1,
    });

    const result = runMemoryAdapterValidation(
      normalizeMemoryAdapterArgs({ source: root, config }),
    );
    expect(result.status).toBe("BLOCKED");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "MEMORY_ADAPTER_STORAGE_PATH_UNSAFE",
    ]);
  });
});

describe("memory adapter — JSONL read", () => {
  test("reads records back with id/memory/source/createdAt and never throws on malformed lines", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    const file = adapterFilePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const valid = { id: "note-1", memory: "Use Bun for local validation.", source: "local", createdAt: "2026-08-15T00:00:00.000Z" };
    fs.writeFileSync(file, `${JSON.stringify(valid)}\nnot-json\n{"id":"missing-fields"}\n\n`);

    const result = applyMemoryAdapterRead(normalizeMemoryAdapterArgs({ source: root, config }));

    expect(result.status).toBe("read");
    expect(result.operation).toBe("read");
    expect(result.entryCount).toBe(1);
    expect(result.entries).toEqual([valid]);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "MEMORY_ADAPTER_INVALID_RECORD",
      "MEMORY_ADAPTER_MALFORMED_LINE",
    ]);
    expect(result.findings.every((finding) => finding.level === "WARN")).toBe(true);
  });

  test("returns an empty read result when the JSONL file does not exist", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());

    const result = applyMemoryAdapterRead(normalizeMemoryAdapterArgs({ source: root, config }));

    expect(result.status).toBe("read");
    expect(result.entryCount).toBe(0);
    expect(result.entries).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  test("blocks a read through a symlinked storage directory", () => {
    const root = makeTempRoot();
    const outside = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    fs.writeFileSync(path.join(outside, "local.jsonl"), `${JSON.stringify({ id: "outside", memory: "Outside.", source: "local", createdAt: "2026-08-15T00:00:00.000Z" })}\n`);
    fs.symlinkSync(outside, path.join(root, ".skill-sys", "memory"), "dir");

    const result = applyMemoryAdapterRead(normalizeMemoryAdapterArgs({ source: root, config }));

    expect(result.status).toBe("blocked");
    expect(result.entries).toEqual([]);
    expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_STORAGE_PATH_UNSAFE"]);
  });

  test("blocks persisted records containing secret-looking text", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    const file = adapterFilePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ id: "secret", memory: "api key must not be returned", source: "local", createdAt: "2026-08-15T00:00:00.000Z" })}\n`);

    const result = applyMemoryAdapterRead(normalizeMemoryAdapterArgs({ source: root, config }));

    expect(result.status).toBe("blocked");
    expect(result.entries).toEqual([]);
    expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_SENSITIVE_RECORD"]);
  });

  test("read is blocked without read opt-in", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({
      trustPolicy: { readOptIn: false, writeOptIn: false, allowSensitiveMemory: false },
    }));

    const result = applyMemoryAdapterRead(normalizeMemoryAdapterArgs({ source: root, config }));

    expect(result.status).toBe("blocked");
    expect(result.entryCount).toBe(0);
    expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_READ_OPT_IN_REQUIRED"]);
  });

  test("read is blocked for non-jsonl adapter types", () => {
    const root = makeTempRoot();
    for (const type of ["sqlite", "mcp"] as const) {
      const config = writeConfig(root, baseConfig({
        adapter: { type, mode: "read-only", path: ".skill-sys/memory/local.store" },
      }), `.skill-sys/memory-adapter-${type}.json`);

      const result = applyMemoryAdapterRead(normalizeMemoryAdapterArgs({ source: root, config }));

      expect(result.status).toBe("blocked");
      expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_TYPE_UNSUPPORTED"]);
    }
  });

  test("read respects a blocked validation result", () => {
    const root = makeTempRoot();
    const config = writeRawConfig(root, "{ invalid json\n");

    const result = applyMemoryAdapterRead(normalizeMemoryAdapterArgs({ source: root, config }));

    expect(result.status).toBe("blocked");
    expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_INVALID_JSON"]);
  });

  test("read failures return blocked with MEMORY_ADAPTER_READ_FAILED and never throw", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());

    const result = applyMemoryAdapterRead(
      normalizeMemoryAdapterArgs({ source: root, config }),
      { readFile: () => {
        throw new Error("simulated read failure");
      } },
    );

    expect(result.status).toBe("blocked");
    expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_READ_FAILED"]);
  });

  test("renders stable read result JSON and text output", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    const file = adapterFilePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ id: "note-1", memory: "Text.", source: "local", createdAt: "2026-08-15T00:00:00.000Z" })}\n`);

    const result = applyMemoryAdapterRead(normalizeMemoryAdapterArgs({ source: root, config }));

    expect(JSON.parse(renderMemoryAdapterReadResult(result, "json"))).toEqual(result);
    expect(renderMemoryAdapterReadResult(result, "text")).toContain("STATUS: READ");
  });
});

describe("memory adapter — JSONL write", () => {
  test("writes a record and reads it back with id/memory/source/createdAt", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    const input = normalizeMemoryAdapterArgs({ source: root, config });

    const writeResult = applyMemoryAdapterWrite(input, { id: "note-1", memory: "Use Bun for local validation.", source: "local" });

    expect(writeResult.status).toBe("written");
    expect(writeResult.written).toBe(true);
    expect(writeResult.operation).toBe("write");
    expect(writeResult.id).toBe("note-1");
    expect(writeResult.entryCount).toBe(1);
    expect(writeResult.findings).toEqual([]);
    expect(writeResult.output.endsWith("\n")).toBe(true);
    const written = JSON.parse(writeResult.output) as { id: string; memory: string; source: string; createdAt: string };
    expect(written).toEqual({
      id: "note-1",
      memory: "Use Bun for local validation.",
      source: "local",
      createdAt: written.createdAt,
    });
    expect(typeof written.createdAt).toBe("string");
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(written.createdAt)).toBe(true);
    expect(fs.readFileSync(adapterFilePath(root), "utf8")).toBe(writeResult.output);
    expect(fs.readdirSync(path.dirname(adapterFilePath(root))).some((name) => name.startsWith(".tmp-"))).toBe(false);

    const readResult = applyMemoryAdapterRead(input);
    expect(readResult.status).toBe("read");
    expect(readResult.entryCount).toBe(1);
    expect(readResult.entries).toEqual([written]);
    expect(readResult.findings).toEqual([]);
  });

  test("appends to existing records and counts them", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    const input = normalizeMemoryAdapterArgs({ source: root, config });
    const first = applyMemoryAdapterWrite(input, { id: "first", memory: "First.", source: "local" });
    expect(first.status).toBe("written");

    const second = applyMemoryAdapterWrite(input, { id: "second", memory: "Second.", source: "cli" });

    expect(second.status).toBe("written");
    expect(second.entryCount).toBe(2);
    const readResult = applyMemoryAdapterRead(input);
    expect(readResult.entries.map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(readResult.entries[1]?.source).toBe("cli");
  });

  test("write is blocked for read-only mode and writes nothing", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig());

    const result = applyMemoryAdapterWrite(
      normalizeMemoryAdapterArgs({ source: root, config }),
      { id: "x", memory: "y", source: "local" },
    );

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_WRITE_MODE_REQUIRED"]);
    expect(fs.existsSync(adapterFilePath(root))).toBe(false);
  });

  test("write is blocked without write opt-in", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({
      adapter: { type: "jsonl", mode: "read-write", path: ".skill-sys/memory/local.jsonl" },
    }));

    const result = applyMemoryAdapterWrite(
      normalizeMemoryAdapterArgs({ source: root, config }),
      { id: "x", memory: "y", source: "local" },
    );

    expect(result.status).toBe("blocked");
    expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_WRITE_OPT_IN_REQUIRED"]);
    expect(fs.existsSync(adapterFilePath(root))).toBe(false);
  });

  test("secret-looking memory is blocked with MEMORY_ADAPTER_SENSITIVE_TEXT", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());

    const result = applyMemoryAdapterWrite(
      normalizeMemoryAdapterArgs({ source: root, config }),
      { id: "leaky", memory: "contains a password marker", source: "local" },
    );

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_SENSITIVE_TEXT"]);
    expect(fs.existsSync(adapterFilePath(root))).toBe(false);
  });

  test("unsafe id, empty memory, or empty source are blocked", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    const input = normalizeMemoryAdapterArgs({ source: root, config });

    const badId = applyMemoryAdapterWrite(input, { id: "Bad Id!", memory: "Fine.", source: "local" });
    expect(badId.status).toBe("blocked");
    expect(badId.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_ID_INVALID"]);

    const emptyMemory = applyMemoryAdapterWrite(input, { id: "empty-memory", memory: "   ", source: "local" });
    expect(emptyMemory.status).toBe("blocked");
    expect(emptyMemory.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_MEMORY_INVALID"]);

    const emptySource = applyMemoryAdapterWrite(input, { id: "empty-source", memory: "Fine.", source: "   " });
    expect(emptySource.status).toBe("blocked");
    expect(emptySource.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_SOURCE_INVALID"]);
  });

  test("dry-run write leaves the JSONL file unchanged", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    const input = normalizeMemoryAdapterArgs({ source: root, config });
    const seeded = applyMemoryAdapterWrite(input, { id: "seed", memory: "Seeded.", source: "local" });
    expect(seeded.status).toBe("written");
    const before = fs.readFileSync(adapterFilePath(root), "utf8");

    const result = applyMemoryAdapterWrite(input, { id: "dry-run-id", memory: "Not written.", source: "local" }, { dryRun: true });

    expect(result.status).toBe("dry-run");
    expect(result.written).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.entryCount).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({ id: "dry-run-id" });
    expect(fs.readFileSync(adapterFilePath(root), "utf8")).toBe(before);
  });

  test("atomic-write failure returns blocked with MEMORY_ADAPTER_WRITE_FAILED and no temp residue", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    const file = adapterFilePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ id: "seed", memory: "Seeded.", source: "local", createdAt: "2026-08-15T00:00:00.000Z" })}\n`);
    fs.linkSync(file, path.join(root, "second-link.jsonl"));
    const before = fs.readFileSync(file, "utf8");

    const result = applyMemoryAdapterWrite(
      normalizeMemoryAdapterArgs({ source: root, config }),
      { id: "new", memory: "Boom.", source: "local" },
    );

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_WRITE_FAILED"]);
    expect(result.findings[0]?.message).toContain("Refusing to overwrite hardlinked target");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith(".tmp-"))).toBe(false);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  test("write aborts when another writer holds the adapter lock", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    const file = adapterFilePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ id: "seed", memory: "Seeded.", source: "local", createdAt: "2026-08-15T00:00:00.000Z" })}\n`);
    const before = fs.readFileSync(file, "utf8");
    fs.writeFileSync(`${file}.lock`, `${JSON.stringify({ pid: process.pid, timestamp: Date.now() })}\n`);

    const result = applyMemoryAdapterWrite(
      normalizeMemoryAdapterArgs({ source: root, config }),
      { id: "concurrent", memory: "Lost update?", source: "local" },
    );

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_WRITE_FAILED"]);
    expect(result.findings[0]?.message).toContain("locked by another writer");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
  });

  test("write is blocked for non-jsonl adapter types", () => {
    const root = makeTempRoot();
    for (const type of ["sqlite", "mcp"] as const) {
      const config = writeConfig(root, baseConfig({
        adapter: { type, mode: "read-write", path: ".skill-sys/memory/local.store" },
        trustPolicy: { readOptIn: true, writeOptIn: true, allowSensitiveMemory: false },
      }), `.skill-sys/memory-adapter-${type}.json`);

      const result = applyMemoryAdapterWrite(
        normalizeMemoryAdapterArgs({ source: root, config }),
        { id: "x", memory: "y", source: "local" },
      );

      expect(result.status).toBe("blocked");
      expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_TYPE_UNSUPPORTED"]);
    }
  });

  test("write respects a blocked validation result", () => {
    const root = makeTempRoot();
    const config = writeRawConfig(root, "{ invalid json\n");

    const result = applyMemoryAdapterWrite(
      normalizeMemoryAdapterArgs({ source: root, config }),
      { id: "x", memory: "y", source: "local" },
    );

    expect(result.status).toBe("blocked");
    expect(result.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_INVALID_JSON"]);
  });

  test("renders stable write result JSON and dry-run text output", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, readWriteConfig());
    const input = normalizeMemoryAdapterArgs({ source: root, config });

    const written = applyMemoryAdapterWrite(input, { id: "note-1", memory: "Text.", source: "local" });
    expect(JSON.parse(renderMemoryAdapterWriteResult(written, "json"))).toEqual(written);
    expect(renderMemoryAdapterWriteResult(written, "text")).toContain("STATUS: WRITTEN");

    const dryRun = applyMemoryAdapterWrite(input, { id: "dry", memory: "Dry.", source: "local" }, { dryRun: true });
    expect(renderMemoryAdapterWriteResult(dryRun, "text")).toContain("STATUS: DRY-RUN");
    expect(renderMemoryAdapterWriteResult(dryRun, "text")).toContain("Output:");
  });
});
