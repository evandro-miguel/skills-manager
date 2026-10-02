import {
  assertTypedContentConsumerTuple,
  typedContentDescriptorsEqual,
  validateTypedContentDescriptor,
  type TypedContentDescriptor,
} from "../skill-sys/typed-content-identity.ts";

export type SourceCandidate = Readonly<{
  state: "proposed";
  alias: string;
  immutable_revision: string;
  descriptor: TypedContentDescriptor;
  snapshot_digest: string;
  origin: Readonly<{
    key: string;
    display: string;
  }>;
  verification: "verified";
}>;

export type SourceCollisionReason =
  | "ALIAS_IDENTITY_CONFLICT"
  | "REVISION_REUSE"
  | "REVISION_CONTENT_CONFLICT"
  | "DIGEST_DESCRIPTOR_CONFLICT";

export type SourceRejectionReason =
  | "INVALID_CURRENT_REGISTRY"
  | "INVALID_VERIFIED_SOURCE_FACTS"
  | "INVALID_SOURCE_ALIAS"
  | "INVALID_IMMUTABLE_REVISION"
  | "INVALID_ORIGIN"
  | "UNVERIFIED_SOURCE_FACTS"
  | "INVALID_TYPED_DESCRIPTOR"
  | "SOURCE_DESCRIPTOR_KIND_MISMATCH"
  | "INVALID_SNAPSHOT_DIGEST"
  | "SNAPSHOT_DESCRIPTOR_MISMATCH";

export type SourceSnapshotCacheCollisionReason =
  | "DESCRIPTOR_KEY_CONFLICT"
  | "SOURCE_ORIGIN_CONFLICT"
  | "SNAPSHOT_HANDLE_CONFLICT"
  | "VERIFICATION_BINDING_CONFLICT";

export type SourceSnapshotCacheRejectionReason =
  | "INVALID_CURRENT_SNAPSHOT_CACHE_INDEX"
  | "INVALID_VERIFIED_SNAPSHOT_FACTS"
  | "INVALID_SNAPSHOT_HANDLE"
  | "UNVERIFIED_SNAPSHOT_FACTS"
  | SourceRejectionReason;

export type SourceSnapshotCacheEntry = Readonly<{
  state: "proposed";
  descriptor: TypedContentDescriptor;
  source: Readonly<{
    alias: string;
    immutable_revision: string;
    origin: Readonly<{ key: string; display: string }>;
  }>;
  snapshot_handle: symbol;
  verification: Readonly<{ state: "verified"; binding: symbol }>;
}>;

export type SourceSnapshotCacheResult =
  | Readonly<{ outcome: "proposed"; candidate: SourceSnapshotCacheEntry }>
  | Readonly<{ outcome: "no-op"; candidate: SourceSnapshotCacheEntry }>
  | Readonly<{
      outcome: "collision";
      reason: SourceSnapshotCacheCollisionReason;
      descriptor: TypedContentDescriptor;
    }>
  | Readonly<{ outcome: "rejected"; reason: SourceSnapshotCacheRejectionReason }>;

export type SourceRegistrationResult =
  | Readonly<{ outcome: "proposed"; candidate: SourceCandidate }>
  | Readonly<{ outcome: "no-op"; candidate: SourceCandidate }>
  | Readonly<{
      outcome: "collision";
      reason: SourceCollisionReason;
      alias: string;
      existing: SourceCandidate;
    }>
  | Readonly<{ outcome: "rejected"; reason: SourceRejectionReason }>;

type PlainData =
  | null
  | boolean
  | number
  | string
  | PlainDataArray
  | PlainDataRecord;

interface PlainDataArray extends ReadonlyArray<PlainData> {}

interface PlainDataRecord {
  readonly [key: string]: PlainData;
}

type SourceFacts = Readonly<{
  alias: string;
  immutable_revision: string;
  descriptor: TypedContentDescriptor;
  snapshot_digest: string;
  origin: Readonly<{ key: string; display: string }>;
  verification: "verified";
}>;

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._~-]{0,63}$/;
const IMMUTABLE_REVISION_PATTERN = /^[a-f0-9]{40,64}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ORIGIN_KEY_PATTERN = /^[a-f0-9]{64}$/;
const REDACTED_ORIGIN_DISPLAY = "redacted";

const FACT_FIELDS = [
  "alias",
  "immutable_revision",
  "descriptor",
  "snapshot_digest",
  "origin",
  "verification",
] as const;
const FACT_OPTIONAL_FIELDS = ["discovery_reference"] as const;
const CANDIDATE_FIELDS = ["state", ...FACT_FIELDS] as const;
const REGISTRY_FIELDS = ["entries"] as const;
const ORIGIN_FIELDS = ["key", "display"] as const;
const SNAPSHOT_CACHE_FACT_FIELDS = [
  "descriptor",
  "source",
  "snapshot_handle",
  "verification",
] as const;
const SNAPSHOT_CACHE_ENTRY_FIELDS = [
  "state",
  ...SNAPSHOT_CACHE_FACT_FIELDS,
] as const;
const SNAPSHOT_CACHE_INDEX_FIELDS = ["entries"] as const;
const SNAPSHOT_CACHE_SOURCE_FIELDS = [
  "alias",
  "immutable_revision",
  "origin",
] as const;
const SNAPSHOT_VERIFICATION_FIELDS = ["state", "binding"] as const;

type SourceValidationReason =
  | SourceRejectionReason
  | SourceSnapshotCacheRejectionReason;

class SourceValidationError extends Error {
  constructor(readonly reason: SourceValidationReason) {
    super(reason);
    this.name = "SourceValidationError";
  }
}

function reject(reason: SourceValidationReason): never {
  throw new SourceValidationError(reason);
}

function rejected(reason: SourceRejectionReason): SourceRegistrationResult {
  return Object.freeze({ outcome: "rejected", reason });
}

function isSourceRejectionReason(
  reason: SourceValidationReason,
): reason is SourceRejectionReason {
  return ![
    "INVALID_CURRENT_SNAPSHOT_CACHE_INDEX",
    "INVALID_VERIFIED_SNAPSHOT_FACTS",
    "INVALID_SNAPSHOT_HANDLE",
    "UNVERIFIED_SNAPSHOT_FACTS",
  ].includes(reason);
}

function isCanonicalArrayIndex(key: string): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < 4_294_967_295;
}

/**
 * Materialize a detached JSON-like tree without invoking caller-owned
 * accessors. Reflection failures, proxies with trapping handlers, cycles,
 * symbols, hidden properties, and sparse arrays are rejected by the caller.
 */
function snapshotPlainData(value: unknown, seen = new WeakSet<object>()): PlainData {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value !== "object") {
    reject("INVALID_VERIFIED_SOURCE_FACTS");
  }
  if (seen.has(value)) {
    reject("INVALID_VERIFIED_SOURCE_FACTS");
  }
  seen.add(value);

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype) {
    reject("INVALID_VERIFIED_SOURCE_FACTS");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    reject("INVALID_VERIFIED_SOURCE_FACTS");
  }

  if (isArray) {
    const lengthDescriptor = descriptors.length;
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
      reject("INVALID_VERIFIED_SOURCE_FACTS");
    }
    const length = lengthDescriptor.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      ownKeys.length !== length + 1
    ) {
      reject("INVALID_VERIFIED_SOURCE_FACTS");
    }
    const copied: PlainData[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptors, String(index))
      ) {
        reject("INVALID_VERIFIED_SOURCE_FACTS");
      }
      copied.push(snapshotPlainData(descriptor.value, seen));
    }
    for (const key of ownKeys) {
      if (key !== "length" && (typeof key !== "string" || !isCanonicalArrayIndex(key))) {
        reject("INVALID_VERIFIED_SOURCE_FACTS");
      }
    }
    return Object.freeze(copied);
  }

  const copied: Record<string, PlainData> = {};
  for (const key of ownKeys.sort()) {
    if (typeof key !== "string") {
      reject("INVALID_VERIFIED_SOURCE_FACTS");
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      reject("INVALID_VERIFIED_SOURCE_FACTS");
    }
    Object.defineProperty(copied, key, {
      configurable: false,
      enumerable: true,
      value: snapshotPlainData(descriptor.value, seen),
      writable: false,
    });
  }
  return Object.freeze(copied);
}

function snapshotInput(value: unknown, reason: SourceValidationReason): PlainData {
  try {
    return snapshotPlainData(value);
  } catch {
    reject(reason);
  }
}

function requireRecord(value: PlainData, reason: SourceValidationReason): PlainDataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(reason);
  }
  return value as PlainDataRecord;
}

function requireExactFields(
  value: Readonly<Record<string, PlainData>>,
  required: readonly string[],
  optional: readonly string[],
  reason: SourceValidationReason,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) reject(reason);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) reject(reason);
  }
}

function requireString(
  value: PlainData | undefined,
  reason: SourceValidationReason,
): string {
  if (typeof value !== "string") reject(reason);
  return value;
}

function requireAlias(value: PlainData | undefined): string {
  const alias = requireString(value, "INVALID_SOURCE_ALIAS");
  if (!ALIAS_PATTERN.test(alias) || alias === "." || alias === "..") {
    reject("INVALID_SOURCE_ALIAS");
  }
  return alias;
}

function requireOrigin(value: PlainData | undefined): SourceFacts["origin"] {
  if (value === undefined) reject("INVALID_ORIGIN");
  const origin = requireRecord(value, "INVALID_ORIGIN");
  requireExactFields(origin, ORIGIN_FIELDS, [], "INVALID_ORIGIN");
  const key = requireString(origin.key, "INVALID_ORIGIN");
  const display = requireString(origin.display, "INVALID_ORIGIN");
  if (
    !ORIGIN_KEY_PATTERN.test(key) ||
    key === "." ||
    key === ".." ||
    display !== REDACTED_ORIGIN_DISPLAY
  ) {
    reject("INVALID_ORIGIN");
  }
  return Object.freeze({ key, display });
}

function requireDescriptor(value: PlainData | undefined): TypedContentDescriptor {
  if (value === undefined) reject("INVALID_TYPED_DESCRIPTOR");
  try {
    const descriptor = validateTypedContentDescriptor(value);
    if (descriptor.kind !== "skill") {
      reject("SOURCE_DESCRIPTOR_KIND_MISMATCH");
    }
    assertTypedContentConsumerTuple(descriptor, {
      kind: "skill",
      algorithm: "sha-256",
      profile: "tree-v1",
      scope: "skill-content",
    });
    return descriptor;
  } catch (error) {
    if (error instanceof SourceValidationError) throw error;
    reject("INVALID_TYPED_DESCRIPTOR");
  }
}

function buildFacts(
  value: PlainData,
  reason: SourceRejectionReason,
  registryEntry: boolean,
): SourceFacts {
  const facts = requireRecord(value, reason);
  requireExactFields(
    facts,
    registryEntry ? CANDIDATE_FIELDS : FACT_FIELDS,
    registryEntry ? [] : FACT_OPTIONAL_FIELDS,
    reason,
  );
  if (registryEntry && facts.state !== "proposed") reject(reason);

  const alias = requireAlias(facts.alias);
  const immutableRevision = requireString(facts.immutable_revision, "INVALID_IMMUTABLE_REVISION");
  if (!IMMUTABLE_REVISION_PATTERN.test(immutableRevision)) {
    reject("INVALID_IMMUTABLE_REVISION");
  }
  if (
    !registryEntry &&
    Object.hasOwn(facts, "discovery_reference") &&
    typeof facts.discovery_reference !== "string"
  ) {
    reject("INVALID_VERIFIED_SOURCE_FACTS");
  }
  if (facts.verification !== "verified") reject("UNVERIFIED_SOURCE_FACTS");

  const descriptor = requireDescriptor(facts.descriptor);
  const snapshotDigest = requireString(facts.snapshot_digest, "INVALID_SNAPSHOT_DIGEST");
  if (!DIGEST_PATTERN.test(snapshotDigest)) reject("INVALID_SNAPSHOT_DIGEST");
  if (snapshotDigest !== descriptor.digest.value) {
    reject("SNAPSHOT_DESCRIPTOR_MISMATCH");
  }

  return Object.freeze({
    alias,
    immutable_revision: immutableRevision,
    descriptor,
    snapshot_digest: snapshotDigest,
    origin: requireOrigin(facts.origin),
    verification: "verified",
  });
}

function toCandidate(facts: SourceFacts): SourceCandidate {
  return Object.freeze({
    state: "proposed",
    alias: facts.alias,
    immutable_revision: facts.immutable_revision,
    descriptor: facts.descriptor,
    snapshot_digest: facts.snapshot_digest,
    origin: facts.origin,
    verification: "verified",
  });
}

function parseRegistry(value: PlainData): readonly SourceCandidate[] {
  try {
    const registry = requireRecord(value, "INVALID_CURRENT_REGISTRY");
    requireExactFields(registry, REGISTRY_FIELDS, [], "INVALID_CURRENT_REGISTRY");
    if (!Array.isArray(registry.entries)) reject("INVALID_CURRENT_REGISTRY");

    const entries = registry.entries.map((entry) =>
      toCandidate(buildFacts(entry, "INVALID_CURRENT_REGISTRY", true)),
    );
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (previous === undefined || current === undefined || previous.alias >= current.alias) {
        reject("INVALID_CURRENT_REGISTRY");
      }
    }
    validateRegistryConsistency(entries);
    return Object.freeze(entries);
  } catch {
    // The caller supplied a complete in-memory registry. Its internal
    // validation details are deliberately not exposed on this pure seam.
    return reject("INVALID_CURRENT_REGISTRY");
  }
}

function sameCandidateIdentity(left: SourceCandidate, right: SourceCandidate): boolean {
  return (
    left.immutable_revision === right.immutable_revision &&
    left.snapshot_digest === right.snapshot_digest &&
    left.origin.key === right.origin.key &&
    left.verification === right.verification &&
    typedContentDescriptorsEqual(left.descriptor, right.descriptor)
  );
}

function sameDescriptorRevision(left: SourceCandidate, right: SourceCandidate): boolean {
  return (
    left.descriptor.logical_id === right.descriptor.logical_id &&
    left.descriptor.revision === right.descriptor.revision
  );
}

function validateRegistryConsistency(entries: readonly SourceCandidate[]): void {
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const left = entries[leftIndex];
    if (left === undefined) reject("INVALID_CURRENT_REGISTRY");
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const right = entries[rightIndex];
      if (right === undefined) reject("INVALID_CURRENT_REGISTRY");
      if (
        left.immutable_revision === right.immutable_revision &&
        (left.snapshot_digest !== right.snapshot_digest ||
          !typedContentDescriptorsEqual(left.descriptor, right.descriptor))
      ) {
        reject("INVALID_CURRENT_REGISTRY");
      }
      if (
        left.snapshot_digest === right.snapshot_digest &&
        !typedContentDescriptorsEqual(left.descriptor, right.descriptor)
      ) {
        reject("INVALID_CURRENT_REGISTRY");
      }
    }
  }
}

function collision(
  reason: SourceCollisionReason,
  candidate: SourceCandidate,
  existing: SourceCandidate,
): SourceRegistrationResult {
  return Object.freeze({
    outcome: "collision",
    reason,
    alias: candidate.alias,
    existing,
  });
}

function rejectedSnapshotCache(
  reason: SourceSnapshotCacheRejectionReason,
): SourceSnapshotCacheResult {
  return Object.freeze({ outcome: "rejected", reason });
}

/**
 * Reads only own enumerable data properties from one schema boundary without
 * invoking caller-owned accessors. The snapshot-cache seam deliberately keeps
 * its two capability fields outside the JSON-like Source registry snapshot.
 */
function snapshotExactRecordProperties(
  value: unknown,
  required: readonly string[],
  reason: SourceValidationReason,
): Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      reject(reason);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) reject(reason);

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) reject(reason);
    if (keys.length !== required.length) reject(reason);

    const copied: Record<string, unknown> = {};
    for (const key of required) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        reject(reason);
      }
      Object.defineProperty(copied, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false,
      });
    }
    return Object.freeze(copied);
  } catch {
    return reject(reason);
  }
}

function snapshotArrayValues(
  value: unknown,
  reason: SourceValidationReason,
): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      reject(reason);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
      reject(reason);
    }
    const length = lengthDescriptor.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      keys.length !== length + 1
    ) {
      reject(reason);
    }

    const copied: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        reject(reason);
      }
      copied.push(descriptor.value);
    }
    for (const key of keys) {
      if (
        key !== "length" &&
        (typeof key !== "string" || !isCanonicalArrayIndex(key))
      ) {
        reject(reason);
      }
    }
    return Object.freeze(copied);
  } catch {
    return reject(reason);
  }
}

function requireOpaqueCapability(
  value: unknown,
  reason: SourceValidationReason,
): symbol {
  if (
    typeof value !== "symbol" ||
    value.description !== undefined ||
    Symbol.keyFor(value) !== undefined
  ) {
    reject(reason);
  }
  return value;
}

function parseSnapshotCacheSource(
  value: unknown,
  reason: SourceValidationReason,
): SourceSnapshotCacheEntry["source"] {
  const source = requireRecord(snapshotInput(value, reason), reason);
  requireExactFields(source, SNAPSHOT_CACHE_SOURCE_FIELDS, [], reason);
  const immutableRevision = requireString(
    source.immutable_revision,
    "INVALID_IMMUTABLE_REVISION",
  );
  if (!IMMUTABLE_REVISION_PATTERN.test(immutableRevision)) {
    reject("INVALID_IMMUTABLE_REVISION");
  }
  return Object.freeze({
    alias: requireAlias(source.alias),
    immutable_revision: immutableRevision,
    origin: requireOrigin(source.origin),
  });
}

function parseSnapshotVerification(
  value: unknown,
  reason: SourceValidationReason,
): SourceSnapshotCacheEntry["verification"] {
  const verification = snapshotExactRecordProperties(
    value,
    SNAPSHOT_VERIFICATION_FIELDS,
    reason,
  );
  if (snapshotInput(verification.state, reason) !== "verified") {
    reject("UNVERIFIED_SNAPSHOT_FACTS");
  }
  return Object.freeze({
    state: "verified",
    binding: requireOpaqueCapability(
      verification.binding,
      "INVALID_SNAPSHOT_HANDLE",
    ),
  });
}

function parseSnapshotCacheEntry(
  value: unknown,
  reason: SourceValidationReason,
  indexEntry: boolean,
): SourceSnapshotCacheEntry {
  const fields = indexEntry
    ? SNAPSHOT_CACHE_ENTRY_FIELDS
    : SNAPSHOT_CACHE_FACT_FIELDS;
  const entry = snapshotExactRecordProperties(value, fields, reason);
  if (indexEntry && entry.state !== "proposed") reject(reason);

  const descriptor = requireDescriptor(snapshotInput(entry.descriptor, reason));
  const source = parseSnapshotCacheSource(entry.source, reason);
  const snapshotHandle = requireOpaqueCapability(
    entry.snapshot_handle,
    "INVALID_SNAPSHOT_HANDLE",
  );
  const verification = parseSnapshotVerification(entry.verification, reason);

  return Object.freeze({
    state: "proposed",
    descriptor,
    source,
    snapshot_handle: snapshotHandle,
    verification,
  });
}

function snapshotCacheKey(entry: SourceSnapshotCacheEntry): string {
  const digest = entry.descriptor.digest;
  return `${digest.algorithm}\u0000${digest.profile}\u0000${digest.scope}\u0000${digest.value}`;
}

function parseSnapshotCacheIndex(
  value: unknown,
): readonly SourceSnapshotCacheEntry[] {
  try {
    const index = snapshotExactRecordProperties(
      value,
      SNAPSHOT_CACHE_INDEX_FIELDS,
      "INVALID_CURRENT_SNAPSHOT_CACHE_INDEX",
    );
    const entries = snapshotArrayValues(
      index.entries,
      "INVALID_CURRENT_SNAPSHOT_CACHE_INDEX",
    ).map((entry) =>
      parseSnapshotCacheEntry(
        entry,
        "INVALID_CURRENT_SNAPSHOT_CACHE_INDEX",
        true,
      ),
    );
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (
        previous === undefined ||
        current === undefined ||
        snapshotCacheKey(previous) >= snapshotCacheKey(current)
      ) {
        reject("INVALID_CURRENT_SNAPSHOT_CACHE_INDEX");
      }
    }
    return Object.freeze(entries);
  } catch {
    return reject("INVALID_CURRENT_SNAPSHOT_CACHE_INDEX");
  }
}

function sameSnapshotSource(
  left: SourceSnapshotCacheEntry,
  right: SourceSnapshotCacheEntry,
): boolean {
  return (
    left.source.alias === right.source.alias &&
    left.source.immutable_revision === right.source.immutable_revision &&
    left.source.origin.key === right.source.origin.key
  );
}

function snapshotCacheCollision(
  reason: SourceSnapshotCacheCollisionReason,
  candidate: SourceSnapshotCacheEntry,
): SourceSnapshotCacheResult {
  return Object.freeze({
    outcome: "collision",
    reason,
    descriptor: candidate.descriptor,
  });
}

/**
 * Propose an in-memory immutable Source snapshot-cache binding from facts that
 * an adapter has already inspected and verified. This pure seam neither
 * dereferences nor serializes the local opaque capabilities it receives.
 */
export function proposeSourceSnapshotCacheEntry(
  currentIndex: unknown,
  verifiedSnapshotFacts: unknown,
): SourceSnapshotCacheResult {
  try {
    const index = parseSnapshotCacheIndex(currentIndex);
    const candidate = parseSnapshotCacheEntry(
      verifiedSnapshotFacts,
      "INVALID_VERIFIED_SNAPSHOT_FACTS",
      false,
    );
    const sameKey = index.find(
      (existing) => snapshotCacheKey(existing) === snapshotCacheKey(candidate),
    );
    if (sameKey === undefined) {
      return Object.freeze({ outcome: "proposed", candidate });
    }
    if (!typedContentDescriptorsEqual(sameKey.descriptor, candidate.descriptor)) {
      return snapshotCacheCollision("DESCRIPTOR_KEY_CONFLICT", candidate);
    }
    if (!sameSnapshotSource(sameKey, candidate)) {
      return snapshotCacheCollision("SOURCE_ORIGIN_CONFLICT", candidate);
    }
    if (sameKey.snapshot_handle !== candidate.snapshot_handle) {
      return snapshotCacheCollision("SNAPSHOT_HANDLE_CONFLICT", candidate);
    }
    if (sameKey.verification.binding !== candidate.verification.binding) {
      return snapshotCacheCollision("VERIFICATION_BINDING_CONFLICT", candidate);
    }
    return Object.freeze({ outcome: "no-op", candidate: sameKey });
  } catch (error) {
    if (error instanceof SourceValidationError) {
      return rejectedSnapshotCache(error.reason);
    }
    return rejectedSnapshotCache("INVALID_VERIFIED_SNAPSHOT_FACTS");
  }
}

/**
 * Propose a Source registry entry from already verified resolver facts.
 *
 * This Source-domain seam is pure: it does not acquire, trust, persist,
 * install, activate, or register a source. Mutable discovery metadata is
 * accepted only to validate its boundary shape and never enters identity or
 * any result.
 */
export function proposeSourceRegistration(
  currentRegistry: unknown,
  verifiedSourceFacts: unknown,
): SourceRegistrationResult {
  try {
    const registry = parseRegistry(snapshotInput(currentRegistry, "INVALID_CURRENT_REGISTRY"));
    const facts = buildFacts(
      snapshotInput(verifiedSourceFacts, "INVALID_VERIFIED_SOURCE_FACTS"),
      "INVALID_VERIFIED_SOURCE_FACTS",
      false,
    );
    const candidate = toCandidate(facts);

    for (const existing of registry) {
      if (existing.alias === candidate.alias) {
        if (sameCandidateIdentity(existing, candidate)) {
          return Object.freeze({ outcome: "no-op", candidate: existing });
        }
        return collision("ALIAS_IDENTITY_CONFLICT", candidate, existing);
      }
      if (
        existing.immutable_revision === candidate.immutable_revision &&
        existing.snapshot_digest !== candidate.snapshot_digest
      ) {
        return collision("REVISION_CONTENT_CONFLICT", candidate, existing);
      }
      if (
        sameDescriptorRevision(existing, candidate) &&
        existing.snapshot_digest !== candidate.snapshot_digest
      ) {
        return collision("REVISION_REUSE", candidate, existing);
      }
      if (
        existing.snapshot_digest === candidate.snapshot_digest &&
        !typedContentDescriptorsEqual(existing.descriptor, candidate.descriptor)
      ) {
        return collision("DIGEST_DESCRIPTOR_CONFLICT", candidate, existing);
      }
    }

    return Object.freeze({ outcome: "proposed", candidate });
  } catch (error) {
    if (error instanceof SourceValidationError) {
      return rejected(
        isSourceRejectionReason(error.reason)
          ? error.reason
          : "INVALID_VERIFIED_SOURCE_FACTS",
      );
    }
    return rejected("INVALID_VERIFIED_SOURCE_FACTS");
  }
}
