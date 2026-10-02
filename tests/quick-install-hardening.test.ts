import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const quickInstall = require("../scripts/commands/quick-install.ts") as typeof import("../scripts/commands/quick-install.ts");
const sourceChecksum = require("../scripts/commands/source-checksum.ts") as typeof import("../scripts/commands/source-checksum.ts");

const repoRoot = path.resolve(__dirname, "..");
const validFixtureSource = path.join(repoRoot, "examples", "minimal-skillpack");

function withTempDir<T>(prefix: string, callback: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createTargetFromValidFixture(root: string): string {
  const target = path.join(root, "target");
  fs.cpSync(validFixtureSource, target, { recursive: true });
  return target;
}

/**
 * Fetched "verification scripts" that would write a marker and exit non-zero
 * if anything ever executed them.
 */
function writeExecutionCanaries(target: string): string[] {
  const markerPath = path.join(target, "EXECUTED.marker");
  const canary = [
    'import fs from "node:fs";',
    `fs.writeFileSync(${JSON.stringify(markerPath)}, "executed", "utf8");`,
    "process.exit(9);",
    "",
  ].join("\n");
  const canaryPaths = [
    path.join(target, "scripts", "commands", "universal-contract.ts"),
    path.join(target, "scripts", "commands", "source-checksum.ts"),
    path.join(target, "scripts", "universal-contract.ts"),
  ];
  for (const canaryPath of canaryPaths) {
    fs.mkdirSync(path.dirname(canaryPath), { recursive: true });
    fs.writeFileSync(canaryPath, canary, "utf8");
  }
  return [markerPath, ...canaryPaths];
}

/**
 * Fetched sync/bootstrap stand-ins with side effects: quick-install must never
 * resolve or execute these from the fetched tree.
 */
function writeMutationCanaries(target: string): string[] {
  const markerPath = path.join(target, "MUTATION_EXECUTED.marker");
  const canary = [
    'import fs from "node:fs";',
    `fs.writeFileSync(${JSON.stringify(markerPath)}, "executed", "utf8");`,
    "process.exit(9);",
    "",
  ].join("\n");
  const canaryPaths = [
    path.join(target, "scripts", "commands", "sync-global-core.ts"),
    path.join(target, "scripts", "sync-global-core.ts"),
    path.join(target, "scripts", "commands", "bootstrap-skills.ts"),
    path.join(target, "scripts", "bootstrap-skills.ts"),
  ];
  for (const canaryPath of canaryPaths) {
    fs.mkdirSync(path.dirname(canaryPath), { recursive: true });
    fs.writeFileSync(canaryPath, canary, "utf8");
  }
  return [markerPath, ...canaryPaths];
}

function makeSuccessRecorder(): { calls: string[][]; run: typeof quickInstall.run } {
  const calls: string[][] = [];
  const run = ((argv: string[]) => {
    calls.push([...argv]);
    return { code: 0, stdout: "", stderr: "" };
  }) as typeof quickInstall.run;
  return { calls, run };
}

function baseArgs(target: string, overrides: Partial<Record<string, unknown>> = {}): Parameters<typeof quickInstall.verifySource>[0] {
  return {
    ref: "v1.0.0",
    target,
    syncGlobals: [],
    globalSync: false,
    apps: ["opencode"],
    profile: "core",
    skills: [],
    verifySignedTag: false,
    expectedSourceSha256: null,
    help: false,
    ...overrides,
  } as Parameters<typeof quickInstall.verifySource>[0];
}

function makeRunRecorder(): { calls: string[][]; run: typeof quickInstall.run } {
  const calls: string[][] = [];
  const run = ((argv: string[]) => {
    calls.push([...argv]);
    throw new Error(`unexpected subprocess during verification: ${argv.join(" ")}`);
  }) as typeof quickInstall.run;
  return { calls, run };
}

describe("quick-install verification trust boundary", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("fetched TypeScript with side effects is never executed", () => {
    withTempDir("quick-install-inert-", (root) => {
      const target = createTargetFromValidFixture(root);
      const [markerPath, ...canaryPaths] = writeExecutionCanaries(target);
      const recorder = makeRunRecorder();

      expect(() => quickInstall.verifySource(baseArgs(target), { run: recorder.run })).not.toThrow();

      expect(recorder.calls).toEqual([]);
      expect(fs.existsSync(markerPath!)).toBe(false);
      for (const canaryPath of canaryPaths) {
        expect(fs.readFileSync(canaryPath, "utf8")).toContain("process.exit(9)");
      }
    });
  });

  test("valid fixture succeeds with matching local checksum and zero subprocesses", () => {
    withTempDir("quick-install-valid-", (root) => {
      const target = createTargetFromValidFixture(root);
      const expected = sourceChecksum.computeChecksum(sourceChecksum.resolveLayout(target));
      const args = baseArgs(target, { expectedSourceSha256: expected });
      const recorder = makeRunRecorder();

      expect(() => quickInstall.verifySource(args, { run: recorder.run })).not.toThrow();

      expect(recorder.calls).toEqual([]);
      const logged = logSpy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");
      expect(logged).toContain(`Verified source checksum: ${expected}`);
    });
  });

  test("checksum mismatch fails closed", () => {
    withTempDir("quick-install-mismatch-", (root) => {
      const target = createTargetFromValidFixture(root);
      writeExecutionCanaries(target);
      const args = baseArgs(target, { expectedSourceSha256: "0".repeat(64) });
      const recorder = makeRunRecorder();

      // Either a genuine digest mismatch or the local artifact-surface guard
      // rejecting the tampered tree: both fail closed without executing it.
      let failure: unknown;
      try {
        quickInstall.verifySource(args, { run: recorder.run });
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toMatch(/Checksum mismatch|Failed to compute source checksum locally/);
      expect(recorder.calls).toEqual([]);
    });
  });

  test("unresolved local checksum fails closed instead of executing fetched code", () => {
    withTempDir("quick-install-unresolvable-", (root) => {
      const target = createTargetFromValidFixture(root);
      fs.rmSync(path.join(target, "adapters"), { recursive: true, force: true });
      const args = baseArgs(target, { expectedSourceSha256: "a".repeat(64) });
      const recorder = makeRunRecorder();

      expect(() => quickInstall.verifySource(args, { run: recorder.run })).toThrow(
        /Failed to compute source checksum locally/
      );
      expect(recorder.calls).toEqual([]);
    });
  });

  test("fetched contract violations fail closed", () => {
    withTempDir("quick-install-contract-", (root) => {
      const target = createTargetFromValidFixture(root);
      const skillMd = path.join(target, "skills", "example-skill", "SKILL.md");
      fs.writeFileSync(
        skillMd,
        fs.readFileSync(skillMd, "utf8").replace(/^description:.*$/m, ""),
        "utf8"
      );
      writeExecutionCanaries(target);

      const recorder = makeRunRecorder();
      expect(() => quickInstall.verifySource(baseArgs(target), { run: recorder.run })).toThrow(
        /Universal contract verification failed[\s\S]*description/
      );
      expect(recorder.calls).toEqual([]);
    });
  });

  test("empty or missing fetched skills root fails closed", () => {
    withTempDir("quick-install-empty-root-", (root) => {
      const target = createTargetFromValidFixture(root);
      fs.rmSync(path.join(target, "skills"), { recursive: true, force: true });

      const recorder = makeRunRecorder();
      expect(() => quickInstall.verifySource(baseArgs(target), { run: recorder.run })).toThrow(
        /SKILLS_ROOT_EMPTY/
      );
      expect(recorder.calls).toEqual([]);
    });
  });
});

describe("quick-install ref hardening", () => {
  const unsafeRefs = [
    "-evil",
    "--upload-pack=touch /tmp/pwned",
    "main..evil",
    "@{push}",
    "main.lock",
    "a//b",
    "trailing.",
    ".",
    "..",
    "./segment",
    "",
    "   ",
  ];

  for (const ref of unsafeRefs) {
    test(`rejects unsafe ref ${JSON.stringify(ref)} at parse time`, () => {
      expect(() =>
        quickInstall.parseArgs(["bun", "scripts/commands/quick-install.ts", "--ref", ref])
      ).toThrow(/Unsafe git ref|must be a non-empty string|Missing value for --ref/);
    });
  }

  test("unsafe ref fails closed before any fetch or subprocess", () => {
    let ensureRepoCalls = 0;
    expect(() =>
      quickInstall.main(["bun", "scripts/commands/quick-install.ts", "--ref", "-evil"], {
        ensureRepo: () => {
          ensureRepoCalls += 1;
        },
      })
    ).toThrow(/Unsafe git ref/);
    expect(ensureRepoCalls).toBe(0);
  });

  test("safe refs are preserved", () => {
    const sha = "a".repeat(40);
    for (const ref of ["main", "v1.2.3", "feature/test+one", sha, "refs/tags/v1.2.3"]) {
      const args = quickInstall.parseArgs([
        "bun",
        "scripts/commands/quick-install.ts",
        "--target",
        "/tmp/some-target",
        "--ref",
        ref,
      ]);
      expect(args.ref).toBe(ref.trim());
    }
  });

  test("repo values starting with '-' are rejected before git commands", () => {
    // Single-dash value reaches the dedicated guard.
    expect(() =>
      quickInstall.parseArgs([
        "bun",
        "scripts/commands/quick-install.ts",
        "--target",
        "/tmp/some-target",
        "--repo",
        "-evil",
      ])
    ).toThrow(/Unsafe git repo URL or path/);
    // Option-looking value is rejected at parse time; either way it never
    // reaches a git command line.
    expect(() =>
      quickInstall.parseArgs([
        "bun",
        "scripts/commands/quick-install.ts",
        "--target",
        "/tmp/some-target",
        "--repo",
        "--upload-pack=touch /tmp/pwned",
      ])
    ).toThrow(/Missing value for --repo/);
  });

  test("unsafe remote repo forms are rejected before any git command", () => {
    const unsafeRepos = [
      "http://example.com/universal-skills.git",
      "file:///tmp/universal-skills.git",
      "ftp://example.com/universal-skills.git",
      "ext::sh -c touch /tmp/quick-install-pwned",
      "https://127.0.0.1/universal-skills.git",
      "ssh://git@10.0.0.2/universal-skills.git",
      "git@localhost:example/universal-skills.git",
      "https://2130706433/universal-skills.git",
    ];

    for (const repo of unsafeRepos) {
      let ensureRepoCalls = 0;
      expect(() =>
        quickInstall.main(
          [
            "bun",
            "scripts/commands/quick-install.ts",
            "--repo",
            repo,
            "--no-global-sync",
          ],
          {
            ensureRepo: () => {
              ensureRepoCalls += 1;
            },
            verifySource: () => {},
            syncGlobals: () => {},
            bootstrapProject: () => {},
          }
        )
      ).toThrow(/Unsafe git repo|Unsupported source|loopback\/private|numeric host|https or ssh/i);
      expect(ensureRepoCalls).toBe(0);
    }
  });

  test("credentialed repo diagnostics never disclose the credential", () => {
    const credential = "quick-install-secret-value";
    for (const repo of [
      `https://user:${credential}@example.com/universal-skills.git`,
      `https://example.com/universal-skills.git?access_token=${credential}`,
    ]) {
      let message = "";
      try {
        quickInstall.parseArgs([
          "bun",
          "scripts/commands/quick-install.ts",
          "--repo",
          repo,
        ]);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(credential);
    }
  });

  test("safe HTTPS, SSH, scp-like, and local repo forms are preserved", () => {
    for (const repo of [
      "https://github.com/example/universal-skills.git",
      "ssh://git@github.com/example/universal-skills.git",
      "git@github.com:example/universal-skills.git",
      "/tmp/local-universal-skills",
      "../local-universal-skills",
      "./host:path",
    ]) {
      const args = quickInstall.parseArgs([
        "bun",
        "scripts/commands/quick-install.ts",
        "--repo",
        repo,
      ]);
      expect(args.repo).toBe(repo);
    }
  });
});

describe("quick-install trusted distribution scripts", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("trusted scripts exist under the currently executing distribution", () => {
    expect(fs.existsSync(path.join(repoRoot, "scripts", "commands", "sync-global-core.ts"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "scripts", "commands", "bootstrap-skills.ts"))).toBe(true);
  });

  test("sync and bootstrap commands point at trusted scripts, never fetched ones", () => {
    const args = baseArgs("/tmp/fetched-target");
    const syncCmd = quickInstall.buildSyncGlobalsCommand(args);

    expect(syncCmd[0]).toBe("bun");
    expect(syncCmd[1]).toBe(path.join(repoRoot, "scripts", "commands", "sync-global-core.ts"));
    const sourceIdx = syncCmd.indexOf("--source");
    expect(sourceIdx).toBeGreaterThan(0);
    expect(syncCmd[sourceIdx + 1]).toBe("/tmp/fetched-target");

    const bootCmd = quickInstall.buildBootstrapCommand({ ...args, project: "/tmp/proj" });
    expect(bootCmd[0]).toBe("bun");
    expect(bootCmd[1]).toBe(path.join(repoRoot, "scripts", "commands", "bootstrap-skills.ts"));
    const repoIdx = bootCmd.indexOf("--repo");
    expect(bootCmd[repoIdx + 1]).toBe("/tmp/fetched-target");
  });

  test("full flow with side-effecting fetched sync/bootstrap scripts executes nothing from the target", () => {
    withTempDir("quick-install-mutation-canary-", (root) => {
      const target = createTargetFromValidFixture(root);
      // Bind evidence to the pristine fixture before planting fetched-code
      // canaries; verification itself is stubbed in this flow.
      const expected = sourceChecksum.computeChecksum(sourceChecksum.resolveLayout(target));
      const [markerPath, ...canaryPaths] = writeMutationCanaries(target);
      const projectDir = path.join(root, "proj");
      fs.mkdirSync(projectDir, { recursive: true });

      const recorder = makeSuccessRecorder();
      quickInstall.main(
        [
          "bun",
          "scripts/commands/quick-install.ts",
          "--target",
          target,
          "--expected-source-sha256",
          expected,
          "--project",
          projectDir,
        ],
        { ensureRepo: () => {}, verifySource: () => {}, run: recorder.run }
      );

      // Both mutation runners spawned, and every spawn used a script under the
      // executing distribution; nothing under the fetched target was executed.
      expect(recorder.calls.some((argv) => argv[1]!.endsWith("sync-global-core.ts"))).toBe(true);
      expect(recorder.calls.some((argv) => argv[1]!.endsWith("bootstrap-skills.ts"))).toBe(true);
      for (const argv of recorder.calls) {
        expect(argv[0]).toBe("bun");
        expect(argv[1]!.startsWith(target)).toBe(false);
      }
      expect(fs.existsSync(markerPath!)).toBe(false);
      for (const canaryPath of canaryPaths) {
        expect(fs.readFileSync(canaryPath!, "utf8")).toContain("process.exit(9)");
      }
    });
  });
});

describe("quick-install mutation evidence gate", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  test("floating ref without checksum fails closed before any fetch or mutation", () => {
    let ensureRepoCalls = 0;
    expect(() =>
      quickInstall.main(["bun", "scripts/commands/quick-install.ts"], {
        ensureRepo: () => {
          ensureRepoCalls += 1;
        },
      })
    ).toThrow(/--expected-source-sha256/);
    expect(ensureRepoCalls).toBe(0);
  });

  test("fetch-and-verify only (--no-global-sync, no --project) needs no checksum", () => {
    let ensured = 0;
    expect(() =>
      quickInstall.main(["bun", "scripts/commands/quick-install.ts", "--no-global-sync"], {
        ensureRepo: () => {
          ensured += 1;
        },
        verifySource: () => {},
      })
    ).not.toThrow();
    expect(ensured).toBe(1);
  });

  test("malformed checksum digests are rejected at parse time", () => {
    for (const bad of ["abc123", "0".repeat(63), "z".repeat(64), ""]) {
      expect(() =>
        quickInstall.parseArgs(["bun", "x", "--expected-source-sha256", bad])
      ).toThrow(/Unsafe --expected-source-sha256|Missing value/);
    }
  });

  test("valid checksum lets mutations proceed after verification, in order", () => {
    const sequence: string[] = [];
    quickInstall.main(["bun", "x", "--expected-source-sha256", "a".repeat(64)], {
      ensureRepo: () => {
        sequence.push("ensureRepo");
      },
      verifySource: () => {
        sequence.push("verifySource");
      },
      syncGlobals: () => {
        sequence.push("syncGlobals");
      },
      bootstrapProject: () => {
        sequence.push("bootstrapProject");
      },
    });
    expect(sequence).toEqual(["ensureRepo", "verifySource", "syncGlobals", "bootstrapProject"]);
  });
});

describe("quick-install strict bootstrap compatibility gate", () => {
  test("remote repo with --project fails closed with actionable strict-offline guidance", () => {
    const recorder = makeSuccessRecorder();
    for (const remote of [
      "https://github.com/example/universal-skills.git",
      "git@github.com:example/universal-skills.git",
    ]) {
      expect(() =>
        quickInstall.bootstrapProject(baseArgs("/tmp/fetched-target", { project: "/tmp/proj", repo: remote }), {
          run: recorder.run,
        })
      ).toThrow(
        /Refusing project bootstrap from a remote source[\s\S]*--policy-file[\s\S]*--source-lock[\s\S]*--source-entry[\s\S]*--projection-dir/
      );
    }
    expect(recorder.calls).toEqual([]);
  });

  test("local checkout bootstrap is allowed and uses the trusted script", () => {
    const recorder = makeSuccessRecorder();
    expect(() =>
      quickInstall.bootstrapProject(baseArgs("/tmp/fetched-target", { project: "/tmp/proj" }), {
        run: recorder.run,
      })
    ).not.toThrow();
    expect(recorder.calls.length).toBe(1);
    expect(recorder.calls[0]![1]).toBe(path.join(repoRoot, "scripts", "commands", "bootstrap-skills.ts"));
  });
});

describe("quick-install finite command timeout", () => {
  test("default budget constant is documented and finite", () => {
    expect(quickInstall.QUICK_INSTALL_COMMAND_TIMEOUT_MS).toBe(5 * 60 * 1000);
    expect(Number.isInteger(quickInstall.QUICK_INSTALL_COMMAND_TIMEOUT_MS)).toBe(true);
  });

  test("run wrapper propagates timeoutMs overrides into runCommand", () => {
    const sleeper = [process.execPath, "-e", "setTimeout(() => {}, 30000);"];
    const startedAt = Date.now();
    let message = "";
    try {
      quickInstall.run(sleeper, { timeoutMs: 250, stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.startsWith(`Command failed (124): ${sleeper.join(" ")}`)).toBe(true);
    expect(message).toContain("command exceeded timeoutMs=250ms and was terminated");
    expect(Date.now() - startedAt).toBeLessThan(15000);
  });

  test("invalid timeout overrides fail closed through runCommand validation", () => {
    expect(() => quickInstall.run(["true"], { timeoutMs: 0 })).toThrow(
      "runCommand timeoutMs must be a positive integer"
    );
  });
});
