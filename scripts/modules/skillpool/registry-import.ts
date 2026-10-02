import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RegistryExportBundle } from "./registry-export.ts";
import { writeFileAtomicSafe } from "../../lib/files.ts";

export type RegistryImportStatus = "PASS" | "BLOCKED";
export type RegistryImportProvenance = "UNVERIFIED";

export type RegistryImportFinding = {
  level: "ERROR";
  code: string;
  message: string;
  path?: string;
};

export type RegistryImportResult = {
  schemaVersion: 1;
  command: "registry-import";
  status: RegistryImportStatus;
  bundle: string;
  output: string;
  strict: boolean;
  format: string;
  registryName: string;
  provenance: RegistryImportProvenance;
  files: string[];
  findings: RegistryImportFinding[];
};

export type RegistryImportInput = {
  bundle: string;
  output: string;
  strict: boolean;
};

export type RegistryImportArgs = {
  bundle?: string;
  output?: string;
  strict?: boolean;
};

type JsonObject = Record<string, unknown>;
type ImportDocument = { path: string; kind: RegistryExportBundle["artifacts"][number]["kind"]; document: JsonObject; sha256: string };

const SAFE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const PROVENANCE_KEY_NAMES = new Set([
  "attestation",
  "authority",
  "certificate",
  "keyid",
  "proof",
  "provenance",
  "signature",
  "signer",
  "signed",
  "trust",
  "untrusted",
  "verification",
  "verified",
]);
const PROVENANCE_KEY_PREFIXES = [
  "attestation",
  "authority",
  "certificate",
  "proof",
  "provenance",
  "signature",
  "signer",
  "signedprovenance",
  "trust",
  "verif",
];

class RegistryImportValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly findingPath?: string,
  ) {
    super(message);
    this.name = "RegistryImportValidationError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(code: string, message: string, findingPath?: string): never {
  throw new RegistryImportValidationError(code, message, findingPath);
}

function assertObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) fail("REGISTRY_IMPORT_INVALID_SHAPE", `${label} must be an object`, label);
  return value;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("REGISTRY_IMPORT_INVALID_FIELD", `${label} must be a non-empty string`, label);
  }
  return value;
}

function assertSafeName(value: unknown, label: string): string {
  const name = assertString(value, label);
  if (!SAFE_NAME_PATTERN.test(name)) fail("REGISTRY_IMPORT_INVALID_FIELD", `${label} must be a safe identifier`, label);
  return name;
}

function assertSha256(value: unknown, label: string): string {
  const digest = assertString(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(digest)) fail("REGISTRY_IMPORT_INVALID_DIGEST", `${label} must be a 64-character SHA-256 hex digest`, label);
  return digest;
}

function assertSafeRelativePath(value: unknown, label: string): string {
  const relativePath = assertString(value, label);
  const normalized = relativePath.split("\\").join("/");
  if (
    normalized !== relativePath ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    path.posix.normalize(relativePath) !== relativePath ||
    !relativePath.startsWith("registry/")
  ) {
    fail("REGISTRY_IMPORT_UNSAFE_PATH", `${label} must be a normalized registry-relative POSIX path`, label);
  }
  return relativePath;
}

function assertLocalBaseUrl(value: unknown): string {
  const baseUrl = assertString(value, "baseUrl");
  if (baseUrl.includes("\\") || baseUrl.startsWith("~") || baseUrl.startsWith("//") || /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl)) {
    fail("REGISTRY_IMPORT_REMOTE_SOURCE_UNSUPPORTED", "baseUrl must remain local; remote registry authorities are unsupported", "baseUrl");
  }
  return baseUrl;
}

function canonicalDocument(document: JsonObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function documentDigest(document: JsonObject): string {
  return crypto.createHash("sha256").update(canonicalDocument(document)).digest("hex");
}

function findProvenanceKey(value: unknown, currentPath = "$", seen = new Set<object>()): string | null {
  if (!isObject(value) && !Array.isArray(value)) return null;
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return null;
    seen.add(value);
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const result = findProvenanceKey(entry, `${currentPath}[${index}]`, seen);
      if (result) return result;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
    if (
      PROVENANCE_KEY_NAMES.has(normalizedKey) ||
      PROVENANCE_KEY_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix))
    ) {
      return `${currentPath}.${key}`;
    }
    const result = findProvenanceKey(entry, `${currentPath}.${key}`, seen);
    if (result) return result;
  }
  return null;
}

function assertNoUnverifiableProvenance(bundle: JsonObject): void {
  const provenancePath = findProvenanceKey(bundle);
  if (provenancePath) {
    fail(
      "REGISTRY_IMPORT_PROVENANCE_UNVERIFIED",
      `bundle contains unverifiable signed/provenance metadata at ${provenancePath}; no local authority is configured`,
      provenancePath,
    );
  }
}

function assertPointer(value: unknown, label: string): { path: string; sha256: string } {
  const pointer = assertObject(value, label);
  return {
    path: assertSafeRelativePath(pointer.path, `${label}.path`),
    sha256: assertSha256(pointer.sha256, `${label}.sha256`),
  };
}

function assertArtifact(value: unknown, index: number): RegistryExportBundle["artifacts"][number] {
  const artifact = assertObject(value, `artifacts[${index}]`);
  const kind = artifact.kind;
  if (kind !== "metadata" && kind !== "index" && kind !== "channel" && kind !== "advisory") {
    fail("REGISTRY_IMPORT_INVALID_FIELD", `artifacts[${index}].kind is invalid`, `artifacts[${index}].kind`);
  }
  return {
    path: assertSafeRelativePath(artifact.path, `artifacts[${index}].path`),
    sha256: assertSha256(artifact.sha256, `artifacts[${index}].sha256`),
    kind,
  };
}

function buildImportDocuments(bundle: RegistryExportBundle): ImportDocument[] {
  const metadata = assertObject(bundle.metadata, "metadata");
  const index = assertObject(bundle.index, "index");
  const advisories = assertObject(bundle.advisories, "advisories");
  const channelEntries = Object.entries(assertObject(bundle.channels, "channels"));
  const documents: ImportDocument[] = [
    {
      path: "registry/metadata.json",
      kind: "metadata",
      document: metadata,
      sha256: documentDigest(metadata),
    },
    {
      path: "registry/index.json",
      kind: "index",
      document: index,
      sha256: documentDigest(index),
    },
    {
      path: assertSafeRelativePath(advisories.path, "advisories.path"),
      kind: "advisory",
      document: assertObject(advisories.document, "advisories.document"),
      sha256: documentDigest(assertObject(advisories.document, "advisories.document")),
    },
  ];
  for (const [name, rawChannel] of channelEntries) {
    const channel = assertObject(rawChannel, `channels.${name}`);
    documents.push({
      path: assertSafeRelativePath(channel.path, `channels.${name}.path`),
      kind: "channel",
      document: assertObject(channel.document, `channels.${name}.document`),
      sha256: documentDigest(assertObject(channel.document, `channels.${name}.document`)),
    });
  }
  const paths = new Set<string>();
  for (const document of documents) {
    if (paths.has(document.path)) fail("REGISTRY_IMPORT_DUPLICATE_PATH", `registry document path is duplicated: ${document.path}`, document.path);
    paths.add(document.path);
  }
  return documents;
}

function assertBundle(bundleValue: unknown): RegistryExportBundle {
  const bundle = assertObject(bundleValue, "bundle");
  assertNoUnverifiableProvenance(bundle);
  const allowedKeys = new Set(["schemaVersion", "format", "registryName", "baseUrl", "metadata", "index", "channels", "advisories", "artifacts"]);
  for (const key of Object.keys(bundle)) {
    if (!allowedKeys.has(key)) fail("REGISTRY_IMPORT_INVALID_FIELD", `bundle contains an unsupported field: ${key}`, key);
  }
  if (bundle.schemaVersion !== 1) fail("REGISTRY_IMPORT_UNSUPPORTED_SCHEMA", "bundle.schemaVersion must be 1", "schemaVersion");
  if (bundle.format !== "skill-sys-registry-export") fail("REGISTRY_IMPORT_UNSUPPORTED_FORMAT", "bundle.format must be skill-sys-registry-export", "format");

  const registryName = assertSafeName(bundle.registryName, "registryName");
  const baseUrl = assertLocalBaseUrl(bundle.baseUrl);
  const metadata = assertObject(bundle.metadata, "metadata");
  if (metadata.version !== 1) fail("REGISTRY_IMPORT_INVALID_FIELD", "metadata.version must be 1", "metadata.version");
  if (metadata.name !== registryName) fail("REGISTRY_IMPORT_METADATA_MISMATCH", "registryName must match metadata.name", "registryName");
  if (metadata.baseUrl !== baseUrl) fail("REGISTRY_IMPORT_METADATA_MISMATCH", "baseUrl must match metadata.baseUrl", "baseUrl");

  const index = assertObject(bundle.index, "index");
  if (index.version !== 1) fail("REGISTRY_IMPORT_INVALID_FIELD", "index.version must be 1", "index.version");
  if (!Array.isArray(index.taps)) fail("REGISTRY_IMPORT_REMOTE_TAPS_UNSUPPORTED", "index.taps must be an empty array; remote taps require an external trust authority", "index.taps");
  if (index.taps.length > 0) fail("REGISTRY_IMPORT_REMOTE_TAPS_UNSUPPORTED", "remote registry taps cannot be imported without an external trust authority", "index.taps");

  const channels = assertObject(bundle.channels, "channels");
  const channelNames = Object.keys(channels);
  const indexChannels = assertObject(index.channels, "index.channels");
  if (channelNames.length !== Object.keys(indexChannels).length) fail("REGISTRY_IMPORT_CHANNEL_MISMATCH", "bundle channels must match index.channels", "channels");
  for (const name of channelNames) {
    assertSafeName(name, `channels.${name}`);
    const pointer = assertPointer(indexChannels[name], `index.channels.${name}`);
    const channel = assertObject(channels[name], `channels.${name}`);
    const channelPath = assertSafeRelativePath(channel.path, `channels.${name}.path`);
    if (pointer.path !== channelPath) fail("REGISTRY_IMPORT_CHANNEL_MISMATCH", `index.channels.${name}.path must match channels.${name}.path`, `channels.${name}.path`);
    const channelDocument = assertObject(channel.document, `channels.${name}.document`);
    if (channelDocument.version !== 1 || channelDocument.channel !== name) fail("REGISTRY_IMPORT_INVALID_CHANNEL", `channel ${name} must be a matching release channel document`, `channels.${name}.document`);
    const policy = assertObject(channelDocument.policy, `channels.${name}.document.policy`);
    if (policy.allowFloatingRef !== false) fail("REGISTRY_IMPORT_MUTABLE_REF", `channel ${name} must set policy.allowFloatingRef=false`, `channels.${name}.document.policy.allowFloatingRef`);
  }

  const advisoryPointer = assertPointer(metadata.advisories, "metadata.advisories");
  const bundleAdvisories = assertObject(bundle.advisories, "advisories");
  const advisoryPath = assertSafeRelativePath(bundleAdvisories.path, "advisories.path");
  if (advisoryPointer.path !== advisoryPath) fail("REGISTRY_IMPORT_ADVISORY_MISMATCH", "metadata.advisories.path must match advisories.path", "advisories.path");
  const advisoryDocument = assertObject(bundleAdvisories.document, "advisories.document");
  if (advisoryDocument.version !== 1 || !["no-known-advisories", "advisories-present", "unknown"].includes(String(advisoryDocument.status))) {
    fail("REGISTRY_IMPORT_INVALID_ADVISORY", "advisories.document has an invalid security advisory status", "advisories.document");
  }
  if (!Array.isArray(advisoryDocument.advisories)) fail("REGISTRY_IMPORT_INVALID_ADVISORY", "advisories.document.advisories must be an array", "advisories.document.advisories");

  const documents = buildImportDocuments(bundle as RegistryExportBundle);
  const artifactsValue = bundle.artifacts;
  if (!Array.isArray(artifactsValue) || artifactsValue.length !== documents.length) fail("REGISTRY_IMPORT_ARTIFACT_MISMATCH", "artifacts must contain exactly one digest for every imported registry document", "artifacts");
  const expected = new Map(documents.map((document) => [document.path, document]));
  const seenArtifacts = new Set<string>();
  for (const [indexValue, rawArtifact] of artifactsValue.entries()) {
    const artifact = assertArtifact(rawArtifact, indexValue);
    if (seenArtifacts.has(artifact.path)) fail("REGISTRY_IMPORT_DUPLICATE_PATH", `artifact path is duplicated: ${artifact.path}`, artifact.path);
    seenArtifacts.add(artifact.path);
    const document = expected.get(artifact.path);
    if (!document || document.kind !== artifact.kind) fail("REGISTRY_IMPORT_ARTIFACT_MISMATCH", `artifact ${artifact.path} does not match a bundle document`, artifact.path);
    if (document.sha256 !== artifact.sha256) fail("REGISTRY_IMPORT_DIGEST_MISMATCH", `artifact ${artifact.path} digest does not match its canonical document`, artifact.path);
  }
  if (seenArtifacts.size !== expected.size) fail("REGISTRY_IMPORT_ARTIFACT_MISMATCH", "artifacts omit one or more bundle documents", "artifacts");

  const metadataIndexPointer = assertPointer(metadata.index, "metadata.index");
  const indexDocument = expected.get(metadataIndexPointer.path);
  if (!indexDocument || indexDocument.kind !== "index" || indexDocument.sha256 !== metadataIndexPointer.sha256) fail("REGISTRY_IMPORT_METADATA_MISMATCH", "metadata.index must point to the imported index digest", "metadata.index");
  if (advisoryPointer.sha256 !== expected.get(advisoryPath)?.sha256) fail("REGISTRY_IMPORT_ADVISORY_MISMATCH", "metadata.advisories must point to the imported advisory digest", "metadata.advisories");
  for (const name of channelNames) {
    const pointer = assertPointer(indexChannels[name], `index.channels.${name}`);
    const channelPath = assertSafeRelativePath(assertObject(channels[name], `channels.${name}`).path, `channels.${name}.path`);
    if (pointer.sha256 !== expected.get(channelPath)?.sha256) fail("REGISTRY_IMPORT_DIGEST_MISMATCH", `index.channels.${name} must point to the imported channel digest`, `index.channels.${name}`);
  }

  return bundle as RegistryExportBundle;
}

function readBundle(bundlePath: string): RegistryExportBundle {
  assertExistingFile(bundlePath, "--bundle");
  let raw: string;
  try {
    raw = fs.readFileSync(bundlePath, "utf8");
  } catch (error) {
    fail("REGISTRY_IMPORT_READ_FAILED", `failed to read bundle: ${error instanceof Error ? error.message : String(error)}`, bundlePath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail("REGISTRY_IMPORT_INVALID_JSON", `bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, bundlePath);
  }
  return assertBundle(parsed);
}

function assertExistingFile(file: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`${label} does not exist: ${file}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${label} must be a file: ${file}`);
}

function assertSafeOutputParents(output: string): void {
  let current = path.dirname(output);
  while (true) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`--output parent must not contain symlinks: ${current}`);
      if (!stat.isDirectory()) throw new Error(`--output parent must be a directory: ${current}`);
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertWritableOutputDirectory(output: string): void {
  assertSafeOutputParents(output);
  if (!fs.existsSync(output)) return;
  const stat = fs.lstatSync(output);
  if (stat.isSymbolicLink()) throw new Error("--output must not be a symlink");
  if (!stat.isDirectory()) throw new Error(`--output must be a directory: ${output}`);
  if (fs.readdirSync(output).length > 0) throw new Error(`--output must be an empty directory: ${output}`);
}

export function normalizeRegistryImportArgs(args: RegistryImportArgs): RegistryImportInput {
  if (!args.bundle) throw new Error("Missing --bundle");
  if (!args.output) throw new Error("Missing --output");
  const bundle = path.resolve(args.bundle);
  const output = path.resolve(args.output);
  assertExistingFile(bundle, "--bundle");
  assertWritableOutputDirectory(output);
  return { bundle, output, strict: args.strict === true };
}

function blockedResult(input: RegistryImportInput, finding: RegistryImportFinding): RegistryImportResult {
  return {
    schemaVersion: 1,
    command: "registry-import",
    status: "BLOCKED",
    bundle: input.bundle,
    output: input.output,
    strict: input.strict,
    format: "",
    registryName: "",
    provenance: "UNVERIFIED",
    files: [],
    findings: [finding],
  };
}

export function runRegistryImport(input: RegistryImportInput): RegistryImportResult {
  try {
    const bundle = readBundle(input.bundle);
    const documents = buildImportDocuments(bundle).sort((a, b) => a.path.localeCompare(b.path));
    return {
      schemaVersion: 1,
      command: "registry-import",
      status: "PASS",
      bundle: input.bundle,
      output: input.output,
      strict: input.strict,
      format: bundle.format,
      registryName: bundle.registryName,
      provenance: "UNVERIFIED",
      files: documents.map((document) => document.path),
      findings: [],
    };
  } catch (error) {
    const finding = error instanceof RegistryImportValidationError
      ? { level: "ERROR" as const, code: error.code, message: error.message, ...(error.findingPath ? { path: error.findingPath } : {}) }
      : { level: "ERROR" as const, code: "REGISTRY_IMPORT_INVALID_BUNDLE", message: error instanceof Error ? error.message : String(error) };
    return blockedResult(input, finding);
  }
}

export function writeRegistryImportOutputs(outputPath: string, bundle: RegistryExportBundle): string[] {
  const validated = assertBundle(bundle);
  const output = path.resolve(outputPath);
  assertWritableOutputDirectory(output);
  fs.mkdirSync(output, { recursive: true });
  const documents = buildImportDocuments(validated).sort((a, b) => a.path.localeCompare(b.path));
  for (const document of documents) {
    writeFileAtomicSafe(path.join(output, document.path), canonicalDocument(document.document));
  }
  return documents.map((document) => path.join(output, document.path));
}

export function importRegistryBundle(input: RegistryImportInput): RegistryImportResult {
  const result = runRegistryImport(input);
  if (result.status === "BLOCKED") return result;
  const bundle = readBundle(input.bundle);
  writeRegistryImportOutputs(input.output, bundle);
  return result;
}

export function renderRegistryImportResult(result: RegistryImportResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status}`,
    `Registry: ${result.registryName || "<invalid>"}`,
    `Bundle: ${result.bundle}`,
    `Output: ${result.output}`,
    `Format: ${result.format || "<invalid>"}`,
    `Provenance: ${result.provenance}`,
    `Files: ${result.files.length}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const file of result.files) lines.push(`- ${file}`);
  for (const finding of result.findings) lines.push(`- [${finding.level} ${finding.code}] ${finding.message}`);
  return lines.join("\n");
}
