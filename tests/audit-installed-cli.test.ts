import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestTreeStrict } from "../scripts/lib/files.ts";

import {
  main,
  parseArgs,
  runAuditInstalled,
  type AuditInstalledReport,
} from "../scripts/commands/audit-installed.ts";

function makeProject(options: { lock?: object; installs?: string[] } = {}): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "audit-installed-"));
  if (options.lock) {
    fs.writeFileSync(
      path.join(project, "skills-lock.json"),
      JSON.stringify(options.lock),
      "utf8",
    );
  }
  const target = path.join(project, ".agents", "skills");
  fs.mkdirSync(target, { recursive: true });
  for (const name of options.installs ?? []) {
    fs.mkdirSync(path.join(target, name));
  }
  return project;
}

function capture(lines: string[]): (line: string) => void {
  return (line: string) => lines.push(line);
}

function parseReport(stdoutLines: string[]): AuditInstalledReport {
  return JSON.parse(stdoutLines.join("\n")) as AuditInstalledReport;
}

describe("parseArgs", () => {
  test("applies defaults and known flags", () => {
    const args = parseArgs([
      "bun",
      "audit-installed.ts",
      "--project",
      "/tmp/p",
      "--global",
      "--strict",
      "--json",
    ]);
    expect(args.project).toBe("/tmp/p");
    expect(args.manager).toBe("skills");
    expect(args.global).toBe(true);
    expect(args.strict).toBe(true);
    expect(args.json).toBe(true);
  });

  test("rejects unknown options and missing values", () => {
    for (const argv of [
      ["bun", "x", "--wat"],
      ["bun", "x", "--project"],
      ["positional"],
    ]) {
      expect(() => parseArgs(["bun", "audit-installed.ts", ...argv])).toThrow();
    }
  });
});

describe("runAuditInstalled", () => {
  test("audits a healthy install against its lock entry", async () => {
    const project = makeProject({
      lock: {
        skills: [{ name: "alpha", sourceUrl: "https://github.com/o/r.git" }],
      },
      installs: ["alpha"],
    });
    const report = await runAuditInstalled({
      project,
      manager: "skills",
      lockfile: null,
      home: null,
      includeGlobal: false,
      now: () => "2026-08-21T00:00:00Z",
    });
    expect(report.checkedAt).toBe("2026-08-21T00:00:00Z");
    expect(report.manager).toBe("skills");
    expect(report.targetsScanned).toEqual([path.join(project, ".agents", "skills")]);
    expect(report.audit.summary.installs).toBe(1);
    expect(report.audit.findings[0]?.verdict).toBe("NEEDS_UPSTREAM_VERIFICATION");
  });

  test("skips a missing project target without failing", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "audit-empty-"));
    const report = await runAuditInstalled({
      project,
      manager: "skills",
      lockfile: null,
      home: null,
      includeGlobal: false,
    });
    expect(report.audit.summary.installs).toBe(0);
    // No lockfile and no installs: nothing to report.
    expect(report.audit.findings).toHaveLength(0);
  });

  test("verify-upstream MATCHes equal installed/upstream trees via strict digests", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "audit-upstream-"));
    const lock = {
      skills: [
        {
          name: "alpha",
          sourceUrl: "https://github.com/o/r.git",
          ref: "v1",
          skillPath: "skills/alpha",
        },
      ],
    };
    fs.writeFileSync(path.join(project, "skills-lock.json"), JSON.stringify(lock), "utf8");
    const target = path.join(project, ".agents", "skills", "alpha");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "# alpha", "utf8");

    // Independent equal upstream tree, digested exactly like the default
    // git materializer would (strict walk).
    const upstreamTree = fs.mkdtempSync(path.join(os.tmpdir(), "audit-up-tree-"));
    try {
      const upstreamSkill = path.join(upstreamTree, "alpha");
      fs.mkdirSync(upstreamSkill, { recursive: true });
      fs.writeFileSync(path.join(upstreamSkill, "SKILL.md"), "# alpha", "utf8");
      expect(digestTreeStrict(upstreamSkill)).toBe(digestTreeStrict(target));

      const report = await runAuditInstalled({
        project,
        manager: "skills",
        lockfile: null,
        home: null,
        includeGlobal: false,
        verifyUpstream: true,
        materialize: async () => digestTreeStrict(upstreamSkill),
        now: () => "2026-08-21T00:00:00Z",
      });
      expect(report.audit.summary.safeToAdopt).toBe(1);
      const finding = report.audit.findings[0];
      expect(finding?.verdict).toBe("SAFE_TO_ADOPT");
      expect(finding?.states).toContain("STRUCTURAL_MATCH");
      expect(report.audit.findings.some((f) => f.states.includes("DRIFTED"))).toBe(false);
    } finally {
      fs.rmSync(upstreamTree, { recursive: true, force: true });
    }
  });

  test("verify-upstream fails closed on inner symlinks instead of matching", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "audit-symlink-"));
    const lock = {
      skills: [
        {
          name: "alpha",
          sourceUrl: "https://github.com/o/r.git",
          ref: "v1",
          skillPath: "skills/alpha",
        },
      ],
    };
    fs.writeFileSync(path.join(project, "skills-lock.json"), JSON.stringify(lock), "utf8");
    const target = path.join(project, ".agents", "skills", "alpha");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "# alpha", "utf8");
    // Symlink INSIDE the installed tree; a strict walk must refuse this tree.
    fs.symlinkSync(project, path.join(target, "linked"));

    // Clean twin WOULD match if the inner symlink were silently skipped.
    const cleanTwin = fs.mkdtempSync(path.join(os.tmpdir(), "audit-twin-"));
    try {
      fs.writeFileSync(path.join(cleanTwin, "SKILL.md"), "# alpha", "utf8");

      const report = await runAuditInstalled({
        project,
        manager: "skills",
        lockfile: null,
        home: null,
        includeGlobal: false,
        verifyUpstream: true,
        materialize: async () => digestTreeStrict(cleanTwin),
        now: () => "2026-08-21T00:00:00Z",
      });
      // No digest computed for the symlinked tree: no check fed, no safe verdict.
      expect(report.audit.summary.safeToAdopt).toBe(0);
      expect(
        report.audit.findings.some((f) => f.states.includes("STRUCTURAL_MATCH")),
      ).toBe(false);
      const finding = report.audit.findings[0];
      expect(finding?.verdict).not.toBe("SAFE_TO_ADOPT");
    } finally {
      fs.rmSync(cleanTwin, { recursive: true, force: true });
    }
  });
});

describe("main", () => {
  test("emits JSON report to stdout and summary to stderr", async () => {
    const project = makeProject({ installs: ["orphan"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await main(
      ["bun", "audit-installed.ts", "--project", project],
      { stdout: capture(stdout), stderr: capture(stderr) },
    );
    expect(exit).toBe(0);
    const report = parseReport(stdout);
    expect(report.audit.summary.installs).toBe(1);
    expect(stderr.some((line) => line.includes("orphan [project] BLOCKED"))).toBe(true);
    expect(stderr.some((line) => line.includes("install(s)"))).toBe(true);
  });

  test("--strict exits non-zero when findings are blocked", async () => {
    const project = makeProject({ installs: ["orphan"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await main(
      ["bun", "audit-installed.ts", "--project", project, "--strict"],
      { stdout: capture(stdout), stderr: capture(stderr) },
    );
    expect(exit).toBe(1);
  });

  test("reports stale lock entries for ghost declarations", async () => {
    const project = makeProject({
      lock: { skills: [{ name: "ghost" }] },
      installs: [],
    });
    const stdout: string[] = [];
    await main(["bun", "audit-installed.ts", "--project", project], {
      stdout: capture(stdout),
      stderr: () => {},
    });
    const report = parseReport(stdout);
    expect(report.audit.summary.staleLockEntries).toBe(1);
    expect(report.audit.findings[0]?.states).toEqual(["LOCK_ENTRY_STALE"]);
  });

  test("flags symlink escapes as FOREIGN_SYMLINK blocks", async () => {
    const project = makeProject({
      lock: { skills: [{ name: "linked" }] },
    });
    const target = path.join(project, ".agents", "skills");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    fs.symlinkSync(outside, path.join(target, "linked"));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await main(
      ["bun", "audit-installed.ts", "--project", project, "--strict"],
      { stdout: capture(stdout), stderr: capture(stderr) },
    );
    expect(exit).toBe(1);
    const report = parseReport(stdout);
    const finding = report.audit.findings.find((f) => f.name === "linked");
    expect(finding?.states).toContain("FOREIGN_SYMLINK");
    expect(finding?.verdict).toBe("BLOCKED");
  });

  test("--global merges global lock entries and target installs via home override", async () => {
    const project = makeProject({ installs: ["proj-skill"] });
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
    const globalTarget = path.join(fakeHome, ".agents", "skills");
    fs.mkdirSync(globalTarget, { recursive: true });
    fs.mkdirSync(path.join(globalTarget, "glob-skill"));
    fs.writeFileSync(
      path.join(fakeHome, ".agents", ".skill-lock.json"),
      JSON.stringify({ skills: [{ name: "glob-skill" }] }),
      "utf8",
    );

    const stdout: string[] = [];
    await main(
      [
        "bun",
        "audit-installed.ts",
        "--project",
        project,
        "--home",
        fakeHome,
        "--global",
      ],
      { stdout: capture(stdout), stderr: () => {} },
    );
    const report = parseReport(stdout);
    expect(report.audit.summary.installs).toBe(2);
    const names = report.audit.findings.map((f) => f.name).sort();
    expect(names).toEqual(["glob-skill", "proj-skill"]);
    expect(report.targetsScanned).toContain(globalTarget);
  });

  test("--global surfaces absent global lock and target instead of silent narrowing", async () => {
    const project = makeProject({ installs: ["proj"] });
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "empty-home-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await main(
      [
        "bun",
        "audit-installed.ts",
        "--project",
        project,
        "--home",
        fakeHome,
        "--global",
      ],
      { stdout: capture(stdout), stderr: capture(stderr) },
    );
    expect(exit).toBe(0);
    const report = parseReport(stdout);
    const joined = report.absentScopes.join("\n");
    expect(joined).toContain("global lock absent");
    expect(joined).toContain("global target missing");
    expect(stderr.some((line) => line.includes("global lock absent"))).toBe(true);
  });

  test("mid-run global failure emits no stdout report and exits 2", async () => {
    const project = makeProject({ installs: ["proj"] });
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bad-home-"));
    const agentsDir = path.join(fakeHome, ".agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(path.join(agentsDir, ".skill-lock.json")); // directory at lock path
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await main(
      [
        "bun",
        "audit-installed.ts",
        "--project",
        project,
        "--home",
        fakeHome,
        "--global",
      ],
      { stdout: capture(stdout), stderr: capture(stderr) },
    );
    expect(exit).toBe(2);
    expect(stdout).toHaveLength(0); // no misleading partial JSON
    expect(stderr[0]).toContain("LOCK_UNREADABLE");
  });

  test("malformed foreign-lock entries surface as warnings in report and stderr", async () => {
    const project = makeProject({
      lock: { skills: [{ noNameHere: true }, { name: "good" }] },
      installs: [],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await main(["bun", "audit-installed.ts", "--project", project], {
      stdout: capture(stdout),
      stderr: capture(stderr),
    });
    expect(exit).toBe(0);
    const report = parseReport(stdout);
    expect(report.lockWarnings).toHaveLength(1);
    expect(report.lockWarnings[0]).toContain("project:");
    expect(stderr.some((line) => line.includes("lock warning: project:"))).toBe(true);
  });

  test("unsupported managers fail with exit code 2", async () => {
    const stderr: string[] = [];
    const exit = await main(["bun", "audit-installed.ts", "--manager", "npm"], {
      stderr: capture(stderr),
    });
    expect(exit).toBe(2);
    expect(stderr[0]).toContain("unsupported manager");
  });

  test("corrupt project locks fail with exit code 2", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "audit-bad-"));
    fs.writeFileSync(path.join(project, "skills-lock.json"), "{ nope", "utf8");
    const stderr: string[] = [];
    const exit = await main(["bun", "audit-installed.ts", "--project", project], {
      stderr: capture(stderr),
    });
    expect(exit).toBe(2);
    expect(stderr[0]).toContain("LOCK_PARSE_INVALID");
  });

  test("--help prints usage and exits 0", async () => {
    const stdout: string[] = [];
    const exit = await main(["bun", "audit-installed.ts", "--help"], {
      stdout: capture(stdout),
    });
    expect(exit).toBe(0);
    expect(stdout.join("\n")).toContain("Usage:");
  });
});
