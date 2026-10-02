import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scanner = require("../scripts/modules/skillpool/privacy-scan.ts") as typeof import("../scripts/modules/skillpool/privacy-scan.ts");
const publicSurface = require("../scripts/modules/skillpool/public-surface.ts") as typeof import("../scripts/modules/skillpool/public-surface.ts");
const scanCommand = require("../scripts/commands/scan-privacy.ts") as typeof import("../scripts/commands/scan-privacy.ts");
const publicAuditCommand = require("../scripts/commands/public-audit.ts") as typeof import("../scripts/commands/public-audit.ts");
const { captureCommand } = require("./helpers/skillpool-command.ts") as {
  captureCommand: (run: () => void) => { code: number; stdout: string; stderr: string };
};

const agentStateDirectory = [".", "agents"].join("");
const codexMapDirectory = [".codex", "-map"].join("");
const oneDriveMarker = ["One", "Drive"].join("");
const gmailDomain = ["gmail", ".", "com"].join("");
const homePathPrefix = [path.posix.sep, "home", path.posix.sep].join("");
const usersPathPrefix = [path.posix.sep, "Users", path.posix.sep].join("");
const windowsUsersPathPrefix = ["C:", String.fromCharCode(92), "Users", String.fromCharCode(92)].join("");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const localPathMarkersPattern = new RegExp(
  `(?:${escapeRegExp(homePathPrefix)}(?!example-user\\b)|${escapeRegExp(usersPathPrefix)}(?!example-user\\b)|${escapeRegExp(windowsUsersPathPrefix)}(?!ExampleUser\\b))`,
  "i",
);
const publicPrivacyMarkersPattern = new RegExp(
  `(?:${escapeRegExp(gmailDomain)}|${escapeRegExp(oneDriveMarker)}|${escapeRegExp(homePathPrefix)}(?!example-user\\b)|${escapeRegExp(windowsUsersPathPrefix)}(?!ExampleUser\\b))`,
  "i",
);

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

function writeStaticAfolSurfaceFixture(root: string): void {
  writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
  writeJson(path.join(root, ".agents", "lock.json"), { schemaVersion: 1 });
  writeJson(path.join(root, ".agents", "manifest.json"), { schemaVersion: 1 });
  writeText(path.join(root, ".agents", "skills", "afol-rules", "SKILL.md"), "# AFOL Rules\n");
  writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
    version: 1,
    requiredDirectories: ["src"],
    requiredFiles: [],
    forbiddenInArtifactPaths: [".agents"],
    forbiddenInSourcePaths: [".agents"],
    allowedInForbiddenSourcePaths: [".agents/lock.json", ".agents/manifest.json", ".agents/skills/**"],
  });
}

function readRepoJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", relativePath), "utf8")) as T;
}

describe("privacy scanner", () => {
  test("scans PowerShell and batch wrapper content", () => {
    withTempDir("privacy-scan-windows-", (root) => {
      const email = ["fixture-personal", gmailDomain].join("@");
      for (const extension of ["ps1", "bat"]) {
        const relative = `scripts/wrapper.${extension}`;
        writeText(path.join(root, relative), `# ${email}\n`);
        const findings = scanner.scanPrivacy({ rootDir: root, includePaths: [relative] });
        expect(findings.some((finding) => finding.rule === "EMAIL_HANDLE")).toBe(true);
        expect(JSON.stringify(findings)).not.toContain(email);
      }
    });
  });

  test("suppresses only exact reserved agent-state ignore rules", () => {
    withTempDir("privacy-scan-gitignore-", (root) => {
      const codexMapRule = ["/.", "codex-", "map/"].join("");
      const authStateRule = ["*-", "auth", "-state.json"].join("");
      const oauthStateRule = ["oauth", "-state.json"].join("");
      const cases = [
        { line: codexMapRule, blocked: false },
        { line: authStateRule, blocked: false },
        { line: oauthStateRule, blocked: false },
        { line: `# ${codexMapRule}`, blocked: true },
        { line: `${codexMapRule} with extra text`, blocked: true },
        { line: ["/.", "codex-", "map-old/"].join(""), blocked: true },
      ];

      for (const { line, blocked } of cases) {
        writeText(path.join(root, ".gitignore"), `${line}\n`);
        const findings = scanner.scanPrivacy({ rootDir: root, includePaths: [".gitignore"] });
        expect(findings.some((finding) => finding.rule === "AGENT_STATE")).toBe(blocked);
      }
    });
  });

  test("detects personal names, local paths, private workflows, and runtime state without printing values or absolute paths", () => {
    withTempDir("privacy-scan-", (root) => {
      const fixturePerson = ["Fixture", "Person"].join(" ");
      const localPath = ["", "home", "fixture-user", "apps", "example-flow"].join("/");
      writeText(
        path.join(root, "skills", "alpha", "SKILL.md"),
        `Use when operating ${fixturePerson}'s example-flow at ${localPath}.\n`
      );
      writeJson(path.join(root, "privacy-policy.local.json"), {
        markers: {
          personNames: [fixturePerson, "fixture-user"],
          privateWorkflowTerms: ["example-flow"],
        },
      });
      writeText(path.join(root, ".agents", "wb", "session.md"), "local workbench note\n");

      const findings = scanner.scanPrivacy({
        rootDir: root,
        policyPath: path.join(root, "privacy-policy.local.json"),
      });
      const output = scanner.formatPrivacyFindings(findings);

      expect(findings.map((finding) => finding.rule)).toEqual(
        expect.arrayContaining(["PERSON_NAME", "LOCAL_PATH", "PRIVATE_WORKFLOW", "AGENT_STATE_PATH"])
      );
      expect(output).toContain("skills/alpha/SKILL.md:1");
      expect(output).toContain([agentStateDirectory, "wb", "session.md"].join("/"));
      expect(output).not.toContain(`${fixturePerson}'s example-flow`);
      expect(output).not.toContain(localPath);
      expect(output).not.toContain(root);
    });
  });

  test("preserves agent-state marker word boundaries", () => {
    withTempDir("privacy-scan-agent-state-boundaries-", (root) => {
      const codexMapMarker = [".codex", "-map"].join("");
      const authStateMarker = ["auth", "-state"].join("");
      const agentStateDirectory = [".", "agents"].join("");
      const cases = [
        { text: codexMapMarker, blocked: true },
        { text: `${codexMapMarker}/index.json`, blocked: true },
        { text: `${codexMapMarker}ping`, blocked: false },
        { text: `${codexMapMarker}le`, blocked: false },
        { text: `${authStateMarker}!`, blocked: true },
        { text: `${authStateMarker}ful`, blocked: false },
        { text: [agentStateDirectory, "log"].join("/"), blocked: true },
        { text: [agentStateDirectory, "wb"].join("/"), blocked: true },
      ];

      for (const { text, blocked } of cases) {
        writeText(path.join(root, "README.md"), `${text}\n`);
        const findings = scanner.scanPrivacy({ rootDir: root, includePaths: ["README.md"] });
        expect(findings.some((finding) => finding.rule === "AGENT_STATE")).toBe(blocked);
      }
    });
  });

  test("supports controlled allowlist entries for intentional fixtures", () => {
    withTempDir("privacy-scan-allowlist-", (root) => {
      const fixturePerson = ["Fixture", "Person"].join(" ");
      writeText(path.join(root, "tests", "fixtures", "privacy", "example.md"), `${fixturePerson} is a fixture name.\n`);
      writeJson(path.join(root, "privacy-policy.local.json"), {
        markers: {
          personNames: [fixturePerson],
        },
      });
      writeJson(path.join(root, "privacy-allowlist.json"), {
        allowedFindings: [
          {
            path: "tests/fixtures/privacy/example.md",
            rule: "PERSON_NAME",
            reason: "intentional scanner fixture",
          },
        ],
      });

      const findings = scanner.scanPrivacy({
        rootDir: root,
        allowlistPath: path.join(root, "privacy-allowlist.json"),
        policyPath: path.join(root, "privacy-policy.local.json"),
      });

      expect(findings).toEqual([]);
    });
  });

  test("emits WARN skip findings for oversize and binary text files instead of passing them silently", () => {
    withTempDir("privacy-scan-skips-", (root) => {
      const marker = ["", "home", "fixture-user", "apps", "example-flow"].join("/");
      writeText(path.join(root, "big.md"), `pad\n${"x".repeat(1024 * 1024)}\n${marker}\n`);
      fs.writeFileSync(path.join(root, "blob.md"), Buffer.from([0, 1, 2, 3]));

      const findings = scanner.scanPrivacy({ rootDir: root });

      const oversize = findings.filter((finding) => finding.path === "big.md");
      expect(oversize.map((finding) => finding.code)).toEqual(["FILE_SKIPPED_OVERSIZE"]);
      expect(oversize[0]!.level).toBe("WARN");
      expect(oversize[0]!.message).toContain("1048576");

      const binary = findings.find(
        (finding) => finding.code === "FILE_SKIPPED_BINARY" && finding.path === "blob.md"
      );
      expect(binary?.level).toBe("WARN");

      // Skipped content is surfaced without being matched or echoed.
      expect(JSON.stringify(findings)).not.toContain(marker);
    });
  });

  test("force text scanning is opt-in and still preserves binary and size guards", () => {
    withTempDir("privacy-scan-force-text-", (root) => {
      const marker = ["", "home", "fixture-user", "apps", "example-flow"].join("/");
      writeText(path.join(root, "retired.toml"), `marker = '${marker}'\n`);
      writeText(path.join(root, "large.toml"), "x".repeat(1024 * 1024 + 1));
      fs.writeFileSync(path.join(root, "blob.toml"), Buffer.from([0, 1, 2, 3]));

      expect(scanner.scanPrivacy({ rootDir: root })).toEqual([]);

      const findings = scanner.scanPrivacy({ rootDir: root, forceTextContentScan: true });
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "PRIVACY_CONTENT", path: "retired.toml", rule: "LOCAL_PATH" }),
          expect.objectContaining({ code: "FILE_SKIPPED_OVERSIZE", path: "large.toml" }),
          expect.objectContaining({ code: "FILE_SKIPPED_BINARY", path: "blob.toml" }),
        ])
      );
      expect(JSON.stringify(findings)).not.toContain(marker);
    });
  });

  test("does not treat the portable ~windows target token as a local path", () => {
    withTempDir("privacy-scan-windows-token-", (root) => {
      writeText(path.join(root, "global-core.md"), "targetPath: ~windows/.codex/skills\n");

      const findings = scanner.scanPrivacy({ rootDir: root });

      expect(findings.filter((finding) => finding.rule === "LOCAL_PATH")).toEqual([]);
    });
  });

  test("strict allowlists require line, match hash, reason, and expiry", () => {
    withTempDir("privacy-scan-strict-allowlist-", (root) => {
      const fixturePerson = ["Fixture", "Person"].join(" ");
      writeText(path.join(root, "tests", "fixtures", "privacy", "example.md"), `${fixturePerson} is a fixture name.\n`);
      writeJson(path.join(root, "privacy-policy.local.json"), {
        markers: {
          personNames: [fixturePerson],
        },
      });
      const baseline = scanner.scanPrivacy({
        rootDir: root,
        policyPath: path.join(root, "privacy-policy.local.json"),
      });
      expect(baseline).toHaveLength(1);
      const finding = baseline[0]!;
      expect(finding.matchHash).toMatch(/^sha256:[a-f0-9]{64}$/);

      writeJson(path.join(root, "privacy-allowlist.json"), {
        allowedFindings: [
          {
            path: "tests/fixtures/privacy/example.md",
            rule: "PERSON_NAME",
            code: "PRIVACY_CONTENT",
            reason: "intentional scanner fixture",
          },
        ],
      });

      expect(() =>
        scanner.scanPrivacy({
          rootDir: root,
          allowlistPath: path.join(root, "privacy-allowlist.json"),
          policyPath: path.join(root, "privacy-policy.local.json"),
          strictAllowlist: true,
        })
      ).toThrow("line");

      writeJson(path.join(root, "privacy-allowlist.json"), {
        allowedFindings: [
          {
            path: finding.path,
            rule: finding.rule,
            code: finding.code,
            line: finding.line,
            matchHash: finding.matchHash,
            reason: "intentional scanner fixture",
            expires: "2026-12-31",
          },
        ],
      });

      const findings = scanner.scanPrivacy({
        rootDir: root,
        allowlistPath: path.join(root, "privacy-allowlist.json"),
        policyPath: path.join(root, "privacy-policy.local.json"),
        strictAllowlist: true,
      });

      expect(findings).toEqual([]);
    });
  });

  test("configured synthetic public policy markers block fixture branding and example domains", () => {
    withTempDir("privacy-scan-public-policy-", (root) => {
      const fixturePerson = ["Fixture", "Person"].join(" ");
      const sampleUser = ["Sample", "User"].join(" ");
      const maintainerEmail = ["maintainer", "@example.invalid"].join("");
      const internalWorkflow = ["fixture", "internal", "process"].join("-");
      const exampleWorkflow = ["example", "private", "workflow"].join("-");
      const exampleHome = ["", "home", "example-user"].join("/");
      const windowsHome = ["C:", "Users", "ExampleUser"].join("\\");
      writeText(path.join(root, "README.md"), `${fixturePerson} should not appear in the public artifact.\n`);
      writeText(path.join(root, "schema", "example.json"), JSON.stringify({ owner: maintainerEmail }));
      writeJson(path.join(root, "privacy-policy.public.json"), {
        markers: {
          personNames: [fixturePerson, sampleUser],
          privateWorkflowTerms: [internalWorkflow, exampleWorkflow],
          emailHandles: [maintainerEmail],
          localPaths: [exampleHome, windowsHome],
        },
      });

      const findings = scanner.scanPrivacy({
        rootDir: root,
        policyPath: path.join(root, "privacy-policy.public.json"),
      });

      expect(findings.map((finding) => finding.rule)).toEqual(
        expect.arrayContaining(["PERSON_NAME", "EMAIL_HANDLE"])
      );
    });
  });

  test("repo public privacy policy contains synthetic fixtures only", () => {
    const policy = readRepoJson<{ markers?: Record<string, string[]> }>("privacy-policy.public.json");
    const values = Object.values(policy.markers || {}).flat();

    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => /(?:example|fixture|sample|invalid)/i.test(value))).toBe(true);
    expect(values).not.toContain(oneDriveMarker);
    expect(values.some((value) => new RegExp(escapeRegExp(gmailDomain), "i").test(value))).toBe(false);
    expect(values.some((value) => localPathMarkersPattern.test(value))).toBe(false);
  });

  test("repo public allowlist has no personal markers, local paths, or release-debt reasons", () => {
    const allowlist = readRepoJson<{ allowedFindings?: Array<{ reason?: string; path?: string }> }>(
      "privacy-allowlist.public.json"
    );
    const entries = allowlist.allowedFindings || [];
    const blockedReasonFragments = [
      ["stag", "ing"].join(""),
      ["replace before public", " release"].join(""),
      ["private workflow", " retained"].join(""),
      ["real personal", " marker"].join(""),
      ["local marker", " debt"].join(""),
    ];

    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) {
      expect(`${entry.reason || ""} ${entry.path || ""}`).toMatch(/(?:example|fixture|sample|synthetic)/i);
      expect(entry.reason || "").not.toMatch(new RegExp(blockedReasonFragments.join("|"), "i"));
      expect(`${entry.reason || ""} ${entry.path || ""}`).not.toMatch(publicPrivacyMarkersPattern);
    }
  });

  test("engine public packlist does not contain known private staging markers", () => {
    const root = path.resolve(__dirname, "..");
    const packlist = publicSurface.collectPublicSurfacePacklist(root, "engine-public");
    const blockedPatterns = [
      new RegExp(`[A-Z0-9._%+-]+@${escapeRegExp(gmailDomain)}`, "i"),
      new RegExp(`${escapeRegExp(homePathPrefix)}(?!example-user\\b)[A-Za-z0-9._-]+`, "i"),
      new RegExp(`${escapeRegExp(windowsUsersPathPrefix)}(?!ExampleUser\\b)[A-Za-z0-9._-]+`, "i"),
      /(?:owner|maintainer) explicitly approves publication as a named person/i,
    ];

    for (const file of packlist.files) {
      const content = fs.readFileSync(path.join(root, file.path), "utf8");
      for (const pattern of blockedPatterns) {
        expect(content, `${file.path} contains a private staging marker`).not.toMatch(pattern);
      }
    }
  });

  test("scan-privacy command blocks errors and reports relative paths", () => {
    withTempDir("privacy-scan-cli-", (root) => {
      const privateRepo = ["private", "repo"].join(" ");
      writeText(path.join(root, "README.md"), `This ${privateRepo} example is not public-safe.\n`);

      const result = captureCommand(() =>
        scanCommand.main(["bun", "scan-privacy.ts", "--source", root])
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("STATUS: BLOCKING");
      expect(result.stdout).toContain("README.md:1");
      expect(result.stdout).not.toContain(root);
    });
  });

  test("surface mode treats artifact-forbidden paths as packlist exclusions, not source existence blockers", () => {
    withTempDir("privacy-scan-artifact-forbidden-", (root) => {
      writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
      const fixturePerson = ["Fixture", "Person"].join(" ");
      writeText(path.join(root, "docs", "private.md"), `${fixturePerson} should be excluded by the surface.\n`);
      writeText(path.join(root, agentStateDirectory, "wb", "session.md"), "state\n");
      writeText(path.join(root, codexMapDirectory, "index.json"), "{}\n");
      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["src"],
        requiredFiles: [],
        forbiddenInArtifactPaths: [agentStateDirectory, codexMapDirectory],
      });

      const result = captureCommand(() =>
        scanCommand.main(["bun", "scan-privacy.ts", "--source", root, "--surface", "engine-public"])
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("STATUS: PASS");
      expect(result.stdout).not.toContain("FORBIDDEN_PATH");
      expect(result.stdout).not.toContain("docs/private.md");
    });
  });

  test("engine-style surfaces allow the static AFOL payload but block mutable AFOL agent state", () => {
    withTempDir("privacy-scan-afol-static-agents-", (root) => {
      writeStaticAfolSurfaceFixture(root);

      const staticResult = captureCommand(() =>
        scanCommand.main(["bun", "scan-privacy.ts", "--source", root, "--surface", "engine-public"])
      );

      expect(staticResult.code).toBe(0);
      expect(staticResult.stdout).toContain("STATUS: PASS");

      writeText(path.join(root, ".agents", "wb", "session.md"), "mutable state\n");
      const mutableResult = captureCommand(() =>
        scanCommand.main(["bun", "scan-privacy.ts", "--source", root, "--surface", "engine-public"])
      );

      expect(mutableResult.code).toBe(1);
      expect(mutableResult.stdout).toContain(`${agentStateDirectory}/wb exists but is forbidden`);
    });
  });

  test("engine-style surfaces scan allowed static agent skills for privacy markers", () => {
    withTempDir("privacy-scan-afol-static-skill-content-", (root) => {
      writeStaticAfolSurfaceFixture(root);
      const privateRepo = ["private", "repo"].join(" ");
      writeText(
        path.join(root, ".agents", "skills", "afol-rules", "SKILL.md"),
        `This ${privateRepo} marker must block publication.\n`
      );

      const result = captureCommand(() =>
        scanCommand.main(["bun", "scan-privacy.ts", "--source", root, "--surface", "engine-public"])
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toContain(".agents/skills/afol-rules/SKILL.md:1");
      expect(result.stdout).toContain("PRIVATE_WORKFLOW");
    });
  });

  test("engine-style AFOL exceptions fail closed for unknown descendants and symlinks", () => {
    for (const unsafePath of [".agents/custom-runtime/state.json", ".agents/secrets/file.txt"]) {
      withTempDir("privacy-scan-afol-unknown-agents-", (root) => {
        writeStaticAfolSurfaceFixture(root);
        writeText(path.join(root, unsafePath), "local state\n");

        const result = captureCommand(() =>
          scanCommand.main(["bun", "scan-privacy.ts", "--source", root, "--surface", "engine-public"])
        );

        expect(result.code).toBe(1);
        expect(result.stdout).toContain(unsafePath.split("/").slice(0, 2).join("/"));
      });
    }

    withTempDir("privacy-scan-afol-symlink-agents-", (root) => {
      writeStaticAfolSurfaceFixture(root);
      fs.symlinkSync(path.join(root, "src"), path.join(root, ".agents", "skills", "linked"));

      const result = captureCommand(() =>
        scanCommand.main(["bun", "scan-privacy.ts", "--source", root, "--surface", "engine-public"])
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toContain(".agents/skills/linked");
    });
  });

  test("surface mode still blocks paths explicitly forbidden in source", () => {
    withTempDir("privacy-scan-source-forbidden-", (root) => {
      writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
      writeText(path.join(root, ".agents", "wb", "session.md"), "state\n");
      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["src"],
        requiredFiles: [],
        forbiddenInSourcePaths: [".agents"],
      });

      const result = captureCommand(() =>
        scanCommand.main(["bun", "scan-privacy.ts", "--source", root, "--surface", "engine-public"])
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("FORBIDDEN_PATH");
      expect(result.stdout).toContain(".agents exists but is forbidden");
    });
  });

  test("legacy forbiddenPaths stays an artifact-level alias in surface mode", () => {
    withTempDir("privacy-scan-legacy-forbidden-", (root) => {
      writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
      writeText(path.join(root, ".agents", "wb", "session.md"), "state\n");
      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["src"],
        requiredFiles: [],
        forbiddenPaths: [".agents"],
      });

      const result = captureCommand(() =>
        scanCommand.main(["bun", "scan-privacy.ts", "--source", root, "--surface", "engine-public"])
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("STATUS: PASS");
    });
  });

  test("surface policy files may enumerate agent-state paths as blocked artifact metadata", () => {
    withTempDir("privacy-scan-surface-policy-", (root) => {
      writeText(path.join(root, "src", "index.ts"), "export const ok = true;\n");
      writeJson(path.join(root, "artifact-surfaces", "skillpack-public.json"), {
        version: 1,
        requiredDirectories: ["src"],
        requiredFiles: [],
        forbiddenInArtifactPaths: [agentStateDirectory, codexMapDirectory],
      });
      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["src"],
        requiredFiles: ["artifact-surfaces/skillpack-public.json"],
        forbiddenInArtifactPaths: [],
      });

      const result = captureCommand(() =>
        scanCommand.main(["bun", "scan-privacy.ts", "--source", root, "--surface", "engine-public"])
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("STATUS: PASS");
      expect(result.stdout).not.toContain("AGENT_STATE");
    });
  });

  test("public-audit combines privacy and sensitive checks on the selected surface", () => {
    withTempDir("public-audit-", (root) => {
      const privateRepo = ["private", "repo"].join(" ");
      writeText(path.join(root, "src", "index.ts"), `This ${privateRepo} example is not public-safe.\n`);
      writeText(path.join(root, "src", ".env"), "TOKEN=redacted\n");
      writeText(path.join(root, "private", ".env"), "TOKEN=redacted\n");
      writeJson(path.join(root, "artifact-surfaces", "engine-public.json"), {
        version: 1,
        requiredDirectories: ["src"],
        requiredFiles: [],
        forbiddenPaths: [],
      });

      const result = captureCommand(() =>
        publicAuditCommand.main(["bun", "public-audit.ts", "--source", root, "--surface", "engine-public"])
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toContain("STATUS: BLOCKING");
      expect(result.stdout).toContain("PRIVACY FINDINGS");
      expect(result.stdout).toContain("SENSITIVE FINDINGS");
      expect(result.stdout).toContain("src/index.ts:1");
      expect(result.stdout).toContain("src/.env");
      expect(result.stdout).not.toContain("private/.env");
      expect(result.stdout).not.toContain(root);
    });
  });
});
