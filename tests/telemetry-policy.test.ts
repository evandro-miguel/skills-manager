import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyTelemetryCollection,
  normalizeTelemetryPolicyArgs,
  renderTelemetryPolicyResult,
  runTelemetryPolicy,
} from "../scripts/modules/skillpool/telemetry-policy.ts";

const telemetryPolicyCommand = require("../scripts/commands/telemetry-policy.ts") as typeof import("../scripts/commands/telemetry-policy.ts");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const repoRoot = path.resolve(__dirname, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-policy-"));
  tempRoots.push(root);
  return root;
}

function writePolicy(root: string, value: unknown, relativePath = ".skill-sys/telemetry-policy.json"): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function basePolicy(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "local-telemetry-policy",
    visibility: "private",
    packageSurface: false,
    collection: { enabled: false, explicitOptIn: false, approvedBy: "" },
    transports: { remoteUrls: [], localOnly: true },
    allowedSkills: ["registry-trust"],
    ...extra,
  };
}

describe("telemetry policy — normalizeTelemetryPolicyArgs", () => {
  test("rejects missing source or config", () => {
    expect(() => normalizeTelemetryPolicyArgs({ config: "/tmp/policy.json" })).toThrow("Missing --source");
    expect(() => normalizeTelemetryPolicyArgs({ source: "/tmp/source" })).toThrow("Missing --config");
  });

  test("rejects symlinked configs and accepts strict", () => {
    const root = makeTempRoot();
    const config = writePolicy(root, basePolicy());
    const link = path.join(root, ".skill-sys", "link.json");
    fs.symlinkSync(config, link);

    expect(() => normalizeTelemetryPolicyArgs({ source: root, config: link })).toThrow("must not be a symlink");
    expect(normalizeTelemetryPolicyArgs({ source: root, config, strict: true }).strict).toBe(true);
  });
});

describe("telemetry policy — CLI wiring", () => {
  test("parseArgs normalizes config and skill-sys dispatch routes to command", () => {
    const root = makeTempRoot();
    const config = writePolicy(root, basePolicy());

    const args = telemetryPolicyCommand.parseArgs(["bun", "telemetry-policy", "--source", root, "--config", config, "--json", "--strict"]);
    expect(args.source).toBe(root);
    expect(args.config).toBe(config);
    expect(args.json).toBe(true);
    expect(args.strict).toBe(true);

    const plan = skillSys.buildCommand(skillSys.parseCli(["bun", "skill-sys", "telemetry-policy", "--source", root, "--config", config, "--json", "--strict"]));
    expect(plan.argv).toEqual(["bun", path.join(repoRoot, "scripts", "commands", "telemetry-policy.ts"), "--source", root, "--config", config, "--json", "--strict"]);
  });
});

describe("telemetry policy — runTelemetryPolicy", () => {
  test("passes disabled local private policy", () => {
    const root = makeTempRoot();
    const config = writePolicy(root, basePolicy());
    const result = runTelemetryPolicy(normalizeTelemetryPolicyArgs({ source: root, config }));

    expect(result.status).toBe("PASS");
    expect(result.policyName).toBe("local-telemetry-policy");
    expect(result.collection.enabled).toBe(false);
    expect(result.findings).toEqual([]);
  });

  test("warning-only policies produce concerns and strict promotes to blocked", () => {
    const root = makeTempRoot();
    const config = writePolicy(root, basePolicy({ allowedSkills: [] }));

    const loose = runTelemetryPolicy(normalizeTelemetryPolicyArgs({ source: root, config }));
    const strict = runTelemetryPolicy(normalizeTelemetryPolicyArgs({ source: root, config, strict: true }));

    expect(loose.status).toBe("CONCERNS");
    expect(loose.findings[0]?.code).toBe("TELEMETRY_POLICY_NO_ALLOWED_SKILLS");
    expect(strict.status).toBe("BLOCKED");
  });

  test("blocks telemetry without explicit opt-in and remote transports", () => {
    const root = makeTempRoot();
    const config = writePolicy(root, basePolicy({
      collection: { enabled: true, explicitOptIn: false, approvedBy: "" },
      transports: { remoteUrls: ["https://telemetry.invalid/collect"], localOnly: false },
    }));
    const result = runTelemetryPolicy(normalizeTelemetryPolicyArgs({ source: root, config }));

    expect(result.status).toBe("BLOCKED");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "TELEMETRY_POLICY_ENABLED_WITHOUT_APPROVER",
      "TELEMETRY_POLICY_ENABLED_WITHOUT_OPT_IN",
      "TELEMETRY_POLICY_LOCAL_ONLY_REQUIRED",
      "TELEMETRY_POLICY_REMOTE_URLS_FORBIDDEN",
    ]);
  });

  test("blocks public/package-surface policies and unsafe config paths", () => {
    const root = makeTempRoot();
    const config = writePolicy(root, basePolicy({ visibility: "public", packageSurface: true }), "policy.json");
    const result = runTelemetryPolicy(normalizeTelemetryPolicyArgs({ source: root, config }));

    expect(result.status).toBe("BLOCKED");
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "TELEMETRY_POLICY_CONFIG_PATH_UNSAFE",
      "TELEMETRY_POLICY_PACKAGE_SURFACE_FORBIDDEN",
      "TELEMETRY_POLICY_PUBLIC_FORBIDDEN",
    ]);
  });

  test("rejects secret-looking config text", () => {
    const root = makeTempRoot();
    const secretLookingConfig = ["api", "_key", "=", ["abcdef", "1234567890"].join("")].join("");
    const config = writePolicy(root, basePolicy({ approvedSecret: secretLookingConfig }));
    const result = runTelemetryPolicy(normalizeTelemetryPolicyArgs({ source: root, config }));

    expect(result.status).toBe("BLOCKED");
    expect(result.findings.map((finding) => finding.code)).toContain("TELEMETRY_POLICY_SENSITIVE_TEXT");
  });

  test("renders stable JSON and text output", () => {
    const root = makeTempRoot();
    const config = writePolicy(root, basePolicy());
    const result = runTelemetryPolicy(normalizeTelemetryPolicyArgs({ source: root, config }));

    expect(JSON.parse(renderTelemetryPolicyResult(result, "json"))).toEqual(result);
    expect(renderTelemetryPolicyResult(result, "text")).toContain("STATUS: PASS");
  });
});

describe("telemetry policy — explicit collection", () => {
  test("does not create output while collection is disabled", () => {
    const root = makeTempRoot();
    const config = writePolicy(root, basePolicy());
    const output = path.join(root, ".skill-sys", "telemetry", "events.jsonl");

    const result = applyTelemetryCollection(normalizeTelemetryPolicyArgs({ source: root, config }), { event: "command-run", skill: "registry-trust" }, output);

    expect(result.status).toBe("blocked");
    expect(result.findings.map((finding) => finding.code)).toEqual(["TELEMETRY_COLLECTION_DISABLED"]);
    expect(fs.existsSync(output)).toBe(false);
  });

  test("requires explicit enabled opt-in and approver before a deterministic local write", () => {
    const root = makeTempRoot();
    const config = writePolicy(root, basePolicy({ collection: { enabled: true, explicitOptIn: true, approvedBy: "owner" } }));
    const output = path.join(root, ".skill-sys", "telemetry", "events.jsonl");
    const input = normalizeTelemetryPolicyArgs({ source: root, config });

    const dryRun = applyTelemetryCollection(input, { event: "command-run", skill: "registry-trust" }, output, { dryRun: true });
    expect(dryRun.status).toBe("dry-run");
    expect(dryRun.output).toBe('{"schemaVersion":1,"event":"command-run","skill":"registry-trust","approvedBy":"owner"}\n');
    expect(fs.existsSync(output)).toBe(false);

    const written = applyTelemetryCollection(input, { event: "command-run", skill: "registry-trust" }, output);
    expect(written.status).toBe("written");
    expect(fs.readFileSync(output, "utf8")).toBe(dryRun.output);
  });

  test("rejects unapproved skills and unsafe output paths without writing", () => {
    const root = makeTempRoot();
    const config = writePolicy(root, basePolicy({ collection: { enabled: true, explicitOptIn: true, approvedBy: "owner" } }));
    const result = applyTelemetryCollection(normalizeTelemetryPolicyArgs({ source: root, config }), { event: "command-run", skill: "not-approved" }, path.join(root, "events.jsonl"));

    expect(result.status).toBe("blocked");
    expect(result.findings.map((finding) => finding.code)).toEqual(["TELEMETRY_COLLECTION_SKILL_NOT_ALLOWED"]);
    expect(fs.existsSync(path.join(root, "events.jsonl"))).toBe(false);
  });
});
