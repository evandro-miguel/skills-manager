import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export type DevModeStatus = "PASS" | "CONCERNS" | "BLOCKED";
export type DevModeFindingLevel = "WARN" | "ERROR";

export type DevModeFinding = {
  level: DevModeFindingLevel;
  code: string;
  message: string;
  path?: string;
  skill?: string;
};

export type DevModePlannedLink = {
  skill: string;
  source: string;
  target: string;
  action: "would-link";
};

export type DevModeResult = {
  schemaVersion: 1;
  command: "dev-mode";
  status: DevModeStatus;
  source: string;
  config: string;
  strict: boolean;
  devName: string;
  plan: {
    installMode: "symlink";
    devOnly: boolean;
    publicRelease: boolean;
    links: DevModePlannedLink[];
  };
  findings: DevModeFinding[];
};

export type DevModeInput = {
  source: string;
  config: string;
  strict: boolean;
};

export type DevModeArgs = {
  source?: string;
  config?: string;
  strict?: boolean;
};

export type DevModeExecutionStatus = "PLANNED" | "APPLIED" | "UNCHANGED" | "BLOCKED";

export type DevModeExecutionResult = {
  schemaVersion: 1;
  command: "dev-mode";
  operation: "local-apply";
  status: DevModeExecutionStatus;
  applied: boolean;
  cleaned: number;
  source: string;
  config: string;
  findings: DevModeFinding[];
};

export type DevModeExecutionOptions = {
  /** Explicit opt-in; omitting it leaves the validated plan untouched. */
  apply?: boolean;
  /** Remove only stale links proven by an adapter-owned receipt. */
  cleanup?: boolean;
};

type JsonObject = Record<string, unknown>;
type LinkEntry = { skill: string; target: string };

const SAFE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TARGET_PREFIXES = [".agents/skills/", ".skill-sys/dev-links/"];
const RECEIPT_PREFIX = ".skill-sys/dev-links/.receipts";
const MAX_RECEIPT_BYTES = 4096;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}

function addFinding(findings: DevModeFinding[], finding: DevModeFinding): void {
  findings.push(finding);
}

function assertExistingDirectory(dir: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`${label} does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${dir}`);
}

function assertExistingFile(file: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`${label} does not exist: ${file}`);
  }
  if (!stat.isFile()) throw new Error(`${label} must be a file: ${file}`);
}

export function normalizeDevModeArgs(args: DevModeArgs): DevModeInput {
  if (!args.source) throw new Error("Missing --source");
  if (!args.config) throw new Error("Missing --config");
  const source = path.resolve(args.source);
  const config = path.resolve(args.config);
  assertExistingDirectory(source, "--source");
  assertExistingFile(config, "--config");
  if (fs.lstatSync(config).isSymbolicLink()) throw new Error("--config must not be a symlink");
  return { source, config, strict: args.strict === true };
}

function parseConfig(input: DevModeInput, findings: DevModeFinding[]): JsonObject | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(input.config, "utf8")) as unknown;
    if (!isObject(parsed)) {
      addFinding(findings, { level: "ERROR", code: "DEV_MODE_CONFIG_INVALID_SHAPE", path: toRelative(input.source, input.config), message: "Dev mode config must be a JSON object" });
      return null;
    }
    return parsed;
  } catch (error) {
    addFinding(findings, { level: "ERROR", code: "DEV_MODE_CONFIG_INVALID_JSON", path: toRelative(input.source, input.config), message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function isSafeTarget(target: string): boolean {
  if (!target || path.isAbsolute(target)) return false;
  const normalized = path.posix.normalize(target.split("\\").join("/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("~/") || normalized === "~") return false;
  return TARGET_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function skillPath(source: string, skill: string): string {
  return path.join(source, "skills", skill, "SKILL.md");
}

function skillExists(source: string, skill: string): boolean {
  try {
    const file = skillPath(source, skill);
    return fs.statSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function hasSymlinkInExistingPath(root: string, target: string, includeTarget = true): boolean {
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter(Boolean);
  const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  let current = root;
  for (const part of parts.slice(0, limit)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) return false;
    if (fs.lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function executionFinding(code: string, message: string, extra: Pick<DevModeFinding, "path" | "skill"> = {}): DevModeFinding {
  return { level: "ERROR", code, message, ...extra };
}

function receiptPath(source: string, targetRelative: string): string {
  const digest = crypto.createHash("sha256").update(targetRelative).digest("hex");
  return path.join(source, RECEIPT_PREFIX, `${digest}.json`);
}

type DevModeReceipt = { schemaVersion: 1; target: string; source: string };

function readReceipt(file: string): DevModeReceipt | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES || fs.lstatSync(file).isSymbolicLink()) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isObject(parsed) || parsed.schemaVersion !== 1 || typeof parsed.target !== "string" || typeof parsed.source !== "string") return null;
    return { schemaVersion: 1, target: parsed.target, source: parsed.source };
  } catch {
    return null;
  }
}

function pointsTo(linkPath: string, expectedSource: string): boolean {
  try {
    return fs.realpathSync(linkPath) === fs.realpathSync(expectedSource);
  } catch {
    return false;
  }
}

function parseLinks(doc: JsonObject, input: DevModeInput, findings: DevModeFinding[]): LinkEntry[] {
  const configPath = toRelative(input.source, input.config);
  if (!Array.isArray(doc.links) || doc.links.length === 0) {
    addFinding(findings, { level: "WARN", code: "DEV_MODE_LINKS_EMPTY", path: configPath, message: "dev mode config should declare at least one link" });
    return [];
  }

  const links: LinkEntry[] = [];
  const seen = new Set<string>();
  for (const entry of doc.links) {
    if (!isObject(entry)) {
      addFinding(findings, { level: "ERROR", code: "DEV_MODE_LINK_INVALID_SHAPE", path: configPath, message: "links entries must be objects" });
      continue;
    }
    const skill = typeof entry.skill === "string" ? entry.skill.trim() : "";
    const target = typeof entry.target === "string" ? entry.target.trim() : "";
    if (!SAFE_NAME_PATTERN.test(skill)) {
      addFinding(findings, { level: "ERROR", code: "DEV_MODE_SKILL_INVALID", path: configPath, skill, message: "link.skill must be a safe skill name" });
    } else if (!skillExists(input.source, skill)) {
      addFinding(findings, { level: "ERROR", code: "DEV_MODE_SKILL_MISSING", path: configPath, skill, message: `Missing skill: ${skill}` });
    }
    if (!isSafeTarget(target)) {
      addFinding(findings, { level: "ERROR", code: "DEV_MODE_LINK_TARGET_UNSAFE", path: configPath, skill, message: "link.target must stay under .agents/skills/ or .skill-sys/dev-links/" });
    }
    const key = `${skill}\0${target}`;
    if (seen.has(key)) {
      addFinding(findings, { level: "ERROR", code: "DEV_MODE_LINK_DUPLICATE", path: configPath, skill, message: `Duplicate link for ${skill}` });
    }
    seen.add(key);
    links.push({ skill, target: path.posix.normalize(target.split("\\").join("/")) });
  }
  return links;
}

function sortFindings(findings: DevModeFinding[]): DevModeFinding[] {
  return [...findings].sort((a, b) =>
    [a.level, a.code, a.skill ?? "", a.path ?? "", a.message].join("\0").localeCompare(
      [b.level, b.code, b.skill ?? "", b.path ?? "", b.message].join("\0"),
    ),
  );
}

export function runDevModePlan(input: DevModeInput): DevModeResult {
  const findings: DevModeFinding[] = [];
  const configPath = toRelative(input.source, input.config);
  const doc = parseConfig(input, findings);

  let devName = "";
  let devOnly = false;
  let publicRelease = false;
  let links: LinkEntry[] = [];

  if (doc) {
    if (doc.schemaVersion !== 1) addFinding(findings, { level: "ERROR", code: "DEV_MODE_SCHEMA_VERSION_UNSUPPORTED", path: configPath, message: "schemaVersion must be 1" });
    devName = typeof doc.name === "string" ? doc.name.trim() : "";
    if (!SAFE_NAME_PATTERN.test(devName)) addFinding(findings, { level: "ERROR", code: "DEV_MODE_NAME_INVALID", path: configPath, message: "name must be a safe identifier" });

    devOnly = doc.devOnly === true;
    publicRelease = doc.publicRelease === true;
    if (!devOnly || publicRelease) addFinding(findings, { level: "ERROR", code: "DEV_MODE_PUBLIC_RELEASE_FORBIDDEN", path: configPath, message: "dev-mode symlink plans require devOnly=true and publicRelease=false" });

    if (doc.installMode !== "symlink") addFinding(findings, { level: "ERROR", code: "DEV_MODE_INSTALL_MODE_INVALID", path: configPath, message: "dev mode currently supports installMode=symlink only" });
    if (doc.allowSymlinks !== true) addFinding(findings, { level: "ERROR", code: "DEV_MODE_SYMLINKS_NOT_ALLOWED", path: configPath, message: "allowSymlinks must be true for explicit local dev plans" });
    if (doc.skills !== undefined || doc.catalog !== undefined || doc.skillCatalog !== undefined) {
      addFinding(findings, { level: "ERROR", code: "DEV_MODE_CATALOG_EMBEDDED", path: configPath, message: "dev mode stores link plans, not embedded catalogs" });
    }
    links = parseLinks(doc, input, findings);
  }

  const sortedFindings = sortFindings(findings);
  const hasError = sortedFindings.some((finding) => finding.level === "ERROR");
  const hasWarning = sortedFindings.some((finding) => finding.level === "WARN");
  const status: DevModeStatus = hasError || (input.strict && hasWarning) ? "BLOCKED" : hasWarning ? "CONCERNS" : "PASS";

  return {
    schemaVersion: 1,
    command: "dev-mode",
    status,
    source: input.source,
    config: input.config,
    strict: input.strict,
    devName,
    plan: {
      installMode: "symlink",
      devOnly,
      publicRelease,
      links: links.map((link) => ({
        skill: link.skill,
        source: `skills/${link.skill}/SKILL.md`,
        target: link.target,
        action: "would-link",
      })),
    },
    findings: sortedFindings,
  };
}

/**
 * Materialize the already validated plan only when an in-process caller opts
 * in. This is deliberately not CLI-wired: it has no provider, network,
 * package-manager, global-path, or recursive-delete capability.
 */
export function applyDevModeLocal(
  input: DevModeInput,
  options: DevModeExecutionOptions = {},
): DevModeExecutionResult {
  const validation = runDevModePlan(input);
  const blocked = (findings: DevModeFinding[]): DevModeExecutionResult => ({
    schemaVersion: 1,
    command: "dev-mode",
    operation: "local-apply",
    status: "BLOCKED",
    applied: false,
    cleaned: 0,
    source: input.source,
    config: input.config,
    findings: sortFindings(findings),
  });

  if (validation.status !== "PASS") return blocked(validation.findings);
  if (process.platform === "win32") return blocked([executionFinding("DEV_MODE_PLATFORM_UNSUPPORTED", "local symlink application is unsupported on this platform")]);
  if (!isInside(input.source, input.config) || hasSymlinkInExistingPath(input.source, input.config)) {
    return blocked([executionFinding("DEV_MODE_CONFIG_PATH_UNSAFE", "config must stay inside the project root without symlinks")]);
  }

  const requested = new Set(validation.plan.links.map((link) => link.target));
  const prepared = validation.plan.links.map((link) => {
    const targetPath = path.resolve(input.source, link.target);
    const sourcePath = path.join(input.source, "skills", link.skill);
    return { ...link, targetPath, sourcePath, receiptPath: receiptPath(input.source, link.target) };
  });

  for (const link of prepared) {
    if (!isInside(input.source, link.targetPath) || !isSafeTarget(link.target) || hasSymlinkInExistingPath(input.source, link.targetPath, false)) {
      return blocked([executionFinding("DEV_MODE_TARGET_PATH_UNSAFE", "target must stay under a local approved prefix without symlinked parents", { path: link.target, skill: link.skill })]);
    }
    try {
      if (!fs.statSync(link.sourcePath).isDirectory() || fs.lstatSync(link.sourcePath).isSymbolicLink() || !skillExists(input.source, link.skill)) throw new Error();
    } catch {
      return blocked([executionFinding("DEV_MODE_SOURCE_PATH_UNSAFE", "skill source must be an existing regular project directory", { skill: link.skill })]);
    }
    if (fs.existsSync(link.targetPath)) {
      if (!fs.lstatSync(link.targetPath).isSymbolicLink()) {
        return blocked([executionFinding("DEV_MODE_TARGET_CONFLICT", "target already exists and is not a symlink", { path: link.target, skill: link.skill })]);
      }
      const receipt = readReceipt(link.receiptPath);
      if (!receipt || receipt.target !== link.target || receipt.source !== `skills/${link.skill}` || !pointsTo(link.targetPath, link.sourcePath)) {
        return blocked([executionFinding("DEV_MODE_LINK_UNOWNED", "existing symlink is not proven to be owned by this adapter", { path: link.target, skill: link.skill })]);
      }
    } else if (fs.existsSync(link.receiptPath)) {
      return blocked([executionFinding("DEV_MODE_RECEIPT_STALE", "receipt exists without its owned symlink", { path: link.target, skill: link.skill })]);
    }
  }

  const receiptDir = path.join(input.source, RECEIPT_PREFIX);
  const stale: Array<{ target: string; source: string; targetPath: string; receiptPath: string }> = [];
  if (options.cleanup && fs.existsSync(receiptDir)) {
    if (!fs.statSync(receiptDir).isDirectory() || fs.lstatSync(receiptDir).isSymbolicLink() || hasSymlinkInExistingPath(input.source, receiptDir)) {
      return blocked([executionFinding("DEV_MODE_RECEIPT_PATH_UNSAFE", "receipt directory must be a regular project-local directory")]);
    }
    for (const name of fs.readdirSync(receiptDir).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) return blocked([executionFinding("DEV_MODE_RECEIPT_INVALID", "receipt directory contains an invalid entry")]);
      const file = path.join(receiptDir, name);
      const receipt = readReceipt(file);
      if (!receipt || !isSafeTarget(receipt.target) || receiptPath(input.source, receipt.target) !== file || !/^skills\/[a-z0-9][a-z0-9._-]{0,127}$/.test(receipt.source)) {
        return blocked([executionFinding("DEV_MODE_RECEIPT_INVALID", "receipt is invalid or outside the local boundary")]);
      }
      if (requested.has(receipt.target)) continue;
      const targetPath = path.resolve(input.source, receipt.target);
      const sourcePath = path.resolve(input.source, receipt.source);
      if (!isInside(input.source, targetPath) || !isInside(input.source, sourcePath) || hasSymlinkInExistingPath(input.source, targetPath, false) || !fs.existsSync(targetPath) || !fs.lstatSync(targetPath).isSymbolicLink() || !pointsTo(targetPath, sourcePath)) {
        return blocked([executionFinding("DEV_MODE_STALE_LINK_UNOWNED", "stale symlink is not proven to be owned by this adapter", { path: receipt.target })]);
      }
      stale.push({ target: receipt.target, source: receipt.source, targetPath, receiptPath: file });
    }
  }

  if (!options.apply) {
    return { ...blocked([]), status: "PLANNED", findings: [] };
  }

  let changed = false;
  const created: Array<{ targetPath: string; receiptPath: string }> = [];
  try {
    for (const link of prepared) {
      if (fs.existsSync(link.targetPath)) continue;
      fs.mkdirSync(path.dirname(link.targetPath), { recursive: true });
      if (hasSymlinkInExistingPath(input.source, link.targetPath, false)) throw new Error("unsafe target parent");
      fs.symlinkSync(path.relative(path.dirname(link.targetPath), link.sourcePath), link.targetPath, "dir");
      created.push({ targetPath: link.targetPath, receiptPath: link.receiptPath });
      fs.mkdirSync(receiptDir, { recursive: true });
      fs.writeFileSync(link.receiptPath, `${JSON.stringify({ schemaVersion: 1, target: link.target, source: `skills/${link.skill}` })}\n`, { encoding: "utf8", flag: "wx" });
      changed = true;
    }
    for (const link of stale) {
      fs.unlinkSync(link.targetPath);
      fs.unlinkSync(link.receiptPath);
      changed = true;
    }
  } catch {
    for (const link of created.reverse()) {
      try { if (fs.existsSync(link.receiptPath) && fs.lstatSync(link.receiptPath).isFile()) fs.unlinkSync(link.receiptPath); } catch { /* retain concurrent or non-owned paths */ }
      try { if (fs.existsSync(link.targetPath) && fs.lstatSync(link.targetPath).isSymbolicLink()) fs.unlinkSync(link.targetPath); } catch { /* retain concurrent or non-owned paths */ }
    }
    return blocked([executionFinding("DEV_MODE_LOCAL_APPLY_FAILED", "local apply failed before completing the requested changes")]);
  }

  return { ...blocked([]), status: changed ? "APPLIED" : "UNCHANGED", applied: changed, cleaned: stale.length, findings: [] };
}

export function renderDevModeResult(result: DevModeResult, format: "text" | "json" = "text"): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  const lines = [
    `STATUS: ${result.status}`,
    `Dev mode: ${result.devName || "<invalid>"}`,
    `Source: ${result.source}`,
    `Config: ${result.config}`,
    `Install mode: ${result.plan.installMode}`,
    `Dev only: ${result.plan.devOnly}`,
    `Public release: ${result.plan.publicRelease}`,
    `Links: ${result.plan.links.length}`,
    `Findings: ${result.findings.length}`,
  ];
  for (const link of result.plan.links) lines.push(`- link skill=${link.skill} source=${link.source} target=${link.target} action=${link.action}`);
  for (const finding of result.findings) lines.push(`- [${finding.level} ${finding.code}] ${finding.message}`);
  return lines.join("\n");
}
