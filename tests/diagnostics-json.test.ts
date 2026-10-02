import { describe, expect, test } from "bun:test";
import path from "node:path";

const doctorAll = require("../scripts/commands/doctor-all.ts") as typeof import("../scripts/commands/doctor-all.ts");

function captureStdout(fn: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

describe("diagnostics JSON output", () => {
  test("doctor-all emits structured JSON without status prose", () => {
    const commands: string[][] = [];
    const output = captureStdout(() =>
      doctorAll.main(
        ["bun", "doctor-all.ts", "--source", ".", "--json"],
        {
          run: (command) => {
            commands.push(command);
          },
          isGitRepo: () => false,
        }
      )
    );

    const parsed = JSON.parse(output);
    expect(parsed.status).toBe("PASS");
    expect(parsed.source).toBe(path.resolve("."));
    expect(parsed.checks.map((check: { name: string }) => check.name)).toEqual([
      "contract",
      "source-validate",
      "adapter-smoke",
    ]);
    expect(parsed.checks.every((check: { status: string }) => check.status === "PASS")).toBe(true);
    expect(commands).toHaveLength(3);
    expect(output).not.toContain("STATUS: PASS");
    expect(output).not.toContain("-> Contract check");
  });
});
