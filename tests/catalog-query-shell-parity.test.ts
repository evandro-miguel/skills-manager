import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const OPENING_LIST_BLOB = "c5fa46c07b6574ad754b31041ead452788e08e7d";
const OPENING_FACADE_BLOB = "70c1454de7089c86e0fba4aa8d4deaad9309f40c";
const CURRENT_FACADE_BLOB = "f90aa282b042d97c29332cf41d64f17b29fffdd6";
const OPENING_METADATA_BLOB = "db34a9ac24922580645e8b3920b3cb056bc75183";
const CURRENT_LIST = path.join(REPO_ROOT, "scripts", "commands", "list-skills.ts");
const CURRENT_FACADE = path.join(REPO_ROOT, "scripts", "commands", "skill-sys.ts");
const OPENING_LIST_FIXTURE = path.join(
  REPO_ROOT,
  "tests/fixtures/catalog-query-shell-parity/opening-list-skills.txt",
);
const OPENING_METADATA_FIXTURE = path.join(
  REPO_ROOT,
  "tests/fixtures/catalog-query-shell-parity/opening-skill-metadata-lib.txt",
);
const OPENING_FACADE_FIXTURE = path.join(
  REPO_ROOT,
  "tests/fixtures/catalog-query-shell-parity/opening-skill-sys.txt",
);
const temporaryRoots: string[] = [];

type CliResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

type Fixture = Readonly<{
  root: string;
  skillsRoot: string;
  profilesRoot: string;
}>;

type StandaloneScenario = Readonly<{
  name: string;
  args: readonly string[];
}>;

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function run(
  command: readonly string[],
  cwd: string,
): CliResult {
  const result = Bun.spawnSync({
    cmd: [...command],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new Uint8Array(result.stdout ?? []),
    stderr: new Uint8Array(result.stderr ?? []),
  };
}

function git(args: readonly string[]): CliResult {
  const result = run(["git", ...args], REPO_ROOT);
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8"));
  }
  return result;
}

function gitText(args: readonly string[]): string {
  return Buffer.from(git(args).stdout).toString("utf8");
}

function materializeOpeningCommand(): string {
  const sourceRoot = temporaryRoot("f03-opening-list-source-");
  const commandPath = path.join(sourceRoot, "scripts", "commands", "list-skills.ts");
  const metadataPath = path.join(
    sourceRoot,
    "scripts",
    "modules",
    "skill-metadata-lib.ts",
  );
  fs.mkdirSync(path.dirname(commandPath), { recursive: true });
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(
    commandPath,
    fs.readFileSync(OPENING_LIST_FIXTURE, "utf8"),
  );
  fs.writeFileSync(
    metadataPath,
    fs.readFileSync(OPENING_METADATA_FIXTURE, "utf8"),
  );
  return commandPath;
}

function runStandaloneBatch(
  modulePath: string,
  fixture: Fixture,
  scenarios: readonly StandaloneScenario[],
): readonly CliResult[] {
  const batchRoot = temporaryRoot("f03-list-batch-runner-");
  const runnerPath = path.join(batchRoot, "run.ts");
  const casesPath = path.join(batchRoot, "cases.json");
  fs.writeFileSync(casesPath, JSON.stringify(scenarios.map(({ args }) => args)));
  fs.writeFileSync(
    runnerPath,
    [
      'import fs from "node:fs";',
      "const [modulePath, casesPath] = process.argv.slice(2);",
      'if (modulePath === undefined || casesPath === undefined) throw new Error("missing batch input");',
      "const imported = await import(modulePath);",
      "const main = imported.main as (argv: string[]) => void;",
      'const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")) as string[][];',
      "const results = [];",
      "for (const args of cases) {",
      "  const stdout: string[] = [];",
      "  const stderr: string[] = [];",
      "  const originalLog = console.log;",
      "  const originalError = console.error;",
      '  console.log = (...values: unknown[]) => stdout.push(`${values.map(String).join(" ")}\\n`);',
      '  console.error = (...values: unknown[]) => stderr.push(`${values.map(String).join(" ")}\\n`);',
      "  let exitCode = 0;",
      "  try {",
      '    main(["bun", modulePath, ...args]);',
      "  } catch (error) {",
      "    const message = error instanceof Error ? error.message : String(error);",
      '    console.error(`ERROR: ${message}`);',
      "    exitCode = 1;",
      "  } finally {",
      "    console.log = originalLog;",
      "    console.error = originalError;",
      "  }",
      "  results.push({",
      "    exitCode,",
      '    stdout: Buffer.from(stdout.join(""), "utf8").toString("base64"),',
      '    stderr: Buffer.from(stderr.join(""), "utf8").toString("base64"),',
      "  });",
      "}",
      "process.stdout.write(JSON.stringify(results));",
      "",
    ].join("\n"),
  );
  const result = run(["bun", runnerPath, modulePath, casesPath], fixture.root);
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString("utf8"));
  }
  const encoded = JSON.parse(
    Buffer.from(result.stdout).toString("utf8"),
  ) as Array<Readonly<{ exitCode: number; stdout: string; stderr: string }>>;
  return encoded.map((entry) => ({
    exitCode: entry.exitCode,
    stdout: new Uint8Array(Buffer.from(entry.stdout, "base64")),
    stderr: new Uint8Array(Buffer.from(entry.stderr, "base64")),
  }));
}

function writeSkill(
  root: string,
  name: string,
  options: Readonly<{
    description: string;
    category: string;
    tags: string;
    triggers: string;
    internal?: boolean;
    experimental?: boolean;
  }>,
): void {
  const skillRoot = path.join(root, name);
  fs.mkdirSync(skillRoot, { recursive: true });
  const visibility = [
    options.internal === undefined ? "" : `  internal: ${options.internal}\n`,
    options.experimental === undefined
      ? ""
      : `  experimental: ${options.experimental}\n`,
  ].join("");
  fs.writeFileSync(
    path.join(skillRoot, "SKILL.md"),
    `---
name: ${name}
description: ${options.description}
metadata:
  category: ${options.category}
  tags: "${options.tags}"
  triggers: "${options.triggers}"
  version: "1.0.0"
  updated_at: "2026-07-27"
  target_provider: universal
${visibility}---

# ${name}
`,
  );
}

function createFixture(): Fixture {
  const root = temporaryRoot("f03-catalog-shell-parity-");
  const skillsRoot = path.join(root, "skills");
  const profilesRoot = path.join(root, "profiles");
  fs.mkdirSync(skillsRoot);
  fs.mkdirSync(profilesRoot);
  writeSkill(skillsRoot, "alpha", {
    description: "Alpha documentation helper",
    category: "docs",
    tags: "bun, cli",
    triggers: "catalog, documentation",
  });
  writeSkill(skillsRoot, "beta", {
    description: "Beta server operator",
    category: "ops",
    tags: "server",
    triggers: "backend",
  });
  writeSkill(skillsRoot, "internal-skill", {
    description: "Internal helper",
    category: "ops",
    tags: "private",
    triggers: "internal",
    internal: true,
  });
  writeSkill(skillsRoot, "experimental-skill", {
    description: "Experimental helper",
    category: "preview",
    tags: "preview",
    triggers: "experimental",
    experimental: true,
  });
  fs.mkdirSync(path.join(skillsRoot, "invalid"));
  fs.writeFileSync(path.join(skillsRoot, "invalid", "SKILL.md"), "# no frontmatter\n");
  fs.writeFileSync(
    path.join(profilesRoot, "core.json"),
    `${JSON.stringify(
      {
        name: "Core",
        description: "Core profile",
        curation: "reviewed",
        scope: "general",
        skills: ["alpha", "beta"],
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(profilesRoot, "malformed.json"), "{\n");
  return { root, skillsRoot, profilesRoot };
}

function productSnapshot(root: string): readonly string[] {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        entries.push(`d ${relative}`);
        visit(absolute);
      } else if (entry.isFile()) {
        const digest = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
        entries.push(`f ${relative} ${digest}`);
      } else {
        entries.push(`o ${relative}`);
      }
    }
  };
  visit(root);
  return entries.sort();
}

function standaloneArgs(
  fixture: Fixture,
  extra: readonly string[],
): readonly string[] {
  return [
    "--skills-root",
    fixture.skillsRoot,
    "--profiles-root",
    fixture.profilesRoot,
    ...extra,
  ];
}

describe("F-03.02 retained catalog shell parity", () => {
  test("pins the opening and retained legacy source blobs exactly", () => {
    expect(gitText(["hash-object", OPENING_LIST_FIXTURE]).trim()).toBe(OPENING_LIST_BLOB);
    expect(gitText(["hash-object", OPENING_FACADE_FIXTURE]).trim()).toBe(OPENING_FACADE_BLOB);
    expect(gitText(["hash-object", OPENING_METADATA_FIXTURE]).trim()).toBe(OPENING_METADATA_BLOB);
    expect(gitText(["hash-object", CURRENT_LIST]).trim()).toBe(OPENING_LIST_BLOB);
    expect(gitText(["hash-object", CURRENT_FACADE]).trim()).toBe(CURRENT_FACADE_BLOB);
    expect(
      gitText(["hash-object", "scripts/modules/skill-metadata-lib.ts"]).trim(),
    ).toBe(OPENING_METADATA_BLOB);
  });

  test(
    "preserves standalone success, filters, profiles, rendering, failures, and exits byte-for-byte",
    () => {
      const fixture = createFixture();
      const openingCommand = materializeOpeningCommand();
      const before = productSnapshot(fixture.root);
      const cases: readonly StandaloneScenario[] = [
        { name: "success", args: [] },
        { name: "empty", args: ["--category", "missing"] },
        { name: "category", args: ["--category", "DOCS"] },
        { name: "tag", args: ["--tag", "CATALOG"] },
        { name: "text query", args: ["--query", "SERVER"] },
        { name: "profile", args: ["--profile", "core"] },
        { name: "missing profile", args: ["--profile", "missing"] },
        { name: "malformed profile", args: ["--profile", "malformed"] },
        { name: "internal flag", args: ["--include-internal", "--names-only"] },
        {
          name: "experimental flag",
          args: ["--include-experimental", "--names-only"],
        },
        { name: "help", args: ["--help"] },
        { name: "text renderer", args: ["--tag", "bun"] },
        { name: "names-only renderer", args: ["--names-only"] },
        { name: "raw-array JSON renderer", args: ["--json"] },
        { name: "stderr and exit", args: ["--unknown"] },
      ];

      const expandedCases = cases.map((scenario) => ({
        ...scenario,
        args: standaloneArgs(fixture, scenario.args),
      }));
      const opening = runStandaloneBatch(
        openingCommand,
        fixture,
        expandedCases,
      );
      const current = runStandaloneBatch(CURRENT_LIST, fixture, expandedCases);

      for (const [index, scenario] of cases.entries()) {
        expect(current[index], scenario.name).toEqual(opening[index]);
      }
      expect(productSnapshot(fixture.root), "batch mutated product fixtures").toEqual(
        before,
      );
    },
    20_000,
  );

  test("retains facade list/ls/find routing over the byte-compatible standalone adapter", () => {
    const fixture = createFixture();
    const openingCommand = materializeOpeningCommand();
    const before = productSnapshot(fixture.root);
    const cases = [
      {
        name: "list raw JSON",
        facade: ["list", ...standaloneArgs(fixture, []), "--json"],
        standalone: [...standaloneArgs(fixture, []), "--json"],
      },
      {
        name: "ls text",
        facade: ["ls", ...standaloneArgs(fixture, []), "--category", "docs"],
        standalone: [...standaloneArgs(fixture, []), "--category", "docs"],
      },
      {
        name: "find query",
        facade: ["find", "server", ...standaloneArgs(fixture, []), "--names-only"],
        standalone: [...standaloneArgs(fixture, []), "--query", "server", "--names-only"],
      },
    ] as const;

    for (const scenario of cases) {
      const opening = run(["bun", openingCommand, ...scenario.standalone], fixture.root);
      const facade = run(["bun", CURRENT_FACADE, ...scenario.facade], fixture.root);
      expect(facade, scenario.name).toEqual(opening);
      expect(productSnapshot(fixture.root), `${scenario.name} mutated product fixtures`).toEqual(
        before,
      );
    }
  });
});
