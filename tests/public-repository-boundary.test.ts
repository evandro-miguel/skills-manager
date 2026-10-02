import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const audit = require("../scripts/commands/public-repository-audit.ts") as typeof import("../scripts/commands/public-repository-audit.ts");
const packageJson = require("../package.json") as { files: string[]; scripts: Record<string, string> };

const repoRoot = path.resolve(__dirname, "..");

function makeFixtureRoot(prefix: string): string {
  const scratchRoot = path.join(repoRoot, ".tmp");
  fs.mkdirSync(scratchRoot, { recursive: true });
  return fs.mkdtempSync(path.join(scratchRoot, prefix));
}

function runGit(cwd: string, args: string[], envOverrides: Record<string, string> = {}): void {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  Object.assign(env, envOverrides);
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

function runGitOutput(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function auditFreshHistoryFixture(prefix: string, files: Record<string, string>) {
  const tempRoot = makeFixtureRoot(prefix);
  const source = path.join(tempRoot, "source");
  try {
    fs.mkdirSync(path.join(source, "skills", "skill-sys"), { recursive: true });
    fs.writeFileSync(path.join(source, "skills", "skill-sys", "SKILL.md"), "# Fixture skill\n");
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(source, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    runGit(source, ["init"]);
    runGit(source, ["config", "user.email", "fixture@example.invalid"]);
    runGit(source, ["config", "user.name", "Fixture User"]);
    runGit(source, ["add", "."]);
    runGit(source, ["commit", "-m", "fresh audit fixture"]);
    return audit.runPublicRepositoryAudit(source);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

type MetadataHistoryFixture = {
  commitAuthorEmail?: string;
  commitCommitterEmail?: string;
  commitMessage?: string;
  taggerEmail?: string;
  tagMessage?: string;
};

function auditMetadataHistoryFixture(prefix: string, metadata: MetadataHistoryFixture) {
  const tempRoot = makeFixtureRoot(prefix);
  const source = path.join(tempRoot, "source");
  try {
    fs.mkdirSync(path.join(source, "skills", "skill-sys"), { recursive: true });
    fs.writeFileSync(path.join(source, "skills", "skill-sys", "SKILL.md"), "# Fixture skill\n");
    runGit(source, ["init"]);
    runGit(source, ["config", "user.email", "fixture@example.invalid"]);
    runGit(source, ["config", "user.name", "Fixture User"]);
    runGit(source, ["add", "."]);
    runGit(source, ["commit", "-m", metadata.commitMessage ?? "clean fixture"], {
      ...(metadata.commitAuthorEmail ? { GIT_AUTHOR_EMAIL: metadata.commitAuthorEmail } : {}),
      ...(metadata.commitCommitterEmail ? { GIT_COMMITTER_EMAIL: metadata.commitCommitterEmail } : {}),
    });
    if (metadata.taggerEmail || metadata.tagMessage) {
      runGit(source, ["tag", "-a", "fixture-tag", "-m", metadata.tagMessage ?? "clean tag"], {
        ...(metadata.taggerEmail ? { GIT_COMMITTER_EMAIL: metadata.taggerEmail } : {}),
      });
    }
    return audit.runPublicRepositoryAudit(source);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function auditNestedTagMetadataFixture(prefix: string, taggerEmail: string) {
  const tempRoot = makeFixtureRoot(prefix);
  const source = path.join(tempRoot, "source");
  try {
    fs.mkdirSync(path.join(source, "skills", "skill-sys"), { recursive: true });
    fs.writeFileSync(path.join(source, "skills", "skill-sys", "SKILL.md"), "# Fixture skill\n");
    runGit(source, ["init"]);
    runGit(source, ["config", "user.email", "fixture@example.invalid"]);
    runGit(source, ["config", "user.name", "Fixture User"]);
    runGit(source, ["add", "."]);
    runGit(source, ["commit", "-m", "clean fixture"]);

    const commitId = runGitOutput(source, ["rev-parse", "HEAD"]).trim();
    const innerTagId = runGitOutput(source, ["mktag"], [
      `object ${commitId}`,
      "type commit",
      "tag fixture-inner",
      `tagger Fixture User <${taggerEmail}> 0 +0000`,
      "",
      "inner tag fixture",
      "",
    ].join("\n")).trim();
    const outerTagId = runGitOutput(source, ["mktag"], [
      `object ${innerTagId}`,
      "type tag",
      "tag fixture-outer",
      "tagger Fixture User <fixture@example.invalid> 0 +0000",
      "",
      "outer tag fixture",
      "",
    ].join("\n")).trim();
    runGit(source, ["update-ref", "refs/tags/fixture-outer", outerTagId]);

    return audit.runPublicRepositoryAudit(source);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("public repository boundary", () => {
  test("allows only the selected public agent skill under .agents", () => {
    const result = audit.auditTrackedFiles([
      "skills/skill-sys/SKILL.md",
      "README.md",
      "scripts/bin/skill-sys",
    ]);

    expect(result).toEqual({
      status: "PASS",
      trackedFileCount: 3,
      forbiddenTrackedPaths: [],
      forbiddenHistoricalPathCount: 0,
      forbiddenHistoricalClasses: [],
      historicalContentFindingCount: 0,
      historicalContentClasses: [],
      missingRequiredPaths: [],
      remediation: null,
    });
  });

  test("treats the skills directory and public skill-sys tree as allowed", () => {
    expect(audit.isForbiddenPublicRepositoryPath("skills")).toBe(false);
    expect(audit.isForbiddenPublicRepositoryPath("skills/skill-sys/SKILL.md")).toBe(false);
    expect(audit.isForbiddenPublicRepositoryPath("skills/other/SKILL.md")).toBe(true);
  });

  test("blocks AFOL, agent harness files, and non-selected local skills", () => {
    const result = audit.auditTrackedFiles([
      ".agents/skills/afol-rules/SKILL.md",
      "skills/skill-sys/SKILL.md",
      ".agents/lock.json",
      ".afol/config.json",
      "AGENTS.md",
      "docs/plans/implementation.md",
      "docs/templates/architecture.md",
    ]);

    expect(result.status).toBe("BLOCKING");
    expect(result.forbiddenTrackedPaths).toEqual([
      ".afol/config.json",
      ".agents/lock.json",
      ".agents/skills/afol-rules/SKILL.md",
      "AGENTS.md",
      "docs/plans/implementation.md",
      "docs/templates/architecture.md",
    ]);
    expect(result.forbiddenHistoricalPathCount).toBe(0);
    expect(result.remediation).toBeNull();
  });

  test("blocks a repository that omits the public skill", () => {
    const result = audit.auditTrackedFiles(["README.md"]);
    expect(result.status).toBe("BLOCKING");
    expect(result.missingRequiredPaths).toEqual(["skills/skill-sys/SKILL.md"]);
  });

  test("blocks local agentic paths that remain reachable only through Git history", () => {
    const result = audit.auditTrackedFiles(
      ["skills/skill-sys/SKILL.md"],
      [".afol/config.json", "AGENTS.md", "docs/plans/implementation.md"],
    );
    expect(result.status).toBe("BLOCKING");
    expect(result.forbiddenTrackedPaths).toEqual([]);
    expect(result.forbiddenHistoricalPathCount).toBe(3);
    expect(result.forbiddenHistoricalClasses).toEqual([
      { root: ".afol", count: 1, samples: [".afol/config.json"] },
      { root: "AGENTS.md", count: 1, samples: ["AGENTS.md"] },
      { root: "docs/plans", count: 1, samples: ["docs/plans/implementation.md"] },
    ]);
    expect(result.remediation).toBe(audit.HISTORY_REMEDIATION);
  });

  test("does not recount currently tracked forbidden paths as history-only leaks", () => {
    const result = audit.auditTrackedFiles(
      ["skills/skill-sys/SKILL.md", "AGENTS.md"],
      ["AGENTS.md", ".afol/config.json"],
    );
    expect(result.forbiddenTrackedPaths).toEqual(["AGENTS.md"]);
    expect(result.forbiddenHistoricalPathCount).toBe(1);
    expect(result.forbiddenHistoricalClasses).toEqual([
      { root: ".afol", count: 1, samples: [".afol/config.json"] },
    ]);
  });

  test("bounds historical output to class counts and a small sample", () => {
    const historicalPaths = [
      "AGENTS.md",
      ...Array.from({ length: 40 }, (_, index) => `.afol/data/item-${String(index).padStart(2, "0")}.json`),
    ];
    const result = audit.auditTrackedFiles(["skills/skill-sys/SKILL.md"], historicalPaths);
    const rendered = audit.renderPublicRepositoryAudit(result);

    expect(result.forbiddenHistoricalPathCount).toBe(41);
    expect(result.forbiddenHistoricalClasses).toEqual([
      {
        root: ".afol",
        count: 40,
        samples: [".afol/data/item-00.json", ".afol/data/item-01.json", ".afol/data/item-02.json"],
      },
      { root: "AGENTS.md", count: 1, samples: ["AGENTS.md"] },
    ]);
    expect(rendered.filter((line) => line.startsWith("HISTORICAL-CLASS:")).length).toBe(2);
    expect(rendered.some((line) => line.includes("item-39.json"))).toBe(false);
    expect(rendered).toContain(`REMEDIATION: ${audit.HISTORY_REMEDIATION}`);
  });

  test("blocks a secret in an old blob at an otherwise allowed path", () => {
    const tempRoot = makeFixtureRoot("public-repository-audit-allowed-");
    const source = path.join(tempRoot, "source");
    const secret = ["ghp_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
    try {
      fs.mkdirSync(path.join(source, "skills", "skill-sys"), { recursive: true });
      fs.writeFileSync(path.join(source, "skills", "skill-sys", "SKILL.md"), "# Fixture skill\n");
      fs.writeFileSync(path.join(source, "README.md"), `retired token=${secret}\n`);
      runGit(source, ["init"]);
      runGit(source, ["config", "user.email", "fixture@example.invalid"]);
      runGit(source, ["config", "user.name", "Fixture User"]);
      runGit(source, ["add", "."]);
      runGit(source, ["commit", "-m", "secret fixture"]);
      fs.writeFileSync(path.join(source, "README.md"), "sanitized history\n");
      runGit(source, ["add", "."]);
      runGit(source, ["commit", "-m", "sanitize fixture"]);

      const result = audit.runPublicRepositoryAudit(source);
      const rendered = audit.renderPublicRepositoryAudit(result).join("\n");

      expect(result.status).toBe("BLOCKING");
      expect(result.forbiddenHistoricalPathCount).toBe(0);
      expect(result.historicalContentClasses).toEqual([
        { code: "SENSITIVE_SECRET", rule: "ghp_", count: 1, samples: ["README.md"] },
      ]);
      expect(rendered).toContain("HISTORICAL-CONTENT: 1 sensitive finding(s) remain reachable");
      expect(rendered).not.toContain(secret);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("blocks a privacy marker in an old blob whose path is no longer listed", () => {
    const tempRoot = makeFixtureRoot("public-repository-audit-unlisted-");
    const source = path.join(tempRoot, "source");
    const marker = ["", "home", "fixture-user", "private-workflow"].join("/");
    try {
      fs.mkdirSync(path.join(source, "skills", "skill-sys"), { recursive: true });
      fs.writeFileSync(path.join(source, "skills", "skill-sys", "SKILL.md"), "# Fixture skill\n");
      fs.writeFileSync(path.join(source, "retired.toml"), `retired marker=${marker}\n`);
      runGit(source, ["init"]);
      runGit(source, ["config", "user.email", "fixture@example.invalid"]);
      runGit(source, ["config", "user.name", "Fixture User"]);
      runGit(source, ["add", "."]);
      runGit(source, ["commit", "-m", "unlisted secret fixture"]);
      fs.rmSync(path.join(source, "retired.toml"));
      runGit(source, ["add", "."]);
      runGit(source, ["commit", "-m", "remove fixture"]);

      const result = audit.runPublicRepositoryAudit(source);

      expect(result.status).toBe("BLOCKING");
      expect(result.forbiddenHistoricalPathCount).toBe(0);
      expect(result.historicalContentClasses).toEqual([
        { code: "PRIVACY_CONTENT", rule: "LOCAL_PATH", count: 1, samples: ["retired.toml"] },
      ]);
      expect(audit.renderPublicRepositoryAudit(result).join("\n")).not.toContain(marker);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("blocks personal metadata in reachable commits and annotated tags without rendering the match", () => {
    const personalEmail = ["public-audit-fixture", ["gmail", "com"].join(".")].join("@");
    const cases = [
      { field: "commit author", context: "commit", metadata: { commitAuthorEmail: personalEmail } },
      { field: "commit committer", context: "commit", metadata: { commitCommitterEmail: personalEmail } },
      { field: "commit message", context: "commit", metadata: { commitMessage: `review ${personalEmail}` } },
      { field: "annotated tagger", context: "tag", metadata: { taggerEmail: personalEmail } },
      { field: "annotated tag message", context: "tag", metadata: { tagMessage: `release ${personalEmail}` } },
    ];

    for (const [index, item] of cases.entries()) {
      const result = auditMetadataHistoryFixture(`public-repository-audit-metadata-${index}-`, item.metadata);
      const finding = result.historicalContentClasses.find(
        (candidate) => candidate.code === "PRIVACY_CONTENT" && candidate.rule === "EMAIL_HANDLE",
      );
      const rendered = audit.renderPublicRepositoryAudit(result).join("\n");

      expect(result.status, item.field).toBe("BLOCKING");
      expect(finding?.count, item.field).toBe(1);
      expect(finding?.samples[0], item.field).toMatch(new RegExp(`^metadata/${item.context}-`));
      expect(rendered).not.toContain(personalEmail);
      expect(rendered).not.toContain("@");
    }
  });

  test("passes generic example and GitHub noreply identities in reachable metadata", () => {
    const noreplyEmail = ["123456+fixture", "users.noreply.github.com"].join("@");
    const result = auditMetadataHistoryFixture("public-repository-audit-metadata-safe-", {
      commitAuthorEmail: "fixture@example.invalid",
      commitCommitterEmail: noreplyEmail,
      commitMessage: `verified identity ${noreplyEmail}`,
      taggerEmail: noreplyEmail,
      tagMessage: `release ${noreplyEmail}`,
    });

    expect(result.status).toBe("PASS");
    expect(result.historicalContentFindingCount).toBe(0);
    expect(result.historicalContentClasses).toEqual([]);
  });

  test("blocks metadata in a nested annotated tag with no direct ref", () => {
    const personalEmail = ["nested-tag-fixture", ["gmail", "com"].join(".")].join("@");
    const result = auditNestedTagMetadataFixture("public-repository-audit-nested-tag-", personalEmail);
    const finding = result.historicalContentClasses.find(
      (candidate) => candidate.code === "PRIVACY_CONTENT" && candidate.rule === "EMAIL_HANDLE",
    );
    const rendered = audit.renderPublicRepositoryAudit(result).join("\n");

    expect(result.status).toBe("BLOCKING");
    expect(finding?.count).toBe(1);
    expect(finding?.samples[0]).toMatch(/^metadata\/tag-/);
    expect(rendered).not.toContain(personalEmail);
    expect(rendered).not.toContain("@");
  });

  test("does not report marker declarations as content leaks", () => {
    const marker = ["portfolio", "fixture", "name"].join("-");
    const policy = JSON.stringify({ markers: { personNames: [marker] } }, null, 2);
    const result = auditFreshHistoryFixture("public-repository-audit-policy-declarations-", {
      "privacy-policy.public.json": policy,
      "privacy-policy.example.json": policy,
    });

    expect(result.status).toBe("PASS");
    expect(result.historicalContentFindingCount).toBe(0);
    expect(result.historicalContentClasses).toEqual([]);
  });

  test("blocks a policy declaration blob that was also reachable under a non-policy path", () => {
    const tempRoot = makeFixtureRoot("public-repository-audit-policy-blob-alias-");
    const source = path.join(tempRoot, "source");
    const marker = ["portfolio", "fixture", "name"].join("-");
    const policy = JSON.stringify({ markers: { personNames: [marker] } }, null, 2);
    const aliasPath = path.join(source, "z-copy.json");
    try {
      fs.mkdirSync(path.join(source, "skills", "skill-sys"), { recursive: true });
      fs.writeFileSync(path.join(source, "skills", "skill-sys", "SKILL.md"), "# Fixture skill\n");
      fs.writeFileSync(path.join(source, "privacy-policy.public.json"), policy);
      fs.writeFileSync(aliasPath, policy);
      runGit(source, ["init"]);
      runGit(source, ["config", "user.email", "fixture@example.invalid"]);
      runGit(source, ["config", "user.name", "Fixture User"]);
      runGit(source, ["add", "."]);
      runGit(source, ["commit", "-m", "add policy declaration and copy"]);

      fs.rmSync(aliasPath);
      runGit(source, ["add", "--all"]);
      runGit(source, ["commit", "-m", "remove non-policy copy"]);

      const result = audit.runPublicRepositoryAudit(source);

      expect(result.status).toBe("BLOCKING");
      expect(result.historicalContentClasses).toEqual([
        { code: "PRIVACY_CONTENT", rule: "PERSON_NAME", count: 1, samples: ["z-copy.json"] },
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("fails closed when duplicate decoded keys hide an unrecognized marker object", () => {
    const marker = ["portfolio", "fixture", "name"].join("-");
    const customMarkerField = ["custom", "Terms"].join("");
    const duplicateMarkerObject = JSON.stringify({ [customMarkerField]: [marker] });
    const validMarkerObject = JSON.stringify({ personNames: [] });
    const escapedMarkersKey = ["mark", String.fromCharCode(92), "u0065", "rs"].join("");
    const policies = [
      `{"markers":${duplicateMarkerObject},"markers":${validMarkerObject}}`,
      `{"markers":${duplicateMarkerObject},"${escapedMarkersKey}":${validMarkerObject}}`,
    ];

    for (const [index, policy] of policies.entries()) {
      const result = auditFreshHistoryFixture(`public-repository-audit-policy-duplicate-${index}-`, {
        "privacy-policy.public.json": policy,
      });

      expect(result.status).toBe("BLOCKING");
      expect(result.historicalContentClasses).toEqual([
        {
          code: "PRIVACY_CONTENT",
          rule: "DUPLICATE_POLICY_KEY",
          count: 1,
          samples: ["privacy-policy.public.json"],
        },
      ]);
    }
  });

  test("still blocks the declared marker in a non-policy blob", () => {
    const marker = ["portfolio", "fixture", "name"].join("-");
    const policy = JSON.stringify({ markers: { personNames: [marker] } }, null, 2);
    const result = auditFreshHistoryFixture("public-repository-audit-policy-marker-input-", {
      "privacy-policy.public.json": policy,
      "README.md": `fixture input: ${marker}\n`,
    });

    expect(result.status).toBe("BLOCKING");
    expect(result.historicalContentClasses).toEqual([
      { code: "PRIVACY_CONTENT", rule: "PERSON_NAME", count: 1, samples: ["README.md"] },
    ]);
  });

  test("still blocks a declared marker in an unrelated policy field", () => {
    const marker = ["portfolio", "fixture", "name"].join("-");
    const policy = JSON.stringify({
      markers: { personNames: [marker] },
      reviewNote: marker,
    }, null, 2);
    const result = auditFreshHistoryFixture("public-repository-audit-policy-metadata-", {
      "privacy-policy.public.json": policy,
    });

    expect(result.status).toBe("BLOCKING");
    expect(result.historicalContentClasses).toEqual([
      {
        code: "PRIVACY_CONTENT",
        rule: "PERSON_NAME",
        count: 1,
        samples: ["privacy-policy.public.json"],
      },
    ]);
  });

  test("keeps built-in privacy scanning on complete policy declaration bytes", () => {
    const marker = ["/home", "fixture-user", "profile"].join("/");
    const policy = JSON.stringify({ markers: { localPaths: [marker] } }, null, 2);
    const result = auditFreshHistoryFixture("public-repository-audit-policy-built-in-", {
      "privacy-policy.public.json": policy,
    });

    expect(result.status).toBe("BLOCKING");
    expect(result.historicalContentClasses).toEqual([
      {
        code: "PRIVACY_CONTENT",
        rule: "LOCAL_PATH",
        count: 1,
        samples: ["privacy-policy.public.json"],
      },
    ]);
  });

  test("keeps sensitive scanning on complete policy declaration bytes", () => {
    const detectorSentinel = ["ghp_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
    const policy = JSON.stringify({ markers: { personNames: [detectorSentinel] } }, null, 2);
    const result = auditFreshHistoryFixture("public-repository-audit-policy-sensitive-", {
      "privacy-policy.public.json": policy,
    });

    expect(result.status).toBe("BLOCKING");
    expect(result.historicalContentClasses).toEqual([
      {
        code: "SENSITIVE_SECRET",
        rule: "ghp_",
        count: 1,
        samples: ["privacy-policy.public.json"],
      },
    ]);
  });

  test("fails closed when a policy declaration has an unknown schema field", () => {
    const marker = ["portfolio", "fixture", "name"].join("-");
    const policy = JSON.stringify({
      markers: { personNames: [marker] },
      unexpectedField: true,
    }, null, 2);
    const result = auditFreshHistoryFixture("public-repository-audit-policy-schema-", {
      "privacy-policy.public.json": policy,
    });

    expect(result.status).toBe("BLOCKING");
    expect(result.historicalContentClasses).toEqual([
      {
        code: "PRIVACY_CONTENT",
        rule: "PERSON_NAME",
        count: 1,
        samples: ["privacy-policy.public.json"],
      },
    ]);
  });

  test("fails closed when a privacy policy cannot be parsed", () => {
    expect(() =>
      auditFreshHistoryFixture("public-repository-audit-policy-parse-", {
        "privacy-policy.public.json": '{"markers":',
      }),
    ).toThrow();
  });

  test("reports the current checkout according to its reachable history", () => {
    const result = audit.runPublicRepositoryAudit(repoRoot);
    const rendered = audit.renderPublicRepositoryAudit(result);
    const roots = result.forbiddenHistoricalClasses.map((item) => item.root);

    expect(result.forbiddenTrackedPaths).toEqual([]);
    expect(roots).not.toContain("skills");
    expect(result.forbiddenHistoricalClasses.every((item) => item.samples.length <= audit.HISTORICAL_SAMPLE_LIMIT)).toBe(true);
    const historyHasBlockingFindings =
      result.forbiddenHistoricalPathCount > 0 || result.historicalContentFindingCount > 0;
    expect(result.status).toBe(historyHasBlockingFindings ? "BLOCKING" : "PASS");
    if (historyHasBlockingFindings) {
      expect(result.remediation).toBe(audit.HISTORY_REMEDIATION);
      expect(rendered.filter((line) => line.startsWith("HISTORICAL:")).length).toBe(
        result.forbiddenHistoricalPathCount > 0 ? 1 : 0,
      );
    } else {
      expect(result.remediation).toBeNull();
      expect(rendered.filter((line) => line.startsWith("HISTORICAL:")).length).toBe(0);
    }
  });

  test("fails closed before auditing a shallow checkout", () => {
    const tempRoot = makeFixtureRoot("public-repository-audit-");
    const source = path.join(tempRoot, "source");
    const shallow = path.join(tempRoot, "shallow");
    try {
      fs.mkdirSync(path.join(source, "skills", "skill-sys"), { recursive: true });
      fs.writeFileSync(path.join(source, "skills", "skill-sys", "SKILL.md"), "# Fixture skill\n");
      runGit(source, ["init"]);
      runGit(source, ["config", "user.email", "fixture@example.invalid"]);
      runGit(source, ["config", "user.name", "Fixture User"]);
      runGit(source, ["add", "."]);
      runGit(source, ["commit", "-m", "initial fixture"]);
      fs.writeFileSync(path.join(source, "README.md"), "fixture history\n");
      runGit(source, ["add", "."]);
      runGit(source, ["commit", "-m", "second fixture"]);
      runGit(tempRoot, ["clone", "--depth", "1", `file://${source}`, shallow]);

      expect(() => audit.runPublicRepositoryAudit(shallow)).toThrow(audit.SHALLOW_REPOSITORY_REMEDIATION);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("passes a fresh repository with clean historical content", () => {
    const tempRoot = makeFixtureRoot("public-repository-audit-fresh-");
    const source = path.join(tempRoot, "source");
    try {
      fs.mkdirSync(path.join(source, "skills", "skill-sys"), { recursive: true });
      fs.writeFileSync(path.join(source, "skills", "skill-sys", "SKILL.md"), "# Fixture skill\n");
      fs.writeFileSync(path.join(source, "settings.toml"), "enabled = true\n");
      runGit(source, ["init"]);
      runGit(source, ["config", "user.email", "fixture@example.invalid"]);
      runGit(source, ["config", "user.name", "Fixture User"]);
      runGit(source, ["add", "."]);
      runGit(source, ["commit", "-m", "fresh sanitized fixture"]);

      const result = audit.runPublicRepositoryAudit(source);

      expect(result.status).toBe("PASS");
      expect(result.historicalContentFindingCount).toBe(0);
      expect(result.historicalContentClasses).toEqual([]);
      expect(result.remediation).toBeNull();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("release validation runs the tracked repository audit", () => {
    expect(packageJson.files).toContain("skills/skill-sys/");
    expect(packageJson.scripts["validate:release"]).toContain("bun run audit:public-repository");
  });
});
