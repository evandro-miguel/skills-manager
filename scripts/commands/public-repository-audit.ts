#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { requireOptionValue } from "../lib/args.ts";
import { runCommand } from "../lib/command.ts";
import { scanPrivacy } from "../modules/skillpool/privacy-scan.ts";
import { scanSensitiveFiles } from "../modules/skillpool/sensitive-scan.ts";

export const PUBLIC_AGENT_SKILL_ROOT = "skills/skill-sys";
export const REQUIRED_PUBLIC_REPOSITORY_PATHS = [`${PUBLIC_AGENT_SKILL_ROOT}/SKILL.md`];
export const HISTORICAL_SAMPLE_LIMIT = 3;
export const HISTORY_REMEDIATION =
  "GitHub publication requires a sanitized new repository or a separately authorized history rewrite. Do not rewrite history from this checkout.";
export const SHALLOW_REPOSITORY_REMEDIATION =
  "The public repository audit cannot run on a shallow Git repository; complete history is required. Configure actions/checkout with fetch-depth: 0 before retrying.";
export const HISTORICAL_BLOB_MAX_BYTES = 1024 * 1024;
export const HISTORICAL_BLOB_SCAN_MAX_BYTES = 32 * 1024 * 1024;
export const HISTORICAL_BLOB_SCAN_MAX_OBJECTS = 5000;
export const HISTORICAL_BLOB_SCAN_REMEDIATION =
  "Historical Git object content could not be fully verified within the audit bounds. Use a sanitized new repository or a separately authorized history rewrite.";
const PRIVACY_POLICY_DECLARATION_PATHS = new Set([
  "privacy-policy.example.json",
  "privacy-policy.public.json",
]);
const PRIVACY_POLICY_MARKER_FIELDS = [
  "personNames",
  "localPaths",
  "privateWorkflowTerms",
  "emailHandles",
  "companyTerms",
] as const;
export const FORBIDDEN_PUBLIC_REPOSITORY_ROOTS = [
  ".afol",
  ".claude",
  ".codex",
  ".cursor",
  ".gemini",
  ".hermes",
  ".opencode",
  ".qwen",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "RTK.md",
  "docs/lessons",
  "docs/plans",
  "docs/standards",
  "docs/telemetry",
  "docs/templates",
  "docs/map/writing-skills-scripts.md",
  "docs/migration/public-staging-plan.md",
];

type PublicRepositoryAuditArgs = {
  source: string;
  json: boolean;
  help: boolean;
};

export type ForbiddenHistoryClass = {
  root: string;
  count: number;
  samples: string[];
};

export type HistoricalContentClass = {
  code: string;
  rule: string;
  count: number;
  samples: string[];
};

export type HistoricalObject = {
  objectId: string;
  path: string;
};

type HistoricalMetadataObject = HistoricalObject & {
  type: "commit" | "tag";
};

export type HistoricalContentFinding = {
  code: string;
  path: string;
  rule: string;
};

export type PublicRepositoryAuditResult = {
  status: "PASS" | "BLOCKING";
  trackedFileCount: number;
  forbiddenTrackedPaths: string[];
  forbiddenHistoricalPathCount: number;
  forbiddenHistoricalClasses: ForbiddenHistoryClass[];
  historicalContentFindingCount: number;
  historicalContentClasses: HistoricalContentClass[];
  missingRequiredPaths: string[];
  remediation: string | null;
};

function help(stdout: (text: string) => void = console.log): void {
  stdout(`
Audit the tracked Git surface before public repository publication

Usage:
  bun scripts/commands/public-repository-audit.ts [options]

Options:
  --source <dir>  Git checkout to audit (default: current directory)
  --json          Emit machine-readable output
  --help          Show help
`);
}

export function parseArgs(argv: string[]): PublicRepositoryAuditArgs {
  const args: PublicRepositoryAuditArgs = { source: process.cwd(), json: false, help: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--help" || token === "-h") { args.help = true; continue; }
    if (token === "--json") { args.json = true; continue; }
    if (token === "--source") { args.source = requireOptionValue(argv, index, token); index += 1; continue; }
    if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
    throw new Error(`Unknown argument: ${token}`);
  }
  args.source = path.resolve(process.cwd(), args.source);
  return args;
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function classifyForbiddenPublicRepositoryPath(candidate: string): string | null {
  if (!candidate) return null;
  if (isWithin(candidate, ".agents")) return ".agents";
  if (candidate === "skills" || isWithin(candidate, PUBLIC_AGENT_SKILL_ROOT)) return null;
  if (isWithin(candidate, "skills")) return "skills";
  return FORBIDDEN_PUBLIC_REPOSITORY_ROOTS.find((root) => isWithin(candidate, root)) ?? null;
}

export function isForbiddenPublicRepositoryPath(candidate: string): boolean {
  return classifyForbiddenPublicRepositoryPath(candidate) !== null;
}

export function summarizeForbiddenHistoricalPaths(paths: string[]): ForbiddenHistoryClass[] {
  const grouped = new Map<string, string[]>();
  for (const pathName of [...new Set(paths.filter(Boolean))].sort((left, right) => left.localeCompare(right))) {
    const root = classifyForbiddenPublicRepositoryPath(pathName);
    if (!root) continue;
    const members = grouped.get(root) ?? [];
    members.push(pathName);
    grouped.set(root, members);
  }
  return [...grouped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([root, members]) => ({
      root,
      count: members.length,
      samples: members.slice(0, HISTORICAL_SAMPLE_LIMIT),
    }));
}

export function summarizeHistoricalContentFindings(findings: HistoricalContentFinding[]): HistoricalContentClass[] {
  const grouped = new Map<string, string[]>();
  for (const finding of findings) {
    if (!finding.path || !finding.code || !finding.rule) continue;
    const key = `${finding.code}\0${finding.rule}`;
    const members = grouped.get(key) ?? [];
    members.push(finding.path);
    grouped.set(key, members);
  }
  return [...grouped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, members]) => {
      const separator = key.indexOf("\0");
      const code = key.slice(0, separator);
      const rule = key.slice(separator + 1);
      const uniqueMembers = [...new Set(members)].sort((left, right) => left.localeCompare(right));
      return {
        code,
        rule,
        count: uniqueMembers.length,
        samples: uniqueMembers.slice(0, HISTORICAL_SAMPLE_LIMIT),
      };
    });
}

export function auditTrackedFiles(
  trackedFiles: string[],
  historicalPaths: string[] = [],
  historicalContentFindings: HistoricalContentFinding[] = [],
): PublicRepositoryAuditResult {
  const normalized = [...new Set(trackedFiles.filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const tracked = new Set(normalized);
  const forbiddenTrackedPaths = normalized.filter(isForbiddenPublicRepositoryPath);
  const historicalOnly = [...new Set(historicalPaths.filter(Boolean))].filter(
    (pathName) => !tracked.has(pathName) && isForbiddenPublicRepositoryPath(pathName),
  );
  const forbiddenHistoricalClasses = summarizeForbiddenHistoricalPaths(historicalOnly);
  const forbiddenHistoricalPathCount = historicalOnly.length;
  const historicalContentClasses = summarizeHistoricalContentFindings(historicalContentFindings);
  const historicalContentFindingCount = historicalContentClasses.reduce((total, item) => total + item.count, 0);
  const missingRequiredPaths = REQUIRED_PUBLIC_REPOSITORY_PATHS.filter((required) => !tracked.has(required));
  return {
    status: forbiddenTrackedPaths.length || forbiddenHistoricalPathCount || historicalContentFindingCount || missingRequiredPaths.length
      ? "BLOCKING"
      : "PASS",
    trackedFileCount: normalized.length,
    forbiddenTrackedPaths,
    forbiddenHistoricalPathCount,
    forbiddenHistoricalClasses,
    historicalContentFindingCount,
    historicalContentClasses,
    missingRequiredPaths,
    remediation: forbiddenHistoricalPathCount > 0 || historicalContentFindingCount > 0 ? HISTORY_REMEDIATION : null,
  };
}

export function parseRevListObjects(stdout: string): HistoricalObject[] {
  const objects: HistoricalObject[] = [];
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator <= 0) continue;
    const objectId = line.slice(0, separator);
    const objectPath = line.slice(separator + 1);
    if (!/^[0-9a-f]{40,64}$/i.test(objectId) || !objectPath) continue;
    objects.push({ objectId, path: objectPath });
  }
  return objects;
}

export function parseRevListObjectPaths(stdout: string): string[] {
  return parseRevListObjects(stdout).map((item) => item.path);
}

function parseReachableCommitIds(stdout: string): string[] {
  const objectIds = stdout.split("\n").filter(Boolean);
  if (
    objectIds.some((objectId) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(objectId)) ||
    objectIds.length > HISTORICAL_BLOB_SCAN_MAX_OBJECTS
  ) {
    throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
  }
  return [...new Set(objectIds)];
}

function listUnnamedReachableBlobs(source: string, stdout: string): HistoricalObject[] {
  const objectIds = parseReachableCommitIds(
    stdout.split("\n")
      .filter((line) => /^(?:[0-9a-f]{40}|[0-9a-f]{64}) ?$/i.test(line))
      .map((line) => line.trim()).join("\n"),
  );
  if (!objectIds.length) return [];
  const metadata = parseBatchCheck(runGitCapture(
    source, ["cat-file", "--batch-check"], `${objectIds.join("\n")}\n`, 2 * 1024 * 1024,
  ));
  const blobs: HistoricalObject[] = [];
  for (const objectId of objectIds) {
    const detail = metadata.get(objectId);
    if (!detail || detail.type === "missing") throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
    if (detail.type === "blob") {
      // Direct blob refs have no filename in rev-list; scan them under a synthetic text path.
      blobs.push({ objectId, path: `objects/unnamed-${objectId}.txt` });
    }
  }
  return blobs;
}

function parseReachableAnnotatedTagIds(stdout: string): string[] {
  const objectIds: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64}) (blob|tree|commit|tag)$/i);
    if (!match) throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
    if (match[2] === "tag") objectIds.push(match[1]!);
  }
  const uniqueObjectIds = [...new Set(objectIds)];
  if (uniqueObjectIds.length > HISTORICAL_BLOB_SCAN_MAX_OBJECTS) {
    throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
  }
  return uniqueObjectIds;
}

function tagTargetObjectId(content: Buffer): string {
  const headerEnd = content.indexOf(Buffer.from("\n\n"));
  if (headerEnd < 0) throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
  const header = content.subarray(0, headerEnd).toString("utf8");
  const match = header.match(/^object ((?:[0-9a-f]{40}|[0-9a-f]{64}))$/im);
  if (!match) throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
  return match[1]!;
}

function collectReachableAnnotatedTagIds(
  source: string,
  referencedTagIds: string[],
): { objectIds: string[]; contents: Map<string, Buffer> } {
  const objectIds: string[] = [];
  const contents = new Map<string, Buffer>();
  const seen = new Set<string>();
  let pending = [...referencedTagIds];
  let readBytes = 0;
  while (pending.length > 0) {
    const candidates = [...new Set(pending)].filter((objectId) => !seen.has(objectId));
    pending = [];
    if (seen.size > HISTORICAL_BLOB_SCAN_MAX_OBJECTS || candidates.length > HISTORICAL_BLOB_SCAN_MAX_OBJECTS) {
      throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
    }
    const metadata = parseBatchCheck(
      runGitCapture(
        source,
        ["cat-file", "--batch-check"],
        `${candidates.join("\n")}\n`,
        2 * 1024 * 1024,
      ),
    );
    for (const objectId of candidates) {
      const detail = metadata.get(objectId);
      if (!detail || detail.type === "missing") throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
      if (detail.type !== "tag") continue;
      seen.add(objectId);
      objectIds.push(objectId);
      if (detail.size > HISTORICAL_BLOB_MAX_BYTES) continue;
      if (readBytes + detail.size > HISTORICAL_BLOB_SCAN_MAX_BYTES) {
        throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
      }
      const content = runGitCapture(
        source,
        ["cat-file", "tag", objectId],
        undefined,
        HISTORICAL_BLOB_MAX_BYTES + 1,
      );
      readBytes += detail.size;
      contents.set(objectId, content);
      pending.push(tagTargetObjectId(content));
    }
  }
  return { objectIds, contents };
}

function listReachableMetadataObjects(source: string): {
  objects: HistoricalMetadataObject[];
  contents: Map<string, Buffer>;
} {
  const commitIds = parseReachableCommitIds(
    runGitCapture(source, ["rev-list", "--all"], undefined, 2 * 1024 * 1024).toString("utf8"),
  );
  const referencedTagIds = parseReachableAnnotatedTagIds(
    runGitCapture(
      source,
      ["for-each-ref", "--format=%(objectname) %(objecttype)"],
      undefined,
      2 * 1024 * 1024,
    ).toString("utf8"),
  );
  const tags = collectReachableAnnotatedTagIds(source, referencedTagIds);
  if (commitIds.length + tags.objectIds.length > HISTORICAL_BLOB_SCAN_MAX_OBJECTS) {
    throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
  }
  return {
    objects: [
      ...commitIds.map((objectId, index) => ({
        objectId,
        path: `metadata/commit-${String(index + 1).padStart(5, "0")}`,
        type: "commit" as const,
      })),
      ...tags.objectIds.map((objectId, index) => ({
        objectId,
        path: `metadata/tag-${String(index + 1).padStart(5, "0")}`,
        type: "tag" as const,
      })),
    ],
    contents: tags.contents,
  };
}

export function renderPublicRepositoryAudit(result: PublicRepositoryAuditResult): string[] {
  const lines = [`STATUS: ${result.status}`, `Tracked files: ${result.trackedFileCount}`];
  for (const file of result.forbiddenTrackedPaths) lines.push(`FORBIDDEN: ${file}`);
  if (result.forbiddenHistoricalPathCount > 0) {
    lines.push(`HISTORICAL: ${result.forbiddenHistoricalPathCount} forbidden path(s) remain reachable`);
    for (const item of result.forbiddenHistoricalClasses) {
      const example = item.samples.length > 0 ? ` e.g. ${item.samples.join(", ")}` : "";
      lines.push(`HISTORICAL-CLASS: ${item.root} (${item.count})${example}`);
    }
  }
  if (result.historicalContentFindingCount > 0) {
    lines.push(`HISTORICAL-CONTENT: ${result.historicalContentFindingCount} sensitive finding(s) remain reachable`);
    for (const item of result.historicalContentClasses) {
      const example = item.samples.length > 0 ? ` e.g. ${item.samples.join(", ")}` : "";
      lines.push(`HISTORICAL-CONTENT-CLASS: ${item.code}/${item.rule} (${item.count})${example}`);
    }
  }
  for (const file of result.missingRequiredPaths) lines.push(`MISSING: ${file}`);
  if (result.remediation) lines.push(`REMEDIATION: ${result.remediation}`);
  return lines;
}

function runGitCapture(source: string, args: string[], input: string | undefined, maxBuffer: number): Buffer {
  try {
    const result = spawnSync("git", ["-C", source, ...args], {
      input,
      maxBuffer,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
    }
    return Buffer.from(result.stdout || []);
  } catch {
    throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
  }
}

function parseBatchCheck(output: Buffer): Map<string, { type: string; size: number }> {
  const metadata = new Map<string, { type: string; size: number }>();
  for (const line of output.toString("utf8").split("\n")) {
    if (!line) continue;
    const [objectId, type, sizeText] = line.split(" ");
    if (!objectId || !type) throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
    if (type === "missing") {
      metadata.set(objectId, { type, size: 0 });
      continue;
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
    metadata.set(objectId, { type, size });
  }
  return metadata;
}

function normalizeHistoricalBlobPath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
  }
  return normalized;
}

function deduplicateHistoricalContexts(objects: HistoricalObject[]): HistoricalObject[] {
  const contexts = new Map<string, HistoricalObject>();
  const objectIds = new Set<string>();
  for (const object of objects) {
    const relativePath = normalizeHistoricalBlobPath(object.path);
    const key = `${object.objectId}\0${relativePath}`;
    if (!contexts.has(key)) {
      contexts.set(key, { objectId: object.objectId, path: relativePath });
      objectIds.add(object.objectId);
      if (
        contexts.size > HISTORICAL_BLOB_SCAN_MAX_OBJECTS ||
        objectIds.size > HISTORICAL_BLOB_SCAN_MAX_OBJECTS
      ) {
        throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
      }
    }
  }
  return [...contexts.values()];
}

function parseRawHistoryObjects(output: Buffer, selectedObjectIds: ReadonlySet<string>): HistoricalObject[] {
  if (!selectedObjectIds.size) return [];
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
  }
  if (!decoded) return [];

  const records = decoded.split("\0");
  if (records[records.length - 1] === "") records.pop();
  const objects: HistoricalObject[] = [];
  for (let index = 0; index < records.length;) {
    const header = records[index++];
    const match = header?.match(
      /^:[0-7]{6} [0-7]{6} ((?:[0-9a-f]{40}|[0-9a-f]{64})) ((?:[0-9a-f]{40}|[0-9a-f]{64})) [A-Z][0-9]*$/i,
    );
    const relativePath = records[index++];
    if (!match || !relativePath) throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);

    for (const objectId of [match[1]!, match[2]!]) {
      if (!/^0+$/.test(objectId) && selectedObjectIds.has(objectId)) {
        objects.push({ objectId, path: relativePath });
      }
    }
  }
  return deduplicateHistoricalContexts(objects);
}

function createProjectScratch(source: string): { root: string; cleanup: () => void } {
  const parent = path.join(source, ".tmp");
  const existed = fs.existsSync(parent);
  if (existed && !fs.lstatSync(parent).isDirectory()) {
    throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
  }
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "public-repository-audit-"));
  return {
    root,
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      if (!existed) {
        try {
          fs.rmdirSync(parent);
        } catch {
          // Preserve a concurrently created scratch directory.
        }
      }
    },
  };
}

function optionalPrivacyFile(source: string, name: string): string | undefined {
  const candidate = path.join(source, name);
  if (!fs.existsSync(candidate)) return undefined;
  if (!fs.lstatSync(candidate).isFile()) throw new Error(HISTORICAL_BLOB_SCAN_REMEDIATION);
  return candidate;
}

function hasDuplicateJsonObjectKeys(content: string): boolean {
  const objectKeys: Array<Set<string>> = [];
  for (let index = 0; index < content.length; index += 1) {
    const token = content[index];
    if (token === "{") {
      objectKeys.push(new Set());
      continue;
    }
    if (token === "}") {
      if (!objectKeys.pop()) return true;
      continue;
    }
    if (token !== '"') continue;

    const start = index;
    let end = index + 1;
    while (end < content.length) {
      if (content[end] === "\\") {
        end += 2;
        continue;
      }
      if (content[end] === '"') break;
      end += 1;
    }
    if (end >= content.length) return true;

    let next = end + 1;
    while (next < content.length && /\s/.test(content[next]!)) next += 1;
    if (content[next] === ":") {
      const keys = objectKeys[objectKeys.length - 1];
      if (!keys) return true;
      let key: unknown;
      try {
        key = JSON.parse(content.slice(start, end + 1));
      } catch {
        return true;
      }
      if (typeof key !== "string" || keys.has(key)) return true;
      keys.add(key);
    }
    index = end;
  }
  return objectKeys.length > 0;
}

type PolicyDeclarationScan = {
  content: string | null;
  duplicateKeys: boolean;
};

function policyMarkerDeclarationScanContent(relativePath: string, content: string): PolicyDeclarationScan {
  if (!PRIVACY_POLICY_DECLARATION_PATHS.has(relativePath)) return { content: null, duplicateKeys: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { content: null, duplicateKeys: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { content: null, duplicateKeys: false };
  if (hasDuplicateJsonObjectKeys(content)) return { content: null, duplicateKeys: true };

  const policy = parsed as Record<string, unknown>;
  if (Object.keys(policy).some((key) => key !== "markers")) return { content: null, duplicateKeys: false };

  const markers = policy.markers;
  if (!markers || typeof markers !== "object" || Array.isArray(markers)) return { content: null, duplicateKeys: false };
  const markerFields = markers as Record<string, unknown>;
  if (Object.keys(markerFields).some((key) => !PRIVACY_POLICY_MARKER_FIELDS.includes(key as typeof PRIVACY_POLICY_MARKER_FIELDS[number]))) {
    return { content: null, duplicateKeys: false };
  }

  let hasDeclarations = false;
  for (const field of PRIVACY_POLICY_MARKER_FIELDS) {
    const value = markerFields[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      return { content: null, duplicateKeys: false };
    }
    if (value.length > 0) {
      markerFields[field] = [];
      hasDeclarations = true;
    }
  }

  return {
    content: hasDeclarations ? `${JSON.stringify(parsed, null, 2)}\n` : null,
    duplicateKeys: false,
  };
}

function scanHistoricalBlobContents(
  source: string,
  objects: HistoricalObject[],
  metadataObjects: HistoricalMetadataObject[] = [],
  prefetchedMetadataContents: Map<string, Buffer> = new Map(),
): HistoricalContentFinding[] {
  const historicalContexts = deduplicateHistoricalContexts(objects);
  const metadataContexts = deduplicateHistoricalContexts(metadataObjects);
  if (!historicalContexts.length && !metadataContexts.length) return [];
  const metadataTypeByContext = new Map(
    metadataObjects.map((object) => [`${object.objectId}\0${object.path}`, object.type]),
  );
  const objectIds = [...new Set([
    ...historicalContexts.map((object) => object.objectId),
    ...metadataContexts.map((object) => object.objectId),
  ])];

  const metadata = parseBatchCheck(
    runGitCapture(
      source,
      ["cat-file", "--batch-check"],
      `${objectIds.join("\n")}\n`,
      2 * 1024 * 1024,
    ),
  );
  const findings: HistoricalContentFinding[] = [];
  const selected: Array<HistoricalObject & { size: number; type: "blob" | "commit" | "tag" }> = [];
  let blobScanBytes = 0;
  for (const object of historicalContexts) {
    const detail = metadata.get(object.objectId);
    if (!detail || detail.type === "missing") {
      findings.push({ code: "HISTORICAL_BLOB_SCAN", path: object.path, rule: "MISSING_OBJECT" });
      continue;
    }
    if (detail.type !== "blob") continue;
    if (detail.size > HISTORICAL_BLOB_MAX_BYTES) {
      findings.push({ code: "FILE_SKIPPED_OVERSIZE", path: object.path, rule: "MAX_FILE_BYTES" });
      continue;
    }
    if (blobScanBytes + detail.size > HISTORICAL_BLOB_SCAN_MAX_BYTES) {
      findings.push({ code: "HISTORICAL_BLOB_SCAN", path: object.path, rule: "MAX_TOTAL_BYTES" });
      continue;
    }
    selected.push({ ...object, size: detail.size, type: "blob" });
    blobScanBytes += detail.size;
  }
  let metadataScanBytes = 0;
  for (const object of metadataContexts) {
    const detail = metadata.get(object.objectId);
    const objectType = metadataTypeByContext.get(`${object.objectId}\0${object.path}`);
    if (!detail || detail.type === "missing") {
      findings.push({ code: "HISTORICAL_BLOB_SCAN", path: object.path, rule: "MISSING_OBJECT" });
      continue;
    }
    if (!objectType || detail.type !== objectType) {
      findings.push({ code: "HISTORICAL_BLOB_SCAN", path: object.path, rule: "OBJECT_TYPE_MISMATCH" });
      continue;
    }
    if (detail.size > HISTORICAL_BLOB_MAX_BYTES) {
      findings.push({ code: "FILE_SKIPPED_OVERSIZE", path: object.path, rule: "MAX_FILE_BYTES" });
      continue;
    }
    if (metadataScanBytes + detail.size > HISTORICAL_BLOB_SCAN_MAX_BYTES) {
      findings.push({ code: "HISTORICAL_BLOB_SCAN", path: object.path, rule: "MAX_TOTAL_BYTES" });
      continue;
    }
    selected.push({ ...object, size: detail.size, type: objectType });
    metadataScanBytes += detail.size;
  }
  if (!selected.length) return findings;

  const scratch = createProjectScratch(source);
  const allowlistPath = optionalPrivacyFile(source, "privacy-allowlist.public.json");
  const policyPath = optionalPrivacyFile(source, "privacy-policy.public.json");
  const contentByObjectId = new Map(prefetchedMetadataContents);
  try {
    for (const [index, object] of selected.entries()) {
      let content = contentByObjectId.get(object.objectId);
      if (!content) {
        content = runGitCapture(source, ["cat-file", object.type, object.objectId], undefined, HISTORICAL_BLOB_MAX_BYTES + 1);
        contentByObjectId.set(object.objectId, content);
      }
      const relativePath = object.path;
      const blobRoot = path.join(scratch.root, `${object.objectId}-${index}`);
      const filePath = path.join(blobRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      const originalContent = content.toString("utf8");
      const policyDeclaration = policyMarkerDeclarationScanContent(relativePath, originalContent);
      const policyDeclarationContent = policyDeclaration.content;
      const privacyScanOptions = {
        rootDir: blobRoot,
        baseDir: blobRoot,
        includePaths: [relativePath],
        maxFileBytes: HISTORICAL_BLOB_MAX_BYTES,
        ...(allowlistPath ? { allowlistPath } : {}),
        strictAllowlist: true,
        forceTextContentScan: true,
      };
      const scans = [
        ...scanSensitiveFiles({
          rootDir: blobRoot,
          baseDir: blobRoot,
          includePaths: [relativePath],
          maxFileBytes: HISTORICAL_BLOB_MAX_BYTES,
        }),
        ...scanPrivacy({
          ...privacyScanOptions,
          ...(policyDeclarationContent === null && policyPath ? { policyPath } : {}),
        }),
      ];
      if (policyDeclarationContent !== null) {
        fs.writeFileSync(filePath, policyDeclarationContent);
        scans.push(
          ...scanPrivacy({
            ...privacyScanOptions,
            ...(policyPath ? { policyPath } : {}),
          }),
        );
      }
      for (const finding of scans) {
        findings.push({ code: finding.code, path: finding.path, rule: finding.rule });
      }
      if (policyDeclaration.duplicateKeys) {
        findings.push({ code: "PRIVACY_CONTENT", path: relativePath, rule: "DUPLICATE_POLICY_KEY" });
      }
      fs.rmSync(blobRoot, { recursive: true, force: true });
    }
  } finally {
    scratch.cleanup();
  }
  return findings;
}

export function runPublicRepositoryAudit(source: string): PublicRepositoryAuditResult {
  const shallowResult = runCommand(["git", "-C", source, "rev-parse", "--is-shallow-repository"], {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
  });
  if (shallowResult.code !== 0) throw new Error("git shallow-repository check failed for the selected source");
  const shallow = shallowResult.stdout.trim();
  if (shallow === "true") throw new Error(SHALLOW_REPOSITORY_REMEDIATION);
  if (shallow !== "false") throw new Error("git shallow-repository check returned an invalid result");

  const trackedResult = runCommand(["git", "-C", source, "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
  });
  if (trackedResult.code !== 0) throw new Error("git ls-files failed for the selected source");
  const historyResult = runCommand(["git", "-C", source, "rev-list", "--objects", "--all"], {
    stdout: "pipe",
    stderr: "pipe",
    allowFailure: true,
  });
  if (historyResult.code !== 0) throw new Error("git rev-list failed for the selected source");
  const revListObjects = parseRevListObjects(historyResult.stdout);
  const reachableMetadataObjects = listReachableMetadataObjects(source);
  const policyObjectIds = new Set(
    revListObjects
      .filter((object) => PRIVACY_POLICY_DECLARATION_PATHS.has(normalizeHistoricalBlobPath(object.path)))
      .map((object) => object.objectId),
  );
  const rawHistory = policyObjectIds.size
    ? runGitCapture(
      source,
      ["log", "--all", "--raw", "--no-renames", "--format=", "-z", "--no-abbrev", "-m"],
      undefined,
      HISTORICAL_BLOB_SCAN_MAX_BYTES,
    )
    : Buffer.alloc(0);
  const historicalObjects = deduplicateHistoricalContexts([
    ...revListObjects,
    ...listUnnamedReachableBlobs(source, historyResult.stdout),
    ...parseRawHistoryObjects(rawHistory, policyObjectIds),
  ]);
  return auditTrackedFiles(
    trackedResult.stdout.split("\0"),
    historicalObjects.map((item) => item.path),
    scanHistoricalBlobContents(
      source,
      historicalObjects,
      reachableMetadataObjects.objects,
      reachableMetadataObjects.contents,
    ),
  );
}

export function main(
  argv: string[] = process.argv,
  stdout: (text: string) => void = console.log,
  stderr: (text: string) => void = console.error,
): number {
  try {
    const args = parseArgs(argv);
    if (args.help) { help(stdout); return 0; }
    const result = runPublicRepositoryAudit(args.source);
    if (args.json) stdout(JSON.stringify(result, null, 2));
    else for (const line of renderPublicRepositoryAudit(result)) stdout(line);
    return result.status === "PASS" ? 0 : 1;
  } catch (error) {
    stderr(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
