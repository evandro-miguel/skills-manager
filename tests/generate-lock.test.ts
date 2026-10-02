import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  main,
  parseArgs,
  runGenerateLock,
  type MaterializeSource,
  type ResolveRemoteRef,
} from "../scripts/commands/generate-lock.ts";
import {
  loadSourceLock,
  SOURCE_LOCK_VERSION,
} from "../scripts/modules/skill-sys/source-lock.ts";
import {
  SOURCE_MANIFEST_VERSION,
  type SourceManifest,
} from "../scripts/modules/skill-sys/source-manifest.ts";

const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");
const registry = require("../scripts/modules/skill-sys/command-registry.ts") as typeof import("../scripts/modules/skill-sys/command-registry.ts");

const FIXED_NOW = "2026-06-14T12:00:00.000Z";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function makeTmpDir(prefix = "generate-lock-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function manifestOf(
  sources: Array<{ name: string; source: string; ref: string; skillPath?: string }>,
): SourceManifest {
  return { version: SOURCE_MANIFEST_VERSION, sources };
}

const DEFAULT_MANIFEST_NAME = "skill-sys.sources.json";
const DEFAULT_LOCK_NAME = "skill-sys.sources.lock.json";

/** Create a fake materialized checkout tree with one or more SKILL.md files. */
function makeCheckout(opts: {
  skillPath?: string;
  secondSkillPath?: string;
  empty?: boolean;
}): string {
  const root = makeTmpDir("generate-lock-checkout-");
  if (!opts.empty && opts.skillPath) {
    const dir = path.join(root, opts.skillPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${opts.skillPath}\n---\n# skill\n`);
  }
  if (!opts.empty && opts.secondSkillPath) {
    const dir = path.join(root, opts.secondSkillPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# other skill\n");
  }
  return root;
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------
describe("generate-lock parseArgs", () => {
  test("applies documented defaults", () => {
    const args = parseArgs(["bun", "generate-lock"]);
    expect(args.source).toBe(".");
    expect(args.manifest).toBeNull();
    expect(args.lockfile).toBeNull();
    expect(args.dryRun).toBe(false);
    expect(args.json).toBe(false);
    expect(args.help).toBe(false);
  });

  test("parses all supported flags", () => {
    const args = parseArgs([
      "bun",
      "generate-lock",
      "--source",
      "./proj",
      "--manifest",
      "m.json",
      "--lockfile",
      "l.json",
      "--dry-run",
      "--json",
    ]);
    expect(args.source).toBe("./proj");
    expect(args.manifest).toBe("m.json");
    expect(args.lockfile).toBe("l.json");
    expect(args.dryRun).toBe(true);
    expect(args.json).toBe(true);
  });

  test("shows help via --help and -h", () => {
    expect(parseArgs(["bun", "generate-lock", "--help"]).help).toBe(true);
    expect(parseArgs(["bun", "generate-lock", "-h"]).help).toBe(true);
  });

  test("rejects unknown options", () => {
    expect(() => parseArgs(["bun", "generate-lock", "--bogus", "x"])).toThrow(/Unknown option/);
  });

  test("rejects missing value for value options", () => {
    expect(() => parseArgs(["bun", "generate-lock", "--source"])).toThrow(/Missing value for --source/);
    expect(() => parseArgs(["bun", "generate-lock", "--manifest"])).toThrow(/Missing value for --manifest/);
  });
});

// ---------------------------------------------------------------------------
// runGenerateLock
// ---------------------------------------------------------------------------
describe("generate-lock runGenerateLock", () => {
  test("reads manifest, resolves+materializes, and writes a valid lock", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([
        { name: "alpha", source: "https://github.com/example/skills.git", ref: "v1", skillPath: "skills/alpha" },
      ]),
    );
    const checkout = makeCheckout({ skillPath: "skills/alpha" });
    const lockPath = path.join(dir, DEFAULT_LOCK_NAME);

    const result = runGenerateLock({
      source: dir,
      manifest: null,
      lockfile: null,
      dryRun: false,
      resolve: () => COMMIT_A,
      materialize: () => checkout,
      now: () => FIXED_NOW,
    });

    expect(result.written).toBe(true);
    expect(result.lockPath).toBe(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    expect(written.version).toBe(SOURCE_LOCK_VERSION);
    expect(written.generatedAt).toBe(FIXED_NOW);
    expect(written.sources[0]).toEqual({
      name: "alpha",
      source: "https://github.com/example/skills.git",
      ref: "v1",
      resolvedCommit: COMMIT_A,
      skillPath: "skills/alpha",
      manifestPath: "skills/alpha/SKILL.md",
      resolvedAt: FIXED_NOW,
    });

    // The written file must round-trip through strict validation.
    expect(() => loadSourceLock(lockPath)).not.toThrow();
  });

  test("derives manifestPath from a lone SKILL.md when skillPath is absent", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([{ name: "alpha", source: "https://github.com/example/skills.git", ref: "v1" }]),
    );
    const checkout = makeCheckout({ skillPath: "skills/alpha" });
    const lockPath = path.join(dir, DEFAULT_LOCK_NAME);

    const result = runGenerateLock({
      source: dir,
      manifest: null,
      lockfile: null,
      dryRun: false,
      resolve: () => COMMIT_A,
      materialize: () => checkout,
      now: () => FIXED_NOW,
    });

    expect(result.lock.sources[0]!.manifestPath).toBe("skills/alpha/SKILL.md");
    expect(result.lock.sources[0]!.skillPath).toBeUndefined();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test("--dry-run builds the lock but writes nothing", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([
        { name: "alpha", source: "https://github.com/example/skills.git", ref: "v1", skillPath: "skills/alpha" },
      ]),
    );
    const checkout = makeCheckout({ skillPath: "skills/alpha" });
    const lockPath = path.join(dir, DEFAULT_LOCK_NAME);

    const result = runGenerateLock({
      source: dir,
      manifest: null,
      lockfile: null,
      dryRun: true,
      resolve: () => COMMIT_A,
      materialize: () => checkout,
      now: () => FIXED_NOW,
    });

    expect(result.written).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(result.lock.sources[0]!.resolvedCommit).toBe(COMMIT_A);
  });

  test("honors explicit --manifest and --lockfile overrides", () => {
    const dir = makeTmpDir();
    const customManifest = path.join(dir, "custom.manifest.json");
    const customLock = path.join(dir, "custom.lock.json");
    writeJson(
      customManifest,
      manifestOf([
        { name: "alpha", source: "https://github.com/example/skills.git", ref: "v1", skillPath: "skills/alpha" },
      ]),
    );
    const checkout = makeCheckout({ skillPath: "skills/alpha" });

    const result = runGenerateLock({
      source: dir,
      manifest: "custom.manifest.json",
      lockfile: "custom.lock.json",
      dryRun: false,
      resolve: () => COMMIT_A,
      materialize: () => checkout,
      now: () => FIXED_NOW,
    });

    expect(result.lockPath).toBe(customLock);
    expect(fs.existsSync(customLock)).toBe(true);
  });

  test("writes a lock for multiple sources in manifest order", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([
        { name: "alpha", source: "https://github.com/example/a.git", ref: "v1", skillPath: "skills/alpha" },
        { name: "beta", source: "https://github.com/example/b.git", ref: "v2", skillPath: "skills/beta" },
      ]),
    );
    const checkoutA = makeCheckout({ skillPath: "skills/alpha" });
    const checkoutB = makeCheckout({ skillPath: "skills/beta" });
    const resolveMap: Record<string, string> = {
      "https://github.com/example/a.git\u0000v1": COMMIT_A,
      "https://github.com/example/b.git\u0000v2": COMMIT_B,
    };
    const resolve: ResolveRemoteRef = (source, ref) => resolveMap[`${source}\u0000${ref}`] ?? COMMIT_A;
    const materializeMap: Record<string, string> = {
      [COMMIT_A]: checkoutA,
      [COMMIT_B]: checkoutB,
    };
    const materialize: MaterializeSource = (_source, _ref, commit) => materializeMap[commit] ?? checkoutA;

    const result = runGenerateLock({
      source: dir,
      manifest: null,
      lockfile: null,
      dryRun: false,
      resolve,
      materialize,
      now: () => FIXED_NOW,
    });

    expect(result.lock.sources).toHaveLength(2);
    expect(result.lock.sources[0]!.resolvedCommit).toBe(COMMIT_A);
    expect(result.lock.sources[1]!.resolvedCommit).toBe(COMMIT_B);
  });

  test("rejects a manifest with duplicate skill names", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([
        { name: "dup", source: "https://github.com/example/a.git", ref: "v1", skillPath: "skills/a" },
        { name: "dup", source: "https://github.com/example/b.git", ref: "v2", skillPath: "skills/b" },
      ]),
    );

    expect(() =>
      runGenerateLock({
        source: dir,
        manifest: null,
        lockfile: null,
        dryRun: false,
        resolve: () => COMMIT_A,
        materialize: () => makeCheckout({ skillPath: "skills/a" }),
        now: () => FIXED_NOW,
      }),
    ).toThrow(/Duplicate skill names.*dup/);
  });

  test("throws a clear error when the manifest is missing", () => {
    const dir = makeTmpDir();
    expect(() =>
      runGenerateLock({
        source: dir,
        manifest: null,
        lockfile: null,
        dryRun: false,
        resolve: () => COMMIT_A,
        materialize: () => makeCheckout({ skillPath: "skills/a" }),
        now: () => FIXED_NOW,
      }),
    ).toThrow(/Source manifest not found/);
  });

  test.each([
    ["file:///etc/passwd"],
    ["https://127.0.0.1/org/repo.git"],
    ["https://user:token@github.com/org/repo.git"],
    ["https://10.0.0.1/org/repo.git"],
    ["git@127.0.0.1:org/repo.git"],
  ])("rejects unsafe source '%s' before resolving or materializing", (source) => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([{ name: "bad", source, ref: "v1", skillPath: "skills/a" }]),
    );

    let resolveCalls = 0;
    let materializeCalls = 0;
    expect(() =>
      runGenerateLock({
        source: dir,
        manifest: null,
        lockfile: null,
        dryRun: false,
        resolve: () => {
          resolveCalls += 1;
          return COMMIT_A;
        },
        materialize: () => {
          materializeCalls += 1;
          return makeCheckout({ skillPath: "skills/a" });
        },
        now: () => FIXED_NOW,
      }),
    ).toThrow();

    expect(resolveCalls).toBe(0);
    expect(materializeCalls).toBe(0);
  });

  test("rejects an intermediate symlink in skillPath that escapes the checkout", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([
        { name: "alpha", source: "https://github.com/example/skills.git", ref: "v1", skillPath: "skills/alpha" },
      ]),
    );
    const checkout = makeCheckout({ empty: true });
    // A directory outside the checkout that the symlink will point at.
    const outside = makeTmpDir("generate-lock-outside-");
    fs.writeFileSync(path.join(outside, "SKILL.md"), "# escaped\n");
    // skills/alpha -> outside, so skills/alpha/SKILL.md reads outside the root
    // even though the lexical path stays inside the checkout.
    fs.mkdirSync(path.join(checkout, "skills"), { recursive: true });
    fs.symlinkSync(outside, path.join(checkout, "skills", "alpha"));

    expect(() =>
      runGenerateLock({
        source: dir,
        manifest: null,
        lockfile: null,
        dryRun: true,
        resolve: () => COMMIT_A,
        materialize: () => checkout,
        now: () => FIXED_NOW,
      }),
    ).toThrow(/outside checkout root|symlink/i);
  });

  test("invokes materializer cleanup after a successful resolution", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([
        { name: "alpha", source: "https://github.com/example/skills.git", ref: "v1", skillPath: "skills/alpha" },
      ]),
    );
    // A production-style checkout owned by the materializer (with a cleanup),
    // not tracked by the test harness until pushed below as a safety net.
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-generate-lock-cleanup-"));
    tempRoots.push(checkout);
    fs.mkdirSync(path.join(checkout, "skills/alpha"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "skills/alpha/SKILL.md"), "# skill\n");

    const result = runGenerateLock({
      source: dir,
      manifest: null,
      lockfile: null,
      dryRun: true,
      resolve: () => COMMIT_A,
      materialize: () => ({
        checkout,
        cleanup: () => fs.rmSync(checkout, { recursive: true, force: true }),
      }),
      now: () => FIXED_NOW,
    });

    expect(result.lock.sources[0]!.manifestPath).toBe("skills/alpha/SKILL.md");
    expect(fs.existsSync(checkout)).toBe(false);
  });

  test("invokes materializer cleanup when SKILL.md resolution fails", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([
        { name: "alpha", source: "https://github.com/example/skills.git", ref: "v1", skillPath: "skills/alpha" },
      ]),
    );
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sys-generate-lock-cleanup-"));
    tempRoots.push(checkout);
    // No SKILL.md present -> findManifestPathInCheckout throws.

    expect(() =>
      runGenerateLock({
        source: dir,
        manifest: null,
        lockfile: null,
        dryRun: true,
        resolve: () => COMMIT_A,
        materialize: () => ({
          checkout,
          cleanup: () => fs.rmSync(checkout, { recursive: true, force: true }),
        }),
        now: () => FIXED_NOW,
      }),
    ).toThrow(/SKILL.md/);

    expect(fs.existsSync(checkout)).toBe(false);
  });

  test("fails when skillPath is set but no SKILL.md exists at that path", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([
        { name: "alpha", source: "https://github.com/example/skills.git", ref: "v1", skillPath: "skills/alpha" },
      ]),
    );
    const checkout = makeCheckout({ empty: true });

    expect(() =>
      runGenerateLock({
        source: dir,
        manifest: null,
        lockfile: null,
        dryRun: false,
        resolve: () => COMMIT_A,
        materialize: () => checkout,
        now: () => FIXED_NOW,
      }),
    ).toThrow(/SKILL.md/);
  });

  test("fails when no SKILL.md is found and skillPath is absent", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([{ name: "alpha", source: "https://github.com/example/skills.git", ref: "v1" }]),
    );
    const checkout = makeCheckout({ empty: true });

    expect(() =>
      runGenerateLock({
        source: dir,
        manifest: null,
        lockfile: null,
        dryRun: false,
        resolve: () => COMMIT_A,
        materialize: () => checkout,
        now: () => FIXED_NOW,
      }),
    ).toThrow(/SKILL.md/);
  });

  test("fails when more than one SKILL.md is found and skillPath is absent", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([{ name: "alpha", source: "https://github.com/example/skills.git", ref: "v1" }]),
    );
    const checkout = makeCheckout({ skillPath: "skills/alpha", secondSkillPath: "skills/beta" });

    expect(() =>
      runGenerateLock({
        source: dir,
        manifest: null,
        lockfile: null,
        dryRun: false,
        resolve: () => COMMIT_A,
        materialize: () => checkout,
        now: () => FIXED_NOW,
      }),
    ).toThrow(/SKILL.md/i);
  });

  test("rejects skillPath traversal before materializing", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([
        { name: "alpha", source: "https://github.com/example/skills.git", ref: "v1", skillPath: "../escape" },
      ]),
    );

    let materializeCalls = 0;
    expect(() =>
      runGenerateLock({
        source: dir,
        manifest: null,
        lockfile: null,
        dryRun: false,
        resolve: () => COMMIT_A,
        materialize: () => {
          materializeCalls += 1;
          return makeCheckout({ skillPath: "skills/alpha" });
        },
        now: () => FIXED_NOW,
      }),
    ).toThrow(/skillPath|traversal|parent/i);

    expect(materializeCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
describe("generate-lock main", () => {
  function setupSingleSource(): { dir: string; checkout: string; lockPath: string } {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([
        { name: "alpha", source: "https://github.com/example/skills.git", ref: "v1", skillPath: "skills/alpha" },
      ]),
    );
    return {
      dir,
      checkout: makeCheckout({ skillPath: "skills/alpha" }),
      lockPath: path.join(dir, DEFAULT_LOCK_NAME),
    };
  }

  test("--json emits the lock to stdout and writes the file, exit 0", () => {
    const { dir, checkout, lockPath } = setupSingleSource();
    const stdout: string[] = [];
    const code = main(
      ["bun", "generate-lock", "--source", dir, "--json"],
      {
        stdout: (msg) => stdout.push(msg),
        stderr: () => undefined,
        resolve: () => COMMIT_A,
        materialize: () => checkout,
        now: () => FIXED_NOW,
      },
    );

    expect(code).toBe(0);
    const emitted = JSON.parse(stdout.join("\n"));
    expect(emitted.sources[0].resolvedCommit).toBe(COMMIT_A);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test("default mode writes the file and prints a short summary to stderr", () => {
    const { dir, checkout, lockPath } = setupSingleSource();
    const stderr: string[] = [];
    const code = main(
      ["bun", "generate-lock", "--source", dir],
      {
        stdout: () => undefined,
        stderr: (msg) => stderr.push(msg),
        resolve: () => COMMIT_A,
        materialize: () => checkout,
        now: () => FIXED_NOW,
      },
    );

    expect(code).toBe(0);
    expect(stderr.join("\n")).toContain("Wrote");
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test("--dry-run does not write and reports nothing was written", () => {
    const { dir, checkout, lockPath } = setupSingleSource();
    const stderr: string[] = [];
    const code = main(
      ["bun", "generate-lock", "--source", dir, "--dry-run"],
      {
        stdout: () => undefined,
        stderr: (msg) => stderr.push(msg),
        resolve: () => COMMIT_A,
        materialize: () => checkout,
        now: () => FIXED_NOW,
      },
    );

    expect(code).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(stderr.join("\n")).toContain("Dry run");
  });

  test("--help prints help and exits 0", () => {
    const stdout: string[] = [];
    const code = main(["bun", "generate-lock", "--help"], {
      stdout: (msg) => stdout.push(msg),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("generate-lock");
  });

  test("returns exit code 1 when the manifest is missing", () => {
    const dir = makeTmpDir();
    const stderr: string[] = [];
    const code = main(
      ["bun", "generate-lock", "--source", dir],
      {
        stdout: () => undefined,
        stderr: (msg) => stderr.push(msg),
        resolve: () => COMMIT_A,
        materialize: () => makeCheckout({ skillPath: "skills/a" }),
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("Source manifest not found");
  });

  test("returns exit code 1 on an unsafe source", () => {
    const dir = makeTmpDir();
    writeJson(
      path.join(dir, DEFAULT_MANIFEST_NAME),
      manifestOf([{ name: "bad", source: "https://127.0.0.1/org/repo.git", ref: "v1", skillPath: "skills/a" }]),
    );
    const stderr: string[] = [];
    const code = main(
      ["bun", "generate-lock", "--source", dir],
      {
        stdout: () => undefined,
        stderr: (msg) => stderr.push(msg),
        resolve: () => COMMIT_A,
        materialize: () => makeCheckout({ skillPath: "skills/a" }),
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("ERROR");
  });
});

// ---------------------------------------------------------------------------
// CLI dispatch + registry
// ---------------------------------------------------------------------------
describe("generate-lock CLI dispatch", () => {
  test("registry exposes generate-lock as public with alias 'lock'", () => {
    const cmd = registry.SKILL_SYS_COMMANDS.find((c) => c.name === "generate-lock");
    expect(cmd).toBeDefined();
    expect(cmd!.audience).toBe("public");
    expect(cmd!.aliases).toContain("lock");
    expect(registry.resolveSkillSysCommandName("generate-lock")).toBe("generate-lock");
    expect(registry.resolveSkillSysCommandName("lock")).toBe("generate-lock");
    expect(registry.publicSkillSysCommands().some((c) => c.name === "generate-lock")).toBe(true);
  });

  test("skill-sys alias 'lock' routes to generate-lock", () => {
    const parsed = skillSys.parseCli(["bun", "skill-sys", "lock", "--dry-run"]);
    expect(parsed.command).toBe("generate-lock");
  });

  test("skill-sys generate-lock plans a passthrough command with all flags", () => {
    const plan = skillSys.buildCommand(
      skillSys.parseCli([
        "bun",
        "skill-sys",
        "generate-lock",
        "--source",
        "./proj",
        "--manifest",
        "m.json",
        "--lockfile",
        "l.json",
        "--dry-run",
        "--json",
      ]),
    );

    expect(plan.argv[0]).toBe("bun");
    expect(plan.argv[1]).toContain("generate-lock.ts");
    expect(valueAfter(plan.argv, "--source")).toBe("./proj");
    expect(valueAfter(plan.argv, "--manifest")).toBe("m.json");
    expect(valueAfter(plan.argv, "--lockfile")).toBe("l.json");
    expect(plan.argv).toContain("--dry-run");
    expect(plan.argv).toContain("--json");
  });
});
