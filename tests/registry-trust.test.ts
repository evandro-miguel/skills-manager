import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  normalizeRegistryTrustArgs,
  renderRegistryTrustResult,
  runRegistryTrust,
} from "../scripts/modules/skillpool/registry-trust.ts";

const registryTrustCommand = require("../scripts/commands/registry-trust.ts") as typeof import("../scripts/commands/registry-trust.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const repoRoot = path.resolve(__dirname, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-trust-"));
  tempRoots.push(root);
  return root;
}

function writeScorecard(root: string, value: unknown): string {
  const scorecardPath = path.join(root, "scorecard.json");
  fs.writeFileSync(scorecardPath, `${JSON.stringify(value, null, 2)}\n`);
  return scorecardPath;
}

function baseScorecard(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "release-trust",
    thresholds: { minScore: 80 },
    signals: [
      { id: "signed-ref", category: "signed-ref", status: "pass", weight: 20, evidence: "release policy requires signed tags" },
      { id: "digest-pins", category: "digest", status: "pass", weight: 20, evidence: "registry validates sha256 pins" },
      { id: "security-scan", category: "scan", status: "pass", weight: 20, evidence: "scan-security PASS" },
      { id: "sandbox", category: "sandbox", status: "pass", weight: 15, evidence: "verify-sandbox PASS" },
      { id: "evals", category: "eval", status: "pass", weight: 15, evidence: "value-gate PASS" },
      { id: "docs", category: "docs", status: "pass", weight: 10, evidence: "docs-check PASS" },
    ],
    ...extra,
  };
}

describe("registry trust — normalizeRegistryTrustArgs", () => {
  test("rejects missing source or scorecard", () => {
    expect(() => normalizeRegistryTrustArgs({ scorecard: "/tmp/scorecard.json" })).toThrow("Missing --source");
    expect(() => normalizeRegistryTrustArgs({ source: "/tmp/source" })).toThrow("Missing --scorecard");
  });

  test("rejects symlinked scorecards and accepts strict", () => {
    const root = makeTempRoot();
    const scorecard = writeScorecard(root, baseScorecard());
    const link = path.join(root, "link.json");
    fs.symlinkSync(scorecard, link);

    expect(() => normalizeRegistryTrustArgs({ source: repoRoot, scorecard: link })).toThrow("must not be a symlink");
    expect(normalizeRegistryTrustArgs({ source: repoRoot, scorecard, strict: true }).strict).toBe(true);
  });

  test("rejects missing, non-directory, nonexistent, and non-file paths", () => {
    const root = makeTempRoot();
    const scorecard = writeScorecard(root, baseScorecard());
    const sourceFile = path.join(root, "source.txt");
    fs.writeFileSync(sourceFile, "not a directory\n");

    expect(() =>
      normalizeRegistryTrustArgs({
        source: path.join(root, "missing-source"),
        scorecard,
      })
    ).toThrow("--source does not exist");
    expect(() =>
      normalizeRegistryTrustArgs({ source: sourceFile, scorecard })
    ).toThrow("--source must be a directory");
    expect(() =>
      normalizeRegistryTrustArgs({
        source: repoRoot,
        scorecard: path.join(root, "missing-scorecard.json"),
      })
    ).toThrow("--scorecard does not exist");
    expect(() =>
      normalizeRegistryTrustArgs({ source: repoRoot, scorecard: root })
    ).toThrow("--scorecard must be a file");
  });
});

describe("registry trust — CLI wiring", () => {
  test("parseArgs normalizes scorecard and skill-sys dispatch routes to command", () => {
    const root = makeTempRoot();
    const scorecard = writeScorecard(root, baseScorecard());

    const args = registryTrustCommand.parseArgs(["bun", "registry-trust", "--source", repoRoot, "--scorecard", scorecard, "--json", "--strict"]);
    expect(args.source).toBe(repoRoot);
    expect(args.scorecard).toBe(scorecard);
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);

    const plan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "registry-trust", "--source", repoRoot, "--scorecard", scorecard, "--json", "--strict"]));
    expect(plan.argv).toEqual(["bun", path.join(repoRoot, "scripts", "commands", "registry-trust.ts"), "--source", repoRoot, "--scorecard", scorecard, "--json", "--strict"]);
  });
});

describe("registry trust — runRegistryTrust", () => {
  test("passes when validated registry surface and local scorecard clear thresholds", () => {
    const root = makeTempRoot();
    const scorecard = writeScorecard(root, baseScorecard());

    const result = runRegistryTrust(normalizeRegistryTrustArgs({ source: repoRoot, scorecard }));

    expect(result.status).toBe("PASS");
    expect(result.score).toBe(100);
    expect(result.scorecardName).toBe("release-trust");
    expect(result.registrySurface.status).toBe("PASS");
    expect(result.findings).toEqual([]);
  });

  test("reports concerns for warning signals and strict promotes warnings to blocked", () => {
    const root = makeTempRoot();
    const scorecard = writeScorecard(root, baseScorecard({
      signals: [{ id: "docs", category: "docs", status: "warn", weight: 100, evidence: "docs incomplete" }],
      thresholds: { minScore: 40 },
    }));

    const loose = runRegistryTrust(normalizeRegistryTrustArgs({ source: repoRoot, scorecard }));
    const strict = runRegistryTrust(normalizeRegistryTrustArgs({ source: repoRoot, scorecard, strict: true }));

    expect(loose.status).toBe("CONCERNS");
    expect(loose.score).toBe(50);
    expect(loose.findings[0]?.code).toBe("REGISTRY_TRUST_SIGNAL_WARNING");
    expect(strict.status).toBe("BLOCKED");
  });

  test("blocks failed signals and scores below threshold", () => {
    const root = makeTempRoot();
    const scorecard = writeScorecard(root, baseScorecard({
      signals: [{ id: "security-scan", category: "scan", status: "fail", weight: 100, evidence: "scan failed" }],
      thresholds: { minScore: 80 },
    }));

    const result = runRegistryTrust(normalizeRegistryTrustArgs({ source: repoRoot, scorecard }));

    expect(result.status).toBe("BLOCKED");
    expect(result.score).toBe(0);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "REGISTRY_TRUST_SCORE_BELOW_THRESHOLD",
      "REGISTRY_TRUST_SIGNAL_FAILED",
    ]);
  });

  test("fails closed when the registry surface is missing", () => {
    const root = makeTempRoot();
    const scorecard = writeScorecard(root, baseScorecard());
    expect(() => runRegistryTrust(normalizeRegistryTrustArgs({ source: root, scorecard }))).toThrow("Missing registry surface file");
  });

  test("rejects invalid JSON and every governed scorecard field class", () => {
    const cases: Array<Readonly<{
      value: unknown;
      message: string;
    }>> = [
      { value: "{", message: "JSON Parse error" },
      {
        value: { ...baseScorecard(), schemaVersion: 2 },
        message: "schemaVersion must be 1",
      },
      {
        value: { ...baseScorecard(), name: "Unsafe Name" },
        message: "name must be a safe identifier",
      },
      {
        value: { ...baseScorecard(), thresholds: {} },
        message: "thresholds.minScore must be an integer",
      },
      {
        value: { ...baseScorecard(), signals: [] },
        message: "signals must be a non-empty array",
      },
      {
        value: { ...baseScorecard(), signals: ["not-an-object"] },
        message: "signals[0] must be an object",
      },
      {
        value: {
          ...baseScorecard(),
          signals: [
            {
              id: "Unsafe Id",
              category: "docs",
              status: "pass",
              weight: 1,
              evidence: "synthetic",
            },
          ],
        },
        message: "signals[0].id must be a safe identifier",
      },
      {
        value: {
          ...baseScorecard(),
          signals: [
            {
              id: "docs",
              category: "unknown",
              status: "pass",
              weight: 1,
              evidence: "synthetic",
            },
          ],
        },
        message: "signals[0].category is invalid",
      },
      {
        value: {
          ...baseScorecard(),
          signals: [
            {
              id: "docs",
              category: "docs",
              status: "unknown",
              weight: 1,
              evidence: "synthetic",
            },
          ],
        },
        message: "signals[0].status is invalid",
      },
      {
        value: {
          ...baseScorecard(),
          signals: [
            {
              id: "docs",
              category: "docs",
              status: "pass",
              weight: 101,
              evidence: "synthetic",
            },
          ],
        },
        message: "signals[0].weight must be an integer",
      },
      {
        value: {
          ...baseScorecard(),
          signals: [
            {
              id: "docs",
              category: "docs",
              status: "pass",
              weight: 1,
              evidence: " ",
            },
          ],
        },
        message: "signals[0].evidence must be a non-empty string",
      },
    ];

    for (const [index, current] of cases.entries()) {
      const root = makeTempRoot();
      const scorecard = path.join(root, `invalid-${index}.json`);
      fs.writeFileSync(
        scorecard,
        typeof current.value === "string"
          ? current.value
          : JSON.stringify(current.value),
      );
      expect(() =>
        runRegistryTrust(
          normalizeRegistryTrustArgs({ source: repoRoot, scorecard }),
        )
      ).toThrow(current.message);
    }
  });

  test("rounds weighted fractional scores to the nearest integer", () => {
    const root = makeTempRoot();
    const scorecard = writeScorecard(root, baseScorecard({
      thresholds: { minScore: 0 },
      signals: [
        {
          id: "docs",
          category: "docs",
          status: "warn",
          weight: 1,
          evidence: "synthetic warning",
        },
        {
          id: "scan",
          category: "scan",
          status: "fail",
          weight: 2,
          evidence: "synthetic failure",
        },
      ],
    }));

    const result = runRegistryTrust(
      normalizeRegistryTrustArgs({ source: repoRoot, scorecard }),
    );
    expect(result.score).toBe(17);
    expect(result.status).toBe("BLOCKED");
  });

  test("renders stable JSON and text output", () => {
    const root = makeTempRoot();
    const scorecard = writeScorecard(root, baseScorecard());
    const result = runRegistryTrust(normalizeRegistryTrustArgs({ source: repoRoot, scorecard }));

    expect(JSON.parse(renderRegistryTrustResult(result, "json"))).toEqual(result);
    expect(renderRegistryTrustResult(result, "text")).toContain("STATUS: PASS");
  });

  test("preserves observed scorecard schema drift and zero-weight scoring", () => {
    const root = makeTempRoot();
    const scorecard = writeScorecard(root, {
      schemaVersion: 1,
      name: " release-trust ",
      thresholds: { minScore: 0, ignored: true },
      signals: [
        {
          id: " docs ",
          category: "docs",
          status: "pass",
          weight: 0,
          evidence: " synthetic evidence ",
          ignored: true,
        },
      ],
      ignored: true,
    });

    const result = runRegistryTrust(
      normalizeRegistryTrustArgs({ source: repoRoot, scorecard }),
    );

    expect(result.status).toBe("PASS");
    expect(result.score).toBe(0);
    expect(result.scorecardName).toBe("release-trust");
    expect(result.signals).toEqual([
      {
        id: "docs",
        category: "docs",
        status: "pass",
        weight: 0,
        evidence: "synthetic evidence",
      },
    ]);
    expect(result).not.toHaveProperty("ignored");
    expect(result.signals[0]).not.toHaveProperty("ignored");
  });

  test("accepts duplicate signal ids as an observed legacy behavior", () => {
    const root = makeTempRoot();
    const scorecard = writeScorecard(root, baseScorecard({
      thresholds: { minScore: 0 },
      signals: [
        {
          id: "docs",
          category: "docs",
          status: "pass",
          weight: 1,
          evidence: "first synthetic observation",
        },
        {
          id: "docs",
          category: "docs",
          status: "pass",
          weight: 1,
          evidence: "second synthetic observation",
        },
      ],
    }));

    const result = runRegistryTrust(
      normalizeRegistryTrustArgs({ source: repoRoot, scorecard }),
    );
    expect(result.status).toBe("PASS");
    expect(result.signals.map((signal) => signal.id)).toEqual([
      "docs",
      "docs",
    ]);
  });
});
