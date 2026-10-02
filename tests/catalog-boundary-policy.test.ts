import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import manifestJson from "../scripts/modules/skill-sys/architecture-boundaries.v5.json";
import type {
  ArchitectureBoundaryManifest,
  ArchitectureDependencyGraph,
} from "../scripts/modules/skill-sys/architecture-fitness.ts";
import { scanArchitectureGraph } from "./helpers/architecture-graph.ts";

const repoRoot = path.resolve(__dirname, "..");
const CATALOG = "scripts/modules/catalog/query-skills.ts";
const APPLICATION_PORT =
  "scripts/modules/application/ports/catalog-skills-reader.ts";
const CATALOG_SPECIFIER = "../../catalog/query-skills.ts";

type PolicyInput = Readonly<{
  graph: ArchitectureDependencyGraph;
  manifest: ArchitectureBoundaryManifest;
  catalogSource: string;
  applicationPortSource: string;
}>;

type RuntimeFunction =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

function sourceUsesTypesIsProxyOnly(sourceText: string): boolean {
  const sourceFile = ts.createSourceFile(
    CATALOG,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let exactImportCount = 0;
  let invalidTypesUse = false;
  let proxyCallCount = 0;
  const proxyFunctions = new Set<RuntimeFunction>();
  let proxyOrderingValid = true;
  let traversalShapeValid = false;
  let queryEntryValid = false;
  let dynamicCodeUse = false;

  function containingFunction(node: ts.Node): RuntimeFunction | undefined {
    for (let current = node.parent; current !== undefined; current = current.parent) {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current)
      ) {
        return current;
      }
    }
    return undefined;
  }

  function validateProxyOrdering(
    call: ts.CallExpression,
    owner: RuntimeFunction,
  ): void {
    const checkedArgument = call.arguments[0];
    if (checkedArgument === undefined || !ts.isIdentifier(checkedArgument)) {
      proxyOrderingValid = false;
      return;
    }
    const proxyPosition = call.getStart(sourceFile);
    const parameterName = checkedArgument.text;
    const ownerName =
      owner.name !== undefined && ts.isIdentifier(owner.name)
        ? owner.name.text
        : undefined;
    const validOwnerShape =
      (ownerName === "assertPlainDataGraph" && parameterName === "candidate") ||
      (ownerName === "assertNotProxy" && parameterName === "root");
    if (
      !validOwnerShape ||
      owner.parameters.length !== 2 ||
      owner.parameters[0]?.name.getText(sourceFile) !== "root" ||
      owner.parameters[1]?.name.getText(sourceFile) !== "rootPath" ||
      owner.parameters.some((parameter) => parameter.initializer !== undefined)
    ) {
      proxyOrderingValid = false;
    }
    if (
      call.arguments.length !== 1 ||
      !ts.isIdentifier(call.arguments[0]!) ||
      call.arguments[0]!.text !== parameterName
    ) {
      proxyOrderingValid = false;
    }

    function isAllowedPrimitiveGuard(identifier: ts.Identifier): boolean {
      const parent = identifier.parent;
      if (ts.isBindingElement(parent) && parent.name === identifier) {
        return true;
      }
      if (
        (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
        (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
        (ts.isPropertySignature(parent) && parent.name === identifier)
      ) {
        return true;
      }
      if (ts.isTypeOfExpression(parent) && parent.expression === identifier) {
        return true;
      }
      if (
        ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
        ((parent.left === identifier && parent.right.kind === ts.SyntaxKind.NullKeyword) ||
          (parent.right === identifier && parent.left.kind === ts.SyntaxKind.NullKeyword))
      ) {
        return true;
      }
      return false;
    }

    function inspectEarlierRead(node: ts.Node): void {
      if (node.getStart(sourceFile) >= proxyPosition) return;
      if (ts.isIdentifier(node) && node.text === "arguments") {
        proxyOrderingValid = false;
      }
      if (
        ts.isIdentifier(node) &&
        node.text === parameterName &&
        !isAllowedPrimitiveGuard(node)
      ) {
        proxyOrderingValid = false;
      }
      ts.forEachChild(node, inspectEarlierRead);
    }
    if (owner.body !== undefined) inspectEarlierRead(owner.body);
    if (
      owner.body !== undefined &&
      owner.body
        .getChildren(sourceFile)
        .some(
          (child) =>
            ts.isIdentifier(child) && child.text === "arguments",
        )
    ) {
      proxyOrderingValid = false;
    }
  }

  function isExactPlainGraphAssertion(
    statement: ts.Statement | undefined,
    parameterName: string,
    pathName: string,
  ): boolean {
    if (
      statement === undefined ||
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    ) {
      return false;
    }
    const call = statement.expression;
    return (
      ts.isIdentifier(call.expression) &&
      call.expression.text === "assertPlainDataGraph" &&
      call.arguments.length === 2 &&
      ts.isIdentifier(call.arguments[0]!) &&
      call.arguments[0]!.text === parameterName &&
      ts.isStringLiteral(call.arguments[1]!) &&
      call.arguments[1]!.text === pathName
    );
  }

  function validateQueryEntry(node: ts.FunctionDeclaration): void {
    if (
      node.parameters.length !== 3 ||
      node.parameters.some(
        (parameter) =>
          !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined,
      ) ||
      node.body === undefined
    ) {
      return;
    }
    const parameterNames = node.parameters.map(
      (parameter) => (parameter.name as ts.Identifier).text,
    );
    queryEntryValid =
      parameterNames[0] === "records" &&
      parameterNames[1] === "selectedProfiles" &&
      parameterNames[2] === "input" &&
      isExactPlainGraphAssertion(node.body.statements[0], "records", "records") &&
      isExactPlainGraphAssertion(
        node.body.statements[1],
        "selectedProfiles",
        "selectedProfiles",
      ) &&
      isExactPlainGraphAssertion(node.body.statements[2], "input", "input");
  }

  function validateTraversalShape(node: ts.FunctionDeclaration): void {
    if (
      node.name?.text !== "assertPlainDataGraph" ||
      node.body === undefined ||
      node.parameters.map((parameter) => parameter.name.getText(sourceFile)).join(",") !==
        "root,rootPath"
    ) {
      return;
    }

    const whileStatement = node.body.statements.find(ts.isWhileStatement);
    if (
      whileStatement === undefined ||
      !ts.isBlock(whileStatement.statement)
    ) {
      return;
    }
    const whileBody = whileStatement.statement;
    const descriptorDeclaration = whileBody.statements.find(
      (statement): statement is ts.VariableStatement => {
        if (!ts.isVariableStatement(statement)) return false;
        const declaration = statement.declarationList.declarations[0];
        const initializer = declaration?.initializer;
        return (
          declaration !== undefined &&
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "descriptors" &&
          initializer !== undefined &&
          ts.isCallExpression(initializer) &&
          ts.isPropertyAccessExpression(initializer.expression) &&
          ts.isIdentifier(initializer.expression.expression) &&
          initializer.expression.expression.text === "Object" &&
          initializer.expression.name.text === "getOwnPropertyDescriptors" &&
          initializer.arguments.length === 1 &&
          ts.isIdentifier(initializer.arguments[0]!) &&
          initializer.arguments[0]!.text === "candidate"
        );
      },
    );
    if (descriptorDeclaration === undefined) return;

    function candidateUseIsAllowed(identifier: ts.Identifier): boolean {
      const parent = identifier.parent;
      if (ts.isBindingElement(parent) && parent.name === identifier) {
        const binding = parent.parent;
        const declaration = binding.parent;
        return (
          parent.propertyName?.getText(sourceFile) === "value" &&
          ts.isObjectBindingPattern(binding) &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer?.getText(sourceFile) === "frame"
        );
      }
      if (ts.isTypeOfExpression(parent) && parent.expression === identifier) return true;
      if (
        ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
        ((parent.left === identifier && parent.right.kind === ts.SyntaxKind.NullKeyword) ||
          (parent.right === identifier && parent.left.kind === ts.SyntaxKind.NullKeyword))
      ) {
        return true;
      }
      if (ts.isPropertyAssignment(parent) && parent.initializer === identifier) {
        const objectLiteral = parent.parent;
        const call = objectLiteral.parent;
        return (
          parent.name.getText(sourceFile) === "value" &&
          ts.isObjectLiteralExpression(objectLiteral) &&
          objectLiteral.getText(sourceFile) ===
            '{ kind: "exit", value: candidate }' &&
          ts.isCallExpression(call) &&
          call.expression.getText(sourceFile) === "stack.push" &&
          call.arguments.length === 1 &&
          call.arguments[0] === objectLiteral
        );
      }
      if (!ts.isCallExpression(parent) || !parent.arguments.includes(identifier)) {
        return false;
      }
      if (parent.arguments.length !== 1 || parent.arguments[0] !== identifier) {
        return false;
      }
      const callee = parent.expression;
      if (!ts.isPropertyAccessExpression(callee)) return false;
      if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "types" &&
        callee.name.text === "isProxy"
      ) {
        return true;
      }
      if (
        ts.isIdentifier(callee.expression) &&
        (callee.expression.text === "checked" ||
          callee.expression.text === "visiting") &&
        (callee.name.text === "has" || callee.name.text === "add")
      ) {
        return true;
      }
      return (
        ts.isIdentifier(callee.expression) &&
        ((callee.expression.text === "Object" &&
          (callee.name.text === "getPrototypeOf" ||
            callee.name.text === "getOwnPropertyDescriptors")) ||
          (callee.expression.text === "Array" &&
            callee.name.text === "isArray"))
      );
    }

    let candidateUsesValid = true;
    function inspectCandidateUses(current: ts.Node): void {
      if (ts.isIdentifier(current) && current.text === "arguments") {
        candidateUsesValid = false;
      }
      if (
        ts.isIdentifier(current) &&
        current.text === "candidate" &&
        !candidateUseIsAllowed(current)
      ) {
        candidateUsesValid = false;
      }
      ts.forEachChild(current, inspectCandidateUses);
    }
    inspectCandidateUses(whileBody);

    const descriptorLoop = whileBody.statements.find(
      (statement): statement is ts.ForOfStatement =>
        ts.isForOfStatement(statement) &&
        statement.expression.getText(sourceFile) === "descriptorKeys",
    );
    const directDescriptorPush =
      descriptorLoop !== undefined &&
      ts.isBlock(descriptorLoop.statement) &&
      descriptorLoop.statement.statements.some((statement) => {
        if (
          !ts.isExpressionStatement(statement) ||
          !ts.isCallExpression(statement.expression)
        ) {
          return false;
        }
        const call = statement.expression;
        return (
          call.expression.getText(sourceFile) === "children.push" &&
          call.arguments.length === 1 &&
          call.arguments[0]?.getText(sourceFile) ===
            '{ value: descriptor.value, path: `${path}.${key}` }'
        );
      });

    const childLoop = whileBody.statements.find(
      (statement): statement is ts.ForStatement => {
        const initializer = ts.isForStatement(statement)
          ? statement.initializer
          : undefined;
        if (
          !ts.isForStatement(statement) ||
          initializer === undefined ||
          !ts.isVariableDeclarationList(initializer) ||
          (initializer.flags & ts.NodeFlags.Let) === 0 ||
          initializer.declarations.length !== 1
        ) {
          return false;
        }
        const declaration = initializer.declarations[0]!;
        const declarationInitializer = declaration.initializer;
        return (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "index" &&
          declarationInitializer !== undefined &&
          ts.isBinaryExpression(declarationInitializer) &&
          declarationInitializer.operatorToken.kind === ts.SyntaxKind.MinusToken &&
          ts.isPropertyAccessExpression(declarationInitializer.left) &&
          ts.isIdentifier(declarationInitializer.left.expression) &&
          declarationInitializer.left.expression.text === "children" &&
          declarationInitializer.left.name.text === "length" &&
          ts.isNumericLiteral(declarationInitializer.right) &&
          declarationInitializer.right.text === "1" &&
          statement.condition?.getText(sourceFile) === "index >= 0" &&
          statement.incrementor?.getText(sourceFile) === "index -= 1"
        );
      },
    );
    let directChildTraversal = false;
    if (childLoop !== undefined && ts.isBlock(childLoop.statement)) {
      const childDeclaration = childLoop.statement.statements[0];
      const childGuard = childLoop.statement.statements[1];
      directChildTraversal =
        childLoop.statement.statements.length === 2 &&
        childDeclaration !== undefined &&
        ts.isVariableStatement(childDeclaration) &&
        childDeclaration.declarationList.declarations.length === 1 &&
        childDeclaration.declarationList.declarations[0]?.name.getText(sourceFile) ===
          "child" &&
        childDeclaration.declarationList.declarations[0]?.initializer?.getText(
          sourceFile,
        ) === "children[index]" &&
        childGuard !== undefined &&
        ts.isIfStatement(childGuard) &&
        childGuard.expression.getText(sourceFile) === "child !== undefined" &&
        ts.isBlock(childGuard.thenStatement) &&
        childGuard.thenStatement.statements.length === 1 &&
        childGuard.thenStatement.statements[0]?.getText(sourceFile) ===
          'stack.push({ kind: "enter", ...child });';
    }

    let childrenUseValid = true;
    function inspectChildrenUse(current: ts.Node): void {
      if (ts.isIdentifier(current) && current.text === "children") {
        const parent = current.parent;
        const declarationBinding =
          ts.isVariableDeclaration(parent) && parent.name === current;
        const pushReceiver =
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === current &&
          parent.name.text === "push" &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent &&
          parent.parent.arguments[0]?.getText(sourceFile) ===
            '{ value: descriptor.value, path: `${path}.${key}` }';
        const lengthRead =
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === current &&
          parent.name.text === "length" &&
          childLoop !== undefined &&
          ts.isBinaryExpression(parent.parent) &&
          parent.parent.left === parent &&
          parent.parent.operatorToken.kind === ts.SyntaxKind.MinusToken &&
          ts.isNumericLiteral(parent.parent.right) &&
          parent.parent.right.text === "1" &&
          ts.isVariableDeclaration(parent.parent.parent) &&
          parent.parent.parent.initializer === parent.parent &&
          parent.parent.parent.name.getText(sourceFile) === "index" &&
          parent.parent.parent.parent === childLoop.initializer;
        const indexedRead =
          ts.isElementAccessExpression(parent) &&
          parent.expression === current &&
          parent.argumentExpression.getText(sourceFile) === "index" &&
          childLoop !== undefined &&
          parent.getStart(sourceFile) >= childLoop.getStart(sourceFile);
        if (!declarationBinding && !pushReceiver && !lengthRead && !indexedRead) {
          childrenUseValid = false;
        }
      }
      ts.forEachChild(current, inspectChildrenUse);
    }
    inspectChildrenUse(whileBody);

    traversalShapeValid =
      candidateUsesValid &&
      directDescriptorPush &&
      directChildTraversal &&
      childrenUseValid;
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node)) {
      validateTraversalShape(node);
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "queryCatalogSkills"
    ) {
      validateQueryEntry(node);
    }
    if (
      (ts.isIdentifier(node) &&
        (node.text === "eval" || node.text === "Function")) ||
      ((ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)) &&
        ts.isElementAccessExpression(node.parent) &&
        node.parent.argumentExpression === node &&
        (node.text === "eval" || node.text === "Function"))
    ) {
      dynamicCodeUse = true;
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "node:util"
    ) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (
        clause?.isTypeOnly === false &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length === 1 &&
        bindings.elements[0]?.name.text === "types" &&
        bindings.elements[0]?.propertyName === undefined
      ) {
        exactImportCount += 1;
      } else {
        invalidTypesUse = true;
      }
    }
    if (ts.isIdentifier(node) && node.text === "types") {
      const parent = node.parent;
      const validImportBinding =
        ts.isImportSpecifier(parent) && parent.name === node;
      const validProxyReceiver =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "isProxy" &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent;
      if (!validImportBinding && !validProxyReceiver) invalidTypesUse = true;
      if (validProxyReceiver) {
        proxyCallCount += 1;
        const owner = containingFunction(node);
        if (owner !== undefined) {
          proxyFunctions.add(owner);
          validateProxyOrdering(parent.parent, owner);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return (
    exactImportCount === 1 &&
    proxyCallCount > 0 &&
    proxyFunctions.size > 0 &&
    proxyFunctions.size === proxyCallCount &&
    !invalidTypesUse &&
    !dynamicCodeUse &&
    proxyOrderingValid &&
    queryEntryValid &&
    traversalShapeValid
  );
}

function sourceIsTypeOnlyPort(sourceText: string): boolean {
  const sourceFile = ts.createSourceFile(
    APPLICATION_PORT,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return sourceFile.statements.every(
    (statement) =>
      (ts.isImportDeclaration(statement) &&
        statement.importClause?.isTypeOnly === true) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement),
  );
}

function evaluateCatalogBoundaryPolicy(input: PolicyInput): readonly string[] {
  const failures: string[] = [];
  const catalogInternal = input.graph.edges.filter((edge) => edge.from === CATALOG);
  const catalogExternal = (input.graph.externalDependencies ?? []).filter(
    (edge) => edge.from === CATALOG,
  );
  if (catalogInternal.length !== 0) failures.push("CATALOG_INTERNAL_EDGE");
  if (
    catalogExternal.length !== 1 ||
    catalogExternal[0]?.specifier !== "node:util" ||
    catalogExternal[0]?.syntax !== "static-import" ||
    catalogExternal[0]?.typeOnly !== false
  ) {
    failures.push("CATALOG_EXTERNAL_IMPORT");
  }
  if (!sourceUsesTypesIsProxyOnly(input.catalogSource)) {
    failures.push("CATALOG_PROXY_BINDING");
  }

  const portInternal = input.graph.edges.filter(
    (edge) => edge.from === APPLICATION_PORT,
  );
  const portExternal = (input.graph.externalDependencies ?? []).filter(
    (edge) => edge.from === APPLICATION_PORT,
  );
  if (
    portInternal.length !== 1 ||
    portInternal[0]?.to !== CATALOG ||
    portInternal[0]?.specifier !== CATALOG_SPECIFIER ||
    portInternal[0]?.syntax !== "static-import" ||
    portInternal[0]?.typeOnly !== true
  ) {
    failures.push("APPLICATION_PORT_EDGE");
  }
  if (portExternal.length !== 0) failures.push("APPLICATION_PORT_EXTERNAL");
  if (!sourceIsTypeOnlyPort(input.applicationPortSource)) {
    failures.push("APPLICATION_PORT_RUNTIME");
  }

  const catalogImporters = input.graph.edges.filter((edge) => edge.to === CATALOG);
  if (
    catalogImporters.length !== 1 ||
    catalogImporters[0]?.from !== APPLICATION_PORT
  ) {
    failures.push("CATALOG_IMPORTER");
  }
  if (input.graph.edges.some((edge) => edge.to === APPLICATION_PORT)) {
    failures.push("APPLICATION_PORT_IMPORTER");
  }

  const targetRules = input.manifest.rules.filter(
    (rule) =>
      rule.selector.kind === "exact" &&
      (rule.selector.path === CATALOG ||
        rule.selector.path === APPLICATION_PORT),
  );
  const catalogRule = targetRules.find(
    (rule) => rule.selector.path === CATALOG,
  );
  const applicationPortRule = targetRules.find(
    (rule) => rule.selector.path === APPLICATION_PORT,
  );
  if (
    targetRules.length !== 2 ||
    catalogRule?.classification !== "catalog-public-target" ||
    catalogRule.owner !== "Catalog" ||
    catalogRule.visibility !== "public-in-engine" ||
    catalogRule.effect !== "pure" ||
    catalogRule.lifecycle !== "active" ||
    applicationPortRule?.classification !==
      "application-catalog-read-port-target" ||
    applicationPortRule.owner !== "Application" ||
    applicationPortRule.visibility !== "internal" ||
    applicationPortRule.effect !== "pure" ||
    applicationPortRule.lifecycle !== "active"
  ) {
    failures.push("TARGET_CLASSIFICATION");
  }
  if (
    input.manifest.exceptions.some(
      (exception) =>
        exception.from === CATALOG ||
        exception.to === CATALOG ||
        exception.from === APPLICATION_PORT ||
        exception.to === APPLICATION_PORT,
    )
  ) {
    failures.push("TARGET_EXCEPTION");
  }
  return failures.sort();
}

let cachedRealInput: PolicyInput | undefined;

function realInput(): PolicyInput {
  if (cachedRealInput !== undefined) return cachedRealInput;
  const scanned = scanArchitectureGraph({ repoRoot });
  cachedRealInput = {
    graph: {
      files: scanned.files,
      edges: scanned.edges,
      externalDependencies: scanned.externalDependencies,
    },
    manifest: manifestJson as ArchitectureBoundaryManifest,
    catalogSource: fs.readFileSync(path.join(repoRoot, CATALOG), "utf8"),
    applicationPortSource: fs.readFileSync(
      path.join(repoRoot, APPLICATION_PORT),
      "utf8",
    ),
  };
  return cachedRealInput;
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

describe("catalog-boundary-policy", () => {
  test("enforces the exact Catalog query and Application read-port boundary", () => {
    expect(evaluateCatalogBoundaryPolicy(realInput())).toEqual([]);
  });

  test("fails command bypass, effects, inversion, deep edges, and cycles", () => {
    const base = realInput();
    const mutations = [
      {
        code: "CATALOG_IMPORTER",
        edge: {
          from: "scripts/commands/list-skills.ts",
          to: CATALOG,
          specifier: "../modules/catalog/query-skills.ts",
          syntax: "static-import" as const,
          typeOnly: false,
          line: 1,
          column: 1,
        },
      },
      {
        code: "CATALOG_IMPORTER",
        edge: {
          from: "scripts/bin/skill-sys",
          to: CATALOG,
          specifier: "../modules/catalog/query-skills.ts",
          syntax: "static-import" as const,
          typeOnly: false,
          line: 1,
          column: 1,
        },
      },
      {
        code: "CATALOG_INTERNAL_EDGE",
        edge: {
          from: CATALOG,
          to: "scripts/lib/effect.ts",
          specifier: "../../lib/effect.ts",
          syntax: "static-import" as const,
          typeOnly: false,
          line: 1,
          column: 1,
        },
      },
      {
        code: "CATALOG_INTERNAL_EDGE",
        edge: {
          from: CATALOG,
          to: APPLICATION_PORT,
          specifier: "../application/ports/catalog-skills-reader.ts",
          syntax: "static-import" as const,
          typeOnly: true,
          line: 1,
          column: 1,
        },
      },
      {
        code: "APPLICATION_PORT_EDGE",
        edge: {
          from: APPLICATION_PORT,
          to: "scripts/modules/catalog/internal/query.ts",
          specifier: "../../catalog/internal/query.ts",
          syntax: "static-import" as const,
          typeOnly: true,
          line: 1,
          column: 1,
        },
      },
      {
        code: "APPLICATION_PORT_IMPORTER",
        edge: {
          from: CATALOG,
          to: APPLICATION_PORT,
          specifier: "../application/ports/catalog-skills-reader.ts",
          syntax: "static-import" as const,
          typeOnly: true,
          line: 1,
          column: 1,
        },
      },
    ];
    for (const mutation of mutations) {
      const graph = clone(base.graph);
      (graph.edges as Array<(typeof graph.edges)[number]>).push(mutation.edge);
      expect(
        evaluateCatalogBoundaryPolicy({ ...base, graph }),
        mutation.code,
      ).toContain(mutation.code);
    }

    for (const specifier of [
      "node:fs",
      "node:process",
      "node:net",
      "node:console",
      "node:timers",
      "node:child_process",
    ]) {
      const graph = clone(base.graph);
      (graph.externalDependencies as Array<
        NonNullable<typeof graph.externalDependencies>[number]
      >).push({
        from: CATALOG,
        specifier,
        syntax: "static-import",
        typeOnly: false,
        line: 1,
        column: 1,
      });
      expect(evaluateCatalogBoundaryPolicy({ ...base, graph })).toContain(
        "CATALOG_EXTERNAL_IMPORT",
      );
    }
  });

  test("fails unclassified targets, broad exceptions, and escaped types use", () => {
    const base = realInput();
    const unclassified = clone(base.manifest);
    (unclassified.rules as Array<(typeof unclassified.rules)[number]>).splice(
      unclassified.rules.findIndex(
        (rule) =>
          rule.selector.kind === "exact" && rule.selector.path === CATALOG,
      ),
      1,
    );
    expect(
      evaluateCatalogBoundaryPolicy({ ...base, manifest: unclassified }),
    ).toContain("TARGET_CLASSIFICATION");

    for (const [target, field, value] of [
      [CATALOG, "owner", "Other"],
      [CATALOG, "visibility", "internal"],
      [CATALOG, "effect", "imperative"],
      [CATALOG, "lifecycle", "observed"],
      [APPLICATION_PORT, "owner", "Other"],
      [APPLICATION_PORT, "visibility", "public-in-engine"],
      [APPLICATION_PORT, "effect", "mixed"],
      [APPLICATION_PORT, "lifecycle", "observed"],
    ] as const) {
      const changedMetadata = clone(base.manifest);
      const rule = changedMetadata.rules.find(
        (candidate) =>
          candidate.selector.kind === "exact" &&
          candidate.selector.path === target,
      );
      if (rule === undefined) throw new Error("missing target rule fixture");
      (rule as unknown as Record<string, unknown>)[field] = value;
      expect(
        evaluateCatalogBoundaryPolicy({
          ...base,
          manifest: changedMetadata,
        }),
        `${target}:${field}`,
      ).toContain("TARGET_CLASSIFICATION");
    }

    const exception = clone(base.manifest);
    (exception.exceptions as Array<(typeof exception.exceptions)[number]>).push({
      ...exception.exceptions[0]!,
      id: "BROAD-TARGET-EXCEPTION",
      from: CATALOG,
      to: APPLICATION_PORT,
    });
    expect(
      evaluateCatalogBoundaryPolicy({ ...base, manifest: exception }),
    ).toContain("TARGET_EXCEPTION");

    expect(
      evaluateCatalogBoundaryPolicy({
        ...base,
        catalogSource: `${base.catalogSource}\nconst escaped = types;\n`,
      }),
    ).toContain("CATALOG_PROXY_BINDING");

    const proxyBindingMutations = [
      base.catalogSource.replace(
        "if (types.isProxy(candidate))",
        "const aliasedValue = candidate;\n    if (types.isProxy(aliasedValue))",
      ),
      base.catalogSource.replace(
        "if (types.isProxy(candidate))",
        "const { constructor } = candidate;\n    if (types.isProxy(candidate))",
      ),
      base.catalogSource.replace(
        "if (types.isProxy(candidate))",
        "void (candidate as { field?: unknown }).field;\n    if (types.isProxy(candidate))",
      ),
      base.catalogSource.replace(
        "rootPath: string,",
        "rootPath: string = String((root as { secret?: unknown }).secret),",
      ),
      base.catalogSource.replace(
        "if (types.isProxy(candidate))",
        "void (arguments[0] as { secret?: unknown }).secret;\n    if (types.isProxy(candidate))",
      ),
      base.catalogSource.replace(
        'if (types.isProxy(candidate)) {\n      fail(path, "proxy values are forbidden");\n    }',
        'if (types.isProxy(candidate)) {\n      fail(path, "proxy values are forbidden");\n    }\n    void (candidate as { secret?: unknown }).secret;',
      ),
      base.catalogSource.replace(
        'if (types.isProxy(candidate)) {\n      fail(path, "proxy values are forbidden");\n    }',
        'if (types.isProxy(candidate)) {\n      fail(path, "proxy values are forbidden");\n    }\n    void (arguments[0] as { secret?: unknown }).secret;',
      ),
      base.catalogSource.replace(
        "    const descriptors = Object.getOwnPropertyDescriptors(candidate);",
        "    const descriptors = Object.getOwnPropertyDescriptors(candidate);\n    void (candidate as { secret?: unknown }).secret;",
      ),
      base.catalogSource.replace(
        "    const descriptors = Object.getOwnPropertyDescriptors(candidate);",
        "    const descriptors = Object.getOwnPropertyDescriptors(candidate);\n    void (arguments[0] as { secret?: unknown }).secret;",
      ),
      base.catalogSource.replace(
        "    const descriptors = Object.getOwnPropertyDescriptors(candidate);",
        "    const descriptors = Object.getOwnPropertyDescriptors(candidate);\n    const leaked = candidate;\n    void (leaked as { secret?: unknown }).secret;",
      ),
      base.catalogSource.replace(
        '  assertPlainDataGraph(records, "records");',
        '  void records[0]?.name;\n  assertPlainDataGraph(records, "records");',
      ),
      base.catalogSource.replace(
        '  assertPlainDataGraph(selectedProfiles, "selectedProfiles");',
        '  void selectedProfiles[0]?.name;\n  assertPlainDataGraph(selectedProfiles, "selectedProfiles");',
      ),
      base.catalogSource.replace(
        '  assertPlainDataGraph(input, "input");',
        '  void input.categories;\n  assertPlainDataGraph(input, "input");',
      ),
      base.catalogSource.replace(
        'children.push({ value: descriptor.value, path: `${path}.${key}` });',
        'children.push({ value: null, path: `${path}.${key}` });',
      ),
      base.catalogSource.replace(
        'stack.push({ kind: "enter", ...child });',
        'if (false) {\n          stack.push({ kind: "enter", ...child });\n        }',
      ),
      base.catalogSource.replace(
        '      if (child !== undefined) {\n        stack.push({ kind: "enter", ...child });\n      }',
        '      if (child !== undefined) {\n        stack.push({ kind: "enter", ...child });\n      }\n      children.length = 0;',
      ),
      base.catalogSource.replace(
        '      if (child !== undefined) {\n        stack.push({ kind: "enter", ...child });\n      }',
        '      if (child !== undefined) {\n        stack.push({ kind: "enter", ...child });\n      }\n      index = 0;',
      ),
      base.catalogSource.replace(
        "for (let index = children.length - 1; index >= 0; index -= 1)",
        "for (let index = 0; index >= 0; index -= 1)",
      ),
      base.catalogSource.replace(
        "for (let index = children.length - 1; index >= 0; index -= 1)",
        "for (let index = (children.length = 0); index >= 0; index -= 1)",
      ),
      base.catalogSource.replace(
        '    stack.push({ kind: "exit", value: candidate });',
        '    children.length = 0;\n    stack.push({ kind: "exit", value: candidate });',
      ),
      base.catalogSource.replace(
        "    const descriptors = Object.getOwnPropertyDescriptors(candidate);",
        '    const descriptors = Object.getOwnPropertyDescriptors(candidate);\n    eval("candidate.secret");',
      ),
      base.catalogSource.replace(
        "    const descriptors = Object.getOwnPropertyDescriptors(candidate);",
        '    const descriptors = Object.getOwnPropertyDescriptors(candidate);\n    Function("candidate.secret")();',
      ),
      base.catalogSource.replace(
        "    const descriptors = Object.getOwnPropertyDescriptors(candidate);",
        '    const descriptors = Object.getOwnPropertyDescriptors(candidate);\n    globalThis[`eval`]("candidate.secret");',
      ),
      base.catalogSource.replace(
        "    const descriptors = Object.getOwnPropertyDescriptors(candidate);",
        '    const descriptors = Object.getOwnPropertyDescriptors(candidate);\n    globalThis[`Function`]("candidate.secret")();',
      ),
      base.catalogSource.replace(
        "if (types.isProxy(candidate))",
        "if (types.isProxy(path))",
      ),
      base.catalogSource.replace(
        "import { types } from \"node:util\";",
        "import { types as utilTypes } from \"node:util\";",
      ),
    ];
    for (const catalogSource of proxyBindingMutations) {
      expect(
        evaluateCatalogBoundaryPolicy({ ...base, catalogSource }),
      ).toContain("CATALOG_PROXY_BINDING");
    }
    expect(
      evaluateCatalogBoundaryPolicy({
        ...base,
        applicationPortSource: `${base.applicationPortSource}\nexport const runtime = true;\n`,
      }),
    ).toContain("APPLICATION_PORT_RUNTIME");
  });
});
