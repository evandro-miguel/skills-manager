import { describe, expect, test } from "bun:test";
import {
  CatalogQueryInputError,
  queryCatalogSkills,
  type CatalogSelectedProfileRecord,
  type CatalogSkillRecord,
  type CatalogSkillsQueryInput,
} from "../scripts/modules/catalog/query-skills.ts";

function skill(overrides: Partial<CatalogSkillRecord> = {}): CatalogSkillRecord {
  return {
    name: "alpha",
    description: "Alpha documentation helper",
    category: "docs",
    tags: ["bun", "cli"],
    triggers: ["documentation", "catalog"],
    version: "1.0.0",
    updated_at: "2026-07-27",
    target_provider: "universal",
    path: "skills/alpha",
    profiles: [],
    profile_metadata: [],
    internal: false,
    experimental: false,
    ...overrides,
  };
}

function input(overrides: Partial<CatalogSkillsQueryInput> = {}): CatalogSkillsQueryInput {
  return {
    categories: [],
    tags: [],
    queries: [],
    profiles: [],
    includeInternal: false,
    includeExperimental: false,
    ...overrides,
  };
}

describe("F-03 catalog.skills.query", () => {
  test("filters visibility and performs category, token, and text matching", () => {
    const records = [
      skill(),
      skill({
        name: "internal",
        path: "skills/internal",
        internal: true,
        category: "ops",
      }),
      skill({
        name: "experimental",
        path: "skills/experimental",
        experimental: true,
        tags: ["preview"],
      }),
    ];

    expect(queryCatalogSkills(records, [], input())).toMatchObject({
      matchCount: 1,
      skills: [{ name: "alpha" }],
    });
    expect(
      queryCatalogSkills(
        records,
        [],
        input({ includeInternal: true, includeExperimental: true }),
      ).matchCount,
    ).toBe(3);
    expect(
      queryCatalogSkills(records, [], input({ categories: ["DOCS"] })).skills.map(
        ({ name }) => name,
      ),
    ).toEqual(["alpha"]);
    expect(
      queryCatalogSkills(records, [], input({ tags: ["DOCUMENTATION"] })).skills.map(
        ({ name }) => name,
      ),
    ).toEqual(["alpha"]);
    expect(
      queryCatalogSkills(records, [], input({ queries: ["HELPER"] })).skills.map(
        ({ name }) => name,
      ),
    ).toEqual(["alpha"]);
    expect(queryCatalogSkills(records, [], input({ queries: ["UNIVERSAL"] })).matchCount).toBe(0);
    expect(
      queryCatalogSkills(records, [], input({ categories: ["missing"], tags: ["bun"] }))
        .matchCount,
    ).toBe(0);
  });

  test("restricts to selected profiles and annotates matches in selection order", () => {
    const profiles: readonly CatalogSelectedProfileRecord[] = [
      {
        name: "Core",
        description: "Core choices",
        skills: ["alpha", "shared"],
      },
      {
        name: "Docs",
        curation: "reviewed",
        scope: "documentation",
        skills: ["shared"],
      },
    ];
    const result = queryCatalogSkills(
      [
        skill(),
        skill({ name: "shared", path: "skills/shared" }),
        skill({ name: "outside", path: "skills/outside" }),
      ],
      profiles,
      input({ profiles: ["core", "docs"] }),
    );

    expect(result.skills.map(({ name }) => name)).toEqual(["alpha", "shared"]);
    expect(result.skills[0]?.profiles).toEqual(["Core"]);
    expect(result.skills[0]?.profile_metadata).toEqual([
      { name: "Core", description: "Core choices" },
    ]);
    expect(result.skills[1]?.profiles).toEqual(["Core", "Docs"]);
    expect(result.skills[1]?.profile_metadata).toEqual([
      { name: "Core", description: "Core choices" },
      { name: "Docs", curation: "reviewed", scope: "documentation" },
    ]);
  });

  test("orders by unsigned UTF-8 name bytes then safe-relative path bytes", () => {
    const records = [
      skill({ name: "é", path: "skills/z" }),
      skill({ name: "a", path: "skills/z" }),
      skill({ name: "a", path: "skills/a-long" }),
      skill({ name: "a", path: "skills/a" }),
      skill({ name: "z", path: "skills/a" }),
    ];

    expect(
      queryCatalogSkills(records, [], input()).skills.map(({ name, path }) => [name, path]),
    ).toEqual([
      ["a", "skills/a"],
      ["a", "skills/a-long"],
      ["a", "skills/z"],
      ["z", "skills/a"],
      ["é", "skills/z"],
    ]);
  });

  test("rejects duplicate identities and every unsafe relative-path class", () => {
    expect(() =>
      queryCatalogSkills([skill(), skill()], [], input()),
    ).toThrow(/duplicate Catalog skill identity/);

    for (const path of [
      "",
      "/skills/alpha",
      "../alpha",
      "skills/../alpha",
      "skills\\alpha",
      "skills//alpha",
      "skills/./alpha",
      "skills/alpha\u0000",
      "skills/alpha\u001f",
      "skills/alpha\u007f",
      "skills/alpha\u009f",
      "C:/skills/alpha",
      "c:skills/alpha",
      `skills/${"a".repeat(4_090)}`,
      "skills/\ud800",
      "skills/\udc00",
    ]) {
      expect(() => queryCatalogSkills([skill({ path })], [], input())).toThrow(
        /non-empty string|safe relative path|well-formed Unicode/,
      );
    }
    expect(
      queryCatalogSkills(
        [skill({ path: `skills/${"a".repeat(4_089)}` })],
        [],
        input(),
      ).matchCount,
    ).toBe(1);
    for (const codePoint of [
      ...Array.from({ length: 0x20 }, (_, index) => index),
      ...Array.from({ length: 0x21 }, (_, index) => index + 0x7f),
    ]) {
      expect(() =>
        queryCatalogSkills(
          [skill({ path: `skills/a${String.fromCharCode(codePoint)}b` })],
          [],
          input(),
        ),
      ).toThrow(/safe relative path/);
    }
  });

  test("returns deeply detached, immutable records without mutating inputs", () => {
    const original = skill({
      tags: ["one"],
      profile_metadata: [{ name: "stale", description: "must be replaced" }],
      profiles: ["stale"],
    });
    const records = [original];
    const selectedProfiles = [{ name: "Core", skills: ["alpha"] }];
    const filters = input({ profiles: ["core"] });
    const before = structuredClone({ records, selectedProfiles, filters });

    const result = queryCatalogSkills(records, selectedProfiles, filters);

    expect({ records, selectedProfiles, filters }).toEqual(before);
    expect(result.skills[0]).not.toBe(original);
    expect(result.skills[0]?.tags).not.toBe(original.tags);
    expect(result.skills[0]?.profiles).toEqual(["Core"]);
    expect(result.skills[0]?.profile_metadata).toEqual([{ name: "Core" }]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.skills)).toBe(true);
    expect(Object.isFrozen(result.skills[0])).toBe(true);
    expect(Object.isFrozen(result.skills[0]?.tags)).toBe(true);
    expect(Object.isFrozen(result.skills[0]?.profile_metadata[0])).toBe(true);
  });

  test("rejects proxies before traps and accessors before getters across every argument", () => {
    let trapReads = 0;
    let getterReads = 0;
    const proxy = new Proxy(skill(), {
      get() {
        trapReads += 1;
        throw new Error("proxy trap must not run");
      },
      ownKeys() {
        trapReads += 1;
        throw new Error("proxy trap must not run");
      },
      getOwnPropertyDescriptor() {
        trapReads += 1;
        throw new Error("proxy trap must not run");
      },
    });
    const accessor = Object.defineProperty({}, "categories", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("getter must not run");
      },
    });

    expect(() => queryCatalogSkills([proxy], [], input())).toThrow(/proxy/);
    expect(() =>
      queryCatalogSkills([skill()], [], accessor as CatalogSkillsQueryInput),
    ).toThrow(/accessor/);
    expect(trapReads).toBe(0);
    expect(getterReads).toBe(0);
  });

  test("validates all hostile graphs before reading otherwise valid caller data", () => {
    let reads = 0;
    const records = [
      Object.defineProperty(skill(), "name", {
        enumerable: true,
        get() {
          reads += 1;
          return "alpha";
        },
      }),
    ];
    const hostileInput = new Proxy(input(), {});

    expect(() =>
      queryCatalogSkills(records as readonly CatalogSkillRecord[], [], hostileInput),
    ).toThrow(/accessor|proxy/);
    expect(reads).toBe(0);
  });

  test("rejects exotic, cyclic, sparse, symbolic, and hidden-field data", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const sparse = new Array(2);
    sparse[1] = skill();
    const symbolic = Object.assign(input(), { [Symbol("hidden")]: true });
    const hidden = Object.defineProperty(input(), "secret", {
      value: true,
      enumerable: false,
    });

    const cases: Array<() => unknown> = [
      () => queryCatalogSkills([new Date() as unknown as CatalogSkillRecord], [], input()),
      () => queryCatalogSkills(cyclic as readonly CatalogSkillRecord[], [], input()),
      () => queryCatalogSkills(sparse as readonly CatalogSkillRecord[], [], input()),
      () => queryCatalogSkills([skill()], [], symbolic),
      () => queryCatalogSkills([skill()], [], hidden),
    ];

    for (const invoke of cases) {
      expect(invoke).toThrow(CatalogQueryInputError);
    }
  });

  test("rejects unknown fields and invalid scalar or collection types", () => {
    expect(() =>
      queryCatalogSkills(
        [{ ...skill(), surprise: true } as CatalogSkillRecord],
        [],
        input(),
      ),
    ).toThrow(/unknown field/);
    expect(() =>
      queryCatalogSkills(
        [skill({ internal: "yes" as unknown as boolean })],
        [],
        input(),
      ),
    ).toThrow(/must be a boolean/);
  });

  test("preserves requested-profile order, display names, and repeated annotations", () => {
    const result = queryCatalogSkills(
      [skill()],
      [
        {
          name: "Curated Core",
          description: "First selection",
          skills: ["alpha", "alpha"],
        },
        {
          name: "Curated Core",
          description: "Repeated selection",
          skills: ["alpha"],
        },
      ],
      input({ profiles: ["core", "core"] }),
    );

    expect(result.skills.map(({ name }) => name)).toEqual(["alpha"]);
    expect(result.skills[0]?.profiles).toEqual([
      "Curated Core",
      "Curated Core",
      "Curated Core",
    ]);
    expect(result.skills[0]?.profile_metadata).toEqual([
      { name: "Curated Core", description: "First selection" },
      { name: "Curated Core", description: "First selection" },
      { name: "Curated Core", description: "Repeated selection" },
    ]);
  });

  test("requires one detached selected-profile record per requested profile", () => {
    expect(() =>
      queryCatalogSkills(
        [skill()],
        [{ name: "Curated Core", skills: ["alpha"] }],
        input({ profiles: ["core", "docs"] }),
      ),
    ).toThrow(/one-for-one/);
  });

  test("handles empty input deterministically and preserves missing profile metadata", () => {
    expect(queryCatalogSkills([], [], input())).toEqual({
      matchCount: 0,
      skills: [],
    });
    const result = queryCatalogSkills(
      [skill()],
      [{ name: "Core", skills: ["alpha"] }],
      input({ profiles: ["core"] }),
    );
    expect(result.skills[0]?.profile_metadata).toEqual([{ name: "Core" }]);
    expect("description" in (result.skills[0]?.profile_metadata[0] ?? {})).toBe(false);
  });

  test("rejects extremely deep invalid graphs with the typed Catalog error", () => {
    let nested: unknown = "alpha";
    for (let depth = 0; depth < 20_000; depth += 1) {
      nested = [nested];
    }
    const deeplyInvalid = {
      ...input(),
      queries: nested,
    } as unknown as CatalogSkillsQueryInput;

    expect(() => queryCatalogSkills([], [], deeplyInvalid)).toThrow(
      CatalogQueryInputError,
    );
  });
});
