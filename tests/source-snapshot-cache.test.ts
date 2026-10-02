import { describe, expect, test } from "bun:test";
import {
  proposeSourceSnapshotCacheEntry,
  type SourceSnapshotCacheEntry,
  type SourceSnapshotCacheRejectionReason,
} from "../scripts/modules/source/propose-source-registration.ts";

const DIGEST = "a".repeat(64);
const NEXT_DIGEST = "b".repeat(64);
const REVISION = "c".repeat(40);
const ORIGIN_KEY = "d".repeat(64);

function validSnapshotFacts(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
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
    source: {
      alias: "demo-source",
      immutable_revision: REVISION,
      origin: { key: ORIGIN_KEY, display: "redacted" },
    },
    snapshot_handle: Symbol(),
    verification: { state: "verified", binding: Symbol() },
    ...overrides,
  };
}

function cacheEntry(facts: Record<string, unknown>): Record<string, unknown> {
  return { state: "proposed", ...facts };
}

function validIndex(
  entries: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return { entries };
}

function frozenDeep(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every((key) => frozenDeep(Reflect.get(value, key)));
}

describe("F-05.02 Source snapshot-cache proposal seam", () => {
  test("proposes a detached immutable descriptor-bound entry without cache lifecycle claims", () => {
    const facts = validSnapshotFacts();
    const result = proposeSourceSnapshotCacheEntry(validIndex(), facts);

    expect(result).toMatchObject({
      outcome: "proposed",
      candidate: {
        state: "proposed",
        descriptor: { digest: { value: DIGEST } },
        source: {
          alias: "demo-source",
          immutable_revision: REVISION,
          origin: { key: ORIGIN_KEY, display: "redacted" },
        },
        verification: { state: "verified" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("snapshot_handle");
    expect(JSON.stringify(result)).not.toContain("binding");
    expect(JSON.stringify(result)).not.toContain("cached");
    expect(frozenDeep(result)).toBe(true);
    expect(() => structuredClone(result)).toThrow();
    if (result.outcome !== "proposed") return;
    expect(result.candidate.descriptor).not.toBe(facts.descriptor);
    expect(result.candidate.source).not.toBe(facts.source);
  });

  test("returns no-op only for the exact descriptor, source, handle, and verification binding", () => {
    const snapshotHandle = Symbol();
    const verificationBinding = Symbol();
    const facts = validSnapshotFacts({
      snapshot_handle: snapshotHandle,
      verification: { state: "verified", binding: verificationBinding },
    });
    const existing = cacheEntry(facts);
    const result = proposeSourceSnapshotCacheEntry(validIndex([existing]), facts);

    expect(result).toMatchObject({ outcome: "no-op" });
    if (result.outcome !== "no-op") return;
    expect(result.candidate).not.toBe(existing as unknown as SourceSnapshotCacheEntry);
    expect(result.candidate.snapshot_handle).toBe(snapshotHandle);
    expect(result.candidate.verification.binding).toBe(verificationBinding);
    expect(frozenDeep(result)).toBe(true);
  });

  test("fails closed on every same-key descriptor binding change", () => {
    const facts = validSnapshotFacts();
    const existing = cacheEntry(facts);
    const cases: readonly [string, Record<string, unknown>, string][] = [
      [
        "changed complete descriptor",
        validSnapshotFacts({
          snapshot_handle: facts.snapshot_handle,
          verification: facts.verification,
          descriptor: {
            ...(facts.descriptor as Record<string, unknown>),
            logical_id: "skill:demo/other",
          },
        }),
        "DESCRIPTOR_KEY_CONFLICT",
      ],
      [
        "changed immutable origin",
        validSnapshotFacts({
          snapshot_handle: facts.snapshot_handle,
          verification: facts.verification,
          source: {
            ...(facts.source as Record<string, unknown>),
            origin: { key: "e".repeat(64), display: "redacted" },
          },
        }),
        "SOURCE_ORIGIN_CONFLICT",
      ],
      [
        "changed snapshot handle",
        validSnapshotFacts({ verification: facts.verification }),
        "SNAPSHOT_HANDLE_CONFLICT",
      ],
      [
        "changed verification binding",
        validSnapshotFacts({ snapshot_handle: facts.snapshot_handle }),
        "VERIFICATION_BINDING_CONFLICT",
      ],
    ];

    for (const [label, candidate, reason] of cases) {
      expect(
        proposeSourceSnapshotCacheEntry(validIndex([existing]), candidate),
        label,
      ).toMatchObject({ outcome: "collision", reason, descriptor: { digest: { value: DIGEST } } });
    }
  });

  test("uses the full digest tuple as its canonical ordered index key", () => {
    const first = validSnapshotFacts();
    const second = validSnapshotFacts({
      descriptor: {
        ...(first.descriptor as Record<string, unknown>),
        digest: {
          ...((first.descriptor as { digest: Record<string, unknown> }).digest),
          value: NEXT_DIGEST,
        },
      },
    });
    const proposed = proposeSourceSnapshotCacheEntry(
      validIndex([cacheEntry(first)]),
      second,
    );
    expect(proposed).toMatchObject({ outcome: "proposed" });
    expect(
      proposeSourceSnapshotCacheEntry(
        validIndex([cacheEntry(second), cacheEntry(first)]),
        first,
      ),
    ).toEqual({ outcome: "rejected", reason: "INVALID_CURRENT_SNAPSHOT_CACHE_INDEX" });
  });

  test("rejects incomplete, unverified, unsafe, and legacy-shaped facts without normalization", () => {
    const cases: readonly [
      string,
      Record<string, unknown>,
      SourceSnapshotCacheRejectionReason,
    ][] = [
      [
        "missing handle",
        (() => {
          const facts = validSnapshotFacts();
          delete facts.snapshot_handle;
          return facts;
        })(),
        "INVALID_VERIFIED_SNAPSHOT_FACTS",
      ],
      [
        "described global handle",
        validSnapshotFacts({ snapshot_handle: Symbol.for("cache-handle") }),
        "INVALID_SNAPSHOT_HANDLE",
      ],
      [
        "pending verification",
        validSnapshotFacts({ verification: { state: "pending", binding: Symbol() } }),
        "UNVERIFIED_SNAPSHOT_FACTS",
      ],
      [
        "mutable revision",
        validSnapshotFacts({
          source: {
            alias: "demo-source",
            immutable_revision: "main",
            origin: { key: ORIGIN_KEY, display: "redacted" },
          },
        }),
        "INVALID_IMMUTABLE_REVISION",
      ],
      [
        "bare commit descriptor substitute",
        validSnapshotFacts({ descriptor: REVISION }),
        "INVALID_TYPED_DESCRIPTOR",
      ],
      [
        "path-like unknown field",
        validSnapshotFacts({ cache_path: "/private/cache" }),
        "INVALID_VERIFIED_SNAPSHOT_FACTS",
      ],
    ];

    for (const [label, facts, reason] of cases) {
      expect(proposeSourceSnapshotCacheEntry(validIndex(), facts), label).toEqual({
        outcome: "rejected",
        reason,
      });
    }
  });

  test("rejects hostile values without invoking accessors or exposing private text", () => {
    const secret = "https://user:password@private-host/cache/path";
    const accessorFacts = validSnapshotFacts();
    Object.defineProperty(accessorFacts, "descriptor", {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    });
    const proxyFacts = new Proxy(validSnapshotFacts(), {
      ownKeys: () => {
        throw new Error(secret);
      },
    });
    const proxyIndex = new Proxy(validIndex(), {
      ownKeys: () => {
        throw new Error(secret);
      },
    });

    for (const facts of [accessorFacts, proxyFacts]) {
      expect(() => proposeSourceSnapshotCacheEntry(validIndex(), facts)).not.toThrow();
      const result = proposeSourceSnapshotCacheEntry(validIndex(), facts);
      expect(result).toEqual({
        outcome: "rejected",
        reason: "INVALID_VERIFIED_SNAPSHOT_FACTS",
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(() =>
      proposeSourceSnapshotCacheEntry(proxyIndex, validSnapshotFacts()),
    ).not.toThrow();
    const rejectedIndex = proposeSourceSnapshotCacheEntry(
      proxyIndex,
      validSnapshotFacts(),
    );
    expect(rejectedIndex).toEqual({
      outcome: "rejected",
      reason: "INVALID_CURRENT_SNAPSHOT_CACHE_INDEX",
    });
    expect(JSON.stringify(rejectedIndex)).not.toContain(secret);
  });
});
