import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const standaloneCommand = path.join(
  repoRoot,
  "scripts",
  "commands",
  "registry-trust.ts",
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

type SignalStatus = "pass" | "warn" | "fail";

type ScorecardFixture = Readonly<{
  root: string;
  scorecard: string;
}>;

const SYNTHETIC_EVIDENCE = "synthetic registry evidence";

function sensitiveShapedEvidence(): string {
  return ["sk", "-", "syntheticregistrymarker".repeat(2)].join("");
}

function scorecard(
  status: SignalStatus = "pass",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "release-trust",
    thresholds: { minScore: status === "warn" ? 40 : 80 },
    signals: [
      {
        id: "docs",
        category: "docs",
        status,
        weight: 100,
        evidence: SYNTHETIC_EVIDENCE,
      },
    ],
    ...overrides,
  };
}

function createScorecard(
  value: unknown = scorecard(),
  fileName = "scorecard.json",
): ScorecardFixture {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "registry-trust-cli-characterization-"),
  );
  temporaryRoots.push(root);
  const scorecardPath = path.join(root, fileName);
  fs.mkdirSync(path.dirname(scorecardPath), { recursive: true });
  fs.writeFileSync(
    scorecardPath,
    typeof value === "string"
      ? value
      : `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  return { root, scorecard: scorecardPath };
}

function createRegistrySource(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "registry-trust-source-characterization-"),
  );
  temporaryRoots.push(root);
  fs.cpSync(
    path.join(repoRoot, "registry"),
    path.join(root, "registry"),
    { recursive: true },
  );
  return root;
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
  command: "registry-trust" | "registry-trust-score" | "trust-score",
  args: readonly string[],
  fixtureRoots: readonly string[] = [],
): CliResult {
  return run([facadeCommand, command, ...args], fixtureRoots);
}

function commandLine(
  args: readonly string[],
  fixtureRoots: readonly string[] = [],
): string {
  let value = ["bun", standaloneCommand, ...args].join(" ");
  for (const [index, fixtureRoot] of fixtureRoots.entries()) {
    value = value
      .split(fixtureRoot)
      .join(`<fixture-root-${index + 1}>`);
  }
  return value.split(repoRoot).join("<repo-root>");
}

function facadeFailure(
  args: readonly string[],
  fixtureRoots: readonly string[] = [],
  childStderr = "",
): CliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr:
      `${childStderr}ERROR: Command failed (1): ${
        commandLine(args, fixtureRoots)
      }\n`,
  };
}

function textResult(
  status: "PASS" | "CONCERNS" | "BLOCKED",
  fixture = 1,
  options: Readonly<{
    strict?: boolean;
    score?: number;
    threshold?: number;
    findings?: readonly string[];
  }> = {},
): string {
  const findings = options.findings ?? [];
  return [
    `STATUS: ${status}`,
    "Scorecard: release-trust",
    "Source: <repo-root>",
    `Scorecard file: <fixture-root-${fixture}>/scorecard.json`,
    `Score: ${options.score ?? 100}`,
    `Threshold: ${options.threshold ?? 80}`,
    "Signals: 1",
    `Findings: ${findings.length}`,
    ...findings,
    "",
  ].join("\n");
}

function jsonResult(
  fixture = 1,
  options: Readonly<{
    strict?: boolean;
    status?: "PASS" | "CONCERNS" | "BLOCKED";
    signalStatus?: SignalStatus;
    score?: number;
    threshold?: number;
    findings?: readonly Record<string, unknown>[];
  }> = {},
): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      command: "registry-trust",
      status: options.status ?? "PASS",
      source: "<repo-root>",
      scorecard: `<fixture-root-${fixture}>/scorecard.json`,
      strict: options.strict ?? false,
      scorecardName: "release-trust",
      score: options.score ?? 100,
      threshold: options.threshold ?? 80,
      registrySurface: {
        status: "PASS",
        files: [
          "registry/advisories/security-status.json",
          "registry/index.json",
          "registry/metadata.json",
        ],
        channelDigests: {},
      },
      signals: [
        {
          id: "docs",
          category: "docs",
          status: options.signalStatus ?? "pass",
          weight: 100,
          evidence: SYNTHETIC_EVIDENCE,
        },
      ],
      findings: options.findings ?? [],
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
      "Score registry trust from a local scorecard and validated registry surface",
      "",
      "Usage:",
      "  bun scripts/commands/registry-trust.ts --source <dir> --scorecard <file> [options]",
      "",
      "Options:",
      "  --source <dir>      Repository/source root",
      "  --scorecard <file>  Local registry trust scorecard JSON",
      "  --json              Emit machine-readable output",
      "  --strict            Treat warnings as blocking",
      "  --help              Show help",
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

describe("F-04.01 registry-trust CLI characterization", () => {
  test("canonical standalone, facade, and both aliases preserve PASS text bytes", () => {
    const fixture = createScorecard();
    const args = [
      "--source",
      repoRoot,
      "--scorecard",
      fixture.scorecard,
    ];
    const expected = {
      exitCode: 0,
      stdout: textResult("PASS"),
      stderr: "",
    };

    expect(standalone(args, [fixture.root])).toEqual(expected);
    expect(facade("registry-trust", args, [fixture.root])).toEqual(expected);
    expect(facade("registry-trust-score", args, [fixture.root])).toEqual(
      expected,
    );
    expect(facade("trust-score", args, [fixture.root])).toEqual(expected);
  });

  test("canonical standalone, facade, and both aliases preserve PASS JSON bytes", () => {
    const fixture = createScorecard();
    const args = [
      "--source",
      repoRoot,
      "--scorecard",
      fixture.scorecard,
      "--json",
    ];
    const expected = {
      exitCode: 0,
      stdout: jsonResult(),
      stderr: "",
    };

    expect(standalone(args, [fixture.root])).toEqual(expected);
    expect(facade("registry-trust", args, [fixture.root])).toEqual(expected);
    expect(facade("registry-trust-score", args, [fixture.root])).toEqual(
      expected,
    );
    expect(facade("trust-score", args, [fixture.root])).toEqual(expected);
  });

  test("help preserves standalone idempotence and facade divergence", () => {
    const expected = helpResult();
    expect(standalone(["--help"])).toEqual(expected);
    expect(standalone(["-h"])).toEqual(expected);
    expect(standalone(["--help", "--help"])).toEqual(expected);
    expect(facade("registry-trust", ["--help"])).toEqual(expected);
    expect(facade("registry-trust-score", ["--help"])).toEqual(expected);
    expect(facade("trust-score", ["--help"])).toEqual(expected);

    const droppedHelp = facadeFailure(
      [],
      [],
      "ERROR: Missing --source\n",
    );
    expect(facade("registry-trust", ["--help", "--help"])).toEqual(
      droppedHelp,
    );
    expect(facade("registry-trust", ["-h"])).toEqual(droppedHelp);
  });

  test("scalar repeats are last-wins on standalone and facade", () => {
    const first = createScorecard(
      scorecard("fail"),
      "first-scorecard.json",
    );
    const last = createScorecard();
    const args = [
      "--source",
      first.root,
      "--source",
      repoRoot,
      "--scorecard",
      first.scorecard,
      "--scorecard",
      last.scorecard,
    ];
    const expected = {
      exitCode: 0,
      stdout: textResult("PASS", 2),
      stderr: "",
    };

    expect(standalone(args, [first.root, last.root])).toEqual(expected);
    expect(
      facade("registry-trust", args, [first.root, last.root]),
    ).toEqual(expected);
  });

  test("boolean repeats are idempotent standalone and dropped by facade", () => {
    const fixture = createScorecard();
    const args = [
      "--source",
      repoRoot,
      "--scorecard",
      fixture.scorecard,
      "--json",
      "--json",
      "--strict",
      "--strict",
    ];

    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 0,
      stdout: jsonResult(1, { strict: true }),
      stderr: "",
    });
    expect(facade("registry-trust", args, [fixture.root])).toEqual({
      exitCode: 0,
      stdout: textResult("PASS"),
      stderr: "",
    });
  });

  test("PASS and CONCERNS exit zero while strict-warning BLOCKED and failure BLOCKED exit one", () => {
    const passing = createScorecard();
    const warning = createScorecard(scorecard("warn"));
    const failing = createScorecard(scorecard("fail"));
    const warningFinding =
      `- [WARN REGISTRY_TRUST_SIGNAL_WARNING] docs is warning: ${SYNTHETIC_EVIDENCE}`;
    const failureFindings = [
      "- [ERROR REGISTRY_TRUST_SCORE_BELOW_THRESHOLD] registry trust score 0 is below threshold 80",
      `- [ERROR REGISTRY_TRUST_SIGNAL_FAILED] docs failed: ${SYNTHETIC_EVIDENCE}`,
    ];
    const cases = [
      {
        fixture: passing,
        extra: [] as string[],
        blocked: false,
        stdout: textResult("PASS", 1),
      },
      {
        fixture: warning,
        extra: [] as string[],
        blocked: false,
        stdout: textResult("CONCERNS", 2, {
          score: 50,
          threshold: 40,
          findings: [warningFinding],
        }),
      },
      {
        fixture: warning,
        extra: ["--strict"],
        blocked: true,
        stdout: textResult("BLOCKED", 2, {
          strict: true,
          score: 50,
          threshold: 40,
          findings: [warningFinding],
        }),
      },
      {
        fixture: failing,
        extra: [] as string[],
        blocked: true,
        stdout: textResult("BLOCKED", 3, {
          score: 0,
          findings: failureFindings,
        }),
      },
    ];
    const roots = [passing.root, warning.root, failing.root];

    for (const current of cases) {
      const args = [
        "--source",
        repoRoot,
        "--scorecard",
        current.fixture.scorecard,
        ...current.extra,
      ];
      expect(
        standalone(args, roots),
      ).toEqual({
        exitCode: current.blocked ? 1 : 0,
        stdout: current.stdout,
        stderr: "",
      });
      expect(
        facade("registry-trust", args, roots),
      ).toEqual(
        current.blocked
          ? {
              exitCode: 1,
              stdout: current.stdout,
              stderr:
                `ERROR: Command failed (1): ${
                  commandLine(args, roots)
                }\n`,
            }
          : {
              exitCode: 0,
              stdout: current.stdout,
              stderr: "",
            },
      );
    }
  });

  test("thrown validation errors retain standalone and facade prose", () => {
    const missingScorecardArgs = ["--source", repoRoot];
    expect(standalone(missingScorecardArgs)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: Missing --scorecard\n",
    });
    expect(facade("registry-trust", missingScorecardArgs)).toEqual(
      facadeFailure(
        missingScorecardArgs,
        [],
        "ERROR: Missing --scorecard\n",
      ),
    );

    const fixture = createScorecard();
    const link = path.join(fixture.root, "scorecard-link.json");
    fs.symlinkSync(fixture.scorecard, link);
    const symlinkArgs = [
      "--source",
      repoRoot,
      "--scorecard",
      link,
    ];
    expect(standalone(symlinkArgs, [fixture.root])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: --scorecard must not be a symlink\n",
    });
    expect(facade("trust-score", symlinkArgs, [fixture.root])).toEqual(
      facadeFailure(
        symlinkArgs,
        [fixture.root],
        "ERROR: --scorecard must not be a symlink\n",
      ),
    );
  });

  test("invalid JSON and missing registry surface remain thrown exit-one errors", () => {
    const invalidJson = createScorecard("{");
    const invalidJsonArgs = [
      "--source",
      repoRoot,
      "--scorecard",
      invalidJson.scorecard,
    ];
    const standaloneInvalid = standalone(
      invalidJsonArgs,
      [invalidJson.root],
    );
    expect(standaloneInvalid.exitCode).toBe(1);
    expect(standaloneInvalid.stdout).toBe("");
    expect(standaloneInvalid.stderr).toBe(
      "ERROR: JSON Parse error: Expected '}'\n",
    );
    expect(
      facade("registry-trust", invalidJsonArgs, [invalidJson.root]),
    ).toEqual(
      facadeFailure(
        invalidJsonArgs,
        [invalidJson.root],
        "ERROR: JSON Parse error: Expected '}'\n",
      ),
    );

    const missingSurface = createRegistrySource();
    fs.rmSync(path.join(missingSurface, "registry", "metadata.json"));
    const scorecardFixture = createScorecard();
    const missingSurfaceArgs = [
      "--source",
      missingSurface,
      "--scorecard",
      scorecardFixture.scorecard,
    ];
    const roots = [
      missingSurface,
      scorecardFixture.root,
    ];
    expect(standalone(missingSurfaceArgs, roots)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "ERROR: Missing registry surface file: registry/metadata.json\n",
    });
    expect(
      facade("registry-trust-score", missingSurfaceArgs, roots),
    ).toEqual(
      facadeFailure(
        missingSurfaceArgs,
        roots,
        "ERROR: Missing registry surface file: registry/metadata.json\n",
      ),
    );
  });

  test("every scorecard validation class preserves exact thrown CLI bytes", () => {
    const cases: Array<Readonly<{
      value: unknown;
      error: string;
    }>> = [
      {
        value: { ...scorecard(), schemaVersion: 2 },
        error: "schemaVersion must be 1",
      },
      {
        value: { ...scorecard(), name: "Unsafe Name" },
        error: "name must be a safe identifier",
      },
      {
        value: { ...scorecard(), thresholds: { minScore: 101 } },
        error: "thresholds.minScore must be an integer from 0 to 100",
      },
      {
        value: { ...scorecard(), signals: ["invalid"] },
        error: "signals[0] must be an object",
      },
      {
        value: {
          ...scorecard(),
          signals: [{
            id: "docs",
            category: "unknown",
            status: "pass",
            weight: 1,
            evidence: SYNTHETIC_EVIDENCE,
          }],
        },
        error: "signals[0].category is invalid",
      },
      {
        value: {
          ...scorecard(),
          signals: [{
            id: "docs",
            category: "docs",
            status: "unknown",
            weight: 1,
            evidence: SYNTHETIC_EVIDENCE,
          }],
        },
        error: "signals[0].status is invalid",
      },
      {
        value: {
          ...scorecard(),
          signals: [{
            id: "docs",
            category: "docs",
            status: "pass",
            weight: 101,
            evidence: SYNTHETIC_EVIDENCE,
          }],
        },
        error: "signals[0].weight must be an integer from 0 to 100",
      },
      {
        value: {
          ...scorecard(),
          signals: [{
            id: "Unsafe Id",
            category: "docs",
            status: "pass",
            weight: 1,
            evidence: SYNTHETIC_EVIDENCE,
          }],
        },
        error: "signals[0].id must be a safe identifier",
      },
      {
        value: {
          ...scorecard(),
          signals: [{
            id: "docs",
            category: "docs",
            status: "pass",
            weight: 1,
            evidence: " ",
          }],
        },
        error: "signals[0].evidence must be a non-empty string",
      },
    ];

    for (const current of cases) {
      const fixture = createScorecard(current.value);
      const args = [
        "--source",
        repoRoot,
        "--scorecard",
        fixture.scorecard,
      ];
      const expectedChildStderr = `ERROR: ${current.error}\n`;
      expect(standalone(args, [fixture.root])).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: expectedChildStderr,
      });
      expect(
        facade("registry-trust", args, [fixture.root]),
      ).toEqual(
        facadeFailure(args, [fixture.root], expectedChildStderr),
      );
    }
  }, 20_000);

  test("runtime normalization preserves schema drift and evidence echo", () => {
    const fixture = createScorecard({
      schemaVersion: 1,
      name: " release-trust ",
      thresholds: { minScore: 40, extraThreshold: "ignored" },
      signals: [
        {
          id: " docs ",
          category: "docs",
          status: "warn",
          weight: 100,
          evidence: `  ${SYNTHETIC_EVIDENCE}  `,
          extraSignal: "ignored",
        },
      ],
      extraRoot: "ignored",
    });
    const args = [
      "--source",
      repoRoot,
      "--scorecard",
      fixture.scorecard,
      "--json",
    ];
    const warning = {
      level: "WARN",
      code: "REGISTRY_TRUST_SIGNAL_WARNING",
      signal: "docs",
      message: `docs is warning: ${SYNTHETIC_EVIDENCE}`,
    };

    expect(standalone(args, [fixture.root])).toEqual({
      exitCode: 0,
      stdout: jsonResult(1, {
        status: "CONCERNS",
        signalStatus: "warn",
        score: 50,
        threshold: 40,
        findings: [warning],
      }),
      stderr: "",
    });
  });

  test("legacy output echoes dynamically constructed sensitive-shaped evidence", () => {
    const marker = sensitiveShapedEvidence();
    const fixture = createScorecard(scorecard("warn", {
      signals: [
        {
          id: "docs",
          category: "docs",
          status: "warn",
          weight: 100,
          evidence: marker,
        },
      ],
    }));
    const baseArgs = [
      "--source",
      repoRoot,
      "--scorecard",
      fixture.scorecard,
    ];
    const text = standalone(baseArgs, [fixture.root]);
    const json = facade(
      "trust-score",
      [...baseArgs, "--json"],
      [fixture.root],
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(
      `docs is warning: ${marker}`,
    );
    expect(json.exitCode).toBe(0);
    expect(json.stdout).toContain(`"evidence": "${marker}"`);
    expect(json.stdout).toContain(
      `"message": "docs is warning: ${marker}"`,
    );
  });

  test("source symlinks remain accepted while the reported path stays lexical", () => {
    const fixture = createScorecard();
    const sourceLink = path.join(fixture.root, "source-link");
    fs.symlinkSync(repoRoot, sourceLink, "dir");
    const result = standalone(
      [
        "--source",
        sourceLink,
        "--scorecard",
        fixture.scorecard,
      ],
      [fixture.root],
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("STATUS: PASS\n");
    expect(result.stdout).toContain("Source: <fixture-root-1>/source-link\n");
    expect(result.stdout).toContain(
      `Scorecard file: <fixture-root-1>/scorecard.json\n`,
    );
  });

  test("scorecard ancestor and registry-surface symlinks remain observable as accepted", () => {
    const scorecardFixture = createScorecard();
    const ancestorRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "registry-trust-ancestor-characterization-"),
    );
    temporaryRoots.push(ancestorRoot);
    const ancestorLink = path.join(ancestorRoot, "scorecards");
    fs.symlinkSync(scorecardFixture.root, ancestorLink, "dir");
    const scorecardThroughAncestor = path.join(
      ancestorLink,
      path.basename(scorecardFixture.scorecard),
    );

    const registryFileSource = createRegistrySource();
    const metadata = path.join(
      registryFileSource,
      "registry",
      "metadata.json",
    );
    fs.rmSync(metadata);
    fs.symlinkSync(
      path.join(repoRoot, "registry", "metadata.json"),
      metadata,
    );

    const pointerSource = createRegistrySource();
    const index = path.join(
      pointerSource,
      "registry",
      "index.json",
    );
    fs.rmSync(index);
    fs.symlinkSync(
      path.join(repoRoot, "registry", "index.json"),
      index,
    );

    const intermediateSource = createRegistrySource();
    const advisories = path.join(
      intermediateSource,
      "registry",
      "advisories",
    );
    fs.rmSync(advisories, { recursive: true });
    fs.symlinkSync(
      path.join(repoRoot, "registry", "advisories"),
      advisories,
      "dir",
    );

    const cases = [
      {
        source: repoRoot,
        scorecard: scorecardThroughAncestor,
      },
      {
        source: registryFileSource,
        scorecard: scorecardFixture.scorecard,
      },
      {
        source: pointerSource,
        scorecard: scorecardFixture.scorecard,
      },
      {
        source: intermediateSource,
        scorecard: scorecardFixture.scorecard,
      },
    ];
    for (const current of cases) {
      const result = standalone(
        [
          "--source",
          current.source,
          "--scorecard",
          current.scorecard,
        ],
        [
          scorecardFixture.root,
          ancestorRoot,
          registryFileSource,
          pointerSource,
          intermediateSource,
        ],
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toStartWith("STATUS: PASS\n");
    }
  });
});
