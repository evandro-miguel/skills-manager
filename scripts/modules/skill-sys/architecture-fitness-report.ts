import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  evaluateArchitectureFitness,
  parseArchitectureBoundaryManifest,
  parseArchitectureDependencyGraph,
  type ArchitectureBoundaryManifest,
  type ArchitectureDependencyGraph,
  type ArchitectureFitnessFindingCode,
  type BoundaryClassification,
} from "./architecture-fitness.ts";

const REPORT_V1_SCHEMA_VERSION = 1 as const;
const REPORT_V1_COHORT_ID = "F-03.03-report-v1" as const;
const REPORT_V2_SCHEMA_VERSION = 2 as const;
const REPORT_V2_COHORT_ID = "F-03.03-report-v2" as const;
const REPORT_V3_SCHEMA_VERSION = 3 as const;
const REPORT_V3_COHORT_ID = "F-03.03-report-v3" as const;
const REPORT_V4_SCHEMA_VERSION = 4 as const;
const REPORT_V4_COHORT_ID = "F-03.03-report-v4" as const;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const UNPAIRED_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;
const URL_SCHEME_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const RAW_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const NODE_SPECIFIER_PATTERN = /^node:[A-Za-z0-9_./-]+$/u;
const CREDENTIAL_SPECIFIER_PATTERN =
  /(?:^|\s)Bearer\s+\S+|(?:^|[^A-Za-z0-9])(?:ghp_[A-Za-z0-9._-]+|sk-proj-[A-Za-z0-9._-]+|AKIA[A-Z0-9]+)(?:$|[^A-Za-z0-9._-])/iu;
const EMBEDDED_CREDENTIAL_PATTERN =
  /(?:^|[/:])[^/@\s:]+:[^/@\s]+@|(?:authorization|credential|password|passwd|token|secret|api[_-]?key)\s*[:=]/iu;
const HOSTILE_TEXT_PATTERN =
  /-----BEGIN|\\|(?:^|\s)\/(?:home|Users|tmp|var|etc)\//iu;

export type ArchitectureFitnessReportV1Classification = Exclude<
  BoundaryClassification,
  "catalog-public-target" | "application-catalog-read-port-target"
>;
export type ArchitectureFitnessReportV2Classification =
  BoundaryClassification;

const REPORT_V1_CLASSIFICATIONS =
  new Set<ArchitectureFitnessReportV1Classification>([
    "contract-leaf",
    "source-public-target",
    "source-internal-target",
    "application-target",
    "adapter-target",
    "planning-public-target",
    "remove-compatibility-facade",
    "interface-observed",
    "legacy-observed",
    "legacy-compatibility",
    "legacy-support",
  ]);
const REPORT_V2_CLASSIFICATIONS =
  new Set<ArchitectureFitnessReportV2Classification>([
    ...REPORT_V1_CLASSIFICATIONS,
    "catalog-public-target",
    "application-catalog-read-port-target",
  ]);

const FINDING_CODES = new Set<ArchitectureFitnessFindingCode>([
  "AMBIGUOUS_CLASSIFICATION",
  "CYCLE",
  "DUPLICATE_ID",
  "DUPLICATE_PATH",
  "EDGE_OUTSIDE_GRAPH",
  "FORBIDDEN_DEPENDENCY",
  "INVALID_EXCEPTION",
  "INVALID_GRAPH",
  "INVALID_MANIFEST",
  "INVALID_PATH",
  "STALE_EXCEPTION",
  "UNCLASSIFIED_PATH",
]);

export type ArchitectureFitnessReportV1 = Readonly<{
  schemaVersion: 1;
  cohortId: "F-03.03-report-v1";
  evaluatedRevision: string;
  manifest: Readonly<{
    schemaVersion: 2;
    openingRevision: string;
    digest: string;
  }>;
  graph: Readonly<{
    digest: string;
    fileCount: number;
    internalEdgeCount: number;
    externalDependencyCount: number;
  }>;
  classificationCounts: readonly Readonly<{
    classification: ArchitectureFitnessReportV1Classification;
    count: number;
  }>[];
  outcome: Readonly<{
    ok: boolean;
    findingCount: number;
    cycleCount: number;
  }>;
  findings: readonly Readonly<{
    code: ArchitectureFitnessFindingCode;
    path: string;
  }>[];
  cycles: readonly (readonly string[])[];
  exceptions: Readonly<{
    declaredIds: readonly string[];
    usedIds: readonly string[];
    unusedAcceptedIds: readonly string[];
    retiredIds: readonly string[];
  }>;
  reportDigest: string;
}>;

export type ArchitectureFitnessReportV2 = Readonly<{
  schemaVersion: 2;
  cohortId: "F-03.03-report-v2";
  evaluatedRevision: string;
  manifest: Readonly<{
    schemaVersion: 3;
    openingRevision: string;
    digest: string;
  }>;
  graph: ArchitectureFitnessReportV1["graph"];
  classificationCounts: readonly Readonly<{
    classification: ArchitectureFitnessReportV2Classification;
    count: number;
  }>[];
  outcome: ArchitectureFitnessReportV1["outcome"];
  findings: ArchitectureFitnessReportV1["findings"];
  cycles: ArchitectureFitnessReportV1["cycles"];
  exceptions: ArchitectureFitnessReportV1["exceptions"];
  reportDigest: string;
}>;

export type ArchitectureFitnessReportV3 = Readonly<{
  schemaVersion: 3;
  cohortId: "F-03.03-report-v3";
  evaluatedRevision: string;
  manifest: Readonly<{
    schemaVersion: 4;
    openingRevision: string;
    digest: string;
  }>;
  graph: ArchitectureFitnessReportV1["graph"];
  classificationCounts: readonly Readonly<{
    classification: ArchitectureFitnessReportV2Classification;
    count: number;
  }>[];
  outcome: ArchitectureFitnessReportV1["outcome"];
  findings: ArchitectureFitnessReportV1["findings"];
  cycles: ArchitectureFitnessReportV1["cycles"];
  exceptions: ArchitectureFitnessReportV1["exceptions"];
  reportDigest: string;
}>;

export type ArchitectureFitnessReportV4 = Readonly<{
  schemaVersion: 4;
  cohortId: "F-03.03-report-v4";
  evaluatedRevision: string;
  manifest: Readonly<{
    schemaVersion: 5;
    openingRevision: string;
    digest: string;
  }>;
  graph: ArchitectureFitnessReportV1["graph"];
  classificationCounts: readonly Readonly<{
    classification: ArchitectureFitnessReportV2Classification;
    count: number;
  }>[];
  outcome: ArchitectureFitnessReportV1["outcome"];
  findings: ArchitectureFitnessReportV1["findings"];
  cycles: ArchitectureFitnessReportV1["cycles"];
  exceptions: ArchitectureFitnessReportV1["exceptions"];
  reportDigest: string;
}>;

export type ArchitectureFitnessReport =
  | ArchitectureFitnessReportV1
  | ArchitectureFitnessReportV2
  | ArchitectureFitnessReportV3
  | ArchitectureFitnessReportV4;

export class ArchitectureFitnessReportError extends Error {
  readonly code:
    | "INVALID_REPORT_INPUT"
    | "INVALID_REPORT_VALUE"
    | "REPORT_DIGEST_MISMATCH";

  constructor(
    code:
      | "INVALID_REPORT_INPUT"
      | "INVALID_REPORT_VALUE"
      | "REPORT_DIGEST_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ArchitectureFitnessReportError";
    this.code = code;
    Object.freeze(this);
  }
}

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | CanonicalObject;

interface CanonicalObject {
  readonly [key: string]: CanonicalValue;
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(
  code: ArchitectureFitnessReportError["code"],
  message: string,
): never {
  throw new ArchitectureFitnessReportError(code, message);
}

function inspectPlainData(value: unknown, seen = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_REPORT_INPUT", "non-finite number");
    return;
  }
  if (typeof value !== "object") {
    fail("INVALID_REPORT_INPUT", "unsupported value");
  }
  let proxied: boolean;
  try {
    proxied = types.isProxy(value);
  } catch {
    fail("INVALID_REPORT_INPUT", "hostile proxy");
  }
  if (proxied) fail("INVALID_REPORT_INPUT", "proxy value");
  if (seen.has(value)) fail("INVALID_REPORT_INPUT", "cyclic value");
  seen.add(value);

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail("INVALID_REPORT_INPUT", "hostile object");
  }
  const array = Array.isArray(value);
  if (
    (array && prototype !== Array.prototype) ||
    (!array && prototype !== Object.prototype && prototype !== null)
  ) {
    fail("INVALID_REPORT_INPUT", "exotic object");
  }
  if (
    array &&
    Object.keys(descriptors).filter((key) => key !== "length").length !==
      value.length
  ) {
    fail("INVALID_REPORT_INPUT", "sparse array");
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail("INVALID_REPORT_INPUT", "symbol key");
    if (array && key === "length") continue;
    if (
      array &&
      (!/^(?:0|[1-9][0-9]*)$/u.test(key) ||
        Number(key) >= (value as unknown[]).length)
    ) {
      fail("INVALID_REPORT_INPUT", "unknown array field");
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      fail("INVALID_REPORT_INPUT", "accessor or hidden field");
    }
    inspectPlainData(descriptor.value, seen);
  }
  seen.delete(value);
}

function exactRecord(
  value: unknown,
  requiredKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_REPORT_INPUT", "expected object");
  }
  const keys = Object.keys(value).sort(asciiCompare);
  const expected = [...requiredKeys].sort(asciiCompare);
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    return fail("INVALID_REPORT_INPUT", "unknown or missing field");
  }
  return value as Record<string, unknown>;
}

function safePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//u.test(value) ||
    value.includes("\\") ||
    stringIsUnsafe(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

function stringIsUnsafe(value: string): boolean {
  return (
    CONTROL_CHARACTER_PATTERN.test(value) ||
    UNPAIRED_SURROGATE_PATTERN.test(value) ||
    URL_SCHEME_PATTERN.test(value) ||
    EMBEDDED_CREDENTIAL_PATTERN.test(value) ||
    HOSTILE_TEXT_PATTERN.test(value)
  );
}

function assertSafeText(value: unknown): void {
  if (typeof value === "string") {
    if (stringIsUnsafe(value)) {
      fail("INVALID_REPORT_INPUT", "hostile text");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) assertSafeText(child);
}

function assertSafeDependencySpecifiers(
  graph: ArchitectureDependencyGraph,
): void {
  for (const specifier of [
    ...graph.edges.map((edge) => edge.specifier),
    ...(graph.externalDependencies ?? []).map(
      (dependency) => dependency.specifier,
    ),
  ]) {
    if (
      specifier.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(specifier) ||
      specifier.includes("\\") ||
      (RAW_SCHEME_PATTERN.test(specifier) &&
        !NODE_SPECIFIER_PATTERN.test(specifier)) ||
      CREDENTIAL_SPECIFIER_PATTERN.test(specifier) ||
      stringIsUnsafe(specifier)
    ) {
      fail("INVALID_REPORT_INPUT", "unsafe dependency specifier");
    }
  }
}

function canonicalize(value: unknown): CanonicalValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value).sort(asciiCompare)) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return fail("INVALID_REPORT_INPUT", "non-canonical value");
}

function canonicalBytes(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalBytes(value), "utf8").digest("hex");
}

function tupleCompare(
  left: readonly (string | number | boolean)[],
  right: readonly (string | number | boolean)[],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    const comparison =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : typeof leftValue === "boolean" && typeof rightValue === "boolean"
          ? Number(leftValue) - Number(rightValue)
          : asciiCompare(String(leftValue), String(rightValue));
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function normalizeManifest(
  manifest: ArchitectureBoundaryManifest,
): ArchitectureBoundaryManifest {
  return {
    schemaVersion: manifest.schemaVersion,
    openingRevision: manifest.openingRevision,
    rules: [...manifest.rules]
      .map((rule) => ({
        ...rule,
        selector: { ...rule.selector },
        ...(rule.exclusions === undefined
          ? {}
          : {
              exclusions: [...rule.exclusions]
                .map((selector) => ({ ...selector }))
                .sort((left, right) =>
                  tupleCompare(
                    [left.kind, left.path],
                    [right.kind, right.path],
                  ),
                ),
            }),
      }))
      .sort((left, right) =>
        tupleCompare(
          [left.id, left.selector.kind, left.selector.path],
          [right.id, right.selector.kind, right.selector.path],
        ),
      ),
    forbiddenDependencies: [...manifest.forbiddenDependencies]
      .map((dependency) => ({ ...dependency }))
      .sort((left, right) =>
        tupleCompare(
          [left.id, left.from, left.to],
          [right.id, right.from, right.to],
        ),
      ),
    openingEdges: [...manifest.openingEdges]
      .map((edge) => ({ ...edge }))
      .sort((left, right) =>
        tupleCompare([left.from, left.to], [right.from, right.to]),
      ),
    exceptions: [...manifest.exceptions]
      .map((exception) => ({ ...exception }))
      .sort((left, right) =>
        tupleCompare(
          [left.id, left.from, left.to, left.forbiddenDependencyId],
          [right.id, right.from, right.to, right.forbiddenDependencyId],
        ),
      ),
  };
}

function normalizeGraph(
  graph: ArchitectureDependencyGraph,
): Required<ArchitectureDependencyGraph> {
  return {
    files: [...graph.files].sort(asciiCompare),
    edges: [...graph.edges]
      .map((edge) => ({ ...edge }))
      .sort((left, right) =>
        tupleCompare(
          [
            left.from,
            left.to,
            left.specifier,
            left.syntax,
            left.typeOnly,
            left.line,
            left.column,
          ],
          [
            right.from,
            right.to,
            right.specifier,
            right.syntax,
            right.typeOnly,
            right.line,
            right.column,
          ],
        ),
      ),
    externalDependencies: [...(graph.externalDependencies ?? [])]
      .map((dependency) => ({ ...dependency }))
      .sort((left, right) =>
        tupleCompare(
          [
            left.from,
            left.specifier,
            left.syntax,
            left.typeOnly,
            left.line,
            left.column,
          ],
          [
            right.from,
            right.specifier,
            right.syntax,
            right.typeOnly,
            right.line,
            right.column,
          ],
        ),
      ),
  };
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createArchitectureFitnessReport(
  input: unknown,
): ArchitectureFitnessReport {
  try {
    inspectPlainData(input);
    const record = exactRecord(input, [
      "evaluatedRevision",
      "manifest",
      "graph",
    ]);
    if (
      typeof record.evaluatedRevision !== "string" ||
      !REVISION_PATTERN.test(record.evaluatedRevision)
    ) {
      return fail("INVALID_REPORT_INPUT", "invalid evaluated revision");
    }
    assertSafeText(record.manifest);
    assertSafeText(record.graph);
    const parsedManifest = parseArchitectureBoundaryManifest(record.manifest);
    const parsedGraph = parseArchitectureDependencyGraph(record.graph);
    if (!parsedManifest.ok || !parsedGraph.ok) {
      return fail("INVALID_REPORT_INPUT", "invalid manifest or graph");
    }
    const manifest = normalizeManifest(parsedManifest.value);
    const graph = normalizeGraph(parsedGraph.value);
    const reportIdentity =
      manifest.schemaVersion === 2
        ? {
            schemaVersion: REPORT_V1_SCHEMA_VERSION,
            cohortId: REPORT_V1_COHORT_ID,
          }
        : manifest.schemaVersion === 3
          ? {
              schemaVersion: REPORT_V2_SCHEMA_VERSION,
              cohortId: REPORT_V2_COHORT_ID,
            }
          : manifest.schemaVersion === 4
            ? {
                schemaVersion: REPORT_V3_SCHEMA_VERSION,
                cohortId: REPORT_V3_COHORT_ID,
              }
            : manifest.schemaVersion === 5
              ? {
                  schemaVersion: REPORT_V4_SCHEMA_VERSION,
                  cohortId: REPORT_V4_COHORT_ID,
                }
              : fail("INVALID_REPORT_INPUT", "unsupported manifest version");
    assertSafeDependencySpecifiers(graph);
    const result = evaluateArchitectureFitness(manifest, graph);
    const fileSet = new Set(graph.files);
    if (result.findings.some((finding) => !fileSet.has(finding.path))) {
      return fail(
        "INVALID_REPORT_INPUT",
        "evaluator diagnostic is not a governed graph path",
      );
    }

    const counts = new Map<BoundaryClassification, number>();
    for (const classification of result.classifications) {
      counts.set(
        classification.classification,
        (counts.get(classification.classification) ?? 0) + 1,
      );
    }
    const declaredIds = manifest.exceptions
      .map((exception) => exception.id)
      .sort(asciiCompare);
    const acceptedIds = manifest.exceptions
      .filter((exception) => exception.reviewStatus === "accepted")
      .map((exception) => exception.id);
    const usedIds = [...result.usedExceptionIds].sort(asciiCompare);
    const usedSet = new Set(usedIds);
    const payload = {
      ...reportIdentity,
      evaluatedRevision: record.evaluatedRevision,
      manifest: {
        schemaVersion: manifest.schemaVersion,
        openingRevision: manifest.openingRevision,
        digest: sha256(manifest),
      },
      graph: {
        digest: sha256(graph),
        fileCount: graph.files.length,
        internalEdgeCount: graph.edges.length,
        externalDependencyCount: graph.externalDependencies.length,
      },
      classificationCounts: [...counts.entries()]
        .map(([classification, count]) => ({ classification, count }))
        .sort((left, right) =>
          asciiCompare(left.classification, right.classification),
        ),
      outcome: {
        ok: result.ok,
        findingCount: result.findings.length,
        cycleCount: result.cycles.length,
      },
      findings: result.findings
        .map(({ code, path }) => ({ code, path }))
        .sort(
          (left, right) =>
            asciiCompare(left.path, right.path) ||
            asciiCompare(left.code, right.code),
        ),
      cycles: result.cycles.map((cycle) => [...cycle]),
      exceptions: {
        declaredIds,
        usedIds,
        unusedAcceptedIds: acceptedIds
          .filter((id) => !usedSet.has(id))
          .sort(asciiCompare),
        retiredIds: manifest.exceptions
          .filter((exception) => exception.reviewStatus === "retired")
          .map((exception) => exception.id)
          .sort(asciiCompare),
      },
    };
    return deepFreeze({
      ...payload,
      reportDigest: sha256(payload),
    }) as ArchitectureFitnessReport;
  } catch (error) {
    if (error instanceof ArchitectureFitnessReportError) throw error;
    return fail("INVALID_REPORT_INPUT", "hostile report input");
  }
}

function requireString(
  value: unknown,
  pattern?: RegExp,
): asserts value is string {
  if (
    typeof value !== "string" ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    fail("INVALID_REPORT_VALUE", "invalid string");
  }
}

function requireInteger(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    fail("INVALID_REPORT_VALUE", "invalid count");
  }
}

function requireStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) fail("INVALID_REPORT_VALUE", "invalid string list");
  for (const entry of value) {
    requireString(entry);
    if (
      entry.length === 0 ||
      entry.includes("/") ||
      entry.includes("\\") ||
      stringIsUnsafe(entry)
    ) {
      fail("INVALID_REPORT_VALUE", "invalid identifier");
    }
  }
}

function arrayIsAsciiSortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) =>
      index === 0 || asciiCompare(values[index - 1]!, value) < 0,
  );
}

function arrayIsAsciiSorted(values: readonly string[]): boolean {
  return values.every(
    (value, index) =>
      index === 0 || asciiCompare(values[index - 1]!, value) <= 0,
  );
}

function validateReport(value: unknown): ArchitectureFitnessReport {
  try {
    inspectPlainData(value);
    const report = exactRecord(value, [
      "schemaVersion",
      "cohortId",
      "evaluatedRevision",
      "manifest",
      "graph",
      "classificationCounts",
      "outcome",
      "findings",
      "cycles",
      "exceptions",
      "reportDigest",
    ]);
    const reportIdentity =
      report.schemaVersion === REPORT_V1_SCHEMA_VERSION &&
      report.cohortId === REPORT_V1_COHORT_ID
        ? {
            manifestVersion: 2 as const,
            classifications: REPORT_V1_CLASSIFICATIONS,
          }
        : report.schemaVersion === REPORT_V2_SCHEMA_VERSION &&
            report.cohortId === REPORT_V2_COHORT_ID
          ? {
              manifestVersion: 3 as const,
              classifications: REPORT_V2_CLASSIFICATIONS,
            }
          : report.schemaVersion === REPORT_V3_SCHEMA_VERSION &&
              report.cohortId === REPORT_V3_COHORT_ID
            ? {
                manifestVersion: 4 as const,
                classifications: REPORT_V2_CLASSIFICATIONS,
              }
            : report.schemaVersion === REPORT_V4_SCHEMA_VERSION &&
                report.cohortId === REPORT_V4_COHORT_ID
              ? {
                  manifestVersion: 5 as const,
                  classifications: REPORT_V2_CLASSIFICATIONS,
                }
              : fail("INVALID_REPORT_VALUE", "unsupported report version");
    requireString(report.evaluatedRevision, REVISION_PATTERN);
    requireString(report.reportDigest, DIGEST_PATTERN);

    const manifest = exactRecord(report.manifest, [
      "schemaVersion",
      "openingRevision",
      "digest",
    ]);
    if (manifest.schemaVersion !== reportIdentity.manifestVersion) {
      return fail("INVALID_REPORT_VALUE", "invalid manifest version");
    }
    requireString(manifest.openingRevision, REVISION_PATTERN);
    requireString(manifest.digest, DIGEST_PATTERN);

    const graph = exactRecord(report.graph, [
      "digest",
      "fileCount",
      "internalEdgeCount",
      "externalDependencyCount",
    ]);
    requireString(graph.digest, DIGEST_PATTERN);
    requireInteger(graph.fileCount);
    requireInteger(graph.internalEdgeCount);
    requireInteger(graph.externalDependencyCount);

    if (!Array.isArray(report.classificationCounts)) {
      return fail("INVALID_REPORT_VALUE", "invalid classifications");
    }
    const allowedClassifications: ReadonlySet<BoundaryClassification> =
      reportIdentity.classifications;
    for (const entry of report.classificationCounts) {
      const count = exactRecord(entry, ["classification", "count"]);
      if (
        !allowedClassifications.has(
          count.classification as BoundaryClassification,
        )
      ) {
        return fail("INVALID_REPORT_VALUE", "invalid classification");
      }
      requireInteger(count.count);
      if (count.count === 0) {
        return fail("INVALID_REPORT_VALUE", "empty classification count");
      }
    }

    const outcome = exactRecord(report.outcome, [
      "ok",
      "findingCount",
      "cycleCount",
    ]);
    if (typeof outcome.ok !== "boolean") {
      return fail("INVALID_REPORT_VALUE", "invalid outcome");
    }
    requireInteger(outcome.findingCount);
    requireInteger(outcome.cycleCount);

    if (!Array.isArray(report.findings)) {
      return fail("INVALID_REPORT_VALUE", "invalid findings");
    }
    for (const entry of report.findings) {
      const finding = exactRecord(entry, ["code", "path"]);
      if (!FINDING_CODES.has(finding.code as ArchitectureFitnessFindingCode)) {
        return fail("INVALID_REPORT_VALUE", "invalid finding code");
      }
      if (!safePath(finding.path)) {
        return fail("INVALID_REPORT_VALUE", "invalid finding path");
      }
    }
    if (!Array.isArray(report.cycles)) {
      return fail("INVALID_REPORT_VALUE", "invalid cycles");
    }
    for (const cycle of report.cycles) {
      if (!Array.isArray(cycle) || cycle.length === 0 || !cycle.every(safePath)) {
        return fail("INVALID_REPORT_VALUE", "invalid cycle");
      }
    }

    const exceptions = exactRecord(report.exceptions, [
      "declaredIds",
      "usedIds",
      "unusedAcceptedIds",
      "retiredIds",
    ]);
    requireStringArray(exceptions.declaredIds);
    requireStringArray(exceptions.usedIds);
    requireStringArray(exceptions.unusedAcceptedIds);
    requireStringArray(exceptions.retiredIds);
    const classificationNames = report.classificationCounts.map(
      (entry) => (entry as { classification: string }).classification,
    );
    if (!arrayIsAsciiSortedUnique(classificationNames)) {
      return fail("INVALID_REPORT_VALUE", "non-canonical classifications");
    }
    const findingKeys = report.findings.map((entry) => {
      const finding = entry as { path: string; code: string };
      return `${finding.path}\u0000${finding.code}`;
    });
    if (!arrayIsAsciiSorted(findingKeys)) {
      return fail("INVALID_REPORT_VALUE", "non-canonical findings");
    }
    const cycleKeys = report.cycles.map((cycle) => {
      const members = cycle as string[];
      if (!arrayIsAsciiSortedUnique(members)) {
        return fail("INVALID_REPORT_VALUE", "non-canonical cycle");
      }
      return members.join("\u0000");
    });
    if (!arrayIsAsciiSortedUnique(cycleKeys)) {
      return fail("INVALID_REPORT_VALUE", "non-canonical cycles");
    }
    for (const values of [
      exceptions.declaredIds,
      exceptions.usedIds,
      exceptions.unusedAcceptedIds,
      exceptions.retiredIds,
    ]) {
      if (!arrayIsAsciiSortedUnique(values)) {
        return fail("INVALID_REPORT_VALUE", "non-canonical exception ledger");
      }
    }
    const declaredSet = new Set(exceptions.declaredIds);
    const ledgerIds = [
      ...exceptions.usedIds,
      ...exceptions.unusedAcceptedIds,
      ...exceptions.retiredIds,
    ];
    if (
      ledgerIds.some((id) => !declaredSet.has(id)) ||
      new Set(ledgerIds).size !== ledgerIds.length ||
      ledgerIds.length !== declaredSet.size
    ) {
      return fail("INVALID_REPORT_VALUE", "inconsistent exception ledger");
    }
    const cycleFindingCount = report.findings.filter(
      (entry) =>
        (entry as { code: ArchitectureFitnessFindingCode }).code === "CYCLE",
    ).length;
    const classificationTotal = report.classificationCounts.reduce(
      (total, entry) => total + (entry as { count: number }).count,
      0,
    );
    const hasClassificationGap = report.findings.some((entry) => {
      const code = (entry as { code: ArchitectureFitnessFindingCode }).code;
      return (
        code === "UNCLASSIFIED_PATH" ||
        code === "AMBIGUOUS_CLASSIFICATION"
      );
    });
    if (
      outcome.findingCount !== report.findings.length ||
      outcome.cycleCount !== report.cycles.length ||
      outcome.ok !== (outcome.findingCount === 0) ||
      cycleFindingCount !== outcome.cycleCount ||
      classificationTotal > graph.fileCount ||
      (!hasClassificationGap && classificationTotal !== graph.fileCount)
    ) {
      return fail("INVALID_REPORT_VALUE", "inconsistent outcome");
    }
    return report as unknown as ArchitectureFitnessReport;
  } catch (error) {
    if (error instanceof ArchitectureFitnessReportError) throw error;
    return fail("INVALID_REPORT_VALUE", "hostile report value");
  }
}

export function serializeArchitectureFitnessReport(reportInput: unknown): string {
  const report = validateReport(reportInput);
  const { reportDigest, ...payload } = report;
  if (sha256(payload) !== reportDigest) {
    return fail("REPORT_DIGEST_MISMATCH", "report digest mismatch");
  }
  return `${JSON.stringify(canonicalize(report), null, 2)}\n`;
}
