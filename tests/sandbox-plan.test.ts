import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classifySensitivePath,
  normalizeSandboxArgs,
  planSandbox,
  renderSandboxVerdict,
} from "../scripts/modules/skillpool/sandbox-plan.ts";

const verifySandbox = require("../scripts/commands/verify-sandbox.ts") as typeof import("../scripts/commands/verify-sandbox.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix = "sandbox-plan-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function outputToString(output: Uint8Array | null | undefined): string {
  return output ? Buffer.from(output).toString("utf8") : "";
}

describe("sandbox plan-only verifier", () => {
  test("normalizes plan-only args and fails closed for execution modes", () => {
    const source = tempDir();
    expect(() => normalizeSandboxArgs({ source }, { cwd: source })).toThrow("plan-only");
    expect(() => normalizeSandboxArgs({ source, plan: true, apply: true }, { cwd: source })).toThrow(
      "UNSUPPORTED_SANDBOX_EXECUTE",
    );
    expect(() => normalizeSandboxArgs({ source, "dry-run": true, run: true }, { cwd: source })).toThrow(
      "UNSUPPORTED_SANDBOX_EXECUTE",
    );
    expect(() => normalizeSandboxArgs({ source, plan: true, execute: true }, { cwd: source })).toThrow(
      "UNSUPPORTED_SANDBOX_EXECUTE",
    );

    const input = normalizeSandboxArgs({ source, plan: true }, { cwd: source });
    expect(input.mode).toBe("plan");
    expect(input.source).toBe(source);
  });

  test("builds a deterministic docker command vector with required controls but never executes it", () => {
    const source = tempDir();
    fs.mkdirSync(path.join(source, "skills"));
    const input = normalizeSandboxArgs({ source, plan: true }, { cwd: source });
    const verdict = planSandbox(input);

    expect(verdict.status).toBe("PLAN");
    expect(verdict.applySupported).toBe(false);
    expect(verdict.runtime.command).toBe("docker");
    expect(verdict.runtime.args).toContain("--network");
    expect(verdict.runtime.args).toContain("none");
    expect(verdict.runtime.args).toContain("--read-only");
    expect(verdict.runtime.args).toContain("--cap-drop");
    expect(verdict.runtime.args).toContain("ALL");
    expect(verdict.runtime.args).toContain("no-new-privileges");
    expect(verdict.runtime.args.some((arg) => arg.includes(`source=${source}`) && arg.includes("readonly"))).toBe(true);
    expect(verdict.controls).toEqual({
      networkNone: true,
      readonlyFilesystem: true,
      noNewPrivileges: true,
      capDropAll: true,
      mountsExplicit: true,
      denySensitivePaths: true,
    });
    expect(verdict.violations).toEqual([]);
    expect(renderSandboxVerdict(verdict, "json")).toContain('"applySupported": false');
  });

  test("rejects sensitive source and mount paths, unsafe targets, and symlink components", () => {
    const root = tempDir();
    const source = path.join(root, "source");
    const mount = path.join(root, "mount");
    fs.mkdirSync(source);
    fs.mkdirSync(mount);
    fs.mkdirSync(path.join(root, ".ssh"));

    expect(classifySensitivePath(path.join(root, ".ssh"), os.homedir())).toContain("SENSITIVE_PATH_SEGMENT");
    expect(() => normalizeSandboxArgs({ source: path.join(root, ".ssh"), plan: true }, { cwd: root })).toThrow(
      "sensitive source",
    );
    expect(() => normalizeSandboxArgs({ source, plan: true, mount: `${path.join(root, ".aws")}:/data` }, { cwd: root })).toThrow(
      "mount source not found",
    );
    fs.mkdirSync(path.join(root, ".aws"));
    expect(() => normalizeSandboxArgs({ source, plan: true, mount: `${path.join(root, ".aws")}:/data` }, { cwd: root })).toThrow(
      "sensitive source path",
    );
    expect(() => normalizeSandboxArgs({ source, plan: true, mount: `${mount}:/root/secrets` }, { cwd: root })).toThrow(
      "sensitive container target",
    );
    expect(() => normalizeSandboxArgs({ source, plan: true, mount: `${mount}:relative` }, { cwd: root })).toThrow(
      "RELATIVE_TARGET",
    );
    for (const target of ["/workspace-evil", "/skill-evil", "/data-evil"]) {
      expect(() => normalizeSandboxArgs({ source, plan: true, mount: `${mount}:${target}` }, { cwd: root })).toThrow(
        "outside the allowed container roots",
      );
    }
    expect(normalizeSandboxArgs({ source, plan: true, mount: `${mount}:/workspace/cache` }, { cwd: root }).mounts).toEqual([
      { source: path.resolve(mount), target: "/workspace/cache" },
    ]);

    const outside = tempDir("sandbox-outside-");
    fs.symlinkSync(outside, path.join(root, "link"));
    expect(() => normalizeSandboxArgs({ source: path.join(root, "link"), plan: true }, { cwd: root })).toThrow(
      "symlink path component",
    );
  });

  test("rejects Docker --mount option injection characters while allowing nested targets", () => {
    const root = tempDir();
    const source = path.join(root, "source,readonly=false");
    const mount = path.join(root, "mount,readonly=false");
    fs.mkdirSync(source);
    fs.mkdirSync(mount);

    expect(() => normalizeSandboxArgs({ source, plan: true }, { cwd: root })).toThrow("comma");
    expect(() => normalizeSandboxArgs({ source: root, plan: true, mount: `${mount}:/workspace/cache` }, { cwd: root })).toThrow(
      "comma",
    );
    expect(() => normalizeSandboxArgs({ source: root, plan: true, mount: `${root}:/workspace/cache,readonly=false` }, { cwd: root })).toThrow(
      "comma",
    );
    expect(() => normalizeSandboxArgs({ source: root, plan: true, mount: `${root}:/workspace/cache\nprivileged` }, { cwd: root })).toThrow(
      "control character",
    );
    expect(normalizeSandboxArgs({ source: root, plan: true, mount: `${root}:/workspace/cache/nested` }, { cwd: root }).mounts).toEqual([
      { source: path.resolve(root), target: "/workspace/cache/nested" },
    ]);
  });

  test("standalone CLI emits JSON and returns non-zero only for blocked plans", () => {
    const source = tempDir();
    const result = Bun.spawnSync(["bun", "scripts/commands/verify-sandbox.ts", "--source", source, "--plan", "--json"], {
      cwd: path.resolve(__dirname, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(outputToString(result.stderr)).toBe("");
    const parsed = JSON.parse(outputToString(result.stdout));
    expect(parsed.status).toBe("PLAN");
    expect(parsed.controls.networkNone).toBe(true);

    const blocked = Bun.spawnSync(["bun", "scripts/commands/verify-sandbox.ts", "--source", source, "--apply"], {
      cwd: path.resolve(__dirname, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(blocked.exitCode).toBe(1);
    expect(outputToString(blocked.stderr)).toContain("UNSUPPORTED_SANDBOX_EXECUTE");
  });

  test("skill-sys dispatch validates and executes the in-process planner boundary", () => {
    const source = tempDir();
    const plan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "verify-sandbox", "--source", source, "--dry-run", "--json"]));
    expect(plan.argv).toContain("verify-sandbox");
    expect(plan.argv).toContain("--dry-run");
    expect(plan.argv).toContain("--json");
    expect(() => skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "verify-sandbox", "--source", source]))).toThrow(
      "plan-only",
    );
    expect(() => skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "verify-sandbox", "--source", source, "--run"]))).toThrow(
      "UNSUPPORTED_SANDBOX_EXECUTE",
    );

    const output: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (message?: unknown) => output.push(String(message ?? ""));
      const code = skillSys.main(["bun", "skill-sys", "verify-sandbox", "--source", source, "--plan", "--json"]);
      expect(code).toBe(0);
      expect(JSON.parse(output.join("\n")).status).toBe("PLAN");
    } finally {
      console.log = originalLog;
    }
  });
});
