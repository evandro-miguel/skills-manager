import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const files = require("../scripts/lib/files.ts") as typeof import("../scripts/lib/files.ts");
const bootstrap = require("../scripts/commands/bootstrap-skills.ts") as typeof import("../scripts/commands/bootstrap-skills.ts");
const install = require("../scripts/modules/skillpool/install.ts") as typeof import("../scripts/modules/skillpool/install.ts");
const projections = require("../scripts/modules/skillpool/projections.ts") as typeof import("../scripts/modules/skillpool/projections.ts");
const sourceLockModule = require("../scripts/modules/skill-sys/source-lock.ts") as typeof import("../scripts/modules/skill-sys/source-lock.ts");
const sourceModule = require("../scripts/modules/skillpool/source.ts") as typeof import("../scripts/modules/skillpool/source.ts");
const commandHelpers = require("./helpers/skillpool-command.ts") as typeof import("./helpers/skillpool-command.ts");

type RunCommand = typeof import("../scripts/lib/command.ts").runCommand;

const repoRoot = path.resolve(__dirname, "..");
const examplePack = path.join(repoRoot, "examples", "minimal-skillpack");
const REMOTE_REPO = "https://example.invalid/skills.git";
const REF = "v1.2.3";
const SKILL = "example-skill";

function withTempDir<T>(prefix: string, callback: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function sha256Bytes(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function gitOutput(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function initializeTestGitRepo(root: string): string {
  gitOutput(root, ["init", "--quiet"]);
  gitOutput(root, ["add", "."]);
  gitOutput(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  return gitOutput(root, ["rev-parse", "HEAD"]);
}

interface MaterializedFixture {
  projectDir: string;
  pack: string;
  sourcesLockPath: string;
  commit: string;
  checksum: string;
  projectionMeta: { canonicalDigest: string; projectionDigest: string; rendererVersion: number };
}

function createMaterializedFixture(projectDir: string, repo: string = REMOTE_REPO): MaterializedFixture {
  fs.mkdirSync(projectDir, { recursive: true });
  const pack = path.join(projectDir, "pack");
  fs.cpSync(examplePack, pack, { recursive: true });
  const commit = initializeTestGitRepo(pack);
  // The policy pins sourceCommit against ref resolution in the checkout, so
  // materialize the locked ref as a tag.
  gitOutput(pack, ["tag", REF]);
  const layout = sourceModule.resolveSourceLayout(pack, { requireSkills: true });
  const checksum = sourceModule.computeSourceChecksum(pack, layout);

  const projectionsDir = path.join(projectDir, "projections");
  projections.buildProjections({
    sourceRoot: pack,
    providers: ["codex"],
    outDir: projectionsDir,
    clean: true,
  });
  const projectionMeta = JSON.parse(
    fs.readFileSync(path.join(projectionsDir, "codex", SKILL, "projection.meta.json"), "utf8")
  ) as MaterializedFixture["projectionMeta"];

  fs.mkdirSync(path.join(projectDir, "evidence"), { recursive: true });
  const sourcesLockPath = path.join(projectDir, "evidence", "sources.lock.json");
  sourceLockModule.writeSourceLock(sourcesLockPath, {
    version: 1,
    generatedAt: "2026-08-22T00:00:00.000Z",
    sources: [
      {
        name: SKILL,
        source: repo,
        ref: REF,
        resolvedCommit: commit,
        manifestPath: `skills/${SKILL}/SKILL.md`,
        resolvedAt: "2026-08-22T00:00:00.000Z",
      },
    ],
  });

  return { projectDir, pack, sourcesLockPath, commit, checksum, projectionMeta };
}

function makeRecorder(code = 0): {
  calls: string[][];
  run: (args: string[], options?: unknown) => { code: number; stdout: string; stderr: string };
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (args: string[], _options?: unknown) => {
      calls.push(args);
      return { code, stdout: "", stderr: "" };
    },
  };
}

function depsWith(repo: () => string, recorder: ReturnType<typeof makeRecorder>) {
  return {
    detectDefaultRepoFn: repo,
    runCommand: recorder.run as unknown as RunCommand,
    exit: (() => undefined) as (code?: number) => void,
  };
}

function writePolicyFile(projectDir: string, policy: Record<string, unknown>, name = "strict-policy.json"): string {
  const policyPath = path.join(projectDir, name);
  fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return policyPath;
}

function bootstrapLevelPolicy(commit: string): Record<string, unknown> {
  // Digest pin values are shape-validated at bootstrap time; they only bind
  // against materialized bytes during install.
  return {
    requireSourceCommit: true,
    sourceCommit: commit,
    requireSourceChecksum: true,
    expectedSourceSha256: "b".repeat(64),
    requireProjectionDigests: true,
    expectedProjectionDigests: [
      {
        provider: "codex",
        skill: SKILL,
        canonicalDigest: "c".repeat(64),
        projectionDigest: "d".repeat(64),
        rendererVersion: 1,
      },
    ],
  };
}

function strictPolicyForFixture(fixture: MaterializedFixture): Record<string, unknown> {
  return {
    requireSourceCommit: true,
    sourceCommit: fixture.commit,
    requireSourceChecksum: true,
    expectedSourceSha256: fixture.checksum,
    requireProjectionDigests: true,
    expectedProjectionDigests: [
      {
        provider: "codex",
        skill: SKILL,
        canonicalDigest: fixture.projectionMeta.canonicalDigest,
        projectionDigest: fixture.projectionMeta.projectionDigest,
        rendererVersion: fixture.projectionMeta.rendererVersion,
      },
    ],
  };
}

function strictBootstrapArgs(options: {
  projectDir: string;
  repo?: string;
  ref?: string;
  policyFile?: string;
  omitPolicyFile?: boolean;
  sourceLock?: string;
  sourceEntry?: string;
  source?: string;
  projectionDir?: string;
  extra?: string[];
}): string[] {
  const args = [
    "bun",
    "scripts/commands/bootstrap-skills.ts",
    "--project",
    options.projectDir,
    "--repo",
    options.repo ?? REMOTE_REPO,
    "--ref",
    options.ref ?? REF,
    "--apps",
    "codex",
    "--skills",
    SKILL,
  ];
  if (!options.omitPolicyFile) {
    if (options.policyFile === undefined) {
      args.push("--policy-file", path.join(options.projectDir, "strict-policy.json"));
    } else {
      args.push("--policy-file", options.policyFile);
    }
  }
  if (options.sourceLock !== undefined) args.push("--source-lock", options.sourceLock);
  if (options.sourceEntry !== undefined) args.push("--source-entry", options.sourceEntry);
  if (options.source !== undefined) args.push("--source", options.source);
  if (options.projectionDir !== undefined) args.push("--projection-dir", options.projectionDir);
  if (options.extra) args.push(...options.extra);
  return args;
}

describe("W8 strict offline bootstrap/source-lock evidence binding", () => {
  let skillpoolHome: string;
  let previousSkillpoolHome: string | undefined;
  beforeAll(() => {
    previousSkillpoolHome = process.env.SKILLPOOL_HOME;
    skillpoolHome = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-hardening-home-"));
    process.env.SKILLPOOL_HOME = skillpoolHome;
  });
  afterAll(() => {
    if (previousSkillpoolHome === undefined) {
      delete process.env.SKILLPOOL_HOME;
    } else {
      process.env.SKILLPOOL_HOME = previousSkillpoolHome;
    }
    fs.rmSync(skillpoolHome, { recursive: true, force: true });
  });

  describe("bootstrap command", () => {
    function seedProject(root: string, commit: string, repo: string = REMOTE_REPO): { projectDir: string; sourceDir: string } {
      const projectDir = path.join(root, "project");
      const sourceDir = path.join(root, "materialized-source");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(path.join(projectDir, "projections"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "evidence"), { recursive: true });
      writePolicyFile(projectDir, bootstrapLevelPolicy(commit));
      sourceLockModule.writeSourceLock(path.join(projectDir, "evidence", "sources.lock.json"), {
        version: 1,
        generatedAt: "2026-08-22T00:00:00.000Z",
        sources: [
          {
            name: SKILL,
            source: repo,
            ref: REF,
            resolvedCommit: commit,
            manifestPath: `skills/${SKILL}/SKILL.md`,
            resolvedAt: "2026-08-22T00:00:00.000Z",
          },
        ],
      });
      return { projectDir, sourceDir };
    }

    test("valid fully local strict bootstrap writes a bound lock and offline installer argv", () => {
      withTempDir("bootstrap-strict-valid-", (root) => {
        const { projectDir, sourceDir } = seedProject(root, "a".repeat(40));
        const recorder = makeRecorder();
        const result = commandHelpers.captureCommand(() =>
          bootstrap.main(
            strictBootstrapArgs({
              projectDir,
              policyFile: path.join(projectDir, "strict-policy.json"),
              sourceLock: "evidence/sources.lock.json",
              sourceEntry: SKILL,
              source: sourceDir,
              projectionDir: "projections",
            }),
            depsWith(() => REMOTE_REPO, recorder)
          )
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("Bound source-lock evidence:");

        const lockPath = path.join(projectDir, ".skills.lock.json");
        expect(fs.existsSync(lockPath)).toBe(true);
        const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
        expect(lock.policy).toEqual(bootstrapLevelPolicy("a".repeat(40)));
        expect(lock.sourceLock).toEqual({
          path: "evidence/sources.lock.json",
          sha256: sha256Bytes(path.join(projectDir, "evidence", "sources.lock.json")),
          entryName: SKILL,
        });

        expect(recorder.calls).toHaveLength(1);
        const argv = recorder.calls[0]!;
        expect(argv.join(" ")).not.toContain("--refresh-cache");
        expect(argv.join(" ")).not.toContain("--dry-run");
        const flagIndex = (flag: string): number => argv.indexOf(flag);
        expect(flagIndex("--source")).toBeGreaterThan(-1);
        expect(argv[flagIndex("--source") + 1]).toBe(path.resolve(sourceDir));
        expect(flagIndex("--projection-dir")).toBeGreaterThan(-1);
        expect(argv[flagIndex("--projection-dir") + 1]).toBe(path.resolve(projectDir, "projections"));
        expect(flagIndex("--lockfile")).toBeGreaterThan(-1);
        expect(argv[flagIndex("--lockfile") + 1]).toBe(".skills.lock.json");
      });
    });

    test("dry-run validates and prints actions without writing the lockfile", () => {
      withTempDir("bootstrap-strict-dry-", (root) => {
        const { projectDir, sourceDir } = seedProject(root, "a".repeat(40));
        const recorder = makeRecorder();
        const result = commandHelpers.captureCommand(() =>
          bootstrap.main(
            strictBootstrapArgs({
              projectDir,
              policyFile: path.join(projectDir, "strict-policy.json"),
              sourceLock: "evidence/sources.lock.json",
              sourceEntry: SKILL,
              source: sourceDir,
              projectionDir: "projections",
              extra: ["--dry-run"],
            }),
            depsWith(() => REMOTE_REPO, recorder)
          )
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("(dry-run)");
        expect(fs.existsSync(path.join(projectDir, ".skills.lock.json"))).toBe(false);
        expect(recorder.calls).toHaveLength(0);

        // Dry-run still fails closed on incomplete evidence.
        const invalid = commandHelpers.captureCommand(() =>
          bootstrap.main(
            strictBootstrapArgs({
              projectDir,
              omitPolicyFile: true,
              sourceLock: "evidence/sources.lock.json",
              sourceEntry: SKILL,
              source: sourceDir,
              projectionDir: "projections",
              extra: ["--dry-run"],
            }),
            depsWith(() => REMOTE_REPO, makeRecorder())
          )
        );
        expect(invalid.code).toBe(1);
        expect(invalid.stderr).toContain("--policy-file");
        expect(fs.existsSync(path.join(projectDir, ".skills.lock.json"))).toBe(false);
      });
    });

    test("public init forwards strict offline evidence and rejects mismatched entries", () => {
      withTempDir("bootstrap-public-strict-", (root) => {
        const { projectDir, sourceDir } = seedProject(root, "a".repeat(40));
        const before = fs.readdirSync(projectDir);
        for (const sourceEntry of [SKILL, "missing-entry"]) {
          const args = strictBootstrapArgs({
            projectDir,
            sourceLock: "evidence/sources.lock.json",
            sourceEntry,
            source: sourceDir,
            projectionDir: "projections",
            extra: ["--dry-run"],
          });
          const result = Bun.spawnSync({
            cmd: [process.execPath, path.join(repoRoot, "scripts/commands/skill-sys.ts"), "init", ...args.slice(2)],
            cwd: repoRoot,
            stdout: "pipe",
            stderr: "pipe",
          });
          const stdout = new TextDecoder().decode(result.stdout);
          const stderr = new TextDecoder().decode(result.stderr);
          if (sourceEntry === SKILL) {
            expect(stderr).toBe("");
            expect(result.exitCode).toBe(0);
            expect(stdout).toContain("Bound source-lock evidence:");
            expect(stdout).toContain(path.join(projectDir, "projections"));
            expect(stdout).toContain("Installation and doctor checks were not run");
          } else {
            expect(result.exitCode).toBe(1);
            expect(stderr).toContain("missing-entry");
            expect(stdout).not.toContain("Installer argv");
          }
          expect(fs.readdirSync(projectDir)).toEqual(before);
        }
      });
    });

    test("public init writes strict local evidence and completes install plus doctor", () => {
      withTempDir("bootstrap-public-local-install-", (root) => {
        const projectDir = path.join(root, "project");
        const repo = path.join(projectDir, "pack");
        const fixture = createMaterializedFixture(projectDir, repo);
        const policyPath = writePolicyFile(projectDir, strictPolicyForFixture(fixture));
        const homeDir = path.join(root, "isolated-home");
        fs.mkdirSync(homeDir);

        const result = Bun.spawnSync({
          cmd: [
            process.execPath,
            path.join(repoRoot, "scripts/commands/skill-sys.ts"),
            "init",
            "--repo",
            repo,
            "--ref",
            REF,
            "--project",
            projectDir,
            "--apps",
            "codex",
            "--profile",
            "default",
            "--source",
            fixture.pack,
            "--policy-file",
            policyPath,
            "--source-lock",
            "evidence/sources.lock.json",
            "--source-entry",
            SKILL,
            "--projection-dir",
            "projections",
          ],
          cwd: repoRoot,
          env: { ...process.env, SKILLPOOL_HOME: homeDir },
          stdout: "pipe",
          stderr: "pipe",
        });

        const stdout = new TextDecoder().decode(result.stdout);
        const stderr = new TextDecoder().decode(result.stderr);
        expect(stderr).toBe("");
        expect(result.exitCode).toBe(0);
        expect(stdout).toContain("Bound source-lock evidence:");
        expect(stdout).toContain("-> Verifying installation");
        expect(stdout).toContain("STATUS: PASS");
        expect(stdout).toContain("Done: skills installed and verified.");

        const lock = JSON.parse(fs.readFileSync(path.join(projectDir, ".skills.lock.json"), "utf8")) as Record<string, unknown>;
        expect(lock.policy).toEqual(strictPolicyForFixture(fixture));
        expect(lock.sourceLock).toEqual({
          path: "evidence/sources.lock.json",
          sha256: sha256Bytes(fixture.sourcesLockPath),
          entryName: SKILL,
        });
        expect(fs.existsSync(path.join(projectDir, ".agents", "skills", SKILL))).toBe(true);
        expect(fs.existsSync(path.join(projectDir, ".skills.state.json"))).toBe(true);
        expect(fs.readdirSync(homeDir)).toEqual([]);
      });
    });

    test.each([false, true])("init dry-run previews without reading or changing a prior lock (exists=%s)", (existingLock) => {
      withTempDir("bootstrap-init-preview-", (root) => {
        const projectDir = path.join(root, "project with spaces");
        const repo = path.join(projectDir, "pack");
        const fixture = createMaterializedFixture(projectDir, repo);
        writePolicyFile(projectDir, strictPolicyForFixture(fixture));
        const homeDir = path.join(root, "isolated-home");
        fs.mkdirSync(homeDir);
        const lockName = "preview.lock.json";
        const lockPath = path.join(projectDir, lockName);
        const beforeEntries = fs.readdirSync(projectDir).sort();
        // An existing lock must not become the input to a preview of its replacement.
        const original = "existing lock must remain untouched\n";
        if (existingLock) fs.writeFileSync(lockPath, original);
        const result = Bun.spawnSync({
          cmd: [process.execPath, path.join(repoRoot, "scripts/commands/skill-sys.ts"), "init",
            "--repo", repo, "--ref", REF, "--source", fixture.pack, "--project", projectDir,
            "--apps", "codex", "--profile", "default", "--skills", SKILL,
            "--policy-file", path.join(projectDir, "strict-policy.json"),
            "--source-lock", "evidence/sources.lock.json", "--source-entry", SKILL,
            "--projection-dir", "projections", "--lockfile", lockName, "--dry-run",
            ...(existingLock ? ["--force"] : [])],
          cwd: repoRoot,
          env: { ...process.env, SKILLPOOL_HOME: homeDir },
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = new TextDecoder().decode(result.stdout);
        expect(new TextDecoder().decode(result.stderr)).toBe("");
        expect(result.exitCode).toBe(0);
        expect(stdout).toContain("Installation and doctor checks were not run");
        expect(stdout).toContain(lockName);
        expect(fs.readdirSync(projectDir).sort()).toEqual(
          existingLock ? [...beforeEntries, lockName].sort() : beforeEntries
        );
        if (existingLock) expect(fs.readFileSync(lockPath, "utf8")).toBe(original);
        expect(fs.readdirSync(homeDir)).toEqual([]);
      });
    });

    test("missing or partial strict policy fails closed before any lockfile write", () => {
      withTempDir("bootstrap-strict-missing-", (root) => {
        const commit = "a".repeat(40);
        const { projectDir, sourceDir } = seedProject(root, commit);
        const recorder = makeRecorder();

        const missing = commandHelpers.captureCommand(() =>
          bootstrap.main(
            strictBootstrapArgs({
              projectDir,
              sourceLock: "evidence/sources.lock.json",
              sourceEntry: SKILL,
              source: sourceDir,
              projectionDir: "projections",
              omitPolicyFile: true,
            }),
            depsWith(() => REMOTE_REPO, recorder)
          )
        );
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain("Refusing bootstrap without strict offline evidence");
        expect(missing.stderr).toContain("--policy-file");
        expect(fs.existsSync(path.join(projectDir, ".skills.lock.json"))).toBe(false);

        const bare = commandHelpers.captureCommand(() =>
          bootstrap.main(strictBootstrapArgs({ projectDir, omitPolicyFile: true }), depsWith(() => REMOTE_REPO, recorder))
        );
        expect(bare.code).toBe(1);
        expect(bare.stderr).toContain("--policy-file");
        expect(bare.stderr).toContain("--source-lock");
        expect(bare.stderr).toContain("--source-entry");
        expect(bare.stderr).toContain("--source ");
        expect(bare.stderr).toContain("--projection-dir");
        expect(fs.existsSync(path.join(projectDir, ".skills.lock.json"))).toBe(false);

        const partialPath = writePolicyFile(
          projectDir,
          {
            requireSourceCommit: true,
            sourceCommit: commit,
            requireProjectionDigests: true,
            expectedProjectionDigests: [],
          },
          "partial-policy.json"
        );
        const partial = commandHelpers.captureCommand(() =>
          bootstrap.main(
            strictBootstrapArgs({
              projectDir,
              policyFile: partialPath,
              sourceLock: "evidence/sources.lock.json",
              sourceEntry: SKILL,
              source: sourceDir,
              projectionDir: "projections",
            }),
            depsWith(() => REMOTE_REPO, recorder)
          )
        );
        expect(partial.code).toBe(1);
        expect(partial.stderr).toContain("Incomplete strict bootstrap policy");
        expect(partial.stderr).toContain("requireSourceChecksum must be true");
        expect(fs.existsSync(path.join(projectDir, ".skills.lock.json"))).toBe(false);
        expect(recorder.calls).toHaveLength(0);
      });
    });

    test("rejects --refresh-cache in strict remote bootstrap", () => {
      withTempDir("bootstrap-strict-refresh-", (root) => {
        const { projectDir, sourceDir } = seedProject(root, "a".repeat(40));
        const recorder = makeRecorder();
        const result = commandHelpers.captureCommand(() =>
          bootstrap.main(
            strictBootstrapArgs({
              projectDir,
              policyFile: path.join(projectDir, "strict-policy.json"),
              sourceLock: "evidence/sources.lock.json",
              sourceEntry: SKILL,
              source: sourceDir,
              projectionDir: "projections",
              extra: ["--refresh-cache"],
            }),
            depsWith(() => REMOTE_REPO, recorder)
          )
        );
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("rejects --refresh-cache");
        expect(recorder.calls).toHaveLength(0);
        expect(fs.existsSync(path.join(projectDir, ".skills.lock.json"))).toBe(false);
      });
    });

    test("source-lock evidence mismatches fail closed without writes", () => {
      withTempDir("bootstrap-strict-evidence-", (root) => {
        const commit = "a".repeat(40);
        const { projectDir, sourceDir } = seedProject(root, commit);
        const base = {
          projectDir,
          policyFile: path.join(projectDir, "strict-policy.json"),
          sourceLock: "evidence/sources.lock.json",
          sourceEntry: SKILL,
          source: sourceDir,
          projectionDir: "projections",
        };
        const sourcesLockPath = path.join(projectDir, "evidence", "sources.lock.json");

        function rewriteSourcesLock(entryOverrides: Record<string, unknown>): void {
          sourceLockModule.writeSourceLock(sourcesLockPath, {
            version: 1,
            generatedAt: "2026-08-22T00:00:00.000Z",
            sources: [
              {
                name: SKILL,
                source: REMOTE_REPO,
                ref: REF,
                resolvedCommit: commit,
                manifestPath: `skills/${SKILL}/SKILL.md`,
                resolvedAt: "2026-08-22T00:00:00.000Z",
                ...entryOverrides,
              },
            ],
          });
        }

        const cases: Array<{ expected: string; entryOverrides: Record<string, unknown> }> = [
          { expected: "does not match --repo", entryOverrides: { source: "https://other.invalid/skills.git" } },
          { expected: "does not match --ref", entryOverrides: { ref: "v9.9.9" } },
          { expected: "resolvedCommit does not match policy sourceCommit", entryOverrides: { resolvedCommit: "f".repeat(40) } },
        ];

        for (const testCase of cases) {
          rewriteSourcesLock(testCase.entryOverrides);
          const result = commandHelpers.captureCommand(() =>
            bootstrap.main(strictBootstrapArgs(base), depsWith(() => REMOTE_REPO, makeRecorder()))
          );
          expect(result.code).toBe(1);
          expect(result.stderr).toContain(testCase.expected);
          expect(fs.existsSync(path.join(projectDir, ".skills.lock.json"))).toBe(false);
        }

        rewriteSourcesLock({});
        const wrongEntry = commandHelpers.captureCommand(() =>
          bootstrap.main(strictBootstrapArgs({ ...base, sourceEntry: "no-such-entry" }), depsWith(() => REMOTE_REPO, makeRecorder()))
        );
        expect(wrongEntry.code).toBe(1);
        expect(wrongEntry.stderr).toContain("has no unique entry");

        // A nonexistent path outside the project must be rejected by
        // containment even though nothing exists there yet.
        const escape = commandHelpers.captureCommand(() =>
          bootstrap.main(
            strictBootstrapArgs({ ...base, sourceLock: "../escaped.lock.json" }),
            depsWith(() => REMOTE_REPO, makeRecorder())
          )
        );
        expect(escape.code).toBe(1);
        expect(escape.stderr).toContain("must stay within project directory");

        // A symlink inside the project passes containment but is rejected by
        // the regular-file check before its bytes are read.
        fs.symlinkSync(sourcesLockPath, path.join(projectDir, "evidence", "linked.lock.json"));
        const symlinked = commandHelpers.captureCommand(() =>
          bootstrap.main(strictBootstrapArgs({ ...base, sourceLock: "evidence/linked.lock.json" }), depsWith(() => REMOTE_REPO, makeRecorder()))
        );
        expect(symlinked.code).toBe(1);
        expect(symlinked.stderr).toContain("Refusing to use symlinked --source-lock");
        expect(fs.existsSync(path.join(projectDir, ".skills.lock.json"))).toBe(false);
      });
    });

    test("credential-bearing --repo mismatches render redacted diagnostics without leaking tokens", () => {
      withTempDir("bootstrap-strict-cred-redact-", (root) => {
        const commit = "a".repeat(40);
        const { projectDir, sourceDir } = seedProject(root, commit);
        const base = {
          projectDir,
          policyFile: path.join(projectDir, "strict-policy.json"),
          sourceLock: "evidence/sources.lock.json",
          sourceEntry: SKILL,
          source: sourceDir,
          projectionDir: "projections",
        };

        // Direction 1: the CLI --repo carries credentials that never render.
        const bootstrapToken = "BOOTSTRAP-CI-TOKEN";
        const credRepo = `https://ci:${bootstrapToken}@example.invalid/skills.git`;
        const args = strictBootstrapArgs(base);
        args[args.indexOf("--repo") + 1] = credRepo;
        const result = commandHelpers.captureCommand(() =>
          bootstrap.main(args, depsWith(() => credRepo, makeRecorder()))
        );
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("does not match --repo");
        expect(result.stderr).toContain("expected=https://[REDACTED]@example.invalid/skills.git");
        expect(result.stderr).toContain("actual=https://example.invalid/skills.git");
        expect(result.stderr).not.toContain(bootstrapToken);
        expect(fs.existsSync(path.join(projectDir, ".skills.lock.json"))).toBe(false);

        // Direction 2: the credential lives inside the evidence entry.
        const evidenceToken = "EVIDENCE-SOURCE-TOKEN";
        sourceLockModule.writeSourceLock(path.join(projectDir, "evidence", "sources.lock.json"), {
          version: 1,
          generatedAt: "2026-08-22T00:00:00.000Z",
          sources: [
            {
              name: SKILL,
              source: `https://evidence:${evidenceToken}@example.invalid/skills.git`,
              ref: REF,
              resolvedCommit: commit,
              manifestPath: `skills/${SKILL}/SKILL.md`,
              resolvedAt: "2026-08-22T00:00:00.000Z",
            },
          ],
        });
        const reversed = commandHelpers.captureCommand(() =>
          bootstrap.main(strictBootstrapArgs(base), depsWith(() => REMOTE_REPO, makeRecorder()))
        );
        expect(reversed.code).toBe(1);
        expect(reversed.stderr).toContain("does not match --repo");
        expect(reversed.stderr).toContain("actual=https://[REDACTED]@example.invalid/skills.git");
        expect(reversed.stderr).not.toContain(evidenceToken);
        expect(fs.existsSync(path.join(projectDir, ".skills.lock.json"))).toBe(false);
      });
    });

    test("local repo identities fail before lock creation without strict evidence", () => {
      withTempDir("bootstrap-local-flow-", (root) => {
        const projectDir = path.join(root, "project");
        const localRepo = path.join(root, "local-skills-repo");
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(localRepo, { recursive: true });
        const recorder = makeRecorder();
        const result = commandHelpers.captureCommand(() =>
          bootstrap.main(
            strictBootstrapArgs({ projectDir, repo: localRepo, omitPolicyFile: true }),
            depsWith(() => localRepo, recorder)
          )
        );

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("strict offline evidence");
        expect(result.stderr).toContain("--policy-file");
        expect(fs.existsSync(path.join(projectDir, ".skills.lock.json"))).toBe(false);
        expect(recorder.calls).toHaveLength(0);
      });
    });
  });

  // Install-side evidence verification: the installer must repeat validation
  // before source resolution and target writes.
  describe("install-side evidence verification", () => {
    function installOptions() {
      return {
        universalContractScript: "noop-universal-contract.ts",
        skillMetadataScript: "noop-skill-metadata.ts",
        skillLifecycleScript: "noop-skill-lifecycle.ts",
        runUniversalContract: commandHelpers.okAudit,
        runSkillMetadataAudit: commandHelpers.okAudit,
        runSkillLifecycleAudit: commandHelpers.okLifecycleAudit,
      };
    }

    interface Fixture {
      projectDir: string;
      pack: string;
      sourcesLockPath: string;
      commit: string;
    }

    function createFixture(root: string, repo: string = REMOTE_REPO): Fixture {
      const projectDir = path.join(root, "project");
      const materialized = createMaterializedFixture(projectDir, repo);

      // Simulate what bootstrap wrote: primary lock with complete policy pins
      // plus the source-lock evidence binding over the exact file bytes.
      files.writeFileAtomicSafe(
        path.join(projectDir, ".skills.lock.json"),
        `${JSON.stringify(
          {
            repo: repo,
            ref: REF,
            installs: [{ app: "codex", skills: [SKILL] }],
            policy: strictPolicyForFixture(materialized),
            sourceLock: {
              path: "evidence/sources.lock.json",
              sha256: sha256Bytes(materialized.sourcesLockPath),
              entryName: SKILL,
            },
          },
          null,
          2
        )}\n`
      );

      return {
        projectDir: materialized.projectDir,
        pack: materialized.pack,
        sourcesLockPath: materialized.sourcesLockPath,
        commit: materialized.commit,
      };
    }

    function runInstall(fixture: Fixture): { code: number; stdout: string; stderr: string } {
      return commandHelpers.captureCommand(() =>
        install.installCommand(
          {
            project: fixture.projectDir,
            lockfile: ".skills.lock.json",
            source: fixture.pack,
            "projection-dir": path.join(fixture.projectDir, "projections"),
          },
          installOptions()
        )
      );
    }

    function assertNothingInstalled(projectDir: string): void {
      expect(fs.existsSync(path.join(projectDir, ".agents", "skills", SKILL))).toBe(false);
      expect(fs.existsSync(path.join(projectDir, ".skills.state.json"))).toBe(false);
    }

    test("valid bound lock installs fully offline and never touches the source cache or network", () => {
      withTempDir("bootstrap-install-valid-", (root) => {
        const fixture = createFixture(root);
        const result = runInstall(fixture);

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`Verified source lock evidence: evidence/sources.lock.json (${SKILL})`);
        expect(fs.existsSync(path.join(fixture.projectDir, ".agents", "skills", SKILL))).toBe(true);
        expect(fs.existsSync(path.join(fixture.projectDir, ".skills.state.json"))).toBe(true);
        // example.invalid is unreachable; success with --source proves install
        // attempted no ls-remote/fetch. The isolated SKILLPOOL_HOME proves no
        // cache entry was created either.
        expect(fs.existsSync(path.join(skillpoolHome, "sources"))).toBe(false);
      });
    });

    test("tampered source-lock bytes are rejected before any target write", () => {
      withTempDir("bootstrap-install-tamper-", (root) => {
        const fixture = createFixture(root);
        fs.appendFileSync(fixture.sourcesLockPath, "\n"); // byte tamper only
        const result = runInstall(fixture);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("do not match the pinned sha256");
        assertNothingInstalled(fixture.projectDir);
      });
    });

    test("binding paths outside the project or symlinked bindings fail closed", () => {
      withTempDir("bootstrap-install-boundary-", (root) => {
        const fixture = createFixture(root);

        // Escape: rewrite binding to point outside the project.
        const lockRaw = fs.readFileSync(path.join(fixture.projectDir, ".skills.lock.json"), "utf8");
        const escaped = JSON.parse(lockRaw) as Record<string, unknown>;
        escaped.sourceLock = {
          path: "../outside.lock.json",
          sha256: sha256Bytes(fixture.sourcesLockPath),
          entryName: SKILL,
        };
        files.writeFileAtomicSafe(path.join(fixture.projectDir, ".skills.lock.json"), `${JSON.stringify(escaped, null, 2)}\n`);
        let result = runInstall(fixture);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("must stay within project directory");
        assertNothingInstalled(fixture.projectDir);

        // Symlink inside the project passes containment but is rejected by
        // the regular-file check before its bytes are read.
        fs.symlinkSync(fixture.sourcesLockPath, path.join(fixture.projectDir, "evidence", "linked.lock.json"));
        const symlinked = JSON.parse(lockRaw) as Record<string, unknown>;
        symlinked.sourceLock = {
          path: "evidence/linked.lock.json",
          sha256: sha256Bytes(fixture.sourcesLockPath),
          entryName: SKILL,
        };
        files.writeFileAtomicSafe(path.join(fixture.projectDir, ".skills.lock.json"), `${JSON.stringify(symlinked, null, 2)}\n`);
        result = runInstall(fixture);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Refusing to read symlinked source lock file");
        assertNothingInstalled(fixture.projectDir);
      });
    });

    test("a valid-bytes source lock whose entry mismatches repo/ref/commit fails closed", () => {
      withTempDir("bootstrap-install-entry-", (root) => {
        const fixture = createFixture(root);

        // Rebind to a source lock whose bytes are internally consistent but
        // whose resolvedCommit differs from the policy pin.
        sourceLockModule.writeSourceLock(path.join(root, "mismatched.lock.json"), {
          version: 1,
          generatedAt: "2026-08-22T00:00:00.000Z",
          sources: [
            {
              name: SKILL,
              source: REMOTE_REPO,
              ref: REF,
              resolvedCommit: "f".repeat(40),
              manifestPath: `skills/${SKILL}/SKILL.md`,
              resolvedAt: "2026-08-22T00:00:00.000Z",
            },
          ],
        });
        fs.copyFileSync(path.join(root, "mismatched.lock.json"), fixture.sourcesLockPath);
        const lockRaw = fs.readFileSync(path.join(fixture.projectDir, ".skills.lock.json"), "utf8");
        const rebound = JSON.parse(lockRaw) as Record<string, unknown>;
        rebound.sourceLock = {
          path: "evidence/sources.lock.json",
          sha256: sha256Bytes(fixture.sourcesLockPath),
          entryName: SKILL,
        };
        files.writeFileAtomicSafe(path.join(fixture.projectDir, ".skills.lock.json"), `${JSON.stringify(rebound, null, 2)}\n`);

        const result = runInstall(fixture);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("resolvedCommit does not match policy sourceCommit");
        assertNothingInstalled(fixture.projectDir);
      });
    });

    test("identical credential-bearing repos still bind byte-exactly", () => {
      withTempDir("bootstrap-install-cred-eq-", (root) => {
        // Equality checks must see the raw values: the same credential-bearing
        // URL on both sides binds and installs normally.
        const credRepo = "https://ci:INSTALL-SHARED-TOKEN@example.invalid/skills.git";
        const fixture = createFixture(root, credRepo);
        const result = runInstall(fixture);

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(`Verified source lock evidence: evidence/sources.lock.json (${SKILL})`);
        expect(result.stdout).not.toContain("INSTALL-SHARED-TOKEN");
        expect(fs.existsSync(path.join(fixture.projectDir, ".agents", "skills", SKILL))).toBe(true);
      });
    });

    test("credential-bearing repo mismatch renders redacted diagnostics without leaking tokens", () => {
      withTempDir("bootstrap-install-cred-mismatch-", (root) => {
        const fixture = createFixture(root);
        const mismatchToken = "INSTALL-EVIDENCE-TOKEN";
        sourceLockModule.writeSourceLock(fixture.sourcesLockPath, {
          version: 1,
          generatedAt: "2026-08-22T00:00:00.000Z",
          sources: [
            {
              name: SKILL,
              source: `https://other:${mismatchToken}@example.invalid/skills.git`,
              ref: REF,
              resolvedCommit: fixture.commit,
              manifestPath: `skills/${SKILL}/SKILL.md`,
              resolvedAt: "2026-08-22T00:00:00.000Z",
            },
          ],
        });
        const lockRaw = fs.readFileSync(path.join(fixture.projectDir, ".skills.lock.json"), "utf8");
        const rebound = JSON.parse(lockRaw) as Record<string, unknown>;
        rebound.sourceLock = {
          path: "evidence/sources.lock.json",
          sha256: sha256Bytes(fixture.sourcesLockPath),
          entryName: SKILL,
        };
        files.writeFileAtomicSafe(path.join(fixture.projectDir, ".skills.lock.json"), `${JSON.stringify(rebound, null, 2)}\n`);

        const result = runInstall(fixture);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("does not match lockfile repo");
        expect(result.stderr).toContain("expected=https://example.invalid/skills.git");
        expect(result.stderr).toContain("actual=https://[REDACTED]@example.invalid/skills.git");
        expect(result.stderr).not.toContain(mismatchToken);
        assertNothingInstalled(fixture.projectDir);
      });
    });

    test("existing strict locks without sourceLock continue to install unchanged", () => {
      withTempDir("bootstrap-install-nobinding-", (root) => {
        const fixture = createFixture(root);
        const lockRaw = fs.readFileSync(path.join(fixture.projectDir, ".skills.lock.json"), "utf8");
        const withoutBinding = JSON.parse(lockRaw) as Record<string, unknown>;
        delete withoutBinding.sourceLock;
        files.writeFileAtomicSafe(path.join(fixture.projectDir, ".skills.lock.json"), `${JSON.stringify(withoutBinding, null, 2)}\n`);

        const result = runInstall(fixture);
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain("Verified source lock evidence");
        expect(fs.existsSync(path.join(fixture.projectDir, ".agents", "skills", SKILL))).toBe(true);
      });
    });
  });
});
