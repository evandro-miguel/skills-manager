import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const ARCHITECTURE_TYPESCRIPT_UNIVERSE = [
  "scripts/commands",
  "scripts/lib",
  "scripts/modules",
] as const;

export type ArchitectureImportSyntax =
  | "static-import"
  | "re-export"
  | "import-equals"
  | "commonjs-require"
  | "dynamic-import";

export type ArchitectureGraphEdge = {
  readonly from: string;
  readonly to: string;
  readonly specifier: string;
  readonly syntax: ArchitectureImportSyntax;
  readonly typeOnly: boolean;
  readonly line: number;
  readonly column: number;
};

export type ArchitectureExternalDependency = {
  readonly from: string;
  readonly specifier: string;
  readonly syntax: ArchitectureImportSyntax;
  readonly typeOnly: boolean;
  readonly line: number;
  readonly column: number;
};

export type ArchitectureGraphExclusion = {
  readonly pathPrefix: string;
  readonly reason:
    | "cache"
    | "dependency"
    | "fixture"
    | "generated-output"
    | "test-evidence";
};

export type ArchitectureGraph = {
  readonly files: readonly string[];
  readonly launcherFiles: readonly string[];
  readonly edges: readonly ArchitectureGraphEdge[];
  readonly externalDependencies: readonly ArchitectureExternalDependency[];
  readonly exclusions: readonly ArchitectureGraphExclusion[];
};

export type ArchitectureGraphIssueCode =
  | "COMPUTED_SPECIFIER"
  | "INVALID_PACKAGE_IMPORTS"
  | "SOURCE_PARSE_FAILED"
  | "SOURCE_READ_FAILED"
  | "SYMLINK_PATH"
  | "TARGET_OUTSIDE_UNIVERSE"
  | "UNRESOLVED_PACKAGE_IMPORT"
  | "UNRESOLVED_RELATIVE_IMPORT"
  | "UNSAFE_PACKAGE_IMPORT_TARGET";

export type ArchitectureGraphIssue = {
  readonly code: ArchitectureGraphIssueCode;
  readonly from: string;
  readonly syntax?: ArchitectureImportSyntax;
  readonly specifier?: string;
  readonly line?: number;
  readonly column?: number;
};

export class ArchitectureGraphScanError extends Error {
  readonly code = "ARCHITECTURE_GRAPH_SCAN_FAILED" as const;
  readonly issues: readonly ArchitectureGraphIssue[];

  constructor(issues: readonly ArchitectureGraphIssue[]) {
    const ordered = [...issues].sort(compareIssues);
    super(
      `Architecture graph scan failed with ${ordered.length} issue(s): ${ordered
        .map((issue) => `${issue.code}:${issue.from}`)
        .join(", ")}`,
    );
    this.name = "ArchitectureGraphScanError";
    this.issues = Object.freeze(ordered.map((issue) => Object.freeze({ ...issue })));
    Object.freeze(this);
  }
}

export type ScanArchitectureGraphOptions = {
  readonly repoRoot: string;
};

type PendingDependency = {
  readonly from: string;
  readonly absoluteFrom: string;
  readonly specifier: string;
  readonly syntax: ArchitectureImportSyntax;
  readonly typeOnly: boolean;
  readonly line: number;
  readonly column: number;
};

const ARCHITECTURE_GRAPH_EXCLUSIONS = Object.freeze([
  Object.freeze({ pathPrefix: ".cache/", reason: "cache" }),
  Object.freeze({ pathPrefix: "dist/", reason: "generated-output" }),
  Object.freeze({ pathPrefix: "fixtures/", reason: "fixture" }),
  Object.freeze({ pathPrefix: "node_modules/", reason: "dependency" }),
  Object.freeze({ pathPrefix: "tests/", reason: "test-evidence" }),
] satisfies readonly ArchitectureGraphExclusion[]);

type PackageImportRule = {
  readonly key: string;
  readonly target: string;
  readonly wildcard: boolean;
};

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function compareAscii(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function repositoryRelative(repoRoot: string, absolutePath: string): string {
  return toPosixPath(path.relative(repoRoot, absolutePath));
}

function listFilesRecursively(
  repoRoot: string,
  directory: string,
  issues: ArchitectureGraphIssue[],
): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    issues.push({
      code: "SOURCE_READ_FAILED",
      from: repositoryRelative(repoRoot, directory),
    });
    return files;
  }
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push({
        code: "SYMLINK_PATH",
        from: repositoryRelative(repoRoot, absolutePath),
      });
    } else if (entry.isDirectory()) {
      files.push(...listFilesRecursively(repoRoot, absolutePath, issues));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

function listUniverseFiles(repoRoot: string, issues: ArchitectureGraphIssue[]): string[] {
  return ARCHITECTURE_TYPESCRIPT_UNIVERSE.flatMap((relativeDirectory) =>
    listFilesRecursively(repoRoot, path.join(repoRoot, relativeDirectory), issues),
  )
    .filter((filePath) => filePath.endsWith(".ts"))
    .map((filePath) => path.resolve(filePath))
    .sort((left, right) =>
      compareAscii(repositoryRelative(repoRoot, left), repositoryRelative(repoRoot, right)),
    );
}

function listLauncherFiles(repoRoot: string, issues: ArchitectureGraphIssue[]): string[] {
  return listFilesRecursively(repoRoot, path.join(repoRoot, "scripts", "bin"), issues)
    .map((filePath) => repositoryRelative(repoRoot, filePath))
    .sort(compareAscii);
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function importDeclarationIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.name !== undefined || clause.namedBindings === undefined) {
    return false;
  }
  if (ts.isNamespaceImport(clause.namedBindings)) {
    return false;
  }
  return (
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function exportDeclarationIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) {
    return true;
  }
  return (
    node.exportClause !== undefined &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function bindingNameContainsRequire(name: ts.BindingName | ts.Identifier): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === "require";
  }
  return name.elements.some(
    (element) =>
      !ts.isOmittedExpression(element) && bindingNameContainsRequire(element.name),
  );
}

function importClauseDeclaresRequire(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined || clause.isTypeOnly) {
    return false;
  }
  if (clause.name?.text === "require") {
    return true;
  }
  if (clause.namedBindings === undefined) {
    return false;
  }
  if (ts.isNamespaceImport(clause.namedBindings)) {
    return clause.namedBindings.name.text === "require";
  }
  return clause.namedBindings.elements.some(
    (element) => !element.isTypeOnly && element.name.text === "require",
  );
}

function statementDeclaresRequire(statement: ts.Statement): boolean {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) =>
      bindingNameContainsRequire(declaration.name),
    );
  }
  if (ts.isImportDeclaration(statement)) {
    return importClauseDeclaresRequire(statement);
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    return !statement.isTypeOnly && statement.name.text === "require";
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    return statement.name !== undefined && ts.isIdentifier(statement.name)
      ? statement.name.text === "require"
      : false;
  }
  return false;
}

function functionScopeHasVarRequire(scope: ts.SourceFile | ts.SignatureDeclaration): boolean {
  const root = ts.isSourceFile(scope)
    ? scope
    : "body" in scope && scope.body !== undefined
      ? scope.body
      : undefined;
  if (root === undefined) {
    return false;
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (node !== root && ts.isFunctionLike(node)) {
      return;
    }
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0 &&
      node.declarations.some((declaration) => bindingNameContainsRequire(declaration.name))
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function lexicalScopeDeclaresRequire(scope: ts.Node): boolean {
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) {
    return scope.statements.some(statementDeclaresRequire);
  }
  if (ts.isCaseBlock(scope)) {
    return scope.clauses.some((clause) => clause.statements.some(statementDeclaresRequire));
  }
  if (ts.isCatchClause(scope)) {
    return (
      scope.variableDeclaration !== undefined &&
      bindingNameContainsRequire(scope.variableDeclaration.name)
    );
  }
  if (ts.isForStatement(scope)) {
    return (
      scope.initializer !== undefined &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((declaration) =>
        bindingNameContainsRequire(declaration.name),
      )
    );
  }
  if (ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    return (
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((declaration) =>
        bindingNameContainsRequire(declaration.name),
      )
    );
  }
  return false;
}

function isShadowedRequire(identifier: ts.Identifier): boolean {
  let current: ts.Node | undefined = identifier.parent;
  while (current !== undefined) {
    if (
      ts.isClassExpression(current) &&
      current.name?.text === "require"
    ) {
      return true;
    }
    if (ts.isFunctionLike(current)) {
      if (
        current.parameters.some((parameter) => bindingNameContainsRequire(parameter.name)) ||
        ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) &&
          current.name !== undefined &&
          ts.isIdentifier(current.name) &&
          current.name.text === "require") ||
        functionScopeHasVarRequire(current)
      ) {
        return true;
      }
    }
    if (
      lexicalScopeDeclaresRequire(current) ||
      (ts.isSourceFile(current) && functionScopeHasVarRequire(current))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function collectDependencies(
  sourceFile: ts.SourceFile,
  absoluteFrom: string,
  from: string,
  issues: ArchitectureGraphIssue[],
): PendingDependency[] {
  const dependencies: PendingDependency[] = [];

  const addLiteral = (
    specifierNode: ts.StringLiteralLike,
    syntax: ArchitectureImportSyntax,
    typeOnly: boolean,
  ): void => {
    const location = locationOf(sourceFile, specifierNode);
    dependencies.push({
      from,
      absoluteFrom,
      specifier: specifierNode.text,
      syntax,
      typeOnly,
      ...location,
    });
  };

  const addComputedIssue = (
    node: ts.Node,
    syntax: ArchitectureImportSyntax,
  ): void => {
    issues.push({
      code: "COMPUTED_SPECIFIER",
      from,
      syntax,
      ...locationOf(sourceFile, node),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) {
        addLiteral(node.moduleSpecifier, "static-import", importDeclarationIsTypeOnly(node));
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) {
        addLiteral(node.moduleSpecifier, "re-export", exportDeclarationIsTypeOnly(node));
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression !== undefined && ts.isStringLiteralLike(expression)) {
        addLiteral(expression, "import-equals", node.isTypeOnly);
      } else {
        addComputedIssue(node.moduleReference, "import-equals");
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isCommonJsRequire =
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        !isShadowedRequire(node.expression);

      if (isDynamicImport || isCommonJsRequire) {
        const syntax: ArchitectureImportSyntax = isDynamicImport
          ? "dynamic-import"
          : "commonjs-require";
        const argument = node.arguments[0];
        const supportedArgumentCount = isDynamicImport
          ? node.arguments.length === 1 || node.arguments.length === 2
          : node.arguments.length === 1;
        if (supportedArgumentCount && argument !== undefined && ts.isStringLiteralLike(argument)) {
          addLiteral(argument, syntax, false);
        } else {
          addComputedIssue(node, syntax);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return dependencies;
}

function candidatePaths(absoluteFrom: string, specifier: string): string[] {
  const unresolved = path.resolve(path.dirname(absoluteFrom), specifier);
  const candidates: string[] = [];

  if (specifier.endsWith(".js") || specifier.endsWith(".mjs") || specifier.endsWith(".cjs")) {
    candidates.push(unresolved.replace(/\.(?:m|c)?js$/u, ".ts"));
    candidates.push(unresolved);
  } else if (!path.extname(unresolved)) {
    candidates.push(`${unresolved}.ts`, path.join(unresolved, "index.ts"));
  } else {
    candidates.push(unresolved);
  }

  return [...new Set(candidates.map((candidate) => path.normalize(candidate)))];
}

function readPackageImportRules(
  repoRoot: string,
  issues: ArchitectureGraphIssue[],
): readonly PackageImportRule[] {
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
  } catch {
    issues.push({ code: "INVALID_PACKAGE_IMPORTS", from: "package.json" });
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    issues.push({ code: "INVALID_PACKAGE_IMPORTS", from: "package.json" });
    return [];
  }
  const imports = (parsed as Record<string, unknown>).imports;
  if (imports === undefined) {
    return [];
  }
  if (typeof imports !== "object" || imports === null || Array.isArray(imports)) {
    issues.push({ code: "INVALID_PACKAGE_IMPORTS", from: "package.json" });
    return [];
  }

  const rules: PackageImportRule[] = [];
  for (const [key, target] of Object.entries(imports)) {
    const wildcardCount = [...key].filter((character) => character === "*").length;
    if (
      !key.startsWith("#") ||
      key === "#" ||
      wildcardCount > 1 ||
      typeof target !== "string"
    ) {
      issues.push({
        code: "INVALID_PACKAGE_IMPORTS",
        from: "package.json",
        specifier: key,
      });
      continue;
    }
    rules.push({
      key,
      target,
      wildcard: wildcardCount === 1,
    });
  }
  return Object.freeze(
    rules.sort((left, right) => {
      if (left.wildcard !== right.wildcard) {
        return left.wildcard ? 1 : -1;
      }
      if (left.wildcard) {
        const [leftPrefix = "", leftSuffix = ""] = left.key.split("*");
        const [rightPrefix = "", rightSuffix = ""] = right.key.split("*");
        return (
          rightPrefix.length - leftPrefix.length ||
          rightSuffix.length - leftSuffix.length ||
          compareAscii(left.key, right.key)
        );
      }
      return compareAscii(left.key, right.key);
    }),
  );
}

function resolvePackageImportTarget(
  specifier: string,
  rules: readonly PackageImportRule[],
): string | undefined {
  for (const rule of rules) {
    if (!rule.wildcard) {
      if (specifier === rule.key) {
        return rule.target;
      }
      continue;
    }
    const [prefix = "", suffix = ""] = rule.key.split("*");
    if (
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      specifier.length >= prefix.length + suffix.length
    ) {
      const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
      return rule.target.replace("*", matched);
    }
  }
  return undefined;
}

function isInsideRepo(repoRoot: string, candidate: string): boolean {
  const relative = path.relative(repoRoot, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function existingFileCandidate(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => {
    try {
      return fs.lstatSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function compareEdges(left: ArchitectureGraphEdge, right: ArchitectureGraphEdge): number {
  return (
    compareAscii(left.from, right.from) ||
    compareAscii(left.to, right.to) ||
    compareAscii(left.syntax, right.syntax) ||
    compareAscii(left.specifier, right.specifier) ||
    left.line - right.line ||
    left.column - right.column
  );
}

function compareExternalDependencies(
  left: ArchitectureExternalDependency,
  right: ArchitectureExternalDependency,
): number {
  return (
    compareAscii(left.from, right.from) ||
    compareAscii(left.specifier, right.specifier) ||
    compareAscii(left.syntax, right.syntax) ||
    left.line - right.line ||
    left.column - right.column
  );
}

function compareIssues(left: ArchitectureGraphIssue, right: ArchitectureGraphIssue): number {
  return (
    compareAscii(left.from, right.from) ||
    compareAscii(left.code, right.code) ||
    compareAscii(left.specifier ?? "", right.specifier ?? "") ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0)
  );
}

function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

export function scanArchitectureGraph(options: ScanArchitectureGraphOptions): ArchitectureGraph {
  const repoRoot = path.resolve(options.repoRoot);
  const issues: ArchitectureGraphIssue[] = [];
  const absoluteFiles = listUniverseFiles(repoRoot, issues);
  const launcherFiles = listLauncherFiles(repoRoot, issues);
  const packageImportRules = readPackageImportRules(repoRoot, issues);
  const universe = new Set(absoluteFiles.map((filePath) => path.normalize(filePath)));
  const pendingDependencies: PendingDependency[] = [];

  for (const absoluteFile of absoluteFiles) {
    const from = repositoryRelative(repoRoot, absoluteFile);
    let sourceText: string;
    try {
      sourceText = fs.readFileSync(absoluteFile, "utf8");
    } catch {
      issues.push({ code: "SOURCE_READ_FAILED", from });
      continue;
    }

    const sourceFile = ts.createSourceFile(
      absoluteFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const parseDiagnostics = (
      sourceFile as unknown as { readonly parseDiagnostics?: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
    if (parseDiagnostics !== undefined && parseDiagnostics.length > 0) {
      for (const diagnostic of parseDiagnostics) {
        const position =
          diagnostic.start === undefined
            ? undefined
            : sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
        issues.push({
          code: "SOURCE_PARSE_FAILED",
          from,
          ...(position === undefined
            ? {}
            : { line: position.line + 1, column: position.character + 1 }),
        });
      }
      continue;
    }
    pendingDependencies.push(...collectDependencies(sourceFile, absoluteFile, from, issues));
  }

  const edges: ArchitectureGraphEdge[] = [];
  const externalDependencies: ArchitectureExternalDependency[] = [];

  for (const dependency of pendingDependencies) {
    let resolutionSpecifier = dependency.specifier;
    if (dependency.specifier.startsWith("#")) {
      const packageTarget = resolvePackageImportTarget(
        dependency.specifier,
        packageImportRules,
      );
      if (packageTarget === undefined) {
        issues.push({
          code: "UNRESOLVED_PACKAGE_IMPORT",
          from: dependency.from,
          syntax: dependency.syntax,
          specifier: dependency.specifier,
          line: dependency.line,
          column: dependency.column,
        });
        continue;
      }
      if (
        !packageTarget.startsWith("./") ||
        packageTarget.includes("\\") ||
        packageTarget.includes("://")
      ) {
        issues.push({
          code: "UNSAFE_PACKAGE_IMPORT_TARGET",
          from: dependency.from,
          syntax: dependency.syntax,
          specifier: dependency.specifier,
          line: dependency.line,
          column: dependency.column,
        });
        continue;
      }
      const absolutePackageTarget = path.resolve(repoRoot, packageTarget);
      if (!isInsideRepo(repoRoot, absolutePackageTarget)) {
        issues.push({
          code: "UNSAFE_PACKAGE_IMPORT_TARGET",
          from: dependency.from,
          syntax: dependency.syntax,
          specifier: dependency.specifier,
          line: dependency.line,
          column: dependency.column,
        });
        continue;
      }
      resolutionSpecifier = path.relative(
        path.dirname(dependency.absoluteFrom),
        absolutePackageTarget,
      );
      if (!isRelativeSpecifier(resolutionSpecifier)) {
        resolutionSpecifier = `./${resolutionSpecifier}`;
      }
    } else if (!isRelativeSpecifier(dependency.specifier)) {
      externalDependencies.push({
        from: dependency.from,
        specifier: dependency.specifier,
        syntax: dependency.syntax,
        typeOnly: dependency.typeOnly,
        line: dependency.line,
        column: dependency.column,
      });
      continue;
    }

    const candidates = candidatePaths(dependency.absoluteFrom, resolutionSpecifier);
    const symlinkCandidate = candidates.find((candidate) => {
      try {
        return fs.lstatSync(candidate).isSymbolicLink();
      } catch {
        return false;
      }
    });
    if (symlinkCandidate !== undefined) {
      issues.push({
        code: "SYMLINK_PATH",
        from: repositoryRelative(repoRoot, symlinkCandidate),
        syntax: dependency.syntax,
        specifier: dependency.specifier,
        line: dependency.line,
        column: dependency.column,
      });
      continue;
    }
    const existingCandidate = existingFileCandidate(candidates);
    if (existingCandidate === undefined) {
      issues.push({
        code: dependency.specifier.startsWith("#")
          ? "UNRESOLVED_PACKAGE_IMPORT"
          : "UNRESOLVED_RELATIVE_IMPORT",
        from: dependency.from,
        syntax: dependency.syntax,
        specifier: dependency.specifier,
        line: dependency.line,
        column: dependency.column,
      });
      continue;
    }

    const normalizedTarget = path.normalize(existingCandidate);
    if (!universe.has(normalizedTarget)) {
      issues.push({
        code: "TARGET_OUTSIDE_UNIVERSE",
        from: dependency.from,
        syntax: dependency.syntax,
        specifier: dependency.specifier,
        line: dependency.line,
        column: dependency.column,
      });
      continue;
    }

    edges.push({
      from: dependency.from,
      to: repositoryRelative(repoRoot, normalizedTarget),
      specifier: dependency.specifier,
      syntax: dependency.syntax,
      typeOnly: dependency.typeOnly,
      line: dependency.line,
      column: dependency.column,
    });
  }

  if (issues.length > 0) {
    throw new ArchitectureGraphScanError(issues);
  }

  return Object.freeze({
    files: Object.freeze(absoluteFiles.map((filePath) => repositoryRelative(repoRoot, filePath))),
    launcherFiles: Object.freeze(launcherFiles),
    edges: Object.freeze(edges.sort(compareEdges).map((edge) => Object.freeze(edge))),
    externalDependencies: Object.freeze(
      externalDependencies
        .sort(compareExternalDependencies)
        .map((dependency) => Object.freeze(dependency)),
    ),
    exclusions: ARCHITECTURE_GRAPH_EXCLUSIONS,
  });
}

export function findArchitectureCycles(graph: ArchitectureGraph): readonly (readonly string[])[] {
  const adjacency = new Map<string, string[]>(graph.files.map((file) => [file, []]));
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }
  for (const targets of adjacency.values()) {
    targets.sort(compareAscii);
  }

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (file: string): void => {
    const index = nextIndex;
    nextIndex += 1;
    indices.set(file, index);
    lowLinks.set(file, index);
    stack.push(file);
    onStack.add(file);

    for (const target of adjacency.get(file) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(file, Math.min(lowLinks.get(file)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(file, Math.min(lowLinks.get(file)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(file) !== indices.get(file)) {
      return;
    }

    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== file);

    const isSelfCycle =
      component.length === 1 && (adjacency.get(component[0]!) ?? []).includes(component[0]!);
    if (component.length > 1 || isSelfCycle) {
      cycles.push(component.sort(compareAscii));
    }
  };

  for (const file of [...graph.files].sort(compareAscii)) {
    if (!indices.has(file)) {
      visit(file);
    }
  }

  return Object.freeze(
    cycles
      .sort((left, right) => compareAscii(left.join("\0"), right.join("\0")))
      .map((cycle) => Object.freeze(cycle)),
  );
}
