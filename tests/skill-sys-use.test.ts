import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildUseOutput,
  handleUseCommand,
  type UseCommandOptions,
  type UseOutput,
  resolveSkillFromSource,
} from "../scripts/commands/skill-sys.ts";
import { runCommand } from "../scripts/lib/command.ts";
import { fetchExactRef } from "../scripts/modules/skillpool/cache.ts";
import { resolveSkillSysCommandName } from "../scripts/modules/skill-sys/command-registry.ts";

const REPO_ROOT = path.resolve(__dirname, "..");
const MINIMAL_SKILLPACK = path.join(REPO_ROOT, "examples", "minimal-skillpack");

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `skill-sys-use-test-${prefix}-`));
}

function populateCheckout(dest: string, sourceRoot: string = MINIMAL_SKILLPACK): void {
  for (const entry of fs.readdirSync(sourceRoot)) {
    fs.cpSync(path.join(sourceRoot, entry), path.join(dest, entry), {
      recursive: true,
    });
  }
}

function makeRemoteSkillpack(prefix: string, skillName: string, skillMd: string): string {
  const root = makeTmpDir(prefix);
  fs.mkdirSync(path.join(root, "skills", skillName), { recursive: true });
  fs.mkdirSync(path.join(root, "profiles"), { recursive: true });
  fs.writeFileSync(path.join(root, "skillpack.json"), JSON.stringify({ name: "remote-pack", version: "0.1.0" }));
  fs.writeFileSync(path.join(root, "skills", skillName, "SKILL.md"), skillMd);
  return root;
}

const FAKE_COMMIT = "a".repeat(40);

function remoteUseOptions(
  cwd: string,
  fetchDestinations: string[],
): UseCommandOptions {
  return {
    cwd,
    resolveRemoteRef: (_repo, ref) => ({
      ref,
      commit: FAKE_COMMIT,
      sourceRef: ref,
    }),
    fetchExactRef: (_repo, _ref, dest) => {
      populateCheckout(dest);
      fetchDestinations.push(dest);
    },
  };
}

describe("skill-sys use", () => {
  it("registers 'use' as a public command in the command registry", () => {
    expect(resolveSkillSysCommandName("use")).toBe("use");
  });

  it("resolves a skill from a local skillpack source", () => {
    const result = resolveSkillFromSource(MINIMAL_SKILLPACK, "example-skill", {
      cwd: REPO_ROOT,
    });
    expect(result.skillName).toBe("example-skill");
    expect(result.sourceDisplay).toBe(path.join("examples", "minimal-skillpack"));
    expect(result.skillDir).toBe(
      path.join(MINIMAL_SKILLPACK, "skills", "example-skill")
    );
    expect(result.skillMdPath).toBe(
      path.join(MINIMAL_SKILLPACK, "skills", "example-skill", "SKILL.md")
    );
    expect(fs.existsSync(result.skillMdPath)).toBe(true);
  });

  it("auto-detects the skill name only for single-skill sources", () => {
    const result = resolveSkillFromSource(MINIMAL_SKILLPACK, "", {
      cwd: REPO_ROOT,
    });
    expect(result.skillName).toBe("example-skill");
  });

  it("fails when source does not exist", () => {
    expect(() =>
      resolveSkillFromSource("/nonexistent/path", "example-skill", {
        cwd: REPO_ROOT,
      })
    ).toThrow(/not found|does not exist|unable to resolve/i);
  });

  it("fails when skill name is missing in a multi-skill source", () => {
    const tmpDir = makeTmpDir("multi");
    try {
      // Create a multi-skill source so auto-detect fails
      for (const name of ["skill-a", "skill-b"]) {
        const skillDir = path.join(tmpDir, "skills", name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `---\nname: ${name}\n---\n\nContent.\n`
        );
      }
      fs.writeFileSync(
        path.join(tmpDir, "skillpack.json"),
        JSON.stringify({ name: "multi-pack", version: "0.1.0" })
      );
      fs.mkdirSync(path.join(tmpDir, "profiles"), { recursive: true });

      expect(() =>
        resolveSkillFromSource(tmpDir, "", { cwd: REPO_ROOT })
      ).toThrow(/--skill is required/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails when the requested skill is not found in the source", () => {
    expect(() =>
      resolveSkillFromSource(MINIMAL_SKILLPACK, "nonexistent-skill", {
        cwd: REPO_ROOT,
      })
    ).toThrow(/not found/i);
  });

  it("builds markdown output by default", () => {
    const resolved = resolveSkillFromSource(MINIMAL_SKILLPACK, "example-skill", {
      cwd: REPO_ROOT,
    });
    const output = buildUseOutput(resolved, "markdown", undefined);
    expect(output).toContain("# skill-sys use: example-skill");
    expect(output).toContain("source:");
    expect(output).toContain("skill: example-skill");
    expect(output).toContain("Example Skill");
  });

  it("builds JSON output with stable fields", () => {
    const resolved = resolveSkillFromSource(MINIMAL_SKILLPACK, "example-skill", {
      cwd: REPO_ROOT,
    });
    const output = buildUseOutput(resolved, "json", undefined);
    const parsed = JSON.parse(output) as UseOutput;
    expect(parsed.source).toBe(path.join("examples", "minimal-skillpack"));
    expect(path.isAbsolute(parsed.source)).toBe(false);
    expect(parsed.skill).toBe("example-skill");
    expect(parsed.format).toBe("json");
    expect(parsed.sensitiveScan.status).toBe("clean");
    expect(parsed.content).toContain("Example Skill");
  });

  it("includes agent label in JSON output when provided", () => {
    const resolved = resolveSkillFromSource(MINIMAL_SKILLPACK, "example-skill", {
      cwd: REPO_ROOT,
    });
    const output = buildUseOutput(resolved, "json", "codex");
    const parsed = JSON.parse(output) as UseOutput;
    expect(parsed.agent).toBe("codex");
  });

  it("blocks output when sensitive content is found", () => {
    const tmpDir = makeTmpDir("secret");
    const syntheticSecret = ["ghp_", "A".repeat(36)].join("");
    try {
      const skillDir = path.join(tmpDir, "skills", "leaky-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        `---\nname: leaky-skill\n---\n\nMy key is ${syntheticSecret}\n`
      );
      fs.writeFileSync(
        path.join(tmpDir, "skillpack.json"),
        JSON.stringify({ name: "leaky-pack", version: "0.1.0" })
      );
      fs.mkdirSync(path.join(tmpDir, "profiles"), { recursive: true });

      expect(() =>
        handleUseCommand(tmpDir, "leaky-skill", "markdown", undefined, {
          cwd: REPO_ROOT,
        })
      ).toThrow(/sensitive/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not write to project roots, global roots, or HOME", () => {
    const tmpDir = makeTmpDir("readonly");
    try {
      const skillDir = path.join(tmpDir, "skills", "safe-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: safe-skill\n---\n\nSafe content.\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "skillpack.json"),
        JSON.stringify({ name: "safe-pack", version: "0.1.0" })
      );
      fs.mkdirSync(path.join(tmpDir, "profiles"), { recursive: true });

      const beforeDirs = new Set<string>([
        path.join(tmpDir, ".agents", "skills"),
        path.join(tmpDir, ".skills.state.json"),
        path.join(os.homedir(), ".skill-sys"),
      ]);

      handleUseCommand(tmpDir, "safe-skill", "markdown", undefined, {
        cwd: REPO_ROOT,
      });

      for (const dir of beforeDirs) {
        expect(fs.existsSync(dir)).toBe(false);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("classifies owner/repo shorthand as remote and fetches into an isolated temp dir", () => {
    const cwd = makeTmpDir("remote-shorthand");
    const fetchDestinations: string[] = [];
    try {
      const result = handleUseCommand("org/repo", "example-skill", "markdown", undefined, {
        ...remoteUseOptions(cwd, fetchDestinations),
        resolveRemoteRef: (repo, ref) => {
          expect(repo).toBe("https://github.com/org/repo.git");
          expect(ref).toBe("HEAD");
          return { ref, commit: FAKE_COMMIT, sourceRef: ref };
        },
        fetchExactRef: (repo, ref, dest) => {
          expect(repo).toBe("https://github.com/org/repo.git");
          expect(ref).toBe("HEAD");
          populateCheckout(dest);
          fetchDestinations.push(dest);
        },
      });

      expect(result).toContain("example-skill");
      expect(result).toContain("Example Skill");
      expect(fetchDestinations).toHaveLength(1);
      expect(fs.existsSync(fetchDestinations[0] as string)).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("passes an explicit ref through remote use", () => {
    const cwd = makeTmpDir("remote-ref");
    const fetchDestinations: string[] = [];
    try {
      const result = handleUseCommand("org/repo#v1.2.3", "example-skill", "markdown", undefined, {
        ...remoteUseOptions(cwd, fetchDestinations),
        resolveRemoteRef: (repo, ref) => {
          expect(repo).toBe("https://github.com/org/repo.git");
          expect(ref).toBe("v1.2.3");
          return { ref, commit: FAKE_COMMIT, sourceRef: ref };
        },
        fetchExactRef: (repo, ref, dest) => {
          expect(repo).toBe("https://github.com/org/repo.git");
          expect(ref).toBe("v1.2.3");
          populateCheckout(dest);
          fetchDestinations.push(dest);
        },
      });

      expect(result).toContain("example-skill");
      expect(fetchDestinations).toHaveLength(1);
      expect(fs.existsSync(fetchDestinations[0] as string)).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses skillPath from a GitHub tree URL", () => {
    const cwd = makeTmpDir("remote-tree");
    const fetchDestinations: string[] = [];
    try {
      const result = handleUseCommand(
        "https://github.com/org/repo/tree/main/skills/example-skill",
        "",
        "markdown",
        undefined,
        {
          ...remoteUseOptions(cwd, fetchDestinations),
          resolveRemoteRef: (repo, ref) => {
            expect(repo).toBe("https://github.com/org/repo.git");
            expect(ref).toBe("main");
            return { ref, commit: FAKE_COMMIT, sourceRef: ref };
          },
          fetchExactRef: (repo, ref, dest) => {
            expect(repo).toBe("https://github.com/org/repo.git");
            expect(ref).toBe("main");
            populateCheckout(dest);
            fetchDestinations.push(dest);
          },
        }
      );

      expect(result).toContain("example-skill");
      expect(result).toContain("Example Skill");
      expect(fetchDestinations).toHaveLength(1);
      expect(fs.existsSync(fetchDestinations[0] as string)).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("removes the temp checkout after a remote sensitive scan failure", () => {
    const cwd = makeTmpDir("remote-secret-cwd");
    const syntheticSecret = ["ghp_", "A".repeat(36)].join("");
    const leakyRoot = makeRemoteSkillpack(
      "remote-secret-pack",
      "leaky-skill",
      `---\nname: leaky-skill\n---\n\nMy key is ${syntheticSecret}\n`
    );
    let fetchDestination: string | undefined;
    try {
      expect(() =>
        handleUseCommand("org/repo", "leaky-skill", "markdown", undefined, {
          ...remoteUseOptions(cwd, []),
          fetchExactRef: (_repo, _ref, dest) => {
            populateCheckout(dest, leakyRoot);
            fetchDestination = dest;
          },
        })
      ).toThrow(/sensitive/i);
      expect(fetchDestination).toBeDefined();
      expect(fs.existsSync(fetchDestination as string)).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(leakyRoot, { recursive: true, force: true });
    }
  });

  it("does not write to the project dir when using a remote source", () => {
    const cwd = makeTmpDir("remote-no-write");
    const before = new Set(fs.readdirSync(cwd));
    try {
      handleUseCommand("org/repo", "example-skill", "markdown", undefined, {
        ...remoteUseOptions(cwd, []),
      });
      const after = new Set(fs.readdirSync(cwd));
      expect([...after].sort()).toEqual([...before].sort());
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fetches an exact tag from a local git repo into a detached checkout", () => {
    const repoDir = makeTmpDir("real-fetch-repo");
    const dest = makeTmpDir("real-fetch-dest");
    try {
      fs.mkdirSync(path.join(repoDir, "skills", "example-skill"), { recursive: true });
      fs.writeFileSync(path.join(repoDir, "skills", "example-skill", "SKILL.md"), "# Fetched Skill\n");

      runCommand(["git", "-C", repoDir, "init"], { stdout: "pipe", stderr: "pipe" });
      runCommand(["git", "-C", repoDir, "config", "user.email", "test@example.com"], { stdout: "pipe", stderr: "pipe" });
      runCommand(["git", "-C", repoDir, "config", "user.name", "Test"], { stdout: "pipe", stderr: "pipe" });
      runCommand(["git", "-C", repoDir, "add", "."], { stdout: "pipe", stderr: "pipe" });
      runCommand(["git", "-C", repoDir, "commit", "-m", "init"], { stdout: "pipe", stderr: "pipe" });
      runCommand(["git", "-C", repoDir, "tag", "v1"], { stdout: "pipe", stderr: "pipe" });

      fetchExactRef(repoDir, "v1", dest);

      expect(fs.existsSync(path.join(dest, "skills", "example-skill", "SKILL.md"))).toBe(true);
      const head = runCommand(["git", "-C", dest, "rev-parse", "--abbrev-ref", "HEAD"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(head.stdout).toBe("HEAD");
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it("handleUseCommand returns markdown string for valid input", () => {
    const result = handleUseCommand(
      MINIMAL_SKILLPACK,
      "example-skill",
      "markdown",
      undefined,
      { cwd: REPO_ROOT }
    );
    expect(result).toContain("example-skill");
    expect(result).toContain("Example Skill");
  });
});

describe("skill-sys use local source containment", () => {
  function makeLocalPack(prefix: string): string {
    const root = makeTmpDir(prefix);
    fs.mkdirSync(path.join(root, "skills", "target"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "skills", "target", "SKILL.md"),
      "---\nname: target\n---\n\nSafe content.\n"
    );
    fs.writeFileSync(
      path.join(root, "skillpack.json"),
      JSON.stringify({ name: "pack", version: "0.1.0" })
    );
    fs.mkdirSync(path.join(root, "profiles"), { recursive: true });
    return root;
  }

  it("rejects traversal and separator names before joining paths", () => {
    const root = makeLocalPack("containment-names");
    try {
      expect(() =>
        resolveSkillFromSource(root, "..", { cwd: REPO_ROOT })
      ).toThrow(/Invalid skill name/);
      expect(() =>
        resolveSkillFromSource(root, ".", { cwd: REPO_ROOT })
      ).toThrow(/Invalid skill name/);
      expect(() =>
        resolveSkillFromSource(root, "target/../target", { cwd: REPO_ROOT })
      ).toThrow(/Invalid skill name/);
      expect(() =>
        resolveSkillFromSource(root, "..\\escape", { cwd: REPO_ROOT })
      ).toThrow(/Invalid skill name/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses symlinked skill directories even when they stay inside the skills root", () => {
    const root = makeLocalPack("containment-dirlink");
    try {
      fs.mkdirSync(path.join(root, "skills", "inner"));
      fs.writeFileSync(
        path.join(root, "skills", "inner", "SKILL.md"),
        "---\nname: inner\n---\n\nInner.\n"
      );
      fs.rmSync(path.join(root, "skills", "target"), { recursive: true });
      fs.symlinkSync(
        path.join(root, "skills", "inner"),
        path.join(root, "skills", "target"),
        "dir"
      );
      expect(() =>
        resolveSkillFromSource(root, "target", { cwd: REPO_ROOT })
      ).toThrow(/[Ss]ymlink/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses symlinked skill directories escaping the skills root", () => {
    const root = makeLocalPack("containment-escape");
    const outside = makeTmpDir("containment-outside");
    try {
      fs.mkdirSync(path.join(outside, "escaped"));
      fs.writeFileSync(
        path.join(outside, "escaped", "SKILL.md"),
        "---\nname: escaped\n---\n\nEscaped.\n"
      );
      fs.rmSync(path.join(root, "skills", "target"), { recursive: true });
      fs.symlinkSync(
        path.join(outside, "escaped"),
        path.join(root, "skills", "target"),
        "dir"
      );
      expect(() =>
        resolveSkillFromSource(root, "target", { cwd: REPO_ROOT })
      ).toThrow(/[Ss]ymlink|outside source skills root/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses symlinked SKILL.md pointing outside the source", () => {
    const root = makeLocalPack("containment-filelink");
    const outside = makeTmpDir("containment-file-outside");
    try {
      fs.writeFileSync(
        path.join(outside, "SKILL.md"),
        "---\nname: target\n---\n\nOutside.\n"
      );
      fs.rmSync(path.join(root, "skills", "target", "SKILL.md"));
      fs.symlinkSync(
        path.join(outside, "SKILL.md"),
        path.join(root, "skills", "target", "SKILL.md")
      );
      expect(() =>
        resolveSkillFromSource(root, "target", { cwd: REPO_ROOT })
      ).toThrow(/[Ss]ymlink/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("still resolves plain real directories inside the skills root", () => {
    const root = makeLocalPack("containment-ok");
    try {
      const result = resolveSkillFromSource(root, "target", { cwd: REPO_ROOT });
      expect(result.skillName).toBe("target");
      expect(fs.realpathSync.native(result.skillDir)).toBe(
        fs.realpathSync.native(path.join(root, "skills", "target"))
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
