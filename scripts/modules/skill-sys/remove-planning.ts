const PLAN_SCHEMA_VERSION = 1;
const MANAGED_BY = "skill-sys";

const INPUT_KEYS = ["all", "app", "dryRun", "plan", "project", "skill"] as const;
const ENTRY_KEYS = [
  "app",
  "installMode",
  "managedBy",
  "recordedDigest",
  "skill",
  "target",
] as const;
const CANDIDATE_KEYS = [
  "app",
  "candidateId",
  "installMode",
  "recordedDigest",
  "skill",
  "target",
] as const;
const PREPARED_KEYS = ["candidates", "ignored", "mode", "project", "scope"] as const;
const IGNORED_KEYS = ["filtered", "malformed", "unmanaged"] as const;
const OBSERVATION_KEYS = ["actualDigest", "candidateId", "exists", "target"] as const;

export interface RemovePlannerInput {
  project: string;
  skill: string | null;
  app: string | null;
  all: boolean;
  plan: boolean;
  dryRun: boolean;
}

export interface RemovePlanAction {
  app: string;
  skill: string;
  target: string;
  installMode: string | null;
  exists: boolean;
  recordedDigest: string | null;
  actualDigest: string | null;
  digestMatches: boolean | null;
}

export interface RemovePlan {
  schemaVersion: number;
  command: "remove";
  project: string;
  scope: "skill" | "broad";
  mode: "plan" | "dry-run";
  applySupported: boolean;
  actions: RemovePlanAction[];
  ignored: {
    unmanaged: number;
    filtered: number;
    malformed: number;
  };
}

export interface DetachedRemoveStateEntry {
  readonly managedBy: string | null;
  readonly app: string | null;
  readonly skill: string | null;
  readonly target: string | null;
  readonly installMode: string | null;
  readonly recordedDigest: string | null;
}

export interface PreparedRemoveCandidate {
  readonly candidateId: number;
  readonly app: string | null;
  readonly skill: string | null;
  readonly target: string;
  readonly installMode: string | null;
  readonly recordedDigest: string | null;
}

export interface PreparedRemovePlan {
  readonly project: string;
  readonly scope: "skill" | "broad";
  readonly mode: "plan" | "dry-run";
  readonly candidates: readonly PreparedRemoveCandidate[];
  readonly ignored: Readonly<{
    unmanaged: number;
    filtered: number;
    malformed: number;
  }>;
}

export interface RemoveCandidateObservation {
  readonly candidateId: number;
  readonly target: string;
  readonly exists: boolean;
  readonly actualDigest: string | null;
}

function isExactPlainRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return false;
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) {
      return false;
    }
  }
  return true;
}

function isNormalizedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNormalizedNullableString(value: unknown): value is string | null {
  return value === null || isNormalizedString(value);
}

function assertPlannerInput(value: RemovePlannerInput): void {
  if (
    !isExactPlainRecord(value, INPUT_KEYS) ||
    !isNormalizedString(value.project) ||
    !isNormalizedNullableString(value.skill) ||
    !isNormalizedNullableString(value.app) ||
    typeof value.all !== "boolean" ||
    typeof value.plan !== "boolean" ||
    typeof value.dryRun !== "boolean" ||
    (!value.plan && !value.dryRun) ||
    (value.skill === null && !value.all) ||
    (value.skill !== null && value.all)
  ) {
    throw new Error("INVALID_REMOVE_PLANNER_INPUT");
  }
}

function assertDetachedEntry(value: unknown): asserts value is DetachedRemoveStateEntry {
  if (
    !isExactPlainRecord(value, ENTRY_KEYS) ||
    !isNormalizedNullableString(value.managedBy) ||
    !isNormalizedNullableString(value.app) ||
    !isNormalizedNullableString(value.skill) ||
    !isNormalizedNullableString(value.target) ||
    !isNormalizedNullableString(value.installMode) ||
    !isNormalizedNullableString(value.recordedDigest)
  ) {
    throw new Error("INVALID_DETACHED_REMOVE_STATE_ENTRY");
  }
}

function assertPreparedCandidate(
  value: unknown,
): asserts value is PreparedRemoveCandidate {
  if (
    !isExactPlainRecord(value, CANDIDATE_KEYS) ||
    !Number.isInteger(value.candidateId) ||
    (value.candidateId as number) < 0 ||
    !isNormalizedNullableString(value.app) ||
    !isNormalizedNullableString(value.skill) ||
    !isNormalizedString(value.target) ||
    !isNormalizedNullableString(value.installMode) ||
    !isNormalizedNullableString(value.recordedDigest)
  ) {
    throw new Error("INVALID_PREPARED_REMOVE_CANDIDATE");
  }
}

function assertCounterRecord(value: unknown): void {
  if (
    !isExactPlainRecord(value, IGNORED_KEYS) ||
    !Number.isInteger(value.unmanaged) ||
    (value.unmanaged as number) < 0 ||
    !Number.isInteger(value.filtered) ||
    (value.filtered as number) < 0 ||
    !Number.isInteger(value.malformed) ||
    (value.malformed as number) < 0
  ) {
    throw new Error("INVALID_PREPARED_REMOVE_PLAN");
  }
}

function assertPreparedPlan(value: PreparedRemovePlan): void {
  if (
    !isExactPlainRecord(value, PREPARED_KEYS) ||
    !isNormalizedString(value.project) ||
    (value.scope !== "skill" && value.scope !== "broad") ||
    (value.mode !== "plan" && value.mode !== "dry-run") ||
    !Array.isArray(value.candidates)
  ) {
    throw new Error("INVALID_PREPARED_REMOVE_PLAN");
  }
  assertCounterRecord(value.ignored);
  const candidateIds = new Set<number>();
  for (const candidate of value.candidates) {
    assertPreparedCandidate(candidate);
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error("INVALID_PREPARED_REMOVE_PLAN");
    }
    candidateIds.add(candidate.candidateId);
  }
}

function assertObservation(
  value: unknown,
): asserts value is RemoveCandidateObservation {
  if (
    !isExactPlainRecord(value, OBSERVATION_KEYS) ||
    !Number.isInteger(value.candidateId) ||
    (value.candidateId as number) < 0 ||
    !isNormalizedString(value.target) ||
    typeof value.exists !== "boolean" ||
    !isNormalizedNullableString(value.actualDigest) ||
    (value.exists ? value.actualDigest === null : value.actualDigest !== null)
  ) {
    throw new Error("INVALID_REMOVE_CANDIDATE_OBSERVATION");
  }
}

function freezeIgnored(
  unmanaged: number,
  filtered: number,
  malformed: number,
): PreparedRemovePlan["ignored"] {
  return Object.freeze({ unmanaged, filtered, malformed });
}

export function prepareRemovePlan(
  input: RemovePlannerInput,
  entries: readonly unknown[],
): PreparedRemovePlan {
  assertPlannerInput(input);
  if (!Array.isArray(entries)) {
    throw new Error("INVALID_DETACHED_REMOVE_STATE_ENTRIES");
  }

  const candidates: PreparedRemoveCandidate[] = [];
  let unmanaged = 0;
  let filtered = 0;
  let malformed = 0;

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    assertDetachedEntry(entry);

    if (entry.managedBy !== MANAGED_BY) {
      unmanaged += 1;
      continue;
    }
    if (entry.target === null) {
      malformed += 1;
      continue;
    }
    if (input.skill !== null && entry.skill !== input.skill) {
      filtered += 1;
      continue;
    }
    if (input.app !== null && entry.app !== input.app) {
      filtered += 1;
      continue;
    }

    candidates.push(
      Object.freeze({
        candidateId: entryIndex,
        app: entry.app,
        skill: entry.skill,
        target: entry.target,
        installMode: entry.installMode,
        recordedDigest: entry.recordedDigest,
      }),
    );
  }

  return Object.freeze({
    project: input.project,
    scope: input.skill === null ? "broad" : "skill",
    mode: input.plan ? "plan" : "dry-run",
    candidates: Object.freeze(candidates),
    ignored: freezeIgnored(unmanaged, filtered, malformed),
  });
}

export function finalizeRemovePlan(
  prepared: PreparedRemovePlan,
  observations: readonly unknown[],
): RemovePlan {
  assertPreparedPlan(prepared);
  if (!Array.isArray(observations) || observations.length !== prepared.candidates.length) {
    throw new Error("REMOVE_OBSERVATION_CARDINALITY_MISMATCH");
  }

  const actionsWithOrder: Array<RemovePlanAction & { readonly encounterOrder: number }> =
    [];
  for (let index = 0; index < prepared.candidates.length; index += 1) {
    const candidate = prepared.candidates[index]!;
    const observation = observations[index];
    assertObservation(observation);
    if (
      observation.candidateId !== candidate.candidateId ||
      observation.target !== candidate.target
    ) {
      throw new Error("REMOVE_OBSERVATION_IDENTITY_MISMATCH");
    }

    const digestMatches =
      candidate.recordedDigest === null
        ? null
        : !observation.exists
          ? false
          : candidate.recordedDigest === observation.actualDigest;
    actionsWithOrder.push({
      app: candidate.app ?? "",
      skill: candidate.skill ?? "",
      target: candidate.target,
      installMode: candidate.installMode,
      exists: observation.exists,
      recordedDigest: candidate.recordedDigest,
      actualDigest: observation.actualDigest,
      digestMatches,
      encounterOrder: index,
    });
  }

  actionsWithOrder.sort(
    (left, right) =>
      left.app.localeCompare(right.app) ||
      left.skill.localeCompare(right.skill) ||
      left.target.localeCompare(right.target) ||
      left.encounterOrder - right.encounterOrder,
  );
  const actions = actionsWithOrder.map(
    ({ encounterOrder: _encounterOrder, ...action }) => action,
  );

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    command: "remove",
    project: prepared.project,
    scope: prepared.scope,
    mode: prepared.mode,
    applySupported: false,
    actions,
    ignored: {
      unmanaged: prepared.ignored.unmanaged,
      filtered: prepared.ignored.filtered,
      malformed: prepared.ignored.malformed,
    },
  };
}
