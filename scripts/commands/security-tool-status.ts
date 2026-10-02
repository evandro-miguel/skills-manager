#!/usr/bin/env bun

import { runCommand } from "../lib/command.ts";

type ToolName = "codeql" | "scorecard";

type ToolConfig = {
  command: string;
  versionArgs: string[];
  workflow: string;
};

const TOOL_CONFIGS: Record<ToolName, ToolConfig> = {
  codeql: {
    command: "codeql",
    versionArgs: ["--version"],
    workflow: ".github/workflows/codeql.yml",
  },
  scorecard: {
    command: "scorecard",
    versionArgs: ["--version"],
    workflow: ".github/workflows/scorecard.yml",
  },
};

function help(): void {
  console.log(`
Local security tool availability check

Usage:
  bun scripts/commands/security-tool-status.ts <codeql|scorecard>

This script is intentionally a status check, not a passing validation gate. If the
local CLI is not installed it exits non-zero and points to the GitHub workflow
that performs the hosted analysis.
`);
}

function parseTool(argv: string[] = process.argv): ToolName | "help" {
  const token = argv[2];
  if (!token || token === "--help" || token === "-h") {
    return "help";
  }
  if (token !== "codeql" && token !== "scorecard") {
    throw new Error(`Unknown security tool '${token}'. Expected codeql or scorecard.`);
  }
  return token;
}

function commandPath(command: string): string | null {
  const result = runCommand(["bash", "-lc", `command -v ${command}`], {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
  });
  return result.code === 0 && result.stdout ? result.stdout.split("\n")[0] || null : null;
}

function renderStatus(tool: ToolName): number {
  const config = TOOL_CONFIGS[tool];
  const resolved = commandPath(config.command);
  if (!resolved) {
    console.error(`STATUS: UNAVAILABLE`);
    console.error(`Tool: ${tool}`);
    console.error(`Local CLI not found on PATH: ${config.command}`);
    console.error(`Hosted workflow: ${config.workflow}`);
    console.error("Not included in validate:publish because this checkout cannot truthfully claim a local run.");
    return 1;
  }

  const version = runCommand([config.command, ...config.versionArgs], {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
  });
  console.log("STATUS: AVAILABLE");
  console.log(`Tool: ${tool}`);
  console.log(`Path: ${resolved}`);
  if (version.stdout) {
    console.log(version.stdout);
  } else if (version.stderr) {
    console.log(version.stderr);
  }
  console.log("This only reports local availability; hosted workflow remains authoritative for repository security scanning.");
  return version.code === 0 ? 0 : 1;
}

function main(argv: string[] = process.argv): number {
  try {
    const tool = parseTool(argv);
    if (tool === "help") {
      help();
      return 0;
    }
    return renderStatus(tool);
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

export { main, parseTool, renderStatus };
