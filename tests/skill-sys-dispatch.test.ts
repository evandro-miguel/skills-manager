import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "../scripts/commands/skill-sys.ts";
import { digestTreeStrict } from "../scripts/lib/files.ts";

const REPO_ROOT = path.resolve(__dirname, "..");
const MINIMAL_SKILLPACK = path.join(REPO_ROOT, "examples", "minimal-skillpack");

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempProject(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeSkill(project: string, target: string, body = "# Skill\n"): string {
  const dir = path.join(project, target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
  return dir;
}

function writeState(project: string, installed: unknown[]): void {
  fs.writeFileSync(
    path.join(project, ".skills.state.json"),
    `${JSON.stringify({ schemaVersion: 2, mode: "minimal", installed }, null, 2)}\n`,
    "utf8",
  );
}

function readState(project: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(project, ".skills.state.json"), "utf8"));
}

describe("skill-sys main dispatch", () => {
  test("use dispatches a local skillpack and emits skill text", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main(
      ["bun", "skill-sys", "use", MINIMAL_SKILLPACK, "--skill", "example-skill"],
      { cwd: REPO_ROOT, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    );
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("example-skill");
    expect(stdout.join("\n")).toContain("Example Skill");
    expect(stderr).toEqual([]);
  });

  test("remove --apply deletes a managed skill through main", () => {
    const project = tempProject("skill-sys-dispatch-remove-");
    const target = ".agents/skills/alpha";
    writeSkill(project, target, "# Alpha\n");
    writeState(project, [{
      managedBy: "skill-sys",
      app: "codex",
      skill: "alpha",
      target,
      installMode: "projection",
      skillDigest: digestTreeStrict(path.join(project, target)),
    }]);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = main(
      ["bun", "skill-sys", "remove", "--project", project, "--skill", "alpha", "--apply"],
      { cwd: REPO_ROOT, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    );

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(project, target))).toBe(false);
    expect(readState(project).installed).toEqual([]);
    expect(stdout.join("\n")).toContain("STATUS: APPLY");
  });

  test("update forwards a requested skill to the upgrade backend", () => {
    const captured: string[][] = [];
    const code = main(
      ["bun", "skill-sys", "update", "alpha", "--project", "."],
      {
        cwd: REPO_ROOT,
        run: (argv) => {
          captured.push(argv);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("upgrade");
    expect(captured[0]).toContain("--skills");
    expect(captured[0]).toContain("alpha");
  });

  test("eval receipt forwards only data-validation inputs to the offline backend", () => {
    const captured: string[][] = [];
    const code = main(
      ["bun", "skill-sys", "eval", "receipt", "--receipt", "receipt.json", "--source-digest", "a".repeat(64), "--fixture-digest", "b".repeat(64), "--case-ids", "case-a,case-b", "--provider", "example-provider", "--model", "example/model-v1", "--json"],
      { cwd: REPO_ROOT, run: (argv) => { captured.push(argv); return { code: 0, stdout: "", stderr: "" }; } },
    );
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.some((argument) => argument.endsWith("eval-receipt.ts"))).toBe(true);
    expect(captured[0]).toContain("--source-digest");
    expect(captured[0]).toContain("--fixture-digest");
    expect(captured[0]).toContain("--json");
  });

  test("update forwards --source so profile-declared skills can be resolved", () => {
    const captured: string[][] = [];
    const code = main(
      ["bun", "skill-sys", "update", "alpha", "--project", ".", "--source", "examples/minimal-skillpack"],
      {
        cwd: REPO_ROOT,
        run: (argv) => {
          captured.push(argv);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(code).toBe(0);
    expect(captured[0]).toContain("--source");
    expect(captured[0]).toContain("examples/minimal-skillpack");
    expect(captured[0]).toContain("--skills");
    expect(captured[0]).toContain("alpha");
  });

  test("project-learnings append forwards the subcommand and all write options", () => {
    const captured: string[][] = [];
    const code = main(
      [
        "bun",
        "skill-sys",
        "project-learnings",
        "append",
        "--source",
        "/tmp/source",
        "--learnings",
        "/tmp/source/.skill-sys/project-learnings.json",
        "--id",
        "new-entry",
        "--summary",
        "Entry summary",
        "--source-entry",
        "cli",
        "--dry-run",
      ],
      {
        cwd: REPO_ROOT,
        run: (argv) => {
          captured.push(argv);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.some((arg: string) => arg.endsWith("project-learnings.ts"))).toBe(true);
    expect(captured[0]).toContain("append");
    expect(captured[0]).toContain("--source");
    expect(captured[0]).toContain("--learnings");
    expect(captured[0]).toContain("--id");
    expect(captured[0]).toContain("new-entry");
    expect(captured[0]).toContain("--summary");
    expect(captured[0]).toContain("Entry summary");
    expect(captured[0]).toContain("--source-entry");
    expect(captured[0]).toContain("cli");
    expect(captured[0]).toContain("--dry-run");
  });

  test("project-learnings rejects an unknown subcommand instead of silently validating", () => {
    const stderr: string[] = [];
    const code = main(
      ["bun", "skill-sys", "project-learnings", "bogus", "--source", "/tmp/source", "--learnings", "/tmp/learnings.json"],
      {
        cwd: REPO_ROOT,
        stderr: (text) => stderr.push(text),
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("Usage: skill-sys project-learnings");
    expect(stderr.join("\n")).toContain("validate|append|update");
  });
});
