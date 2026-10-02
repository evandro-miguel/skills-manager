import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const surface = require("../scripts/modules/skillpool/public-surface.ts") as typeof import("../scripts/modules/skillpool/public-surface.ts");
const packlistCommand = require("../scripts/commands/packlist.ts") as typeof import("../scripts/commands/packlist.ts");
const npmPackAuditCommand = require("../scripts/commands/npm-pack-audit.ts") as typeof import("../scripts/commands/npm-pack-audit.ts");
const { captureCommand } = require("./helpers/skillpool-command.ts") as {
  captureCommand: (run: () => void) => { code: number; stdout: string; stderr: string };
};

function withTempDir<T>(prefix: string, callback: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeJson(filePath: string, data: unknown): void {
  writeText(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeNpmAuditFixture(root: string): string[] {
  writeText(path.join(root, "README.md"), "# Fixture\n");
  writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
  writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
    version: 1,
    requiredDirectories: ["src"],
    requiredFiles: ["README.md"],
  });
  return ["README.md", "src/index.ts"];
}

function npmPackJson(files: string[]): string {
  return JSON.stringify([{ files: files.map((file) => ({ path: file })) }]);
}

function withFakeNpm<T>(stdout: string, exitCode: number, callback: () => T): T {
  const binRoot = fs.mkdtempSync(path.join(os.tmpdir(), "npm-pack-audit-bin-"));
  const previousPath = process.env.PATH;
  const previousOutput = process.env.NPM_PACK_AUDIT_FIXTURE_OUTPUT;
  const previousExit = process.env.NPM_PACK_AUDIT_FIXTURE_EXIT;
  writeText(
    path.join(binRoot, "npm"),
    '#!/bin/sh\nprintf \'%s\\n\' "$NPM_PACK_AUDIT_FIXTURE_OUTPUT"\nexit "$NPM_PACK_AUDIT_FIXTURE_EXIT"\n',
  );
  fs.chmodSync(path.join(binRoot, "npm"), 0o755);
  process.env.PATH = [binRoot, previousPath].filter(Boolean).join(path.delimiter);
  process.env.NPM_PACK_AUDIT_FIXTURE_OUTPUT = stdout;
  process.env.NPM_PACK_AUDIT_FIXTURE_EXIT = String(exitCode);
  try {
    return callback();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousOutput === undefined) delete process.env.NPM_PACK_AUDIT_FIXTURE_OUTPUT;
    else process.env.NPM_PACK_AUDIT_FIXTURE_OUTPUT = previousOutput;
    if (previousExit === undefined) delete process.env.NPM_PACK_AUDIT_FIXTURE_EXIT;
    else process.env.NPM_PACK_AUDIT_FIXTURE_EXIT = previousExit;
    fs.rmSync(binRoot, { recursive: true, force: true });
  }
}

describe("public artifact surfaces", () => {
  test("engine-public ships only the selected public skill and keeps local agent payloads outside the artifact", () => {
    const root = path.resolve(__dirname, "..");
    const codexMapDirectory = [".codex", "-map"].join("");
    const engineSurface = surface.resolvePublicSurface(root, "engine-public");
    expect(engineSurface.forbiddenInSourcePaths).toEqual(
      expect.arrayContaining([
        "skills",
        "SKILLS.json",
        "SKILLS.md",
        "globals/core.json",
        "skill-lifecycle.json",
        "artifact-surface.json",
        ".agents",
        codexMapDirectory,
        ".arq",
        ".skill-sys-backup",
        ".skill-sys-tmp",
        ".skills.state.json",
        "releases",
        "tmp",
      ])
    );
    expect(engineSurface.allowedInForbiddenSourcePaths).toEqual([
      ".agents/lock.json",
      ".agents/manifest.json",
      ".agents/skills/**",
      "skills/skill-sys/**",
    ]);
    expect(engineSurface.forbiddenInArtifactPaths).toEqual(
      expect.arrayContaining([
        ".agents/lock.json",
        ".agents/manifest.json",
        "docs/map/writing-skills-scripts.md",
        "bun.lock",
      ]),
    );

    const packlist = surface.collectPublicSurfacePacklist(root, "engine-public");
    expect(packlist.files.some((file) => file.path === ".agents" || file.path.startsWith(".agents/"))).toBe(false);
    expect(packlist.files.some((file) => file.path === "skills/skill-sys/SKILL.md")).toBe(true);
  });

  test("collects deterministic packlist from surface entries only", () => {
    withTempDir("public-surface-", (root) => {
      writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
      writeText(path.join(root, "README.md"), "# Fixture\n");
      writeText(path.join(root, "private", "secret.txt"), "do not include\n");
      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["src"],
        requiredFiles: ["README.md"],
        forbiddenPaths: ["private"],
      });

      const result = surface.collectPublicSurfacePacklist(root, "engine-public");

      expect(result.surface).toBe("artifact-surfaces/engine-public.json");
      expect(result.files.map((file) => file.path)).toEqual(["README.md", "src/index.ts"]);
      expect(result.fileCount).toBe(2);
      expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  test("fails closed for artifact-forbidden paths, legacy aliases, and untracked critical surfaces", () => {
    withTempDir("public-surface-fail-closed-", (root) => {
      writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
      writeText(path.join(root, "skills", "private", "SKILL.md"), "# Private\n");
      writeText(path.join(root, "package.json"), "{\"name\":\"fixture\"}\n");
      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["src"],
        requiredFiles: ["package.json"],
        forbiddenInArtifactPaths: [],
        denyUntrackedCriticalSurfaces: true,
      });

      expect(() => surface.collectPublicSurfacePacklist(root, "engine-public")).toThrow(
        "Critical public surface directory is neither included nor forbidden: skills"
      );

      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["src", "skills"],
        requiredFiles: ["package.json"],
        forbiddenInArtifactPaths: ["skills"],
        denyUntrackedCriticalSurfaces: true,
      });
      expect(() => surface.collectPublicSurfacePacklist(root, "engine-public")).toThrow(
        "Surface includes forbidden path: skills/private/SKILL.md"
      );

      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["src", "skills"],
        requiredFiles: ["package.json"],
        forbiddenPaths: ["skills"],
        denyUntrackedCriticalSurfaces: true,
      });
      expect(() => surface.collectPublicSurfacePacklist(root, "engine-public")).toThrow(
        "Surface includes forbidden path: skills/private/SKILL.md"
      );
    });
  });

  test("source-forbidden paths count as tracked critical surfaces without entering the artifact denylist", () => {
    withTempDir("public-surface-source-forbidden-", (root) => {
      writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
      writeText(path.join(root, "package.json"), "{\"name\":\"fixture\"}\n");
      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["src"],
        requiredFiles: ["package.json"],
        forbiddenInSourcePaths: ["skills"],
        denyUntrackedCriticalSurfaces: true,
      });

      const result = surface.resolvePublicSurface(root, "engine-public");
      expect(result.forbiddenInArtifactPaths).toEqual([]);
      expect(result.forbiddenInSourcePaths).toEqual(["skills"]);
    });
  });

  test("forbidden source exceptions must stay below a forbidden root and use only trailing subtree wildcards", () => {
    withTempDir("public-surface-source-exceptions-", (root) => {
      writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
      const surfacePath = path.join(root, "artifact-surfaces", "engine-public.json");
      const baseSurface = {
        version: 1,
        requiredDirectories: ["src"],
        requiredFiles: [],
        forbiddenInSourcePaths: [".agents"],
      };

      writeJson(surfacePath, {
        ...baseSurface,
        allowedInForbiddenSourcePaths: ["src/index.ts"],
      });
      expect(() => surface.resolvePublicSurface(root, "engine-public")).toThrow(
        "must be below a forbiddenInSourcePaths root"
      );

      writeJson(surfacePath, {
        ...baseSurface,
        allowedInForbiddenSourcePaths: [".agents/*/SKILL.md"],
      });
      expect(() => surface.resolvePublicSurface(root, "engine-public")).toThrow(
        "may use a wildcard only as a trailing /** subtree"
      );
    });
  });

  test("packlist skips install runtime artifacts even when the public surface includes the source root", () => {
    withTempDir("public-surface-runtime-artifacts-", (root) => {
      writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
      writeText(path.join(root, ".skill-sys-tmp", "scratch.txt"), "temporary install scratch\n");
      writeText(path.join(root, ".skill-sys-backup", "install-1", "backup.txt"), "rollback backup\n");
      writeJson(path.join(root, ".skills.state.json"), {
        schemaVersion: 2,
        installed: [{ name: "dev-only", installMode: "symlink" }],
      });
      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["."],
        requiredFiles: [],
      });

      const result = surface.collectPublicSurfacePacklist(root, "engine-public");
      const paths = result.files.map((file) => file.path);

      expect(paths).toContain("src/index.ts");
      expect(paths).not.toContain(".skill-sys-tmp/scratch.txt");
      expect(paths).not.toContain(".skill-sys-backup/install-1/backup.txt");
      expect(paths).not.toContain(".skills.state.json");
    });
  });

  test("packlist command emits relative paths and a digest", () => {
    withTempDir("packlist-cli-", (root) => {
      writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["src"],
        requiredFiles: [],
      });

      const result = captureCommand(() =>
        packlistCommand.main(["bun", "packlist.ts", "--source", root, "--surface", "engine-public"])
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Surface: artifact-surfaces/engine-public.json");
      expect(result.stdout).toContain("Digest: ");
      expect(result.stdout).toContain("src/index.ts");
      expect(result.stdout).not.toContain(root);
    });
  });

  test("npm-pack audit accepts npm array and named-object JSON shapes", () => {
    const files = [{ path: "README.md" }, { path: "scripts/index.ts" }];

    expect(npmPackAuditCommand.parseNpmPackFiles(JSON.stringify([{ files }]))).toEqual([
      "README.md",
      "scripts/index.ts",
    ]);
    expect(npmPackAuditCommand.parseNpmPackFiles(JSON.stringify({ "universall-skill-sys": { files } }))).toEqual([
      "README.md",
      "scripts/index.ts",
    ]);
  });

  test("npm-pack audit reports missing and extra files without invoking a registry", () => {
    withTempDir("npm-pack-audit-fixture-", (root) => {
      const expectedFiles = writeNpmAuditFixture(root);

      const pass = withFakeNpm(npmPackJson(expectedFiles), 0, () =>
        npmPackAuditCommand.runNpmPackAudit({ source: root, surface: "engine-public", json: false }),
      );
      expect(pass).toMatchObject({
        status: "PASS",
        packlistFileCount: expectedFiles.length,
        npmFileCount: expectedFiles.length,
        missingFromNpm: [],
        extraInNpm: [],
      });

      const missing = withFakeNpm(npmPackJson(["README.md"]), 0, () =>
        npmPackAuditCommand.runNpmPackAudit({ source: root, surface: "engine-public", json: false }),
      );
      expect(missing.status).toBe("BLOCKING");
      expect(missing.missingFromNpm).toEqual(["src/index.ts"]);
      expect(missing.extraInNpm).toEqual([]);

      const extra = withFakeNpm(npmPackJson([...expectedFiles, "private.txt"]), 0, () =>
        npmPackAuditCommand.runNpmPackAudit({ source: root, surface: "engine-public", json: false }),
      );
      expect(extra.status).toBe("BLOCKING");
      expect(extra.missingFromNpm).toEqual([]);
      expect(extra.extraInNpm).toEqual(["private.txt"]);
    });
  });

  test("npm-pack audit fails closed for command errors and malformed JSON", () => {
    withTempDir("npm-pack-audit-errors-", (root) => {
      writeNpmAuditFixture(root);

      expect(() =>
        withFakeNpm("registry unavailable", 17, () =>
          npmPackAuditCommand.runNpmPackAudit({ source: root, surface: "engine-public", json: false }),
        ),
      ).toThrow("Command failed (17): npm pack --dry-run --json --ignore-scripts");

      expect(() =>
        withFakeNpm("{not-json", 0, () =>
          npmPackAuditCommand.runNpmPackAudit({ source: root, surface: "engine-public", json: false }),
        ),
      ).toThrow("npm pack --dry-run --json did not emit valid JSON");
    });
  });

  test("npm-pack audit main emits JSON/text and preserves blocking exit semantics", () => {
    withTempDir("npm-pack-audit-main-", (root) => {
      const expectedFiles = writeNpmAuditFixture(root);
      const passJson = withFakeNpm(npmPackJson(expectedFiles), 0, () =>
        captureCommand(() =>
          npmPackAuditCommand.main(["bun", "npm-pack-audit.ts", "--source", root, "--surface", "engine-public", "--json"]),
        ),
      );
      expect(passJson.code).toBe(0);
      expect(JSON.parse(passJson.stdout)).toMatchObject({ status: "PASS", missingFromNpm: [], extraInNpm: [] });

      const blockingText = withFakeNpm(npmPackJson([...expectedFiles, "private.txt"]), 0, () =>
        captureCommand(() =>
          npmPackAuditCommand.main(["bun", "npm-pack-audit.ts", "--source", root, "--surface", "engine-public"]),
        ),
      );
      expect(blockingText.code).toBe(1);
      expect(blockingText.stdout).toContain("STATUS: BLOCKING");
      expect(blockingText.stdout).toContain("EXTRA IN NPM:");
      expect(blockingText.stdout).toContain("- private.txt");
      expect(blockingText.stderr).toBe("");

      const commandError = withFakeNpm("pack failed", 9, () =>
        captureCommand(() =>
          npmPackAuditCommand.main(["bun", "npm-pack-audit.ts", "--source", root, "--surface", "engine-public"]),
        ),
      );
      expect(commandError.code).toBe(1);
      // Captured child output ("pack failed") must not reach the error text.
      expect(commandError.stderr).toContain("Command failed (9): npm pack --dry-run --json --ignore-scripts");
      expect(commandError.stderr).not.toContain("pack failed");
    });
  });
});
