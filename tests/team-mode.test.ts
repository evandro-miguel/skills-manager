import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyTeamModeLocal,
  normalizeTeamModeArgs,
  renderTeamModeResult,
  runTeamModeValidation,
} from "../scripts/modules/skillpool/team-mode.ts";

const teamModeCommand = require("../scripts/commands/team-mode.ts") as typeof import("../scripts/commands/team-mode.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const repoRoot = path.resolve(__dirname, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-mode-"));
  tempRoots.push(root);
  return root;
}

function writeConfig(root: string, value: unknown, filename = "skill-sys.team.json"): string {
  const configPath = path.join(root, filename);
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
  return configPath;
}

function baseConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "default-team",
    lockfile: ".skills.lock.json",
    installMode: "projection",
    sharedConfig: true,
    ...extra,
  };
}

function writeLockfile(root: string, content = '{"skills":[]}\n'): string {
  const lockfile = path.join(root, ".skills.lock.json");
  fs.writeFileSync(lockfile, content, "utf8");
  return lockfile;
}

describe("team mode — normalizeTeamModeArgs", () => {
  test("rejects missing source or config", () => {
    expect(() => normalizeTeamModeArgs({ config: "/tmp/config.json" })).toThrow("Missing --source");
    expect(() => normalizeTeamModeArgs({ source: "/tmp/source" })).toThrow("Missing --config");
  });

  test("rejects symlinked config files and accepts strict", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig());
    const link = path.join(root, "link.json");
    fs.symlinkSync(config, link);

    expect(() => normalizeTeamModeArgs({ source: root, config: link })).toThrow("must not be a symlink");
    expect(normalizeTeamModeArgs({ source: root, config, strict: true }).strict).toBe(true);
  });
});

describe("team mode — CLI wiring", () => {
  test("parseArgs normalizes config and skill-sys dispatch routes to command", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig());

    const args = teamModeCommand.parseArgs(["bun", "team-mode", "--source", root, "--config", config, "--json", "--strict"]);
    expect(args.source).toBe(root);
    expect(args.config).toBe(config);
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);

    const plan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "team-mode", "--source", root, "--config", config, "--json", "--strict"]));
    expect(plan.argv).toEqual(["bun", path.join(repoRoot, "scripts", "commands", "team-mode.ts"), "--source", root, "--config", config, "--json", "--strict"]);
  });
});

describe("team mode — runTeamModeValidation", () => {
  test("passes for config that stores only team policy and lockfile reference", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({ adapters: ["codex", "opencode"], allowedProfiles: ["core"] }));

    const result = runTeamModeValidation(normalizeTeamModeArgs({ source: root, config }));

    expect(result.status).toBe("PASS");
    expect(result.teamName).toBe("default-team");
    expect(result.policy.installMode).toBe("projection");
    expect(result.policy.lockfile).toBe(".skills.lock.json");
    expect(result.findings).toEqual([]);
  });

  test("blocks embedded catalogs, symlink install mode, unsafe lockfile, and unknown adapters", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({
      lockfile: "../outside.lock.json",
      installMode: "symlink",
      adapters: ["codex", "unknown-agent"],
      skills: [{ name: "embedded" }],
    }));

    const result = runTeamModeValidation(normalizeTeamModeArgs({ source: root, config }));

    expect(result.status).toBe("BLOCKED");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "TEAM_MODE_ADAPTER_UNSUPPORTED",
      "TEAM_MODE_CATALOG_EMBEDDED",
      "TEAM_MODE_LOCKFILE_UNSAFE",
      "TEAM_MODE_SYMLINK_FORBIDDEN",
    ]);
  });

  test("warns when sharedConfig is not explicit and strict blocks warnings", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({ sharedConfig: undefined }));

    const loose = runTeamModeValidation(normalizeTeamModeArgs({ source: root, config }));
    const strict = runTeamModeValidation(normalizeTeamModeArgs({ source: root, config, strict: true }));

    expect(loose.status).toBe("CONCERNS");
    expect(strict.status).toBe("BLOCKED");
    expect(loose.findings[0]?.code).toBe("TEAM_MODE_SHARED_CONFIG_UNDECLARED");
  });

  test("characterizes invalid sharedConfig as a warning that strict blocks", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({ sharedConfig: "yes" }));

    const loose = runTeamModeValidation(normalizeTeamModeArgs({ source: root, config }));
    const strict = runTeamModeValidation(normalizeTeamModeArgs({ source: root, config, strict: true }));

    expect(loose.status).toBe("CONCERNS");
    expect(strict.status).toBe("BLOCKED");
    expect(loose.policy.sharedConfig).toBeNull();
    expect(loose.findings).toEqual([
      {
        level: "WARN",
        code: "TEAM_MODE_SHARED_CONFIG_UNDECLARED",
        path: "skill-sys.team.json",
        message: "sharedConfig should be explicit true or false",
      },
    ]);
  });

  test("renders stable JSON and text output", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig());
    const result = runTeamModeValidation(normalizeTeamModeArgs({ source: root, config }));

    expect(JSON.parse(renderTeamModeResult(result, "json"))).toEqual(result);
    expect(renderTeamModeResult(result, "text")).toContain("STATUS: PASS");
  });

  test("characterizes runtime acceptance that is broader than the input schema", () => {
    const root = makeTempRoot();
    const schema = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "schema", "team-mode.schema.json"), "utf8"),
    ) as {
      additionalProperties: boolean;
      required: string[];
      properties: {
        adapters: { uniqueItems: boolean };
        allowedProfiles: { uniqueItems: boolean };
      };
    };
    const config = writeConfig(root, {
      schemaVersion: 1,
      name: "default-team",
      lockfile: ".skills.lock.json",
      sharedConfig: true,
      unknownRuntimeField: "ignored-by-observed-validator",
    });

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("installMode");
    expect(schema.properties.adapters.uniqueItems).toBe(true);
    expect(schema.properties.allowedProfiles.uniqueItems).toBe(true);

    const result = runTeamModeValidation(normalizeTeamModeArgs({ source: root, config }));
    expect(result.status).toBe("PASS");
    expect(result.policy.installMode).toBe("projection");
    expect(result.findings).toEqual([]);
  });

  test("characterizes duplicate adapter and profile values retained by runtime", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({
      adapters: ["opencode", "codex", "codex"],
      allowedProfiles: ["core", "core"],
    }));

    const result = runTeamModeValidation(normalizeTeamModeArgs({ source: root, config }));

    expect(result.status).toBe("PASS");
    expect(result.policy.adapters).toEqual(["codex", "codex", "opencode"]);
    expect(result.policy.allowedProfiles).toEqual(["core", "core"]);
    expect(result.findings).toEqual([]);
  });
});

describe("F-04.03 team mode — explicit local apply", () => {
  test("plans by default and applies a deterministic local projection only with opt-in", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig());
    writeLockfile(root);
    const input = normalizeTeamModeArgs({ source: root, config });
    const output = path.join(root, ".skill-sys", "team", "default-team", "team-lock.json");

    const planned = applyTeamModeLocal(input);
    expect(planned.status).toBe("PLANNED");
    expect(planned.applied).toBeFalse();
    expect(fs.existsSync(output)).toBeFalse();

    const applied = applyTeamModeLocal(input, { apply: true });
    expect(applied.status).toBe("APPLIED");
    expect(applied.applied).toBeTrue();
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({
      schemaVersion: 1,
      team: "default-team",
      installMode: "projection",
      lockfile: { path: ".skills.lock.json", sha256: applied.inputDigest, bytes: 14 },
    });
    expect(applyTeamModeLocal(input, { apply: true }).status).toBe("UNCHANGED");
  });

  test("copies only bounded local lockfile bytes in copy mode", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({ installMode: "copy" }));
    const lockfile = writeLockfile(root, '{"skills":["alpha"]}\n');
    const result = applyTeamModeLocal(normalizeTeamModeArgs({ source: root, config }), { apply: true });
    const output = path.join(root, ".skill-sys", "team", "default-team", "team-lock.json");

    expect(result.status).toBe("APPLIED");
    expect(fs.readFileSync(output, "utf8")).toBe(fs.readFileSync(lockfile, "utf8"));
  });

  test("fails closed for invalid, unsafe, sensitive, and conflicting input without mutation", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig({ adapters: ["unsupported"] }));
    writeLockfile(root);
    const input = normalizeTeamModeArgs({ source: root, config });
    expect(applyTeamModeLocal(input, { apply: true }).status).toBe("BLOCKED");
    expect(fs.existsSync(path.join(root, ".skill-sys"))).toBeFalse();

    const validConfig = writeConfig(root, baseConfig(), "valid.json");
    fs.writeFileSync(path.join(root, ".skills.lock.json"), "token=abcdefghijk\n", "utf8");
    const sensitive = applyTeamModeLocal(normalizeTeamModeArgs({ source: root, config: validConfig }), { apply: true });
    expect(sensitive.findings[0]?.code).toBe("TEAM_MODE_LOCKFILE_SENSITIVE_TEXT");
    expect(fs.existsSync(path.join(root, ".skill-sys"))).toBeFalse();

    const lockfilePath = path.join(root, ".skills.lock.json");
    const outside = path.join(makeTempRoot(), "team-mode-outside-lock.json");
    fs.writeFileSync(outside, "{}\n", "utf8");
    fs.unlinkSync(lockfilePath);
    fs.symlinkSync(outside, lockfilePath);
    const unsafe = applyTeamModeLocal(normalizeTeamModeArgs({ source: root, config: validConfig }), { apply: true });
    expect(unsafe.findings[0]?.code).toBe("TEAM_MODE_LOCKFILE_PATH_UNSAFE");
    fs.unlinkSync(lockfilePath);
    fs.writeFileSync(lockfilePath, "x".repeat(64 * 1024 + 1), "utf8");
    const oversized = applyTeamModeLocal(normalizeTeamModeArgs({ source: root, config: validConfig }), { apply: true });
    expect(oversized.findings[0]?.code).toBe("TEAM_MODE_LOCKFILE_BOUNDS_INVALID");

    writeLockfile(root);
    const output = path.join(root, ".skill-sys", "team", "default-team", "team-lock.json");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "user-owned", "utf8");
    const conflicting = applyTeamModeLocal(normalizeTeamModeArgs({ source: root, config: validConfig }), { apply: true });
    expect(conflicting.findings[0]?.code).toBe("TEAM_MODE_OUTPUT_CONFLICT");
    expect(fs.readFileSync(output, "utf8")).toBe("user-owned");
  });

  test("injected failure removes only artifacts created by the invocation", () => {
    const root = makeTempRoot();
    const config = writeConfig(root, baseConfig());
    writeLockfile(root);
    const result = applyTeamModeLocal(normalizeTeamModeArgs({ source: root, config }), { apply: true, failAfterWrite: true });

    expect(result.status).toBe("BLOCKED");
    expect(result.findings[0]?.code).toBe("TEAM_MODE_LOCAL_APPLY_FAILED");
    expect(fs.existsSync(path.join(root, ".skill-sys"))).toBeFalse();
    expect(fs.existsSync(path.join(root, ".skills.lock.json"))).toBeTrue();
  });
});
