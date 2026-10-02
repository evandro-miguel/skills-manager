import {
  assertTypedContentConsumerTuple,
  type TypedContentDescriptor,
  TypedContentIdentityError,
  validateTypedContentDescriptor,
} from "./typed-content-identity.ts";
import { types as nodeUtilTypes } from "node:util";

export type SourceManifestV2Declaration = Readonly<{
  alias: string;
  locator: string;
  discovery_reference?: string;
}>;

export type SourceManifestV2 = Readonly<{
  schemaVersion: 2;
  declarations: readonly SourceManifestV2Declaration[];
}>;

export type SourceImmutableRevisionV2 =
  | Readonly<{ kind: "git-commit-sha1"; value: string }>
  | Readonly<{ kind: "local-snapshot-sha256"; value: string }>;

export type SourceOriginV2 = Readonly<{
  key: string;
  immutable_revision: SourceImmutableRevisionV2;
}>;

export type SourceResolutionV2 = Readonly<{
  alias: string;
  origin: SourceOriginV2;
  descriptor: TypedContentDescriptor & Readonly<{ kind: "skill" }>;
}>;

export type SourceLockV2 = Readonly<{
  schemaVersion: 2;
  resolutions: readonly SourceResolutionV2[];
}>;

export type SourceContractV2ErrorCode =
  | "INVALID_OBJECT"
  | "INVALID_ARRAY"
  | "INVALID_PROPERTY"
  | "INVALID_VALUE"
  | "MISSING_FIELD"
  | "UNKNOWN_FIELD"
  | "INVALID_SCHEMA_VERSION"
  | "INVALID_ALIAS"
  | "INVALID_TEXT"
  | "INVALID_UNICODE"
  | "DUPLICATE_ALIAS"
  | "NON_CANONICAL_ORDER"
  | "INVALID_ORIGIN_KEY"
  | "INVALID_IMMUTABLE_REVISION"
  | "INVALID_DESCRIPTOR"
  | "ORIGIN_DESCRIPTOR_MISMATCH";

export class SourceContractV2Error extends Error {
  override readonly name = "SourceContractV2Error";

  constructor(
    readonly code: SourceContractV2ErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    Object.freeze(this);
  }
}

export type SourceManifestV2ParseResult =
  | Readonly<{ ok: true; value: SourceManifestV2 }>
  | Readonly<{ ok: false; error: SourceContractV2Error }>;

export type SourceLockV2ParseResult =
  | Readonly<{ ok: true; value: SourceLockV2 }>
  | Readonly<{ ok: false; error: SourceContractV2Error }>;

type PlainRecord = Record<string, unknown>;

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._~-]{0,63}$/;
const LOWER_HEX_40_PATTERN = /^[a-f0-9]{40}$/;
const LOWER_HEX_64_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const MANIFEST_KEYS = new Set(["schemaVersion", "declarations"]);
const DECLARATION_KEYS = new Set(["alias", "locator", "discovery_reference"]);
const LOCK_KEYS = new Set(["schemaVersion", "resolutions"]);
const RESOLUTION_KEYS = new Set(["alias", "origin", "descriptor"]);
const ORIGIN_KEYS = new Set(["key", "immutable_revision"]);
const REVISION_KEYS = new Set(["kind", "value"]);
const SKILL_CONSUMER_TUPLE = Object.freeze({
  kind: "skill",
  algorithm: "sha-256",
  profile: "tree-v1",
  scope: "skill-content",
} as const);

function fail(
  code: SourceContractV2ErrorCode,
  path: string,
  message: string,
): never {
  throw new SourceContractV2Error(code, path, message);
}

function snapshotPlainData(
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object") {
    return fail("INVALID_VALUE", path, `${path} contains a non-data value`);
  }
  if (nodeUtilTypes.isProxy(value)) {
    return fail("INVALID_OBJECT", path, `${path} must not be a Proxy`);
  }
  if (ancestors.has(value)) {
    return fail("INVALID_VALUE", path, `${path} contains a cycle`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return fail("INVALID_ARRAY", path, `${path} must use the standard array prototype`);
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key === "symbol")) {
        return fail("UNKNOWN_FIELD", `${path}.[symbol]`, `${path} contains a symbol field`);
      }
      const allowedKeys = new Set([
        "length",
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ]);
      for (const key of ownKeys) {
        if (typeof key === "string" && !allowedKeys.has(key)) {
          return fail("UNKNOWN_FIELD", `${path}.${key}`, `${path} contains an extra array field`);
        }
      }
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (
          property === undefined ||
          property.enumerable !== true ||
          !Object.hasOwn(property, "value")
        ) {
          return fail(
            "INVALID_PROPERTY",
            `${path}.${key}`,
            `${path}.${key} must be an enumerable data property`,
          );
        }
        copy.push(snapshotPlainData(property.value, `${path}.${key}`, ancestors));
      }
      return Object.freeze(copy);
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return fail("INVALID_OBJECT", path, `${path} must be a plain object`);
    }
    const copy = Object.create(null) as PlainRecord;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        return fail("UNKNOWN_FIELD", `${path}.[symbol]`, `${path} contains a symbol field`);
      }
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (
        property === undefined ||
        property.enumerable !== true ||
        !Object.hasOwn(property, "value")
      ) {
        return fail(
          "INVALID_PROPERTY",
          `${path}.${key}`,
          `${path}.${key} must be an enumerable data property`,
        );
      }
      copy[key] = snapshotPlainData(property.value, `${path}.${key}`, ancestors);
    }
    return Object.freeze(copy);
  } catch (error) {
    if (error instanceof SourceContractV2Error) {
      throw error;
    }
    return fail("INVALID_VALUE", path, `${path} could not be inspected safely`);
  } finally {
    ancestors.delete(value);
  }
}

function requireObject(value: unknown, path: string): PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_OBJECT", path, `${path} must be an object`);
  }
  return value as PlainRecord;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    return fail("INVALID_ARRAY", path, `${path} must be an array`);
  }
  return value;
}

function exactKeys(
  value: PlainRecord,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("UNKNOWN_FIELD", `${path}.${key}`, `${path}.${key} is not allowed`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("MISSING_FIELD", `${path}.${key}`, `${path}.${key} is required`);
    }
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    return fail("INVALID_VALUE", path, `${path} must be a string`);
  }
  return value;
}

function validateAlias(value: unknown, path: string): string {
  const alias = requireString(value, path);
  if (!ALIAS_PATTERN.test(alias)) {
    return fail("INVALID_ALIAS", path, `${path} does not match the Source alias grammar`);
  }
  return alias;
}

function hasValidUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return false;
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateSanitizedText(
  value: unknown,
  path: string,
  maximumCodePoints: number,
): string {
  const text = requireString(value, path);
  if (!hasValidUnicodeScalars(text)) {
    return fail("INVALID_UNICODE", path, `${path} must contain only Unicode scalar values`);
  }
  const length = [...text].length;
  if (
    length < 1 ||
    length > maximumCodePoints ||
    text.trim() !== text ||
    CONTROL_PATTERN.test(text)
  ) {
    return fail("INVALID_TEXT", path, `${path} violates the bounded sanitized text grammar`);
  }
  return text;
}

function validateCanonicalAliases<T extends Readonly<{ alias: string }>>(
  entries: readonly T[],
  path: string,
): void {
  const aliases = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const alias = entries[index]!.alias;
    if (aliases.has(alias)) {
      fail("DUPLICATE_ALIAS", `${path}.${index}.alias`, `duplicate alias '${alias}'`);
    }
    aliases.add(alias);
  }
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!;
    const current = entries[index]!;
    if (previous.alias > current.alias) {
      fail(
        "NON_CANONICAL_ORDER",
        `${path}.${index}.alias`,
        `${path} must use ascending ASCII alias order`,
      );
    }
  }
}

function validateSchemaVersion(value: unknown): 2 {
  if (value !== 2) {
    return fail(
      "INVALID_SCHEMA_VERSION",
      "schemaVersion",
      "schemaVersion must be exactly 2",
    );
  }
  return 2;
}

function validateDeclaration(value: unknown, index: number): SourceManifestV2Declaration {
  const path = `declarations.${index}`;
  const declaration = requireObject(value, path);
  exactKeys(declaration, DECLARATION_KEYS, ["alias", "locator"], path);
  const canonical: {
    alias: string;
    locator: string;
    discovery_reference?: string;
  } = {
    alias: validateAlias(declaration.alias, `${path}.alias`),
    locator: validateSanitizedText(declaration.locator, `${path}.locator`, 2048),
  };
  if (Object.hasOwn(declaration, "discovery_reference")) {
    canonical.discovery_reference = validateSanitizedText(
      declaration.discovery_reference,
      `${path}.discovery_reference`,
      256,
    );
  }
  return Object.freeze(canonical);
}

function validateImmutableRevision(
  value: unknown,
  path: string,
): SourceImmutableRevisionV2 {
  const revision = requireObject(value, path);
  exactKeys(revision, REVISION_KEYS, ["kind", "value"], path);
  const kind = requireString(revision.kind, `${path}.kind`);
  const revisionValue = requireString(revision.value, `${path}.value`);
  if (kind === "git-commit-sha1" && LOWER_HEX_40_PATTERN.test(revisionValue)) {
    return Object.freeze({ kind, value: revisionValue });
  }
  if (kind === "local-snapshot-sha256" && LOWER_HEX_64_PATTERN.test(revisionValue)) {
    return Object.freeze({ kind, value: revisionValue });
  }
  return fail(
    "INVALID_IMMUTABLE_REVISION",
    path,
    `${path} is not an authorized immutable revision`,
  );
}

function validateOrigin(value: unknown, path: string): SourceOriginV2 {
  const origin = requireObject(value, path);
  exactKeys(origin, ORIGIN_KEYS, ["key", "immutable_revision"], path);
  const key = requireString(origin.key, `${path}.key`);
  if (!LOWER_HEX_64_PATTERN.test(key)) {
    return fail(
      "INVALID_ORIGIN_KEY",
      `${path}.key`,
      `${path}.key must be 64 lowercase hexadecimal characters`,
    );
  }
  return Object.freeze({
    key,
    immutable_revision: validateImmutableRevision(
      origin.immutable_revision,
      `${path}.immutable_revision`,
    ),
  });
}

function validateSkillDescriptor(
  value: unknown,
  path: string,
): TypedContentDescriptor & Readonly<{ kind: "skill" }> {
  try {
    const descriptor = validateTypedContentDescriptor(value);
    assertTypedContentConsumerTuple(descriptor, SKILL_CONSUMER_TUPLE);
    return descriptor as TypedContentDescriptor & Readonly<{ kind: "skill" }>;
  } catch (error) {
    if (error instanceof TypedContentIdentityError) {
      const errorPath =
        error.path === "descriptor"
          ? path
          : error.path.startsWith("descriptor.")
            ? `${path}${error.path.slice("descriptor".length)}`
            : `${path}.${error.path}`;
      return fail("INVALID_DESCRIPTOR", errorPath, error.message);
    }
    throw error;
  }
}

function validateResolution(value: unknown, index: number): SourceResolutionV2 {
  const path = `resolutions.${index}`;
  const resolution = requireObject(value, path);
  exactKeys(resolution, RESOLUTION_KEYS, ["alias", "origin", "descriptor"], path);
  const origin = validateOrigin(resolution.origin, `${path}.origin`);
  const descriptor = validateSkillDescriptor(resolution.descriptor, `${path}.descriptor`);
  if (
    origin.immutable_revision.kind === "local-snapshot-sha256" &&
    origin.immutable_revision.value !== descriptor.digest.value
  ) {
    return fail(
      "ORIGIN_DESCRIPTOR_MISMATCH",
      `${path}.origin.immutable_revision.value`,
      "local snapshot revision must equal descriptor.digest.value",
    );
  }
  return Object.freeze({
    alias: validateAlias(resolution.alias, `${path}.alias`),
    origin,
    descriptor,
  });
}

export function validateSourceManifestV2(value: unknown): SourceManifestV2 {
  const manifest = requireObject(snapshotPlainData(value, "manifest"), "manifest");
  exactKeys(manifest, MANIFEST_KEYS, ["schemaVersion", "declarations"], "manifest");
  const declarations = requireArray(manifest.declarations, "declarations").map(
    validateDeclaration,
  );
  validateCanonicalAliases(declarations, "declarations");
  return Object.freeze({
    schemaVersion: validateSchemaVersion(manifest.schemaVersion),
    declarations: Object.freeze(declarations),
  });
}

export function parseSourceManifestV2(value: unknown): SourceManifestV2ParseResult {
  try {
    return Object.freeze({ ok: true, value: validateSourceManifestV2(value) });
  } catch (error) {
    if (error instanceof SourceContractV2Error) {
      return Object.freeze({ ok: false, error });
    }
    throw error;
  }
}

export function validateSourceLockV2(value: unknown): SourceLockV2 {
  const lock = requireObject(snapshotPlainData(value, "lock"), "lock");
  exactKeys(lock, LOCK_KEYS, ["schemaVersion", "resolutions"], "lock");
  const resolutions = requireArray(lock.resolutions, "resolutions").map(validateResolution);
  validateCanonicalAliases(resolutions, "resolutions");
  return Object.freeze({
    schemaVersion: validateSchemaVersion(lock.schemaVersion),
    resolutions: Object.freeze(resolutions),
  });
}

export function parseSourceLockV2(value: unknown): SourceLockV2ParseResult {
  try {
    return Object.freeze({ ok: true, value: validateSourceLockV2(value) });
  } catch (error) {
    if (error instanceof SourceContractV2Error) {
      return Object.freeze({ ok: false, error });
    }
    throw error;
  }
}
