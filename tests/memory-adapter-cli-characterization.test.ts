import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const standaloneCommand = path.join(
  repoRoot,
  "scripts",
  "commands",
  "memory-adapter.ts",
);
const facadeCommand = path.join(
  repoRoot,
  "scripts",
  "commands",
  "skill-sys.ts",
);
const temporaryRoots: string[] = [];

type CliResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

type MemoryFixture = Readonly<{ root: string; config: string }>;

function baseConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    ...overrides,
  };
}

function createMemoryRoot(
  configValue: unknown = baseConfig(),
  fileName = ".skill-sys/memory-adapter.json",
): MemoryFixture {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "memory-adapter-cli-characterization-"),
  );
  temporaryRoots.push(root);
  const config = path.join(root, fileName);
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(
    config,
    typeof configValue === "string"
      ? configValue
      : `${JSON.stringify(configValue, null, 2)}\n`,
    "utf8",
  );
  return { root, config };
}

function readWriteConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
    ...overrides,
  });
}

function memoryFile(root: string): string {
  return path.join(root, ".skill-sys", "memory", "local.jsonl");
}

function run(
  command: readonly string[],
  fixtureRoots: readonly string[] = [],
): CliResult {
  const result = Bun.spawnSync({
    cmd: ["bun", ...command],
    cwd: repoRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
    maxBuffer: 1_048_576,
  });
  const sanitize = (value: Uint8Array | null | undefined): string => {
    let text = value === undefined || value === null
      ? ""
      : Buffer.from(value).toString("utf8");
    for (const [index, fixtureRoot] of fixtureRoots.entries()) {
      text = text
        .split(fixtureRoot)
        .join(`<fixture-root-${index + 1}>`);
    }
    return text
      .split(repoRoot)
      .join("<repo-root>")
      .replaceAll("\r\n", "\n")
      .replace(
        /"message": "JSON Parse error: [^"]+"/gu,
        '"message": "<json-parse-error>"',
      )
      .replace(/Bun v[^\n]+\n/gu, "<bun-runtime>\n");
  };
  return {
    exitCode: result.exitCode,
    stdout: sanitize(result.stdout),
    stderr: sanitize(result.stderr),
  };
}

function standalone(
  args: readonly string[],
  fixtureRoots: readonly string[] = [],
): CliResult {
  return run([standaloneCommand, ...args], fixtureRoots);
}

function facade(
  command: "memory-adapter" | "memory",
  args: readonly string[],
  fixtureRoots: readonly string[] = [],
): CliResult {
  return run([facadeCommand, command, ...args], fixtureRoots);
}

function sanitizedCommandLine(
  args: readonly string[],
  fixtureRoots: readonly string[] = [],
): string {
  let commandLine = ["bun", standaloneCommand, ...args].join(" ");
  for (const [index, fixtureRoot] of fixtureRoots.entries()) {
    commandLine = commandLine
      .split(fixtureRoot)
      .join(`<fixture-root-${index + 1}>`);
  }
  return commandLine.split(repoRoot).join("<repo-root>");
}

function facadeFailureStderr(
  args: readonly string[],
  fixtureRoots: readonly string[] = [],
  childStderr = "",
): string {
  return `${childStderr}ERROR: Command failed (1): ${sanitizedCommandLine(args, fixtureRoots)}\n`;
}

function textResult(
  status: "PASS" | "CONCERNS" | "BLOCKED",
  options: Readonly<{
    fixture?: number;
    adapterName?: string;
    adapterType?: "jsonl" | "sqlite" | "mcp";
    adapterMode?: "read-only" | "read-write";
    visibility?: "private" | "local";
    packageSurface?: boolean;
    allowedSkills?: number;
    findings?: readonly string[];
  }> = {},
): string {
  const fixture = options.fixture ?? 1;
  const findings = options.findings ?? [];
  return [
    `STATUS: ${status}`,
    `Adapter: ${options.adapterName ?? "local-memory"}`,
    `Source: <fixture-root-${fixture}>`,
    `Config file: <fixture-root-${fixture}>/.skill-sys/memory-adapter.json`,
    `Adapter type: ${options.adapterType ?? "jsonl"}`,
    `Adapter mode: ${options.adapterMode ?? "read-only"}`,
    `Visibility: ${options.visibility ?? "private"}`,
    `Package surface: ${options.packageSurface ?? false}`,
    `Allowed skills: ${options.allowedSkills ?? 1}`,
    `Findings: ${findings.length}`,
    ...findings,
    "",
  ].join("\n");
}

function jsonResult(
  options: Readonly<{
    fixture?: number;
    strict?: boolean;
    status?: "PASS" | "CONCERNS" | "BLOCKED";
    adapterType?: "jsonl" | "sqlite" | "mcp";
    adapterMode?: "read-only" | "read-write";
    adapterPath?: string;
    allowedSkills?: number;
    findings?: readonly Record<string, unknown>[];
  }> = {},
): string {
  const fixture = options.fixture ?? 1;
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      command: "memory-adapter",
      status: options.status ?? "PASS",
      source: `<fixture-root-${fixture}>`,
      config:
        `<fixture-root-${fixture}>/.skill-sys/memory-adapter.json`,
      strict: options.strict ?? false,
      adapterName: "local-memory",
      adapter: {
        type: options.adapterType ?? "jsonl",
        mode: options.adapterMode ?? "read-only",
        path:
          options.adapterPath ?? ".skill-sys/memory/local.jsonl",
      },
      policy: {
        visibility: "private",
        packageSurface: false,
        readOptIn: true,
        writeOptIn: false,
        allowSensitiveMemory: false,
      },
      allowedSkillCount: options.allowedSkills ?? 1,
      findings: options.findings ?? [],
    },
    null,
    2,
  )}\n`;
}

function invalidJsonResult(): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      command: "memory-adapter",
      status: "BLOCKED",
      source: "<fixture-root-1>",
      config: "<fixture-root-1>/.skill-sys/memory-adapter.json",
      strict: false,
      adapterName: "",
      adapter: { type: "jsonl", mode: "read-only", path: "" },
      policy: {
        visibility: "private",
        packageSurface: false,
        readOptIn: false,
        writeOptIn: false,
        allowSensitiveMemory: false,
      },
      allowedSkillCount: 0,
      findings: [
        {
          level: "ERROR",
          code: "MEMORY_ADAPTER_INVALID_JSON",
          path: ".skill-sys/memory-adapter.json",
          message: "<json-parse-error>",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function helpResult(): CliResult {
  return {
    exitCode: 0,
    stdout: [
      "",
      "Manage local/private memory adapter interfaces under explicit trust policy",
      "",
      "Usage:",
      "  bun scripts/commands/memory-adapter.ts [validate] --source <dir> --config <file> [options]",
      "  bun scripts/commands/memory-adapter.ts read --source <dir> --config <file> [options]",
      "  bun scripts/commands/memory-adapter.ts write --source <dir> --config <file> --id <id> --memory <text> --source-entry <text> [options]",
      "",
      "Commands:",
      "  validate             Validate the memory adapter config (default)",
      "  read                 Read memory records from a JSONL adapter",
      "  write                Append a memory record to a JSONL adapter",
      "",
      "Options:",
      "  --source <dir>       Project/source root",
      "  --config <file>      Memory adapter JSON config",
      "  --id <id>            Record id (write)",
      "  --memory <text>      Record memory text (write)",
      "  --source-entry <text> Record provenance (write)",
      "  --json               Emit machine-readable output",
      "  --dry-run            Print what would be written without writing (write)",
      "  --strict             Treat warnings as blocking",
      "  --help               Show help",
      "",
      "",
    ].join("\n"),
    stderr: "",
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("F-04.01 memory-adapter CLI characterization", () => {
  test("canonical standalone, facade, and alias preserve exact PASS text bytes", () => {
    const fixture = createMemoryRoot();
    const args = ["--source", fixture.root, "--config", fixture.config];
    const expected = {
      exitCode: 0,
      stdout: textResult("PASS"),
      stderr: "",
    };

    expect(standalone(args, [fixture.root])).toEqual(expected);
    expect(facade("memory-adapter", args, [fixture.root])).toEqual(expected);
    expect(facade("memory", args, [fixture.root])).toEqual(expected);
  });

  test("canonical standalone, facade, and alias preserve exact PASS JSON bytes", () => {
    const fixture = createMemoryRoot();
    const args = [
      "--source",
      fixture.root,
      "--config",
      fixture.config,
      "--json",
    ];
    const expected = {
      exitCode: 0,
      stdout: jsonResult(),
      stderr: "",
    };

    expect(standalone(args, [fixture.root])).toEqual(expected);
    expect(facade("memory-adapter", args, [fixture.root])).toEqual(expected);
    expect(facade("memory", args, [fixture.root])).toEqual(expected);
  });

  test("standalone help, short-help, and repeated help are idempotent", () => {
    const expected = helpResult();
    expect(standalone(["--help"])).toEqual(expected);
    expect(standalone(["-h"])).toEqual(expected);
    expect(standalone(["--help", "--help"])).toEqual(expected);
  });

  test("facade and alias forward one long-help occurrence", () => {
    const expected = helpResult();
    expect(facade("memory-adapter", ["--help"])).toEqual(expected);
    expect(facade("memory", ["--help"])).toEqual(expected);
  });

  test("facade and alias drop short-help and repeated long-help", () => {
    const droppedHelp = {
      exitCode: 1,
      stdout: "",
      stderr: facadeFailureStderr([], [], "ERROR: Missing --source\n"),
    };
    expect(facade("memory-adapter", ["-h"])).toEqual(droppedHelp);
    expect(facade("memory", ["-h"])).toEqual(droppedHelp);
    expect(facade("memory-adapter", ["--help", "--help"])).toEqual(
      droppedHelp,
    );
    expect(facade("memory", ["--help", "--help"])).toEqual(droppedHelp);
  });

  test("duplicate scalar options are last-wins on all surfaces", () => {
    const first = createMemoryRoot(
      baseConfig({ name: "first-memory" }),
    );
    const last = createMemoryRoot();
    const args = [
      "--source",
      first.root,
      "--source",
      last.root,
      "--config",
      first.config,
      "--config",
      last.config,
    ];
    const fixtureRoots = [first.root, last.root];
    const expected = {
      exitCode: 0,
      stdout: textResult("PASS", { fixture: 2 }),
      stderr: "",
    };

    expect(standalone(args, fixtureRoots)).toEqual(expected);
    expect(facade("memory-adapter", args, fixtureRoots)).toEqual(expected);
    expect(facade("memory", args, fixtureRoots)).toEqual(expected);
  });

  test("duplicate json is idempotent standalone but dropped by facade and alias", () => {
    const fixture = createMemoryRoot();
    const args = [
      "--source",
      fixture.root,
      "--config",
      fixture.config,
      "--json",
      "--json",
    ];

    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 0,
      stdout: jsonResult(),
      stderr: "",
    });
    const facadeExpected = {
      exitCode: 0,
      stdout: textResult("PASS"),
      stderr: "",
    };
    expect(facade("memory-adapter", args, [fixture.root])).toEqual(
      facadeExpected,
    );
    expect(facade("memory", args, [fixture.root])).toEqual(facadeExpected);
  });

  test("duplicate strict changes standalone BLOCKED into facade CONCERNS", () => {
    const fixture = createMemoryRoot(baseConfig({ allowedSkills: [] }));
    const args = [
      "--source",
      fixture.root,
      "--config",
      fixture.config,
      "--strict",
      "--strict",
    ];
    const finding =
      "- [WARN MEMORY_ADAPTER_NO_ALLOWED_SKILLS] memory adapter should declare at least one allowed skill";

    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: textResult("BLOCKED", {
        allowedSkills: 0,
        findings: [finding],
      }),
      stderr: "",
    });
    const facadeExpected = {
      exitCode: 0,
      stdout: textResult("CONCERNS", {
        allowedSkills: 0,
        findings: [finding],
      }),
      stderr: "",
    };
    expect(facade("memory-adapter", args, [fixture.root])).toEqual(
      facadeExpected,
    );
    expect(facade("memory", args, [fixture.root])).toEqual(facadeExpected);
  });

  test("CONCERNS exits zero while strict-warning BLOCKED exits one with facade wrapper", () => {
    const fixture = createMemoryRoot(baseConfig({ allowedSkills: [] }));
    const baseArgs = [
      "--source",
      fixture.root,
      "--config",
      fixture.config,
    ];
    const finding =
      "- [WARN MEMORY_ADAPTER_NO_ALLOWED_SKILLS] memory adapter should declare at least one allowed skill";
    const concerns = {
      exitCode: 0,
      stdout: textResult("CONCERNS", {
        allowedSkills: 0,
        findings: [finding],
      }),
      stderr: "",
    };

    expect(standalone(baseArgs, [fixture.root])).toEqual(concerns);
    expect(facade("memory-adapter", baseArgs, [fixture.root])).toEqual(
      concerns,
    );
    expect(facade("memory", baseArgs, [fixture.root])).toEqual(concerns);

    const strictArgs = [...baseArgs, "--strict"];
    const blockedStdout = textResult("BLOCKED", {
      allowedSkills: 0,
      findings: [finding],
    });
    expect(standalone(strictArgs, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: blockedStdout,
      stderr: "",
    });
    const facadeBlocked = {
      exitCode: 1,
      stdout: blockedStdout,
      stderr: facadeFailureStderr(strictArgs, [fixture.root]),
    };
    expect(facade("memory-adapter", strictArgs, [fixture.root])).toEqual(
      facadeBlocked,
    );
    expect(facade("memory", strictArgs, [fixture.root])).toEqual(
      facadeBlocked,
    );
  });

  test("invalid JSON is a result BLOCKED and facade adds command-failure stderr", () => {
    const fixture = createMemoryRoot("{ invalid json\n");
    const args = [
      "--source",
      fixture.root,
      "--config",
      fixture.config,
      "--json",
    ];
    const expectedStdout = invalidJsonResult();
    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: expectedStdout,
      stderr: "",
    });

    for (const command of ["memory-adapter", "memory"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: expectedStdout,
        stderr: facadeFailureStderr(args, [fixture.root]),
      });
    }
  });

  test("semantic error BLOCKED preserves child stdout and facade stderr divergence", () => {
    const fixture = createMemoryRoot(
      baseConfig({
        visibility: "public",
        packageSurface: true,
        adapter: {
          type: "sqlite",
          mode: "read-write",
          path: "docs/memory.db",
        },
        trustPolicy: {
          readOptIn: false,
          writeOptIn: false,
          allowSensitiveMemory: false,
        },
        allowedSkills: ["bad/skill"],
        note: "contains a password marker",
      }),
      "docs/memory-adapter.json",
    );
    const args = ["--source", fixture.root, "--config", fixture.config];
    const expectedStdout = [
      "STATUS: BLOCKED",
      "Adapter: local-memory",
      "Source: <fixture-root-1>",
      "Config file: <fixture-root-1>/docs/memory-adapter.json",
      "Adapter type: sqlite",
      "Adapter mode: read-write",
      "Visibility: private",
      "Package surface: true",
      "Allowed skills: 0",
      "Findings: 8",
      "- [ERROR MEMORY_ADAPTER_CONFIG_PATH_UNSAFE] memory adapter config must live under a local/private project path",
      "- [ERROR MEMORY_ADAPTER_PACKAGE_SURFACE_FORBIDDEN] memory adapter config must not enter package surfaces",
      "- [ERROR MEMORY_ADAPTER_PUBLIC_FORBIDDEN] memory adapter config must remain private/local",
      "- [ERROR MEMORY_ADAPTER_READ_OPT_IN_REQUIRED] memory adapters require explicit read opt-in",
      "- [ERROR MEMORY_ADAPTER_SENSITIVE_TEXT] memory adapter config must not contain secret-looking text",
      "- [ERROR MEMORY_ADAPTER_SKILL_INVALID] allowedSkills entries must be safe skill identifiers",
      "- [ERROR MEMORY_ADAPTER_STORAGE_PATH_UNSAFE] adapter.path must stay under a local/private path",
      "- [ERROR MEMORY_ADAPTER_WRITE_OPT_IN_REQUIRED] read-write memory adapters require explicit write opt-in",
      "",
    ].join("\n");
    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: expectedStdout,
      stderr: "",
    });

    for (const command of ["memory-adapter", "memory"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: expectedStdout,
        stderr: facadeFailureStderr(args, [fixture.root]),
      });
    }
  });

  test("adapter type mcp remains inert descriptor data on every CLI surface", () => {
    const adapterPath = ".skill-sys/memory/inert-mcp-descriptor";
    const fixture = createMemoryRoot(
      baseConfig({
        adapter: {
          type: "mcp",
          mode: "read-only",
          path: adapterPath,
        },
      }),
    );
    const args = [
      "--source",
      fixture.root,
      "--config",
      fixture.config,
      "--json",
    ];
    const expected = {
      exitCode: 0,
      stdout: jsonResult({
        adapterType: "mcp",
        adapterPath,
      }),
      stderr: "",
    };
    const descriptorTarget = path.join(fixture.root, adapterPath);
    const fixtureTreeBefore = fs
      .readdirSync(fixture.root, { recursive: true })
      .map(String)
      .sort();

    expect(fs.existsSync(descriptorTarget)).toBe(false);
    expect(standalone(args, [fixture.root])).toEqual(expected);
    expect(facade("memory-adapter", args, [fixture.root])).toEqual(expected);
    expect(facade("memory", args, [fixture.root])).toEqual(expected);
    expect(fs.existsSync(descriptorTarget)).toBe(false);
    expect(
      fs.readdirSync(fixture.root, { recursive: true }).map(String).sort(),
    ).toEqual(fixtureTreeBefore);
  });

  test("missing required inputs preserve standalone and facade error shapes", () => {
    expect(standalone([])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Missing --source\n",
    });
    for (const command of ["memory-adapter", "memory"] as const) {
      expect(facade(command, [])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: facadeFailureStderr([], [], "ERROR: Missing --source\n"),
      });
    }

    const fixture = createMemoryRoot();
    const args = ["--source", fixture.root];
    const childStderr = "ERROR: Missing --config\n";
    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: childStderr,
    });
    for (const command of ["memory-adapter", "memory"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: facadeFailureStderr(args, [fixture.root], childStderr),
      });
    }
  });

  test("nonexistent and symlinked config errors are sanitized on all surfaces", () => {
    const fixture = createMemoryRoot();
    const missingConfig = path.join(fixture.root, "missing.json");
    const missingArgs = [
      "--source",
      fixture.root,
      "--config",
      missingConfig,
    ];
    const missingError =
      "ERROR: --config does not exist: <fixture-root-1>/missing.json\n";

    expect(standalone(missingArgs, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: missingError,
    });
    expect(facade("memory", missingArgs, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: facadeFailureStderr(
        missingArgs,
        [fixture.root],
        missingError,
      ),
    });

    const link = path.join(fixture.root, "linked-memory.json");
    fs.symlinkSync(fixture.config, link);
    const linkArgs = ["--source", fixture.root, "--config", link];
    const linkError = "ERROR: --config must not be a symlink\n";
    expect(standalone(linkArgs, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: linkError,
    });
    expect(facade("memory-adapter", linkArgs, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: facadeFailureStderr(linkArgs, [fixture.root], linkError),
    });
  });

  test("parser failures preserve standalone and facade diagnostic shapes", () => {
    const standaloneUnknown = standalone(["--wat"]);
    expect(standaloneUnknown).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Unknown argument: --wat\n",
    });
    const facadeUnknown = facade("memory-adapter", ["--wat"]);
    expect(facadeUnknown).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Unknown option: --wat\n",
    });

    const standaloneMissingValue = standalone(["--source"]);
    expect(standaloneMissingValue).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Missing value for --source\n",
    });
    const facadeMissingValue = facade("memory", ["--source"]);
    expect(facadeMissingValue).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Missing value for --source\n",
    });
  });

  test("write appends a JSONL record and read returns it on every surface", () => {
    const fixture = createMemoryRoot(readWriteConfig());
    const writeArgs = ["write", "--source", fixture.root, "--config", fixture.config, "--id", "cli-note", "--memory", "Added from the CLI.", "--source-entry", "cli", "--json"];

    const written = standalone(writeArgs, [fixture.root]);
    expect(written.exitCode).toBe(0);
    expect(written.stderr).toBe("");
    const writeResult = JSON.parse(written.stdout) as {
      status: string;
      operation: string;
      written: boolean;
      id: string;
      entryCount: number;
      output: string;
    };
    expect(writeResult.status).toBe("written");
    expect(writeResult.operation).toBe("write");
    expect(writeResult.written).toBe(true);
    expect(writeResult.id).toBe("cli-note");
    expect(writeResult.entryCount).toBe(1);
    const record = JSON.parse(writeResult.output) as { id: string; memory: string; source: string; createdAt: string };
    expect(record.id).toBe("cli-note");
    expect(record.memory).toBe("Added from the CLI.");
    expect(record.source).toBe("cli");
    expect(typeof record.createdAt).toBe("string");
    expect(JSON.parse(fs.readFileSync(memoryFile(fixture.root), "utf8"))).toEqual({
      ...record,
      source: "cli",
    });

    const readArgs = ["read", "--source", fixture.root, "--config", fixture.config, "--json"];
    const readExpected = {
      exitCode: 0,
      stderr: "",
    };
    expect(standalone(readArgs, [fixture.root])).toMatchObject(readExpected);
    expect(facade("memory-adapter", readArgs, [fixture.root])).toMatchObject(readExpected);
    expect(facade("memory", readArgs, [fixture.root])).toMatchObject(readExpected);
    const readResult = JSON.parse(standalone(readArgs, [fixture.root]).stdout) as {
      status: string;
      operation: string;
      entryCount: number;
      entries: Array<{ id: string; memory: string; source: string; createdAt: string }>;
      findings: unknown[];
    };
    expect(readResult.status).toBe("read");
    expect(readResult.operation).toBe("read");
    expect(readResult.entryCount).toBe(1);
    expect(readResult.entries).toEqual([record]);
    expect(readResult.findings).toEqual([]);
  });

  test("write --dry-run reports what would be written and leaves the JSONL unchanged", () => {
    const fixture = createMemoryRoot(readWriteConfig());
    const args = ["write", "--source", fixture.root, "--config", fixture.config, "--id", "dry-run", "--memory", "not written", "--source-entry", "cli", "--dry-run"];

    const result = standalone(args, [fixture.root]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("STATUS: DRY-RUN");
    expect(result.stdout).toContain("Dry run: true");
    expect(result.stdout).toContain('"id":"dry-run"');
    expect(result.stdout).toContain('"memory":"not written"');
    expect(fs.existsSync(memoryFile(fixture.root))).toBe(false);
  });

  test("write on a read-only adapter is blocked with exit 1 and JSON findings", () => {
    const fixture = createMemoryRoot();
    const args = ["write", "--source", fixture.root, "--config", fixture.config, "--id", "x", "--memory", "y", "--source-entry", "cli", "--json"];

    const result = standalone(args, [fixture.root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { status: string; written: boolean; findings: Array<{ code: string }> };
    expect(parsed.status).toBe("blocked");
    expect(parsed.written).toBe(false);
    expect(parsed.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_WRITE_MODE_REQUIRED"]);
    expect(fs.existsSync(memoryFile(fixture.root))).toBe(false);
  });

  test("write with secret-looking memory is blocked with exit 1", () => {
    const fixture = createMemoryRoot(readWriteConfig());
    const args = ["write", "--source", fixture.root, "--config", fixture.config, "--id", "leaky", "--memory", "contains a password marker", "--source-entry", "cli", "--json"];

    const result = standalone(args, [fixture.root]);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { status: string; findings: Array<{ code: string }> };
    expect(parsed.status).toBe("blocked");
    expect(parsed.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_SENSITIVE_TEXT"]);
    expect(fs.existsSync(memoryFile(fixture.root))).toBe(false);
  });

  test("read on a non-jsonl adapter is blocked with MEMORY_ADAPTER_TYPE_UNSUPPORTED", () => {
    const fixture = createMemoryRoot(
      baseConfig({
        adapter: { type: "sqlite", mode: "read-only", path: ".skill-sys/memory/local.db" },
      }),
    );
    const args = ["read", "--source", fixture.root, "--config", fixture.config, "--json"];

    const result = standalone(args, [fixture.root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { status: string; findings: Array<{ code: string }> };
    expect(parsed.status).toBe("blocked");
    expect(parsed.findings.map((finding) => finding.code)).toEqual(["MEMORY_ADAPTER_TYPE_UNSUPPORTED"]);
  });

  test("write without --id or --memory fails clearly on all surfaces", () => {
    const fixture = createMemoryRoot(readWriteConfig());

    const missingId = standalone(["write", "--source", fixture.root, "--config", fixture.config, "--memory", "x"], [fixture.root]);
    expect(missingId.exitCode).toBe(1);
    expect(missingId.stdout).toBe("");
    expect(missingId.stderr).toBe("ERROR: Missing --id\n");
    expect(facade("memory", ["write", "--source", fixture.root, "--config", fixture.config, "--memory", "x"], [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: facadeFailureStderr(
        ["write", "--source", fixture.root, "--config", fixture.config, "--memory", "x"],
        [fixture.root],
        "ERROR: Missing --id\n",
      ),
    });

    const missingMemory = standalone(["write", "--source", fixture.root, "--config", fixture.config, "--id", "x"], [fixture.root]);
    expect(missingMemory.exitCode).toBe(1);
    expect(missingMemory.stdout).toBe("");
    expect(missingMemory.stderr).toBe("ERROR: Missing --memory\n");

    const missingSourceEntry = standalone(["write", "--source", fixture.root, "--config", fixture.config, "--id", "x", "--memory", "y"], [fixture.root]);
    expect(missingSourceEntry.exitCode).toBe(1);
    expect(missingSourceEntry.stdout).toBe("");
    expect(missingSourceEntry.stderr).toBe("ERROR: Missing --source-entry\n");
  });
});
