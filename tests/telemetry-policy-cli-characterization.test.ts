import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const standaloneCommand = path.join(
  repoRoot,
  "scripts",
  "commands",
  "telemetry-policy.ts",
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

function createPolicyRoot(
  policy: Record<string, unknown> = {},
): Readonly<{ root: string; config: string }> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "telemetry-policy-cli-characterization-"),
  );
  temporaryRoots.push(root);
  const config = path.join(root, ".skill-sys", "telemetry-policy.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(
    config,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name: "local-telemetry-policy",
        visibility: "private",
        packageSurface: false,
        collection: {
          enabled: false,
          explicitOptIn: false,
          approvedBy: "",
        },
        transports: { remoteUrls: [], localOnly: true },
        allowedSkills: ["registry-trust"],
        ...policy,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { root, config };
}

function run(command: readonly string[], fixtureRoot?: string): CliResult {
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
    if (fixtureRoot !== undefined) {
      text = text.split(fixtureRoot).join("<fixture-root>");
    }
    return text
      .split(repoRoot)
      .join("<repo-root>")
      .replaceAll("\r\n", "\n")
      .replace(/Bun v[^\n]+\n/gu, "<bun-runtime>\n");
  };
  return {
    exitCode: result.exitCode,
    stdout: sanitize(result.stdout),
    stderr: sanitize(result.stderr),
  };
}

function standalone(args: readonly string[], fixtureRoot?: string): CliResult {
  return run([standaloneCommand, ...args], fixtureRoot);
}

function facade(
  command: "telemetry-policy" | "telemetry",
  args: readonly string[],
  fixtureRoot?: string,
): CliResult {
  return run([facadeCommand, command, ...args], fixtureRoot);
}

function facadeChildFailure(
  childError: string,
  args: readonly string[],
  fixtureRoot?: string,
): CliResult {
  let commandLine = ["bun", standaloneCommand, ...args].join(" ");
  if (fixtureRoot !== undefined) {
    commandLine = commandLine
      .split(fixtureRoot)
      .join("<fixture-root>");
  }
  commandLine = commandLine.split(repoRoot).join("<repo-root>");
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${childError}ERROR: Command failed (1): ${commandLine}\n`,
  };
}

function textResult(
  status: "PASS" | "CONCERNS" | "BLOCKED",
  options: Readonly<{
    strict?: boolean;
    allowedSkillCount?: number;
    collectionEnabled?: boolean;
    explicitOptIn?: boolean;
    localOnly?: boolean;
    remoteUrlCount?: number;
    findings?: readonly string[];
  }> = {},
): string {
  const findings = options.findings ?? [];
  return [
    `STATUS: ${status}`,
    "Policy: local-telemetry-policy",
    "Source: <fixture-root>",
    "Config: <fixture-root>/.skill-sys/telemetry-policy.json",
    `Collection enabled: ${options.collectionEnabled ?? false}`,
    `Explicit opt-in: ${options.explicitOptIn ?? false}`,
    `Local only: ${options.localOnly ?? true}`,
    `Remote URLs: ${options.remoteUrlCount ?? 0}`,
    `Allowed skills: ${options.allowedSkillCount ?? 1}`,
    `Findings: ${findings.length}`,
    ...findings,
    "",
  ].join("\n");
}

function jsonResult(
  options: Readonly<{
    strict?: boolean;
    allowedSkills?: number;
  }> = {},
): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      command: "telemetry-policy",
      status: "PASS",
      source: "<fixture-root>",
      config: "<fixture-root>/.skill-sys/telemetry-policy.json",
      strict: options.strict ?? false,
      policyName: "local-telemetry-policy",
      collection: {
        enabled: false,
        explicitOptIn: false,
        approvedBy: "",
      },
      transports: { remoteUrls: [], localOnly: true },
      allowedSkillCount: options.allowedSkills ?? 1,
      findings: [],
    },
    null,
    2,
  )}\n`;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("F-04.01 opening telemetry-policy CLI characterization", () => {
  test("canonical standalone, facade, and alias preserve exact PASS text bytes", () => {
    const { root, config } = createPolicyRoot();
    const args = ["--source", root, "--config", config];
    const expected = {
      exitCode: 0,
      stdout: textResult("PASS"),
      stderr: "",
    };

    expect(standalone(args, root)).toEqual(expected);
    expect(facade("telemetry-policy", args, root)).toEqual(expected);
    expect(facade("telemetry", args, root)).toEqual(expected);
  });

  test("standalone and facade preserve exact JSON bytes", () => {
    const { root, config } = createPolicyRoot();
    const args = ["--source", root, "--config", config, "--json"];
    const expected = {
      exitCode: 0,
      stdout: jsonResult(),
      stderr: "",
    };

    expect(standalone(args, root)).toEqual(expected);
    expect(facade("telemetry-policy", args, root)).toEqual(expected);
    expect(facade("telemetry", args, root)).toEqual(expected);
  });

  test("help and short-help preserve the facade divergence", () => {
    const help = [
      "",
      "Validate a local telemetry policy without collecting or sending telemetry",
      "",
      "Usage:",
      "  bun scripts/commands/telemetry-policy.ts --source <dir> --config <file> [options]",
      "  bun scripts/commands/telemetry-policy.ts collect --source <dir> --config <file> --output <file> --event <name> --skill <name> [options]",
      "",
      "Options:",
      "  --source <dir>   Repository/source root",
      "  --config <file>  Local telemetry policy JSON",
      "  --output <file>  Local/private JSONL output (collect)",
      "  --event <name>   Caller-supplied event name (collect)",
      "  --skill <name>   Policy-approved skill name (collect)",
      "  --json           Emit machine-readable output",
      "  --dry-run        Render event without writing (collect)",
      "  --strict         Treat warnings as blocking",
      "  --help           Show help",
      "",
      "",
    ].join("\n");
    const expectedHelp = { exitCode: 0, stdout: help, stderr: "" };

    expect(standalone(["--help"])).toEqual(expectedHelp);
    expect(standalone(["-h"])).toEqual(expectedHelp);
    expect(standalone(["--help", "--help"])).toEqual(expectedHelp);
    expect(facade("telemetry-policy", ["--help"])).toEqual(expectedHelp);
    expect(facade("telemetry", ["--help"])).toEqual(expectedHelp);
    expect(facade("telemetry-policy", ["-h"])).toEqual(
      facadeChildFailure("ERROR: Missing --source\n", []),
    );
    const droppedDuplicateHelp = facadeChildFailure(
      "ERROR: Missing --source\n",
      [],
    );
    expect(facade("telemetry-policy", ["--help", "--help"])).toEqual(
      droppedDuplicateHelp,
    );
    expect(facade("telemetry", ["--help", "--help"])).toEqual(
      droppedDuplicateHelp,
    );
  });

  test("duplicate scalar options are last-wins on both surfaces", () => {
    const first = createPolicyRoot({
      name: "first-policy-must-not-be-selected",
    });
    const last = createPolicyRoot();
    const duplicateArgs = [
      "--source",
      first.root,
      "--source",
      last.root,
      "--config",
      first.config,
      "--config",
      last.config,
    ];
    const expected = {
      exitCode: 0,
      stdout: textResult("PASS"),
      stderr: "",
    };

    expect(standalone(duplicateArgs, last.root)).toEqual(expected);
    expect(facade("telemetry-policy", duplicateArgs, last.root)).toEqual(
      expected,
    );
  });

  test("collect is opt-in only and writes only through the explicit standalone command", () => {
    const disabled = createPolicyRoot();
    const output = path.join(disabled.root, ".skill-sys", "telemetry", "events.jsonl");
    const args = ["collect", "--source", disabled.root, "--config", disabled.config, "--output", output, "--event", "command-run", "--skill", "registry-trust"];

    expect(standalone(args, disabled.root).exitCode).toBe(1);
    expect(fs.existsSync(output)).toBe(false);

    const enabled = createPolicyRoot({ collection: { enabled: true, explicitOptIn: true, approvedBy: "owner" } });
    const enabledOutput = path.join(enabled.root, ".skill-sys", "telemetry", "events.jsonl");
    const enabledArgs = ["collect", "--source", enabled.root, "--config", enabled.config, "--output", enabledOutput, "--event", "command-run", "--skill", "registry-trust"];

    expect(standalone(enabledArgs, enabled.root).exitCode).toBe(0);
    expect(fs.readFileSync(enabledOutput, "utf8")).toBe('{"schemaVersion":1,"event":"command-run","skill":"registry-trust","approvedBy":"owner"}\n');
  });

  test("duplicate booleans are idempotent standalone but dropped by the facade", () => {
    const { root, config } = createPolicyRoot();
    const duplicateArgs = [
      "--source",
      root,
      "--config",
      config,
      "--json",
      "--json",
      "--strict",
      "--strict",
    ];

    expect(standalone(duplicateArgs, root)).toEqual({
      exitCode: 0,
      stdout: jsonResult({ strict: true }),
      stderr: "",
    });
    expect(facade("telemetry-policy", duplicateArgs, root)).toEqual({
      exitCode: 0,
      stdout: textResult("PASS"),
      stderr: "",
    });
  });

  test("PASS, CONCERNS, strict-warning BLOCKED, and error BLOCKED all exit zero", () => {
    const pass = createPolicyRoot();
    const warning = createPolicyRoot({ allowedSkills: [] });
    const blocked = createPolicyRoot({
      collection: {
        enabled: true,
        explicitOptIn: false,
        approvedBy: "",
      },
      transports: {
        remoteUrls: ["https://telemetry.invalid/collect"],
        localOnly: false,
      },
    });
    const warningFinding =
      "- [WARN TELEMETRY_POLICY_NO_ALLOWED_SKILLS] policy should declare at least one allowed skill";
    const blockedFindings = [
      "- [ERROR TELEMETRY_POLICY_ENABLED_WITHOUT_APPROVER] enabled telemetry requires approvedBy",
      "- [ERROR TELEMETRY_POLICY_ENABLED_WITHOUT_OPT_IN] enabled telemetry requires explicit opt-in",
      "- [ERROR TELEMETRY_POLICY_LOCAL_ONLY_REQUIRED] transports.localOnly must be true",
      "- [ERROR TELEMETRY_POLICY_REMOTE_URLS_FORBIDDEN] remote telemetry URLs are forbidden in the offline MVP",
    ];
    const cases = [
      {
        fixture: pass,
        args: [] as string[],
        stdout: textResult("PASS"),
      },
      {
        fixture: warning,
        args: [] as string[],
        stdout: textResult("CONCERNS", {
          allowedSkillCount: 0,
          findings: [warningFinding],
        }),
      },
      {
        fixture: warning,
        args: ["--strict"],
        stdout: textResult("BLOCKED", {
          strict: true,
          allowedSkillCount: 0,
          findings: [warningFinding],
        }),
      },
      {
        fixture: blocked,
        args: [] as string[],
        stdout: textResult("BLOCKED", {
          collectionEnabled: true,
          localOnly: false,
          remoteUrlCount: 1,
          findings: blockedFindings,
        }),
      },
    ];

    for (const entry of cases) {
      const args = [
        "--source",
        entry.fixture.root,
        "--config",
        entry.fixture.config,
        ...entry.args,
      ];
      const expected = {
        exitCode: 0,
        stdout: entry.stdout,
        stderr: "",
      };
      expect(standalone(args, entry.fixture.root)).toEqual(expected);
      expect(facade("telemetry", args, entry.fixture.root)).toEqual(expected);
    }
  });

  test("parser and required-input failures preserve exact stderr and exit one", () => {
    const { root, config } = createPolicyRoot();
    const cases = [
      {
        standaloneArgs: [] as string[],
        facadeArgs: [] as string[],
        standaloneError: "ERROR: Missing --source\n",
        facadeParserError: undefined,
      },
      {
        standaloneArgs: ["--source", root],
        facadeArgs: ["--source", root],
        standaloneError: "ERROR: Missing --config\n",
        facadeParserError: undefined,
      },
      {
        standaloneArgs: ["--wat"],
        facadeArgs: ["--wat"],
        standaloneError: "ERROR: Unknown argument: --wat\n",
        facadeParserError: "ERROR: Unknown option: --wat\n",
      },
      {
        standaloneArgs: ["--source"],
        facadeArgs: ["--source"],
        standaloneError: "ERROR: Missing value for --source\n",
        facadeParserError: "ERROR: Missing value for --source\n",
      },
    ];

    for (const entry of cases) {
      expect(standalone(entry.standaloneArgs, root)).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: entry.standaloneError,
      });
      expect(facade("telemetry-policy", entry.facadeArgs, root)).toEqual(
        entry.facadeParserError === undefined
          ? facadeChildFailure(
              entry.standaloneError,
              entry.facadeArgs,
              root,
            )
          : {
              exitCode: 1,
              stdout: "",
              stderr: entry.facadeParserError,
            },
      );
    }

    expect(
      standalone(
        ["--source", path.join(root, "missing"), "--config", config],
        root,
      ),
    ).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "ERROR: --source does not exist: <fixture-root>/missing\n",
    });
  });

  test("symlink and invalid JSON failures preserve exact no-stdout behavior", () => {
    const symlinkFixture = createPolicyRoot();
    const symlink = path.join(
      symlinkFixture.root,
      ".skill-sys",
      "linked-policy.json",
    );
    fs.symlinkSync(symlinkFixture.config, symlink);
    const symlinkArgs = [
      "--source",
      symlinkFixture.root,
      "--config",
      symlink,
    ];
    const symlinkExpected = {
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: --config must not be a symlink\n",
    };
    expect(standalone(symlinkArgs, symlinkFixture.root)).toEqual(
      symlinkExpected,
    );
    expect(
      facade("telemetry-policy", symlinkArgs, symlinkFixture.root),
    ).toEqual(
      facadeChildFailure(
        symlinkExpected.stderr,
        symlinkArgs,
        symlinkFixture.root,
      ),
    );

    const invalidFixture = createPolicyRoot();
    fs.writeFileSync(invalidFixture.config, "{", "utf8");
    const invalidArgs = [
      "--source",
      invalidFixture.root,
      "--config",
      invalidFixture.config,
    ];
    const standaloneInvalid = standalone(invalidArgs, invalidFixture.root);
    const facadeInvalid = facade(
      "telemetry-policy",
      invalidArgs,
      invalidFixture.root,
    );
    expect(standaloneInvalid.exitCode).toBe(1);
    expect(standaloneInvalid.stdout).toBe("");
    expect(standaloneInvalid.stderr).toBe(
      "ERROR: JSON Parse error: Expected '}'\n",
    );
    expect(facadeInvalid).toEqual(
      facadeChildFailure(
        standaloneInvalid.stderr,
        invalidArgs,
        invalidFixture.root,
      ),
    );
  });
});
