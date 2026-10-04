import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import path from "node:path";
import { parseSkillsShReference, parseSkillsShExternalId } from "../scripts/modules/integrations/skills-sh/reference-parser.ts";
import { assertSafeGitRef } from "../scripts/lib/git-ref.ts";
import { normalizeSourceSpec } from "../scripts/commands/skill-sys.ts";

// fast-check reports a seed and shrink path on failure. Set these variables to
// replay that counterexample; otherwise each CI run explores fresh inputs.
const options = {
  numRuns: 1000,
  ...(process.env.FUZZ_SEED ? { seed: Number(process.env.FUZZ_SEED) } : {}),
  ...(process.env.FUZZ_PATH ? { path: process.env.FUZZ_PATH } : {}),
};
const segment = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,19}$/);
const cwd = path.resolve(__dirname, "..");
const octet = fc.integer({ min: 0, max: 255 });

describe("source boundary property tests", () => {
  test("catalog forms round-trip without changing the upstream identity", () => {
    fc.assert(fc.property(segment, segment, fc.array(segment, { maxLength: 6 }), (owner, repo, hints) => {
      const id = [owner, repo, ...hints].join("/");
      const reference = parseSkillsShReference(`skills.sh:${id}`);
      expect(reference.canonicalGitUrl).toBe(`https://github.com/${owner}/${repo}.git`);
      expect(parseSkillsShReference(`https://skills.sh/${id}`)).toEqual(reference);
      expect(parseSkillsShExternalId(reference.externalId)).toEqual(reference);
    }), options);
  });

  test("catalog path hints cannot introduce URL syntax or traversal", () => {
    fc.assert(fc.property(segment, segment, fc.constantFrom("..", ".", "%2e%2e", "x?y", "x#y", "x@y", "x\\y"), (owner, repo, hint) => {
      expect(() => parseSkillsShReference(`skills.sh:${owner}/${repo}/${hint}`)).toThrow();
    }), options);
  });

  test("remote sources reject generated embedded credentials", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 60 }), segment, (credential, repo) => {
      const encoded = encodeURIComponent(credential);
      expect(() => normalizeSourceSpec(`https://${encoded}@github.com/example/${repo}.git`, { cwd })).toThrow(/credential/i);
      expect(() => normalizeSourceSpec(`ssh://git:${encoded}@github.com/example/${repo}.git`, { cwd })).toThrow(/credential/i);
      expect(() => normalizeSourceSpec(`https://github.com/example/${repo}.git?access_token=${encoded}`, { cwd })).toThrow(/credential/i);
    }), options);
  });

  test("private and link-local addresses are rejected across remote syntaxes", () => {
    const privateHost = fc.oneof(
      fc.tuple(octet, octet, octet).map(([b, c, d]) => `10.${b}.${c}.${d}`),
      fc.tuple(fc.integer({ min: 16, max: 31 }), octet, octet).map(([b, c, d]) => `172.${b}.${c}.${d}`),
      fc.tuple(octet, octet).map(([c, d]) => `192.168.${c}.${d}`),
      fc.tuple(octet, octet, octet).map(([b, c, d]) => `127.${b}.${c}.${d}`),
      fc.tuple(octet, octet).map(([c, d]) => `169.254.${c}.${d}`),
      fc.tuple(octet, octet, octet).map(([b, c, d]) => `[::ffff:10.${b}.${c}.${d}]`),
      fc.tuple(fc.constantFrom("fc00", "fd00", "fe80"), fc.integer({ min: 1, max: 65535 })).map(([prefix, suffix]) => `[${prefix}::${suffix.toString(16)}]`),
      fc.constantFrom("[::1]", "127.1", "0177.0.0.1"),
    );
    fc.assert(fc.property(privateHost, (host) => {
      for (const source of [`https://${host}/org/repo.git`, `ssh://git@${host}/org/repo.git`, `git@${host}:org/repo.git`]) {
        expect(() => normalizeSourceSpec(source, { cwd })).toThrow(/private|loopback|internal|unsafe|numeric/i);
      }
    }), options);
  });

  test("git refs reject option injection, operators, and invalid ref syntax", () => {
    fc.assert(fc.property(segment, fc.constantFrom(";", "|", "&", "`", "$", "\n", "\0", "..", "//", "@{"), segment, (left, operator, right) => {
      expect(() => assertSafeGitRef(`--${left}`)).toThrow();
      expect(() => assertSafeGitRef(`${left}${operator}${right}`)).toThrow();
      expect(() => assertSafeGitRef(`${left}/${right}.lock`)).toThrow();
      expect(() => assertSafeGitRef(`${left}/${right.repeat(257)}`)).toThrow();
    }), options);
  });
});
