import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const workflowRoot = path.join(repoRoot, ".github/workflows");
const docsCheckCommand = require("../scripts/commands/docs-check.ts") as typeof import("../scripts/commands/docs-check.ts");

function workflowFiles(): string[] {
  return fs
    .readdirSync(workflowRoot)
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .sort()
    .map((entry) => path.join(workflowRoot, entry));
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("workflow policy", () => {
  test("both release jobs reject private packages before dependency installation", () => {
    const workflow = read(".github/workflows/release-publish.yml");
    const publishStart = workflow.indexOf("  publish-npm:");
    const jobs = [workflow.slice(0, publishStart), workflow.slice(publishStart)];
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "npm-eligibility-"));
    try {
      for (const job of jobs) {
        const gateStart = job.indexOf("- name: Check npm publication eligibility");
        expect(gateStart).toBeGreaterThan(0);
        expect(gateStart).toBeLessThan(job.indexOf("- name: Install dependencies"));
        const program = job.slice(gateStart).match(/bun -e '([^']+)'/)?.[1];
        expect(program).toBeDefined();
        for (const isPrivate of [true, false]) {
          fs.writeFileSync(path.join(scratch, "package.json"), JSON.stringify({ private: isPrivate }));
          const result = Bun.spawnSync([process.execPath, "-e", program!], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
          expect(result.exitCode).toBe(isPrivate ? 1 : 0);
          if (isPrivate) expect(result.stderr.toString()).toContain("npm publication is disabled");
        }
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("workflows avoid high-risk triggers and token secret publishing", () => {
    for (const filePath of workflowFiles()) {
      const text = fs.readFileSync(filePath, "utf8");
      expect(text).not.toContain("pull_request_target:");
      expect(text).not.toContain("NPM_TOKEN");
      expect(text).not.toContain("NODE_AUTH_TOKEN");
      expect(text).not.toContain("secrets.npm");
      expect(text).not.toContain("secrets.NPM");
    }
  });

  test("every workflow declares explicit top-level permissions", () => {
    for (const filePath of workflowFiles()) {
      const text = fs.readFileSync(filePath, "utf8");
      expect(text).toMatch(/\npermissions:\n/);
      expect(text).toMatch(/\n  contents: read\n/);
    }
  });

  test("checkout never persists credentials", () => {
    for (const filePath of workflowFiles()) {
      const text = fs.readFileSync(filePath, "utf8");
      const checkoutCount = (text.match(/uses: actions\/checkout@/g) ?? []).length;
      const disabledCount = (text.match(/persist-credentials: false/g) ?? []).length;
      expect(disabledCount).toBe(checkoutCount);
    }
  });

  test("workflow jobs pin runtime versions and define timeouts", () => {
    for (const filePath of workflowFiles()) {
      const text = fs.readFileSync(filePath, "utf8");
      expect(text).not.toContain("bun-version: latest");
      const jobCount = (text.match(/^    runs-on: /gm) ?? []).length;
      const timeoutCount = (text.match(/^    timeout-minutes: /gm) ?? []).length;
      expect(timeoutCount).toBe(jobCount);
    }
  });

  test("release workflow keeps publish behind explicit tag/manual guard", () => {
    const text = read(".github/workflows/release-publish.yml");
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("publish_npm:");
    expect(text).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(text).toContain("npm publish --provenance --tag next");
  });

  test("history-dependent gates use complete history, current repository visibility, and the observed check context", () => {
    const ci = read(".github/workflows/universall-skill-sys-ci.yml");
    const release = read(".github/workflows/release-publish.yml");
    const branchProtection = read("scripts/ops/configure-branch-protection.sh");

    expect(ci).toContain("fetch-depth: 0");
    expect(release).toContain("fetch-depth: 0");
    expect(release).toContain('guard-repo-visibility --repository "$GITHUB_REPOSITORY"');
    expect(branchProtection).toContain('REQUIRED_CHECK="${REQUIRED_CHECK:-quality-gates}"');
    expect(branchProtection).toContain('"contexts": ["$REQUIRED_CHECK"]');
  });

  test("scorecard stays private-repo compatible and does not publish externally", () => {
    const text = read(".github/workflows/scorecard.yml");
    expect(text).toContain("Private repository compatibility guard");
    expect(text).toContain("if: ${{ github.event.repository.private }}");
    expect(text).toContain("if: ${{ !github.event.repository.private }}");
    expect(text).toContain("results_format: sarif");
    expect(text).toContain("publish_results: false");
    expect(text).toContain("github/codeql-action/upload-sarif@");
    expect(text).toMatch(/github\/codeql-action\/upload-sarif@[0-9a-f]{40}/);
  });

  test("codeql stays private-repo compatible until code scanning is enabled", () => {
    const text = read(".github/workflows/codeql.yml");
    expect(text).toContain("Private repository compatibility guard");
    expect(text).toContain("if: ${{ github.event.repository.private }}");
    expect(text).toContain("if: ${{ !github.event.repository.private }}");
    expect(text).toContain("github/codeql-action/init@");
    expect(text).toContain("github/codeql-action/analyze@");
    expect(text).toMatch(/github\/codeql-action\/init@[0-9a-f]{40}/);
    expect(text).toMatch(/github\/codeql-action\/analyze@[0-9a-f]{40}/);
  });

  test("docs-check rejects a command-reference entry absent from the canonical registry", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "docs-check-"));
    try {
      const docsPath = path.join(tempRoot, "README.md");
      fs.writeFileSync(docsPath, "`skill-sys no-such-command`\n");
      const result = docsCheckCommand.docsCheck([docsPath]);

      expect(result.findings).toContainEqual(
        expect.objectContaining({
          code: "DOC_SKILL_SYS_COMMAND_UNKNOWN",
          message: "Command is not in the Skill-Sys registry: no-such-command",
        }),
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
