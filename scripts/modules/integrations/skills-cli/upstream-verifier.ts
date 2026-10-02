/**
 * Upstream verifier for foreign-managed skill installs.
 *
 * Given a foreign lock entry that pins a source URL and a ref/commit, this
 * module materializes the upstream tree in a temporary directory, digests the
 * declared skill path, and compares it with the installed-tree digest. The
 * foreign lock is still only a hint — the comparison happens against freshly
 * materialized Git content, never against the lock's own claims.
 *
 * The default materializer shells out to `git clone`/`git checkout` (no
 * shell). Before any clone or filesystem access it applies the canonical
 * remote-source host safety shared with normal ingestion (HTTPS-only,
 * no userinfo, no loopback/private/link-local hosts, no numeric host
 * encodings), the exact public-forge allowlist, and pure-lexical skill-path
 * validation, so malformed input fails closed without touching the host.
 * Clones run in a minimal allowlisted child environment (no proxies, no
 * injected git config, no askpass programs, no forwarded credentials or
 * HOME/XDG config) with HTTP redirects, extra headers, and credential
 * helpers disabled via `-c`; options end with `--`. Temporary clones live
 * under the OS temp dir and are always cleaned up. Skill subtrees are
 * resolved through symlink-free component walks and digested with
 * `digestTreeStrict`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../../../lib/command.ts";
import { digestTreeStrict } from "../../../lib/files.ts";
import { redactRemoteForDiagnostics } from "../../../lib/redact.ts";
import { assertHttpsGitSourceUrl } from "../../../lib/source-host.ts";
import type { AdoptionUpstreamCheck } from "../../application/services/installed-skill-adoption.ts";

export type UpstreamMaterializerInput = Readonly<{
  sourceUrl: string;
  ref?: string;
  commit?: string;
  skillPath?: string;
}>;

export type UpstreamMaterializer = (
  input: UpstreamMaterializerInput,
) => Promise<string>;

/**
 * Error type thrown exclusively by this module's own git materializer after
 * its safety gates. Messages are safe by construction: URLs pass diagnostics
 * redaction, refs/paths are validated first, and child process output is never
 * included. `verifyUpstream` surfaces these messages only when the default
 * materializer ran; injected materializer errors never reach diagnostics.
 */
export class UpstreamMaterializerError extends Error {}

/**
 * Exact public git-forge allowlist for default upstream materialization.
 * Derived from repository evidence: source ingestion supports GitHub and
 * GitLab tree URLs (`parseGithubTreeUrl` / `parseGitlabTreeUrl` in
 * scripts/commands/skill-sys.ts), the skills.sh catalog resolves references
 * canonically to GitHub repositories, and no other forge host appears in any
 * supported source path. Arbitrary public DNS names are deliberately not
 * accepted: a lock-controlled hostname could otherwise resolve to
 * loopback/private/link-local space between validation and clone (DNS-based
 * SSRF). Injected materializers used by tests/offline controlled callers are
 * still gated by `assertHttpsGitSourceUrl`, never by weaker parsing.
 */
export const DEFAULT_UPSTREAM_FORGE_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "gitlab.com",
]);

/**
 * Restrict a canonical https git URL to the exact public forge allowlist.
 * Must run after `assertHttpsGitSourceUrl`; host comparison is exact after
 * lowercasing, so subdomains, lookalikes, and arbitrary DNS names fail closed.
 */
export function assertAllowedUpstreamForgeHost(sourceUrl: string): void {
  let url: URL;
  try {
    url = new URL(sourceUrl.trim());
  } catch {
    throw new UpstreamMaterializerError(
      "upstream source url is not an allowed public forge",
    );
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!DEFAULT_UPSTREAM_FORGE_HOSTS.has(host)) {
    throw new UpstreamMaterializerError(
      `upstream source host '${host}' is not an allowed public forge (${[...DEFAULT_UPSTREAM_FORGE_HOSTS].join(", ")})`,
    );
  }
}

/** Pure-lexical HTTPS/.git gate — canonical ingestion host safety, https-narrowed. */
function assertVerifiableHttpsSource(rawUrl: string): void {
  try {
    assertHttpsGitSourceUrl(rawUrl);
  } catch (error) {
    throw new UpstreamMaterializerError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Normalize and validate an upstream `skillPath` purely lexically, before any
 * clone or host read: non-empty, relative, no drive letters, no backslash
 * separators, and no empty/`.`/`..` segments. Returns the normalized
 * `/`-separated path.
 */
export function normalizeUpstreamSkillPath(raw: string): string {
  const value = raw.trim();
  if (value === "" || value.includes("\0")) {
    throw new UpstreamMaterializerError(
      "upstream skill path must be a non-empty relative path",
    );
  }
  if (/^[A-Za-z]:/.test(value)) {
    throw new UpstreamMaterializerError(
      "upstream skill path must be relative without drive letters",
    );
  }
  if (value.startsWith("/") || value.startsWith("\\")) {
    throw new UpstreamMaterializerError("upstream skill path must be relative");
  }
  if (value.includes("\\")) {
    throw new UpstreamMaterializerError(
      "upstream skill path must use '/' separators",
    );
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new UpstreamMaterializerError(
        `unsafe upstream skill path segment '${segment}'`,
      );
    }
  }
  return segments.join("/");
}

/**
 * Platform null device used to neutralize global git config.
 */
const UPSTREAM_NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * Explicit allowlist of child variables required for executable lookup,
 * system/temp paths, locale, and TLS certificate discovery. Everything else —
 * proxies, git config injection (`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*`),
 * askpass programs, credential helpers/stores, `HOME`/XDG configuration — is
 * deliberately not forwarded.
 */
const UPSTREAM_GIT_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Executable / system
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  // Temp directories
  "TMPDIR",
  "TMP",
  "TEMP",
  // Locale
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // TLS certificate authorities
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
]);

/**
 * Build the minimal allowlisted environment for upstream clone/checkout.
 * Only the explicit allowlist is copied from the host environment; fixed
 * neutralizers below always win over any inherited value. This prevents a
 * hostile parent environment (or lock-influenced tooling) from steering git
 * through proxies, injected config key/values, askpass programs, or extra
 * HTTP headers. The argv `-c` defenses remain independent and are kept.
 */
export function buildUpstreamGitEnv(
  hostEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of UPSTREAM_GIT_ENV_ALLOWLIST) {
    const value = hostEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return Object.assign(env, {
    // No system or global git config files.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: UPSTREAM_NULL_DEVICE,
    GIT_CONFIG_COUNT: "0",
    // No terminal prompts, no interactive credential-manager UI.
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    // Askpass programs fully neutralized; SSH never asks interactively.
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
  });
}

/**
 * Build the hardened `git clone` argv: HTTP redirects disabled, extra HTTP
 * headers cleared, askpass and credential helpers disabled, options terminated
 * with `--` before the untrusted remote and destination operands.
 */
export function buildGitCloneArgv(sourceUrl: string, workDir: string): string[] {
  return [
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
    sourceUrl,
    workDir,
  ];
}

const SAFE_REF_PATTERN = /^[A-Za-z0-9._/@+-]+$/;

/**
 * Resolve `<workDir>/<skillPath>` under the freshly cloned tree. Every path
 * component is walked with `lstat`; any symlinked root or component aborts
 * resolution, and the final realpath must stay inside the workdir's realpath.
 */
export function resolveContainedSkillSubtree(
  workDir: string,
  skillPath: string,
): string {
  const rootReal = fs.realpathSync(workDir);
  let cursor = rootReal;
  for (const segment of skillPath.split("/")) {
    cursor = path.join(cursor, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(cursor);
    } catch {
      throw new UpstreamMaterializerError(
        `upstream skill path '${skillPath}' missing after checkout`,
      );
    }
    if (stats.isSymbolicLink()) {
      throw new UpstreamMaterializerError(
        `upstream skill path '${skillPath}' traverses a symlink`,
      );
    }
  }
  const subtreeReal = fs.realpathSync(cursor);
  // Defense-in-depth: even with a clean lstat walk, refuse any resolution
  // that escapes the cloned tree's own realpath.
  if (subtreeReal !== rootReal && !subtreeReal.startsWith(rootReal + path.sep)) {
    throw new UpstreamMaterializerError(
      `upstream skill path '${skillPath}' escapes the cloned tree`,
    );
  }
  return subtreeReal;
}

/** Default git-based materializer. Returns the strict digest of `<skillPath>`. */
export const gitUpstreamMaterializer: UpstreamMaterializer = async (input) => {
  // Fail closed before any host read or network activity: canonical
  // remote-host safety, exact public-forge allowlist, then pure-lexical
  // skill-path validation.
  assertVerifiableHttpsSource(input.sourceUrl);
  assertAllowedUpstreamForgeHost(input.sourceUrl);
  const skillPath = normalizeUpstreamSkillPath(input.skillPath ?? "");

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-upstream-"));
  try {
    const clone = runCommand(buildGitCloneArgv(input.sourceUrl, workDir), {
      stdout: "pipe",
      stderr: "pipe",
      allowFailure: true,
      env: buildUpstreamGitEnv(),
    });
    if (clone.code !== 0) {
      // Captured clone output is intentionally excluded; only the redacted
      // source URL enters the error.
      throw new UpstreamMaterializerError(
        `git clone failed for '${redactRemoteForDiagnostics(input.sourceUrl)}'`,
      );
    }

    const target = input.commit ?? input.ref ?? "HEAD";
    // Allow safe git-ref characters only ("/" supports namespaced refs);
    // spaces, "$", backticks, "*", "~" and shell metacharacters stay excluded,
    // and option-like targets ("-", "--upload-pack=...") cannot start a ref.
    if (!SAFE_REF_PATTERN.test(target) || target.startsWith("-") || target.startsWith("/")) {
      throw new UpstreamMaterializerError(`unsafe ref '${target}'`);
    }
    const checkout = runCommand(
      ["git", "-C", workDir, "checkout", "--quiet", target],
      {
        stdout: "pipe",
        stderr: "pipe",
        allowFailure: true,
        env: buildUpstreamGitEnv(),
      },
    );
    if (checkout.code !== 0) {
      throw new UpstreamMaterializerError(`git checkout failed for ref '${target}'`);
    }

    return digestTreeStrict(resolveContainedSkillSubtree(workDir, skillPath));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

export type VerifyUpstreamInput = Readonly<{
  name: string;
  sourceUrl?: string;
  ref?: string;
  commit?: string;
  skillPath?: string;
  installedDigest?: string;
}>;

export type VerifyUpstreamDeps = Readonly<{
  materialize?: UpstreamMaterializer;
}>;

/**
 * Returns `null` when the inputs cannot support verification (missing hints
 * or no installed digest to compare) — callers simply skip feeding a check.
 */
export async function verifyUpstream(
  input: VerifyUpstreamInput,
  deps: VerifyUpstreamDeps = {},
): Promise<AdoptionUpstreamCheck | null> {
  if (
    !input.sourceUrl ||
    !input.skillPath ||
    !input.installedDigest ||
    (!input.commit && !input.ref)
  ) {
    return null;
  }

  const materialize = deps.materialize ?? gitUpstreamMaterializer;
  // Canonical https gate runs for EVERY materializer, injected or default:
  // dependency injection must never weaken lock-source URL validation. The
  // exact public-forge allowlist is default-materializer policy only, so
  // offline/controlled callers can target their own hosts through injection.
  try {
    assertHttpsGitSourceUrl(input.sourceUrl);
  } catch {
    return {
      name: input.name,
      status: "SOURCE_MISSING",
      detail: `upstream verification failed during source validation for '${redactRemoteForDiagnostics(input.sourceUrl)}'`,
    };
  }
  try {
    const upstreamDigest = await materialize({
      sourceUrl: input.sourceUrl,
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      ...(input.commit !== undefined ? { commit: input.commit } : {}),
      skillPath: input.skillPath,
    });
    return {
      name: input.name,
      status:
        upstreamDigest === input.installedDigest
          ? "UPSTREAM_MATCH"
          : "UPSTREAM_DRIFT",
      upstreamDigest,
    };
  } catch (error) {
    return {
      name: input.name,
      status: "SOURCE_MISSING",
      detail:
        // Only errors produced by this module's own materializer are governed
        // and safe to surface verbatim. Injected materializers are opaque:
        // their raw error text is never rendered at all — quoted strings,
        // variable assignments, and embedded credentials cannot leak — so the
        // detail degrades to a static stage plus the redacted source.
        deps.materialize === undefined && error instanceof UpstreamMaterializerError
          ? error.message
          : `upstream verification failed during materialization for '${redactRemoteForDiagnostics(input.sourceUrl)}'`,
    };
  }
}
