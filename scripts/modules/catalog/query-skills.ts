import { types } from "node:util";

type CatalogProfileMetadata = Readonly<{
  name: string;
  description?: string;
  curation?: string;
  scope?: string;
}>;

export type CatalogSkillRecord = Readonly<{
  name: string;
  description: string;
  category: string;
  tags: readonly string[];
  triggers: readonly string[];
  version: string;
  updated_at: string;
  target_provider: string;
  path: string;
  profiles: readonly string[];
  profile_metadata: readonly CatalogProfileMetadata[];
  internal: boolean;
  experimental: boolean;
}>;

export type CatalogSelectedProfileRecord = Readonly<{
  name: string;
  description?: string;
  curation?: string;
  scope?: string;
  skills: readonly string[];
}>;

export type CatalogSkillsQueryInput = Readonly<{
  categories: readonly string[];
  tags: readonly string[];
  queries: readonly string[];
  profiles: readonly string[];
  includeInternal: boolean;
  includeExperimental: boolean;
}>;

export type CatalogSkillsQueryResult = Readonly<{
  matchCount: number;
  skills: readonly CatalogSkillRecord[];
}>;

export class CatalogQueryInputError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "CatalogQueryInputError";
    this.path = path;
  }
}

const SKILL_FIELDS = [
  "name",
  "description",
  "category",
  "tags",
  "triggers",
  "version",
  "updated_at",
  "target_provider",
  "path",
  "profiles",
  "profile_metadata",
  "internal",
  "experimental",
] as const;

const PROFILE_FIELDS = [
  "name",
  "description",
  "curation",
  "scope",
  "skills",
] as const;

const QUERY_FIELDS = [
  "categories",
  "tags",
  "queries",
  "profiles",
  "includeInternal",
  "includeExperimental",
] as const;

const UTF8_ENCODER = new TextEncoder();

function fail(path: string, message: string): never {
  throw new CatalogQueryInputError(path, message);
}

function isCanonicalArrayIndex(key: string): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) {
    return false;
  }
  const value = Number(key);
  return Number.isSafeInteger(value) && value >= 0 && value < 4_294_967_295;
}

/**
 * Reject hostile object mechanics over the complete input graph before any
 * query code reads caller-controlled properties.
 */
function assertPlainDataGraph(
  root: unknown,
  rootPath: string,
): void {
  type InspectionFrame =
    | Readonly<{ kind: "enter"; value: unknown; path: string }>
    | Readonly<{ kind: "exit"; value: object }>;

  const visiting = new WeakSet<object>();
  const checked = new WeakSet<object>();
  const stack: InspectionFrame[] = [{ kind: "enter", value: root, path: rootPath }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      continue;
    }
    if (frame.kind === "exit") {
      visiting.delete(frame.value);
      checked.add(frame.value);
      continue;
    }

    const { value: candidate, path } = frame;
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean" ||
      typeof candidate === "number"
    ) {
      continue;
    }
    if (typeof candidate !== "object") {
      fail(path, `unsupported ${typeof candidate} value`);
    }
    if (types.isProxy(candidate)) {
      fail(path, "proxy values are forbidden");
    }
    if (checked.has(candidate)) {
      continue;
    }
    if (visiting.has(candidate)) {
      fail(path, "cyclic values are forbidden");
    }
    visiting.add(candidate);

    const prototype = Object.getPrototypeOf(candidate);
    const isArray = Array.isArray(candidate);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype) {
      fail(path, "only ordinary plain records and dense arrays are allowed");
    }

    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const descriptorKeys = Reflect.ownKeys(descriptors);
    const children: Readonly<{ value: unknown; path: string }>[] = [];
    for (const key of descriptorKeys) {
      if (typeof key === "symbol") {
        fail(path, "symbol fields are forbidden");
      }
      const descriptor = descriptors[key];
      if (!descriptor) {
        fail(path, "property descriptor could not be inspected");
      }
      if ("get" in descriptor || "set" in descriptor) {
        fail(`${path}.${key}`, "accessor fields are forbidden");
      }

      if (isArray && key === "length") {
        continue;
      }
      if (!descriptor.enumerable) {
        fail(`${path}.${key}`, "hidden non-enumerable fields are forbidden");
      }
      if (isArray && !isCanonicalArrayIndex(key)) {
        fail(`${path}.${key}`, "custom array fields are forbidden");
      }
      children.push({ value: descriptor.value, path: `${path}.${key}` });
    }

    if (isArray) {
      const lengthDescriptor = descriptors.length;
      const length =
        lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
      if (typeof length !== "number" || descriptorKeys.length !== length + 1) {
        fail(path, "sparse arrays are forbidden");
      }
      for (let index = 0; index < length; index += 1) {
        if (!Object.hasOwn(descriptors, String(index))) {
          fail(`${path}.${index}`, "sparse arrays are forbidden");
        }
      }
    }

    stack.push({ kind: "exit", value: candidate });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) {
        stack.push({ kind: "enter", ...child });
      }
    }
  }
}

function assertExactFields(
  value: object,
  allowedFields: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      fail(`${path}.${field}`, "unknown field");
    }
  }
  for (const field of allowedFields) {
    if (!Object.hasOwn(value, field)) {
      fail(`${path}.${field}`, "missing required field");
    }
  }
}

function assertOptionalFields(
  value: object,
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  path: string,
): void {
  const allowed = new Set([...requiredFields, ...optionalFields]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      fail(`${path}.${field}`, "unknown field");
    }
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(value, field)) {
      fail(`${path}.${field}`, "missing required field");
    }
  }
}

function assertWellFormedUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) {
        fail(path, "must contain well-formed Unicode");
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        fail(path, "must contain well-formed Unicode");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(path, "must contain well-formed Unicode");
    }
  }
}

function assertString(value: unknown, path: string, allowEmpty = true): string {
  if (typeof value !== "string") {
    fail(path, "must be a string");
  }
  assertWellFormedUnicode(value, path);
  if (!allowEmpty && value.length === 0) {
    fail(path, "must be a non-empty string");
  }
  return value;
}

function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(path, "must be a boolean");
  }
  return value;
}

function assertStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    fail(path, "must be an array of strings");
  }
  return value.map((item, index) => assertString(item, `${path}.${index}`, false));
}

function assertSafeRelativePath(value: unknown, path: string): string {
  const candidate = assertString(value, path, false);
  if (
    candidate.startsWith("/") ||
    /^[A-Za-z]:/.test(candidate) ||
    candidate.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/.test(candidate) ||
    UTF8_ENCODER.encode(candidate).length > 4_096 ||
    candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(path, "must be a safe relative path");
  }
  return candidate;
}

function validateProfileMetadata(
  value: unknown,
  path: string,
): CatalogProfileMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be a profile metadata record");
  }
  assertOptionalFields(value, ["name"], ["description", "curation", "scope"], path);
  const source = value as Record<string, unknown>;
  const metadata: {
    name: string;
    description?: string;
    curation?: string;
    scope?: string;
  } = { name: assertString(source.name, `${path}.name`, false) };
  for (const field of ["description", "curation", "scope"] as const) {
    if (Object.hasOwn(source, field)) {
      metadata[field] = assertString(source[field], `${path}.${field}`);
    }
  }
  return Object.freeze(metadata);
}

function validateSkill(value: unknown, index: number): CatalogSkillRecord {
  const path = `records.${index}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be a Catalog skill record");
  }
  assertExactFields(value, SKILL_FIELDS, path);
  const source = value as Record<string, unknown>;
  const tags = Object.freeze([...assertStringArray(source.tags, `${path}.tags`)]);
  const triggers = Object.freeze([
    ...assertStringArray(source.triggers, `${path}.triggers`),
  ]);
  const profiles = Object.freeze([
    ...assertStringArray(source.profiles, `${path}.profiles`),
  ]);
  if (!Array.isArray(source.profile_metadata)) {
    fail(`${path}.profile_metadata`, "must be an array of profile metadata");
  }
  const profileMetadata = Object.freeze(
    source.profile_metadata.map((entry, metadataIndex) =>
      validateProfileMetadata(entry, `${path}.profile_metadata.${metadataIndex}`),
    ),
  );

  return Object.freeze({
    name: assertString(source.name, `${path}.name`, false),
    description: assertString(source.description, `${path}.description`),
    category: assertString(source.category, `${path}.category`),
    tags,
    triggers,
    version: assertString(source.version, `${path}.version`),
    updated_at: assertString(source.updated_at, `${path}.updated_at`),
    target_provider: assertString(source.target_provider, `${path}.target_provider`),
    path: assertSafeRelativePath(source.path, `${path}.path`),
    profiles,
    profile_metadata: profileMetadata,
    internal: assertBoolean(source.internal, `${path}.internal`),
    experimental: assertBoolean(source.experimental, `${path}.experimental`),
  });
}

function validateSelectedProfile(
  value: unknown,
  index: number,
): CatalogSelectedProfileRecord {
  const path = `selectedProfiles.${index}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be a selected profile record");
  }
  assertOptionalFields(
    value,
    ["name", "skills"],
    PROFILE_FIELDS.filter((field) => field !== "name" && field !== "skills"),
    path,
  );
  const source = value as Record<string, unknown>;
  const skills = Object.freeze([
    ...assertStringArray(source.skills, `${path}.skills`),
  ]);
  const profile: {
    name: string;
    description?: string;
    curation?: string;
    scope?: string;
    skills: readonly string[];
  } = {
    name: assertString(source.name, `${path}.name`, false),
    skills,
  };
  for (const field of ["description", "curation", "scope"] as const) {
    if (Object.hasOwn(source, field)) {
      profile[field] = assertString(source[field], `${path}.${field}`);
    }
  }
  return Object.freeze(profile);
}

function validateQueryInput(value: unknown): CatalogSkillsQueryInput {
  const path = "input";
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be a Catalog query record");
  }
  assertExactFields(value, QUERY_FIELDS, path);
  const source = value as Record<string, unknown>;
  return Object.freeze({
    categories: Object.freeze([
      ...assertStringArray(source.categories, `${path}.categories`),
    ]),
    tags: Object.freeze([...assertStringArray(source.tags, `${path}.tags`)]),
    queries: Object.freeze([...assertStringArray(source.queries, `${path}.queries`)]),
    profiles: Object.freeze([
      ...assertStringArray(source.profiles, `${path}.profiles`),
    ]),
    includeInternal: assertBoolean(source.includeInternal, `${path}.includeInternal`),
    includeExperimental: assertBoolean(
      source.includeExperimental,
      `${path}.includeExperimental`,
    ),
  });
}

function lower(value: string): string {
  return value.toLowerCase();
}

function splitTokens(values: readonly string[]): readonly string[] {
  return values.flatMap((value) =>
    value
      .split(/[,\s]+/)
      .map((token) => lower(token.trim()))
      .filter(Boolean),
  );
}

function bytewiseCompare(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function profileMetadata(profile: CatalogSelectedProfileRecord): CatalogProfileMetadata {
  const metadata: {
    name: string;
    description?: string;
    curation?: string;
    scope?: string;
  } = { name: profile.name };
  for (const field of ["description", "curation", "scope"] as const) {
    if (profile[field] !== undefined) {
      metadata[field] = profile[field];
    }
  }
  return Object.freeze(metadata);
}

function matchesFilters(
  skill: CatalogSkillRecord,
  input: CatalogSkillsQueryInput,
): boolean {
  if (input.categories.length > 0) {
    const category = lower(skill.category);
    if (!input.categories.some((candidate) => lower(candidate) === category)) {
      return false;
    }
  }
  if (input.tags.length > 0) {
    const tokens = new Set(splitTokens([...skill.tags, ...skill.triggers]));
    if (!input.tags.some((candidate) => tokens.has(lower(candidate)))) {
      return false;
    }
  }
  if (input.queries.length > 0) {
    const haystack = lower(
      [
        skill.name,
        skill.description,
        skill.category,
        skill.tags.join(" "),
        skill.triggers.join(" "),
      ].join(" "),
    );
    if (!input.queries.some((query) => haystack.includes(lower(query)))) {
      return false;
    }
  }
  return true;
}

/**
 * Pure package-internal implementation of `catalog.skills.query`.
 *
 * The imperative adapter owns filesystem discovery. This function receives
 * detached records and selected profile data, validates them fail-closed, then
 * filters, annotates, and bytewise-sorts immutable detached results.
 */
export function queryCatalogSkills(
  records: readonly CatalogSkillRecord[],
  selectedProfiles: readonly CatalogSelectedProfileRecord[],
  input: CatalogSkillsQueryInput,
): CatalogSkillsQueryResult {
  assertPlainDataGraph(records, "records");
  assertPlainDataGraph(selectedProfiles, "selectedProfiles");
  assertPlainDataGraph(input, "input");

  if (!Array.isArray(records)) {
    fail("records", "must be an array");
  }
  if (!Array.isArray(selectedProfiles)) {
    fail("selectedProfiles", "must be an array");
  }
  const validatedRecords = records.map(validateSkill);
  const validatedProfiles = selectedProfiles.map(validateSelectedProfile);
  const validatedInput = validateQueryInput(input);

  if (validatedInput.profiles.length !== validatedProfiles.length) {
    fail(
      "selectedProfiles",
      "must correspond one-for-one with input.profiles in selection order",
    );
  }
  const identities = new Set<string>();
  for (const skill of validatedRecords) {
    const identity = `${skill.name.length}:${skill.name}${skill.path}`;
    if (identities.has(identity)) {
      fail("records", `duplicate Catalog skill identity '${skill.name}' + '${skill.path}'`);
    }
    identities.add(identity);
  }

  const profileLookup = new Map<string, CatalogProfileMetadata[]>();
  for (const profile of validatedProfiles) {
    const metadata = profileMetadata(profile);
    for (const skillName of profile.skills) {
      const annotations = profileLookup.get(skillName) ?? [];
      annotations.push(metadata);
      profileLookup.set(skillName, annotations);
    }
  }

  const restrictToProfiles = validatedInput.profiles.length > 0;
  const skills = validatedRecords
    .filter((skill) => validatedInput.includeInternal || !skill.internal)
    .filter((skill) => validatedInput.includeExperimental || !skill.experimental)
    .filter((skill) => !restrictToProfiles || profileLookup.has(skill.name))
    .filter((skill) => matchesFilters(skill, validatedInput))
    .map((skill): CatalogSkillRecord => {
      const metadata = Object.freeze([...(profileLookup.get(skill.name) ?? [])]);
      return Object.freeze({
        ...skill,
        tags: Object.freeze([...skill.tags]),
        triggers: Object.freeze([...skill.triggers]),
        profiles: Object.freeze(metadata.map(({ name }) => name)),
        profile_metadata: metadata,
      });
    })
    .sort((left, right) => {
      const byName = bytewiseCompare(left.name, right.name);
      return byName === 0 ? bytewiseCompare(left.path, right.path) : byName;
    });

  const frozenSkills = Object.freeze(skills);
  return Object.freeze({
    matchCount: frozenSkills.length,
    skills: frozenSkills,
  });
}
