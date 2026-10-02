import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareTargets,
  compareWithOptionalRepair,
  main,
  parseArgs,
  resolveSyncScript,
} from "../scripts/commands/doctor-all.ts";
import {
  checkClaudePermissions,
  checkCodexDuplicates,
  checkOpenCodePermissions,
  providerDoctor,
} from "../scripts/commands/provider-doctor.ts";
import { normalizeSkillNameStrict } from "../scripts/modules/skillpool/entry.ts";

const tempDirs: string[] = [];

function tempRoot(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, body = "# Skill\n"): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
}

function captureConsole(run: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("doctor-all diagnostics command", () => {
  test("parseArgs resolves paths, supports all skill target flags, and rejects malformed args", () => {
    const args = parseArgs([
      "bun",
      "doctor-all.ts",
      "--source",
      "fixtures/source",
      "--project",
      "fixtures/project",
      "--opencode-skills",
      "homes/opencode",
      "--codex-skills",
      "homes/codex",
      "--claude-skills",
      "homes/claude",
      "--qwen-skills",
      "homes/qwen",
      "--gemini-skills",
      "homes/gemini",
      "--repair",
      "--json",
    ]);

    expect(args.source).toBe(path.resolve(process.cwd(), "fixtures/source"));
    expect(args.project).toBe(path.resolve(process.cwd(), "fixtures/project"));
    expect(args.opencodeSkills).toBe(path.resolve(process.cwd(), "homes/opencode"));
    expect(args.codexSkills).toBe(path.resolve(process.cwd(), "homes/codex"));
    expect(args.claudeSkills).toBe(path.resolve(process.cwd(), "homes/claude"));
    expect(args.qwenSkills).toBe(path.resolve(process.cwd(), "homes/qwen"));
    expect(args.geminiSkills).toBe(path.resolve(process.cwd(), "homes/gemini"));
    expect(args.repair).toBe(true);
    expect(args.json).toBe(true);
    expect(parseArgs(["bun", "doctor-all.ts", "-h"]).help).toBe(true);
    expect(() => parseArgs(["bun", "doctor-all.ts", "--source"])).toThrow("Missing value");
    expect(() => parseArgs(["bun", "doctor-all.ts", "--unknown", "x"])).toThrow("Unknown option");
    expect(() => parseArgs(["bun", "doctor-all.ts", "stray"])).toThrow("Unknown argument");
  });

  test("compareTargets reports missing, drifted, extra, and matching skills without touching home directories", () => {
    const root = tempRoot("doctor-compare");
    const source = path.join(root, "source-skills");
    const target = path.join(root, "target-skills");
    writeSkill(source, "alpha", "# Alpha\n");
    writeSkill(source, "beta", "# Beta\n");
    writeSkill(source, "drift", "# Source drift\n");
    writeSkill(target, "alpha", "# Alpha\n");
    writeSkill(target, "extra", "# Extra\n");
    writeSkill(target, "drift", "# Target drift\n");

    const missingTarget = compareTargets(source, path.join(root, "missing"), "Codex", ["alpha"]);
    expect(missingTarget.errors[0]).toContain("target not found");

    const result = compareTargets(source, target, "Codex", ["alpha", "beta", "drift"]);
    expect(result.findings).toContain("[ERROR Codex] missing skill: beta");
    expect(result.findings).toContain("[ERROR Codex] drift detected: drift");
    expect(result.findings).toContain("[WARN Codex] extra skill in target: extra");
    expect(result.errors).toHaveLength(2);
    expect(result.warns).toHaveLength(1);
  });

  test("compareWithOptionalRepair throws without repair and rechecks after repair with injected sync behavior", () => {
    const root = tempRoot("doctor-repair");
    const source = path.join(root, "source-skills");
    const target = path.join(root, "target-skills");
    writeSkill(source, "alpha", "# Alpha\n");
    fs.mkdirSync(target, { recursive: true });

    expect(() => compareWithOptionalRepair(source, target, "Codex", root, false, ["alpha"])).toThrow("drift check failed");
    expect(() => compareWithOptionalRepair(source, target, "Codex", root, true, ["alpha"])).toThrow("sync-skills.ts");

    writeSkill(target, "alpha", "# Alpha\n");
    expect(() => compareWithOptionalRepair(source, target, "Codex", root, false, ["alpha"])).not.toThrow();
    expect(resolveSyncScript(root)).toBe(path.join(root, "scripts", "commands", "sync-skills.ts"));
  });

  test("main runs core checks, optional project doctor, drift comparisons, repair pull, and JSON output through injected dependencies", () => {
    const root = tempRoot("doctor-main");
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "skills"));
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    const commands: string[][] = [];
    const compares: string[] = [];

    const output = captureConsole(() =>
      main(
        [
          "bun",
          "doctor-all.ts",
          "--source",
          root,
          "--project",
          project,
          "--opencode-skills",
          path.join(root, "opencode"),
          "--codex-skills",
          path.join(root, "codex"),
          "--claude-skills",
          path.join(root, "claude"),
          "--qwen-skills",
          path.join(root, "qwen"),
          "--gemini-skills",
          path.join(root, "gemini"),
          "--repair",
          "--json",
        ],
        {
          run: (command) => commands.push(command),
          isGitRepo: () => true,
          compareGlobalCoreApp: (_sourceRoot, _sourceSkillsDir, _targetSkillsDir, label, appName, repair) => {
            compares.push(`${label}:${appName}:${repair}`);
          },
        }
      )
    );

    expect(commands[0]).toEqual(["git", "-C", root, "pull", "--ff-only"]);
    expect(commands.some((command) => command.includes("validate") && command.includes("--source"))).toBe(true);
    expect(commands.some((command) => command.includes("doctor") && command.includes("--strict-hash"))).toBe(true);
    expect(compares).toEqual([
      "OpenCode:opencode:true",
      "Codex:codex:true",
      "Claude Code:claude-code:true",
      "Qwen:qwen:true",
      "Gemini CLI:gemini-cli:true",
    ]);
    const json = JSON.parse(output.slice(output.indexOf("{")));
    expect(json.status).toBe("PASS");
    expect(json.repair).toBe(true);
    expect(json.checks.map((check: { name: string }) => check.name)).toEqual([
      "repair-pull",
      "contract",
      "source-validate",
      "adapter-smoke",
      "project-lockfile-doctor",
    ]);
  });

  test("main prints human status and skips repair pull when source is not a git repo", () => {
    const root = tempRoot("doctor-human");
    fs.mkdirSync(path.join(root, "skills"));
    const commands: string[][] = [];

    const output = captureConsole(() =>
      main(["bun", "doctor-all.ts", "--source", root, "--repair"], {
        run: (command) => commands.push(command),
        isGitRepo: () => false,
        compareGlobalCoreApp: () => undefined,
      })
    );

    expect(commands[0]?.[0]).toBe("bun");
    expect(commands.some((command) => command[0] === "git")).toBe(false);
    expect(output).toContain("-> Contract");
    expect(output).toContain("STATUS: PASS");
  });
});

describe("provider-doctor strict skill-name identity", () => {
  function fakeLister(namesByScope: Record<string, string[]>) {
    return (dirPath: string) => namesByScope[dirPath] ?? [];
  }

  test("strict normalizer keeps case-preserving identity, so doctor must not fold case collisions", () => {
    expect(normalizeSkillNameStrict("Foo")).toBe("Foo");
    expect(normalizeSkillNameStrict("Foo")).not.toBe(normalizeSkillNameStrict("foo"));
  });

  test("codex duplicates group by strict-normalized identity and keep case-colliding names distinct", () => {
    const project = tempRoot("pd-case");
    const ownScope = path.join(project, ".agents", "skills");
    const parentScope = path.join(path.dirname(project), ".agents", "skills");

    const findings = checkCodexDuplicates(project, {
      listSkillNames: fakeLister({
        [ownScope]: ["dup", "Foo"],
        [parentScope]: ["dup", "foo"],
      }),
    });

    const duplicates = findings.filter((finding) => finding.code === "CODEX_DUPLICATE_SKILL");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.message).toBe("Duplicate Codex skill name: dup");
    expect(duplicates[0]!.paths).toEqual([ownScope, parentScope]);
    expect(findings.some((finding) => finding.message.includes("Foo") || finding.message.includes("'foo'"))).toBe(
      false
    );
  });

  test("literal C: drive-prefix directories become blocking findings instead of silent skips", () => {
    const project = tempRoot("pd-drive");
    const scope = path.join(project, ".agents", "skills");
    fs.mkdirSync(path.join(scope, "C:"), { recursive: true });

    const findings = checkCodexDuplicates(project);
    const invalid = findings.filter((finding) => finding.code === "CODEX_INVALID_SKILL_NAME");

    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.level).toBe("ERROR");
    expect(invalid[0]!.message).toBe("Invalid skill name 'C:': Windows drive prefixes are not allowed");
    expect(invalid[0]!.paths).toEqual([path.join(scope, "C:")]);
    expect(
      findings.some((finding) => finding.code === "CODEX_DUPLICATE_SKILL" && finding.message.endsWith(": C:"))
    ).toBe(false);
  });

  test("separator and traversal names produce deterministic blocking findings without escaping", () => {
    // Owned sandbox: the project lives inside a private temp parent created by
    // tempRoot(), never directly under the shared os.tmpdir(), so unrelated
    // parallel tests that create tmpdir siblings cannot affect this test.
    const parent = tempRoot("pd-traversal");
    const project = path.join(parent, "project");
    const ownScope = path.join(project, ".agents", "skills");
    const parentScope = path.join(path.dirname(project), ".agents", "skills");
    fs.mkdirSync(ownScope, { recursive: true });
    fs.mkdirSync(parentScope, { recursive: true });

    // Dedicated unique sentinels owned by this test. A naive resolution of the
    // injected "../escape" name lands next to these files, so byte-for-byte
    // sentinel equality plus exact owned-listing equality proves the doctor
    // cannot create, read into, or write through traversal/separator names.
    const outsideProjectSentinel = path.join(parent, "escape-target.outside-project.sentinel");
    const insideProjectSentinel = path.join(project, "escape-target.inside-project.sentinel");
    fs.writeFileSync(outsideProjectSentinel, "outside-project-intact");
    fs.writeFileSync(insideProjectSentinel, "inside-project-intact");
    const parentListingBefore = fs.readdirSync(parent).sort();

    const findings = checkCodexDuplicates(project, {
      listSkillNames: fakeLister({
        [ownScope]: ["../escape", "a/b", "a\\b"],
        [parentScope]: ["safe"],
      }),
    });

    const invalid = findings.filter((finding) => finding.code === "CODEX_INVALID_SKILL_NAME");
    expect(invalid.map((finding) => [finding.level, finding.message])).toEqual([
      ["ERROR", "Invalid skill name '../escape': path separators are not allowed"],
      ["ERROR", "Invalid skill name 'a/b': path separators are not allowed"],
      ["ERROR", "Invalid skill name 'a\\b': path separators are not allowed"],
    ]);
    expect(findings.filter((finding) => finding.code !== "CODEX_INVALID_SKILL_NAME")).toEqual([]);

    // Escape proof: sentinels are untouched, the owned listings contain exactly
    // what this test created, and no path reachable by naively joining the
    // hostile names onto either scope exists after the run.
    expect(fs.readFileSync(outsideProjectSentinel, "utf8")).toBe("outside-project-intact");
    expect(fs.readFileSync(insideProjectSentinel, "utf8")).toBe("inside-project-intact");
    expect(fs.readdirSync(parent).sort()).toEqual(parentListingBefore);
    for (const escapeCandidate of [
      path.join(parent, "escape"),
      path.join(project, ".agents", "escape"),
      path.join(ownScope, "a"),
      path.join(ownScope, "a\\b"),
      path.join(parentScope, "a"),
      path.join(parentScope, "a\\b"),
    ]) {
      expect(fs.existsSync(escapeCandidate)).toBe(false);
    }
  });

  test("claude and opencode checks surface malformed source skill names without crashing", () => {
    const root = tempRoot("pd-source");
    fs.mkdirSync(path.join(root, "adapters"), { recursive: true });
    fs.mkdirSync(path.join(root, "profiles"), { recursive: true });
    writeSkill(root, "skills/C:");
    writeSkill(root, "skills/plain", "# Plain\n");
    const project = tempRoot("pd-source-project");

    const claudeFindings = checkClaudePermissions(root, project);
    expect(claudeFindings.map((finding) => [finding.level, finding.code])).toEqual([
      ["ERROR", "SOURCE_INVALID_SKILL_NAME"],
    ]);
    expect(claudeFindings[0]!.message).toBe("Invalid skill name 'C:': Windows drive prefixes are not allowed");
    expect(claudeFindings[0]!.paths).toEqual([path.join(root, "skills", "C:")]);

    const opencodeFindings = checkOpenCodePermissions(root);
    expect(opencodeFindings).toEqual(claudeFindings);
  });

  test("providerDoctor completes deterministically with malformed scope names present", () => {
    const project = tempRoot("pd-e2e");
    const ownScope = path.join(project, ".agents", "skills");

    const result = providerDoctor(
      {
        source: project,
        project,
        provider: "codex",
        duplicates: true,
        permissions: false,
        json: false,
        help: false,
      },
      {
        listSkillNames: fakeLister({
          [ownScope]: ["C:", ".."],
        }),
      }
    );

    expect(result.provider).toBe("codex");
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "Invalid skill name 'C:': Windows drive prefixes are not allowed",
      "Invalid skill name '..': path separators are not allowed",
    ]);
    expect(JSON.parse(JSON.stringify(result)).findings).toHaveLength(2);
  });
});
