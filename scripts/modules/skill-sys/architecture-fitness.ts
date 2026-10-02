export type BoundaryClassification =
  | "contract-leaf"
  | "source-public-target"
  | "source-internal-target"
  | "application-target"
  | "adapter-target"
  | "planning-public-target"
  | "catalog-public-target"
  | "application-catalog-read-port-target"
  | "remove-compatibility-facade"
  | "interface-observed"
  | "legacy-observed"
  | "legacy-compatibility"
  | "legacy-support";

export type BoundarySelector =
  | Readonly<{ kind: "exact"; path: string }>
  | Readonly<{ kind: "prefix"; path: string }>;

export type BoundaryRule = Readonly<{
  id: string;
  selector: BoundarySelector;
  exclusions?: readonly BoundarySelector[];
  classification: BoundaryClassification;
  owner: string;
  visibility: string;
  effect: string;
  lifecycle: string;
}>;

export type ForbiddenDependency = Readonly<{
  id: string;
  from: BoundaryClassification;
  to: BoundaryClassification | "*";
}>;

export type OpeningDependencyEdge = Readonly<{ from: string; to: string }>;

export type BoundaryException = Readonly<{
  id: string;
  from: string;
  to: string;
  forbiddenDependencyId: string;
  rationale: string;
  compatibilityConsumer: string;
  owningRoadmapFeature: string;
  creationRevision: string;
  reviewStatus: "accepted" | "retired";
  validThroughManifestVersion: number;
  openingRevision: string;
  owner: string;
  retirementCondition: string;
  retirementTargetChild: string;
  evidenceReference: string;
}>;

export type ArchitectureBoundaryManifest = Readonly<{
  schemaVersion: 2 | 3 | 4 | 5;
  openingRevision: string;
  rules: readonly BoundaryRule[];
  forbiddenDependencies: readonly ForbiddenDependency[];
  openingEdges: readonly OpeningDependencyEdge[];
  exceptions: readonly BoundaryException[];
}>;

export type ArchitectureDependencySyntax =
  | "static-import"
  | "re-export"
  | "import-equals"
  | "commonjs-require"
  | "dynamic-import";

export type ArchitectureDependencyEdge = Readonly<{
  from: string;
  to: string;
  specifier: string;
  syntax: ArchitectureDependencySyntax;
  typeOnly: boolean;
  line: number;
  column: number;
}>;

export type ArchitectureDependencyGraph = Readonly<{
  files: readonly string[];
  edges: readonly ArchitectureDependencyEdge[];
  externalDependencies?: readonly Readonly<{
    from: string;
    specifier: string;
    syntax: ArchitectureDependencySyntax;
    typeOnly: boolean;
    line: number;
    column: number;
  }>[];
}>;

export type ArchitectureFitnessFindingCode =
  | "AMBIGUOUS_CLASSIFICATION"
  | "CYCLE"
  | "DUPLICATE_ID"
  | "DUPLICATE_PATH"
  | "EDGE_OUTSIDE_GRAPH"
  | "FORBIDDEN_DEPENDENCY"
  | "INVALID_EXCEPTION"
  | "INVALID_GRAPH"
  | "INVALID_MANIFEST"
  | "INVALID_PATH"
  | "STALE_EXCEPTION"
  | "UNCLASSIFIED_PATH";

export type ArchitectureFitnessFinding = Readonly<{
  code: ArchitectureFitnessFindingCode;
  path: string;
  detail: string;
}>;

export type ArchitecturePathClassification = Readonly<{
  path: string;
  ruleId: string;
  classification: BoundaryClassification;
}>;

export type ArchitectureFitnessResult = Readonly<{
  ok: boolean;
  classifications: readonly ArchitecturePathClassification[];
  findings: readonly ArchitectureFitnessFinding[];
  cycles: readonly (readonly string[])[];
  usedExceptionIds: readonly string[];
}>;

export const ARCHITECTURE_OPENING_REVISION =
  "6d0a2728ea39da64b09177edc71ae364fdcb1325" as const;

const DEPENDENCY_SYNTAXES = new Set<ArchitectureDependencySyntax>([
  "static-import",
  "re-export",
  "import-equals",
  "commonjs-require",
  "dynamic-import",
]);
const CLASSIFICATIONS = new Set<BoundaryClassification>([
  "contract-leaf",
  "source-public-target",
  "source-internal-target",
  "application-target",
  "adapter-target",
  "planning-public-target",
  "catalog-public-target",
  "application-catalog-read-port-target",
  "remove-compatibility-facade",
  "interface-observed",
  "legacy-observed",
  "legacy-compatibility",
  "legacy-support",
]);

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFindings(
  left: ArchitectureFitnessFinding,
  right: ArchitectureFitnessFinding,
): number {
  return (
    asciiCompare(left.path, right.path) ||
    asciiCompare(left.code, right.code) ||
    asciiCompare(left.detail, right.detail)
  );
}

function isSafeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//u.test(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function selectorIsValid(selector: BoundarySelector): boolean {
  return (
    (selector.kind === "exact" || selector.kind === "prefix") &&
    isSafeRelativePath(
      selector.kind === "prefix" && selector.path.endsWith("/")
        ? selector.path.slice(0, -1)
        : selector.path,
    ) &&
    (selector.kind !== "prefix" || selector.path.endsWith("/"))
  );
}

function selectorMatches(selector: BoundarySelector, path: string): boolean {
  return selector.kind === "exact" ? path === selector.path : path.startsWith(selector.path);
}

function ruleMatches(rule: BoundaryRule, path: string): boolean {
  return (
    selectorMatches(rule.selector, path) &&
    !(rule.exclusions ?? []).some((selector) => selectorMatches(selector, path))
  );
}

function edgeKey(edge: OpeningDependencyEdge): string {
  return `${edge.from}\u0000${edge.to}`;
}

function finding(
  code: ArchitectureFitnessFindingCode,
  path: string,
  detail: string,
): ArchitectureFitnessFinding {
  return Object.freeze({ code, path, detail });
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort(asciiCompare);
}

type ParseResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; findings: readonly ArchitectureFitnessFinding[] }>;

function isPlainDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) return false;
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) return false;
  }
  for (const key of ownKeys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (
      property === undefined ||
      property.enumerable !== true ||
      !Object.hasOwn(property, "value")
    ) {
      return false;
    }
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSelectorValue(value: unknown): value is BoundarySelector {
  return (
    isPlainDataRecord(value, ["kind", "path"]) &&
    (value.kind === "exact" || value.kind === "prefix") &&
    typeof value.path === "string" &&
    selectorIsValid(value as unknown as BoundarySelector)
  );
}

function manifestStructureIsValid(value: unknown): value is ArchitectureBoundaryManifest {
  if (
    !isPlainDataRecord(value, [
      "schemaVersion",
      "openingRevision",
      "rules",
      "forbiddenDependencies",
      "openingEdges",
      "exceptions",
    ]) ||
    (value.schemaVersion !== 2 &&
      value.schemaVersion !== 3 &&
      value.schemaVersion !== 4 &&
      value.schemaVersion !== 5) ||
    typeof value.openingRevision !== "string" ||
    !Array.isArray(value.rules) ||
    !Array.isArray(value.forbiddenDependencies) ||
    !Array.isArray(value.openingEdges) ||
    !Array.isArray(value.exceptions)
  ) {
    return false;
  }

  const rulesValid = value.rules.every((entry) => {
    if (
      !isPlainDataRecord(
        entry,
        ["id", "selector", "classification", "owner", "visibility", "effect", "lifecycle"],
        ["exclusions"],
      ) ||
      !isNonEmptyString(entry.id) ||
      !isSelectorValue(entry.selector) ||
      !CLASSIFICATIONS.has(entry.classification as BoundaryClassification) ||
      !isNonEmptyString(entry.owner) ||
      !isNonEmptyString(entry.visibility) ||
      !isNonEmptyString(entry.effect) ||
      !isNonEmptyString(entry.lifecycle)
    ) {
      return false;
    }
    return (
      entry.exclusions === undefined ||
      (Array.isArray(entry.exclusions) && entry.exclusions.every(isSelectorValue))
    );
  });
  const versionVocabularyValid =
    value.schemaVersion === 3 ||
    value.schemaVersion === 4 ||
    value.schemaVersion === 5 ||
    value.rules.every(
      (entry) =>
        entry.classification !== "catalog-public-target" &&
        entry.classification !== "application-catalog-read-port-target",
    );
  const dependenciesValid = value.forbiddenDependencies.every(
    (entry) =>
      isPlainDataRecord(entry, ["id", "from", "to"]) &&
      isNonEmptyString(entry.id) &&
      CLASSIFICATIONS.has(entry.from as BoundaryClassification) &&
      (entry.to === "*" || CLASSIFICATIONS.has(entry.to as BoundaryClassification)),
  );
  const openingEdgesValid = value.openingEdges.every(
    (entry) =>
      isPlainDataRecord(entry, ["from", "to"]) &&
      typeof entry.from === "string" &&
      typeof entry.to === "string" &&
      isSafeRelativePath(entry.from) &&
      isSafeRelativePath(entry.to),
  );
  const exceptionKeys = [
    "id",
    "from",
    "to",
    "forbiddenDependencyId",
    "rationale",
    "compatibilityConsumer",
    "owningRoadmapFeature",
    "creationRevision",
    "reviewStatus",
    "validThroughManifestVersion",
    "openingRevision",
    "owner",
    "retirementCondition",
    "retirementTargetChild",
    "evidenceReference",
  ] as const;
  const exceptionsValid = value.exceptions.every(
    (entry) =>
      isPlainDataRecord(entry, exceptionKeys) &&
      exceptionKeys
        .filter((key) => key !== "validThroughManifestVersion")
        .every((key) => isNonEmptyString(entry[key])) &&
      (entry.reviewStatus === "accepted" || entry.reviewStatus === "retired") &&
      Number.isInteger(entry.validThroughManifestVersion) &&
      (entry.validThroughManifestVersion as number) >= 0,
  );
  return (
    rulesValid &&
    versionVocabularyValid &&
    dependenciesValid &&
    openingEdgesValid &&
    exceptionsValid
  );
}

export function parseArchitectureBoundaryManifest(
  value: unknown,
): ParseResult<ArchitectureBoundaryManifest> {
  if (!manifestStructureIsValid(value)) {
    return Object.freeze({
      ok: false,
      findings: Object.freeze([
        finding("INVALID_MANIFEST", "manifest", "invalid runtime structure"),
      ]),
    });
  }
  return Object.freeze({ ok: true, value });
}

function graphStructureIsValid(value: unknown): value is ArchitectureDependencyGraph {
  if (
    !isPlainDataRecord(value, ["files", "edges"], ["externalDependencies"]) ||
    !Array.isArray(value.files) ||
    !value.files.every((file) => typeof file === "string" && isSafeRelativePath(file)) ||
    !Array.isArray(value.edges)
  ) {
    return false;
  }
  const dependencyKeys = [
    "from",
    "to",
    "specifier",
    "syntax",
    "typeOnly",
    "line",
    "column",
  ] as const;
  const edgesValid = value.edges.every(
    (edge) =>
      isPlainDataRecord(edge, dependencyKeys) &&
      typeof edge.from === "string" &&
      typeof edge.to === "string" &&
      isSafeRelativePath(edge.from) &&
      isSafeRelativePath(edge.to) &&
      isNonEmptyString(edge.specifier) &&
      !/[\u0000-\u001f\u007f]/u.test(edge.specifier) &&
      DEPENDENCY_SYNTAXES.has(edge.syntax as ArchitectureDependencySyntax) &&
      typeof edge.typeOnly === "boolean" &&
      Number.isInteger(edge.line) &&
      (edge.line as number) > 0 &&
      Number.isInteger(edge.column) &&
      (edge.column as number) > 0,
  );
  const externalKeys = [
    "from",
    "specifier",
    "syntax",
    "typeOnly",
    "line",
    "column",
  ] as const;
  const external = value.externalDependencies ?? [];
  const externalValid =
    Array.isArray(external) &&
    external.every(
      (dependency) =>
        isPlainDataRecord(dependency, externalKeys) &&
        typeof dependency.from === "string" &&
        isSafeRelativePath(dependency.from) &&
        isNonEmptyString(dependency.specifier) &&
        !/[\u0000-\u001f\u007f]/u.test(dependency.specifier) &&
        DEPENDENCY_SYNTAXES.has(dependency.syntax as ArchitectureDependencySyntax) &&
        typeof dependency.typeOnly === "boolean" &&
        Number.isInteger(dependency.line) &&
        (dependency.line as number) > 0 &&
        Number.isInteger(dependency.column) &&
        (dependency.column as number) > 0,
    );
  return edgesValid && externalValid;
}

export function parseArchitectureDependencyGraph(
  value: unknown,
): ParseResult<ArchitectureDependencyGraph> {
  if (!graphStructureIsValid(value)) {
    return Object.freeze({
      ok: false,
      findings: Object.freeze([
        finding("INVALID_GRAPH", "graph", "invalid runtime structure"),
      ]),
    });
  }
  return Object.freeze({ ok: true, value });
}

function exceptionSuppressionKey(exception: BoundaryException): string {
  return `${edgeKey(exception)}\u0000${exception.forbiddenDependencyId}`;
}

function exceptionIsSemanticallyValid(
  exception: BoundaryException,
  manifest: ArchitectureBoundaryManifest,
  dependencyIds: ReadonlySet<string>,
  openingEdgeKeys: ReadonlySet<string>,
  duplicateSuppressionKeys: ReadonlySet<string>,
): boolean {
  return (
    isSafeRelativePath(exception.from) &&
    isSafeRelativePath(exception.to) &&
    dependencyIds.has(exception.forbiddenDependencyId) &&
    exception.openingRevision === manifest.openingRevision &&
    exception.creationRevision === manifest.openingRevision &&
    exception.owningRoadmapFeature === "F-03" &&
    exception.owner.trim().length > 0 &&
    exception.rationale.trim().length > 0 &&
    exception.compatibilityConsumer.trim().length > 0 &&
    exception.retirementCondition.trim().length > 0 &&
    exception.retirementTargetChild.trim().length > 0 &&
    exception.evidenceReference.trim().length > 0 &&
    openingEdgeKeys.has(edgeKey(exception)) &&
    !duplicateSuppressionKeys.has(exceptionSuppressionKey(exception)) &&
    (exception.reviewStatus === "retired" ||
      (exception.reviewStatus === "accepted" &&
        exception.validThroughManifestVersion === manifest.schemaVersion))
  );
}

function validateManifest(
  manifest: ArchitectureBoundaryManifest,
): ArchitectureFitnessFinding[] {
  const findings: ArchitectureFitnessFinding[] = [];
  if (
    manifest.schemaVersion !== 2 &&
    manifest.schemaVersion !== 3 &&
    manifest.schemaVersion !== 4 &&
    manifest.schemaVersion !== 5
  ) {
    findings.push(
      finding("INVALID_MANIFEST", "manifest.schemaVersion", "must equal 2, 3, 4, or 5"),
    );
  }
  if (manifest.openingRevision !== ARCHITECTURE_OPENING_REVISION) {
    findings.push(
      finding(
        "INVALID_MANIFEST",
        "manifest.openingRevision",
        "must equal the governed opening revision",
      ),
    );
  }
  if (manifest.rules.length === 0) {
    findings.push(finding("INVALID_MANIFEST", "manifest.rules", "must not be empty"));
  }

  for (const duplicate of duplicateValues([
    ...manifest.rules.map((rule) => `rule:${rule.id}`),
    ...manifest.forbiddenDependencies.map((rule) => `dependency:${rule.id}`),
    ...manifest.exceptions.map((exception) => `exception:${exception.id}`),
  ])) {
    findings.push(finding("DUPLICATE_ID", "manifest", duplicate));
  }

  for (const rule of manifest.rules) {
    if (
      rule.id.length === 0 ||
      rule.owner.length === 0 ||
      rule.visibility.length === 0 ||
      rule.effect.length === 0 ||
      rule.lifecycle.length === 0 ||
      !selectorIsValid(rule.selector) ||
      !(rule.exclusions ?? []).every(selectorIsValid)
    ) {
      findings.push(finding("INVALID_MANIFEST", `manifest.rules.${rule.id}`, "invalid rule"));
    }
  }

  const dependencyIds = new Set(manifest.forbiddenDependencies.map((rule) => rule.id));
  const openingEdgeKeys = new Set(manifest.openingEdges.map(edgeKey));
  for (const edge of manifest.openingEdges) {
    if (!isSafeRelativePath(edge.from) || !isSafeRelativePath(edge.to)) {
      findings.push(finding("INVALID_PATH", "manifest.openingEdges", "unsafe opening edge"));
    }
  }
  for (const duplicate of duplicateValues(manifest.openingEdges.map(edgeKey))) {
    findings.push(finding("DUPLICATE_PATH", "manifest.openingEdges", duplicate));
  }

  const duplicateSuppressionKeys = new Set(
    duplicateValues(
      manifest.exceptions
        .filter((exception) => exception.reviewStatus === "accepted")
        .map(exceptionSuppressionKey),
    ),
  );
  for (const duplicate of [...duplicateSuppressionKeys].sort(asciiCompare)) {
    findings.push(finding("DUPLICATE_ID", "manifest.exceptions", duplicate));
  }
  for (const exception of manifest.exceptions) {
    if (
      !exceptionIsSemanticallyValid(
        exception,
        manifest,
        dependencyIds,
        openingEdgeKeys,
        duplicateSuppressionKeys,
      )
    ) {
      findings.push(
        finding("INVALID_EXCEPTION", `manifest.exceptions.${exception.id}`, "invalid exception"),
      );
    }
  }
  return findings;
}

function findCycles(graph: ArchitectureDependencyGraph): readonly (readonly string[])[] {
  const files = [...new Set(graph.files)].sort(asciiCompare);
  const adjacency = new Map(files.map((file) => [file, [] as string[]]));
  for (const edge of graph.edges) {
    if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
      adjacency.get(edge.from)!.push(edge.to);
    }
  }
  for (const targets of adjacency.values()) {
    targets.sort(asciiCompare);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    component.sort(asciiCompare);
    if (
      component.length > 1 ||
      (component.length === 1 && (adjacency.get(component[0]!) ?? []).includes(component[0]!))
    ) {
      cycles.push(component);
    }
  };

  for (const file of files) {
    if (!indices.has(file)) visit(file);
  }
  return Object.freeze(
    cycles
      .sort((left, right) => asciiCompare(left.join("\u0000"), right.join("\u0000")))
      .map((cycle) => Object.freeze(cycle)),
  );
}

export function evaluateArchitectureFitness(
  manifestInput: unknown,
  graphInput: unknown,
): ArchitectureFitnessResult {
  const parsedManifest = parseArchitectureBoundaryManifest(manifestInput);
  const parsedGraph = parseArchitectureDependencyGraph(graphInput);
  if (!parsedManifest.ok || !parsedGraph.ok) {
    const structuralFindings = [
      ...(parsedManifest.ok ? [] : parsedManifest.findings),
      ...(parsedGraph.ok ? [] : parsedGraph.findings),
    ].sort(compareFindings);
    return Object.freeze({
      ok: false,
      classifications: Object.freeze([]),
      findings: Object.freeze(structuralFindings),
      cycles: Object.freeze([]),
      usedExceptionIds: Object.freeze([]),
    });
  }
  const manifest = parsedManifest.value;
  const graph = parsedGraph.value;
  const findings = validateManifest(manifest);
  const files = [...graph.files].sort(asciiCompare);
  for (const duplicate of duplicateValues(files)) {
    findings.push(finding("DUPLICATE_PATH", duplicate, "duplicate graph file"));
  }

  const classifications: ArchitecturePathClassification[] = [];
  const classificationByPath = new Map<string, BoundaryClassification>();
  for (const file of files) {
    if (!isSafeRelativePath(file)) {
      findings.push(finding("INVALID_PATH", file, "unsafe graph path"));
      continue;
    }
    const matches = manifest.rules.filter((rule) => ruleMatches(rule, file));
    if (matches.length === 0) {
      findings.push(finding("UNCLASSIFIED_PATH", file, "no boundary rule"));
      continue;
    }
    if (matches.length !== 1) {
      findings.push(
        finding(
          "AMBIGUOUS_CLASSIFICATION",
          file,
          matches.map((rule) => rule.id).sort(asciiCompare).join(","),
        ),
      );
      continue;
    }
    const match = matches[0]!;
    classificationByPath.set(file, match.classification);
    classifications.push(
      Object.freeze({ path: file, ruleId: match.id, classification: match.classification }),
    );
  }

  const fileSet = new Set(files);
  const validExceptions = new Map<string, BoundaryException>();
  const dependencyIds = new Set(manifest.forbiddenDependencies.map((rule) => rule.id));
  const openingEdgeKeys = new Set(manifest.openingEdges.map(edgeKey));
  const duplicateSuppressionKeys = new Set(
    duplicateValues(
      manifest.exceptions
        .filter((exception) => exception.reviewStatus === "accepted")
        .map(exceptionSuppressionKey),
    ),
  );
  for (const exception of manifest.exceptions) {
    if (
      exception.reviewStatus === "accepted" &&
      exceptionIsSemanticallyValid(
        exception,
        manifest,
        dependencyIds,
        openingEdgeKeys,
        duplicateSuppressionKeys,
      )
    ) {
      validExceptions.set(exceptionSuppressionKey(exception), exception);
    }
  }
  const usedExceptionIds = new Set<string>();

  const orderedEdges = [...graph.edges].sort(
    (left, right) =>
      asciiCompare(left.from, right.from) ||
      asciiCompare(left.to, right.to) ||
      asciiCompare(left.syntax, right.syntax) ||
      left.line - right.line ||
      left.column - right.column,
  );
  for (const edge of orderedEdges) {
    if (!isSafeRelativePath(edge.from) || !isSafeRelativePath(edge.to)) {
      findings.push(finding("INVALID_PATH", edge.from, "unsafe dependency edge"));
      continue;
    }
    if (!fileSet.has(edge.from) || !fileSet.has(edge.to)) {
      findings.push(finding("EDGE_OUTSIDE_GRAPH", edge.from, edge.to));
      continue;
    }
    const from = classificationByPath.get(edge.from);
    const to = classificationByPath.get(edge.to);
    if (from === undefined || to === undefined) continue;

    for (const prohibition of manifest.forbiddenDependencies) {
      if (prohibition.from !== from || (prohibition.to !== "*" && prohibition.to !== to)) {
        continue;
      }
      const exception = validExceptions.get(
        `${edgeKey(edge)}\u0000${prohibition.id}`,
      );
      if (exception !== undefined) {
        usedExceptionIds.add(exception.id);
      } else {
        findings.push(
          finding(
            "FORBIDDEN_DEPENDENCY",
            edge.from,
            `${prohibition.id}:${edge.to}`,
          ),
        );
      }
    }
  }

  const orderedExternalDependencies = [...(graph.externalDependencies ?? [])].sort(
    (left, right) =>
      asciiCompare(left.from, right.from) ||
      asciiCompare(left.specifier, right.specifier) ||
      asciiCompare(left.syntax, right.syntax) ||
      left.line - right.line ||
      left.column - right.column,
  );
  for (const dependency of orderedExternalDependencies) {
    if (!isSafeRelativePath(dependency.from) || !fileSet.has(dependency.from)) {
      findings.push(
        finding("EDGE_OUTSIDE_GRAPH", dependency.from, dependency.specifier),
      );
      continue;
    }
    const from = classificationByPath.get(dependency.from);
    if (from === undefined) continue;
    for (const prohibition of manifest.forbiddenDependencies) {
      if (prohibition.from === from && prohibition.to === "*") {
        findings.push(
          finding(
            "FORBIDDEN_DEPENDENCY",
            dependency.from,
            `${prohibition.id}:external:${dependency.specifier}`,
          ),
        );
      }
    }
  }

  for (const exception of validExceptions.values()) {
    if (!usedExceptionIds.has(exception.id)) {
      findings.push(
        finding(
          "STALE_EXCEPTION",
          `manifest.exceptions.${exception.id}`,
          "accepted exception is unused",
        ),
      );
    }
  }

  const cycles = findCycles(graph);
  for (const cycle of cycles) {
    findings.push(finding("CYCLE", cycle[0]!, cycle.join(" -> ")));
  }

  const orderedFindings = Object.freeze(findings.sort(compareFindings));
  return Object.freeze({
    ok: orderedFindings.length === 0,
    classifications: Object.freeze(
      classifications.sort((left, right) => asciiCompare(left.path, right.path)),
    ),
    findings: orderedFindings,
    cycles,
    usedExceptionIds: Object.freeze([...usedExceptionIds].sort(asciiCompare)),
  });
}
