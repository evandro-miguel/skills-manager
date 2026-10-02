#!/usr/bin/env bun
/**
 * Run coverage and enforce minimum thresholds from lcov totals.
 */

import fs from "node:fs";
import path from "node:path";
import { runCommand } from "../lib/command.ts";

interface CoverageGateArgs {
  thresholdLines: number;
  thresholdFuncs: number;
  coverageDir: string;
  lcovFile: string;
  runTests: boolean;
  help: boolean;
}

interface CoverageSummary {
  linesPct: number;
  funcsPct: number;
}

function help(): void {
  console.log(`
Coverage gate

Usage:
  bun scripts/commands/coverage-gate.ts [options]

Options:
  --threshold-lines <number>  Minimum line coverage percentage (default: 80)
  --threshold-funcs <number>  Minimum function coverage percentage (default: 80)
  --coverage-dir <dir>        Coverage output directory (default: coverage)
  --lcov-file <path>          Explicit lcov file path (default: <coverage-dir>/lcov.info)
  --no-run-tests              Validate an existing lcov report without running tests
  --help                      Show help
`);
}

function parsePercent(token: string, value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Invalid percentage for ${token}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CoverageGateArgs {
  const args: CoverageGateArgs = {
    thresholdLines: 80,
    thresholdFuncs: 80,
    coverageDir: "coverage",
    lcovFile: "",
    runTests: true,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--no-run-tests") {
      args.runTests = false;
      continue;
    }
    if (token === "--threshold-lines") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      args.thresholdLines = parsePercent(token, value);
      i += 1;
      continue;
    }
    if (token === "--threshold-funcs") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      args.thresholdFuncs = parsePercent(token, value);
      i += 1;
      continue;
    }
    if (token === "--coverage-dir") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      args.coverageDir = value;
      i += 1;
      continue;
    }
    if (token === "--lcov-file") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${token}`);
      }
      args.lcovFile = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.coverageDir = path.resolve(process.cwd(), args.coverageDir);
  args.lcovFile = args.lcovFile
    ? path.resolve(process.cwd(), args.lcovFile)
    : path.join(args.coverageDir, "lcov.info");
  return args;
}

function parseLcovSummary(lcovText: string): CoverageSummary {
  let linesFound = 0;
  let linesHit = 0;
  let funcsFound = 0;
  let funcsHit = 0;
  let sourceFiles = 0;

  for (const rawLine of lcovText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("SF:")) {
      sourceFiles += 1;
      continue;
    }
    if (line.startsWith("LF:")) {
      linesFound += Number.parseInt(line.slice(3), 10) || 0;
      continue;
    }
    if (line.startsWith("LH:")) {
      linesHit += Number.parseInt(line.slice(3), 10) || 0;
      continue;
    }
    if (line.startsWith("FNF:")) {
      funcsFound += Number.parseInt(line.slice(4), 10) || 0;
      continue;
    }
    if (line.startsWith("FNH:")) {
      funcsHit += Number.parseInt(line.slice(4), 10) || 0;
    }
  }
  if (sourceFiles === 0) {
    throw new Error("LCOV report has no source file records");
  }
  if (linesFound === 0 && funcsFound === 0) {
    throw new Error("LCOV report has no measurable LF/FNF counters");
  }

  const linesPct = linesFound === 0 ? 100 : (linesHit / linesFound) * 100;
  const funcsPct = funcsFound === 0 ? 100 : (funcsHit / funcsFound) * 100;
  return {
    linesPct,
    funcsPct,
  };
}

function parseTextCoverageSummary(output: string): CoverageSummary {
  const match = output.match(/^All files\s+\|\s+([0-9.]+)\s+\|\s+([0-9.]+)\s+\|/m);
  if (!match) {
    throw new Error("Unable to parse Bun text coverage summary");
  }
  const funcsPct = Number.parseFloat(match[1] ?? "");
  const linesPct = Number.parseFloat(match[2] ?? "");
  if (!Number.isFinite(funcsPct) || !Number.isFinite(linesPct)) {
    throw new Error("Parsed invalid Bun text coverage summary values");
  }
  return { linesPct, funcsPct };
}

function formatPercent(value: number): string {
  return value.toFixed(2);
}

function runCoverage(args: CoverageGateArgs): CoverageSummary {
  const result = runCommand(
    [
      "bun",
      "test",
      "--coverage",
      "--coverage-dir",
      args.coverageDir,
    ],
    { stdout: "pipe", stderr: "pipe", trimOutput: false }
  );

  // Preserve the normal Bun test output in command invocations.
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return parseTextCoverageSummary(`${result.stdout}\n${result.stderr}`);
}

function readLcovCoverage(args: CoverageGateArgs): CoverageSummary {
  if (!fs.existsSync(args.lcovFile)) {
    throw new Error(`Coverage report not found: ${args.lcovFile}`);
  }

  return parseLcovSummary(fs.readFileSync(args.lcovFile, "utf8"));
}

function main(argv: string[] = process.argv): void {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }

  const summary = args.runTests ? runCoverage(args) : readLcovCoverage(args);

  console.log(
    `Coverage summary: lines ${formatPercent(summary.linesPct)}%, funcs ${formatPercent(summary.funcsPct)}%`
  );

  const errors: string[] = [];
  if (summary.linesPct < args.thresholdLines) {
    errors.push(
      `line coverage ${formatPercent(summary.linesPct)}% is below threshold ${formatPercent(args.thresholdLines)}%`
    );
  }
  if (summary.funcsPct < args.thresholdFuncs) {
    errors.push(
      `function coverage ${formatPercent(summary.funcsPct)}% is below threshold ${formatPercent(args.thresholdFuncs)}%`
    );
  }

  if (errors.length) {
    console.error("STATUS: FAIL");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("STATUS: PASS");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
}

export {
  main,
  parseArgs,
  parseTextCoverageSummary,
  parseLcovSummary,
};
