import { types } from "node:util";

export type CommandAudienceV1 = "public" | "compatibility" | "planned";
export type CommandStabilityV1 = "experimental" | "stable" | "deprecated";
export type CommandSideEffectV1 = "read" | "plan" | "write" | "destructive";
export type CommandInputValueTypeV1 = "path" | "text" | "boolean";
export type CommandInputRepeatPolicyV1 =
  | "last"
  | "idempotent"
  | "drop-to-default-on-repeat"
  | "unsupported";
export type CommandInputRepeatV1 = Readonly<{
  facade: CommandInputRepeatPolicyV1;
  standalone: CommandInputRepeatPolicyV1;
}>;
export type CommandCliSurfaceV1 = "facade" | "standalone";
export type CommandEffectV1 =
  | "filesystem-read"
  | "filesystem-write"
  | "network"
  | "process-execution"
  | "provider-execution"
  | "llm-execution"
  | "tool-execution";

export type CommandInputSpecV1 = Readonly<{
  id: string;
  token: string;
  valueType: CommandInputValueTypeV1;
  required: boolean;
  default: boolean | null;
  repeat: CommandInputRepeatV1;
  applicationInput: boolean;
  cliSurfaces: readonly CommandCliSurfaceV1[];
}>;

export type CommandSpecV1 = Readonly<{
  schemaVersion: 1;
  id: string;
  name: string;
  aliases: readonly string[];
  audience: CommandAudienceV1;
  stability: CommandStabilityV1;
  summary: string;
  sideEffect: CommandSideEffectV1;
  inputs: readonly CommandInputSpecV1[];
  permissions: readonly string[];
  effects: readonly CommandEffectV1[];
  applicationHandler: string;
  result: Readonly<{
    schemaVersion: 1;
    type: string;
    schema: string;
  }>;
  surfaces: Readonly<{
    cli: "active" | "unsupported";
    mcp: "active" | "unsupported";
  }>;
  observedExit: Readonly<{
    resultStatuses: Readonly<{
      PASS: number;
      CONCERNS: number;
      BLOCKED: number;
    }>;
    thrownError: Readonly<{
      exitCode: number;
      stderrPrefix: string;
    }>;
  }>;
  observedErrors: Readonly<{
    kind: "legacy-prose";
    facadeAndStandaloneMayDiffer: boolean;
  }>;
}>;

export type LegacyCommandObservation = Readonly<{
  name: string;
  aliases: string[];
  audience: CommandAudienceV1;
  summary: string;
}>;

export type CommandSpecValidationErrorCode =
  | "INVALID_DATA"
  | "INVALID_FIELD"
  | "INVALID_SEMANTICS"
  | "UNSUPPORTED_CONTRACT"
  | "COLLISION";

export class CommandSpecValidationError extends Error {
  override readonly name = "CommandSpecValidationError";

  constructor(
    readonly code: CommandSpecValidationErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    Object.freeze(this);
  }
}

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "id",
  "name",
  "aliases",
  "audience",
  "stability",
  "summary",
  "sideEffect",
  "inputs",
  "permissions",
  "effects",
  "applicationHandler",
  "result",
  "surfaces",
  "observedExit",
  "observedErrors",
] as const;
const INPUT_KEYS = [
  "id",
  "token",
  "valueType",
  "required",
  "default",
  "repeat",
  "applicationInput",
  "cliSurfaces",
] as const;
const REPEAT_KEYS = ["facade", "standalone"] as const;
const LEGACY_KEYS = ["name", "aliases", "audience", "summary"] as const;
const RESULT_KEYS = ["schemaVersion", "type", "schema"] as const;
const SURFACE_KEYS = ["cli", "mcp"] as const;
const OBSERVED_EXIT_KEYS = ["resultStatuses", "thrownError"] as const;
const RESULT_STATUS_KEYS = ["PASS", "CONCERNS", "BLOCKED"] as const;
const THROWN_ERROR_KEYS = ["exitCode", "stderrPrefix"] as const;
const OBSERVED_ERROR_KEYS = [
  "kind",
  "facadeAndStandaloneMayDiffer",
] as const;

const AUDIENCES = new Set<CommandAudienceV1>([
  "public",
  "compatibility",
  "planned",
]);
const STABILITIES = new Set<CommandStabilityV1>([
  "experimental",
  "stable",
  "deprecated",
]);
const SIDE_EFFECTS = new Set<CommandSideEffectV1>([
  "read",
  "plan",
  "write",
  "destructive",
]);
const VALUE_TYPES = new Set<CommandInputValueTypeV1>(["path", "text", "boolean"]);
const REPEAT_POLICIES = new Set<CommandInputRepeatPolicyV1>([
  "last",
  "idempotent",
  "drop-to-default-on-repeat",
  "unsupported",
]);
const CLI_SURFACES = new Set<CommandCliSurfaceV1>([
  "facade",
  "standalone",
]);
const EFFECTS = new Set<CommandEffectV1>([
  "filesystem-read",
  "filesystem-write",
  "network",
  "process-execution",
  "provider-execution",
  "llm-execution",
  "tool-execution",
]);
const KNOWN_APPLICATION_HANDLERS = new Set([
  "telemetry-policy.validate",
  "team-mode.validate",
  "memory-adapter.validate",
  "memory-adapter.read",
  "memory-adapter.write",
  "project-learnings.validate",
  "project-learnings.write",
  "registry-trust.evaluate",
]);
const KNOWN_RESULT_SCHEMAS = new Set([
  "schema/telemetry-policy-result.schema.json",
  "schema/team-mode-result.schema.json",
  "schema/memory-adapter-result.schema.json",
  "schema/memory-adapter-read-result.schema.json",
  "schema/memory-adapter-write-result.schema.json",
  "schema/project-learnings-result.schema.json",
  "schema/project-learnings-write-result.schema.json",
  "schema/registry-trust-result.schema.json",
]);
const LOCAL_POLICY_READ_HANDLERS = new Set([
  "telemetry-policy.validate",
  "team-mode.validate",
  "memory-adapter.validate",
  "memory-adapter.read",
  "project-learnings.validate",
  "registry-trust.evaluate",
]);
const LOCAL_POLICY_WRITE_HANDLERS = new Set([
  "memory-adapter.write",
  "project-learnings.write",
]);
const KNOWN_HANDLER_RESULTS = new Map<
  string,
  Readonly<{ type: string; schema: string }>
>([
  [
    "telemetry-policy.validate",
    {
      type: "telemetry-policy-result",
      schema: "schema/telemetry-policy-result.schema.json",
    },
  ],
  [
    "team-mode.validate",
    {
      type: "team-mode-result",
      schema: "schema/team-mode-result.schema.json",
    },
  ],
  [
    "memory-adapter.validate",
    {
      type: "memory-adapter-result",
      schema: "schema/memory-adapter-result.schema.json",
    },
  ],
  [
    "memory-adapter.read",
    {
      type: "memory-adapter-read-result",
      schema: "schema/memory-adapter-read-result.schema.json",
    },
  ],
  [
    "memory-adapter.write",
    {
      type: "memory-adapter-write-result",
      schema: "schema/memory-adapter-write-result.schema.json",
    },
  ],
  [
    "project-learnings.validate",
    {
      type: "project-learnings-result",
      schema: "schema/project-learnings-result.schema.json",
    },
  ],
  [
    "project-learnings.write",
    {
      type: "project-learnings-write-result",
      schema: "schema/project-learnings-write-result.schema.json",
    },
  ],
  [
    "registry-trust.evaluate",
    {
      type: "registry-trust-result",
      schema: "schema/registry-trust-result.schema.json",
    },
  ],
]);
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const CLI_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const OPTION_PATTERN = /^(?:--[a-z][a-z0-9]*(?:-[a-z0-9]+)*|-[a-z])$/u;
const PERMISSION_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const RESULT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const MAX_DATA_DEPTH = 64;
const MAX_DATA_NODES = 4096;
const MAX_CONTAINER_ENTRIES = 4096;

function fail(
  code: CommandSpecValidationErrorCode,
  path: string,
  message: string,
): never {
  throw new CommandSpecValidationError(code, path, message);
}

function inspectPlainData(value: unknown): void {
  type InspectionFrame =
    | Readonly<{ kind: "enter"; value: unknown; depth: number }>
    | Readonly<{ kind: "exit"; value: object }>;

  const active = new Set<object>();
  const stack: InspectionFrame[] = [{ kind: "enter", value, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "exit") {
      active.delete(frame.value);
      continue;
    }
    const current = frame.value;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        fail("INVALID_DATA", "$", "non-finite numbers are unsupported");
      }
      continue;
    }
    if (typeof current !== "object") {
      fail("INVALID_DATA", "$", "unsupported data type");
    }
    nodes += 1;
    if (nodes > MAX_DATA_NODES || frame.depth > MAX_DATA_DEPTH) {
      fail("INVALID_DATA", "$", "data complexity limit exceeded");
    }

    let isProxy: boolean;
    try {
      isProxy = types.isProxy(current);
    } catch {
      fail("INVALID_DATA", "$", "hostile object");
    }
    if (isProxy) fail("INVALID_DATA", "$", "proxy values are unsupported");

    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(current);
      const entryCount = Reflect.ownKeys(current).length;
      if (entryCount > MAX_CONTAINER_ENTRIES) {
        fail("INVALID_DATA", "$", "container entry limit exceeded");
      }
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch (error) {
      if (error instanceof CommandSpecValidationError) throw error;
      fail("INVALID_DATA", "$", "hostile object");
    }
    if (active.has(current)) {
      fail("INVALID_DATA", "$", "cyclic values are unsupported");
    }
    active.add(current);
    stack.push({ kind: "exit", value: current });

    const isArray = Array.isArray(current);
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      fail("INVALID_DATA", "$", "exotic objects are unsupported");
    }
    const keys = Reflect.ownKeys(descriptors);
    if (
      isArray &&
      keys.filter((key) => key !== "length").length !== current.length
    ) {
      fail("INVALID_DATA", "$", "sparse arrays are unsupported");
    }

    const children: unknown[] = [];
    for (const key of keys) {
      if (typeof key !== "string") {
        fail("INVALID_DATA", "$", "symbol keys are unsupported");
      }
      if (isArray && key === "length") continue;
      if (
        isArray &&
        (!/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= current.length)
      ) {
        fail("INVALID_DATA", "$", "unknown array fields are unsupported");
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        fail("INVALID_DATA", "$", "accessors or hidden fields are unsupported");
      }
      children.push(descriptor.value);
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        kind: "enter",
        value: children[index],
        depth: frame.depth + 1,
      });
    }
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_FIELD", path, "expected an object");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return fail("INVALID_FIELD", path, "unknown or missing field");
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  path: string,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    CONTROL_PATTERN.test(value) ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    return fail("INVALID_FIELD", path, "invalid string");
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    return fail("INVALID_FIELD", path, "expected a boolean");
  }
  return value;
}

function requireExitCode(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 255) {
    return fail("INVALID_FIELD", path, "invalid exit code");
  }
  return value as number;
}

function requireEnum<Value extends string>(
  value: unknown,
  allowed: ReadonlySet<Value>,
  path: string,
): Value {
  if (typeof value !== "string" || !allowed.has(value as Value)) {
    return fail("INVALID_FIELD", path, "unsupported value");
  }
  return value as Value;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    return fail("INVALID_FIELD", path, "expected an array");
  }
  return value;
}

function uniqueStrings(
  value: unknown,
  path: string,
  validate: (entry: unknown, path: string) => string,
): readonly string[] {
  const entries = requireArray(value, path);
  const seen = new Set<string>();
  const output: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const item = validate(entry, `${path}[${index}]`);
    if (seen.has(item)) {
      fail("INVALID_SEMANTICS", path, "duplicate entry");
    }
    seen.add(item);
    output.push(item);
  }
  return output;
}

function validateInput(value: unknown, index: number): CommandInputSpecV1 {
  const path = `$.inputs[${index}]`;
  const input = exactRecord(value, INPUT_KEYS, path);
  const id = requireString(input.id, `${path}.id`, CLI_NAME_PATTERN);
  const token = requireString(input.token, `${path}.token`, OPTION_PATTERN);
  const valueType = requireEnum(input.valueType, VALUE_TYPES, `${path}.valueType`);
  const required = requireBoolean(input.required, `${path}.required`);
  const rawRepeat = exactRecord(input.repeat, REPEAT_KEYS, `${path}.repeat`);
  const repeat = Object.freeze({
    facade: requireEnum(
      rawRepeat.facade,
      REPEAT_POLICIES,
      `${path}.repeat.facade`,
    ),
    standalone: requireEnum(
      rawRepeat.standalone,
      REPEAT_POLICIES,
      `${path}.repeat.standalone`,
    ),
  });
  const applicationInput = requireBoolean(
    input.applicationInput,
    `${path}.applicationInput`,
  );
  const cliSurfaces = uniqueStrings(
    input.cliSurfaces,
    `${path}.cliSurfaces`,
    (entry, entryPath) => requireEnum(entry, CLI_SURFACES, entryPath),
  ) as readonly CommandCliSurfaceV1[];
  if (cliSurfaces.length === 0) {
    fail("INVALID_SEMANTICS", `${path}.cliSurfaces`, "at least one surface is required");
  }
  for (const surface of CLI_SURFACES) {
    const declared = cliSurfaces.includes(surface);
    const policy = repeat[surface];
    if (declared === (policy === "unsupported")) {
      fail(
        "INVALID_SEMANTICS",
        `${path}.repeat.${surface}`,
        "repeat policy must match the declared CLI surfaces",
      );
    }
  }

  if (valueType === "path") {
    if (
      input.default !== null ||
      required !== true ||
      repeat.facade !== "last" ||
      repeat.standalone !== "last" ||
      applicationInput !== true ||
      !token.startsWith("--")
    ) {
      fail("INVALID_SEMANTICS", path, "invalid scalar path input policy");
    }
  } else if (valueType === "text") {
    if (
      input.default !== null ||
      repeat.facade !== "last" ||
      repeat.standalone !== "last" ||
      applicationInput !== true ||
      !token.startsWith("--")
    ) {
      fail("INVALID_SEMANTICS", path, "invalid text input policy");
    }
  } else if (
    input.default !== false ||
    required !== false ||
    repeat.standalone !== "idempotent" ||
    (repeat.facade !== "idempotent" &&
      repeat.facade !== "drop-to-default-on-repeat" &&
      repeat.facade !== "unsupported")
  ) {
    fail("INVALID_SEMANTICS", path, "invalid boolean input policy");
  }

  return Object.freeze({
    id,
    token,
    valueType,
    required,
    default: valueType === "path" || valueType === "text" ? null : false,
    repeat,
    applicationInput,
    cliSurfaces: Object.freeze([...cliSurfaces]),
  });
}

function validateLegacyObservation(
  value: unknown,
  index: number,
): LegacyCommandObservation {
  const path = `$legacy[${index}]`;
  const record = exactRecord(value, LEGACY_KEYS, path);
  const name = requireString(record.name, `${path}.name`, CLI_NAME_PATTERN);
  const aliases = [
    ...uniqueStrings(record.aliases, `${path}.aliases`, (entry, entryPath) =>
      requireString(entry, entryPath, CLI_NAME_PATTERN),
    ),
  ];
  if (aliases.includes(name)) {
    fail("COLLISION", `${path}.aliases`, "canonical name cannot also be an alias");
  }
  Object.freeze(aliases);
  return Object.freeze({
    name,
    aliases,
    audience: requireEnum(record.audience, AUDIENCES, `${path}.audience`),
    summary: requireString(record.summary, `${path}.summary`),
  });
}

function assertNoDuplicates(
  values: readonly string[],
  path: string,
  message: string,
): void {
  if (new Set(values).size !== values.length) {
    fail("COLLISION", path, message);
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateCommandSpecV1(value: unknown): CommandSpecV1 {
  inspectPlainData(value);
  const spec = exactRecord(value, TOP_LEVEL_KEYS, "$");
  if (spec.schemaVersion !== 1) {
    fail("UNSUPPORTED_CONTRACT", "$.schemaVersion", "unsupported schema version");
  }

  const id = requireString(spec.id, "$.id", IDENTIFIER_PATTERN);
  const name = requireString(spec.name, "$.name", CLI_NAME_PATTERN);
  const aliases = uniqueStrings(spec.aliases, "$.aliases", (entry, path) =>
    requireString(entry, path, CLI_NAME_PATTERN),
  );
  if (aliases.includes(name)) {
    fail("COLLISION", "$.aliases", "canonical name cannot also be an alias");
  }
  const audience = requireEnum(spec.audience, AUDIENCES, "$.audience");
  const stability = requireEnum(spec.stability, STABILITIES, "$.stability");
  const summary = requireString(spec.summary, "$.summary");
  const sideEffect = requireEnum(spec.sideEffect, SIDE_EFFECTS, "$.sideEffect");

  const rawInputs = requireArray(spec.inputs, "$.inputs");
  if (rawInputs.length === 0) {
    fail("INVALID_SEMANTICS", "$.inputs", "at least one input is required");
  }
  const inputs = rawInputs.map(validateInput);
  assertNoDuplicates(
    inputs.map((input) => input.id),
    "$.inputs",
    "duplicate input id",
  );
  assertNoDuplicates(
    inputs.map((input) => input.token),
    "$.inputs",
    "duplicate option token",
  );

  const permissions = uniqueStrings(
    spec.permissions,
    "$.permissions",
    (entry, path) => requireString(entry, path, PERMISSION_PATTERN),
  );
  const effects = uniqueStrings(spec.effects, "$.effects", (entry, path) =>
    requireEnum(entry, EFFECTS, path),
  ) as readonly CommandEffectV1[];
  if (
    sideEffect === "read" &&
    effects.some((effect) => effect !== "filesystem-read")
  ) {
    fail(
      "INVALID_SEMANTICS",
      "$.effects",
      "read commands cannot declare executable or mutating effects",
    );
  }

  const applicationHandler = requireString(
    spec.applicationHandler,
    "$.applicationHandler",
    IDENTIFIER_PATTERN,
  );
  if (!KNOWN_APPLICATION_HANDLERS.has(applicationHandler)) {
    fail(
      "UNSUPPORTED_CONTRACT",
      "$.applicationHandler",
      "unknown application handler",
    );
  }
  if (
    LOCAL_POLICY_READ_HANDLERS.has(applicationHandler) &&
    (permissions.length !== 1 ||
      permissions[0] !== "policy.local.read" ||
      effects.length !== 1 ||
      effects[0] !== "filesystem-read")
  ) {
    fail(
      "INVALID_SEMANTICS",
      "$.applicationHandler",
      "handler capabilities do not match the registered contract",
    );
  }
  if (
    LOCAL_POLICY_WRITE_HANDLERS.has(applicationHandler) &&
    (permissions.length !== 2 ||
      permissions[0] !== "policy.local.read" ||
      permissions[1] !== "policy.local.write" ||
      effects.length !== 2 ||
      effects[0] !== "filesystem-read" ||
      effects[1] !== "filesystem-write")
  ) {
    fail(
      "INVALID_SEMANTICS",
      "$.applicationHandler",
      "handler capabilities do not match the registered contract",
    );
  }

  const rawResult = exactRecord(spec.result, RESULT_KEYS, "$.result");
  if (rawResult.schemaVersion !== 1) {
    fail(
      "UNSUPPORTED_CONTRACT",
      "$.result.schemaVersion",
      "unsupported result schema version",
    );
  }
  const resultType = requireString(
    rawResult.type,
    "$.result.type",
    RESULT_TYPE_PATTERN,
  );
  const resultSchema = requireString(rawResult.schema, "$.result.schema");
  if (!KNOWN_RESULT_SCHEMAS.has(resultSchema)) {
    fail("UNSUPPORTED_CONTRACT", "$.result.schema", "unknown result schema");
  }
  const expectedResult = KNOWN_HANDLER_RESULTS.get(applicationHandler);
  if (
    expectedResult === undefined ||
    expectedResult.type !== resultType ||
    expectedResult.schema !== resultSchema
  ) {
    fail(
      "INVALID_SEMANTICS",
      "$.result",
      "result contract does not match the registered application handler",
    );
  }

  const rawSurfaces = exactRecord(spec.surfaces, SURFACE_KEYS, "$.surfaces");
  const cli = requireEnum(
    rawSurfaces.cli,
    new Set(["active", "unsupported"] as const),
    "$.surfaces.cli",
  );
  const mcp = requireEnum(
    rawSurfaces.mcp,
    new Set(["active", "unsupported"] as const),
    "$.surfaces.mcp",
  );
  if (cli !== "active" || mcp !== "unsupported") {
    fail(
      "UNSUPPORTED_CONTRACT",
      "$.surfaces",
      "transport has no owned adapter and characterization evidence",
    );
  }

  const rawObservedExit = exactRecord(
    spec.observedExit,
    OBSERVED_EXIT_KEYS,
    "$.observedExit",
  );
  const rawStatuses = exactRecord(
    rawObservedExit.resultStatuses,
    RESULT_STATUS_KEYS,
    "$.observedExit.resultStatuses",
  );
  const rawThrownError = exactRecord(
    rawObservedExit.thrownError,
    THROWN_ERROR_KEYS,
    "$.observedExit.thrownError",
  );
  const rawObservedErrors = exactRecord(
    spec.observedErrors,
    OBSERVED_ERROR_KEYS,
    "$.observedErrors",
  );
  if (rawObservedErrors.kind !== "legacy-prose") {
    fail("INVALID_FIELD", "$.observedErrors.kind", "unsupported value");
  }

  return deepFreeze({
    schemaVersion: 1,
    id,
    name,
    aliases: [...aliases],
    audience,
    stability,
    summary,
    sideEffect,
    inputs: [...inputs],
    permissions: [...permissions],
    effects: [...effects],
    applicationHandler,
    result: {
      schemaVersion: 1,
      type: resultType,
      schema: resultSchema,
    },
    surfaces: { cli, mcp },
    observedExit: {
      resultStatuses: {
        PASS: requireExitCode(
          rawStatuses.PASS,
          "$.observedExit.resultStatuses.PASS",
        ),
        CONCERNS: requireExitCode(
          rawStatuses.CONCERNS,
          "$.observedExit.resultStatuses.CONCERNS",
        ),
        BLOCKED: requireExitCode(
          rawStatuses.BLOCKED,
          "$.observedExit.resultStatuses.BLOCKED",
        ),
      },
      thrownError: {
        exitCode: requireExitCode(
          rawThrownError.exitCode,
          "$.observedExit.thrownError.exitCode",
        ),
        stderrPrefix: requireString(
          rawThrownError.stderrPrefix,
          "$.observedExit.thrownError.stderrPrefix",
        ),
      },
    },
    observedErrors: {
      kind: "legacy-prose",
      facadeAndStandaloneMayDiffer: requireBoolean(
        rawObservedErrors.facadeAndStandaloneMayDiffer,
        "$.observedErrors.facadeAndStandaloneMayDiffer",
      ),
    },
  } satisfies CommandSpecV1);
}

export function validateCommandSpecRegistry(
  value: unknown,
  legacyValue: unknown = [],
): readonly CommandSpecV1[] {
  inspectPlainData(value);
  inspectPlainData(legacyValue);
  const specs = requireArray(value, "$registry").map((entry) =>
    validateCommandSpecV1(entry),
  );
  const legacy = requireArray(legacyValue, "$legacy").map(
    validateLegacyObservation,
  );

  assertNoDuplicates(
    specs.map((spec) => spec.id),
    "$registry",
    "duplicate semantic id",
  );
  assertNoDuplicates(
    specs.map((spec) => spec.applicationHandler),
    "$registry",
    "duplicate application handler",
  );

  const tokenOwners = new Map<string, string>();
  const registerToken = (token: string, owner: string, path: string): void => {
    const previous = tokenOwners.get(token);
    if (previous !== undefined && previous !== owner) {
      fail("COLLISION", path, "command name or alias collision");
    }
    tokenOwners.set(token, owner);
  };
  for (const spec of specs) {
    registerToken(spec.name, spec.id, "$registry");
    for (const alias of spec.aliases) registerToken(alias, spec.id, "$registry");
  }
  for (const [index, observation] of legacy.entries()) {
    const owner = `legacy:${index}:${observation.name}`;
    registerToken(observation.name, owner, "$legacy");
    for (const alias of observation.aliases) {
      registerToken(alias, owner, "$legacy");
    }
  }

  return deepFreeze([...specs]);
}

export function resolveCommandSpec(
  registry: unknown,
  token: string,
): CommandSpecV1 | null {
  const normalized = token.trim();
  if (!CLI_NAME_PATTERN.test(normalized)) return null;
  const specs = validateCommandSpecRegistry(registry);
  return (
    specs.find(
      (spec) => spec.name === normalized || spec.aliases.includes(normalized),
    ) ?? null
  );
}

export function projectCommandSpecToLegacyObservation(
  value: unknown,
): LegacyCommandObservation {
  const spec = validateCommandSpecV1(value);
  const aliases = [...spec.aliases];
  Object.freeze(aliases);
  return Object.freeze({
    name: spec.name,
    aliases,
    audience: spec.audience,
    summary: spec.summary,
  });
}

export function serializeCommandSpecV1(value: unknown): string {
  return `${JSON.stringify(validateCommandSpecV1(value), null, 2)}\n`;
}

const TELEMETRY_POLICY_COMMAND_SPEC_INPUT = {
  schemaVersion: 1,
  id: "policy.telemetry.validate",
  name: "telemetry-policy",
  aliases: ["telemetry"],
  audience: "public",
  stability: "experimental",
  summary:
    "Validate local telemetry policy opt-in gates without collecting telemetry.",
  sideEffect: "read",
  inputs: [
    {
      id: "source",
      token: "--source",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "config",
      token: "--config",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "json",
      token: "--json",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "strict",
      token: "--strict",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help",
      token: "--help",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: false,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help-short",
      token: "-h",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: { facade: "unsupported", standalone: "idempotent" },
      applicationInput: false,
      cliSurfaces: ["standalone"],
    },
  ],
  permissions: ["policy.local.read"],
  effects: ["filesystem-read"],
  applicationHandler: "telemetry-policy.validate",
  result: {
    schemaVersion: 1,
    type: "telemetry-policy-result",
    schema: "schema/telemetry-policy-result.schema.json",
  },
  surfaces: {
    cli: "active",
    mcp: "unsupported",
  },
  observedExit: {
    resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 0 },
    thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
  },
  observedErrors: {
    kind: "legacy-prose",
    facadeAndStandaloneMayDiffer: true,
  },
} as const;

const TEAM_MODE_COMMAND_SPEC_INPUT = {
  schemaVersion: 1,
  id: "policy.team-mode.validate",
  name: "team-mode",
  aliases: ["team"],
  audience: "public",
  stability: "experimental",
  summary:
    "Validate deterministic team-mode config without packaging catalogs or enabling symlink installs.",
  sideEffect: "read",
  inputs: [
    {
      id: "source",
      token: "--source",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "config",
      token: "--config",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "json",
      token: "--json",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "strict",
      token: "--strict",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help",
      token: "--help",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: false,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help-short",
      token: "-h",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: { facade: "unsupported", standalone: "idempotent" },
      applicationInput: false,
      cliSurfaces: ["standalone"],
    },
  ],
  permissions: ["policy.local.read"],
  effects: ["filesystem-read"],
  applicationHandler: "team-mode.validate",
  result: {
    schemaVersion: 1,
    type: "team-mode-result",
    schema: "schema/team-mode-result.schema.json",
  },
  surfaces: {
    cli: "active",
    mcp: "unsupported",
  },
  observedExit: {
    resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
    thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
  },
  observedErrors: {
    kind: "legacy-prose",
    facadeAndStandaloneMayDiffer: true,
  },
} as const;

const MEMORY_ADAPTER_COMMAND_SPEC_INPUT = {
  schemaVersion: 1,
  id: "memory.adapter.validate",
  name: "memory-adapter",
  aliases: ["memory"],
  audience: "public",
  stability: "experimental",
  summary:
    "Validate local/private memory adapter interfaces without invoking them.",
  sideEffect: "read",
  inputs: [
    {
      id: "source",
      token: "--source",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "config",
      token: "--config",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "json",
      token: "--json",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "strict",
      token: "--strict",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help",
      token: "--help",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: false,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help-short",
      token: "-h",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: { facade: "unsupported", standalone: "idempotent" },
      applicationInput: false,
      cliSurfaces: ["standalone"],
    },
  ],
  permissions: ["policy.local.read"],
  effects: ["filesystem-read"],
  applicationHandler: "memory-adapter.validate",
  result: {
    schemaVersion: 1,
    type: "memory-adapter-result",
    schema: "schema/memory-adapter-result.schema.json",
  },
  surfaces: {
    cli: "active",
    mcp: "unsupported",
  },
  observedExit: {
    resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
    thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
  },
  observedErrors: {
    kind: "legacy-prose",
    facadeAndStandaloneMayDiffer: true,
  },
} as const;

const MEMORY_ADAPTER_READ_COMMAND_SPEC_INPUT = {
  schemaVersion: 1,
  id: "memory.adapter.read",
  name: "memory-adapter-read",
  aliases: [],
  audience: "public",
  stability: "experimental",
  summary:
    "Read memory records from a local/private JSONL memory adapter under explicit trust policy.",
  sideEffect: "read",
  inputs: [
    {
      id: "source",
      token: "--source",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "config",
      token: "--config",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "json",
      token: "--json",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "strict",
      token: "--strict",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help",
      token: "--help",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: false,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help-short",
      token: "-h",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: { facade: "unsupported", standalone: "idempotent" },
      applicationInput: false,
      cliSurfaces: ["standalone"],
    },
  ],
  permissions: ["policy.local.read"],
  effects: ["filesystem-read"],
  applicationHandler: "memory-adapter.read",
  result: {
    schemaVersion: 1,
    type: "memory-adapter-read-result",
    schema: "schema/memory-adapter-read-result.schema.json",
  },
  surfaces: {
    cli: "active",
    mcp: "unsupported",
  },
  observedExit: {
    resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
    thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
  },
  observedErrors: {
    kind: "legacy-prose",
    facadeAndStandaloneMayDiffer: true,
  },
} as const;

const MEMORY_ADAPTER_WRITE_COMMAND_SPEC_INPUT = {
  schemaVersion: 1,
  id: "memory.adapter.write",
  name: "memory-adapter-write",
  aliases: [],
  audience: "public",
  stability: "experimental",
  summary:
    "Append a memory record to a local/private JSONL memory adapter under explicit trust policy.",
  sideEffect: "write",
  inputs: [
    {
      id: "source",
      token: "--source",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "config",
      token: "--config",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "id",
      token: "--id",
      valueType: "text",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "memory",
      token: "--memory",
      valueType: "text",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "source-entry",
      token: "--source-entry",
      valueType: "text",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "dry-run",
      token: "--dry-run",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "json",
      token: "--json",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "strict",
      token: "--strict",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help",
      token: "--help",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: false,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help-short",
      token: "-h",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: { facade: "unsupported", standalone: "idempotent" },
      applicationInput: false,
      cliSurfaces: ["standalone"],
    },
  ],
  permissions: ["policy.local.read", "policy.local.write"],
  effects: ["filesystem-read", "filesystem-write"],
  applicationHandler: "memory-adapter.write",
  result: {
    schemaVersion: 1,
    type: "memory-adapter-write-result",
    schema: "schema/memory-adapter-write-result.schema.json",
  },
  surfaces: {
    cli: "active",
    mcp: "unsupported",
  },
  observedExit: {
    resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
    thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
  },
  observedErrors: {
    kind: "legacy-prose",
    facadeAndStandaloneMayDiffer: true,
  },
} as const;

const PROJECT_LEARNINGS_COMMAND_SPEC_INPUT = {
  schemaVersion: 1,
  id: "project.learnings.validate",
  name: "project-learnings",
  aliases: ["learnings"],
  audience: "public",
  stability: "experimental",
  summary: "Validate local/private project learnings without publishing them.",
  sideEffect: "read",
  inputs: [
    {
      id: "source",
      token: "--source",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "learnings",
      token: "--learnings",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "json",
      token: "--json",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "strict",
      token: "--strict",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help",
      token: "--help",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: false,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help-short",
      token: "-h",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: { facade: "unsupported", standalone: "idempotent" },
      applicationInput: false,
      cliSurfaces: ["standalone"],
    },
  ],
  permissions: ["policy.local.read"],
  effects: ["filesystem-read"],
  applicationHandler: "project-learnings.validate",
  result: {
    schemaVersion: 1,
    type: "project-learnings-result",
    schema: "schema/project-learnings-result.schema.json",
  },
  surfaces: {
    cli: "active",
    mcp: "unsupported",
  },
  observedExit: {
    resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
    thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
  },
  observedErrors: {
    kind: "legacy-prose",
    facadeAndStandaloneMayDiffer: true,
  },
} as const;

const PROJECT_LEARNINGS_WRITE_COMMAND_SPEC_INPUT = {
  schemaVersion: 1,
  id: "project.learnings.write",
  name: "project-learnings-write",
  aliases: [],
  audience: "public",
  stability: "experimental",
  summary: "Append or update a local/private project learning entry.",
  sideEffect: "write",
  inputs: [
    {
      id: "source",
      token: "--source",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "learnings",
      token: "--learnings",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "id",
      token: "--id",
      valueType: "text",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "summary",
      token: "--summary",
      valueType: "text",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    // `--source-entry` is required for `append` only (the `update` subcommand
    // does not take it). The input model cannot express per-command
    // requirement, so it stays required on the write spec; the standalone CLI
    // enforces the append-only rule.
    {
      id: "source-entry",
      token: "--source-entry",
      valueType: "text",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "dry-run",
      token: "--dry-run",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "json",
      token: "--json",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "strict",
      token: "--strict",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help",
      token: "--help",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: false,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help-short",
      token: "-h",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: { facade: "unsupported", standalone: "idempotent" },
      applicationInput: false,
      cliSurfaces: ["standalone"],
    },
  ],
  permissions: ["policy.local.read", "policy.local.write"],
  effects: ["filesystem-read", "filesystem-write"],
  applicationHandler: "project-learnings.write",
  result: {
    schemaVersion: 1,
    type: "project-learnings-write-result",
    schema: "schema/project-learnings-write-result.schema.json",
  },
  surfaces: {
    cli: "active",
    mcp: "unsupported",
  },
  observedExit: {
    resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
    thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
  },
  observedErrors: {
    kind: "legacy-prose",
    facadeAndStandaloneMayDiffer: true,
  },
} as const;

const REGISTRY_TRUST_COMMAND_SPEC_INPUT = {
  schemaVersion: 1,
  id: "trust.registry.evaluate",
  name: "registry-trust",
  aliases: ["registry-trust-score", "trust-score"],
  audience: "public",
  stability: "experimental",
  summary:
    "Score registry trust from a local scorecard and validated registry surface.",
  sideEffect: "read",
  inputs: [
    {
      id: "source",
      token: "--source",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "scorecard",
      token: "--scorecard",
      valueType: "path",
      required: true,
      default: null,
      repeat: { facade: "last", standalone: "last" },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "json",
      token: "--json",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "strict",
      token: "--strict",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: true,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help",
      token: "--help",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: {
        facade: "drop-to-default-on-repeat",
        standalone: "idempotent",
      },
      applicationInput: false,
      cliSurfaces: ["facade", "standalone"],
    },
    {
      id: "help-short",
      token: "-h",
      valueType: "boolean",
      required: false,
      default: false,
      repeat: { facade: "unsupported", standalone: "idempotent" },
      applicationInput: false,
      cliSurfaces: ["standalone"],
    },
  ],
  permissions: ["policy.local.read"],
  effects: ["filesystem-read"],
  applicationHandler: "registry-trust.evaluate",
  result: {
    schemaVersion: 1,
    type: "registry-trust-result",
    schema: "schema/registry-trust-result.schema.json",
  },
  surfaces: {
    cli: "active",
    mcp: "unsupported",
  },
  observedExit: {
    resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 0 },
    thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
  },
  observedErrors: {
    kind: "legacy-prose",
    facadeAndStandaloneMayDiffer: true,
  },
} as const;

export function createTelemetryPolicyCommandSpec(): CommandSpecV1 {
  return validateCommandSpecV1(TELEMETRY_POLICY_COMMAND_SPEC_INPUT);
}

export const TELEMETRY_POLICY_COMMAND_SPEC =
  createTelemetryPolicyCommandSpec();

export function createTeamModeCommandSpec(): CommandSpecV1 {
  return validateCommandSpecV1(TEAM_MODE_COMMAND_SPEC_INPUT);
}

export const TEAM_MODE_COMMAND_SPEC = createTeamModeCommandSpec();

export function createMemoryAdapterCommandSpec(): CommandSpecV1 {
  return validateCommandSpecV1(MEMORY_ADAPTER_COMMAND_SPEC_INPUT);
}

export const MEMORY_ADAPTER_COMMAND_SPEC =
  createMemoryAdapterCommandSpec();

export function createMemoryAdapterReadCommandSpec(): CommandSpecV1 {
  return validateCommandSpecV1(MEMORY_ADAPTER_READ_COMMAND_SPEC_INPUT);
}

export const MEMORY_ADAPTER_READ_COMMAND_SPEC =
  createMemoryAdapterReadCommandSpec();

export function createMemoryAdapterWriteCommandSpec(): CommandSpecV1 {
  return validateCommandSpecV1(MEMORY_ADAPTER_WRITE_COMMAND_SPEC_INPUT);
}

export const MEMORY_ADAPTER_WRITE_COMMAND_SPEC =
  createMemoryAdapterWriteCommandSpec();

export function createProjectLearningsCommandSpec(): CommandSpecV1 {
  return validateCommandSpecV1(PROJECT_LEARNINGS_COMMAND_SPEC_INPUT);
}

export const PROJECT_LEARNINGS_COMMAND_SPEC =
  createProjectLearningsCommandSpec();

export function createProjectLearningsWriteCommandSpec(): CommandSpecV1 {
  return validateCommandSpecV1(PROJECT_LEARNINGS_WRITE_COMMAND_SPEC_INPUT);
}

export const PROJECT_LEARNINGS_WRITE_COMMAND_SPEC =
  createProjectLearningsWriteCommandSpec();

export function createRegistryTrustCommandSpec(): CommandSpecV1 {
  return validateCommandSpecV1(REGISTRY_TRUST_COMMAND_SPEC_INPUT);
}

export const REGISTRY_TRUST_COMMAND_SPEC =
  createRegistryTrustCommandSpec();
