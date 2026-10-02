import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scanner = require("../scripts/modules/skillpool/sensitive-scan.ts") as typeof import("../scripts/modules/skillpool/sensitive-scan.ts");
const scanCommand = require("../scripts/commands/scan-sensitive.ts") as typeof import("../scripts/commands/scan-sensitive.ts");
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

function writeSourceLayout(root: string): void {
  writeText(path.join(root, "skills", "alpha", "SKILL.md"), "# Alpha\n");
  writeText(path.join(root, "adapters", "codex.json"), '{ "name": "codex", "targetPath": ".agents/skills" }\n');
  writeText(path.join(root, "profiles", "core.json"), '{ "name": "core", "skills": ["alpha"] }\n');
}

describe("sensitive scanner", () => {
  test("detects denylisted filenames and secret-shaped content without printing secrets or absolute paths", () => {
    withTempDir("sensitive-scan-", (root) => {
      const secret = ["ghp_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
      writeSourceLayout(root);
      writeText(path.join(root, "skills", "alpha", ".env"), "OPENAI_API_KEY=redacted\n");
      writeText(path.join(root, "skills", "alpha", "notes.md"), `token=${secret}\n`);

      const findings = scanner.scanSensitiveFiles({
        rootDir: path.join(root, "skills"),
        baseDir: root,
      });
      const output = scanner.formatSensitiveFindings(findings);

      expect(findings.map((finding) => finding.code)).toEqual(
        expect.arrayContaining(["SENSITIVE_FILE", "SENSITIVE_SECRET"])
      );
      expect(output).toContain("skills/alpha/.env");
      expect(output).toContain("skills/alpha/notes.md:1");
      expect(output).not.toContain(secret);
      expect(output).not.toContain(root);
    });
  });

  test("does not flag short placeholder sk examples", () => {
    withTempDir("sensitive-scan-placeholder-", (root) => {
      writeText(path.join(root, "skills", "alpha", "SKILL.md"), 'export OPENAI_API_KEY="sk-..."\n');

      const findings = scanner.scanSensitiveFiles({
        rootDir: path.join(root, "skills"),
        baseDir: root,
      });

      expect(findings).toEqual([]);
    });
  });

  test("emits WARN skip findings for oversize and binary files instead of passing them silently", () => {
    withTempDir("sensitive-scan-skips-", (root) => {
      const secret = ["ghp_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
      writeText(path.join(root, "big.md"), `pad\n${"x".repeat(1024 * 1024)}\ntoken=${secret}\n`);
      writeText(path.join(root, "small.md"), `token=${secret}\n`);
      fs.writeFileSync(path.join(root, "blob.md"), Buffer.from([0, 1, 2, 3]));

      const findings = scanner.scanSensitiveFiles({ rootDir: root, baseDir: root });

      const oversize = findings.filter((finding) => finding.path === "big.md");
      expect(oversize.map((finding) => finding.code)).toEqual(["FILE_SKIPPED_OVERSIZE"]);
      expect(oversize[0]!.level).toBe("WARN");
      expect(oversize[0]!.message).toContain("big.md");
      expect(oversize[0]!.message).toContain("1048576");

      const binary = findings.find(
        (finding) => finding.code === "FILE_SKIPPED_BINARY" && finding.path === "blob.md"
      );
      expect(binary?.level).toBe("WARN");

      // A small matching secret still matches as today; skipped content is not echoed.
      expect(findings.some((finding) => finding.code === "SENSITIVE_SECRET" && finding.path === "small.md")).toBe(true);
      const output = scanner.formatSensitiveFindings(findings);
      expect(output).not.toContain(secret);

      expect(() =>
        scanner.assertNoSensitiveFindings(oversize, "Skill 'padded'"),
      ).toThrow(/FILE_SKIPPED_OVERSIZE/);
    });
  });

  test("can restrict scanning to explicit surface include paths", () => {
    withTempDir("sensitive-scan-surface-", (root) => {
      writeText(path.join(root, "public", "safe.md"), "# Safe\n");
      writeText(path.join(root, "private", ".env"), "TOKEN=redacted\n");

      const findings = scanner.scanSensitiveFiles({
        rootDir: root,
        baseDir: root,
        includePaths: ["public"],
      });

      expect(findings).toEqual([]);
    });
  });

  test("scan-sensitive command reports blocking findings as relative paths", () => {
    withTempDir("sensitive-scan-cli-", (root) => {
      writeSourceLayout(root);
      const authStateFile = ["oauth", "state"].join("-") + ".json";
      writeText(path.join(root, "skills", "alpha", authStateFile), "{}\n");

      const result = captureCommand(() =>
        scanCommand.main(["bun", "scan-sensitive.ts", "--source", root])
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("STATUS: BLOCKING");
      expect(result.stdout).toContain(`skills/alpha/${authStateFile}`);
      expect(result.stdout).not.toContain(root);
    });
  });
});
