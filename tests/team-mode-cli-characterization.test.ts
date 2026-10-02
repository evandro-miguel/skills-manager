import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const standaloneCommand = path.join(
  repoRoot,
  "scripts",
  "commands",
  "team-mode.ts",
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

type TeamFixture = Readonly<{ root: string; config: string }>;

function baseConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "default-team",
    lockfile: ".skills.lock.json",
    installMode: "projection",
    sharedConfig: true,
    adapters: ["codex", "opencode"],
    allowedProfiles: ["core"],
    ...overrides,
  };
}

function createTeamRoot(
  configValue: unknown = baseConfig(),
  fileName = "skill-sys.team.json",
): TeamFixture {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "team-mode-cli-characterization-"),
  );
  temporaryRoots.push(root);
  const config = path.join(root, fileName);
  fs.writeFileSync(
    config,
    typeof configValue === "string"
      ? configValue
      : `${JSON.stringify(configValue, null, 2)}\n`,
    "utf8",
  );
  return { root, config };
}

function run(command: readonly string[], fixtureRoots: readonly string[] = []): CliResult {
  const result = Bun.spawnSync({
    cmd: ["bun", ...command],
    cwd: repoRoot,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
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
  command: "team-mode" | "team",
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
    teamName?: string;
    installMode?: "projection" | "copy";
    lockfile?: string;
    sharedConfig?: boolean | null;
    adapters?: number;
    profiles?: number;
    findings?: readonly string[];
  }> = {},
): string {
  const fixture = options.fixture ?? 1;
  const findings = options.findings ?? [];
  return [
    `STATUS: ${status}`,
    `Team: ${options.teamName ?? "default-team"}`,
    `Source: <fixture-root-${fixture}>`,
    `Config: <fixture-root-${fixture}>/skill-sys.team.json`,
    `Install mode: ${options.installMode ?? "projection"}`,
    `Lockfile: ${options.lockfile ?? ".skills.lock.json"}`,
    `Shared config: ${
      options.sharedConfig === null
        ? "<undeclared>"
        : String(options.sharedConfig ?? true)
    }`,
    `Adapters: ${options.adapters ?? 2}`,
    `Profiles: ${options.profiles ?? 1}`,
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
    sharedConfig?: boolean | null;
    findings?: readonly Record<string, unknown>[];
  }> = {},
): string {
  const fixture = options.fixture ?? 1;
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      command: "team-mode",
      status: options.status ?? "PASS",
      source: `<fixture-root-${fixture}>`,
      config: `<fixture-root-${fixture}>/skill-sys.team.json`,
      strict: options.strict ?? false,
      teamName: "default-team",
      policy: {
        lockfile: ".skills.lock.json",
        installMode: "projection",
        sharedConfig: options.sharedConfig === undefined
          ? true
          : options.sharedConfig,
        adapters: ["codex", "opencode"],
        allowedProfiles: ["core"],
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
      command: "team-mode",
      status: "BLOCKED",
      source: "<fixture-root-1>",
      config: "<fixture-root-1>/skill-sys.team.json",
      strict: false,
      teamName: "",
      policy: {
        lockfile: "",
        installMode: "projection",
        sharedConfig: null,
        adapters: [],
        allowedProfiles: [],
      },
      findings: [
        {
          level: "ERROR",
          code: "TEAM_MODE_CONFIG_INVALID_JSON",
          path: "skill-sys.team.json",
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
      "Validate a deterministic team-mode configuration",
      "",
      "Usage:",
      "  bun scripts/commands/team-mode.ts --source <dir> --config <file> [options]",
      "",
      "Options:",
      "  --source <dir>    Source/project root for relative policy validation",
      "  --config <file>   Team-mode JSON config file",
      "  --json            Emit machine-readable output",
      "  --strict          Treat warnings as blocking",
      "  --help            Show help",
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

describe("F-04.01 team-mode CLI characterization", () => {
  test("canonical standalone, facade, and alias preserve exact PASS text bytes", () => {
    const fixture = createTeamRoot();
    const args = ["--source", fixture.root, "--config", fixture.config];
    const expected = {
      exitCode: 0,
      stdout: textResult("PASS"),
      stderr: "",
    };

    expect(standalone(args, [fixture.root])).toEqual(expected);
    expect(facade("team-mode", args, [fixture.root])).toEqual(expected);
    expect(facade("team", args, [fixture.root])).toEqual(expected);
  });

  test("canonical standalone, facade, and alias preserve exact PASS JSON bytes", () => {
    const fixture = createTeamRoot();
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
    expect(facade("team-mode", args, [fixture.root])).toEqual(expected);
    expect(facade("team", args, [fixture.root])).toEqual(expected);
  });

  test("standalone help, short-help, and repeated help are idempotent", () => {
    const expected = helpResult();
    expect(standalone(["--help"])).toEqual(expected);
    expect(standalone(["-h"])).toEqual(expected);
    expect(standalone(["--help", "--help"])).toEqual(expected);
  });

  test("facade and alias forward one long-help occurrence", () => {
    const expected = helpResult();
    expect(facade("team-mode", ["--help"])).toEqual(expected);
    expect(facade("team", ["--help"])).toEqual(expected);
  });

  test("facade and alias drop short-help and repeated long-help", () => {
    const droppedHelp = {
      exitCode: 1,
      stdout: "",
      stderr: facadeFailureStderr([], [], "ERROR: Missing --source\n"),
    };
    expect(facade("team-mode", ["-h"])).toEqual(droppedHelp);
    expect(facade("team", ["-h"])).toEqual(droppedHelp);
    expect(facade("team-mode", ["--help", "--help"])).toEqual(droppedHelp);
    expect(facade("team", ["--help", "--help"])).toEqual(droppedHelp);
  });

  test("duplicate scalar options are last-wins on all surfaces", () => {
    const first = createTeamRoot(baseConfig({ name: "first-team" }));
    const last = createTeamRoot();
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
    expect(facade("team-mode", args, fixtureRoots)).toEqual(expected);
    expect(facade("team", args, fixtureRoots)).toEqual(expected);
  });

  test("duplicate json is idempotent standalone but dropped by facade and alias", () => {
    const fixture = createTeamRoot();
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
    expect(facade("team-mode", args, [fixture.root])).toEqual(facadeExpected);
    expect(facade("team", args, [fixture.root])).toEqual(facadeExpected);
  });

  test("duplicate strict changes standalone BLOCKED into facade CONCERNS", () => {
    const fixture = createTeamRoot(baseConfig({ sharedConfig: undefined }));
    const args = [
      "--source",
      fixture.root,
      "--config",
      fixture.config,
      "--strict",
      "--strict",
    ];
    const finding =
      "- [WARN TEAM_MODE_SHARED_CONFIG_UNDECLARED] sharedConfig should be explicit true or false";

    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: textResult("BLOCKED", {
        sharedConfig: null,
        findings: [finding],
      }),
      stderr: "",
    });
    const facadeExpected = {
      exitCode: 0,
      stdout: textResult("CONCERNS", {
        sharedConfig: null,
        findings: [finding],
      }),
      stderr: "",
    };
    expect(facade("team-mode", args, [fixture.root])).toEqual(facadeExpected);
    expect(facade("team", args, [fixture.root])).toEqual(facadeExpected);
  });

  test("CONCERNS exits zero while strict-warning BLOCKED exits one with facade wrapper", () => {
    const fixture = createTeamRoot(baseConfig({ sharedConfig: undefined }));
    const baseArgs = [
      "--source",
      fixture.root,
      "--config",
      fixture.config,
    ];
    const finding =
      "- [WARN TEAM_MODE_SHARED_CONFIG_UNDECLARED] sharedConfig should be explicit true or false";
    const concerns = {
      exitCode: 0,
      stdout: textResult("CONCERNS", {
        sharedConfig: null,
        findings: [finding],
      }),
      stderr: "",
    };

    expect(standalone(baseArgs, [fixture.root])).toEqual(concerns);
    expect(facade("team-mode", baseArgs, [fixture.root])).toEqual(concerns);
    expect(facade("team", baseArgs, [fixture.root])).toEqual(concerns);

    const strictArgs = [...baseArgs, "--strict"];
    const blockedStdout = textResult("BLOCKED", {
      sharedConfig: null,
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
    expect(facade("team-mode", strictArgs, [fixture.root])).toEqual(
      facadeBlocked,
    );
    expect(facade("team", strictArgs, [fixture.root])).toEqual(facadeBlocked);
  });

  test("invalid JSON is a result BLOCKED and facade adds command-failure stderr", () => {
    const fixture = createTeamRoot("{ invalid json\n");
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

    for (const command of ["team-mode", "team"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: expectedStdout,
        stderr: facadeFailureStderr(args, [fixture.root]),
      });
    }
  });

  test("semantic error BLOCKED preserves child stdout and facade stderr divergence", () => {
    const fixture = createTeamRoot(
      baseConfig({
        lockfile: "../outside.lock.json",
        installMode: "symlink",
        adapters: ["unknown-agent"],
        skills: ["embedded"],
      }),
    );
    const args = ["--source", fixture.root, "--config", fixture.config];
    const expectedStdout = textResult("BLOCKED", {
      lockfile: "../outside.lock.json",
      adapters: 1,
      findings: [
        "- [ERROR TEAM_MODE_ADAPTER_UNSUPPORTED] Unsupported adapter: unknown-agent",
        "- [ERROR TEAM_MODE_CATALOG_EMBEDDED] team mode stores config and lockfile references, not embedded skill catalogs",
        "- [ERROR TEAM_MODE_LOCKFILE_UNSAFE] lockfile must be a safe project-relative path",
        "- [ERROR TEAM_MODE_SYMLINK_FORBIDDEN] team mode config must not enable symlink installs",
      ],
    });
    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: expectedStdout,
      stderr: "",
    });

    for (const command of ["team-mode", "team"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: expectedStdout,
        stderr: facadeFailureStderr(args, [fixture.root]),
      });
    }
  });

  test("missing source preserves standalone and facade error shapes", () => {
    expect(standalone([])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Missing --source\n",
    });
    expect(facade("team-mode", [])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: facadeFailureStderr([], [], "ERROR: Missing --source\n"),
    });
    expect(facade("team", [])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: facadeFailureStderr([], [], "ERROR: Missing --source\n"),
    });
  });

  test("missing config preserves exact bytes and exits on all surfaces", () => {
    const fixture = createTeamRoot();
    const args = ["--source", fixture.root];
    const childStderr = "ERROR: Missing --config\n";

    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: childStderr,
    });
    for (const command of ["team-mode", "team"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: facadeFailureStderr(args, [fixture.root], childStderr),
      });
    }
  });

  test("nonexistent config preserves exact bytes and exits on all surfaces", () => {
    const fixture = createTeamRoot();
    const missingConfig = path.join(fixture.root, "missing.json");
    const args = [
      "--source",
      fixture.root,
      "--config",
      missingConfig,
    ];
    const childStderr =
      "ERROR: --config does not exist: <fixture-root-1>/missing.json\n";

    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: childStderr,
    });
    for (const command of ["team-mode", "team"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: facadeFailureStderr(args, [fixture.root], childStderr),
      });
    }
  });

  test("symlinked config preserves exact bytes and exits on all surfaces", () => {
    const fixture = createTeamRoot();
    const link = path.join(fixture.root, "linked-team.json");
    fs.symlinkSync(fixture.config, link);
    const args = ["--source", fixture.root, "--config", link];
    const childStderr = "ERROR: --config must not be a symlink\n";

    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: childStderr,
    });
    for (const command of ["team-mode", "team"] as const) {
      expect(facade(command, args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: facadeFailureStderr(args, [fixture.root], childStderr),
      });
    }
  });

  test("parser failures preserve standalone and facade diagnostic shapes", () => {
    const standaloneUnknown = standalone(["--wat"]);
    expect(standaloneUnknown).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Unknown argument: --wat\n",
    });
    const facadeUnknown = facade("team-mode", ["--wat"]);
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
    const facadeMissingValue = facade("team", ["--source"]);
    expect(facadeMissingValue).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Missing value for --source\n",
    });
  });
});
