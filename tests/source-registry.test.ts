import { describe, expect, test } from "bun:test";
import {
  proposeSourceRegistration,
  type SourceCandidate,
  type SourceRejectionReason,
} from "../scripts/modules/source/propose-source-registration.ts";

const DIGEST = "a".repeat(64);
const REVISION = "b".repeat(40);
const ORIGIN_KEY = "c".repeat(64);

function validFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alias: "demo-source",
    immutable_revision: REVISION,
    descriptor: {
      kind: "skill",
      logical_id: "skill:demo/example",
      revision: "1",
      digest: {
        algorithm: "sha-256",
        profile: "tree-v1",
        scope: "skill-content",
        value: DIGEST,
      },
    },
    snapshot_digest: DIGEST,
    origin: { key: ORIGIN_KEY, display: "redacted" },
    verification: "verified",
    discovery_reference: "main",
    ...overrides,
  };
}

function candidateFromFacts(facts: Record<string, unknown>): Record<string, unknown> {
  const { discovery_reference: _discoveryReference, ...candidate } = facts;
  return { state: "proposed", ...candidate };
}

function validRegistry(entries: readonly Record<string, unknown>[] = []): Record<string, unknown> {
  return { entries };
}

function frozenDeep(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every((key) => frozenDeep(Reflect.get(value, key)));
}

describe("F-05.01 Source proposal seam", () => {
  test("proposes a detached immutable candidate without mutable discovery metadata", () => {
    const facts = validFacts();
    const result = proposeSourceRegistration(validRegistry(), facts);

    expect(result).toMatchObject({
      outcome: "proposed",
      candidate: {
        state: "proposed",
        alias: "demo-source",
        immutable_revision: REVISION,
        snapshot_digest: DIGEST,
        origin: { key: ORIGIN_KEY, display: "redacted" },
        verification: "verified",
      },
    });
    expect(result).not.toHaveProperty("receipt");
    expect(JSON.stringify(result)).not.toContain("discovery_reference");
    expect(frozenDeep(result)).toBe(true);
    if (result.outcome !== "proposed") return;
    expect(result.candidate.descriptor).not.toBe(facts.descriptor);

    (facts.origin as Record<string, unknown>).display = "mutated";
    expect(result.candidate.origin.display).toBe("redacted");
  });

  test("returns no-op for the same full identity while excluding display spelling from equality", () => {
    const existingFacts = validFacts({ origin: { key: ORIGIN_KEY, display: "redacted" } });
    const registry = validRegistry([candidateFromFacts(existingFacts)]);
    const result = proposeSourceRegistration(
      registry,
      validFacts({ origin: { key: ORIGIN_KEY, display: "redacted" } }),
    );

    expect(result).toMatchObject({ outcome: "no-op" });
    if (result.outcome !== "no-op") return;
    expect(result.candidate.origin.display).toBe("redacted");
    expect(frozenDeep(result)).toBe(true);
  });

  test("reports a deterministic alias collision and preserves only safe existing data", () => {
    const existing = candidateFromFacts(validFacts());
    const result = proposeSourceRegistration(
      validRegistry([existing]),
      validFacts({ immutable_revision: "c".repeat(40) }),
    );

    expect(result).toMatchObject({
      outcome: "collision",
      reason: "ALIAS_IDENTITY_CONFLICT",
      alias: "demo-source",
      existing: { state: "proposed", alias: "demo-source" },
    });
    expect(frozenDeep(result)).toBe(true);
  });

  test("uses full typed-descriptor equality for digest and revision conflicts", () => {
    const differentDescriptor = {
      kind: "skill",
      logical_id: "skill:demo/other",
      revision: "1",
      digest: {
        algorithm: "sha-256",
        profile: "tree-v1",
        scope: "skill-content",
        value: DIGEST,
      },
    };
    const digestConflict = proposeSourceRegistration(
      validRegistry([candidateFromFacts(validFacts())]),
      validFacts({ alias: "another-source", descriptor: differentDescriptor }),
    );
    expect(digestConflict).toMatchObject({
      outcome: "collision",
      reason: "DIGEST_DESCRIPTOR_CONFLICT",
    });

    const revisionReuse = proposeSourceRegistration(
      validRegistry([candidateFromFacts(validFacts())]),
      validFacts({
        alias: "another-source",
        immutable_revision: "d".repeat(40),
        snapshot_digest: "c".repeat(64),
        descriptor: {
          ...validFacts().descriptor as Record<string, unknown>,
          digest: {
            ...(validFacts().descriptor as { digest: Record<string, unknown> }).digest,
            value: "c".repeat(64),
          },
        },
      }),
    );
    expect(revisionReuse).toMatchObject({ outcome: "collision", reason: "REVISION_REUSE" });
  });

  test("accepts exact alias grammar and rejects boundary violations without normalization", () => {
    for (const alias of ["a", `a${"b".repeat(63)}`, "a._~-"]) {
      expect(proposeSourceRegistration(validRegistry(), validFacts({ alias }))).toMatchObject({
        outcome: "proposed",
      });
    }
    for (const alias of ["", ".", "..", "A", " a", "a ", "a/b", "a\\b", "a\n", "á", `a${"b".repeat(64)}`]) {
      expect(proposeSourceRegistration(validRegistry(), validFacts({ alias }))).toEqual({
        outcome: "rejected",
        reason: "INVALID_SOURCE_ALIAS",
      });
    }
  });

  test("rejects malformed, mutable, unverified, and incompatible facts safely", () => {
    const cases: readonly [string, Record<string, unknown>, SourceRejectionReason][] = [
      ["unknown field", validFacts({ extra: true }), "INVALID_VERIFIED_SOURCE_FACTS"],
      ["mutable revision", validFacts({ immutable_revision: "main" }), "INVALID_IMMUTABLE_REVISION"],
      ["unverified", validFacts({ verification: "pending" }), "UNVERIFIED_SOURCE_FACTS"],
      ["snapshot mismatch", validFacts({ snapshot_digest: "c".repeat(64) }), "SNAPSHOT_DESCRIPTOR_MISMATCH"],
      [
        "non-skill descriptor",
        validFacts({
          descriptor: {
            kind: "schema",
            logical_id: "schema:demo/example",
            revision: "1",
            digest: {
              algorithm: "sha-256",
              profile: "json-jcs-v1",
              scope: "schema-document",
              value: DIGEST,
            },
          },
        }),
        "SOURCE_DESCRIPTOR_KIND_MISMATCH",
      ],
      ["unsafe origin display", validFacts({ origin: { key: ORIGIN_KEY, display: "https://host" } }), "INVALID_ORIGIN"],
      ["host-like origin key", validFacts({ origin: { key: "private-host.internal", display: "redacted" } }), "INVALID_ORIGIN"],
    ];
    for (const [label, facts, reason] of cases) {
      expect(proposeSourceRegistration(validRegistry(), facts), label).toEqual({
        outcome: "rejected",
        reason,
      });
    }
  });

  test("rejects corrupt, duplicate, and non-canonical registries before comparison", () => {
    const sourceA = candidateFromFacts(validFacts({ alias: "a" }));
    const sourceB = candidateFromFacts(validFacts({ alias: "b" }));
    for (const registry of [
      validRegistry([sourceB, sourceA]),
      validRegistry([sourceA, candidateFromFacts(validFacts({ alias: "a" }))]),
      validRegistry([
        sourceA,
        candidateFromFacts(
          validFacts({ alias: "b", immutable_revision: REVISION, snapshot_digest: "c".repeat(64), descriptor: {
            ...validFacts().descriptor as Record<string, unknown>,
            digest: {
              ...(validFacts().descriptor as { digest: Record<string, unknown> }).digest,
              value: "c".repeat(64),
            },
          } }),
        ),
      ]),
    ]) {
      expect(proposeSourceRegistration(registry, validFacts())).toEqual({
        outcome: "rejected",
        reason: "INVALID_CURRENT_REGISTRY",
      });
    }
  });

  test("rejects hostile inputs without invoking accessors or leaking their details", () => {
    const secret = [
      "https://",
      ["user", "password"].join(":"),
      "@private-host",
      ["", "home", "secret"].join("/"),
    ].join("");
    const facts = validFacts();
    Object.defineProperty(facts, "alias", {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    });
    const proxy = new Proxy(validFacts(), {
      ownKeys: () => {
        throw new Error(secret);
      },
    });
    for (const hostile of [facts, proxy, [validFacts(), , validFacts()]]) {
      expect(() => proposeSourceRegistration(validRegistry(), hostile)).not.toThrow();
      const result = proposeSourceRegistration(validRegistry(), hostile);
      expect(result).toEqual({ outcome: "rejected", reason: "INVALID_VERIFIED_SOURCE_FACTS" });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  test("never returns locator, credential, path, or host text from source facts", () => {
    const secret = [
      "https://",
      ["user", "password"].join(":"),
      "@private-host",
      ["", "home", "secret"].join("/"),
    ].join("");
    const rejected = proposeSourceRegistration(
      validRegistry(),
      validFacts({ origin: { key: secret, display: secret }, discovery_reference: secret }),
    );
    const existing = candidateFromFacts(validFacts());
    const collision = proposeSourceRegistration(
      validRegistry([existing]),
      validFacts({ immutable_revision: "d".repeat(40), discovery_reference: secret }),
    );
    const noOp = proposeSourceRegistration(
      validRegistry([existing]),
      validFacts({ discovery_reference: secret }),
    );

    for (const result of [rejected, collision, noOp]) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain("private-host");
      expect(JSON.stringify(result)).not.toContain("password");
    }
    expect(collision).toMatchObject({ outcome: "collision" });
    expect(noOp).toMatchObject({ outcome: "no-op" });
  });

  test("keeps public result values detached from a registry candidate", () => {
    const registryCandidate = candidateFromFacts(validFacts()) as unknown as SourceCandidate;
    const result = proposeSourceRegistration(validRegistry([registryCandidate]), validFacts());
    if (result.outcome !== "no-op") throw new Error("expected no-op");
    expect(result.candidate).not.toBe(registryCandidate);
    expect(result.candidate.origin).not.toBe(registryCandidate.origin);
    expect(frozenDeep(result)).toBe(true);
  });
});
