import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateRegistrySurface } from "../../commands/validate-registry-surface.ts";
import { writeFileAtomicSafe } from "../../lib/files.ts";

export type RegistryExportStatus = "PASS";

export type RegistryExportArtifact = {
  path: string;
  sha256: string;
  kind: "metadata" | "index" | "channel" | "advisory";
};

export type RegistryExportBundle = {
  schemaVersion: 1;
  format: "skill-sys-registry-export";
  registryName: string;
  baseUrl: string;
  metadata: Record<string, unknown>;
  index: Record<string, any>;
  channels: Record<string, { path: string; sha256: string; document: Record<string, unknown> }>;
  advisories: { path: string; sha256: string; document: Record<string, unknown> };
  artifacts: RegistryExportArtifact[];
};

export type RegistryExportFinding = {
  level: "WARN" | "ERROR";
  code: string;
  message: string;
  path?: string;
};

export type RegistryExportResult = {
  schemaVersion: 1;
  command: "registry-export";
  status: RegistryExportStatus;
  source: string;
  strict: boolean;
  bundle: RegistryExportBundle;
  findings: RegistryExportFinding[];
};

export type RegistryExportInput = {
  source: string;
  strict: boolean;
};

export type RegistryExportArgs = {
  source?: string;
  strict?: boolean;
};

type JsonObject = Record<string, any>;

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(root: string, relativePath: string): JsonObject {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as JsonObject;
}

function assertExistingDirectory(dir: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`${label} does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${dir}`);
}

export function normalizeRegistryExportArgs(args: RegistryExportArgs): RegistryExportInput {
  const source = path.resolve(args.source || process.cwd());
  assertExistingDirectory(source, "--source");
  return { source, strict: args.strict === true };
}

export function runRegistryExport(input: RegistryExportInput): RegistryExportResult {
  const source = path.resolve(input.source);
  const surface = validateRegistrySurface(source);
  const metadata = readJson(source, "registry/metadata.json");
  const index = readJson(source, "registry/index.json");

  const channels: RegistryExportBundle["channels"] = {};
  for (const [name, pointer] of Object.entries(index.channels as Record<string, { path: string; sha256: string }>).sort(([a], [b]) => a.localeCompare(b))) {
    channels[name] = {
      path: pointer.path,
      sha256: pointer.sha256.toLowerCase(),
      document: readJson(source, pointer.path),
    };
  }

  const advisoryPath = "registry/advisories/security-status.json";
  const advisories = {
    path: advisoryPath,
    sha256: sha256File(path.join(source, advisoryPath)),
    document: readJson(source, advisoryPath),
  };

  const artifacts: RegistryExportArtifact[] = [
    { path: advisoryPath, sha256: advisories.sha256, kind: "advisory" },
    { path: "registry/index.json", sha256: sha256File(path.join(source, "registry/index.json")), kind: "index" },
    { path: "registry/metadata.json", sha256: sha256File(path.join(source, "registry/metadata.json")), kind: "metadata" },
  ];
  for (const channel of Object.values(channels)) {
    artifacts.push({ path: channel.path, sha256: channel.sha256, kind: "channel" });
  }
  artifacts.sort((a, b): number => a.path.localeCompare(b.path));

  return {
    schemaVersion: 1,
    command: "registry-export",
    status: surface.status,
    source,
    strict: input.strict,
    bundle: {
      schemaVersion: 1,
      format: "skill-sys-registry-export",
      registryName: String(metadata.name || ""),
      baseUrl: String(metadata.baseUrl || ""),
      metadata,
      index,
      channels,
      advisories,
      artifacts,
    },
    findings: [],
  };
}

/** Write only the portable bundle, keeping the command result on stdout. */
export function writeRegistryExportBundle(outputPath: string, bundle: RegistryExportBundle): string {
  const output = path.resolve(outputPath);
  writeFileAtomicSafe(output, `${JSON.stringify(bundle, null, 2)}\n`);
  return output;
}

export function renderRegistryExportResult(result: RegistryExportResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status}`,
    `Registry: ${result.bundle.registryName}`,
    `Source: ${result.source}`,
    `Format: ${result.bundle.format}`,
    `Channels: ${Object.keys(result.bundle.channels).length}`,
    `Artifacts: ${result.bundle.artifacts.length}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const artifact of result.bundle.artifacts) lines.push(`- ${artifact.path} ${artifact.sha256}`);
  return lines.join("\n");
}
