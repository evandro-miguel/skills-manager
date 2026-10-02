import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { digestTreeStrict } from "../scripts/lib/files.ts";
import {
  assertAllowedUpstreamForgeHost,
  buildGitCloneArgv,
  buildUpstreamGitEnv,
  DEFAULT_UPSTREAM_FORGE_HOSTS,
  gitUpstreamMaterializer,
  normalizeUpstreamSkillPath,
  resolveContainedSkillSubtree,
  verifyUpstream,
} from "../scripts/modules/integrations/skills-cli/upstream-verifier.ts";

const baseInput = {
  name: "alpha",
  sourceUrl: "https://github.com/o/r.git",
  ref: "v1",
  skillPath: "skills/alpha",
  installedDigest: "digest-1",
};

const USERINFO_TOKEN = "UPSTREAM-USERINFO-TOKEN-CANARY";
const DETAIL_TOKEN = "UPSTREAM-DETAIL-TOKEN-CANARY";

async function rejectionOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected promise to reject");
}

function rejectionOfSync(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected function to throw");
}

describe("verifyUpstream", () => {
  /** Build an input omitting one optional hint (exactOptionalPropertyTypes-safe). */
  function inputWithout(key: "sourceUrl" | "skillPath" | "installedDigest"): {
    name: string;
    sourceUrl?: string;
    ref?: string;
    skillPath?: string;
    installedDigest?: string;
  } {
    return {
      name: baseInput.name,
      ...(key === "sourceUrl" && baseInput.sourceUrl !== undefined
        ? { sourceUrl: baseInput.sourceUrl }
        : {}),
      ...(baseInput.ref !== undefined ? { ref: baseInput.ref } : {}),
      ...(key === "skillPath" && baseInput.skillPath !== undefined
        ? { skillPath: baseInput.skillPath }
        : {}),
      ...(key === "installedDigest" && baseInput.installedDigest !== undefined
        ? { installedDigest: baseInput.installedDigest }
        : {}),
    };
  }

  test("returns null when required hints are missing", async () => {
    let calls = 0;
    const materialize = async () => {
      calls += 1;
      return "x";
    };
    expect(await verifyUpstream(inputWithout("sourceUrl"), { materialize })).toBeNull();
    expect(await verifyUpstream(inputWithout("skillPath"), { materialize })).toBeNull();
    expect(
      await verifyUpstream(inputWithout("installedDigest"), { materialize }),
    ).toBeNull();
    expect(
      await verifyUpstream(
        { name: "alpha", sourceUrl: baseInput.sourceUrl, skillPath: "s", installedDigest: "d" },
        { materialize },
      ),
    ).toBeNull(); // neither commit nor ref provided
    expect(calls).toBe(0);
  });

  test("reports UPSTREAM_MATCH on digest equality", async () => {
    const check = await verifyUpstream(baseInput, {
      materialize: async () => "digest-1",
    });
    expect(check?.status).toBe("UPSTREAM_MATCH");
    expect(check?.upstreamDigest).toBe("digest-1");
  });

  test("reports UPSTREAM_DRIFT on mismatch", async () => {
    const check = await verifyUpstream(baseInput, {
      materialize: async () => "other",
    });
    expect(check?.status).toBe("UPSTREAM_DRIFT");
  });

  test("injected materializer failures map to SOURCE_MISSING with static detail only", async () => {
    const check = await verifyUpstream(baseInput, {
      materialize: async () => {
        throw new Error("clone boom");
      },
    });
    expect(check?.status).toBe("SOURCE_MISSING");
    // Static stage + redacted source; raw injected error text is never surfaced.
    expect(check?.detail).toBe(
      `upstream verification failed during materialization for '${baseInput.sourceUrl}'`,
    );
    expect(check?.detail).not.toContain("clone boom");
  });

  test("prefers pinned commits over mutable refs", async () => {
    const seen: Array<{ ref?: string; commit?: string }> = [];
    await verifyUpstream({ ...baseInput, ref: "main", commit: "abc123" }, {
      materialize: async (input) => {
        seen.push({
          ...(input.ref !== undefined ? { ref: input.ref } : {}),
          ...(input.commit !== undefined ? { commit: input.commit } : {}),
        });
        return "digest-1";
      },
    });
    expect(seen[0]?.commit).toBe("abc123");
  });
});

describe("upstream source-url host safety (pre-clone, canonical)", () => {
  test("clone argv disables redirects, extra headers, askpass, and credential helpers; -- ends options", () => {
    expect(buildGitCloneArgv("https://github.com/o/r.git", "/tmp/work")).toEqual([
      "git",
      "clone",
      "--quiet",
      "--no-checkout",
      "-c",
      "http.followRedirects=false",
      "-c",
      "http.extraHeader=",
      "-c",
      "core.askPass=",
      "-c",
      "credential.helper=",
      "--",
      "https://github.com/o/r.git",
      "/tmp/work",
    ]);
  });

  test("upstream git env is a minimal allowlist; hostile variables never leak through", () => {
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    const fixtureHome = ["", "home", "example-user"].join("/");
    const seeded: Record<string, string | undefined> = {
      // Required-basis variables that must survive.
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      SSL_CERT_DIR: "/etc/ssl/certs",
      // Hostile parent environment.
      GIT_ASKPASS: "/tmp/evil/askpass.sh",
      SSH_ASKPASS: "/tmp/evil/ssh-askpass.sh",
      SSH_ASKPASS_REQUIRE: "prefer",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "http.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic UPSTREAM-CONFIG-CANARY",
      GIT_CONFIG_GLOBAL: "/tmp/evil/global-config",
      HTTPS_PROXY: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "socks5://127.0.0.1:9",
      NO_PROXY: "",
      HTTP_EXTRAHEADER: "X-Canary: injected-header-env",
      GIT_HTTP_EXTRAHEADER: "X-Canary: injected-header-env",
      GIT_TERMINAL_PROMPT: "1",
      GCM_INTERACTIVE: "Always",
      CREDENTIAL_HELPER: "cache --timeout 9999",
      HOME: fixtureHome,
      XDG_CONFIG_HOME: `${fixtureHome}/.config`,
    };
    const env = buildUpstreamGitEnv(seeded);
    expect(env).toEqual({
      // Only the explicit allowlist is forwarded.
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      SSL_CERT_DIR: "/etc/ssl/certs",
      // Fixed neutralizers always win over inherited values.
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_CONFIG_COUNT: "0",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
    });
    // Belt-and-braces absence checks for the highest-value channels.
    // (GIT_ASKPASS/SSH_ASKPASS are present but neutralized to "", asserted above.)
    for (const key of [
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "ALL_PROXY",
      "HTTP_EXTRAHEADER",
      "GIT_HTTP_EXTRAHEADER",
      "CREDENTIAL_HELPER",
      "HOME",
      "XDG_CONFIG_HOME",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  test("buildUpstreamGitEnv() defaults to the live process allowlist plus neutralizers", () => {
    const env = buildUpstreamGitEnv({ PATH: "/usr/bin" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_COUNT).toBe("0");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("Never");
    expect(env.GIT_ASKPASS).toBe("");
    expect(env.SSH_ASKPASS).toBe("");
    expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
  });

  test("default materialization is restricted to the exact public forge allowlist", () => {
    expect([...DEFAULT_UPSTREAM_FORGE_HOSTS].sort()).toEqual(["github.com", "gitlab.com"]);
    for (const host of DEFAULT_UPSTREAM_FORGE_HOSTS) {
      expect(() =>
        assertAllowedUpstreamForgeHost(`https://${host}/o/r.git`),
      ).not.toThrow();
    }
    // Host comparison is exact after lowercasing: subdomains and lookalikes fail.
    // (Scheme violations like ftp:// are the canonical gate's job, tested above.)
    for (const url of [
      "https://example.invalid/o/r.git",
      "https://raw.githubusercontent.com/o/r.git/HEAD/x",
      "https://github.com.evil.test/o/r.git",
      "https://gitlab.com.evil.test/o/r.git",
      "",
    ]) {
      const message = rejectionOfSync(() => assertAllowedUpstreamForgeHost(url));
      expect(message).toMatch(/not an allowed public forge/);
    }
  });

  test("default materializer rejects arbitrary public DNS hosts before any clone", async () => {
    const message = await rejectionOf(() =>
      gitUpstreamMaterializer({
        sourceUrl: "https://example.invalid/o/r.git",
        skillPath: "skills/alpha",
      }),
    );
    expect(message).toMatch(/not an allowed public forge \(github\.com, gitlab\.com\)/);
    // Rejected before mkdtemp: no clone workspace was ever created.
  });

  test("rejects loopback, private, link-local, and encoded hosts before any clone", async () => {
    const blockedSources = [
      "https://localhost/o/r.git",
      "https://LOCALHOST/o/r.git",
      "https://127.0.0.1/o/r.git",
      "https://127.254.1.2/o/r.git",
      "https://10.1.2.3/o/r.git",
      "https://172.16.0.9/o/r.git",
      "https://172.31.255.255/o/r.git",
      "https://192.168.1.1/o/r.git",
      "https://169.254.1.1/o/r.git",
      "https://[::1]/o/r.git",
      "https://[::ffff:127.0.0.1]/o/r.git",
      "https://[fc00::1]/o/r.git",
      "https://[fe80::1]/o/r.git",
      // numeric / non-canonical encodings
      "https://0x7f000001/o/r.git",
      "https://2130706433/o/r.git",
      "https://0x7f.0.0.1/o/r.git",
      "https://127.1/o/r.git",
      "https://0177.0.0.1/o/r.git",
      // userinfo credential channels
      `https://deploy:${USERINFO_TOKEN}@example.invalid/o/r.git`,
      `https://%64eploy:${USERINFO_TOKEN}@example.invalid/o/r.git`,
      // non-HTTPS schemes and non-URL sources
      "http://example.invalid/o/r.git",
      "ssh://git@example.invalid/o/r.git",
      "git@example.invalid:o/r.git",
      "file:///tmp/repo.git",
      "/etc/passwd",
      "./local/dir",
      "~/skills",
    ];

    for (const sourceUrl of blockedSources) {
      const message = await rejectionOf(() =>
        gitUpstreamMaterializer({ sourceUrl, skillPath: "skills/x" }),
      );
      // The failure wording must originate from the validation gate, never
      // from a clone attempt ("git clone failed for '...'").
      expect(message).toMatch(
        /loopback\/private hosts|numeric host encodings|userinfo credentials|only https git|invalid source url|home expansion/,
      );
      expect(message).not.toMatch(/^git clone failed for/);
      expect(message).not.toContain(USERINFO_TOKEN);
    }
  });

  test("rejected sources create no temporary clone directory", async () => {
    const tmp = os.tmpdir();
    const countCloneDirs = (): number =>
      fs.readdirSync(tmp).filter((entry) => entry.startsWith("skill-upstream-")).length;

    const before = countCloneDirs();
    await rejectionOf(() =>
      gitUpstreamMaterializer({ sourceUrl: "https://localhost/o/r.git", skillPath: "skills/x" }),
    );
    await rejectionOf(() =>
      gitUpstreamMaterializer({
        sourceUrl: `https://u:${USERINFO_TOKEN}@h/x.git`,
        skillPath: "skills/x",
      }),
    );
    await rejectionOf(() =>
      gitUpstreamMaterializer({ sourceUrl: "https://2130706433/o/r.git", skillPath: "skills/x" }),
    );
    // Allowlist rejections are also pre-clone.
    await rejectionOf(() =>
      gitUpstreamMaterializer({
        sourceUrl: "https://example.invalid/o/r.git",
        skillPath: "skills/x",
      }),
    );
    expect(countCloneDirs()).toBe(before);
  });

  test("rejects https userinfo before cloning and never echoes the credential", async () => {
    const sourceUrl = `https://deploy:${USERINFO_TOKEN}@example.invalid/o/r.git`;
    const message = await rejectionOf(() => gitUpstreamMaterializer({ sourceUrl }));
    expect(message).toMatch(/userinfo/);
    expect(message).toContain("[REDACTED]@example.invalid");
    expect(message).not.toContain(USERINFO_TOKEN);

    const encodedMessage = await rejectionOf(() =>
      gitUpstreamMaterializer({
        sourceUrl: `https://%64eploy:${USERINFO_TOKEN}@example.invalid/o/r.git`,
      }),
    );
    expect(encodedMessage).toMatch(/userinfo/);
    expect(encodedMessage).not.toContain(USERINFO_TOKEN);
  });

  test("verifyUpstream pre-gates userinfo before any materializer runs, redacting credentials", async () => {
    const check = await verifyUpstream({
      ...baseInput,
      sourceUrl: `https://deploy:${USERINFO_TOKEN}@example.invalid/o/r.git`,
    });
    expect(check?.status).toBe("SOURCE_MISSING");
    // Static validation-stage detail; the whole credential is redacted away.
    expect(check?.detail).toBe(
      `upstream verification failed during source validation for 'https://[REDACTED]@example.invalid/o/r.git'`,
    );
    expect(check?.detail).not.toContain(USERINFO_TOKEN);
  });
});

describe("injected error diagnostics lockdown", () => {
  test("quoted and assignment-embedded URLs cannot leak through details", async () => {
    const payloads = [
      `clone failed for https://u:${DETAIL_TOKEN}@h/x.git`,
      `URL="https://user:${DETAIL_TOKEN}@host/path"`,
      `$cred='https://u:${DETAIL_TOKEN}@h/p'; git clone $cred`,
      `remote.origin.url=https://user:${DETAIL_TOKEN}@h/x.git`,
    ];
    for (const payload of payloads) {
      const check = await verifyUpstream(baseInput, {
        materialize: async () => {
          throw new Error(payload);
        },
      });
      expect(check?.status).toBe("SOURCE_MISSING");
      expect(check?.detail).toBe(
        `upstream verification failed during materialization for '${baseInput.sourceUrl}'`,
      );
      expect(check?.detail).not.toContain(DETAIL_TOKEN);
      expect(check?.detail).not.toContain("[REDACTED]");
    }
  });

  test("non-Error thrown values also degrade to the static detail", async () => {
    const check = await verifyUpstream(baseInput, {
      materialize: async () => {
        throw `raw ${DETAIL_TOKEN}`;
      },
    });
    expect(check?.status).toBe("SOURCE_MISSING");
    expect(check?.detail).not.toContain(DETAIL_TOKEN);
    expect(check?.detail).toContain("materialization");
  });

  test("injected materializers cannot weaken URL validation", async () => {
    let calls = 0;
    const spyMaterialize = async (): Promise<string> => {
      calls += 1;
      return baseInput.installedDigest;
    };
    // Canonical gate precedes any injected invocation; details carry only the
    // redacted source through a static validation-stage message.
    for (const [sourceUrl, redacted] of [
      ["ssh://git@github.com/o/r.git", "ssh://[REDACTED]@github.com/o/r.git"],
      ["http://github.com/o/r.git", "http://github.com/o/r.git"],
      ["https://github.com/o/r", "https://github.com/o/r"],
      ["/etc/passwd", "/etc/passwd"],
    ] as const) {
      const check = await verifyUpstream(
        { ...baseInput, sourceUrl },
        { materialize: spyMaterialize },
      );
      expect(check?.status).toBe("SOURCE_MISSING");
      expect(check?.detail).toBe(
        `upstream verification failed during source validation for '${redacted}'`,
      );
    }
    expect(calls).toBe(0);
  });

  test("default-materializer allowlist rejections surface as governed SOURCE_MISSING details", async () => {
    const check = await verifyUpstream({
      ...baseInput,
      sourceUrl: "https://example.invalid/o/r.git",
    });
    expect(check?.status).toBe("SOURCE_MISSING");
    expect(check?.detail).toMatch(/not an allowed public forge \(github\.com, gitlab\.com\)/);
  });
});

describe("upstream skillPath sandbox", () => {
  test("accepts plain relative paths", () => {
    expect(normalizeUpstreamSkillPath("skills/alpha")).toBe("skills/alpha");
    expect(normalizeUpstreamSkillPath(" skills/alpha ")).toBe("skills/alpha");
    expect(normalizeUpstreamSkillPath("docs/.github-kit")).toBe("docs/.github-kit");
  });

  test("rejects absolute paths, drive letters, traversal, and separator tricks lexically", () => {
    const rejected = [
      "",
      "   ",
      "/etc/passwd",
      "\\windows\\path",
      "\\\\server\\share\\x",
      "C:\\evil",
      "c:/evil",
      "C:relative",
      "..",
      "../outside",
      "skills/../..",
      "skills/../../etc",
      "a/./b",
      "./skills",
      "skills/",
      "skills//alpha",
      "with\\backslash",
      "bad\0nul",
    ];
    for (const candidate of rejected) {
      const message = rejectionOfSync(() => normalizeUpstreamSkillPath(candidate));
      expect(message).toMatch(/relative|unsafe upstream skill path|separators/);
    }
  });

  test("malformed skill paths fail closed before any host read or clone", async () => {
    const tmp = os.tmpdir();
    const countCloneDirs = (): number =>
      fs.readdirSync(tmp).filter((entry) => entry.startsWith("skill-upstream-")).length;

    const before = countCloneDirs();
    for (const skillPath of ["../escape", "/abs", ".", "a/../b"]) {
      const message = await rejectionOf(() =>
        gitUpstreamMaterializer({ sourceUrl: baseInput.sourceUrl, skillPath }),
      );
      expect(message).toMatch(/relative|unsafe upstream skill path/);
      expect(message).not.toMatch(/^git clone failed for/);
    }
    expect(countCloneDirs()).toBe(before);
  });

  test("symlinked components cannot hash outside sentinel content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-sandbox-"));
    try {
      const workDir = path.join(root, "work");
      const outside = path.join(root, "outside");
      const good = path.join(workDir, "skills", "good");
      fs.mkdirSync(good, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(good, "SKILL.md"), "good");
      fs.writeFileSync(path.join(outside, "SENTINEL.txt"), "SENTINEL-CONTENT-CANARY");

      // Symlinked component pointing at the sentinel tree.
      fs.symlinkSync(outside, path.join(workDir, "skills", "link-out"));
      // Symlinked component escaping the whole workdir.
      fs.symlinkSync(root, path.join(workDir, "root-link"));

      const goodReal = resolveContainedSkillSubtree(workDir, "skills/good");
      expect(goodReal.startsWith(fs.realpathSync(workDir))).toBe(true);
      const goodDigest = digestTreeStrict(goodReal);

      const escapeOne = rejectionOfSync(() =>
        resolveContainedSkillSubtree(workDir, "skills/link-out"),
      );
      expect(escapeOne).toMatch(/traverses a symlink/);

      const escapeTwo = rejectionOfSync(() =>
        resolveContainedSkillSubtree(workDir, "root-link/outside"),
      );
      expect(escapeTwo).toMatch(/traverses a symlink/);

      const missing = rejectionOfSync(() =>
        resolveContainedSkillSubtree(workDir, "skills/nope"),
      );
      expect(missing).toMatch(/missing after checkout/);

      // The good subtree digest covers only its own files — the sentinel
      // content is unreachable through any resolved path above.
      expect(goodDigest).not.toBe(digestTreeStrict(outside));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("valid https + relative path happy path", () => {
  test("valid inputs pass lexical validation without network", () => {
    expect(normalizeUpstreamSkillPath(baseInput.skillPath)).toBe("skills/alpha");
  });

  test("valid HTTPS + relative skillPath still verifies end to end", async () => {
    const check = await verifyUpstream(baseInput, {
      materialize: async (input) => {
        expect(input.sourceUrl).toBe(baseInput.sourceUrl);
        expect(input.skillPath).toBe("skills/alpha");
        expect(input.ref).toBe("v1");
        return "digest-1";
      },
    });
    expect(check?.status).toBe("UPSTREAM_MATCH");
    expect(check?.upstreamDigest).toBe("digest-1");
  });
});
