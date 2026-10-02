#!/usr/bin/env bun
/**
 * PR13 — plan-only sandbox runtime verification planner.
 *
 * This module is deliberately non-executing. It builds a deterministic
 * description of the sandbox command vector that *would* isolate a skill
 * source, derives the required runtime controls from that vector, and emits a
 * verdict. It never spawns Docker, never runs a child process, never imports or
 * evaluates skill code, and never touches the network.
 *
 * Safety contract:
 * - `--apply`, `--run`, and `--execute` are explicitly unsupported and throw.
 * - One of `--plan` / `--dry-run` is required; bare `verify-sandbox` fails
 *   closed.
 * - The source must be an explicit, existing, non-symlink directory that is not
 *   HOME and not a sensitive/credential path.
 * - Any extra `--mount` source/target that resolves to a denied path fails
 *   closed.
 * - The emitted command vector always carries: network none, read-only root,
 *   cap-drop ALL, no-new-privileges, an explicit read-only source bind, and
 *   tmpfs scratch for workspace/tmp. The verdict re-derives every control from
 *   the emitted vector so the plan is self-verifying.
 *
 * Docker/runtime execution is explicitly future work; this slice is plan-only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERDICT_SCHEMA_VERSION = 1;

export type SandboxRawArgs = Record<string, string | boolean | string[] | undefined>;

export type SandboxMode = "plan" | "dry-run";

export interface SandboxExtraMount {
  source: string;
  target: string;
}

export interface SandboxPlannerInput {
  source: string;
  mode: SandboxMode;
  mounts: SandboxExtraMount[];
}

export type SandboxControlName =
  | "networkNone"
  | "readonlyFilesystem"
  | "noNewPrivileges"
  | "capDropAll"
  | "mountsExplicit"
  | "denySensitivePaths";

export type SandboxControls = Record<SandboxControlName, boolean>;

export type SandboxMount =
  | { kind: "bind"; source: string; target: string; readOnly: boolean }
  | { kind: "tmpfs"; target: string; readOnly: boolean };

export interface SandboxViolation {
  severity: "ERROR" | "WARN";
  code: string;
  message: string;
}

export interface SandboxRuntimeVector {
  command: "docker";
  args: string[];
}

export interface SandboxPlan {
  schemaVersion: number;
  command: "verify-sandbox";
  status: "PLAN" | "BLOCKED";
  mode: SandboxMode;
  source: string;
  applySupported: boolean;
  runtime: SandboxRuntimeVector;
  controls: SandboxControls;
  mounts: SandboxMount[];
  violations: SandboxViolation[];
}

const USAGE =
  "Usage: skill-sys verify-sandbox --source <dir> --plan|--dry-run [--mount src:target] [--json]";

// ---------------------------------------------------------------------------
// Sensitive path classification. Applied to the source root and to every extra
// mount source/target so the sandbox never gains access to HOME, SSH/AWS/cloud
// credential stores, browser auth state, env files, or credential-like files.
// ---------------------------------------------------------------------------

// Path segments that, if present anywhere in a resolved path, mark it denied.
const DENY_PATH_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".mozilla",
  ".config",
  "firefox",
  "google-chrome",
  "chromium",
  "BraveSoftware",
  "Edge",
  "Application Support",
  "AppData",
]);

// Basename patterns that mark an individual file credential-like or env-shaped.
const DENY_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)$/i,
  /^credentials$/i,
  /^.*\.(pem|key|p12|pfx|keystore)$/i,
  /^(?:.*[._-])?token[s]?$/i,
  /^cookies\.sqlite$/i,
  /^login data(\s+for\s+account)?$/i,
  /^key[34]\.db$/i,
  /^logins\.json$/i,
  /^local state$/i,
  /^known_hosts$/i,
  /^authorized_keys$/i,
];

// Container target roots that must never be a mount target.
const DENY_TARGET_SEGMENTS = new Set(["root", "home", "etc", "proc", "sys", "dev", "var"]);

// Docker parses a --mount value as a comma-delimited list of key=value fields.
// Reject delimiters and control characters in every user-derived bind field so
// a path cannot append or corrupt Docker mount options during serialization.
const DOCKER_MOUNT_FIELD_FORBIDDEN = /[,\u0000-\u001F\u007F]/;

function assertSafeDockerMountField(value: string, label: string): void {
  const match = value.match(DOCKER_MOUNT_FIELD_FORBIDDEN);
  if (!match) {
    return;
  }
  const reason = match[0] === "," ? "a comma" : "a control character";
  throw new Error(`Refusing to serialize sandbox ${label} containing ${reason} in Docker --mount.`);
}

/**
 * Classify a resolved host path. Returns a stable machine code when the path is
 * HOME or contains a sensitive segment/basename, otherwise null.
 */
export function classifySensitivePath(absPath: string, home: string): string | null {
  if (absPath === home) {
    return "HOME_ROOT";
  }
  const segments = absPath.split(path.sep).filter(Boolean);
  for (const segment of segments) {
    if (DENY_PATH_SEGMENTS.has(segment)) {
      return `SENSITIVE_PATH_SEGMENT:${segment}`;
    }
  }
  const base = path.basename(absPath);
  for (const pattern of DENY_BASENAME_PATTERNS) {
    if (pattern.test(base)) {
      return `SENSITIVE_PATH_BASENAME:${base}`;
    }
  }
  return null;
}

/**
 * Classify a container target path. Returns a stable machine code when the
 * target escapes the allowed writable/scratch roots into a sensitive area.
 */
function classifySensitiveTarget(target: string): string | null {
  if (!target.startsWith("/")) {
    return "RELATIVE_TARGET";
  }
  if (target === "/") {
    return "ROOT_TARGET";
  }
  const segments = target.split("/").filter(Boolean);
  for (const segment of segments) {
    if (DENY_TARGET_SEGMENTS.has(segment)) {
      return `SENSITIVE_TARGET_SEGMENT:${segment}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Raw arg normalization.
// ---------------------------------------------------------------------------

function stringValue(args: SandboxRawArgs, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === true || value === false) {
    return null;
  }
  if (Array.isArray(value)) {
    const last = value[value.length - 1];
    return typeof last === "string" && last.trim() ? last : null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function boolValue(args: SandboxRawArgs, key: string): boolean {
  return args[key] === true;
}

function collectStringValues(args: SandboxRawArgs, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === true || value === false) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  }
  const text = String(value).trim();
  return text ? [text] : [];
}

function parseMountSpec(raw: string): { source: string; target: string } {
  const trimmed = raw.trim();
  const sep = trimmed.lastIndexOf(":");
  if (sep <= 0 || sep === trimmed.length - 1) {
    throw new Error(`Invalid --mount spec '${raw}'. Expected '<host-source>:<container-target>'.`);
  }
  const source = trimmed.slice(0, sep).trim();
  const target = trimmed.slice(sep + 1).trim();
  if (!source || !target) {
    throw new Error(`Invalid --mount spec '${raw}'. Expected '<host-source>:<container-target>'.`);
  }
  return { source, target };
}

/**
 * Normalize and validate raw CLI args into a planner input. Throws (fails
 * closed) for unsupported execution flags, missing source, missing plan mode,
 * unsafe sources, or unsafe extra mounts. This is the single dispatch-boundary
 * validator shared by the `skill-sys` dispatcher and the standalone command.
 */
export function normalizeSandboxArgs(
  raw: SandboxRawArgs,
  options: { cwd?: string } = {},
): SandboxPlannerInput {
  const cwd = options.cwd || process.cwd();

  if (boolValue(raw, "apply") || boolValue(raw, "run") || boolValue(raw, "execute")) {
    throw new Error(
      "UNSUPPORTED_SANDBOX_EXECUTE: skill-sys verify-sandbox --apply/--run/--execute is not implemented. This command is plan-only; use --plan or --dry-run to preview the sandbox command vector."
    );
  }

  const sourceRaw = stringValue(raw, "source");
  if (!sourceRaw) {
    throw new Error(USAGE);
  }

  const plan = boolValue(raw, "plan");
  const dryRun = boolValue(raw, "dry-run");
  if (!plan && !dryRun) {
    throw new Error(
      "skill-sys verify-sandbox is plan-only: pass --plan or --dry-run. Execution (--apply/--run/--execute) is not supported yet."
    );
  }

  const home = os.homedir();
  const sourceAbs = path.resolve(cwd, sourceRaw);
  assertSafeSandboxSource(sourceAbs, home);
  assertSafeDockerMountField(sourceAbs, "source path");

  const mounts = collectStringValues(raw, "mount").map((spec) => {
    const parsed = parseMountSpec(spec);
    return resolveExtraMount(parsed.source, parsed.target, cwd, home);
  });

  return {
    source: sourceAbs,
    mode: plan ? "plan" : "dry-run",
    mounts,
  };
}

function assertSafeSandboxSource(sourceAbs: string, home: string): void {
  if (!fs.existsSync(sourceAbs)) {
    throw new Error(`Sandbox source not found: ${sourceAbs}`);
  }
  assertNoSymlinkPathComponents(sourceAbs, "source");
  const lstat = fs.lstatSync(sourceAbs);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to sandbox symlinked source: ${sourceAbs}`);
  }
  if (!fs.statSync(sourceAbs).isDirectory()) {
    throw new Error(`Sandbox source is not a directory: ${sourceAbs}`);
  }
  const denied = classifySensitivePath(sourceAbs, home);
  if (denied) {
    throw new Error(`Refusing to sandbox sensitive source path (${denied}): ${sourceAbs}`);
  }
}

function assertNoSymlinkPathComponents(absPath: string, label: string): void {
  const resolved = path.resolve(absPath);
  const { root } = path.parse(resolved);
  const relative = path.relative(root, resolved);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      break;
    }
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing to sandbox ${label} through symlink path component: ${absPath}`);
    }
  }
}

function resolveExtraMount(
  rawSource: string,
  rawTarget: string,
  cwd: string,
  home: string,
): SandboxExtraMount {
  const sourceAbs = path.resolve(cwd, rawSource);
  if (!fs.existsSync(sourceAbs)) {
    throw new Error(`Sandbox mount source not found: ${sourceAbs}`);
  }
  assertNoSymlinkPathComponents(sourceAbs, "mount source");
  if (fs.lstatSync(sourceAbs).isSymbolicLink()) {
    throw new Error(`Refusing to mount symlinked source: ${sourceAbs}`);
  }
  const sourceDenied = classifySensitivePath(sourceAbs, home);
  if (sourceDenied) {
    throw new Error(
      `Refusing to mount sensitive source path (${sourceDenied}): ${sourceAbs}`
    );
  }
  const targetDenied = classifySensitiveTarget(rawTarget);
  if (targetDenied) {
    throw new Error(
      `Refusing to use sensitive container target (${targetDenied}): ${rawTarget}`
    );
  }
  const allowedTarget = ["/skill", "/workspace", "/data"].some(
    (root) => rawTarget === root || rawTarget.startsWith(`${root}/`),
  );
  if (!allowedTarget) {
    throw new Error(
      `Refusing to mount outside the allowed container roots (/skill, /workspace, /data): ${rawTarget}`
    );
  }
  assertSafeDockerMountField(sourceAbs, "mount source path");
  assertSafeDockerMountField(rawTarget, "container target");
  return { source: sourceAbs, target: rawTarget };
}

// ---------------------------------------------------------------------------
// Plan construction. Pure data; no execution primitives.
// ---------------------------------------------------------------------------

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function hasPair(args: string[], flag: string, value: string): boolean {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === flag && args[i + 1] === value) {
      return true;
    }
  }
  return false;
}

function collectBindSources(args: string[]): string[] {
  const sources: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== "--mount") {
      continue;
    }
    const spec = args[i + 1] ?? "";
    const parts = spec.split(",");
    const typePart = parts.find((part) => part.startsWith("type="));
    if (typePart !== "type=bind") {
      continue;
    }
    const sourcePart = parts.find((part) => part.startsWith("source="));
    if (sourcePart) {
      sources.push(sourcePart.slice("source=".length));
    }
  }
  return sources;
}

/**
 * Build a deterministic, read-only sandbox plan from a validated input. The
 * command vector is constructed first, then every required control is derived
 * from that vector so the verdict is self-verifying. Performs zero mutation
 * and zero execution.
 */
export function planSandbox(input: SandboxPlannerInput): SandboxPlan {
  const home = os.homedir();
  const sourceAbs = path.resolve(input.source);
  const extraSources = input.mounts.map((mount) => path.resolve(mount.source));
  const allowedSources = new Set<string>([sourceAbs, ...extraSources]);

  const args: string[] = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    `--mount`,
    `type=bind,source=${sourceAbs},target=/skill,readonly`,
    `--tmpfs`,
    `/workspace:rw`,
    `--tmpfs`,
    `/tmp:rw,noexec,nosuid,nodev`,
  ];

  const mounts: SandboxMount[] = [
    { kind: "bind", source: sourceAbs, target: "/skill", readOnly: true },
    { kind: "tmpfs", target: "/workspace", readOnly: false },
    { kind: "tmpfs", target: "/tmp", readOnly: false },
  ];

  for (const extra of input.mounts) {
    const src = path.resolve(extra.source);
    args.push(`--mount`, `type=bind,source=${src},target=${extra.target},readonly`);
    mounts.push({ kind: "bind", source: src, target: extra.target, readOnly: true });
  }

  args.push("--workdir", "/workspace");
  args.push("skill-sys-sandbox:pending");

  // Re-derive controls from the emitted vector.
  const bindSources = collectBindSources(args);
  const mountsExplicit =
    !hasFlag(args, "--volume") &&
    !hasFlag(args, "-v") &&
    bindSources.every((src) => allowedSources.has(src));

  const allCheckedPaths = [sourceAbs, ...extraSources, ...bindSources];
  const denySensitivePaths = allCheckedPaths.every((candidate) => classifySensitivePath(candidate, home) === null);

  const controls: SandboxControls = {
    networkNone: hasPair(args, "--network", "none"),
    readonlyFilesystem: hasFlag(args, "--read-only"),
    noNewPrivileges: hasPair(args, "--security-opt", "no-new-privileges"),
    capDropAll: hasPair(args, "--cap-drop", "ALL"),
    mountsExplicit,
    denySensitivePaths,
  };

  const violations: SandboxViolation[] = [];
  for (const [name, ok] of Object.entries(controls) as Array<[SandboxControlName, boolean]>) {
    if (!ok) {
      violations.push({
        severity: "ERROR",
        code: `MISSING_CONTROL:${name}`,
        message: `Required sandbox control '${name}' is not present in the planned command vector.`,
      });
    }
  }

  const status: "PLAN" | "BLOCKED" = violations.length === 0 ? "PLAN" : "BLOCKED";

  return {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    command: "verify-sandbox",
    status,
    mode: input.mode,
    source: sourceAbs,
    applySupported: false,
    runtime: { command: "docker", args },
    controls,
    mounts,
    violations,
  };
}

export function renderSandboxVerdict(plan: SandboxPlan, format: "text" | "json"): string {
  if (format === "json") {
    return `${JSON.stringify(plan, null, 2)}\n`;
  }

  const lines: string[] = [];
  lines.push(`STATUS: ${plan.status}`);
  lines.push(`Command: skill-sys verify-sandbox (${plan.mode} mode)`);
  lines.push(`Source: ${plan.source}`);
  lines.push(`Apply supported: ${plan.applySupported ? "yes" : "no"}`);
  lines.push(`Runtime: ${plan.runtime.command} ${plan.runtime.args.join(" ")}`);
  lines.push("Controls:");
  lines.push(`  network none: ${plan.controls.networkNone ? "yes" : "NO"}`);
  lines.push(`  read-only filesystem: ${plan.controls.readonlyFilesystem ? "yes" : "NO"}`);
  lines.push(`  no-new-privileges: ${plan.controls.noNewPrivileges ? "yes" : "NO"}`);
  lines.push(`  cap-drop all: ${plan.controls.capDropAll ? "yes" : "NO"}`);
  lines.push(`  mounts explicit: ${plan.controls.mountsExplicit ? "yes" : "NO"}`);
  lines.push(`  deny sensitive paths: ${plan.controls.denySensitivePaths ? "yes" : "NO"}`);
  lines.push("Mounts:");
  for (const mount of plan.mounts) {
    if (mount.kind === "bind") {
      lines.push(`  - bind ${mount.source} -> ${mount.target} (read-only)`);
    } else {
      lines.push(`  - tmpfs ${mount.target}`);
    }
  }
  lines.push(`Violations: ${plan.violations.length}`);
  for (const violation of plan.violations) {
    lines.push(`  - [${violation.severity} ${violation.code}] ${violation.message}`);
  }
  return `${lines.join("\n")}\n`;
}
