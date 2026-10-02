import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const redact = require("../scripts/lib/redact.ts") as typeof import("../scripts/lib/redact.ts");
const releasePrepare = require("../scripts/commands/release-prepare.ts") as typeof import("../scripts/commands/release-prepare.ts");
const publishSkill = require("../scripts/commands/publish-skill.ts") as typeof import("../scripts/commands/publish-skill.ts");
const skillChangeGuard = require("../scripts/commands/skill-change-guard.ts") as typeof import("../scripts/commands/skill-change-guard.ts");
const npmPackAudit = require("../scripts/commands/npm-pack-audit.ts") as typeof import("../scripts/commands/npm-pack-audit.ts");
const install = require("../scripts/modules/skillpool/install.ts") as typeof import("../scripts/modules/skillpool/install.ts");

const repoRoot = path.resolve(__dirname, "..");
const examplePack = path.join(repoRoot, "examples", "minimal-skillpack");

// Canary markers are deliberately unique strings that stand in for secrets.
const CHILD_STREAM_CANARY = "CHILD-STREAM-CANARY-SECRET";
const ARGV_TOKEN_CANARY = "ARGV-CANARY-TOKEN-VALUE";
const AUDIT_CANARY = "AUDIT-CANARY-SECRET";

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function makeTempRoot(prefix: string): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function thrownMessage(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected callback to throw");
}

// ---------------------------------------------------------------------------
// 1. Shared redaction helper
// ---------------------------------------------------------------------------
describe("redact helper", () => {
  test("scheme URL userinfo is redacted while host/path/ref context survives", () => {
    expect(
      redact.redactRemoteForDiagnostics("https://ci:supersecret@github.com/org/repo.git")
    ).toBe("https://[REDACTED]@github.com/org/repo.git");
    expect(
      redact.redactRemoteForDiagnostics("ssh://git@github.com/org/repo.git")
    ).toBe("ssh://[REDACTED]@github.com/org/repo.git");
    expect(
      redact.redactRemoteForDiagnostics("https://user:pass@github.com/org/repo.git#v1.2.3")
    ).toBe("https://[REDACTED]@github.com/org/repo.git");
  });

  test("recognized credential query params are masked; ordinary params survive", () => {
    expect(
      redact.redactRemoteForDiagnostics(
        "https://github.com/org/repo.git?token=abc123&secret=xyz&password=p&api_key=k&authorization=Bearer%20t&ref=main"
      )
    ).toBe(
      "https://github.com/org/repo.git?token=[REDACTED]&secret=[REDACTED]&password=[REDACTED]&api_key=[REDACTED]&authorization=[REDACTED]&ref=main"
    );
  });

  test("percent-encoded credential query param names are masked after decoding", () => {
    expect(
      redact.redactRemoteForDiagnostics(
        "https://github.com/org/repo.git?%74oken=QUERY-CANARY-SECRET&ref=main"
      )
    ).toBe("https://github.com/org/repo.git?%74oken=[REDACTED]&ref=main");
    expect(
      redact.redactRemoteForDiagnostics(
        "https://github.com/org/repo.git?%61ccess%5Ftoken=a&api%2Dkey=b"
      )
    ).toBe(
      "https://github.com/org/repo.git?%61ccess%5Ftoken=[REDACTED]&api%2Dkey=[REDACTED]"
    );
    expect(
      redact.redactRemoteForDiagnostics(
        "https://github.com/org/repo.git?%2574oken=double-encoded"
      )
    ).toBe("https://github.com/org/repo.git?%2574oken=[REDACTED]");
  });

  test("fragments are dropped entirely so credential assignments cannot leak", () => {
    const fragmentCanary = `${["refresh", "_token"].join("")}=${["FRAGMENT", "CANARY", "TOKEN"].join("-")}`;
    const queryCanary = ["token", "=", ["QUERY", "CANARY", "SECRET"].join("-")].join("");
    const userInfo = ["user", "pass"].join(":");
    expect(
      redact.redactRemoteForDiagnostics(`https://github.com/org/repo.git#${fragmentCanary}`)
    ).toBe("https://github.com/org/repo.git");
    expect(
      redact.redactRemoteForDiagnostics(
        `https://${userInfo}@github.com/org/repo.git?${queryCanary}#${fragmentCanary}`
      )
    ).toBe("https://[REDACTED]@github.com/org/repo.git?token=[REDACTED]");
  });

  test("scp-like Git remotes redact userinfo but keep host and path", () => {
    expect(redact.redactRemoteForDiagnostics("git@github.com:org/repo.git")).toBe(
      "[REDACTED]@github.com:org/repo.git"
    );
    expect(redact.redactRemoteForDiagnostics("deploy@127.0.0.1:skills.git")).toBe(
      "[REDACTED]@127.0.0.1:skills.git"
    );
  });

  test("local paths, refs, and hashes pass through untouched", () => {
    const localPath = ["", "home", "example-user", "projects", "skills"].join("/");
    expect(redact.redactRemoteForDiagnostics(localPath)).toBe(localPath);
    expect(redact.redactRemoteForDiagnostics("v1.2.3")).toBe("v1.2.3");
    const sha = "a".repeat(40);
    expect(redact.redactRemoteForDiagnostics(sha)).toBe(sha);
  });

  test("argv rendering masks secret flags and credential-bearing remotes", () => {
    expect(
      redact.redactArgvForDiagnostics([
        "git",
        "remote",
        "add",
        "origin",
        `https://ci:${ARGV_TOKEN_CANARY}@example.invalid/x.git`,
      ])
    ).toEqual(["git", "remote", "add", "origin", "https://[REDACTED]@example.invalid/x.git"]);
    expect(
      redact.childFailureMessage(["git", "--token", ARGV_TOKEN_CANARY, "status"], 3)
    ).toBe("Command failed (3): git --token [REDACTED] status");
  });
});

// ---------------------------------------------------------------------------
// 2. Wrapper child-failure canaries
// ---------------------------------------------------------------------------
describe("wrapper failure output never echoes captured child streams", () => {
  test("release-prepare run() reports exit code only", () => {
    const message = thrownMessage(() =>
      releasePrepare.run(["git", "status", "--porcelain"], {}, {
        runCommand: () => ({ code: 7, stdout: CHILD_STREAM_CANARY, stderr: CHILD_STREAM_CANARY }),
      })
    );
    expect(message).toBe("Command failed (7): git status --porcelain");
    expect(message).not.toContain(CHILD_STREAM_CANARY);
  });

  test("publish-skill run() reports exit code only and redacts repo argv", () => {
    const message = thrownMessage(() =>
      publishSkill.run("git", ["status"], {}, {
        runCommand: () => ({ code: 2, stdout: CHILD_STREAM_CANARY, stderr: CHILD_STREAM_CANARY }),
      })
    );
    expect(message).toBe("Command failed (2): git status");
    expect(message).not.toContain(CHILD_STREAM_CANARY);

    const repoMessage = thrownMessage(() =>
      publishSkill.run(
        "git",
        ["remote", "add", "origin", `https://ci:${ARGV_TOKEN_CANARY}@example.invalid/x.git`],
        {},
        { runCommand: () => ({ code: 5, stdout: "", stderr: "" }) },
      )
    );
    expect(repoMessage).not.toContain(ARGV_TOKEN_CANARY);
    expect(repoMessage).toContain("[REDACTED]@example.invalid");
  });

  test("publish-skill aggregate fetch failure keeps ref context and drops tokens", () => {
    const message = thrownMessage(() =>
      publishSkill.fetchPublishWorkdir(
        `https://fetch:${ARGV_TOKEN_CANARY}@example.invalid/x.git`,
        "missing-ref",
        "/nonexistent-checkout",
        (_command: string, args: string[]) => {
          if (args.includes("fetch")) {
            throw new Error("Command failed (128): git -C /nonexistent-checkout fetch");
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      )
    );
    expect(message).toContain("Failed to fetch Git ref 'missing-ref'");
    expect(message).toContain("[REDACTED]@example.invalid");
    expect(message).not.toContain(ARGV_TOKEN_CANARY);
  });

  test("skill-change-guard run() excludes real failing child stdout/stderr", () => {
    // The child script lives in a file so the secret exists only in the
    // child's captured streams, never in argv (headers render argv).
    const root = makeTempRoot("guard-canary-");
    const childScriptPath = path.join(root, "canary-child.js");
    fs.writeFileSync(
      childScriptPath,
      `process.stdout.write("${CHILD_STREAM_CANARY}"); process.stderr.write("${CHILD_STREAM_CANARY}"); process.exit(3);\n`,
      "utf8",
    );
    const message = thrownMessage(() =>
      skillChangeGuard.run(process.execPath, [childScriptPath])
    );
    expect(message).toContain("Command failed (3)");
    expect(message).not.toContain(CHILD_STREAM_CANARY);
  });

  test("npm-pack-audit reports stage + exit code without captured npm output", () => {
    const message = thrownMessage(() =>
      npmPackAudit.runNpmPackAudit(
        { source: repoRoot, surface: "engine-public", json: false },
        { runCommand: () => ({ code: 9, stdout: CHILD_STREAM_CANARY, stderr: CHILD_STREAM_CANARY }) },
      )
    );
    expect(message).toContain("Command failed (9): npm pack --dry-run --json --ignore-scripts");
    expect(message).not.toContain(CHILD_STREAM_CANARY);
  });

  test("install audit failures keep stage + rerun pointer but drop raw audit payload", () => {
    const root = makeTempRoot("install-audit-canary-");
    const projectDir = path.join(root, "project");
    const packCopy = path.join(root, "pack");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.cpSync(examplePack, packCopy, { recursive: true });

    const message = thrownMessage(() =>
      install.installCommand(
        {
          project: projectDir,
          app: "codex",
          source: packCopy,
          skills: "example-skill",
          "install-mode": "copy",
        },
        {
          universalContractScript: "universal-contract.ts",
          skillMetadataScript: "skill-metadata.ts",
          skillLifecycleScript: "skill-lifecycle.ts",
          runUniversalContract: () => ({ ok: false, message: AUDIT_CANARY }),
          runSkillMetadataAudit: () => ({ ok: true, message: "ok" }),
          runSkillLifecycleAudit: () => ({ ok: true, message: "ok" }),
        },
      )
    );
    expect(message).toContain("failed universal contract check");
    expect(message).toContain("audit details withheld");
    expect(message).not.toContain(AUDIT_CANARY);

    // The metadata audit lane gets the same treatment.
    const metadataMessage = thrownMessage(() =>
      install.installCommand(
        {
          project: projectDir,
          app: "codex",
          source: packCopy,
          skills: "example-skill",
          "install-mode": "copy",
        },
        {
          universalContractScript: "universal-contract.ts",
          skillMetadataScript: "skill-metadata.ts",
          skillLifecycleScript: "skill-lifecycle.ts",
          runUniversalContract: () => ({ ok: true, message: "ok" }),
          runSkillMetadataAudit: () => ({ ok: false, message: AUDIT_CANARY }),
          runSkillLifecycleAudit: () => ({ ok: true, message: "ok" }),
        },
      )
    );
    expect(metadataMessage).toContain("failed metadata audit");
    expect(metadataMessage).not.toContain(AUDIT_CANARY);
  });
});
