export const CONTENT_IDENTITY_ALGORITHM = "sha-256" as const;

export const CONTENT_IDENTITY_KINDS = [
  "skill",
  "skillpack",
  "provider",
  "projection",
  "schema",
  "profile",
  "bundle",
  "agent-pack",
] as const;

export type ContentIdentityKind = (typeof CONTENT_IDENTITY_KINDS)[number];
export type ContentDigestProfile = "tree-v1" | "json-jcs-v1";
export type ContentDigestScope =
  | "skill-content"
  | "skillpack-manifest"
  | "provider-manifest"
  | "projection-output"
  | "schema-document"
  | "profile-manifest"
  | "bundle-manifest"
  | "agent-pack-manifest";

export type ContentIdentityContractMap = {
  skill: { profile: "tree-v1"; scope: "skill-content" };
  skillpack: { profile: "json-jcs-v1"; scope: "skillpack-manifest" };
  provider: { profile: "json-jcs-v1"; scope: "provider-manifest" };
  projection: { profile: "tree-v1"; scope: "projection-output" };
  schema: { profile: "json-jcs-v1"; scope: "schema-document" };
  profile: { profile: "json-jcs-v1"; scope: "profile-manifest" };
  bundle: { profile: "json-jcs-v1"; scope: "bundle-manifest" };
  "agent-pack": { profile: "json-jcs-v1"; scope: "agent-pack-manifest" };
};

export type ContentDigestDescriptor<K extends ContentIdentityKind = ContentIdentityKind> = {
  [Kind in K]: Readonly<{
    algorithm: typeof CONTENT_IDENTITY_ALGORITHM;
    profile: ContentIdentityContractMap[Kind]["profile"];
    scope: ContentIdentityContractMap[Kind]["scope"];
    value: string;
  }>;
}[K];

export type TypedContentDescriptor = {
  [K in ContentIdentityKind]: Readonly<{
    kind: K;
    logical_id: string;
    revision: string;
    digest: ContentDigestDescriptor<K>;
  }>;
}[ContentIdentityKind];

export type ContentConsumerTuple = {
  [K in ContentIdentityKind]: Readonly<{
    kind: K;
    algorithm: typeof CONTENT_IDENTITY_ALGORITHM;
    profile: ContentIdentityContractMap[K]["profile"];
    scope: ContentIdentityContractMap[K]["scope"];
  }>;
}[ContentIdentityKind];

export type TypedContentIdentityErrorCode =
  | "INVALID_OBJECT"
  | "INVALID_PROPERTY"
  | "MISSING_FIELD"
  | "UNKNOWN_FIELD"
  | "INVALID_TYPE"
  | "UNKNOWN_KIND"
  | "INVALID_KIND"
  | "INVALID_LOGICAL_ID"
  | "INVALID_REVISION"
  | "INVALID_ALGORITHM"
  | "INVALID_PROFILE"
  | "INVALID_SCOPE"
  | "INVALID_DIGEST";

export class TypedContentIdentityError extends Error {
  override readonly name = "TypedContentIdentityError";

  constructor(
    readonly code: TypedContentIdentityErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    Object.freeze(this);
  }
}

export type TypedContentDescriptorParseResult =
  | Readonly<{ ok: true; value: TypedContentDescriptor }>
  | Readonly<{ ok: false; error: TypedContentIdentityError }>;

type KindContract = {
  profile: ContentDigestProfile;
  scope: ContentDigestScope;
  validateLogicalId: (logicalId: string) => boolean;
};

const QUALIFIED_TOKEN = "[a-z0-9][a-z0-9._~-]{0,63}";
const PROVIDER_TOKEN = "[a-z0-9][a-z0-9-]{0,31}";
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
function isQualifiedToken(value: string): boolean {
  return value !== "." && value !== "..";
}

function qualifiedLogicalIdPattern(kind: ContentIdentityKind): RegExp {
  return new RegExp(`^${kind}:(${QUALIFIED_TOKEN})/(${QUALIFIED_TOKEN})$`);
}

function validateQualifiedLogicalId(kind: ContentIdentityKind, logicalId: string): boolean {
  const match = qualifiedLogicalIdPattern(kind).exec(logicalId);
  return match !== null && isQualifiedToken(match[1] ?? "") && isQualifiedToken(match[2] ?? "");
}

function validateProviderLogicalId(logicalId: string): boolean {
  return new RegExp(`^provider:${PROVIDER_TOKEN}$`).test(logicalId);
}

function validateProjectionLogicalId(logicalId: string): boolean {
  const match = new RegExp(
    `^projection:(${PROVIDER_TOKEN})/(${QUALIFIED_TOKEN})/(${QUALIFIED_TOKEN})$`,
  ).exec(logicalId);
  return match !== null && isQualifiedToken(match[2] ?? "") && isQualifiedToken(match[3] ?? "");
}

const KIND_CONTRACTS: Readonly<Record<ContentIdentityKind, KindContract>> = {
  skill: {
    profile: "tree-v1",
    scope: "skill-content",
    validateLogicalId: (logicalId) => validateQualifiedLogicalId("skill", logicalId),
  },
  skillpack: {
    profile: "json-jcs-v1",
    scope: "skillpack-manifest",
    validateLogicalId: (logicalId) => validateQualifiedLogicalId("skillpack", logicalId),
  },
  provider: {
    profile: "json-jcs-v1",
    scope: "provider-manifest",
    validateLogicalId: validateProviderLogicalId,
  },
  projection: {
    profile: "tree-v1",
    scope: "projection-output",
    validateLogicalId: validateProjectionLogicalId,
  },
  schema: {
    profile: "json-jcs-v1",
    scope: "schema-document",
    validateLogicalId: (logicalId) => validateQualifiedLogicalId("schema", logicalId),
  },
  profile: {
    profile: "json-jcs-v1",
    scope: "profile-manifest",
    validateLogicalId: (logicalId) => validateQualifiedLogicalId("profile", logicalId),
  },
  bundle: {
    profile: "json-jcs-v1",
    scope: "bundle-manifest",
    validateLogicalId: (logicalId) => validateQualifiedLogicalId("bundle", logicalId),
  },
  "agent-pack": {
    profile: "json-jcs-v1",
    scope: "agent-pack-manifest",
    validateLogicalId: (logicalId) => validateQualifiedLogicalId("agent-pack", logicalId),
  },
};

const TOP_LEVEL_KEYS = new Set(["kind", "logical_id", "revision", "digest"]);
const DIGEST_KEYS = new Set(["algorithm", "profile", "scope", "value"]);
const CONSUMER_TUPLE_KEYS = new Set(["kind", "algorithm", "profile", "scope"]);

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypedContentIdentityError("INVALID_OBJECT", field, `${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypedContentIdentityError(
      "INVALID_OBJECT",
      field,
      `${field} must be a plain object`,
    );
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  field: string,
): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw new TypedContentIdentityError(
      "UNKNOWN_FIELD",
      `${field}.[symbol]`,
      `${field} contains an unsupported symbol field`,
    );
  }

  const stringKeys = ownKeys.filter((key): key is string => typeof key === "string").sort();
  for (const key of stringKeys) {
    if (!allowedKeys.has(key)) {
      throw new TypedContentIdentityError(
        "UNKNOWN_FIELD",
        `${field}.[unknown]`,
        `${field} contains an unknown field`,
      );
    }
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (
      property === undefined ||
      property.enumerable !== true ||
      !Object.hasOwn(property, "value")
    ) {
      throw new TypedContentIdentityError(
        "INVALID_PROPERTY",
        `${field}.${key}`,
        `${field}.${key} must be an enumerable data property`,
      );
    }
  }
}

function requireOwnField(
  value: Record<string, unknown>,
  key: string,
  parent: string,
): unknown {
  if (!Object.hasOwn(value, key)) {
    throw new TypedContentIdentityError(
      "MISSING_FIELD",
      `${parent}.${key}`,
      `${parent}.${key} is required`,
    );
  }
  return value[key];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypedContentIdentityError("INVALID_TYPE", field, `${field} must be a string`);
  }
  return value;
}

function validateKind(value: unknown): ContentIdentityKind {
  const kind = requireString(value, "kind");
  if (!Object.hasOwn(KIND_CONTRACTS, kind)) {
    throw new TypedContentIdentityError(
      "UNKNOWN_KIND",
      "kind",
      "kind is not registered",
    );
  }
  return kind as ContentIdentityKind;
}

/**
 * Validate and copy the F-02.02 typed content descriptor shape.
 *
 * This pure contract check proves syntax and exact kind/profile/scope binding.
 * It does not hash content, resolve mutable references, or confer trust,
 * provenance, admission, installation, or activation.
 */
export function validateTypedContentDescriptor(value: unknown): TypedContentDescriptor {
  const descriptor = requireRecord(value, "descriptor");
  rejectUnknownKeys(descriptor, TOP_LEVEL_KEYS, "descriptor");

  const kind = validateKind(requireOwnField(descriptor, "kind", "descriptor"));
  const contract = KIND_CONTRACTS[kind];
  const logicalId = requireString(
    requireOwnField(descriptor, "logical_id", "descriptor"),
    "logical_id",
  );
  if (!contract.validateLogicalId(logicalId)) {
    throw new TypedContentIdentityError(
      "INVALID_LOGICAL_ID",
      "logical_id",
      `logical_id is invalid for kind '${kind}'`,
    );
  }

  const revision = requireString(
    requireOwnField(descriptor, "revision", "descriptor"),
    "revision",
  );
  if (!REVISION_PATTERN.test(revision)) {
    throw new TypedContentIdentityError(
      "INVALID_REVISION",
      "revision",
      "revision does not match the F-02.02 grammar",
    );
  }

  const digest = requireRecord(requireOwnField(descriptor, "digest", "descriptor"), "digest");
  rejectUnknownKeys(digest, DIGEST_KEYS, "digest");

  const algorithm = requireString(
    requireOwnField(digest, "algorithm", "digest"),
    "digest.algorithm",
  );
  if (algorithm !== CONTENT_IDENTITY_ALGORITHM) {
    throw new TypedContentIdentityError(
      "INVALID_ALGORITHM",
      "digest.algorithm",
      `digest.algorithm must be '${CONTENT_IDENTITY_ALGORITHM}'`,
    );
  }
  const profile = requireString(requireOwnField(digest, "profile", "digest"), "digest.profile");
  if (profile !== contract.profile) {
    throw new TypedContentIdentityError(
      "INVALID_PROFILE",
      "digest.profile",
      `digest.profile must be '${contract.profile}' for kind '${kind}'`,
    );
  }
  const scope = requireString(requireOwnField(digest, "scope", "digest"), "digest.scope");
  if (scope !== contract.scope) {
    throw new TypedContentIdentityError(
      "INVALID_SCOPE",
      "digest.scope",
      `digest.scope must be '${contract.scope}' for kind '${kind}'`,
    );
  }

  const digestValue = requireString(
    requireOwnField(digest, "value", "digest"),
    "digest.value",
  );
  if (!DIGEST_PATTERN.test(digestValue)) {
    throw new TypedContentIdentityError(
      "INVALID_DIGEST",
      "digest.value",
      "digest.value must be 64 lowercase hexadecimal characters",
    );
  }

  const validatedDigest = Object.freeze({
    algorithm: CONTENT_IDENTITY_ALGORITHM,
    profile: contract.profile,
    scope: contract.scope,
    value: digestValue,
  });
  return Object.freeze({
    kind,
    logical_id: logicalId,
    revision,
    digest: validatedDigest,
  }) as TypedContentDescriptor;
}

export function parseTypedContentDescriptor(value: unknown): TypedContentDescriptorParseResult {
  try {
    return Object.freeze({ ok: true, value: validateTypedContentDescriptor(value) });
  } catch (error) {
    if (error instanceof TypedContentIdentityError) {
      return Object.freeze({ ok: false, error });
    }
    throw error;
  }
}

export function assertTypedContentConsumerTuple(
  descriptor: TypedContentDescriptor,
  expected: ContentConsumerTuple,
): void {
  const validatedDescriptor = validateTypedContentDescriptor(descriptor);
  const consumer = requireRecord(expected, "consumer");
  rejectUnknownKeys(consumer, CONSUMER_TUPLE_KEYS, "consumer");
  const expectedKind = validateKind(requireOwnField(consumer, "kind", "consumer"));
  const expectedContract = KIND_CONTRACTS[expectedKind];
  const expectedAlgorithm = requireString(
    requireOwnField(consumer, "algorithm", "consumer"),
    "consumer.algorithm",
  );
  const expectedProfile = requireString(
    requireOwnField(consumer, "profile", "consumer"),
    "consumer.profile",
  );
  const expectedScope = requireString(
    requireOwnField(consumer, "scope", "consumer"),
    "consumer.scope",
  );

  if (expectedAlgorithm !== CONTENT_IDENTITY_ALGORITHM) {
    throw new TypedContentIdentityError(
      "INVALID_ALGORITHM",
      "consumer.algorithm",
      "consumer algorithm is not registered",
    );
  }
  if (expectedProfile !== expectedContract.profile) {
    throw new TypedContentIdentityError(
      "INVALID_PROFILE",
      "consumer.profile",
      "consumer profile does not match its kind",
    );
  }
  if (expectedScope !== expectedContract.scope) {
    throw new TypedContentIdentityError(
      "INVALID_SCOPE",
      "consumer.scope",
      "consumer scope does not match its kind",
    );
  }

  if (validatedDescriptor.kind !== expectedKind) {
    throw new TypedContentIdentityError(
      "INVALID_KIND",
      "kind",
      "descriptor kind does not match the consumer kind",
    );
  }
  if (validatedDescriptor.digest.algorithm !== expectedAlgorithm) {
    throw new TypedContentIdentityError(
      "INVALID_ALGORITHM",
      "digest.algorithm",
      "descriptor algorithm does not match the consumer contract",
    );
  }
  if (validatedDescriptor.digest.profile !== expectedProfile) {
    throw new TypedContentIdentityError(
      "INVALID_PROFILE",
      "digest.profile",
      "descriptor profile does not match the consumer contract",
    );
  }
  if (validatedDescriptor.digest.scope !== expectedScope) {
    throw new TypedContentIdentityError(
      "INVALID_SCOPE",
      "digest.scope",
      "descriptor scope does not match the consumer contract",
    );
  }
}

export function typedContentDescriptorsEqual(
  left: TypedContentDescriptor,
  right: TypedContentDescriptor,
): boolean {
  return (
    left.kind === right.kind &&
    left.logical_id === right.logical_id &&
    left.revision === right.revision &&
    left.digest.algorithm === right.digest.algorithm &&
    left.digest.profile === right.digest.profile &&
    left.digest.scope === right.digest.scope &&
    left.digest.value === right.digest.value
  );
}
