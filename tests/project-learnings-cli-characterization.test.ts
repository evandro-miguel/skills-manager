import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const standaloneCommand = path.join(
  repoRoot,
  "scripts",
  "commands",
  "project-learnings.ts",
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

type LearningsFixture = Readonly<{ root: string; learnings: string }>;

function sensitiveTrigger(): string {
  return ["pass", "word"].join("");
}

function baseLearnings(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "local-learnings",
    visibility: "private",
    packageSurface: false,
    entries: [
      {
        id: "use-bun",
        summary: "Use Bun scripts for local validation.",
        source: "local",
        tags: ["workflow"],
      },
    ],
    ...overrides,
  };
}

function createLearningsRoot(
  value: unknown = baseLearnings(),
  fileName = ".skill-sys/project-learnings.json",
): LearningsFixture {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "project-learnings-cli-characterization-"),
  );
  temporaryRoots.push(root);
  const learnings = path.join(root, fileName);
  fs.mkdirSync(path.dirname(learnings), { recursive: true });
  fs.writeFileSync(
    learnings,
    typeof value === "string"
      ? value
      : `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  return { root, learnings };
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
  command: "project-learnings" | "learnings",
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
    fileName?: string;
    learningsName?: string;
    visibility?: "private" | "local";
    packageSurface?: boolean;
    entries?: number;
    findings?: readonly string[];
  }> = {},
): string {
  const fixture = options.fixture ?? 1;
  const findings = options.findings ?? [];
  return [
    `STATUS: ${status}`,
    `Learnings: ${options.learningsName ?? "local-learnings"}`,
    `Source: <fixture-root-${fixture}>`,
    `Learnings file: <fixture-root-${fixture}>/${
      options.fileName ?? ".skill-sys/project-learnings.json"
    }`,
    `Visibility: ${options.visibility ?? "private"}`,
    `Package surface: ${options.packageSurface ?? false}`,
    `Entries: ${options.entries ?? 1}`,
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
    entries?: number;
    findings?: readonly Record<string, unknown>[];
  }> = {},
): string {
  const fixture = options.fixture ?? 1;
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      command: "project-learnings",
      status: options.status ?? "PASS",
      source: `<fixture-root-${fixture}>`,
      learnings:
        `<fixture-root-${fixture}>/.skill-sys/project-learnings.json`,
      strict: options.strict ?? false,
      learningsName: "local-learnings",
      entryCount: options.entries ?? 1,
      policy: {
        visibility: "private",
        packageSurface: false,
        localOnly: true,
      },
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
      command: "project-learnings",
      status: "BLOCKED",
      source: "<fixture-root-1>",
      learnings: "<fixture-root-1>/.skill-sys/project-learnings.json",
      strict: false,
      learningsName: "",
      entryCount: 0,
      policy: {
        visibility: "private",
        packageSurface: false,
        localOnly: true,
      },
      findings: [
        {
          level: "ERROR",
          code: "PROJECT_LEARNINGS_INVALID_JSON",
          path: ".skill-sys/project-learnings.json",
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
      "Manage local/private project learnings without publishing them",
      "",
      "Usage:",
      "  bun scripts/commands/project-learnings.ts [validate] --source <dir> --learnings <file> [options]",
      "  bun scripts/commands/project-learnings.ts append --source <dir> --learnings <file> --id <id> --summary <text> --source-entry <text> [options]",
      "  bun scripts/commands/project-learnings.ts update --source <dir> --learnings <file> --id <id> --summary <text> [options]",
      "",
      "Commands:",
      "  validate             Validate learnings (default)",
      "  append               Add a new learning entry",
      "  update               Replace an existing entry's summary",
      "",
      "Options:",
      "  --source <dir>       Project/source root",
      "  --learnings <file>   Project learnings JSON file",
      "  --id <id>            Entry id (append/update)",
      "  --summary <text>     Entry summary (append/update)",
      "  --source-entry <text> Entry source/origin (append)",
      "  --json               Emit machine-readable output",
      "  --dry-run            Print what would be written without writing",
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

describe("F-04.01 project-learnings CLI characterization", () => {
  test("canonical standalone, facade, and alias preserve exact PASS text bytes", () => {
    const fixture = createLearningsRoot();
    const args = [
      "--source",
      fixture.root,
      "--learnings",
      fixture.learnings,
    ];
    const expected = {
      exitCode: 0,
      stdout: textResult("PASS"),
      stderr: "",
    };

    expect(standalone(args, [fixture.root])).toEqual(expected);
    expect(facade("project-learnings", args, [fixture.root])).toEqual(
      expected,
    );
    expect(facade("learnings", args, [fixture.root])).toEqual(expected);
  });

  test("canonical standalone, facade, and alias preserve exact PASS JSON bytes", () => {
    const fixture = createLearningsRoot();
    const args = [
      "--source",
      fixture.root,
      "--learnings",
      fixture.learnings,
      "--json",
    ];
    const expected = {
      exitCode: 0,
      stdout: jsonResult(),
      stderr: "",
    };

    expect(standalone(args, [fixture.root])).toEqual(expected);
    expect(facade("project-learnings", args, [fixture.root])).toEqual(
      expected,
    );
    expect(facade("learnings", args, [fixture.root])).toEqual(expected);
  });

  test("standalone help, short-help, and repeated help are idempotent", () => {
    const expected = helpResult();
    expect(standalone(["--help"])).toEqual(expected);
    expect(standalone(["-h"])).toEqual(expected);
    expect(standalone(["--help", "--help"])).toEqual(expected);
  });

  test("facade and alias forward one long-help occurrence", () => {
    const expected = helpResult();
    expect(facade("project-learnings", ["--help"])).toEqual(expected);
    expect(facade("learnings", ["--help"])).toEqual(expected);
  });

  test("facade and alias drop short-help and repeated long-help", () => {
    const droppedHelp = {
      exitCode: 1,
      stdout: "",
      stderr: facadeFailureStderr([], [], "ERROR: Missing --source\n"),
    };
    expect(facade("project-learnings", ["-h"])).toEqual(droppedHelp);
    expect(facade("learnings", ["-h"])).toEqual(droppedHelp);
    expect(
      facade("project-learnings", ["--help", "--help"]),
    ).toEqual(droppedHelp);
    expect(facade("learnings", ["--help", "--help"])).toEqual(droppedHelp);
  });

  test("duplicate scalar options are last-wins on all surfaces", () => {
    const first = createLearningsRoot(
      baseLearnings({ name: "first-learnings" }),
    );
    const last = createLearningsRoot();
    const args = [
      "--source",
      first.root,
      "--source",
      last.root,
      "--learnings",
      first.learnings,
      "--learnings",
      last.learnings,
    ];
    const fixtureRoots = [first.root, last.root];
    const expected = {
      exitCode: 0,
      stdout: textResult("PASS", { fixture: 2 }),
      stderr: "",
    };

    expect(standalone(args, fixtureRoots)).toEqual(expected);
    expect(facade("project-learnings", args, fixtureRoots)).toEqual(expected);
    expect(facade("learnings", args, fixtureRoots)).toEqual(expected);
  });

  test("duplicate json is idempotent standalone but dropped by facade and alias", () => {
    const fixture = createLearningsRoot();
    const args = [
      "--source",
      fixture.root,
      "--learnings",
      fixture.learnings,
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
    expect(facade("project-learnings", args, [fixture.root])).toEqual(
      facadeExpected,
    );
    expect(facade("learnings", args, [fixture.root])).toEqual(facadeExpected);
  });

  test("duplicate strict changes standalone BLOCKED into facade CONCERNS", () => {
    const fixture = createLearningsRoot(baseLearnings({ entries: [] }));
    const args = [
      "--source",
      fixture.root,
      "--learnings",
      fixture.learnings,
      "--strict",
      "--strict",
    ];
    const finding =
      "- [WARN PROJECT_LEARNINGS_EMPTY] project learnings should declare at least one entry";

    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: textResult("BLOCKED", {
        entries: 0,
        findings: [finding],
      }),
      stderr: "",
    });
    const facadeExpected = {
      exitCode: 0,
      stdout: textResult("CONCERNS", {
        entries: 0,
        findings: [finding],
      }),
      stderr: "",
    };
    expect(facade("project-learnings", args, [fixture.root])).toEqual(
      facadeExpected,
    );
    expect(facade("learnings", args, [fixture.root])).toEqual(facadeExpected);
  });

  test("CONCERNS exits zero while strict-warning BLOCKED exits one with facade wrapper", () => {
    const fixture = createLearningsRoot(baseLearnings({ entries: [] }));
    const baseArgs = [
      "--source",
      fixture.root,
      "--learnings",
      fixture.learnings,
    ];
    const finding =
      "- [WARN PROJECT_LEARNINGS_EMPTY] project learnings should declare at least one entry";
    const concerns = {
      exitCode: 0,
      stdout: textResult("CONCERNS", {
        entries: 0,
        findings: [finding],
      }),
      stderr: "",
    };

    expect(standalone(baseArgs, [fixture.root])).toEqual(concerns);
    expect(facade("project-learnings", baseArgs, [fixture.root])).toEqual(
      concerns,
    );
    expect(facade("learnings", baseArgs, [fixture.root])).toEqual(concerns);

    const strictArgs = [...baseArgs, "--strict"];
    const blockedStdout = textResult("BLOCKED", {
      entries: 0,
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
    expect(
      facade("project-learnings", strictArgs, [fixture.root]),
    ).toEqual(facadeBlocked);
    expect(facade("learnings", strictArgs, [fixture.root])).toEqual(
      facadeBlocked,
    );
  });

  test("invalid JSON is a result BLOCKED and facade adds command-failure stderr", () => {
    const fixture = createLearningsRoot("{ invalid json\n");
    const args = [
      "--source",
      fixture.root,
      "--learnings",
      fixture.learnings,
      "--json",
    ];
    const expectedStdout = invalidJsonResult();
    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: expectedStdout,
      stderr: "",
    });

    for (const command of ["project-learnings", "learnings"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: expectedStdout,
        stderr: facadeFailureStderr(args, [fixture.root]),
      });
    }
  });

  test("semantic and privacy errors preserve exact BLOCKED bytes", () => {
    const fixture = createLearningsRoot(
      baseLearnings({
        visibility: "public",
        packageSurface: true,
        entries: [
          {
            id: "local-rule",
            summary: `contains a ${sensitiveTrigger()} marker`,
            source: "local",
          },
        ],
      }),
      "docs/project-learnings.json",
    );
    const args = [
      "--source",
      fixture.root,
      "--learnings",
      fixture.learnings,
    ];
    const expectedStdout = textResult("BLOCKED", {
      fileName: "docs/project-learnings.json",
      packageSurface: true,
      entries: 1,
      findings: [
        "- [ERROR PROJECT_LEARNINGS_PACKAGE_SURFACE_FORBIDDEN] project learnings must not enter package surfaces",
        "- [ERROR PROJECT_LEARNINGS_PATH_UNSAFE] project learnings must live under a local/private project path",
        "- [ERROR PROJECT_LEARNINGS_PUBLIC_FORBIDDEN] project learnings must remain private/local",
        "- [ERROR PROJECT_LEARNINGS_SENSITIVE_TEXT] project learnings must not contain secret-looking text",
      ],
    });
    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: expectedStdout,
      stderr: "",
    });
    for (const command of ["project-learnings", "learnings"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: expectedStdout,
        stderr: facadeFailureStderr(args, [fixture.root]),
      });
    }
  });

  test("missing required inputs preserve standalone and facade error shapes", () => {
    expect(standalone([])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Missing --source\n",
    });
    for (const command of ["project-learnings", "learnings"] as const) {
      expect(facade(command, [])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: facadeFailureStderr([], [], "ERROR: Missing --source\n"),
      });
    }

    const fixture = createLearningsRoot();
    const args = ["--source", fixture.root];
    const childStderr = "ERROR: Missing --learnings\n";
    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: childStderr,
    });
    for (const command of ["project-learnings", "learnings"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: facadeFailureStderr(args, [fixture.root], childStderr),
      });
    }
  });

  test("nonexistent source and learnings errors sanitize raw paths", () => {
    const fixture = createLearningsRoot();
    const missingSource = path.join(fixture.root, "missing-source");
    const missingSourceArgs = [
      "--source",
      missingSource,
      "--learnings",
      fixture.learnings,
    ];
    const sourceError =
      "ERROR: --source does not exist: <fixture-root-1>/missing-source\n";
    expect(standalone(missingSourceArgs, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: sourceError,
    });
    expect(
      facade("learnings", missingSourceArgs, [fixture.root]),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: facadeFailureStderr(
        missingSourceArgs,
        [fixture.root],
        sourceError,
      ),
    });

    const missingLearnings = path.join(fixture.root, "missing.json");
    const missingLearningsArgs = [
      "--source",
      fixture.root,
      "--learnings",
      missingLearnings,
    ];
    const learningsError =
      "ERROR: --learnings does not exist: <fixture-root-1>/missing.json\n";
    expect(standalone(missingLearningsArgs, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: learningsError,
    });
    expect(
      facade("project-learnings", missingLearningsArgs, [fixture.root]),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: facadeFailureStderr(
        missingLearningsArgs,
        [fixture.root],
        learningsError,
      ),
    });
  });

  test("symlinked learnings errors are exact on all surfaces", () => {
    const fixture = createLearningsRoot();
    const link = path.join(fixture.root, "linked-learnings.json");
    fs.symlinkSync(fixture.learnings, link);
    const args = ["--source", fixture.root, "--learnings", link];
    const childStderr = "ERROR: --learnings must not be a symlink\n";

    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: childStderr,
    });
    for (const command of ["project-learnings", "learnings"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: facadeFailureStderr(args, [fixture.root], childStderr),
      });
    }
  });

  test("facade rejects unknown project-learnings subcommands instead of silently validating", () => {
    const result = facade("project-learnings", [
      "bogus",
      "--source",
      "x",
      "--learnings",
      "y",
    ]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "ERROR: Usage: skill-sys project-learnings [validate|append|update] --source <dir> --learnings <file> [--id <id> --summary <text> [--source-entry <text>]] [options]\n",
    });
  });

  test("facade forwards append and update subcommands with their options", () => {
    const fixture = createLearningsRoot();
    const appendArgs = [
      "append",
      "--source",
      fixture.root,
      "--learnings",
      fixture.learnings,
      "--id",
      "cli-characterization-entry",
      "--summary",
      "Added through the facade.",
      "--source-entry",
      "cli",
      "--json",
    ];
    const appendResult = facade("project-learnings", appendArgs, [
      fixture.root,
    ]);
    expect(appendResult.exitCode).toBe(0);
    const written = JSON.parse(
      fs.readFileSync(fixture.learnings, "utf8"),
    ) as { entries: Array<{ id: string; summary: string; source: string }> };
    expect(
      written.entries.some(
        (entry) =>
          entry.id === "cli-characterization-entry" &&
          entry.source === "cli" &&
          entry.summary === "Added through the facade.",
      ),
    ).toBe(true);

    const updateArgs = [
      "update",
      "--source",
      fixture.root,
      "--learnings",
      fixture.learnings,
      "--id",
      "cli-characterization-entry",
      "--summary",
      "Updated through the facade.",
      "--json",
    ];
    const updateResult = facade("project-learnings", updateArgs, [
      fixture.root,
    ]);
    expect(updateResult.exitCode).toBe(0);
    const updated = JSON.parse(
      fs.readFileSync(fixture.learnings, "utf8"),
    ) as { entries: Array<{ id: string; summary: string; source: string }> };
    expect(updated.entries).toContainEqual({
      id: "cli-characterization-entry",
      summary: "Updated through the facade.",
      source: "cli",
    });
  });

  test("parser failures preserve standalone and facade diagnostic shapes", () => {
    const standaloneUnknown = standalone(["--wat"]);
    expect(standaloneUnknown).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Unknown argument: --wat\n",
    });
    const facadeUnknown = facade("project-learnings", ["--wat"]);
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
    const facadeMissingValue = facade("learnings", ["--source"]);
    expect(facadeMissingValue).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Missing value for --source\n",
    });
  });
});
