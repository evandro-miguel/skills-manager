import { describe, expect, test } from "bun:test";
import {
  finalizeRemovePlan,
  prepareRemovePlan,
  type DetachedRemoveStateEntry,
  type RemoveCandidateObservation,
  type RemovePlannerInput,
} from "../scripts/modules/skill-sys/remove-planning.ts";

const BROAD_INPUT: RemovePlannerInput = {
  project: "/work/project",
  skill: null,
  app: null,
  all: true,
  plan: true,
  dryRun: false,
};

type MutableDetachedEntry = {
  -readonly [Key in keyof DetachedRemoveStateEntry]: DetachedRemoveStateEntry[Key];
};

type MutableObservation = {
  -readonly [Key in keyof RemoveCandidateObservation]: RemoveCandidateObservation[Key];
};

function entry(
  overrides: Partial<DetachedRemoveStateEntry> = {},
): MutableDetachedEntry {
  return {
    managedBy: "skill-sys",
    app: "codex",
    skill: "alpha",
    target: ".agents/skills/alpha",
    installMode: "projection",
    recordedDigest: "digest-alpha",
    ...overrides,
  };
}

function observe(
  candidateId: number,
  target: string,
  overrides: Partial<RemoveCandidateObservation> = {},
): MutableObservation {
  return {
    candidateId,
    target,
    exists: true,
    actualDigest: "digest-alpha",
    ...overrides,
  };
}

describe("F-03.02 remove planning functional core", () => {
  test("prepares candidates with current filter order and counter semantics", () => {
    const prepared = prepareRemovePlan(
      { ...BROAD_INPUT, skill: "alpha", app: "codex", all: false },
      [
        entry({ managedBy: "other", target: null }),
        entry({ target: null }),
        entry({ skill: "beta", app: "other" }),
        entry({ skill: "alpha", app: "other" }),
        entry(),
      ],
    );

    expect(prepared).toEqual({
      project: "/work/project",
      scope: "skill",
      mode: "plan",
      candidates: [
        {
          candidateId: 4,
          app: "codex",
          skill: "alpha",
          target: ".agents/skills/alpha",
          installMode: "projection",
          recordedDigest: "digest-alpha",
        },
      ],
      ignored: { unmanaged: 1, filtered: 2, malformed: 1 },
    });
  });

  test("finalizes all digest outcomes and missing optional values", () => {
    const prepared = prepareRemovePlan(BROAD_INPUT, [
      entry({ skill: "match", target: "skills/match" }),
      entry({
        app: null,
        skill: null,
        target: "skills/no-digest",
        installMode: null,
        recordedDigest: null,
      }),
      entry({
        skill: "missing",
        target: "skills/missing",
        recordedDigest: "digest-missing",
      }),
      entry({
        skill: "drift",
        target: "skills/drift",
        recordedDigest: "digest-expected",
      }),
    ]);

    const plan = finalizeRemovePlan(prepared, [
      observe(0, "skills/match"),
      observe(1, "skills/no-digest", { actualDigest: "digest-live" }),
      observe(2, "skills/missing", { exists: false, actualDigest: null }),
      observe(3, "skills/drift", { actualDigest: "digest-other" }),
    ]);

    expect(plan.actions.map((action) => [action.skill, action.digestMatches])).toEqual([
      ["", null],
      ["drift", false],
      ["match", true],
      ["missing", false],
    ]);
    expect(plan.actions[0]).toMatchObject({
      app: "",
      skill: "",
      installMode: null,
      recordedDigest: null,
      actualDigest: "digest-live",
    });
    expect(plan).toMatchObject({
      schemaVersion: 1,
      command: "remove",
      project: "/work/project",
      scope: "broad",
      mode: "plan",
      applySupported: false,
    });
  });

  test("uses the current localeCompare ordering for mixed case and diacritics", () => {
    const values = ["zeta", "Alpha", "águia", "beta", "Árvore", "alpha"];
    const prepared = prepareRemovePlan(
      { ...BROAD_INPUT, plan: false, dryRun: true },
      values.map((skill) =>
        entry({
          app: skill,
          skill,
          target: `skills/${skill}`,
          recordedDigest: null,
        }),
      ),
    );
    const plan = finalizeRemovePlan(
      prepared,
      prepared.candidates.map((candidate) =>
        observe(candidate.candidateId, candidate.target, {
          exists: false,
          actualDigest: null,
        }),
      ),
    );

    expect(plan.mode).toBe("dry-run");
    expect(plan.actions.map((action) => action.skill)).toEqual([
      "águia",
      "alpha",
      "Alpha",
      "Árvore",
      "beta",
      "zeta",
    ]);
  });

  test("preserves encounter order for complete comparator ties and duplicate targets", () => {
    const prepared = prepareRemovePlan(BROAD_INPUT, [
      entry({ recordedDigest: "first" }),
      entry({ recordedDigest: "second" }),
      entry({ recordedDigest: "third" }),
    ]);
    const plan = finalizeRemovePlan(prepared, [
      observe(0, ".agents/skills/alpha", { actualDigest: "first" }),
      observe(1, ".agents/skills/alpha", { actualDigest: "second" }),
      observe(2, ".agents/skills/alpha", { actualDigest: "third" }),
    ]);

    expect(plan.actions.map((action) => action.recordedDigest)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("does not mutate inputs and returns detached, legacy-mutable plan outputs", () => {
    const input = { ...BROAD_INPUT };
    const sourceEntry = entry();
    const entries = [sourceEntry];
    const inputSnapshot = structuredClone(input);
    const entriesSnapshot = structuredClone(entries);
    const prepared = prepareRemovePlan(input, entries);

    sourceEntry.skill = "changed";
    entries.push(entry({ skill: "later" }));
    expect(input).toEqual(inputSnapshot);
    expect(entriesSnapshot[0]!.skill).toBe("alpha");
    expect(prepared.candidates).toHaveLength(1);
    expect(prepared.candidates[0]!.skill).toBe("alpha");
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.candidates)).toBe(true);
    expect(Object.isFrozen(prepared.candidates[0])).toBe(true);
    expect(Object.isFrozen(prepared.ignored)).toBe(true);

    const observation = observe(0, ".agents/skills/alpha");
    const plan = finalizeRemovePlan(prepared, [observation]);
    observation.actualDigest = "changed";
    expect(plan.actions[0]!.actualDigest).toBe("digest-alpha");
    expect(Object.isFrozen(plan)).toBe(false);
    expect(Object.isFrozen(plan.actions)).toBe(false);
    expect(Object.isFrozen(plan.actions[0])).toBe(false);
    expect(Object.isFrozen(plan.ignored)).toBe(false);

    plan.project = "/changed";
    plan.actions[0]!.skill = "changed";
    plan.actions.push({ ...plan.actions[0]!, target: "skills/extra" });
    plan.ignored.filtered = 99;
    expect(plan.project).toBe("/changed");
    expect(plan.actions.map((action) => action.target)).toEqual([
      ".agents/skills/alpha",
      "skills/extra",
    ]);
    expect(plan.ignored.filtered).toBe(99);
    expect(prepared.project).toBe("/work/project");
    expect(prepared.candidates[0]!.skill).toBe("alpha");
    expect(prepared.ignored.filtered).toBe(0);
  });

  test("fails closed for non-plain, accessor, exotic, and non-normalized entries", () => {
    class EntryClass {
      managedBy = "skill-sys";
      app = "codex";
      skill = "alpha";
      target = "skills/alpha";
      installMode = "copy";
      recordedDigest = null;
    }
    const accessor: Record<string, unknown> = { ...entry() };
    Object.defineProperty(accessor, "target", {
      enumerable: true,
      get: () => "skills/alpha",
    });
    const hostileProxy = new Proxy(entry(), {
      ownKeys: () => {
        throw new Error("proxy trap");
      },
    });

    for (const value of [
      null,
      "entry",
      [],
      new EntryClass(),
      accessor,
      { ...entry(), extra: true },
      { ...entry(), target: "   " },
    ]) {
      expect(() => prepareRemovePlan(BROAD_INPUT, [value])).toThrow(
        "INVALID_DETACHED_REMOVE_STATE_ENTRY",
      );
    }
    expect(() => prepareRemovePlan(BROAD_INPUT, [hostileProxy])).toThrow("proxy trap");
  });

  test("fails closed for observation cardinality, identity, order, and shape mismatch", () => {
    const prepared = prepareRemovePlan(BROAD_INPUT, [
      entry({ skill: "alpha", target: "skills/alpha" }),
      entry({ skill: "beta", target: "skills/beta" }),
    ]);
    expect(() => finalizeRemovePlan(prepared, [])).toThrow(
      "REMOVE_OBSERVATION_CARDINALITY_MISMATCH",
    );
    expect(() =>
      finalizeRemovePlan(prepared, [
        observe(1, "skills/beta"),
        observe(0, "skills/alpha"),
      ]),
    ).toThrow("REMOVE_OBSERVATION_IDENTITY_MISMATCH");
    expect(() =>
      finalizeRemovePlan(prepared, [
        observe(0, "skills/wrong"),
        observe(1, "skills/beta"),
      ]),
    ).toThrow("REMOVE_OBSERVATION_IDENTITY_MISMATCH");
    expect(() =>
      finalizeRemovePlan(prepared, [
        { ...observe(0, "skills/alpha"), extra: true },
        observe(1, "skills/beta"),
      ]),
    ).toThrow("INVALID_REMOVE_CANDIDATE_OBSERVATION");
    expect(() =>
      finalizeRemovePlan(prepared, [
        observe(0, "skills/alpha", { exists: false, actualDigest: "impossible" }),
        observe(1, "skills/beta"),
      ]),
    ).toThrow("INVALID_REMOVE_CANDIDATE_OBSERVATION");
  });
});
