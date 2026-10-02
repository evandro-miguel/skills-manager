import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  main,
  parseArgs,
  parseLcovSummary,
  parseTextCoverageSummary,
} from "../scripts/commands/coverage-gate.ts";

const tempDirs: string[] = [];

function makeTempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

function writeLcov(dir: string, body: string): string {
  const coverageDir = path.join(dir, "coverage");
  fs.mkdirSync(coverageDir, { recursive: true });
  const lcovFile = path.join(coverageDir, "lcov.info");
  fs.writeFileSync(lcovFile, body);
  return lcovFile;
}

function sampleLcov(linesFound: number, linesHit: number, funcsFound: number, funcsHit: number): string {
  return [
    "TN:",
    "SF:scripts/example.ts",
    `FNF:${funcsFound}`,
    `FNH:${funcsHit}`,
    `LF:${linesFound}`,
    `LH:${linesHit}`,
    "end_of_record",
  ].join("\n");
}

function captureMain(argv: string[]): { code: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;

  let code = 0;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  process.exit = ((exitCode?: string | number | null | undefined) => {
    code = Number(exitCode ?? 0);
    throw new Error(`process.exit:${code}`);
  }) as typeof process.exit;

  try {
    main(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.startsWith("process.exit:")) {
      throw error;
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("coverage gate command", () => {
  test("parses explicit thresholds, coverage dir, lcov file, and no-run-tests flag", () => {
    const args = parseArgs([
      "bun",
      "coverage-gate.ts",
      "--threshold-lines",
      "81.5",
      "--threshold-funcs",
      "82",
      "--coverage-dir",
      "tmp/coverage-fixture",
      "--lcov-file",
      "tmp/custom.info",
      "--no-run-tests",
    ]);

    expect(args.thresholdLines).toBe(81.5);
    expect(args.thresholdFuncs).toBe(82);
    expect(args.runTests).toBe(false);
    expect(args.coverageDir).toBe(path.resolve(process.cwd(), "tmp/coverage-fixture"));
    expect(args.lcovFile).toBe(path.resolve(process.cwd(), "tmp/custom.info"));
  });

  test("rejects unknown options, missing values, and invalid percentages", () => {
    expect(() => parseArgs(["bun", "coverage-gate.ts", "--bogus"])).toThrow("Unknown option: --bogus");
    expect(() => parseArgs(["bun", "coverage-gate.ts", "--threshold-lines"])).toThrow("Missing value");
    expect(() => parseArgs(["bun", "coverage-gate.ts", "--threshold-funcs", "101"])).toThrow("Invalid percentage");
    expect(() => parseArgs(["bun", "coverage-gate.ts", "stray"])).toThrow("Unknown argument: stray");
  });

  test("parses lcov LF/LH and FNF/FNH counters across source records", () => {
    const summary = parseLcovSummary([
      "SF:scripts/a.ts",
      "LF:10",
      "LH:8",
      "FNF:5",
      "FNH:4",
      "end_of_record",
      "SF:scripts/b.ts",
      "LF:30",
      "LH:22",
      "FNF:15",
      "FNH:11",
      "end_of_record",
    ].join("\n"));

    expect(summary.linesPct).toBe(75);
    expect(summary.funcsPct).toBe(75);
  });

  test("fails closed for empty or non-measurable lcov reports", () => {
    expect(() => parseLcovSummary("LF:1\nLH:1\nFNF:1\nFNH:1\n")).toThrow("no source file records");
    expect(() => parseLcovSummary("SF:scripts/a.ts\nend_of_record\n")).toThrow("no measurable LF/FNF counters");
  });

  test("parses Bun text coverage summary from normal coverage output", () => {
    const summary = parseTextCoverageSummary([
      "------------------------------------------------|---------|---------|-------------------",
      "File                                            | % Funcs | % Lines | Uncovered Line #s",
      "------------------------------------------------|---------|---------|-------------------",
      "All files                                       |   83.33 |   81.25 |",
    ].join("\n"));

    expect(summary.funcsPct).toBe(83.33);
    expect(summary.linesPct).toBe(81.25);
    expect(() => parseTextCoverageSummary("no table here")).toThrow("Unable to parse");
  });

  test("--no-run-tests fails when lcov.info does not exist", () => {
    const dir = makeTempDir("coverage-gate-missing");

    expect(() =>
      main([
        "bun",
        "coverage-gate.ts",
        "--no-run-tests",
        "--coverage-dir",
        path.join(dir, "coverage"),
      ])
    ).toThrow("Coverage report not found");
  });

  test("reports FAIL below configured line and function thresholds", () => {
    const dir = makeTempDir("coverage-gate-fail");
    writeLcov(dir, sampleLcov(100, 79, 100, 79));

    const result = captureMain([
      "bun",
      "coverage-gate.ts",
      "--no-run-tests",
      "--coverage-dir",
      path.join(dir, "coverage"),
      "--threshold-lines",
      "80",
      "--threshold-funcs",
      "80",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Coverage summary: lines 79.00%, funcs 79.00%");
    expect(result.stderr).toContain("STATUS: FAIL");
    expect(result.stderr).toContain("line coverage 79.00% is below threshold 80.00%");
    expect(result.stderr).toContain("function coverage 79.00% is below threshold 80.00%");
  });

  test("reports PASS when lcov coverage meets configured thresholds", () => {
    const dir = makeTempDir("coverage-gate-pass");
    writeLcov(dir, sampleLcov(100, 80, 100, 90));

    const result = captureMain([
      "bun",
      "coverage-gate.ts",
      "--no-run-tests",
      "--coverage-dir",
      path.join(dir, "coverage"),
      "--threshold-lines",
      "80",
      "--threshold-funcs",
      "80",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Coverage summary: lines 80.00%, funcs 90.00%");
    expect(result.stdout).toContain("STATUS: PASS");
    expect(result.stderr).toBe("");
  });
});
