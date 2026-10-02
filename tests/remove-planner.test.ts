import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { digestTreeStrict } from "../scripts/lib/files.ts";
import {
  normalizeRemoveArgs,
  planRemove,
  renderRemovePlan,
  type RemovePlan,
} from "../scripts/modules/skillpool/remove.ts";

const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempProject(prefix = "remove-planner-"): string {
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
    `${JSON.stringify({ installed }, null, 2)}\n`,
    "utf8",
  );
}

function managedEntry(project: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const target = String(overrides.target ?? ".agents/skills/alpha");
  writeSkill(project, target, "# Alpha\n");
  return {
    managedBy: "skill-sys",
    app: "codex",
    skill: "alpha",
    target,
    installMode: "projection",
    skillDigest: digestTreeStrict(path.join(project, target)),
    ...overrides,
  };
}

describe("remove planner", () => {
  test("normalizes args and fails closed for unsupported or broad invocations", () => {
    expect(() => normalizeRemoveArgs({})).toThrow("Usage: skill-sys remove");
    expect(() => normalizeRemoveArgs({ project: "." })).toThrow("plan-only");
    expect(() => normalizeRemoveArgs({ project: ".", plan: true })).toThrow("--all");
    expect(() => normalizeRemoveArgs({ project: ".", skill: "alpha", all: true, plan: true })).toThrow(
      "cannot be combined",
    );
    expect(
      normalizeRemoveArgs({ project: ".", skill: "alpha", apply: true }, { cwd: "/tmp" }),
    ).toMatchObject({
      project: "/tmp",
      skill: "alpha",
      plan: true,
      dryRun: false,
      apply: true,
      confirmAll: false,
      force: false,
    });

    expect(normalizeRemoveArgs({ project: ".", skill: "alpha", plan: true }, { cwd: "/tmp" })).toMatchObject({
      project: "/tmp",
      skill: "alpha",
      plan: true,
      dryRun: false,
    });
  });

  test("plans only skill-sys-managed entries, applies filters, and does not mutate files", () => {
    const project = tempProject();
    const alpha = managedEntry(project);
    const beta = managedEntry(project, { skill: "beta", target: ".agents/skills/beta", app: "codex" });
    const unmanaged = { ...managedEntry(project, { skill: "gamma", target: ".agents/skills/gamma" }), managedBy: "other" };
    writeState(project, [beta, unmanaged, { managedBy: "skill-sys" }, alpha]);
    const before = fs.readdirSync(path.join(project, ".agents", "skills")).sort();
    const stateBefore = fs.readFileSync(path.join(project, ".skills.state.json"), "utf8");
    const alphaBefore = fs.readFileSync(path.join(project, ".agents", "skills", "alpha", "SKILL.md"), "utf8");

    const plan = planRemove(
      normalizeRemoveArgs({ project, skill: "alpha", app: "codex", plan: true }, { cwd: project }),
    );

    expect(plan).toMatchObject({ schemaVersion: 1, command: "remove", scope: "skill", mode: "plan" });
    expect(plan.actions.map((action) => action.skill)).toEqual(["alpha"]);
    expect(plan.actions[0]?.target).toBe(".agents/skills/alpha");
    expect(plan.actions[0]?.exists).toBe(true);
    expect(plan.actions[0]?.digestMatches).toBe(true);
    expect(plan.ignored).toEqual({ unmanaged: 1, filtered: 1, malformed: 1 });
    expect(fs.readdirSync(path.join(project, ".agents", "skills")).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(project, ".skills.state.json"), "utf8")).toBe(stateBefore);
    expect(fs.readFileSync(path.join(project, ".agents", "skills", "alpha", "SKILL.md"), "utf8")).toBe(alphaBefore);
  });

  test("silently omits non-object JSON members without changing counters", () => {
    const project = tempProject();
    writeState(project, [
      null,
      managedEntry(project),
      ["ignored"],
      42,
      false,
      "ignored",
    ]);

    const plan = planRemove(
      normalizeRemoveArgs({ project, skill: "alpha", plan: true }, { cwd: project }),
    );

    expect(plan.actions.map((action) => action.skill)).toEqual(["alpha"]);
    expect(plan.ignored).toEqual({ unmanaged: 0, filtered: 0, malformed: 0 });
  });

  test("omitted JSON members do not move the first candidate safety failure", () => {
    const project = tempProject();
    writeState(project, [
      null,
      {
        managedBy: "skill-sys",
        app: "codex",
        skill: "first",
        target: path.join(project, ".agents/skills/first"),
      },
      ["ignored"],
      {
        managedBy: "skill-sys",
        app: "codex",
        skill: "second",
        target: "../outside",
      },
    ]);

    expect(() =>
      planRemove(normalizeRemoveArgs({ project, all: true, plan: true }, { cwd: project })),
    ).toThrow("absolute target");
  });

  test("does not inspect unsafe targets on unmanaged or filtered entries", () => {
    const project = tempProject();
    const outside = tempProject("remove-planner-filtered-outside-");
    fs.symlinkSync(outside, path.join(project, "filtered-link"));
    const candidate = managedEntry(project, {
      app: "codex",
      skill: "kept",
      target: ".agents/skills/kept",
    });
    writeState(project, [
      {
        managedBy: "other",
        app: "codex",
        skill: "unmanaged",
        target: path.join(project, ".agents", "skills", "unmanaged"),
      },
      {
        managedBy: "skill-sys",
        app: "codex",
        skill: "filtered-by-skill",
        target: "../outside",
      },
      {
        managedBy: "skill-sys",
        app: "other",
        skill: "kept",
        target: "filtered-link/skill",
      },
      candidate,
    ]);

    const plan = planRemove(
      normalizeRemoveArgs(
        { project, skill: "kept", app: "codex", plan: true },
        { cwd: project },
      ),
    );

    expect(plan.actions.map((action) => action.skill)).toEqual(["kept"]);
    expect(plan.ignored).toEqual({ unmanaged: 1, filtered: 2, malformed: 0 });
  });

  test("broad dry-run requires --all and returns sorted deterministic actions", () => {
    const project = tempProject();
    writeState(project, [
      managedEntry(project, { skill: "beta", target: ".agents/skills/beta" }),
      managedEntry(project, { skill: "alpha", target: ".agents/skills/alpha" }),
    ]);

    const plan = planRemove(normalizeRemoveArgs({ project, all: true, "dry-run": true }, { cwd: project }));

    expect(plan.scope).toBe("broad");
    expect(plan.mode).toBe("dry-run");
    expect(plan.actions.map((action) => action.skill)).toEqual(["alpha", "beta"]);
  });

  test("reports digest drift and missing targets without mutating", () => {
    const project = tempProject();
    const drift = managedEntry(project, { skill: "drift", target: ".agents/skills/drift" });
    drift.skillDigest = "sha256:not-the-current-digest";
    const missing = {
      managedBy: "skill-sys",
      app: "codex",
      skill: "missing",
      target: ".agents/skills/missing",
      installMode: "copy",
      skillDigest: "sha256:missing",
    };
    writeState(project, [drift, missing]);

    const plan = planRemove(normalizeRemoveArgs({ project, all: true, plan: true }, { cwd: project }));

    expect(plan.actions.map((action) => [action.skill, action.exists, action.digestMatches])).toEqual([
      ["drift", true, false],
      ["missing", false, false],
    ]);
  });

  test("fails closed for absolute, escaping, home, and symlink targets", () => {
    const project = tempProject();
    writeState(project, [managedEntry(project, { target: path.join(project, ".agents/skills/alpha") })]);
    expect(() => planRemove(normalizeRemoveArgs({ project, skill: "alpha", plan: true }, { cwd: project }))).toThrow(
      "absolute target",
    );

    const escapeProject = tempProject();
    writeState(escapeProject, [managedEntry(escapeProject, { target: "../outside" })]);
    expect(() =>
      planRemove(normalizeRemoveArgs({ project: escapeProject, skill: "alpha", plan: true }, { cwd: escapeProject })),
    ).toThrow("within the project");

    expect(() => planRemove(normalizeRemoveArgs({ project: os.homedir(), skill: "alpha", plan: true }))).toThrow(
      "HOME directory as --project",
    );

    const homeParentProject = tempProject("remove-planner-home-parent-");
    const fakeHome = path.join(homeParentProject, "home");
    fs.mkdirSync(fakeHome);
    writeState(homeParentProject, [
      {
        managedBy: "skill-sys",
        app: "codex",
        skill: "home",
        target: path.basename(fakeHome),
      },
    ]);
    const homeTargetProbe = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        [
          'import os from "node:os";',
          'import { normalizeRemoveArgs, planRemove } from "./scripts/modules/skillpool/remove.ts";',
          'const project = process.env.REMOVE_TEST_PROJECT ?? "";',
          'const expectedHome = process.env.REMOVE_TEST_HOME ?? "";',
          "if (os.homedir() !== expectedHome) {",
          '  console.error(`Unexpected subprocess HOME: ${os.homedir()}`);',
          "  process.exit(91);",
          "}",
          "try {",
          '  planRemove(normalizeRemoveArgs({ project, skill: "home", plan: true }, { cwd: project }));',
          '  console.error("Expected HOME target refusal");',
          "  process.exit(92);",
          "} catch (error) {",
          "  console.log(error instanceof Error ? error.message : String(error));",
          "}",
        ].join("\n"),
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: fakeHome,
        REMOVE_TEST_HOME: fakeHome,
        REMOVE_TEST_PROJECT: homeParentProject,
      },
    });
    expect(homeTargetProbe.exitCode).toBe(0);
    expect(homeTargetProbe.stderr.toString()).toBe("");
    expect(homeTargetProbe.stdout.toString()).toBe(
      "Refusing to plan removal of HOME directory: home\n",
    );

    const symlinkProject = tempProject();
    fs.mkdirSync(path.join(symlinkProject, ".agents", "skills"), { recursive: true });
    fs.symlinkSync(os.tmpdir(), path.join(symlinkProject, ".agents", "skills", "alpha"));
    writeState(symlinkProject, [
      {
        managedBy: "skill-sys",
        app: "codex",
        skill: "alpha",
        target: ".agents/skills/alpha",
      },
    ]);
    expect(() =>
      planRemove(normalizeRemoveArgs({ project: symlinkProject, skill: "alpha", plan: true }, { cwd: symlinkProject })),
    ).toThrow("symlink path component");

    const parentSymlinkProject = tempProject();
    const outside = tempProject("remove-planner-outside-");
    fs.mkdirSync(path.join(parentSymlinkProject, ".agents"), { recursive: true });
    fs.symlinkSync(outside, path.join(parentSymlinkProject, ".agents", "skills"));
    writeState(parentSymlinkProject, [
      {
        managedBy: "skill-sys",
        app: "codex",
        skill: "alpha",
        target: ".agents/skills/alpha",
      },
    ]);
    expect(() =>
      planRemove(
        normalizeRemoveArgs({ project: parentSymlinkProject, skill: "alpha", plan: true }, { cwd: parentSymlinkProject }),
      ),
    ).toThrow("symlink path component");
  });

  test("renders text/json and skill-sys main dispatches the in-process planner", () => {
    const project = tempProject();
    writeState(project, [managedEntry(project)]);
    const digest = digestTreeStrict(path.join(project, ".agents", "skills", "alpha"));
    const plan = planRemove(normalizeRemoveArgs({ project, skill: "alpha", plan: true }, { cwd: project }));
    const expectedPlan: RemovePlan = {
      schemaVersion: 1,
      command: "remove",
      project,
      scope: "skill",
      mode: "plan",
      applySupported: false,
      actions: [
        {
          app: "codex",
          skill: "alpha",
          target: ".agents/skills/alpha",
          installMode: "projection",
          exists: true,
          recordedDigest: digest,
          actualDigest: digest,
          digestMatches: true,
        },
      ],
      ignored: {
        unmanaged: 0,
        filtered: 0,
        malformed: 0,
      },
    };
    const expectedText = [
      "STATUS: PLAN",
      "Command: skill-sys remove (skill scope, plan mode)",
      `Project: ${project}`,
      "Apply supported: no",
      "Actions: 1",
      "- codex/alpha -> .agents/skills/alpha [present; digest matches]",
      "Ignored: 0 unmanaged, 0 filtered, 0 malformed",
      "",
    ].join("\n");
    const expectedJson = `${JSON.stringify(expectedPlan, null, 2)}\n`;
    expect(plan).toEqual(expectedPlan);
    expect(renderRemovePlan(plan, "text")).toBe(expectedText);
    expect(renderRemovePlan(plan, "json")).toBe(expectedJson);

    const stdout: string[] = [];
    const stderr: string[] = [];
    let subprocessRuns = 0;
    const code = skillSys.main(["bun", "skill-sys", "remove", "--project", project, "--skill", "alpha", "--plan", "--json"], {
      cwd: project,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
      run: () => {
        subprocessRuns += 1;
        return { code: 99, stdout: "", stderr: "" };
      },
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([expectedJson]);
    expect(stderr).toEqual([]);
    expect(subprocessRuns).toBe(0);
  });
});
