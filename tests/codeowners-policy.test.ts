import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const codeowners = fs.readFileSync(path.join(repoRoot, ".github/CODEOWNERS"), "utf8");
const maintainer = "@evandro-miguel";

const requiredPatterns = [
  ".github/workflows/**",
  "scripts/modules/skillpool/**",
  "scripts/modules/skill-sys/**",
  "scripts/commands/release-*.ts",
  "scripts/commands/verify-origin.ts",
  "scripts/commands/validate-registry-surface.ts",
  "artifact-surfaces/**",
  "schema/**",
  "providers/**",
  "registry/**",
  "package.json",
  "privacy-*.json",
  "SECURITY.md",
  "CONTRIBUTING.md",
];

describe("CODEOWNERS governance policy", () => {
  test("governance and release surfaces require explicit ownership", () => {
    for (const pattern of requiredPatterns) {
      expect(codeowners).toContain(`${pattern} ${maintainer}`);
    }
  });

  test("catch-all owner remains present for non-governance files", () => {
    expect(codeowners).toContain(`* ${maintainer}`);
  });

  test("the canonical .github file is the only CODEOWNERS source", () => {
    expect(fs.existsSync(path.join(repoRoot, "CODEOWNERS"))).toBe(false);
  });
});
