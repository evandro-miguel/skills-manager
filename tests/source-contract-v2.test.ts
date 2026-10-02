import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseSourceLockV2,
  parseSourceManifestV2,
  SourceContractV2Error,
  validateSourceLockV2,
  validateSourceManifestV2,
} from "../scripts/modules/skill-sys/source-contract-v2.ts";
import {
  type JsonSchemaDocument,
  validateAgainstSubset,
} from "./helpers/json-schema-subset.ts";

const repoRoot = path.resolve(__dirname, "..");
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const sha1 = "c".repeat(40);

function readSchema(fileName: string): JsonSchemaDocument & Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, "schema", fileName), "utf8"),
  ) as JsonSchemaDocument & Record<string, unknown>;
}

const manifestSchema = readSchema("source-manifest-v2.schema.json");
const lockSchema = readSchema("source-lock-v2.schema.json");

function descriptor(digest = digestA): Record<string, unknown> {
  return {
    kind: "skill",
    logical_id: "skill:demo/example",
    revision: "1.0.0",
    digest: {
      algorithm: "sha-256",
      profile: "tree-v1",
      scope: "skill-content",
      value: digest,
    },
  };
}

function gitResolution(alias = "alpha"): Record<string, unknown> {
  return {
    alias,
    origin: {
      key: digestB,
      immutable_revision: { kind: "git-commit-sha1", value: sha1 },
    },
    descriptor: descriptor(),
  };
}

function localResolution(alias = "alpha", digest = digestA): Record<string, unknown> {
  return {
    alias,
    origin: {
      key: digestB,
      immutable_revision: { kind: "local-snapshot-sha256", value: digest },
    },
    descriptor: descriptor(digest),
  };
}

function expectManifestError(
  value: unknown,
  code: SourceContractV2Error["code"],
): void {
  const result = parseSourceManifestV2(value);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
  }
}

function expectLockError(value: unknown, code: SourceContractV2Error["code"]): void {
  const result = parseSourceLockV2(value);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
  }
}

function sha256(relativePath: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(repoRoot, relativePath)))
    .digest("hex");
}

const authorizedSchemaKeywords = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "x-skill-sys-schema-version",
  "x-skill-sys-logical-id",
  "x-skill-sys-revision",
  "$defs",
  "$ref",
  "oneOf",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "pattern",
]);

function expectAuthorizedSchemaNode(node: JsonSchemaDocument & Record<string, unknown>): void {
  for (const key of Object.keys(node)) {
    expect(authorizedSchemaKeywords.has(key), `unauthorized schema keyword ${key}`).toBe(
      true,
    );
  }
  for (const mapKey of ["properties", "$defs"] as const) {
    const map = node[mapKey];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const child of Object.values(map)) {
        expectAuthorizedSchemaNode(child as JsonSchemaDocument & Record<string, unknown>);
      }
    }
  }
  if (node.items && typeof node.items === "object") {
    expectAuthorizedSchemaNode(node.items as JsonSchemaDocument & Record<string, unknown>);
  }
  for (const child of node.oneOf ?? []) {
    expectAuthorizedSchemaNode(child as JsonSchemaDocument & Record<string, unknown>);
  }
}

function expectOnlyLocalRefs(node: unknown, root: JsonSchemaDocument): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      expectOnlyLocalRefs(child, root);
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    expect(record.$ref).toMatch(/^#\/\$defs\/[A-Za-z0-9]+$/);
    expect(root.$defs).toHaveProperty(record.$ref.slice("#/$defs/".length));
  }
  for (const child of Object.values(record)) {
    expectOnlyLocalRefs(child, root);
  }
}

describe("Source manifest and lock v2 schema candidates", () => {
  test("use the governed metadata, authorized keyword subset, and local refs", () => {
    expect(manifestSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(lockSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(manifestSchema.$id).toBe(
      "https://skill-sys.dev/schema/source-manifest-v2.schema.json",
    );
    expect(lockSchema.$id).toBe(
      "https://skill-sys.dev/schema/source-lock-v2.schema.json",
    );
    expect(manifestSchema["x-skill-sys-schema-version"]).toBe("2");
    expect(manifestSchema["x-skill-sys-logical-id"]).toBe(
      "schema:skill-sys/source-manifest",
    );
    expect(manifestSchema["x-skill-sys-revision"]).toBe("2");
    expect(lockSchema["x-skill-sys-schema-version"]).toBe("2");
    expect(lockSchema["x-skill-sys-logical-id"]).toBe("schema:skill-sys/source-lock");
    expect(lockSchema["x-skill-sys-revision"]).toBe("2");

    for (const schema of [manifestSchema, lockSchema]) {
      expectAuthorizedSchemaNode(schema);
      expectOnlyLocalRefs(schema, schema);
    }
  });

  test("accept empty canonical candidates and both immutable revision branches", () => {
    expect(validateAgainstSubset(manifestSchema, {
      schemaVersion: 2,
      declarations: [],
    })).toEqual([]);
    expect(validateAgainstSubset(lockSchema, {
      schemaVersion: 2,
      resolutions: [],
    })).toEqual([]);
    expect(
      validateAgainstSubset(lockSchema, {
        schemaVersion: 2,
        resolutions: [gitResolution()],
      }),
    ).toEqual([]);
    expect(
      validateAgainstSubset(lockSchema, {
        schemaVersion: 2,
        resolutions: [localResolution()],
      }),
    ).toEqual([]);
  });

  test("enforces recursively exact keys and complete descriptor tuple syntax", () => {
    const forbiddenFields = [
      ["root", { schemaVersion: 2, resolutions: [], state: "active" }, "UNKNOWN_FIELD"],
      [
        "resolution",
        {
          schemaVersion: 2,
          resolutions: [{ ...gitResolution(), verification: {} }],
        },
        "UNKNOWN_FIELD",
      ],
      [
        "origin",
        {
          schemaVersion: 2,
          resolutions: [
            {
              ...gitResolution(),
              origin: { ...(gitResolution().origin as object), display: "demo" },
            },
          ],
        },
        "UNKNOWN_FIELD",
      ],
      [
        "revision",
        {
          schemaVersion: 2,
          resolutions: [
            {
              ...gitResolution(),
              origin: {
                key: digestB,
                immutable_revision: {
                  kind: "git-commit-sha1",
                  value: sha1,
                  snapshot_digest: digestA,
                },
              },
            },
          ],
        },
        "UNKNOWN_FIELD",
      ],
      [
        "descriptor",
        {
          schemaVersion: 2,
          resolutions: [
            { ...gitResolution(), descriptor: { ...descriptor(), path: "/tmp/demo" } },
          ],
        },
        "INVALID_DESCRIPTOR",
      ],
      [
        "digest",
        {
          schemaVersion: 2,
          resolutions: [
            {
              ...gitResolution(),
              descriptor: {
                ...descriptor(),
                digest: {
                  ...(descriptor().digest as object),
                  receipt_id: "receipt-1",
                },
              },
            },
          ],
        },
        "INVALID_DESCRIPTOR",
      ],
    ] as const;

    for (const [label, candidate, errorCode] of forbiddenFields) {
      expect(
        validateAgainstSubset(lockSchema, candidate),
        `${label} must reject unknown fields`,
      ).not.toEqual([]);
      expectLockError(candidate, errorCode);
    }

    for (const descriptorOverride of [
      { kind: "profile" },
      { digest: { algorithm: "sha-512", profile: "tree-v1", scope: "skill-content", value: digestA } },
      { digest: { algorithm: "sha-256", profile: "json-jcs-v1", scope: "skill-content", value: digestA } },
      { digest: { algorithm: "sha-256", profile: "tree-v1", scope: "projection-output", value: digestA } },
    ]) {
      const candidate = {
        schemaVersion: 2,
        resolutions: [
          {
            ...gitResolution(),
            descriptor: { ...descriptor(), ...descriptorOverride },
          },
        ],
      };
      expect(validateAgainstSubset(lockSchema, candidate)).not.toEqual([]);
      expectLockError(candidate, "INVALID_DESCRIPTOR");
    }
  });

  test("leaves local digest equality to runtime validation", () => {
    const mismatch = {
      schemaVersion: 2,
      resolutions: [
        {
          ...localResolution(),
          origin: {
            key: digestB,
            immutable_revision: {
              kind: "local-snapshot-sha256",
              value: digestB,
            },
          },
        },
      ],
    };
    expect(validateAgainstSubset(lockSchema, mismatch)).toEqual([]);
    expectLockError(mismatch, "ORIGIN_DESCRIPTOR_MISMATCH");
  });

  test("preserves the immutable v1 schema and parser bytes", () => {
    expect(sha256("schema/source-manifest.schema.json")).toBe(
      "fa4301ac5073a286dd66b2216e6818169f480d5e86388ea63dc1668ee2760343",
    );
    expect(sha256("schema/source-lock.schema.json")).toBe(
      "aa34be2b40fb73436541db27805091c0ec6207d69809f3fe9cb5e5aeb01c0042",
    );
    expect(sha256("scripts/modules/skill-sys/source-manifest.ts")).toBe(
      "b9b188d37ba1870cb04a6ea5380fdbe91a40cab12eb0128d95da45b71312cf7e",
    );
    expect(sha256("scripts/modules/skill-sys/source-lock.ts")).toBe(
      "000219ce0c39ef54685d0a2aa10b33f4d4e30edffe0caa9008ecc7965ea8be7c",
    );
  });
});

describe("Source contract v2 pure validation", () => {
  test("returns frozen canonical manifest and lock copies", () => {
    const manifest = validateSourceManifestV2({
      declarations: [
        { locator: "https://example.test/alpha.git", alias: "alpha" },
        {
          discovery_reference: "main",
          locator: "https://example.test/beta.git",
          alias: "beta",
        },
      ],
      schemaVersion: 2,
    });
    const lock = validateSourceLockV2({
      resolutions: [gitResolution("alpha"), localResolution("beta")],
      schemaVersion: 2,
    });

    expect(Object.keys(manifest)).toEqual(["schemaVersion", "declarations"]);
    expect(Object.keys(manifest.declarations[1]!)).toEqual([
      "alias",
      "locator",
      "discovery_reference",
    ]);
    expect(Object.keys(lock)).toEqual(["schemaVersion", "resolutions"]);
    expect(Object.keys(lock.resolutions[0]!)).toEqual([
      "alias",
      "origin",
      "descriptor",
    ]);
    expect(Object.keys(lock.resolutions[0]!.origin)).toEqual([
      "key",
      "immutable_revision",
    ]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.declarations)).toBe(true);
    expect(Object.isFrozen(manifest.declarations[0]!)).toBe(true);
    expect(Object.isFrozen(lock)).toBe(true);
    expect(Object.isFrozen(lock.resolutions)).toBe(true);
    expect(Object.isFrozen(lock.resolutions[0]!.origin.immutable_revision)).toBe(true);
    expect(Object.isFrozen(lock.resolutions[0]!.descriptor.digest)).toBe(true);
  });

  test("accepts exact boundaries, valid Unicode scalars, and empty documents", () => {
    expect(validateSourceManifestV2({ schemaVersion: 2, declarations: [] })).toEqual({
      schemaVersion: 2,
      declarations: [],
    });
    expect(validateSourceLockV2({ schemaVersion: 2, resolutions: [] })).toEqual({
      schemaVersion: 2,
      resolutions: [],
    });
    expect(
      validateSourceManifestV2({
        schemaVersion: 2,
        declarations: [
          {
            alias: `a${"b".repeat(63)}`,
            locator: "😀".repeat(2048),
            discovery_reference: "😀".repeat(256),
          },
        ],
      }).declarations[0]?.locator,
    ).toBe("😀".repeat(2048));
  });

  test("rejects aliases outside the exact grammar, duplicates, and non-ASCII order", () => {
    for (const alias of ["", "Alpha", "-alpha", "alpha/beta", "alpha ", "a".repeat(65)]) {
      expectManifestError(
        {
          schemaVersion: 2,
          declarations: [{ alias, locator: "https://example.test/source.git" }],
        },
        "INVALID_ALIAS",
      );
    }
    expectManifestError(
      {
        schemaVersion: 2,
        declarations: [
          { alias: "alpha", locator: "one" },
          { alias: "alpha", locator: "two" },
        ],
      },
      "DUPLICATE_ALIAS",
    );
    expectManifestError(
      {
        schemaVersion: 2,
        declarations: [
          { alias: "alpha", locator: "one" },
          { alias: "beta", locator: "two" },
          { alias: "alpha", locator: "three" },
        ],
      },
      "DUPLICATE_ALIAS",
    );
    expectLockError(
      {
        schemaVersion: 2,
        resolutions: [gitResolution("beta"), gitResolution("alpha")],
      },
      "NON_CANONICAL_ORDER",
    );
  });

  test("rejects text bounds, outer whitespace, controls, and invalid scalar strings", () => {
    for (const locator of [
      "",
      "x".repeat(2049),
      " leading",
      "trailing ",
      "line\nbreak",
      `del${String.fromCharCode(0x7f)}`,
      `c1${String.fromCharCode(0x85)}`,
    ]) {
      expectManifestError(
        { schemaVersion: 2, declarations: [{ alias: "alpha", locator }] },
        "INVALID_TEXT",
      );
    }
    expectManifestError(
      {
        schemaVersion: 2,
        declarations: [{ alias: "alpha", locator: "\ud800" }],
      },
      "INVALID_UNICODE",
    );
    expectManifestError(
      {
        schemaVersion: 2,
        declarations: [
          {
            alias: "alpha",
            locator: "source",
            discovery_reference: "r".repeat(257),
          },
        ],
      },
      "INVALID_TEXT",
    );
  });

  test("rejects invalid origin alternatives, keys, and descriptor digests", () => {
    expectLockError(
      {
        schemaVersion: 2,
        resolutions: [
          {
            ...gitResolution(),
            origin: {
              key: "A".repeat(64),
              immutable_revision: { kind: "git-commit-sha1", value: sha1 },
            },
          },
        ],
      },
      "INVALID_ORIGIN_KEY",
    );
    for (const immutableRevision of [
      { kind: "git-commit-sha1", value: "A".repeat(40) },
      { kind: "git-commit-sha1", value: "a".repeat(39) },
      { kind: "local-snapshot-sha256", value: "a".repeat(63) },
      { kind: "git-sha256", value: digestA },
      { kind: "artifact", value: digestA },
    ]) {
      expectLockError(
        {
          schemaVersion: 2,
          resolutions: [
            {
              ...gitResolution(),
              origin: { key: digestB, immutable_revision: immutableRevision },
            },
          ],
        },
        "INVALID_IMMUTABLE_REVISION",
      );
    }
    expectLockError(
      {
        schemaVersion: 2,
        resolutions: [
          {
            ...gitResolution(),
            descriptor: {
              ...descriptor(),
              digest: { ...(descriptor().digest as object), value: "A".repeat(64) },
            },
          },
        ],
      },
      "INVALID_DESCRIPTOR",
    );
  });

  test("rejects hostile objects without invoking accessors", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty(
      { declarations: [] },
      "schemaVersion",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 2;
        },
      },
    );
    expectManifestError(accessor, "INVALID_PROPERTY");
    expect(getterCalls).toBe(0);

    const symbol = { schemaVersion: 2, declarations: [], [Symbol("hidden")]: true };
    expectManifestError(symbol, "UNKNOWN_FIELD");
    expectManifestError(Object.assign(Object.create(null), symbol), "INVALID_OBJECT");
    expectManifestError(new Date(), "INVALID_OBJECT");

    const declarations = [] as unknown[] & { extra?: boolean };
    declarations.extra = true;
    expectManifestError({ schemaVersion: 2, declarations }, "UNKNOWN_FIELD");

    expectManifestError(
      JSON.parse('{"schemaVersion":2,"declarations":[],"__proto__":{}}'),
      "UNKNOWN_FIELD",
    );
    expectLockError(
      JSON.parse(
        `{"schemaVersion":2,"resolutions":[{"alias":"alpha","origin":{"key":"${digestB}","immutable_revision":{"kind":"git-commit-sha1","value":"${sha1}"}},"descriptor":{"kind":"skill","logical_id":"skill:demo/example","revision":"1.0.0","digest":{"algorithm":"sha-256","profile":"tree-v1","scope":"skill-content","value":"${digestA}"},"__proto__":{}}}]}`,
      ),
      "INVALID_DESCRIPTOR",
    );
  });

  test("rejects root, nested, and array Proxies before executing traps", () => {
    let trapCalls = 0;
    const traps: ProxyHandler<object> = {
      get() {
        trapCalls += 1;
        return undefined;
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        return undefined;
      },
      getPrototypeOf() {
        trapCalls += 1;
        return Object.prototype;
      },
      ownKeys() {
        trapCalls += 1;
        return [];
      },
    };

    const rootProxy = new Proxy(
      { schemaVersion: 2, declarations: [] },
      traps,
    );
    expectManifestError(rootProxy, "INVALID_OBJECT");
    expect(trapCalls).toBe(0);

    const nestedProxy = new Proxy(
      { alias: "alpha", locator: "source" },
      traps,
    );
    expectManifestError(
      { schemaVersion: 2, declarations: [nestedProxy] },
      "INVALID_OBJECT",
    );
    expect(trapCalls).toBe(0);

    const arrayProxy = new Proxy([], traps);
    expectManifestError(
      { schemaVersion: 2, declarations: arrayProxy },
      "INVALID_OBJECT",
    );
    expect(trapCalls).toBe(0);
  });

  test("normalizes typed descriptor error paths without duplicate descriptor segments", () => {
    const candidate = {
      schemaVersion: 2,
      resolutions: [
        {
          ...gitResolution(),
          descriptor: { ...descriptor(), extra: true },
        },
      ],
    };
    const result = parseSourceLockV2(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_DESCRIPTOR");
      expect(result.error.path).toBe("resolutions.0.descriptor.[unknown]");
    }
  });

  test("keeps schema and runtime aligned for serializable structural cases", () => {
    const cases: readonly [unknown, boolean][] = [
      [{ schemaVersion: 2, declarations: [] }, true],
      [
        {
          schemaVersion: 2,
          declarations: [{ alias: "alpha", locator: "https://example.test/source.git" }],
        },
        true,
      ],
      [{ schemaVersion: 1, declarations: [] }, false],
      [{ schemaVersion: 2, declarations: [{ alias: "alpha" }] }, false],
      [
        {
          schemaVersion: 2,
          declarations: [{ alias: "alpha", locator: "source", policy: {} }],
        },
        false,
      ],
    ];
    for (const [candidate, valid] of cases) {
      expect(validateAgainstSubset(manifestSchema, candidate).length === 0).toBe(valid);
      expect(parseSourceManifestV2(candidate).ok).toBe(valid);
    }

    const lockCases: readonly [unknown, boolean][] = [
      [{ schemaVersion: 2, resolutions: [] }, true],
      [{ schemaVersion: 2, resolutions: [gitResolution()] }, true],
      [{ schemaVersion: 2, resolutions: [localResolution()] }, true],
      [{ schemaVersion: 2, resolutions: [{ ...gitResolution(), state: "verified" }] }, false],
      [{ schemaVersion: 2, resolutions: [{ ...gitResolution(), descriptor: {} }] }, false],
    ];
    for (const [candidate, valid] of lockCases) {
      expect(validateAgainstSubset(lockSchema, candidate).length === 0).toBe(valid);
      expect(parseSourceLockV2(candidate).ok).toBe(valid);
    }
  });
});
