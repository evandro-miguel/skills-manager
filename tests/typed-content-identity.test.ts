import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  assertTypedContentConsumerTuple,
  CONTENT_IDENTITY_KINDS,
  parseTypedContentDescriptor,
  typedContentDescriptorsEqual,
  TypedContentIdentityError,
  type ContentDigestDescriptor,
  type TypedContentDescriptor,
  validateTypedContentDescriptor,
} from "../scripts/modules/skill-sys/typed-content-identity.ts";

const DIGEST = "a".repeat(64);

type ExpectFalse<Value extends false> = Value;
type InvalidDigestCrossProduct = {
  algorithm: "sha-256";
  profile: "tree-v1";
  scope: "schema-document";
  value: string;
};
type _RejectsInvalidDigestCrossProduct = ExpectFalse<
  InvalidDigestCrossProduct extends ContentDigestDescriptor ? true : false
>;

const VALID_DESCRIPTORS: TypedContentDescriptor[] = [
  {
    kind: "skill",
    logical_id: "skill:demo/example",
    revision: "1",
    digest: { algorithm: "sha-256", profile: "tree-v1", scope: "skill-content", value: DIGEST },
  },
  {
    kind: "skillpack",
    logical_id: "skillpack:demo/example",
    revision: "v1.0.0+build",
    digest: {
      algorithm: "sha-256",
      profile: "json-jcs-v1",
      scope: "skillpack-manifest",
      value: DIGEST,
    },
  },
  {
    kind: "provider",
    logical_id: "provider:claude-code",
    revision: "2026.07",
    digest: {
      algorithm: "sha-256",
      profile: "json-jcs-v1",
      scope: "provider-manifest",
      value: DIGEST,
    },
  },
  {
    kind: "projection",
    logical_id: "projection:codex/demo/example",
    revision: "r_1",
    digest: {
      algorithm: "sha-256",
      profile: "tree-v1",
      scope: "projection-output",
      value: DIGEST,
    },
  },
  {
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
  {
    kind: "profile",
    logical_id: "profile:demo/example",
    revision: "1",
    digest: {
      algorithm: "sha-256",
      profile: "json-jcs-v1",
      scope: "profile-manifest",
      value: DIGEST,
    },
  },
  {
    kind: "bundle",
    logical_id: "bundle:demo/example",
    revision: "1",
    digest: {
      algorithm: "sha-256",
      profile: "json-jcs-v1",
      scope: "bundle-manifest",
      value: DIGEST,
    },
  },
  {
    kind: "agent-pack",
    logical_id: "agent-pack:demo/example",
    revision: "1",
    digest: {
      algorithm: "sha-256",
      profile: "json-jcs-v1",
      scope: "agent-pack-manifest",
      value: DIGEST,
    },
  },
];

describe("F-02.02 typed content identity", () => {
  test("accepts every registered kind with its exact logical-id and digest tuple", () => {
    expect(CONTENT_IDENTITY_KINDS).toHaveLength(8);
    for (const descriptor of VALID_DESCRIPTORS) {
      expect(validateTypedContentDescriptor(descriptor)).toEqual(descriptor);
    }
  });

  test("accepts exact grammar boundaries without trimming or case folding", () => {
    const namespace = `a${"b".repeat(63)}`;
    const name = `c${"d".repeat(63)}`;
    const revision = `A${"z".repeat(126)}+`;
    const descriptor = validateTypedContentDescriptor({
      ...VALID_DESCRIPTORS[0],
      logical_id: `skill:${namespace}/${name}`,
      revision,
    });

    expect(descriptor.logical_id).toBe(`skill:${namespace}/${name}`);
    expect(descriptor.revision).toBe(revision);
    expect(
      validateTypedContentDescriptor({
        ...VALID_DESCRIPTORS[2],
        logical_id: `provider:a${"b".repeat(31)}`,
      }).logical_id,
    ).toHaveLength("provider:".length + 32);
    expect(
      validateTypedContentDescriptor({
        ...VALID_DESCRIPTORS[0],
        logical_id: "skill:a._~-/b._~-",
        revision: "v1.0.0+Build-1",
      }).revision,
    ).toBe("v1.0.0+Build-1");
  });

  test("returns a detached validated descriptor copy", () => {
    const input = structuredClone(VALID_DESCRIPTORS[0]!);
    const result = validateTypedContentDescriptor(input);

    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(result.digest).not.toBe(input.digest);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.digest)).toBe(true);
  });

  test("returns stable discriminated parse errors", () => {
    const missing = parseTypedContentDescriptor({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toBeInstanceOf(TypedContentIdentityError);
      expect(missing.error.code).toBe("MISSING_FIELD");
      expect(missing.error.path).toBe("descriptor.kind");
      expect(Object.isFrozen(missing.error)).toBe(true);
    }

    const valid = parseTypedContentDescriptor(VALID_DESCRIPTORS[0]!);
    expect(valid).toEqual({ ok: true, value: VALID_DESCRIPTORS[0]! });
  });

  test("rejects non-objects, unknown fields, kinds, and algorithms", () => {
    expect(() => validateTypedContentDescriptor(null)).toThrow(/descriptor must be an object/);
    expect(() => validateTypedContentDescriptor([])).toThrow(/descriptor must be an object/);
    expect(() =>
      validateTypedContentDescriptor({ ...VALID_DESCRIPTORS[0], extra: true }),
    ).toThrow(/unknown field/);
    expect(() =>
      validateTypedContentDescriptor({
        ...VALID_DESCRIPTORS[0],
        digest: { ...VALID_DESCRIPTORS[0]!.digest, extra: true },
      }),
    ).toThrow(/unknown field/);
    expect(() =>
      validateTypedContentDescriptor({ ...VALID_DESCRIPTORS[0], kind: "source" }),
    ).toThrow(/not registered/);
    expect(() =>
      validateTypedContentDescriptor({
        ...VALID_DESCRIPTORS[0],
        digest: { ...VALID_DESCRIPTORS[0]!.digest, algorithm: "sha-512" },
      }),
    ).toThrow(/algorithm/);
  });

  test("requires own fields and rejects exotic objects", () => {
    const inherited = Object.create(VALID_DESCRIPTORS[0]!) as unknown;
    const parsed = parseTypedContentDescriptor(inherited);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("INVALID_OBJECT");

    expect(parseTypedContentDescriptor(new Date()).ok).toBe(false);
    expect(
      parseTypedContentDescriptor(
        JSON.parse(
          `{"kind":"skill","logical_id":"skill:demo/example","revision":"1","digest":{"algorithm":"sha-256","profile":"tree-v1","scope":"skill-content","value":"${DIGEST}","__proto__":{}}}`,
        ),
      ).ok,
    ).toBe(false);

    const nullPrototypeDigest = Object.assign(Object.create(null), VALID_DESCRIPTORS[0]!.digest);
    const nullPrototypeDescriptor = Object.assign(Object.create(null), {
      ...VALID_DESCRIPTORS[0],
      digest: nullPrototypeDigest,
    });
    expect(validateTypedContentDescriptor(nullPrototypeDescriptor)).toEqual(VALID_DESCRIPTORS[0]!);

    const hidden = { ...VALID_DESCRIPTORS[0] };
    Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
    expect(parseTypedContentDescriptor(hidden).ok).toBe(false);

    const symbol = { ...VALID_DESCRIPTORS[0], [Symbol("hidden")]: true };
    expect(parseTypedContentDescriptor(symbol).ok).toBe(false);

    const accessor = { ...VALID_DESCRIPTORS[0] };
    Object.defineProperty(accessor, "kind", { get: () => "skill", enumerable: true });
    const accessorResult = parseTypedContentDescriptor(accessor);
    expect(accessorResult.ok).toBe(false);
    if (!accessorResult.ok) expect(accessorResult.error.code).toBe("INVALID_PROPERTY");
  });

  test("rejects every missing field and non-string text field", () => {
    for (const field of ["kind", "logical_id", "revision", "digest"] as const) {
      const candidate = structuredClone(VALID_DESCRIPTORS[0]!) as Record<string, unknown>;
      delete candidate[field];
      const result = parseTypedContentDescriptor(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("MISSING_FIELD");
    }

    for (const field of ["algorithm", "profile", "scope", "value"] as const) {
      const candidate = structuredClone(VALID_DESCRIPTORS[0]!) as {
        digest: Record<string, unknown>;
      };
      delete candidate.digest[field];
      const result = parseTypedContentDescriptor(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("MISSING_FIELD");
    }

    for (const [field, value] of [
      ["kind", 1],
      ["logical_id", null],
      ["revision", []],
    ] as const) {
      const result = parseTypedContentDescriptor({ ...VALID_DESCRIPTORS[0], [field]: value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_TYPE");
    }

    for (const digest of [null, [], "digest"]) {
      const result = parseTypedContentDescriptor({ ...VALID_DESCRIPTORS[0], digest });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_OBJECT");
    }

    for (const field of ["algorithm", "profile", "scope", "value"] as const) {
      const result = parseTypedContentDescriptor({
        ...VALID_DESCRIPTORS[0],
        digest: { ...VALID_DESCRIPTORS[0]!.digest, [field]: 1 },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_TYPE");
    }
  });

  test("selects unknown-field errors deterministically without reflecting input values", () => {
    const first = parseTypedContentDescriptor({
      ...VALID_DESCRIPTORS[0],
      zeta: true,
      alpha: true,
    });
    const second = parseTypedContentDescriptor({
      ...VALID_DESCRIPTORS[0],
      alpha: true,
      zeta: true,
    });
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok && !second.ok) {
      expect(first.error.path).toBe("descriptor.[unknown]");
      expect(second.error.path).toBe(first.error.path);
      expect(first.error.message).not.toContain("alpha");
    }

    const hostileKey = `bad\n\u0001${"x".repeat(10_000)}`;
    const hostile = parseTypedContentDescriptor({
      ...VALID_DESCRIPTORS[0],
      [hostileKey]: true,
    });
    expect(hostile.ok).toBe(false);
    if (!hostile.ok) {
      expect(hostile.error.path).toBe("descriptor.[unknown]");
      expect(hostile.error.path).not.toContain(hostileKey);
      expect(hostile.error.message).not.toContain(hostileKey);
    }

    const injected = parseTypedContentDescriptor({
      ...VALID_DESCRIPTORS[0],
      kind: "bad\nvalue",
    });
    expect(injected.ok).toBe(false);
    if (!injected.ok) expect(injected.error.message).toBe("kind is not registered");
  });

  test("enforces exact logical-id alternatives and token cardinality", () => {
    const invalid = [
      ["skill", "skill:demo"],
      ["skill", "skill:demo/example/extra"],
      ["skill", "skill:Demo/example"],
      ["skill", "skill:./example"],
      ["skill", "skill:demo/.."],
      ["skill", "skill:demo/example "],
      ["skill", "skill:demo/exam\u007fple"],
      ["skill", "skill:demo/café"],
      ["provider", "provider:codex/name"],
      ["provider", "provider:Codex"],
      ["provider", `provider:a${"b".repeat(32)}`],
      ["projection", "projection:codex/demo"],
      ["projection", "projection:codex/demo/example/extra"],
      ["projection", "projection:codex/demo/.."],
      ["projection", "projection:co.dex/demo/example"],
      ["schema", "https://skill-sys.dev/schema/example"],
    ] as const;

    for (const [kind, logical_id] of invalid) {
      const base = VALID_DESCRIPTORS.find((candidate) => candidate.kind === kind)!;
      expect(() => validateTypedContentDescriptor({ ...base, logical_id })).toThrow(/logical_id/);
    }

    expect(() =>
      validateTypedContentDescriptor({
        ...VALID_DESCRIPTORS[0],
        logical_id: `skill:${"a".repeat(65)}/example`,
      }),
    ).toThrow(/logical_id/);
  });

  test("rejects malformed revisions and digest values", () => {
    for (const revision of [
      "",
      ".revision",
      "_revision",
      "+revision",
      "-revision",
      " revision",
      "revision ",
      "a/b",
      "a\\b",
      "a:b",
      "a@b",
      "a~b",
      "a\u0001b",
      "a\u007fb",
      "café",
      "a".repeat(129),
    ]) {
      expect(() =>
        validateTypedContentDescriptor({ ...VALID_DESCRIPTORS[0], revision }),
      ).toThrow(/revision/);
    }

    for (const value of ["A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      expect(() =>
        validateTypedContentDescriptor({
          ...VALID_DESCRIPTORS[0],
          digest: { ...VALID_DESCRIPTORS[0]!.digest, value },
        }),
      ).toThrow(/digest.value/);
    }
  });

  test("rejects cross-kind profile and scope substitution even when bytes match", () => {
    expect(() =>
      validateTypedContentDescriptor({
        ...VALID_DESCRIPTORS[0],
        digest: {
          ...VALID_DESCRIPTORS[0]!.digest,
          profile: "json-jcs-v1",
          scope: "schema-document",
        },
      }),
    ).toThrow(/profile/);

    expect(() =>
      validateTypedContentDescriptor({
        ...VALID_DESCRIPTORS[0],
        digest: { ...VALID_DESCRIPTORS[0]!.digest, scope: "schema-document" },
      }),
    ).toThrow(/scope/);

    for (let index = 0; index < VALID_DESCRIPTORS.length; index += 1) {
      const descriptor = VALID_DESCRIPTORS[index]!;
      const other = VALID_DESCRIPTORS[(index + 1) % VALID_DESCRIPTORS.length]!;
      if (descriptor.digest.profile !== other.digest.profile) {
        expect(() =>
          validateTypedContentDescriptor({
            ...descriptor,
            digest: { ...descriptor.digest, profile: other.digest.profile },
          }),
        ).toThrow(/profile/);
      }
      expect(() =>
        validateTypedContentDescriptor({
          ...descriptor,
          digest: { ...descriptor.digest, scope: other.digest.scope },
        }),
      ).toThrow(/scope/);
    }
  });

  test("rejects a mutable reference supplied in place of the descriptor", () => {
    const result = parseTypedContentDescriptor("main");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_OBJECT");
      expect(result.error.path).toBe("descriptor");
    }
  });

  test("compares the complete descriptor equality key", () => {
    const descriptor = VALID_DESCRIPTORS[0]! as Extract<
      TypedContentDescriptor,
      { kind: "skill" }
    >;
    const schemaDescriptor = VALID_DESCRIPTORS[4]! as Extract<
      TypedContentDescriptor,
      { kind: "schema" }
    >;
    expect(typedContentDescriptorsEqual(descriptor, structuredClone(descriptor))).toBe(true);

    const changes: TypedContentDescriptor[] = [
      { ...descriptor, logical_id: "skill:demo/other" },
      { ...descriptor, revision: "2" },
      { ...descriptor, revision: "A" },
      { ...descriptor, revision: "a" },
      { ...descriptor, digest: { ...descriptor.digest, value: "b".repeat(64) } },
      {
        ...descriptor,
        kind: "schema",
        digest: { ...schemaDescriptor.digest },
      },
      {
        ...descriptor,
        digest: { ...descriptor.digest, algorithm: "sha-512" },
      } as unknown as TypedContentDescriptor,
      {
        ...descriptor,
        digest: { ...descriptor.digest, profile: "json-jcs-v1" },
      } as unknown as TypedContentDescriptor,
      {
        ...descriptor,
        digest: { ...descriptor.digest, scope: "schema-document" },
      } as unknown as TypedContentDescriptor,
    ];
    for (const changed of changes) {
      expect(typedContentDescriptorsEqual(descriptor, changed)).toBe(false);
    }
  });

  test("asserts the consumer tuple independently of matching digest bytes", () => {
    const descriptor = VALID_DESCRIPTORS[0]!;
    expect(() =>
      assertTypedContentConsumerTuple(descriptor, {
        kind: "skill",
        algorithm: "sha-256",
        profile: "tree-v1",
        scope: "skill-content",
      }),
    ).not.toThrow();

    expect(() =>
      assertTypedContentConsumerTuple(descriptor, {
        kind: "schema",
        algorithm: "sha-256",
        profile: "json-jcs-v1",
        scope: "schema-document",
      }),
    ).toThrow(/consumer kind/);

    for (const expected of [
      {
        kind: "skill",
        algorithm: "sha-512",
        profile: "tree-v1",
        scope: "skill-content",
      },
      {
        kind: "skill",
        algorithm: "sha-256",
        profile: "json-jcs-v1",
        scope: "skill-content",
      },
      {
        kind: "skill",
        algorithm: "sha-256",
        profile: "tree-v1",
        scope: "schema-document",
      },
    ]) {
      expect(() =>
        assertTypedContentConsumerTuple(
          descriptor,
          expected as unknown as Parameters<typeof assertTypedContentConsumerTuple>[1],
        ),
      ).toThrow();
    }

    const forgedDescriptor = {
      ...descriptor,
      digest: { ...descriptor.digest, profile: "json-jcs-v1", scope: "schema-document" },
    } as unknown as TypedContentDescriptor;
    expect(() =>
      assertTypedContentConsumerTuple(forgedDescriptor, {
        kind: "skill",
        algorithm: "sha-256",
        profile: "tree-v1",
        scope: "skill-content",
      }),
    ).toThrow(/digest.profile/);
  });

  test("stays a pure import leaf and does not claim hashing or verification", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../scripts/modules/skill-sys/typed-content-identity.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toContain("node:");
    expect(source).not.toContain("createHash");
    expect(source).not.toContain("readFile");
    expect(source).toContain("does not hash content");
  });
});
