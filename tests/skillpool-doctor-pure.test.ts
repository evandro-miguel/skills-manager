import { describe, expect, test } from "bun:test";
import path from "node:path";

/** Run `fn` with process.env.HOME temporarily set to `home`, restoring the original on return (even if fn throws). */
function withHome<T>(home: string | undefined, fn: () => T): T {
  const saved = process.env.HOME;
  if (home === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = home;
  }
  try { return fn(); } finally { process.env.HOME = saved; }
}

const doctor = require("../scripts/modules/skillpool/doctor.ts") as typeof import("../scripts/modules/skillpool/doctor.ts");

// ─── isLocalAbsolutePath ─────────────────────────────────────────────

describe("isLocalAbsolutePath", () => {
  test("returns true for POSIX absolute path", () => {
    expect(doctor.isLocalAbsolutePath("/usr/local/bin")).toBe(true);
  });

  test("returns true for root slash", () => {
    expect(doctor.isLocalAbsolutePath("/")).toBe(true);
  });

  test("returns false for relative path", () => {
    expect(doctor.isLocalAbsolutePath("relative/path")).toBe(false);
  });

  test("returns false for dot-relative path", () => {
    expect(doctor.isLocalAbsolutePath("./foo")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(doctor.isLocalAbsolutePath("")).toBe(false);
  });

  test("returns true for Windows-style absolute path (C:\\)", () => {
    expect(doctor.isLocalAbsolutePath("C:\\Users\\test")).toBe(true);
  });

  test("returns true for Windows UNC path", () => {
    expect(doctor.isLocalAbsolutePath("\\\\server\\share")).toBe(true);
  });
});

// ─── stateMode ────────────────────────────────────────────────────────

describe("stateMode", () => {
  test('returns "legacy" for null', () => {
    expect(doctor.stateMode(null)).toBe("legacy");
  });

  test('returns "legacy" for undefined', () => {
    expect(doctor.stateMode(undefined)).toBe("legacy");
  });

  test('returns "legacy" for non-object', () => {
    expect(doctor.stateMode("string")).toBe("legacy");
    expect(doctor.stateMode(42)).toBe("legacy");
    expect(doctor.stateMode(true)).toBe("legacy");
  });

  test('returns "legacy" for empty object (no mode)', () => {
    expect(doctor.stateMode({})).toBe("legacy");
  });

  test('returns "legacy" when mode is not a string', () => {
    expect(doctor.stateMode({ mode: 123 })).toBe("legacy");
    expect(doctor.stateMode({ mode: null })).toBe("legacy");
    expect(doctor.stateMode({ mode: true })).toBe("legacy");
  });

  test('returns the mode string when valid', () => {
    expect(doctor.stateMode({ mode: "minimal" })).toBe("minimal");
    expect(doctor.stateMode({ mode: "debug" })).toBe("debug");
    expect(doctor.stateMode({ mode: "custom" })).toBe("custom");
  });
});

// ─── isPathLikeField ──────────────────────────────────────────────────

describe("isPathLikeField", () => {
  const pathLikeFields = ["path", "target", "from", "to", "archive_path", "sourcepath"];

  test("returns true for known path-like field names", () => {
    for (const field of pathLikeFields) {
      expect(doctor.isPathLikeField(field)).toBe(true);
    }
  });

  test("is case-insensitive", () => {
    expect(doctor.isPathLikeField("Path")).toBe(true);
    expect(doctor.isPathLikeField("TARGET")).toBe(true);
    expect(doctor.isPathLikeField("From")).toBe(true);
  });

  test("returns true for dot-prefixed path-like fields", () => {
    expect(doctor.isPathLikeField("state.path")).toBe(true);
    expect(doctor.isPathLikeField("config.target")).toBe(true);
  });

  test("returns true for field with array index suffix", () => {
    expect(doctor.isPathLikeField("skills[0].path")).toBe(true);
    expect(doctor.isPathLikeField("items[2].target")).toBe(true);
    expect(doctor.isPathLikeField("path[0]")).toBe(true);
  });

  test("returns false for non-path-like field names", () => {
    expect(doctor.isPathLikeField("name")).toBe(false);
    expect(doctor.isPathLikeField("version")).toBe(false);
    expect(doctor.isPathLikeField("description")).toBe(false);
    expect(doctor.isPathLikeField("enabled")).toBe(false);
    expect(doctor.isPathLikeField("count")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(doctor.isPathLikeField("")).toBe(false);
  });
});

// ─── normalizedPathEscapesProject ─────────────────────────────────────

describe("normalizedPathEscapesProject", () => {
  test('returns true for ".."', () => {
    expect(doctor.normalizedPathEscapesProject("..")).toBe(true);
  });

  test('returns true for "../" prefix', () => {
    expect(doctor.normalizedPathEscapesProject("../etc/passwd")).toBe(true);
    expect(doctor.normalizedPathEscapesProject("../foo")).toBe(true);
  });

  test('returns true for "..\\.." (backslash normalised)', () => {
    expect(doctor.normalizedPathEscapesProject("..\\..")).toBe(true);
  });

  test("returns true for mixed traversal with backslashes", () => {
    expect(doctor.normalizedPathEscapesProject("..\\..\\etc")).toBe(true);
  });

  test("returns false for simple relative path", () => {
    expect(doctor.normalizedPathEscapesProject("foo/bar")).toBe(false);
  });

  test("returns false for dot-prefixed path", () => {
    expect(doctor.normalizedPathEscapesProject("./foo")).toBe(false);
  });

  test("returns false for plain filename", () => {
    expect(doctor.normalizedPathEscapesProject("file.txt")).toBe(false);
  });

  test("returns false for absolute path (doesn't start with ..)", () => {
    expect(doctor.normalizedPathEscapesProject("/usr/local")).toBe(false);
  });
});

// ─── isHomePath ───────────────────────────────────────────────────────

describe("isHomePath", () => {
  test('returns true for "~"', () => {
    expect(doctor.isHomePath("~")).toBe(true);
  });

  test('returns true for "~/..." paths', () => {
    expect(doctor.isHomePath("~/Documents")).toBe(true);
    expect(doctor.isHomePath("~/")).toBe(true);
  });

  test('returns true for "~\\..." paths', () => {
    expect(doctor.isHomePath("~\\Documents")).toBe(true);
  });

  test("returns false for relative path", () => {
    expect(doctor.isHomePath("relative/path")).toBe(false);
  });

  test("returns false for non-home absolute path", () => {
    withHome("/tmp/doctor-test-home-isolated", () => {
      expect(doctor.isHomePath("/usr/local/bin")).toBe(false);
    });
  });

  test("returns true when absolute path equals HOME", () => {
    withHome("/tmp/doctor-test-home-exact", () => {
      expect(doctor.isHomePath("/tmp/doctor-test-home-exact")).toBe(true);
    });
  });

  test("returns true when absolute path is inside HOME", () => {
    withHome("/tmp/doctor-test-home-sub", () => {
      expect(doctor.isHomePath("/tmp/doctor-test-home-sub/.skills")).toBe(true);
    });
  });

  test("returns false when HOME is unset and path is absolute non-tilde", () => {
    withHome(undefined, () => {
      expect(doctor.isHomePath("/usr/local/bin")).toBe(false);
    });
  });
});

// ─── collectPathFindings ──────────────────────────────────────────────

describe("collectPathFindings", () => {
  test("returns empty findings for null", () => {
    const result = doctor.collectPathFindings(null);
    expect(result.absolute).toEqual([]);
    expect(result.escape).toEqual([]);
    expect(result.home).toEqual([]);
  });

  test("returns empty findings for undefined", () => {
    const result = doctor.collectPathFindings(undefined);
    expect(result.absolute).toEqual([]);
  });

  test("returns empty findings for number", () => {
    const result = doctor.collectPathFindings(42);
    expect(result.absolute).toEqual([]);
  });

  test("returns empty findings for boolean", () => {
    const result = doctor.collectPathFindings(true);
    expect(result.absolute).toEqual([]);
  });

  test("detects absolute path in string value", () => {
    const result = doctor.collectPathFindings("/usr/bin");
    expect(result.absolute).toEqual(["$"]);
  });

  test("detects escape path in path-like field", () => {
    const result = doctor.collectPathFindings({ target: "../etc/passwd" });
    expect(result.escape).toEqual(["$.target"]);
  });

  test("does NOT flag escape for non-path-like field", () => {
    const result = doctor.collectPathFindings({ name: "../etc/passwd" });
    expect(result.escape).toEqual([]);
  });

  test("detects home path (tilde) in path-like field", () => {
    const result = doctor.collectPathFindings({ path: "~/skills" });
    expect(result.home).toEqual(["$.path"]);
  });

  test("traverses arrays", () => {
    const result = doctor.collectPathFindings({ items: ["/abs/one", "/abs/two"] });
    expect(result.absolute).toEqual(["$.items[0]", "$.items[1]"]);
  });

  test("traverses nested objects", () => {
    const result = doctor.collectPathFindings({
      outer: { path: "../escape" },
    });
    expect(result.escape).toEqual(["$.outer.path"]);
  });

  test("traverses arrays of objects", () => {
    const result = doctor.collectPathFindings({
      skills: [{ target: "/abs/path" }],
    });
    expect(result.absolute).toEqual(["$.skills[0].target"]);
  });

  test("respects custom prefix", () => {
    const result = doctor.collectPathFindings("/absolute", "custom.prefix");
    expect(result.absolute).toEqual(["custom.prefix"]);
  });

  test("respects custom output accumulator", () => {
    const existing = { absolute: ["pre.existing"], escape: [], home: [] };
    const result = doctor.collectPathFindings("/another", "$", existing);
    expect(result.absolute).toEqual(["pre.existing", "$"]);
    // Same reference
    expect(result).toBe(existing);
  });

  test("detects home absolute path when HOME is set", () => {
    withHome("/tmp/doctor-collect-home", () => {
      const result = doctor.collectPathFindings({ target: "/tmp/doctor-collect-home/.skills" });
      expect(result.home).toEqual(["$.target"]);
    });
  });

  test("mixed object with multiple finding types", () => {
    withHome("/tmp/doctor-mixed-home", () => {
      const result = doctor.collectPathFindings({
        path: "~/secret",
        target: "../etc",
        name: "/abs/should-be-absolute-only",
      });
      expect(result.home).toEqual(["$.path"]);
      expect(result.escape).toEqual(["$.target"]);
      // 'name' is not path-like, so escape/home won't flag, but absolute will
      expect(result.absolute).toEqual(["$.name"]);
    });
  });
});

// ─── printFindings ────────────────────────────────────────────────────

describe("printFindings", () => {
  let logs: string[];
  let errors: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExitCode: number | string | null | undefined;

  function setupCapture(): void {
    logs = [];
    errors = [];
    originalLog = console.log;
    originalError = console.error;
    originalExitCode = process.exitCode;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    process.exitCode = undefined;
  }

  function teardownCapture(): void {
    console.log = originalLog!;
    console.error = originalError!;
    process.exitCode = originalExitCode as number | undefined;
  }

  test("prints STATUS: PASS with no findings", () => {
    setupCapture();
    try {
      process.exitCode = 0;
      doctor.printFindings([]);
      expect(logs[0]).toBe("STATUS: PASS");
      expect(logs[1]).toBe("Errors: 0  Warnings: 0");
      // printFindings must NOT set exitCode to 1 for empty findings
      expect(process.exitCode).not.toBe(1);
    } finally {
      teardownCapture();
    }
  });

  test("prints STATUS: BLOCKING with ERROR findings and sets exitCode=1", () => {
    setupCapture();
    try {
      doctor.printFindings([
        { level: "ERROR", code: "TEST_ERR", message: "Something broke" },
      ]);
      expect(logs[0]).toBe("STATUS: BLOCKING");
      expect(logs[1]).toBe("Errors: 1  Warnings: 0");
      expect(logs).toContainEqual("- [ERROR TEST_ERR] Something broke");
      expect(process.exitCode).toBe(1);
    } finally {
      teardownCapture();
    }
  });

  test("prints STATUS: CONCERNS with only WARN findings and does NOT set exitCode=1", () => {
    setupCapture();
    try {
      // Ensure exitCode is not 1 before calling
      process.exitCode = 0;
      doctor.printFindings([
        { level: "WARN", code: "TEST_WARN", message: "Heads up" },
      ]);
      expect(logs[0]).toBe("STATUS: CONCERNS");
      expect(logs[1]).toBe("Errors: 0  Warnings: 1");
      // printFindings must NOT set exitCode to 1 for WARN-only
      expect(process.exitCode).not.toBe(1);
    } finally {
      teardownCapture();
    }
  });

  test("counts errors and warnings correctly with mixed findings", () => {
    setupCapture();
    try {
      doctor.printFindings([
        { level: "WARN", code: "W1", message: "w1" },
        { level: "ERROR", code: "E1", message: "e1" },
        { level: "ERROR", code: "E2", message: "e2" },
      ]);
      expect(logs[0]).toBe("STATUS: BLOCKING");
      expect(logs[1]).toBe("Errors: 2  Warnings: 1");
      expect(process.exitCode).toBe(1);
    } finally {
      teardownCapture();
    }
  });

  test("prints all findings in order", () => {
    setupCapture();
    try {
      doctor.printFindings([
        { level: "WARN", code: "W1", message: "warning 1" },
        { level: "ERROR", code: "E1", message: "error 1" },
      ]);
      const findingLines = logs.filter((l) => l.startsWith("- ["));
      expect(findingLines).toEqual([
        "- [WARN W1] warning 1",
        "- [ERROR E1] error 1",
      ]);
    } finally {
      teardownCapture();
    }
  });
});
