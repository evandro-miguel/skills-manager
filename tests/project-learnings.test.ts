import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyProjectLearningsAppend,
  applyProjectLearningsUpdate,
  normalizeProjectLearningsArgs,
  renderProjectLearningsResult,
  runProjectLearningsValidation,
} from "../scripts/modules/skillpool/project-learnings.ts";
import { validateAgainstSubset } from "./helpers/json-schema-subset.ts";

const projectLearningsCommand = require("../scripts/commands/project-learnings.ts") as typeof import("../scripts/commands/project-learnings.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const repoRoot = path.resolve(__dirname, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-learnings-"));
  tempRoots.push(root);
  return root;
}

function writeLearnings(root: string, value: unknown, filename = ".skill-sys/project-learnings.json"): string {
  const learningsPath = path.join(root, filename);
  fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
  fs.writeFileSync(learningsPath, `${JSON.stringify(value, null, 2)}\n`);
  return learningsPath;
}

function baseLearnings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "local-learnings",
    visibility: "private",
    packageSurface: false,
    entries: [{ id: "use-bun", summary: "Use Bun scripts for local validation.", source: "local", tags: ["workflow"] }],
    ...extra,
  };
}

function sensitiveTrigger(): string {
  return ["pass", "word"].join("");
}

function findConfirmedDeadPid(): number {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = spawnSync("true");
    if (typeof result.pid === "number") {
      try {
        process.kill(result.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          return result.pid;
        }
      }
    }
  }
  throw new Error("Unable to obtain a confirmed-dead PID for stale lock testing");
}

describe("project learnings — normalizeProjectLearningsArgs", () => {
  test("rejects missing source or learnings", () => {
    expect(() => normalizeProjectLearningsArgs({ learnings: "/tmp/learnings.json" })).toThrow("Missing --source");
    expect(() => normalizeProjectLearningsArgs({ source: "/tmp/source" })).toThrow("Missing --learnings");
  });

  test("rejects symlinked learnings files and accepts strict", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const link = path.join(root, "link.json");
    fs.symlinkSync(learnings, link);

    expect(() => normalizeProjectLearningsArgs({ source: root, learnings: link })).toThrow("must not be a symlink");
    expect(normalizeProjectLearningsArgs({ source: root, learnings, strict: true }).strict).toBe(true);
  });
});

describe("project learnings — CLI wiring", () => {
  test("parseArgs normalizes learnings and skill-sys dispatch routes to command", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());

    const args = projectLearningsCommand.parseArgs(["bun", "project-learnings", "--source", root, "--learnings", learnings, "--json", "--strict"]);
    expect(args.source).toBe(root);
    expect(args.learnings).toBe(learnings);
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);

    const plan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "project-learnings", "--source", root, "--learnings", learnings, "--json", "--strict"]));
    expect(plan.argv).toEqual(["bun", path.join(repoRoot, "scripts", "commands", "project-learnings.ts"), "--source", root, "--learnings", learnings, "--json", "--strict"]);
  });
});

describe("project learnings — runProjectLearningsValidation", () => {
  test("passes for private local learnings outside package surfaces", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());

    const result = runProjectLearningsValidation(normalizeProjectLearningsArgs({ source: root, learnings }));

    expect(result.status).toBe("PASS");
    expect(result.learningsName).toBe("local-learnings");
    expect(result.entryCount).toBe(1);
    expect(result.policy).toEqual({ visibility: "private", packageSurface: false, localOnly: true });
    expect(result.findings).toEqual([]);
  });

  test("blocks public visibility, package surfaces, unsafe paths, and sensitive-looking entries", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings({
      visibility: "public",
      packageSurface: true,
      entries: [{ id: "bad", summary: `Contains a ${sensitiveTrigger()} marker.`, source: "local" }],
    }), "docs/project-learnings.json");

    const result = runProjectLearningsValidation(normalizeProjectLearningsArgs({ source: root, learnings }));

    expect(result.status).toBe("BLOCKED");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "PROJECT_LEARNINGS_PACKAGE_SURFACE_FORBIDDEN",
      "PROJECT_LEARNINGS_PATH_UNSAFE",
      "PROJECT_LEARNINGS_PUBLIC_FORBIDDEN",
      "PROJECT_LEARNINGS_SENSITIVE_TEXT",
    ]);
  });

  test("characterizes legacy finding output echoing a synthetic sensitive-looking id", () => {
    const root = makeTempRoot();
    const syntheticId = `synthetic-${sensitiveTrigger()}`;
    const learnings = writeLearnings(root, baseLearnings({
      entries: [
        {
          id: syntheticId,
          summary: "Synthetic entry used only to characterize finding output.",
          source: "local",
        },
      ],
    }));

    const result = runProjectLearningsValidation(
      normalizeProjectLearningsArgs({ source: root, learnings }),
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "PROJECT_LEARNINGS_SENSITIVE_TEXT",
    ]);
    expect(result.findings[0]?.entry).toBe(syntheticId);
    expect(renderProjectLearningsResult(result, "json")).toContain(syntheticId);
  });

  test("warns when entries are empty and strict blocks warnings", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings({ entries: [] }));

    const loose = runProjectLearningsValidation(normalizeProjectLearningsArgs({ source: root, learnings }));
    const strict = runProjectLearningsValidation(normalizeProjectLearningsArgs({ source: root, learnings, strict: true }));

    expect(loose.status).toBe("CONCERNS");
    expect(strict.status).toBe("BLOCKED");
    expect(loose.findings[0]?.code).toBe("PROJECT_LEARNINGS_EMPTY");
  });

  test("omits empty entry ids from JSON findings so output matches schema", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings({ entries: [{ summary: "Missing id", source: "local" }] }));

    const result = runProjectLearningsValidation(normalizeProjectLearningsArgs({ source: root, learnings }));
    const parsed = JSON.parse(renderProjectLearningsResult(result, "json")) as typeof result;

    expect(parsed.status).toBe("BLOCKED");
    expect(parsed.findings.some((finding) => finding.code === "PROJECT_LEARNING_ID_INVALID" && finding.entry === "")).toBe(false);
  });

  test("renders stable JSON and text output", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const result = runProjectLearningsValidation(normalizeProjectLearningsArgs({ source: root, learnings }));

    expect(JSON.parse(renderProjectLearningsResult(result, "json"))).toEqual(result);
    expect(renderProjectLearningsResult(result, "text")).toContain("STATUS: PASS");
  });

  test("characterizes runtime acceptance broader than schema additional-properties rules", () => {
    const root = makeTempRoot();
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "schema", "project-learnings.schema.json"),
        "utf8",
      ),
    ) as {
      additionalProperties: boolean;
      required: string[];
      properties: {
        packageSurface: { const: boolean };
        entries: {
          type: string;
          uniqueItems?: boolean;
          items: {
            additionalProperties: boolean;
            required: string[];
            properties: {
              source: { type: string; minLength: number };
              tags: {
                type: string;
                uniqueItems: boolean;
                items: { type: string; minLength: number };
              };
            };
          };
        };
      };
    };
    const learnings = writeLearnings(root, baseLearnings({
      runtimeOnlyField: "ignored-by-observed-validator",
      entries: [
        {
          id: "use-bun",
          summary: "Use Bun scripts for local validation.",
          source: "local",
          tags: ["workflow"],
          runtimeOnlyField: "ignored",
        },
      ],
    }));

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("packageSurface");
    expect(schema.required).toContain("entries");
    expect(schema.properties.packageSurface.const).toBe(false);
    expect(schema.properties.entries.type).toBe("array");
    expect(schema.properties.entries.uniqueItems).toBeUndefined();
    expect(schema.properties.entries.items.additionalProperties).toBe(false);
    expect(schema.properties.entries.items.required).toContain("source");
    expect(schema.properties.entries.items.properties.source).toEqual({
      type: "string",
      minLength: 1,
    });
    expect(schema.properties.entries.items.properties.tags).toEqual({
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    });

    const result = runProjectLearningsValidation(
      normalizeProjectLearningsArgs({ source: root, learnings }),
    );
    expect(result.status).toBe("PASS");
    expect(result.entryCount).toBe(1);
    expect(result.findings).toEqual([]);
  });

  test("characterizes permissive packageSurface and entries warning defaults", () => {
    const root = makeTempRoot();
    const withoutPackageSurface = baseLearnings();
    delete withoutPackageSurface.packageSurface;
    const cases = [
      {
        value: withoutPackageSurface,
        status: "PASS",
        packageSurface: false,
        count: 1,
        codes: [],
      },
      {
        value: baseLearnings({ packageSurface: "not-a-boolean" }),
        status: "PASS",
        packageSurface: false,
        count: 1,
        codes: [],
      },
      {
        value: baseLearnings({ entries: undefined }),
        status: "CONCERNS",
        packageSurface: false,
        count: 0,
        codes: ["PROJECT_LEARNINGS_EMPTY"],
      },
      {
        value: baseLearnings({ entries: "not-an-array" }),
        status: "CONCERNS",
        packageSurface: false,
        count: 0,
        codes: ["PROJECT_LEARNINGS_EMPTY"],
      },
      {
        value: baseLearnings({ entries: [] }),
        status: "CONCERNS",
        packageSurface: false,
        count: 0,
        codes: ["PROJECT_LEARNINGS_EMPTY"],
      },
    ] as const;

    for (const [index, observed] of cases.entries()) {
      const learnings = writeLearnings(
        root,
        observed.value,
        `.skill-sys/project-learnings-${index}.json`,
      );
      const result = runProjectLearningsValidation(
        normalizeProjectLearningsArgs({ source: root, learnings }),
      );
      expect(result.status).toBe(observed.status);
      expect(result.policy.packageSurface).toBe(observed.packageSurface);
      expect(result.entryCount).toBe(observed.count);
      expect(result.findings.map((finding) => finding.code)).toEqual(
        [...observed.codes],
      );
    }
  });

  test("characterizes source and tags fields as ignored by runtime", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings({
      entries: [
        {
          id: "missing-source",
          summary: "Runtime does not require the schema source field.",
        },
        {
          id: "invalid-tags",
          summary: "Runtime ignores the schema tags field.",
          source: "local",
          tags: { unexpected: true },
        },
        {
          id: "empty-duplicate-tags",
          summary: "Runtime also ignores empty and duplicate tag values.",
          source: "local",
          tags: ["", "same", "same"],
        },
      ],
    }));

    const result = runProjectLearningsValidation(
      normalizeProjectLearningsArgs({ source: root, learnings }),
    );

    expect(result.status).toBe("PASS");
    expect(result.entryCount).toBe(3);
    expect(result.findings).toEqual([]);
  });

  test("characterizes nonobjects versus invalid objects in entry counts", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings({
      entries: [
        null,
        {},
        {
          id: "valid-entry",
          summary: "A valid synthetic entry.",
          source: "local",
        },
      ],
    }));

    const result = runProjectLearningsValidation(
      normalizeProjectLearningsArgs({ source: root, learnings }),
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.entryCount).toBe(2);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "PROJECT_LEARNING_ID_INVALID",
      "PROJECT_LEARNING_INVALID_SHAPE",
      "PROJECT_LEARNING_SUMMARY_INVALID",
    ]);
  });

  test("characterizes duplicate ids as blocked while retaining object count", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings({
      entries: [
        {
          id: "same-entry",
          summary: "First synthetic entry.",
          source: "local",
        },
        {
          id: "same-entry",
          summary: "Second synthetic entry.",
          source: "local",
        },
      ],
    }));

    const result = runProjectLearningsValidation(
      normalizeProjectLearningsArgs({ source: root, learnings }),
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.entryCount).toBe(2);
    expect(result.findings).toEqual([
      {
        level: "ERROR",
        code: "PROJECT_LEARNING_DUPLICATE_ID",
        path: ".skill-sys/project-learnings.json",
        entry: "same-entry",
        message: "Duplicate learning id: same-entry",
      },
    ]);
  });
});

describe("project learnings — append/update writes", () => {
  test("append adds a new entry with its source, revalidates PASS, and round-trips content", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const result = applyProjectLearningsAppend(input, { id: "use-docs", summary: "Keep docs fresh.", source: "docs-review" });

    expect(result.status).toBe("written");
    expect(result.written).toBe(true);
    expect(result.entryCount).toBe(2);
    expect(result.output).toBe(`${JSON.stringify(baseLearnings({
      entries: [
        { id: "use-bun", summary: "Use Bun scripts for local validation.", source: "local", tags: ["workflow"] },
        { id: "use-docs", summary: "Keep docs fresh.", source: "docs-review" },
      ],
    }), null, 2)}\n`);

    const reread = JSON.parse(fs.readFileSync(learnings, "utf8")) as {
      schemaVersion: number;
      name: string;
      visibility: string;
      packageSurface: boolean;
      entries: Array<{ id: string; summary: string; source: string }>;
    };
    expect(reread.schemaVersion).toBe(1);
    expect(reread.name).toBe("local-learnings");
    expect(reread.visibility).toBe("private");
    expect(reread.packageSurface).toBe(false);
    expect(reread.entries.map((entry) => entry.id)).toEqual(["use-bun", "use-docs"]);
    expect(reread.entries[1]).toEqual({ id: "use-docs", summary: "Keep docs fresh.", source: "docs-review" });
    expect(fs.readFileSync(learnings, "utf8").endsWith("\n")).toBe(true);
    expect(fs.readdirSync(path.dirname(learnings)).some((name) => name.startsWith(".tmp-"))).toBe(false);

    const revalidated = runProjectLearningsValidation(
      normalizeProjectLearningsArgs({ source: root, learnings }),
    );
    expect(revalidated.status).toBe("PASS");
    expect(revalidated.entryCount).toBe(2);
    expect(revalidated.findings).toEqual([]);
  });

  test("update replaces an existing summary by id and preserves the existing source", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const result = applyProjectLearningsUpdate(input, { id: "use-bun", summary: "Updated summary.", source: "ignored-by-update" });

    expect(result.status).toBe("written");
    expect(result.written).toBe(true);
    const reread = JSON.parse(fs.readFileSync(learnings, "utf8")) as {
      entries: Array<{ id: string; summary: string; source: string; tags: string[] }>;
    };
    expect(reread.entries).toHaveLength(1);
    expect(reread.entries[0]).toEqual({
      id: "use-bun",
      summary: "Updated summary.",
      source: "local",
      tags: ["workflow"],
    });
  });

  test("update with an unknown id is blocked and writes nothing", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const before = fs.readFileSync(learnings, "utf8");
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const result = applyProjectLearningsUpdate(input, { id: "missing-id", summary: "Nope." });

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings).toEqual([
      {
        level: "ERROR",
        code: "PROJECT_LEARNING_ID_NOT_FOUND",
        path: ".skill-sys/project-learnings.json",
        entry: "missing-id",
        message: "Learning id not found: missing-id",
      },
    ]);
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
  });

  test("update is blocked when the existing entry lacks a valid source", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings({
      entries: [{ id: "legacy", summary: "Old entry written before source was required." }],
    }));
    const before = fs.readFileSync(learnings, "utf8");
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const result = applyProjectLearningsUpdate(input, { id: "legacy", summary: "Updated." });

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNING_SOURCE_INVALID"]);
    expect(result.findings[0]?.message).toContain("existing entry must declare a valid source");
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
  });

  test("append with a duplicate id is blocked and the file is unchanged", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const before = fs.readFileSync(learnings, "utf8");
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const result = applyProjectLearningsAppend(input, { id: "use-bun", summary: "Duplicate.", source: "local" });

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNING_DUPLICATE_ID"]);
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
  });

  test("append without a valid source entry is blocked and the file is unchanged", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const before = fs.readFileSync(learnings, "utf8");
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const result = applyProjectLearningsAppend(input, { id: "no-source", summary: "Missing origin.", source: "   " });

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNING_SOURCE_INVALID"]);
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
  });

  test("append with a sensitive summary is blocked and the file is unchanged", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const before = fs.readFileSync(learnings, "utf8");
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const result = applyProjectLearningsAppend(input, { id: "leaky", summary: `contains a ${sensitiveTrigger()} marker`, source: "local" });

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNINGS_SENSITIVE_TEXT"]);
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
  });

  test("append with an unsafe id or empty summary is blocked", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const unsafeId = applyProjectLearningsAppend(input, { id: "Bad Id!", summary: "Fine.", source: "local" });
    expect(unsafeId.status).toBe("blocked");
    expect(unsafeId.written).toBe(false);
    expect(unsafeId.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNING_ID_INVALID"]);

    const emptySummary = applyProjectLearningsAppend(input, { id: "empty-summary", summary: "   ", source: "local" });
    expect(emptySummary.status).toBe("blocked");
    expect(emptySummary.written).toBe(false);
    expect(emptySummary.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNING_SUMMARY_INVALID"]);
  });

  test("dry-run prints what would be written without touching the file", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const before = fs.readFileSync(learnings, "utf8");
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const result = applyProjectLearningsAppend(input, { id: "dry-run-id", summary: "Would be added.", source: "local" }, { dryRun: true });

    expect(result.status).toBe("dry-run");
    expect(result.written).toBe(false);
    const proposed = JSON.parse(result.output) as { entries: Array<{ id: string; source: string }> };
    expect(proposed.entries.map((entry) => entry.id)).toEqual(["use-bun", "dry-run-id"]);
    expect(proposed.entries[1]?.source).toBe("local");
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
  });

  test("append on missing or empty entries arrays creates the array", () => {
    const missingEntriesRoot = makeTempRoot();
    const missingEntries = writeLearnings(missingEntriesRoot, baseLearnings({ entries: undefined }));
    const emptyRoot = makeTempRoot();
    const emptyEntries = writeLearnings(emptyRoot, baseLearnings({ entries: [] }));

    const fromMissing = applyProjectLearningsAppend(
      normalizeProjectLearningsArgs({ source: missingEntriesRoot, learnings: missingEntries }),
      { id: "first", summary: "First entry.", source: "local" },
    );
    const fromEmpty = applyProjectLearningsAppend(
      normalizeProjectLearningsArgs({ source: emptyRoot, learnings: emptyEntries }),
      { id: "first", summary: "First entry.", source: "local" },
    );

    expect(fromMissing.status).toBe("written");
    expect(fromEmpty.status).toBe("written");
    for (const file of [missingEntries, emptyEntries]) {
      const reread = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Array<{ id: string; source: string }> };
      expect(reread.entries).toHaveLength(1);
      expect(reread.entries[0]?.id).toBe("first");
      expect(reread.entries[0]?.source).toBe("local");
    }
  });

  test("append is blocked when existing entries keep the proposed document schema-invalid", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings({
      entries: [{ id: "legacy", summary: "Old entry without the schema-required source." }],
    }));
    const before = fs.readFileSync(learnings, "utf8");
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const result = applyProjectLearningsAppend(input, { id: "new-entry", summary: "New entry.", source: "local" });

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNINGS_SCHEMA_INVALID"]);
    expect(result.findings[0]?.message).toContain("project-learnings.schema.json");
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
  });

  test("the written document validates against the authoritative schema", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const input = normalizeProjectLearningsArgs({ source: root, learnings });
    const schema = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "schema", "project-learnings.schema.json"), "utf8"),
    ) as Parameters<typeof validateAgainstSubset>[0];

    const appendResult = applyProjectLearningsAppend(input, { id: "schema-ok", summary: "Schema-safe.", source: "cli" });
    expect(appendResult.status).toBe("written");
    expect(validateAgainstSubset(schema, JSON.parse(fs.readFileSync(learnings, "utf8")))).toEqual([]);

    const updateResult = applyProjectLearningsUpdate(input, { id: "schema-ok", summary: "Schema-safe update." });
    expect(updateResult.status).toBe("written");
    expect(validateAgainstSubset(schema, JSON.parse(fs.readFileSync(learnings, "utf8")))).toEqual([]);
  });

  test("append aborts when another writer holds the learnings lock", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const before = fs.readFileSync(learnings, "utf8");
    const input = normalizeProjectLearningsArgs({ source: root, learnings });
    fs.writeFileSync(`${learnings}.lock`, `${JSON.stringify({ pid: process.pid, timestamp: Date.now() })}\n`);

    const result = applyProjectLearningsAppend(input, { id: "concurrent", summary: "Lost update?", source: "local" });

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNINGS_LOCKED"]);
    expect(result.findings[0]?.message).toContain("locked by another writer");
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
    expect(fs.existsSync(`${learnings}.lock`)).toBe(true);
  });

  test("update aborts when another writer holds the learnings lock", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const before = fs.readFileSync(learnings, "utf8");
    const input = normalizeProjectLearningsArgs({ source: root, learnings });
    fs.writeFileSync(`${learnings}.lock`, `${JSON.stringify({ pid: process.pid, timestamp: Date.now() })}\n`);

    const result = applyProjectLearningsUpdate(input, { id: "use-bun", summary: "Updated." }, { readFile: () => before });

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNINGS_LOCKED"]);
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
  });

  test("append recovers from a stale legacy lock and leaves no lock file behind", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const input = normalizeProjectLearningsArgs({ source: root, learnings });
    const lockPath = `${learnings}.lock`;
    fs.writeFileSync(lockPath, `${JSON.stringify({ pid: findConfirmedDeadPid(), timestamp: 1 })}\n`);
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    const result = applyProjectLearningsAppend(input, { id: "stale-lock", summary: "Wins the stale lock.", source: "local" });

    expect(result.status).toBe("written");
    expect(result.written).toBe(true);
    const reread = JSON.parse(fs.readFileSync(learnings, "utf8")) as { entries: Array<{ id: string }> };
    expect(reread.entries.some((entry) => entry.id === "stale-lock")).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("the learnings lock is released after a successful write", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const first = applyProjectLearningsAppend(input, { id: "lock-release", summary: "Releases the lock.", source: "local" });
    expect(first.status).toBe("written");
    expect(fs.existsSync(`${learnings}.lock`)).toBe(false);

    const second = applyProjectLearningsAppend(input, { id: "lock-release-2", summary: "Lock is free.", source: "local" });
    expect(second.status).toBe("written");
    expect(fs.existsSync(`${learnings}.lock`)).toBe(false);
  });

  test("append reads the learnings file while holding the learnings lock", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const input = normalizeProjectLearningsArgs({ source: root, learnings });
    const observed = { lockPresentDuringRead: false };
    const readFile = (): string => {
      observed.lockPresentDuringRead = fs.existsSync(`${learnings}.lock`);
      return fs.readFileSync(learnings, "utf8");
    };

    const result = applyProjectLearningsAppend(input, { id: "under-lock", summary: "Read under lock.", source: "local" }, { readFile });

    expect(result.status).toBe("written");
    expect(observed.lockPresentDuringRead).toBe(true);
    expect(fs.existsSync(`${learnings}.lock`)).toBe(false);
  });

  test("update reads the learnings file while holding the learnings lock", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const input = normalizeProjectLearningsArgs({ source: root, learnings });
    const observed = { lockPresentDuringRead: false };
    const readFile = (): string => {
      observed.lockPresentDuringRead = fs.existsSync(`${learnings}.lock`);
      return fs.readFileSync(learnings, "utf8");
    };

    const result = applyProjectLearningsUpdate(input, { id: "use-bun", summary: "Updated under lock." }, { readFile });

    expect(result.status).toBe("written");
    expect(observed.lockPresentDuringRead).toBe(true);
    expect(fs.existsSync(`${learnings}.lock`)).toBe(false);
  });

  test("a snapshot taken before the lock cannot cause a lost update", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    // Writer A snapshots before any lock; a competitor commits first; writer A
    // must derive its write from a fresh in-lock read, not the stale snapshot.
    fs.readFileSync(learnings, "utf8");
    const competitorDoc = baseLearnings({
      entries: [
        { id: "use-bun", summary: "Use Bun scripts for local validation.", source: "local", tags: ["workflow"] },
        { id: "competitor", summary: "Committed before the late writer.", source: "other" },
      ],
    });
    fs.writeFileSync(learnings, `${JSON.stringify(competitorDoc, null, 2)}\n`);

    const result = applyProjectLearningsAppend(input, { id: "late-writer", summary: "Arrives last.", source: "local" });

    expect(result.status).toBe("written");
    const reread = JSON.parse(fs.readFileSync(learnings, "utf8")) as { entries: Array<{ id: string }> };
    expect(reread.entries.map((entry) => entry.id)).toEqual(["use-bun", "competitor", "late-writer"]);
  });

  test("dry-run neither takes nor requires the learnings lock", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const input = normalizeProjectLearningsArgs({ source: root, learnings });
    const observed = { lockPresentDuringRead: false };
    const readFile = (): string => {
      observed.lockPresentDuringRead = fs.existsSync(`${learnings}.lock`);
      return fs.readFileSync(learnings, "utf8");
    };

    const result = applyProjectLearningsAppend(
      input,
      { id: "dry-no-lock", summary: "No lock for dry-run.", source: "local" },
      { dryRun: true, readFile },
    );

    expect(result.status).toBe("dry-run");
    expect(observed.lockPresentDuringRead).toBe(false);
    expect(fs.existsSync(`${learnings}.lock`)).toBe(false);
  });

  test("append with a non-array entries value is blocked and the file is unchanged", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings({ entries: { not: "an array" } }));
    const before = fs.readFileSync(learnings, "utf8");
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const result = applyProjectLearningsAppend(input, { id: "new-entry", summary: "New entry.", source: "local" });

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNINGS_ENTRIES_INVALID"]);
    expect(result.findings[0]?.message).toContain("entries must be an array when present");
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
  });

  test("append write failures return blocked with PROJECT_LEARNINGS_WRITE_FAILED and no temp residue", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const before = fs.readFileSync(learnings, "utf8");
    fs.linkSync(learnings, path.join(root, "second-link.json"));
    const input = normalizeProjectLearningsArgs({ source: root, learnings });

    const result = applyProjectLearningsAppend(input, { id: "new-entry", summary: "New entry.", source: "local" });

    expect(result.status).toBe("blocked");
    expect(result.written).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNINGS_WRITE_FAILED"]);
    expect(result.findings[0]?.message).toContain("Refusing to overwrite hardlinked target");
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(learnings)).some((name) => name.startsWith(".tmp-"))).toBe(false);
    expect(fs.existsSync(`${learnings}.lock`)).toBe(false);
  });
});

describe("project learnings — append/update CLI", () => {
  function runCli(args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync({
      cmd: ["bun", path.join(repoRoot, "scripts", "commands", "project-learnings.ts"), ...args],
      cwd: repoRoot,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout?.toString("utf8") ?? "",
      stderr: result.stderr?.toString("utf8") ?? "",
    };
  }

  test("append writes the file and emits a JSON result", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const args = ["append", "--source", root, "--learnings", learnings, "--id", "cli-entry", "--summary", "Added from the CLI.", "--source-entry", "cli", "--json"];

    const result = runCli(args);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { status: string; written: boolean; operation: string; entryCount: number };
    expect(parsed.status).toBe("written");
    expect(parsed.written).toBe(true);
    expect(parsed.operation).toBe("append");
    expect(parsed.entryCount).toBe(2);
    const reread = JSON.parse(fs.readFileSync(learnings, "utf8")) as { entries: Array<{ id: string; source: string }> };
    expect(reread.entries.some((entry) => entry.id === "cli-entry" && entry.source === "cli")).toBe(true);
  });

  test("update writes the file, preserves source, and emits a JSON result", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const args = ["update", "--source", root, "--learnings", learnings, "--id", "use-bun", "--summary", "Updated from the CLI.", "--json"];

    const result = runCli(args);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { status: string; written: boolean; operation: string; entryCount: number };
    expect(parsed.status).toBe("written");
    expect(parsed.written).toBe(true);
    expect(parsed.operation).toBe("update");
    expect(parsed.entryCount).toBe(1);
    const reread = JSON.parse(fs.readFileSync(learnings, "utf8")) as { entries: Array<{ id: string; summary: string; source: string; tags: string[] }> };
    expect(reread.entries[0]).toEqual({ id: "use-bun", summary: "Updated from the CLI.", source: "local", tags: ["workflow"] });
  });

  test("append duplicate exits 1 and leaves the file unchanged", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const before = fs.readFileSync(learnings, "utf8");
    const args = ["append", "--source", root, "--learnings", learnings, "--id", "use-bun", "--summary", "dup", "--source-entry", "cli", "--json"];

    const result = runCli(args);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { status: string; written: boolean; findings: Array<{ code: string }> };
    expect(parsed.status).toBe("blocked");
    expect(parsed.written).toBe(false);
    expect(parsed.findings.map((finding) => finding.code)).toEqual(["PROJECT_LEARNING_DUPLICATE_ID"]);
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
  });

  test("--dry-run reports what would be written and leaves the file unchanged", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const before = fs.readFileSync(learnings, "utf8");
    const args = ["append", "--source", root, "--learnings", learnings, "--id", "dry-run", "--summary", "not written", "--source-entry", "cli", "--dry-run"];

    const result = runCli(args);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("STATUS: DRY-RUN");
    expect(result.stdout).toContain("Dry run: true");
    expect(result.stdout).toContain('"summary": "not written"');
    expect(result.stdout).toContain('"source": "cli"');
    expect(fs.readFileSync(learnings, "utf8")).toBe(before);
  });

  test("append without --id, --summary, or --source-entry fails clearly", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());

    const missingId = runCli(["append", "--source", root, "--learnings", learnings, "--summary", "x", "--source-entry", "cli"]);
    expect(missingId.exitCode).toBe(1);
    expect(missingId.stderr).toContain("ERROR: Missing --id");

    const missingSummary = runCli(["append", "--source", root, "--learnings", learnings, "--id", "x", "--source-entry", "cli"]);
    expect(missingSummary.exitCode).toBe(1);
    expect(missingSummary.stderr).toContain("ERROR: Missing --summary");

    const missingSourceEntry = runCli(["append", "--source", root, "--learnings", learnings, "--id", "x", "--summary", "y"]);
    expect(missingSourceEntry.exitCode).toBe(1);
    expect(missingSourceEntry.stderr).toContain("ERROR: Missing --source-entry");
  });

  test("default validate behavior is unchanged by the new subcommands", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const args = ["--source", root, "--learnings", learnings, "--json"];

    const result = runCli(args);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { status: string; command: string };
    expect(parsed.command).toBe("project-learnings");
    expect(parsed.status).toBe("PASS");
  });
});

describe("project learnings — facade dispatch", () => {
  function runFacade(args: readonly string[]): { code: number; stdout: string; stderr: string } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = skillSys.main(["bun", "skill-sys", ...args], {
      cwd: repoRoot,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  }

  test("facade append forwards the subcommand and writes the entry with source", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const args = ["project-learnings", "append", "--source", root, "--learnings", learnings, "--id", "facade-entry", "--summary", "Via facade.", "--source-entry", "cli"];

    const result = runFacade(args);

    expect(result.code).toBe(0);
    const reread = JSON.parse(fs.readFileSync(learnings, "utf8")) as { entries: Array<{ id: string; source: string }> };
    expect(reread.entries.some((entry) => entry.id === "facade-entry" && entry.source === "cli")).toBe(true);
  });

  test("facade update forwards the subcommand and writes the summary", () => {
    const root = makeTempRoot();
    const learnings = writeLearnings(root, baseLearnings());
    const args = ["project-learnings", "update", "--source", root, "--learnings", learnings, "--id", "use-bun", "--summary", "Facade update."];

    const result = runFacade(args);

    expect(result.code).toBe(0);
    const reread = JSON.parse(fs.readFileSync(learnings, "utf8")) as { entries: Array<{ id: string; summary: string; source: string; tags?: string[] }> };
    expect(reread.entries[0]).toEqual({ id: "use-bun", summary: "Facade update.", source: "local", tags: ["workflow"] });
  });

  test("facade rejects an unknown project-learnings subcommand", () => {
    const result = runFacade(["project-learnings", "bogus", "--source", ".", "--learnings", "x.json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage: skill-sys project-learnings");
    expect(result.stderr).toContain("validate|append|update");
  });
});
