import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestTreeStrict } from "../scripts/lib/files.ts";

import { main, parseArgs } from "../scripts/commands/adopt-installed.ts";

function makeFixture(options: {
  lock: object;
  fileBody?: string;
}): { project: string; installDir: string; installedDigest: string } {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-plan-"));
  fs.writeFileSync(
    path.join(project, "skills-lock.json"),
    JSON.stringify(options.lock),
    "utf8",
  );
  const target = path.join(project, ".agents", "skills", "good");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, "SKILL.md"),
    options.fileBody ?? "# good skill",
    "utf8",
  );
  return {
    project,
    installDir: target,
    installedDigest: digestTreeStrict(target),
  };
}

const GOOD_LOCK = {
  skills: [
    {
      name: "good",
      sourceUrl: "https://github.com/o/r.git",
      ref: "v1",
      skillPath: "skills/good",
    },
    {
      name: "ghost",
      sourceUrl: "https://github.com/o/other.git",
      ref: "main",
      skillPath: "skills/ghost",
    },
  ],
};

function capture(): {
  stdout: string[];
  stderr: string[];
  stdoutFn: (line: string) => void;
  stderrFn: (line: string) => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdoutFn: (l) => stdout.push(l),
    stderrFn: (l) => stderr.push(l),
  };
}

describe("parseArgs", () => {
  test("accepts plan flags and rejects unknown ones", () => {
    const args = parseArgs(["bun", "x", "--project", "p", "--global"]);
    expect(args.manager).toBe("skills");
    expect(args.global).toBe(true);
    expect(() => parseArgs(["bun", "x", "--wat"])).toThrow();
  });
});

describe("main (plan mode)", () => {
  test("emits an adoption action for digest-verified installs", async () => {
    const fixture = makeFixture({ lock: GOOD_LOCK });
    const out = capture();
    const exit = await main(
      ["bun", "x", "--project", fixture.project, "--json"],
      {
        stdout: out.stdoutFn,
        stderr: out.stderrFn,
        materialize: async () => fixture.installedDigest,
        now: () => new Date(0),
      },
    );

    expect(exit).toBe(0);
    const report = JSON.parse(out.stdout.join("\n")) as {
      actions: Array<{ name: string; steps: string[]; evidence?: Record<string, string> }>;
      audit: { summary: { blocked: number } };
    };
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]?.name).toBe("good");
    expect(report.actions[0]?.steps.join(" ")).toContain("generate-lock");
    expect(report.actions[0]?.evidence?.installedDigest).toBe(
      fixture.installedDigest,
    );
    // Ghost lock entry stays blocked/stale and never becomes an action.
    expect(report.audit.summary.blocked).toBeGreaterThanOrEqual(1);
  });

  test("digest mismatch keeps the finding externally managed", async () => {
    const fixture = makeFixture({ lock: GOOD_LOCK });
    const out = capture();
    await main(["bun", "x", "--project", fixture.project], {
      stdout: out.stdoutFn,
      stderr: out.stderrFn,
      materialize: async () => "different-upstream-digest",
    });
    const report = JSON.parse(out.stdout.join("\n")) as {
      actions: unknown[];
    };
    expect(report.actions).toHaveLength(0);
  });

  test("without upstream verification nothing becomes adoptable", async () => {
    const fixture = makeFixture({ lock: GOOD_LOCK });
    const out = capture();
    await main(["bun", "x", "--project", fixture.project], { stdout: out.stdoutFn, stderr: out.stderrFn });
    const report = JSON.parse(out.stdout.join("\n")) as {
      actions: unknown[];
      audit: { summary: { needsUpstreamVerification: number } };
    };
    expect(report.actions).toHaveLength(0);
    expect(report.audit.summary.needsUpstreamVerification).toBe(1);
  });

  test("equal installed/upstream trees MATCH end-to-end with strict digests", async () => {
    const fixture = makeFixture({ lock: GOOD_LOCK });
    // Independent upstream tree with identical content — the materializer
    // digests it exactly like the default git materializer would (strict walk).
    const upstreamTree = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-upstream-"));
    try {
      const skillRoot = path.join(upstreamTree, "skills", "good");
      fs.mkdirSync(skillRoot, { recursive: true });
      fs.writeFileSync(
        path.join(skillRoot, "SKILL.md"),
        "# good skill",
        "utf8",
      );
      expect(digestTreeStrict(skillRoot)).toBe(fixture.installedDigest);

      const out = capture();
      await main(["bun", "x", "--project", fixture.project, "--json"], {
        stdout: out.stdoutFn,
        stderr: out.stderrFn,
        materialize: async () => digestTreeStrict(skillRoot),
        now: () => new Date(0),
      });
      const report = JSON.parse(out.stdout.join("\n")) as {
        actions: Array<{
          name: string;
          evidence?: Record<string, string>;
        }>;
        audit: {
          findings: Array<{ name: string; verdict: string; states: string[] }>;
          summary: { safeToAdopt: number };
        };
      };
      expect(report.audit.summary.safeToAdopt).toBe(1);
      const good = report.audit.findings.find((f) => f.name === "good");
      expect(good?.verdict).toBe("SAFE_TO_ADOPT");
      expect(good?.states).toContain("STRUCTURAL_MATCH");
      expect(report.actions).toHaveLength(1);
      expect(report.actions[0]?.evidence?.installedDigest).toBe(fixture.installedDigest);
      expect(report.actions[0]?.evidence?.upstreamDigest).toBe(fixture.installedDigest);
    } finally {
      fs.rmSync(upstreamTree, { recursive: true, force: true });
    }
  });

  test("inner symlinks in the installed tree fail closed and never produce a false MATCH", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-symlink-"));
    const outside = path.join(project, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "SENTINEL.txt"), "SENTINEL", "utf8");
    fs.writeFileSync(
      path.join(project, "skills-lock.json"),
      JSON.stringify(GOOD_LOCK),
      "utf8",
    );
    const target = path.join(project, ".agents", "skills", "good");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "# good skill", "utf8");
    // Symlink INSIDE the installed tree pointing at outside content. The old
    // dirDigest silently skipped it; the strict digest must refuse the tree.
    fs.symlinkSync(outside, path.join(target, "linked"));

    // A clean twin of the tree would MATCH if the symlink were skipped.
    const cleanTwin = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-twin-"));
    try {
      fs.writeFileSync(path.join(cleanTwin, "SKILL.md"), "# good skill", "utf8");

      const out = capture();
      await main(["bun", "x", "--project", project, "--json"], {
        stdout: out.stdoutFn,
        stderr: out.stderrFn,
        materialize: async () => digestTreeStrict(cleanTwin),
        now: () => new Date(0),
      });
      const report = JSON.parse(out.stdout.join("\n")) as {
        actions: Array<{ name: string; evidence?: Record<string, string> }>;
        audit: {
          findings: Array<{ name: string; verdict: string; states: string[] }>;
          summary: { safeToAdopt: number; needsUpstreamVerification: number };
        };
      };
      // Fail-closed: no digest, no upstream check, no adoption action.
      expect(report.audit.summary.safeToAdopt).toBe(0);
      expect(report.audit.summary.needsUpstreamVerification).toBe(1);
      expect(report.actions).toHaveLength(0);
      const good = report.audit.findings.find((f) => f.name === "good");
      expect(good?.states).not.toContain("STRUCTURAL_MATCH");
      expect(good?.verdict).not.toBe("SAFE_TO_ADOPT");
    } finally {
      fs.rmSync(cleanTwin, { recursive: true, force: true });
    }
  });

  test("--apply is rejected with the governance message", async () => {
    const out = capture();
    const exit = await main(
      ["bun", "x", "--apply"],
      {
        stdout: out.stdoutFn,
        stderr: out.stderrFn,
        materialize: async () => "x",
      },
    );
    expect(exit).toBe(2);
    expect(out.stdout).toHaveLength(0);
    expect(out.stderr[0]).toContain("not implemented");
    expect(out.stderr[0]).toContain("ownership-state specification");
  });

  test("corrupt project locks fail cleanly", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-bad-"));
    fs.writeFileSync(path.join(project, "skills-lock.json"), "{nope", "utf8");
    const out = capture();
    const exit = await main(["bun", "x", "--project", project], {
      stdout: out.stdoutFn,
      stderr: out.stderrFn,
    });
    expect(exit).toBe(2);
    expect(out.stderr[0]).toContain("LOCK_PARSE_INVALID");
  });

  test("--help prints usage through injected stdout", async () => {
    const out = capture();
    const exit = await main(["bun", "x", "--help"], { stdout: out.stdoutFn });
    expect(exit).toBe(0);
    expect(out.stdout.join("\n")).toContain("Usage:");
  });
});
