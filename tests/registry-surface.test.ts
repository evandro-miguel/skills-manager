import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "..");
const registryGate = require("../scripts/commands/validate-registry-surface.ts") as typeof import("../scripts/commands/validate-registry-surface.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");
const registry = require("../scripts/modules/skill-sys/command-registry.ts") as typeof import("../scripts/modules/skill-sys/command-registry.ts");
const tempRoots: string[] = [];

type ChannelFixture = {
  name: string;
  releaseTag: string;
  commit: string;
  ref?: string;
  artifactDigests?: readonly [string, string, string];
};

function readJson(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-surface-"));
  tempRoots.push(root);
  return root;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeJson(root: string, relativePath: string, value: unknown): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(filePath, text);
  return text;
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (result.status !== 0) {
    throw new Error(`Synthetic Git fixture command failed: ${args.join(" ")}: ${result.stderr}`);
  }
  return String(result.stdout).trim();
}

function createSyntheticGitRepository(root: string): {
  commit(contents: string): string;
  tag(name: string): void;
} {
  runGit(root, ["init", "--quiet"]);
  return {
    commit(contents: string): string {
      fs.writeFileSync(path.join(root, "source.txt"), contents);
      runGit(root, ["add", "source.txt"]);
      runGit(root, [
        "-c", "user.name=registry surface fixture",
        "-c", "user.email=registry-surface@example.invalid",
        "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=/dev/null",
        "commit", "--quiet", "-m", "synthetic fixture",
      ]);
      return runGit(root, ["rev-parse", "HEAD"]);
    },
    tag(name: string): void {
      runGit(root, ["tag", name]);
    },
  };
}

function writeRegistryFixture(root: string, channels: ChannelFixture[] = []): void {
  const pointers: Record<string, { path: string; ref: string; sha256: string }> = {};
  for (const fixture of channels) {
    const relativePath = `registry/channels/${fixture.name}.json`;
    const [sourceSha256, releaseManifestSha256, skillBomSha256] = fixture.artifactDigests ?? [
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
    ];
    const document = {
      $schema: "../../schema/release-channel.schema.json",
      version: 1,
      channel: fixture.name,
      releaseTag: fixture.releaseTag,
      commit: fixture.commit,
      sourceSha256,
      releaseManifestSha256,
      skillBomSha256,
      policy: {
        requireSignedTag: true,
        requireReleaseManifest: true,
        requireSkillBom: true,
        requireSourceChecksum: true,
        allowFloatingRef: false,
      },
    };
    const text = writeJson(root, relativePath, document);
    pointers[fixture.name] = {
      path: relativePath,
      ref: fixture.ref ?? fixture.releaseTag,
      sha256: sha256(text),
    };
  }

  const indexText = writeJson(root, "registry/index.json", {
    $schema: "../schema/registry-index.schema.json",
    version: 1,
    channels: pointers,
    taps: [],
  });
  const advisoryPath = "registry/advisories/security-status.json";
  const advisoryFile = path.join(root, advisoryPath);
  fs.mkdirSync(path.dirname(advisoryFile), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, advisoryPath), advisoryFile);
  writeJson(root, "registry/metadata.json", {
    $schema: "../schema/registry-metadata.schema.json",
    version: 1,
    name: "universall-skill-sys",
    baseUrl: "./registry/",
    index: { path: "registry/index.json", sha256: sha256(indexText) },
    advisories: { path: advisoryPath, sha256: sha256(fs.readFileSync(advisoryFile)) },
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("registry/taps/advisories publish surface", () => {
  test("public registry metadata, index, channel, and advisory schemas exist", () => {
    for (const schemaPath of [
      "schema/registry-metadata.schema.json",
      "schema/registry-index.schema.json",
      "schema/release-channel.schema.json",
      "schema/security-advisory-status.schema.json",
    ]) {
      const schema = readJson(schemaPath);
      expect(schema.$id).toBe(`https://skill-sys.dev/schema/${path.basename(schemaPath)}`);
      expect(schema.type).toBe("object");
    }
  });

  test("registry fixtures validate and forbid floating refs without digest-backed pins", () => {
    const result = registryGate.validateRegistrySurface(repoRoot);
    expect(result.status).toBe("PASS");
    expect(result.files).toEqual([
      "registry/advisories/security-status.json",
      "registry/index.json",
      "registry/metadata.json",
    ]);
    expect(readJson("registry/index.json").channels).toEqual({});
    expect(result.channelDigests).toEqual({});
  });

  test("an empty alpha registry passes without any Git repository or advertised channel", () => {
    const root = makeTempRoot();
    writeRegistryFixture(root);

    const result = registryGate.validateRegistrySurface(root);

    expect(result.status).toBe("PASS");
    expect(result.files).toEqual([
      "registry/advisories/security-status.json",
      "registry/index.json",
      "registry/metadata.json",
    ]);
    expect(result.channelDigests).toEqual({});
  });

  test("an advertised channel passes when the exact source Git root has a matching local tag", () => {
    const root = makeTempRoot();
    const git = createSyntheticGitRepository(root);
    const commit = git.commit("channel source");
    git.tag("v1.2.3");
    writeRegistryFixture(root, [{ name: "next", releaseTag: "v1.2.3", commit }]);

    const result = registryGate.validateRegistrySurface(root);

    expect(result.status).toBe("PASS");
    expect(result.files).toContain("registry/channels/next.json");
    expect(result.channelDigests.next).toMatch(/^[a-f0-9]{64}$/);
  });

  test("accepts tag, immutable commit, and omitted index refs with the same verified channel binding", () => {
    const root = makeTempRoot();
    const git = createSyntheticGitRepository(root);
    const commit = git.commit("channel ref variants");
    git.tag("v1.2.3");
    for (const ref of ["v1.2.3", commit, undefined]) {
      writeRegistryFixture(root, [{ name: "next", releaseTag: "v1.2.3", commit, ...(ref === undefined ? {} : { ref }) }]);
      if (ref === undefined) {
        const index = JSON.parse(fs.readFileSync(path.join(root, "registry/index.json"), "utf8"));
        delete index.channels.next.ref;
        const indexText = writeJson(root, "registry/index.json", index);
        const metadata = JSON.parse(fs.readFileSync(path.join(root, "registry/metadata.json"), "utf8"));
        metadata.index.sha256 = sha256(indexText);
        writeJson(root, "registry/metadata.json", metadata);
      }
      expect(registryGate.validateRegistrySurface(root).status).toBe("PASS");
    }
  });

  test("blocks an index commit ref that differs from its verified channel commit", () => {
    const root = makeTempRoot();
    const git = createSyntheticGitRepository(root);
    const commit = git.commit("tagged channel commit");
    git.tag("v1.2.3");
    const otherCommit = git.commit("unrelated index ref");
    writeRegistryFixture(root, [{ name: "next", releaseTag: "v1.2.3", commit, ref: otherCommit }]);
    expect(() => registryGate.validateRegistrySurface(root)).toThrow(/ref must match its releaseTag or commit/);
  });

  test("blocks an advertised channel whose release tag is missing", () => {
    const root = makeTempRoot();
    const git = createSyntheticGitRepository(root);
    const commit = git.commit("channel source without tag");
    writeRegistryFixture(root, [{ name: "next", releaseTag: "v1.2.3", commit }]);

    expect(() => registryGate.validateRegistrySurface(root)).toThrow(/tag v1\.2\.3 is unavailable/);
  });

  test("blocks a channel when its local release tag resolves to another commit", () => {
    const root = makeTempRoot();
    const git = createSyntheticGitRepository(root);
    git.commit("tagged release source");
    git.tag("v1.2.3");
    const declaredCommit = git.commit("different declared source");
    writeRegistryFixture(root, [{ name: "next", releaseTag: "v1.2.3", commit: declaredCommit }]);

    expect(() => registryGate.validateRegistrySurface(root)).toThrow(/tag does not resolve to its declared commit/);
  });

  test("blocks an advertised channel when source is not a Git repository root", () => {
    const gitRoot = makeTempRoot();
    const git = createSyntheticGitRepository(gitRoot);
    const commit = git.commit("separate source repository");
    git.tag("v1.2.3");
    const registryRoot = makeTempRoot();
    writeRegistryFixture(registryRoot, [{ name: "next", releaseTag: "v1.2.3", commit }]);

    expect(() => registryGate.validateRegistrySurface(registryRoot)).toThrow(/Git root is unavailable|exact Git repository root/);
  });

  test("blocks an advertised channel when --source is nested under another Git root", () => {
    const root = makeTempRoot();
    const git = createSyntheticGitRepository(root);
    const commit = git.commit("source repository root");
    git.tag("v1.2.3");
    const nestedRoot = path.join(root, "registry-source");
    fs.mkdirSync(nestedRoot);
    writeRegistryFixture(nestedRoot, [{ name: "next", releaseTag: "v1.2.3", commit }]);

    expect(() => registryGate.validateRegistrySurface(nestedRoot)).toThrow(/exact Git repository root/);
  });

  test("validator rejects channel artifact digests that are not pairwise distinct", () => {
    const root = makeTempRoot();
    const git = createSyntheticGitRepository(root);
    const commit = git.commit("synthetic channel source");
    git.tag("v1.2.3");
    writeRegistryFixture(root, [{
      name: "next",
      releaseTag: "v1.2.3",
      commit,
      artifactDigests: ["1".repeat(64), "2".repeat(64), "2".repeat(64)],
    }]);

    expect(() => registryGate.validateRegistrySurface(root)).toThrow(
      /artifact digests must be pairwise distinct/,
    );
  });

  test("validator rejects mutable floating refs unless every entry is digest-backed", () => {
    const floatingIndex = {
      $schema: "../schema/registry-index.schema.json",
      version: 1,
      channels: {
        next: {
          path: "registry/channels/next.json",
          ref: "main",
        },
      },
      taps: [],
    };

    expect(() => registryGate.validateRegistryIndex(floatingIndex)).toThrow(
      "registry index channel next uses mutable ref 'main' without sha256"
    );
  });

  test("publish surface intentionally includes registry advisory artifacts and command gate", () => {
    const surface = readJson("artifact-surfaces/engine-public.json");
    const packageJson = readJson("package.json");

    expect(surface.requiredDirectories).toContain("registry");
    expect(packageJson.files).toContain("registry/");
    expect(packageJson.scripts["registry:check"]).toBe(
      "bun scripts/commands/skill-sys.ts validate-registry-surface --source ."
    );
    expect(packageJson.scripts["validate:publish"]).toContain("bun run registry:check");
    expect(packageJson.scripts.test).toContain("tests/registry-surface.test.ts");
    expect(registry.resolveSkillSysCommandName("validate-registry-surface")).toBe("validate-registry-surface");
  });

  test("every registered skill-sys command and alias reaches a dispatch case", () => {
    const earlyReturnCommands = new Set(["context", "help"]);
    for (const command of registry.SKILL_SYS_COMMANDS) {
      if (earlyReturnCommands.has(command.name)) {
        continue;
      }
      for (const commandName of [command.name, ...command.aliases]) {
        const parsed = skillSys.parseCli(["bun", "skill-sys", commandName]);
        expect(parsed.command).toBe(command.name);

        const stderr: string[] = [];
        skillSys.main(["bun", "skill-sys", commandName], {
          cwd: repoRoot,
          stdout: () => undefined,
          stderr: (message: string) => stderr.push(message),
          run: () => ({ code: 0, stdout: "", stderr: "" }),
        });

        expect(stderr.join("\n")).not.toContain("Unknown command");
      }
    }
  });

  test("every public skill-sys command exposes no-setup help through the real CLI", () => {
    for (const command of registry.publicSkillSysCommands()) {
      if (command.name === "help") continue;
      const result = spawnSync(process.execPath, ["scripts/commands/skill-sys.ts", command.name, "--help"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 10000,
      });
      const output = `${result.stdout}\n${result.stderr}`.trim();
      expect({ command: command.name, status: result.status, output: output.slice(0, 160) }).toEqual({
        command: command.name,
        status: 0,
        output: expect.any(String),
      });
      expect(output.length).toBeGreaterThan(0);
      expect(output).not.toContain("ERROR:");
    }
  }, 30_000);
});
