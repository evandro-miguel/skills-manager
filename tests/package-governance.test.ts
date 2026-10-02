import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const packageJson = require("../package.json") as {
  name?: string;
  private?: boolean;
  license?: string;
  publishConfig?: Record<string, unknown>;
  scripts: Record<string, string>;
  repository?: Record<string, unknown>;
  homepage?: string;
  bugs?: Record<string, unknown>;
  keywords?: string[];
  engines?: Record<string, string>;
};
const inventoryCommand = require("../scripts/commands/generate-skills-inventory.ts") as typeof import("../scripts/commands/generate-skills-inventory.ts");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("package governance", () => {
  test("defines truthful validation script levels", () => {
    expect(packageJson.scripts["schema:check"]).toBe(
      "bun test tests/schema-contract.test.ts tests/source-contract-v2.test.ts",
    );
    expect(packageJson.scripts["release:prepare"]).toBe("bun scripts/commands/release-prepare.ts");
    expect(packageJson.scripts["release:verify"]).toBe("bun scripts/commands/release-verify.ts");
    expect(packageJson.scripts["build-projections"]).toBe(
      "bun scripts/commands/skill-sys.ts build-projections --source examples/minimal-skillpack --providers all --out-dir dist/projection-smoke --projection-store-dir .tmp/projection-store --clean"
    );
    expect(packageJson.scripts["validate-projections"]).toBe(
      "bun scripts/commands/skill-sys.ts validate-projections --source examples/minimal-skillpack --providers all --out-dir dist/projection-smoke"
    );
    expect(packageJson.scripts["verify-origin"]).toBe(
      "bun scripts/commands/skill-sys.ts verify-origin --source examples/minimal-skillpack --ref HEAD --no-require-ref-exists"
    );
    expect(packageJson.scripts["architecture:check"]).toBe(
      "bun test --timeout 30000 tests/architecture-fitness.test.ts tests/architecture-fitness-report.test.ts tests/architecture-boundary-integration.test.ts tests/catalog-boundary-policy.test.ts tests/source-boundary-policy.test.ts"
    );
    expect(packageJson.scripts["boundary:check"]).toBe(
      "bun run architecture:check && bun test tests/package-boundaries.test.ts tests/catalog-boundary-policy.test.ts"
    );
    expect(packageJson.scripts["docs:check"]).toBe("bun scripts/commands/skill-sys.ts docs-check");
    expect(packageJson.scripts["knip"]).toBe("knip --no-progress");
    expect(packageJson.scripts["validate:local"]).toBe(
      "bun run typecheck && bun run knip && bun run schema:check && bun run boundary:check && bun run test && bun run validate:skillpack && bun run scan:sensitive && bun run scan:privacy"
    );
    expect(packageJson.scripts["validate:ci"]).toBe(
      "bun run validate:local && bun run coverage:check && bun run lint:docs:full && bun run public:audit && bun run packlist && bun run npm-pack-audit && bun run scan:dependencies"
    );
    expect(packageJson.scripts["scan:dependencies"]).toBe("bun audit");
    expect(packageJson.scripts["guard:repo-visibility"]).toBe(
      "bun scripts/commands/skill-sys.ts guard-repo-visibility"
    );
    expect(packageJson.scripts["registry:check"]).toBe(
      "bun scripts/commands/skill-sys.ts validate-registry-surface --source ."
    );
    expect(packageJson.scripts["validate:release"]).toBe(
      "bun run validate:ci && bun run audit:public-repository && bun run guard:repo-visibility",
    );
    expect(packageJson.scripts["validate:publish"]).toBe(
      "bun run validate:release && bun run build-projections && bun run validate-projections && bun run release:smoke && bun run verify-origin && bun run registry:check && bun run npm-pack-audit"
    );
    expect(packageJson.scripts.validate).toBe("bun run validate:ci");
    expect(packageJson.scripts["ci:checks"]).toBe("bun run validate:release");
    expect(packageJson.scripts["prepublishOnly"]).toBe("bun run validate:publish");
    expect(packageJson.scripts["codeql:local"]).toBe("bun scripts/commands/security-tool-status.ts codeql");
    expect(packageJson.scripts["scorecard:local"]).toBe("bun scripts/commands/security-tool-status.ts scorecard");
  });

  test("keeps governance tests in the local test gate", () => {
    expect(packageJson.scripts.test).toContain("tests/package-governance.test.ts");
    expect(packageJson.scripts.test).toContain("tests/package-boundaries.test.ts");
    expect(packageJson.scripts.test).toContain("tests/architecture-fitness.test.ts");
    expect(packageJson.scripts.test).toContain("tests/architecture-fitness-report.test.ts");
    expect(packageJson.scripts.test).toContain("tests/architecture-boundary-integration.test.ts");
    expect(packageJson.scripts.test).toContain("tests/catalog-boundary-policy.test.ts");
    expect(packageJson.scripts.test).toContain(
      "tests/catalog-query-shell-parity.test.ts",
    );
    expect(packageJson.scripts.test).toContain("tests/remove-planning-core.test.ts");
    expect(packageJson.scripts.test).toContain("tests/source-contract-v2.test.ts");
    expect(packageJson.scripts.test).toContain("tests/command-spec-registry.test.ts");
    expect(packageJson.scripts.test).toContain(
      "tests/telemetry-policy-cli-characterization.test.ts",
    );
    expect(packageJson.scripts.test).toContain(
      "tests/team-mode-cli-characterization.test.ts",
    );
    expect(packageJson.scripts.test).toContain(
      "tests/memory-adapter-cli-characterization.test.ts",
    );
    expect(packageJson.scripts.test).toContain(
      "tests/project-learnings-cli-characterization.test.ts",
    );
    expect(packageJson.scripts.test).toContain(
      "tests/registry-trust-cli-characterization.test.ts",
    );
    expect(packageJson.scripts["validate:local"]).toContain("bun run boundary:check");
  });

  test("uses the sole active architecture manifest v5 authority", () => {
    const manifestV5Path = path.join(
      repoRoot,
      "scripts/modules/skill-sys/architecture-boundaries.v5.json",
    );
    const manifestV4Path = path.join(
      repoRoot,
      "scripts/modules/skill-sys/architecture-boundaries.v4.json",
    );
    const manifestV2Path = path.join(
      repoRoot,
      "scripts/modules/skill-sys/architecture-boundaries.v2.json",
    );
    const manifestV1Path = path.join(
      repoRoot,
      "scripts/modules/skill-sys/architecture-boundaries.v1.json",
    );
    const manifestV3Path = path.join(
      repoRoot,
      "scripts/modules/skill-sys/architecture-boundaries.v3.json",
    );
    expect(fs.existsSync(manifestV5Path)).toBe(true);
    expect(fs.existsSync(manifestV4Path)).toBe(false);
    expect(fs.existsSync(manifestV3Path)).toBe(false);
    expect(fs.existsSync(manifestV2Path)).toBe(false);
    expect(fs.existsSync(manifestV1Path)).toBe(false);
    expect(JSON.parse(fs.readFileSync(manifestV5Path, "utf8")).schemaVersion).toBe(5);
  });

  test("legacy skills inventory command exposes help without requiring a skills directory", () => {
    expect(inventoryCommand.parseArgs(["bun", "generate-skills-inventory.ts", "--help"])).toEqual({
      help: true,
      includeInternal: false,
      includeExperimental: false,
    });
    expect(() => inventoryCommand.parseArgs(["bun", "generate-skills-inventory.ts", "--bad"])).toThrow("Unknown option");
  });

  test("default test script covers every standard test file", () => {
    const standardTestFiles = fs
      .readdirSync(path.join(repoRoot, "tests"))
      .filter((fileName) => fileName.endsWith(".test.ts") && fileName !== "schema-contract.test.ts")
      .sort();

    for (const fileName of standardTestFiles) {
      expect(packageJson.scripts.test).toContain(`tests/${fileName}`);
    }
  });

  test("all workflow actions are pinned to immutable SHAs", () => {
    const workflowDir = path.join(repoRoot, ".github/workflows");
    const workflowFiles = fs.readdirSync(workflowDir).filter((fileName) => fileName.endsWith(".yml"));

    for (const workflowFile of workflowFiles) {
      const workflow = readRepoFile(`.github/workflows/${workflowFile}`);
      const usesEntries = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]!);
      for (const usesEntry of usesEntries) {
        if (usesEntry.startsWith("./")) {
          continue;
        }
        expect(usesEntry, `${workflowFile}: ${usesEntry}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  test("workflow runs the shared ci:checks script", () => {
    const workflow = readRepoFile(".github/workflows/universall-skill-sys-ci.yml");

    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).toContain("run: bun run ci:checks");
    expect(workflow).not.toContain("run: bun run validate\n");
  });

  test("issue templates exist for bugs and skillpack submissions", () => {
    for (const templatePath of [
      ".github/ISSUE_TEMPLATE/bug_report.md",
      ".github/ISSUE_TEMPLATE/skillpack_submission.md",
    ]) {
      const content = readRepoFile(templatePath);
      expect(content).toContain("---");
      expect(content).toContain("labels:");
      expect(content.toLowerCase()).toContain("secret");
      expect(content.length).toBeGreaterThan(200);
    }
  });

  test("publish metadata is safe until explicit publication approval", () => {
    expect(packageJson.private).toBe(true);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.publishConfig).toEqual({
      registry: "https://registry.npmjs.org/",
      tag: "next",
    });
    expect(packageJson.publishConfig?.access).toBeUndefined();
    expect(packageJson.scripts["prepublishOnly"]).toBe("bun run validate:publish");
    expect(packageJson.scripts["validate:publish"]).toContain("bun run validate:release");
    expect(packageJson.scripts["validate:publish"]).toContain("bun run registry:check");
    expect(packageJson.scripts["validate:publish"]).toContain("bun run npm-pack-audit");
  });

  test("package metadata is prepared for prerelease without enabling publication", () => {
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/evandro-miguel/skills-manager.git",
    });
    expect(packageJson.homepage).toBe("https://github.com/evandro-miguel/skills-manager#readme");
    expect(packageJson.bugs).toEqual({
      url: "https://github.com/evandro-miguel/skills-manager/issues",
    });
    expect(packageJson.engines).toEqual({
      bun: ">=1.3.14",
      node: ">=20",
    });
    expect(packageJson.keywords).toEqual([
      "ai-agents",
      "skills",
      "skillpack",
      "skill-sys",
      "codex",
      "opencode",
      "gemini-cli",
      "qwen",
      "antigravity",
    ]);
    expect(packageJson.name).toBe("universall-skill-sys");
    expect(packageJson.private).toBe(true);
    expect(packageJson.license).toBe("MIT");
  });

  test("publish projection gate exercises the public skillpack fixture", () => {
    expect(packageJson.scripts["build-projections"]).toContain("--source examples/minimal-skillpack");
    expect(packageJson.scripts["build-projections"]).toContain("dist/projection-smoke");
    expect(packageJson.scripts["build-projections"]).toContain(
      "--projection-store-dir .tmp/projection-store"
    );
    expect(packageJson.scripts["validate-projections"]).toContain("--source examples/minimal-skillpack");
    for (const provider of ["codex", "opencode"]) {
      const capability = JSON.parse(readRepoFile(`examples/minimal-skillpack/providers/${provider}.json`));
      expect(capability.provider).toBe(provider);
    }
  });

  test("security analysis workflows exist and publish workflow uses OIDC without npm token secrets", () => {
    const codeqlWorkflow = readRepoFile(".github/workflows/codeql.yml");
    const scorecardWorkflow = readRepoFile(".github/workflows/scorecard.yml");
    const publishWorkflow = readRepoFile(".github/workflows/release-publish.yml");
    const allWorkflows = [codeqlWorkflow, scorecardWorkflow, publishWorkflow].join("\n---\n");

    expect(codeqlWorkflow).toContain("github/codeql-action/init");
    expect(codeqlWorkflow).toContain("github/codeql-action/analyze");
    expect(scorecardWorkflow).toContain("ossf/scorecard-action");
    expect(scorecardWorkflow).toContain("security-events: write");
    expect(publishWorkflow).toContain("id-token: write");
    expect(publishWorkflow).toContain("npm publish --provenance");
    expect(publishWorkflow).toContain("workflow_dispatch:");
    expect(publishWorkflow).toContain("publish_npm:");
    expect(publishWorkflow).toContain("environment:");
    expect(publishWorkflow).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(publishWorkflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(publishWorkflow).toContain("github.event.inputs.publish_npm == 'true'");
    expect(publishWorkflow).not.toContain("github.event_name == 'push' ||");
    expect(publishWorkflow).toContain("bun run validate:publish");
    expect(publishWorkflow).toContain("bun scripts/commands/skill-sys.ts guard-repo-visibility");
    expect(publishWorkflow).not.toContain("--allow-public-after-explicit-user-approval");
    expect(allWorkflows).not.toContain("NPM_TOKEN");
    expect(allWorkflows).not.toContain("NODE_AUTH_TOKEN");
    expect(allWorkflows).not.toContain("secrets.npm");
    expect(allWorkflows).not.toContain("secrets.NPM");
  });
});
