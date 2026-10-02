import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const skillSys = require("../scripts/commands/skill-sys.ts") as typeof import("../scripts/commands/skill-sys.ts");

const tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function makeTempRoot(prefix: string): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(tempRoot);
  return tempRoot;
}

// ---------------------------------------------------------------------------
// 1. Reject URLs with embedded credentials
// ---------------------------------------------------------------------------
describe("source URL credential rejection", () => {
  const cwd = repoRoot;

  test("rejects HTTPS URL with username:password", () => {
    const userInfo = ["user", "pass"].join(":");
    expect(() =>
      skillSys.normalizeSourceSpec(`https://${userInfo}@github.com/org/repo.git`, { cwd })
    ).toThrow("credential");
  });

  test("rejects HTTPS URL with username only (token in user)", () => {
    const tokenUser = ["ghp_", "TOKEN"].join("");
    expect(() =>
      skillSys.normalizeSourceSpec(`https://${tokenUser}@github.com/org/repo.git`, { cwd })
    ).toThrow("credential");
  });

  test("rejects HTTPS URL with password only", () => {
    const password = ["pass", "word"].join("");
    expect(() =>
      skillSys.normalizeSourceSpec(`https://:${password}@github.com/org/repo.git`, { cwd })
    ).toThrow("credential");
  });
});

// ---------------------------------------------------------------------------
// 2. Reject file:// and unsupported schemes
// ---------------------------------------------------------------------------
describe("unsupported scheme rejection", () => {
  const cwd = repoRoot;

  test("rejects file:// scheme", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("file:///etc/passwd", { cwd })
    ).toThrow(/unsupported|scheme|Cannot classify/i);
  });

  test("rejects ftp:// scheme", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("ftp://evil.com/repo.git", { cwd })
    ).toThrow(/unsupported|scheme|Cannot classify/i);
  });

  test("rejects data: scheme", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("data:text/plain,hello", { cwd })
    ).toThrow(/unsupported|scheme|Cannot classify/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Reject HTTP(S) private/loopback/link-local IP hosts
// ---------------------------------------------------------------------------
describe("private network host rejection", () => {
  const cwd = repoRoot;

  test("rejects localhost in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://localhost/org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });

  test("rejects 127.0.0.1 in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://127.0.0.1/org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });

  test("rejects 10.x private IP in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://10.0.0.1/org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });

  test("rejects 172.16.x private IP in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://172.16.0.1/org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });

  test("rejects 192.168.x private IP in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://192.168.1.1/org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });

  test("rejects 169.254.x link-local IP in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://169.254.1.1/org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });

  test("rejects [::1] IPv6 loopback in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://[::1]/org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Keep allowing GitHub HTTPS and SSH forms
// ---------------------------------------------------------------------------
describe("legitimate remote sources still accepted", () => {
  const cwd = repoRoot;

  test("accepts GitHub HTTPS URL", () => {
    const result = skillSys.normalizeSourceSpec("https://github.com/org/repo.git", { cwd });
    expect(result).toEqual({ kind: "repo", value: "https://github.com/org/repo.git" });
  });

  test("accepts GitHub HTTPS URL with #ref", () => {
    const result = skillSys.normalizeSourceSpec("https://github.com/org/repo.git#v1.2.3", { cwd });
    expect(result).toEqual({
      kind: "repo",
      value: "https://github.com/org/repo.git",
      ref: "v1.2.3",
    });
  });

  test("accepts git@ SSH form", () => {
    const result = skillSys.normalizeSourceSpec("git@github.com:org/repo.git", { cwd });
    expect(result).toEqual({ kind: "repo", value: "git@github.com:org/repo.git" });
  });

  test("accepts git@ SSH form with #ref", () => {
    const result = skillSys.normalizeSourceSpec("git@github.com:org/repo.git#v2.0", { cwd });
    expect(result).toEqual({
      kind: "repo",
      value: "git@github.com:org/repo.git",
      ref: "v2.0",
    });
  });

  test("accepts owner/repo shorthand", () => {
    const result = skillSys.normalizeSourceSpec("org/repo", { cwd });
    expect(result).toEqual({ kind: "repo", value: "https://github.com/org/repo.git" });
  });

  test("accepts owner/repo shorthand with #ref", () => {
    const result = skillSys.normalizeSourceSpec("org/repo#main", { cwd });
    expect(result).toEqual({
      kind: "repo",
      value: "https://github.com/org/repo.git",
      ref: "main",
    });
  });
});

describe("GitLab tree source grammar", () => {
  const cwd = repoRoot;

  test("parses a GitLab tree URL with a slash-containing ref deterministically", () => {
    expect(
      skillSys.normalizeSourceSpec(
        "https://gitlab.com/group/repo/-/tree/release/skill/v1/skills/foo",
        { cwd },
      ),
    ).toEqual({
      kind: "repo",
      value: "https://gitlab.com/group/repo.git",
      ref: "release/skill/v1",
      skillPath: "skills/foo",
    });
  });

  test("rejects a GitLab tree URL without a skills delimiter", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://gitlab.com/group/repo/-/tree/main/docs", { cwd }),
    ).toThrow(/GitLab tree source path/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Preserve local path behavior
// ---------------------------------------------------------------------------
describe("local path classification preserved", () => {
  test("existing local directory classified as source, not owner/repo shorthand", () => {
    const root = makeTempRoot("local-path-");
    // Create a directory named "org/repo" locally
    const localDir = path.join(root, "org", "repo");
    fs.mkdirSync(localDir, { recursive: true });

    const result = skillSys.normalizeSourceSpec("org/repo", { cwd: root });
    expect(result.kind).toBe("source");
    expect(result.value).toBe(localDir);
  });
});

// ---------------------------------------------------------------------------
// 6. Ambiguous HTTP URL fragment handling
// ---------------------------------------------------------------------------
describe("HTTP URL fragment ambiguity", () => {
  const cwd = repoRoot;

  test("rejects non-git-ref fragment on HTTPS URL (ambiguous fragment with spaces)", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://github.com/org/repo.git#section anchor", { cwd })
    ).toThrow(/Unsafe git ref|ambiguous/i);
  });

  test("rejects non-git-ref fragment with dangerous chars on HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://github.com/org/repo.git#;rm -rf /", { cwd })
    ).toThrow(/Unsafe git ref|ambiguous/i);
  });

  test("allows valid git ref fragment on HTTPS URL", () => {
    const result = skillSys.normalizeSourceSpec("https://github.com/org/repo.git#v1.0.0", { cwd });
    expect(result.ref).toBe("v1.0.0");
  });
});

// ---------------------------------------------------------------------------
// 7. Remote without ref: allowed by parser
// ---------------------------------------------------------------------------
describe("remote without ref remains allowed by parser", () => {
  const cwd = repoRoot;

  test("accepts HTTPS remote without ref (no #)", () => {
    const result = skillSys.normalizeSourceSpec("https://github.com/org/repo.git", { cwd });
    expect(result.ref).toBeUndefined();
    expect(result.kind).toBe("repo");
  });

  test("accepts SSH remote without ref (no #)", () => {
    const result = skillSys.normalizeSourceSpec("git@github.com:org/repo.git", { cwd });
    expect(result.ref).toBeUndefined();
    expect(result.kind).toBe("repo");
  });
});

// ---------------------------------------------------------------------------
// 8. SSH URL (ssh://) scheme support and credential rejection
// ---------------------------------------------------------------------------
describe("ssh:// URL scheme handling", () => {
  const cwd = repoRoot;

  test("accepts ssh://git@host/org/repo.git", () => {
    const result = skillSys.normalizeSourceSpec("ssh://git@github.com/org/repo.git", { cwd });
    expect(result.kind).toBe("repo");
    expect(result.value).toBe("ssh://git@github.com/org/repo.git");
  });

  test("accepts ssh://git@host/org/repo.git#ref", () => {
    const result = skillSys.normalizeSourceSpec("ssh://git@github.com/org/repo.git#v1.0", { cwd });
    expect(result.kind).toBe("repo");
    expect(result.value).toBe("ssh://git@github.com/org/repo.git");
    expect(result.ref).toBe("v1.0");
  });

  test("accepts ssh:// with non-git username (deploy@host)", () => {
    const result = skillSys.normalizeSourceSpec("ssh://deploy@github.com/org/repo.git", { cwd });
    expect(result.kind).toBe("repo");
    expect(result.value).toBe("ssh://deploy@github.com/org/repo.git");
  });

  test("rejects ssh:// URL with embedded password (credential leakage)", () => {
    const userInfo = ["user", "pass"].join(":");
    expect(() =>
      skillSys.normalizeSourceSpec(`ssh://${userInfo}@github.com/org/repo.git`, { cwd })
    ).toThrow(/credential/i);
  });

  test("rejects ssh:// URL with token-as-password", () => {
    const tokenPassword = ["ghp_", "TOKEN123"].join("");
    expect(() =>
      skillSys.normalizeSourceSpec(`ssh://git:${tokenPassword}@github.com/org/repo.git`, { cwd })
    ).toThrow(/credential/i);
  });
});

// ---------------------------------------------------------------------------
// 9. IPv6 private/sensitive range blocking
// ---------------------------------------------------------------------------
describe("IPv6 private/sensitive range rejection", () => {
  const cwd = repoRoot;

  test("rejects ::1 IPv6 loopback in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://[::1]/org/repo.git", { cwd })
    ).toThrow(/private|loopback/i);
  });

  test("rejects ::ffff:127.0.0.1 IPv4-mapped loopback in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://[::ffff:127.0.0.1]/org/repo.git", { cwd })
    ).toThrow(/private|loopback/i);
  });

  test("rejects ::ffff:10.0.0.1 IPv4-mapped private in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://[::ffff:10.0.0.1]/org/repo.git", { cwd })
    ).toThrow(/private|loopback/i);
  });

  test("rejects ::ffff:172.16.0.1 IPv4-mapped private in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://[::ffff:172.16.0.1]/org/repo.git", { cwd })
    ).toThrow(/private|loopback/i);
  });

  test("rejects ::ffff:192.168.0.1 IPv4-mapped private in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://[::ffff:192.168.0.1]/org/repo.git", { cwd })
    ).toThrow(/private|loopback/i);
  });

  test("rejects ::ffff:169.254.0.1 IPv4-mapped link-local in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://[::ffff:169.254.0.1]/org/repo.git", { cwd })
    ).toThrow(/private|loopback/i);
  });

  test("rejects fc00::/7 ULA address (fc00::1) in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://[fc00::1]/org/repo.git", { cwd })
    ).toThrow(/private|loopback/i);
  });

  test("rejects fd12:3456::/48 ULA address in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://[fd12:3456::1]/org/repo.git", { cwd })
    ).toThrow(/private|loopback/i);
  });

  test("rejects fe80::/10 link-local address in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://[fe80::1]/org/repo.git", { cwd })
    ).toThrow(/private|loopback/i);
  });
});

// ---------------------------------------------------------------------------
// 10. Numeric host encoding bypass rejection
// ---------------------------------------------------------------------------
describe("numeric host encoding bypass rejection", () => {
  const cwd = repoRoot;

  test("rejects hex-encoded IPv4 0x7f000001 in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://0x7f000001/org/repo.git", { cwd })
    ).toThrow(/private|loopback|numeric|host|unsafe/i);
  });

  test("rejects decimal-encoded IPv4 2130706433 in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://2130706433/org/repo.git", { cwd })
    ).toThrow(/private|loopback|numeric|host|unsafe/i);
  });

  test("rejects mixed hex-dotted IPv4 0x7f.0.0.1 in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://0x7f.0.0.1/org/repo.git", { cwd })
    ).toThrow(/private|loopback|numeric|host|unsafe/i);
  });

  test("rejects hex-only host that is not dotted-decimal (0xa1580168)", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://0xa1580168/org/repo.git", { cwd })
    ).toThrow(/numeric|host|unsafe/i);
  });
});

// ---------------------------------------------------------------------------
// 11. SSH scp-like (git@host:path / user@host:path) private/loopback host rejection
// ---------------------------------------------------------------------------
describe("scp-like SSH private/loopback host rejection", () => {
  const cwd = repoRoot;

  test("rejects git@127.0.0.1:org/repo.git (loopback)", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("git@127.0.0.1:org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });

  test("rejects git@10.0.0.1:org/repo.git (private)", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("git@10.0.0.1:org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });

  test("rejects git@192.168.1.1:org/repo.git (private)", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("git@192.168.1.1:org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });

  test("rejects user@localhost:org/repo.git (loopback hostname)", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("user@localhost:org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });

  test("rejects git@[::1]:org/repo.git (IPv6 loopback)", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("git@[::1]:org/repo.git", { cwd })
    ).toThrow(/private|loopback|internal|unsafe|Cannot classify/i);
  });

  test("still accepts git@github.com:org/repo.git", () => {
    const result = skillSys.normalizeSourceSpec("git@github.com:org/repo.git", { cwd });
    expect(result).toEqual({ kind: "repo", value: "git@github.com:org/repo.git" });
  });

  test("still accepts git@github.com:org/repo.git with #ref", () => {
    const result = skillSys.normalizeSourceSpec("git@github.com:org/repo.git#v1.0", { cwd });
    expect(result).toEqual({
      kind: "repo",
      value: "git@github.com:org/repo.git",
      ref: "v1.0",
    });
  });
});

// ---------------------------------------------------------------------------
// 12. Short-form and octal-padded dotted-quad host rejection
// ---------------------------------------------------------------------------
describe("short-form and octal IPv4 host rejection", () => {
  const cwd = repoRoot;

  test("rejects short-form loopback 127.1 in HTTPS URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("https://127.1/org/repo.git", { cwd })
    ).toThrow(/private|loopback|numeric|host|unsafe/i);
  });

  test("rejects short-form loopback in ssh:// URL (opaque host)", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("ssh://git@127.1/org/repo.git", { cwd })
    ).toThrow(/private|loopback|numeric|host|unsafe/i);
  });

  test("rejects short-form loopback in scp-like remote", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("git@127.1:org/repo.git", { cwd })
    ).toThrow(/private|loopback|numeric|host|unsafe/i);
  });

  test("rejects octal-padded loopback 0177.0.0.1 in scp-like remote", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("git@0177.0.0.1:org/repo.git", { cwd })
    ).toThrow(/private|loopback|numeric|host|unsafe/i);
  });

  test("rejects octal-padded private 010.1.2.3 in scp-like remote", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("git@010.1.2.3:org/repo.git", { cwd })
    ).toThrow(/private|loopback|numeric|host|unsafe/i);
  });

  test("rejects trailing leading-zero octet 8.8.8.08 in scp-like remote", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("git@8.8.8.08:org/repo.git", { cwd })
    ).toThrow(/numeric/i);
  });

  test("rejects trailing-dot loopback 127.0.0.1. in ssh:// URL", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("ssh://git@127.0.0.1./org/repo.git", { cwd })
    ).toThrow(/private|loopback|numeric|host|unsafe/i);
  });

  test("rejects trailing-dot loopback in scp-like remote", () => {
    expect(() =>
      skillSys.normalizeSourceSpec("git@127.0.0.1.:org/repo.git", { cwd })
    ).toThrow(/private|loopback|numeric|host|unsafe/i);
  });

  test("still accepts canonical public dotted-decimal hosts", () => {
    expect(
      skillSys.normalizeSourceSpec("https://93.184.216.34/org/repo.git", { cwd }).kind
    ).toBe("repo");
    expect(
      skillSys.normalizeSourceSpec("git@140.82.121.4:org/repo.git", { cwd }).kind
    ).toBe("repo");
  });
});
