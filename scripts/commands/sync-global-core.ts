#!/usr/bin/env bun
/**
 * Sync the declared global core skills into user-global agent folders.
 */

import fs from "node:fs";
import path from "node:path";
import { parseCsv, requireOptionValue } from "../lib/args.ts";
import { runCommand } from "../lib/command.ts";
import {
  digestTreeStrict,
  ensureDir,
  fileExists,
  readJson,
  writeFileAtomicSafe,
} from "../lib/files.ts";
import { isSkillDir } from "../lib/skill-dirs.ts";
import {
  DEFAULT_GLOBAL_CORE_MANIFEST,
  listGlobalCoreApps,
  readGlobalCoreManifest,
  resolveGlobalCoreApp,
  resolveGlobalCoreSkills,
} from "../modules/global-core.ts";

export interface SyncGlobalCoreArgs {
  source: string;
  manifest: string;
  apps: string[];
  noContractCheck: boolean;
  deleteExtra: boolean;
  deleteSkills: string[];
  dryRun: boolean;
  help: boolean;
}

export interface SyncGlobalCoreDeps {
  run?: (args: string[]) => void;
  resolveGlobalCoreApp?: typeof resolveGlobalCoreApp;
  allowedTargetRoots?: string[];
  writeCoreOwnership?: (targetDir: string, appName: string, skills: ManagedSkill[]) => void;
  cleanupQuarantine?: (quarantinePath: string) => void;
  writeCleanupReceipt?: (targetDir: string, receipt: GlobalCoreCleanupReceipt, replace?: boolean) => void;
  clearCleanupReceipt?: (targetDir: string) => void;
  renameQuarantine?: (skillPath: string, quarantinePath: string) => void;
}

export type ManagedSkill = {
  name: string;
  digest: string;
};

type GlobalCoreOwnership = {
  version: 2;
  owner: typeof GLOBAL_CORE_OWNER;
  app: string;
  skills: ManagedSkill[];
};

type TargetedRemovalPlan = {
  ownership: GlobalCoreOwnership;
  planned: ManagedSkill[];
  originalLedger: string;
};

type QuarantinedSkill = {
  skill: ManagedSkill;
  skillPath: string;
  quarantinePath: string;
};

type CleanupReceiptEntry = {
  name: string;
  digest: string;
  quarantineName: string;
};

type CleanupReceiptState = "prepared" | "ledger-committed";

export type GlobalCoreCleanupReceipt = {
  version: 1;
  owner: typeof GLOBAL_CORE_OWNER;
  app: string;
  target: string;
  state: CleanupReceiptState;
  originalLedger: string;
  originalSkills: ManagedSkill[];
  remainingSkills: ManagedSkill[];
  entries: CleanupReceiptEntry[];
};

const TOOL_ROOT = path.resolve(__dirname, "../..");
const CONTRACT = path.join(__dirname, "universal-contract.ts");
const SYNC_SKILLS = path.join(__dirname, "sync-skills.ts");
const GLOBAL_CORE_OWNERSHIP_FILE = ".global-core-managed.json";
const GLOBAL_CORE_CLEANUP_RECEIPT_FILE = ".global-core-cleanup.json";
const GLOBAL_CORE_OWNER = "skill-sys-global-core" as const;
const GLOBAL_CORE_QUARANTINE_PREFIX = ".global-core-delete-";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function help(): void {
  console.log(`
Sync the declared global core skill set

Usage:
  bun scripts/commands/sync-global-core.ts [options]

Options:
  --source <dir>        universal-skills root (default: script parent)
  --manifest <file>     Global core manifest (default: globals/core.json)
  --apps <csv>          Restrict sync to these apps (default: manifest defaultApps)
  --delete-extra        Remove destination skills not declared in global core
  --delete-skill <csv>  Remove named, unchanged skills absent from the manifest
  --no-contract-check   Skip source contract validation
  --dry-run             Print actions without writing files
  --help                Show help

Examples:
  bun scripts/commands/sync-global-core.ts
  bun scripts/commands/sync-global-core.ts --apps codex,opencode
  bun scripts/commands/sync-global-core.ts --source /path/to/universal-skills --apps qwen,gemini-cli
`);
}

function parseArgs(argv: string[]): SyncGlobalCoreArgs {
  const args: SyncGlobalCoreArgs = {
    source: TOOL_ROOT,
    manifest: DEFAULT_GLOBAL_CORE_MANIFEST,
    apps: [],
    noContractCheck: false,
    deleteExtra: false,
    deleteSkills: [],
    dryRun: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--no-contract-check") {
      args.noContractCheck = true;
      continue;
    }
    if (token === "--delete-extra") {
      args.deleteExtra = true;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = requireOptionValue(argv, i, token);
      if (key === "source") {
        args.source = path.resolve(process.cwd(), value);
      } else if (key === "manifest") {
        args.manifest = path.resolve(process.cwd(), value);
      } else if (key === "apps") {
        args.apps = parseCsv(value);
      } else if (key === "delete-skill") {
        const names = parseCsv(value);
        if (!names.length) {
          throw new Error("--delete-skill requires at least one skill name");
        }
        args.deleteSkills.push(...names);
      } else {
        throw new Error(`Unknown option: ${token}`);
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.deleteSkills = [...new Set(args.deleteSkills)];
  if (args.deleteExtra && args.deleteSkills.length) {
    throw new Error("--delete-extra and --delete-skill are mutually exclusive");
  }

  return args;
}

function run(args: string[]): void {
  runCommand(args);
}

function assertNoSymlinkParents(targetDir: string): void {
  const root = path.parse(targetDir).root;
  let current = path.resolve(path.dirname(targetDir));

  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Target parent must not be a symlink: ${current}`);
    }
    if (current === root) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

function ensureRealTargetDir(targetDir: string, dryRun: boolean): void {
  assertNoSymlinkParents(targetDir);
  if (fs.existsSync(targetDir) && fs.lstatSync(targetDir).isSymbolicLink()) {
    console.log(`replace-root-symlink: ${targetDir}`);
    if (!dryRun) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  }

  if (!dryRun) {
    ensureDir(targetDir);
  }
}

function isSafeSkillName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function isManagedSkill(value: unknown): value is ManagedSkill {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isSafeSkillName(record.name) &&
    typeof record.digest === "string" &&
    SHA256_PATTERN.test(record.digest);
}

function normalizeManagedSkills(skills: ManagedSkill[]): ManagedSkill[] {
  const byName = new Map<string, ManagedSkill>();
  for (const skill of skills) {
    byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function ownershipPath(targetDir: string): string {
  return path.join(targetDir, GLOBAL_CORE_OWNERSHIP_FILE);
}

function cleanupReceiptPath(targetDir: string): string {
  return path.join(targetDir, GLOBAL_CORE_CLEANUP_RECEIPT_FILE);
}

function pathPresent(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseCoreOwnership(raw: unknown, appName: string, filePath: string): GlobalCoreOwnership {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid global core ownership ledger: ${filePath}`);
  }
  const record = raw as Record<string, unknown>;
  const skills = Array.isArray(record.skills) ? record.skills : [];
  const names = skills.filter(isManagedSkill).map((skill) => skill.name);
  if (
    record.version !== 2 ||
    record.owner !== GLOBAL_CORE_OWNER ||
    record.app !== appName ||
    !Array.isArray(record.skills) ||
    !record.skills.every(isManagedSkill) ||
    new Set(names).size !== names.length
  ) {
    throw new Error(`Invalid global core ownership ledger: ${filePath}`);
  }
  return {
    version: 2,
    owner: GLOBAL_CORE_OWNER,
    app: appName,
    skills: normalizeManagedSkills(record.skills),
  };
}

function readCoreOwnership(targetDir: string, appName: string): GlobalCoreOwnership | null {
  if (!fileExists(targetDir)) {
    return null;
  }
  const targetStat = fs.lstatSync(targetDir);
  if (targetStat.isSymbolicLink()) {
    return null;
  }
  if (!targetStat.isDirectory()) {
    throw new Error(`Global core target must be a directory: ${targetDir}`);
  }

  const filePath = ownershipPath(targetDir);
  if (!fileExists(filePath)) {
    return null;
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    throw new Error(`Global core ownership ledger must be a regular unlinked file: ${filePath}`);
  }

  return parseCoreOwnership(readJson<unknown>(filePath), appName, filePath);
}

function writeCoreOwnership(targetDir: string, appName: string, skills: ManagedSkill[]): void {
  const payload: GlobalCoreOwnership = {
    version: 2,
    owner: GLOBAL_CORE_OWNER,
    app: appName,
    skills: normalizeManagedSkills(skills),
  };
  writeFileAtomicSafe(ownershipPath(targetDir), `${JSON.stringify(payload, null, 2)}\n`);
}

function managedSkillsEqual(left: ManagedSkill[], right: ManagedSkill[]): boolean {
  const normalizedLeft = normalizeManagedSkills(left);
  const normalizedRight = normalizeManagedSkills(right);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((skill, index) => {
    const other = normalizedRight[index];
    return other?.name === skill.name && other.digest === skill.digest;
  });
}

function isCleanupReceiptEntry(value: unknown): value is CleanupReceiptEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const quarantineName = record.quarantineName;
  return Object.keys(record).every((key) => key === "name" || key === "digest" || key === "quarantineName") &&
    isManagedSkill(record) &&
    typeof quarantineName === "string" &&
    isSafeSkillName(quarantineName);
}

function readCleanupReceipt(targetDir: string, appName: string): GlobalCoreCleanupReceipt | null {
  if (!fileExists(targetDir)) {
    return null;
  }
  assertNoSymlinkParents(targetDir);
  const targetStat = fs.lstatSync(targetDir);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`Global core target must be a real directory: ${targetDir}`);
  }

  const filePath = cleanupReceiptPath(targetDir);
  if (!pathPresent(filePath)) {
    return null;
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    throw new Error(`Global core cleanup receipt must be a regular unlinked file: ${filePath}`);
  }

  const raw = readJson<unknown>(filePath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid global core cleanup receipt: ${filePath}`);
  }
  const record = raw as Record<string, unknown>;
  const allowedKeys = new Set([
    "version", "owner", "app", "target", "state", "originalLedger", "originalSkills",
    "remainingSkills", "entries",
  ]);
  const entries = Array.isArray(record.entries) ? record.entries : [];
  const originalSkills = Array.isArray(record.originalSkills) ? record.originalSkills : [];
  const remainingSkills = Array.isArray(record.remainingSkills) ? record.remainingSkills : [];
  const parsedEntries = entries.filter(isCleanupReceiptEntry);
  const names = parsedEntries.map(({ name }) => name);
  const quarantineNames = parsedEntries.map(({ quarantineName }) => quarantineName);
  if (
    record.version !== 1 ||
    record.owner !== GLOBAL_CORE_OWNER ||
    record.app !== appName ||
    record.target !== path.resolve(targetDir) ||
    (record.state !== "prepared" && record.state !== "ledger-committed") ||
    typeof record.originalLedger !== "string" ||
    !Array.isArray(record.originalSkills) ||
    !originalSkills.every(isManagedSkill) ||
    !Array.isArray(record.entries) ||
    parsedEntries.length !== record.entries.length ||
    !parsedEntries.length ||
    new Set(names).size !== names.length ||
    new Set(quarantineNames).size !== quarantineNames.length ||
    !Array.isArray(record.remainingSkills) ||
    !remainingSkills.every(isManagedSkill) ||
    Object.keys(record).some((key) => !allowedKeys.has(key))
  ) {
    throw new Error(`Invalid global core cleanup receipt: ${filePath}`);
  }
  const original = originalSkills as ManagedSkill[];
  const remaining = remainingSkills as ManagedSkill[];
  const remainingNames = new Set(remaining.map(({ name }) => name));
  if (
    new Set(original.map(({ name }) => name)).size !== original.length ||
    remainingNames.size !== remaining.length ||
    parsedEntries.some(({ name }) => remainingNames.has(name))
  ) {
    throw new Error(`Invalid global core cleanup receipt: ${filePath}`);
  }

  let originalOwnership: GlobalCoreOwnership;
  try {
    originalOwnership = parseCoreOwnership(
      JSON.parse(record.originalLedger as string),
      appName,
      `${filePath} originalLedger`,
    );
  } catch {
    throw new Error(`Invalid global core cleanup receipt: ${filePath}`);
  }
  const originalByName = new Map(original.map((skill) => [skill.name, skill]));
  const entryNames = new Set(parsedEntries.map(({ name }) => name));
  if (
    !managedSkillsEqual(originalOwnership.skills, original) ||
    parsedEntries.some((entry) => originalByName.get(entry.name)?.digest !== entry.digest) ||
    remaining.some((skill) => originalByName.get(skill.name)?.digest !== skill.digest) ||
    original.length !== remaining.length + parsedEntries.length ||
    [...originalByName.keys()].some((name) => !remainingNames.has(name) && !entryNames.has(name)) ||
    [...remainingNames].some((name) => !originalByName.has(name))
  ) {
    throw new Error(`Invalid global core cleanup receipt: ${filePath}`);
  }

  const target = path.resolve(targetDir);
  for (const entry of parsedEntries) {
    const expectedPrefix = `${GLOBAL_CORE_QUARANTINE_PREFIX}${entry.name}-`;
    const quarantinePath = path.resolve(target, entry.quarantineName);
    if (
      !entry.quarantineName.startsWith(expectedPrefix) ||
      path.dirname(quarantinePath) !== target
    ) {
      throw new Error(`Invalid global core cleanup receipt: ${filePath}`);
    }
  }

  return {
    version: 1,
    owner: GLOBAL_CORE_OWNER,
    app: appName,
    target,
    state: record.state as CleanupReceiptState,
    originalLedger: record.originalLedger as string,
    originalSkills: normalizeManagedSkills(original),
    remainingSkills: normalizeManagedSkills(remaining),
    entries: parsedEntries,
  };
}

function writeCleanupReceipt(
  targetDir: string,
  receipt: GlobalCoreCleanupReceipt,
  replace = false,
): void {
  const filePath = cleanupReceiptPath(targetDir);
  if (pathPresent(filePath) && !replace) {
    throw new Error(`Refusing to overwrite existing global core cleanup receipt: ${filePath}`);
  }
  if (pathPresent(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
      throw new Error(`Global core cleanup receipt must be a regular unlinked file: ${filePath}`);
    }
    if (replace) {
      const existing = readCleanupReceipt(targetDir, receipt.app);
      if (
        !existing ||
        existing.state !== "prepared" ||
        existing.originalLedger !== receipt.originalLedger ||
        !managedSkillsEqual(existing.originalSkills, receipt.originalSkills) ||
        !managedSkillsEqual(existing.remainingSkills, receipt.remainingSkills) ||
        JSON.stringify(existing.entries) !== JSON.stringify(receipt.entries)
      ) {
        throw new Error(`Refusing to advance an unexpected global core cleanup receipt: ${filePath}`);
      }
    }
  }
  writeFileAtomicSafe(filePath, `${JSON.stringify(receipt, null, 2)}\n`);
}

function createCleanupReceipt(
  targetDir: string,
  appName: string,
  originalSkills: ManagedSkill[],
  originalLedger: string,
  remainingSkills: ManagedSkill[],
  quarantined: QuarantinedSkill[],
): GlobalCoreCleanupReceipt {
  return {
    version: 1,
    owner: GLOBAL_CORE_OWNER,
    app: appName,
    target: path.resolve(targetDir),
    state: "prepared",
    originalLedger,
    originalSkills: normalizeManagedSkills(originalSkills),
    remainingSkills: normalizeManagedSkills(remainingSkills),
    entries: quarantined.map(({ skill, quarantinePath }) => ({
      name: skill.name,
      digest: skill.digest,
      quarantineName: path.basename(quarantinePath),
    })),
  };
}

function clearCleanupReceipt(targetDir: string): void {
  const filePath = cleanupReceiptPath(targetDir);
  if (!pathPresent(filePath)) {
    return;
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    throw new Error(`Global core cleanup receipt must be a regular unlinked file: ${filePath}`);
  }
  fs.rmSync(filePath, { force: true });
  if (pathPresent(filePath)) {
    throw new Error(`Cleanup left receipt residue: ${filePath}`);
  }
}

function managedSkillDigest(targetDir: string, skillName: string): string {
  if (!isSafeSkillName(skillName) || !isSkillDir(targetDir, skillName)) {
    throw new Error(`Managed entry is not a real skill directory: ${path.join(targetDir, skillName)}`);
  }
  return digestTreeStrict(path.join(targetDir, skillName));
}

function validateTargetedDeletions(
  targetDir: string,
  appName: string,
  skillNames: string[],
): TargetedRemovalPlan {
  const ownership = readCoreOwnership(targetDir, appName);
  if (!ownership) {
    throw new Error(`Cannot delete targeted skills without core ownership ledger: ${ownershipPath(targetDir)}`);
  }
  const managedByName = new Map(ownership.skills.map((skill) => [skill.name, skill]));
  const planned: ManagedSkill[] = [];
  for (const skillName of skillNames) {
    const managed = managedByName.get(skillName);
    if (!managed) {
      throw new Error(`Cannot delete unowned global core skill '${skillName}' in ${targetDir}`);
    }
    const actualDigest = managedSkillDigest(targetDir, skillName);
    if (actualDigest !== managed.digest) {
      throw new Error(
        `Refusing to remove changed managed skill '${skillName}': digest differs from ownership ledger`
      );
    }
    planned.push(managed);
  }
  return {
    ownership,
    planned,
    originalLedger: fs.readFileSync(ownershipPath(targetDir), "utf8"),
  };
}

function cleanupQuarantine(quarantinePath: string): void {
  fs.rmSync(quarantinePath, { recursive: true, force: true });
}

function planQuarantine(targetDir: string, skill: ManagedSkill): QuarantinedSkill {
  const skillPath = path.join(targetDir, skill.name);
  const actualDigest = managedSkillDigest(targetDir, skill.name);
  if (actualDigest !== skill.digest) {
    throw new Error(
      `Refusing to remove changed managed skill '${skill.name}': digest differs from ownership ledger`
    );
  }

  const quarantinePath = path.join(
    targetDir,
    `${GLOBAL_CORE_QUARANTINE_PREFIX}${skill.name}-${process.pid}-${crypto.randomUUID()}`
  );
  if (pathPresent(quarantinePath)) {
    throw new Error(`Refusing to overwrite existing global core quarantine: ${quarantinePath}`);
  }

  return { skill, skillPath, quarantinePath };
}

function quarantineManagedSkill(
  item: QuarantinedSkill,
  rename: (skillPath: string, quarantinePath: string) => void,
): void {
  try {
    rename(item.skillPath, item.quarantinePath);
    const quarantineStat = fs.lstatSync(item.quarantinePath);
    if (quarantineStat.isSymbolicLink() || !quarantineStat.isDirectory()) {
      throw new Error(`Global core quarantine must be a real directory: ${item.quarantinePath}`);
    }
    if (digestTreeStrict(item.quarantinePath) !== item.skill.digest) {
      throw new Error(
        `Refusing to remove changed managed skill '${item.skill.name}': digest changed during removal`
      );
    }
  } catch (error) {
    if (pathPresent(item.quarantinePath) && !pathPresent(item.skillPath)) {
      fs.renameSync(item.quarantinePath, item.skillPath);
    }
    throw error;
  }
}

function planQuarantines(targetDir: string, skills: ManagedSkill[]): QuarantinedSkill[] {
  const planned = skills.map((skill) => planQuarantine(targetDir, skill));
  const paths = new Set(planned.map(({ quarantinePath }) => quarantinePath));
  if (paths.size !== planned.length) {
    throw new Error(`Refusing duplicate global core quarantine path in ${targetDir}`);
  }
  return planned;
}

function restoreQuarantinedSkills(quarantined: QuarantinedSkill[]): void {
  for (const item of [...quarantined].reverse()) {
    if (!pathPresent(item.quarantinePath)) {
      if (pathPresent(item.skillPath)) {
        continue;
      }
      throw new Error(`Global core quarantine is missing: ${item.quarantinePath}`);
    }
    if (pathPresent(item.skillPath)) {
      throw new Error(`Refusing to restore over existing skill path: ${item.skillPath}`);
    }
    const quarantineStat = fs.lstatSync(item.quarantinePath);
    if (quarantineStat.isSymbolicLink() || !quarantineStat.isDirectory()) {
      throw new Error(`Global core quarantine must be a real directory: ${item.quarantinePath}`);
    }
    if (digestTreeStrict(item.quarantinePath) !== item.skill.digest) {
      throw new Error(`Refusing to restore changed global core quarantine: ${item.quarantinePath}`);
    }
    fs.renameSync(item.quarantinePath, item.skillPath);
  }
}

function validateRemainingLedger(targetDir: string, receipt: GlobalCoreCleanupReceipt): void {
  assertNoSymlinkParents(targetDir);
  const ownership = readCoreOwnership(targetDir, receipt.app);
  if (!ownership || !managedSkillsEqual(ownership.skills, receipt.remainingSkills)) {
    throw new Error(
      `Refusing pending global core cleanup because the ownership ledger is stale: ${ownershipPath(targetDir)}`
    );
  }
  validateSkillDigests(targetDir, receipt.remainingSkills, "pending global core cleanup");
}

function validateSkillDigests(targetDir: string, skills: ManagedSkill[], label: string): void {
  for (const skill of skills) {
    if (!isSkillDir(targetDir, skill.name) || managedSkillDigest(targetDir, skill.name) !== skill.digest) {
      throw new Error(
        `Refusing ${label} because the managed skill is stale: ${path.join(targetDir, skill.name)}`
      );
    }
  }
}

function validateQuarantine(targetDir: string, entry: CleanupReceiptEntry): QuarantinedSkill {
  const skillPath = path.join(targetDir, entry.name);
  const quarantinePath = path.resolve(targetDir, entry.quarantineName);
  if (pathPresent(skillPath)) {
    throw new Error(`Refusing pending cleanup over an existing skill path: ${skillPath}`);
  }
  if (!pathPresent(quarantinePath)) {
    throw new Error(`Recorded global core quarantine is missing: ${quarantinePath}`);
  }
  const quarantineStat = fs.lstatSync(quarantinePath);
  if (quarantineStat.isSymbolicLink() || !quarantineStat.isDirectory()) {
    throw new Error(`Global core quarantine must be a real directory: ${quarantinePath}`);
  }
  if (digestTreeStrict(quarantinePath) !== entry.digest) {
    throw new Error(`Refusing pending cleanup of changed global core quarantine: ${quarantinePath}`);
  }
  return {
    skill: { name: entry.name, digest: entry.digest },
    skillPath,
    quarantinePath,
  };
}

function validatePreparedRecovery(
  targetDir: string,
  receipt: GlobalCoreCleanupReceipt,
): QuarantinedSkill[] {
  validateSkillDigests(targetDir, receipt.remainingSkills, "prepared global core cleanup");
  const quarantined: QuarantinedSkill[] = [];
  for (const entry of receipt.entries) {
    const skillPath = path.join(targetDir, entry.name);
    const quarantinePath = path.resolve(targetDir, entry.quarantineName);
    const hasSkill = pathPresent(skillPath);
    const hasQuarantine = pathPresent(quarantinePath);
    if (hasSkill && hasQuarantine) {
      throw new Error(`Refusing prepared cleanup with both skill and quarantine present: ${entry.name}`);
    }
    if (!hasSkill && !hasQuarantine) {
      throw new Error(`Prepared global core quarantine and skill are both missing: ${entry.name}`);
    }
    if (hasSkill) {
      if (!isSkillDir(targetDir, entry.name) || managedSkillDigest(targetDir, entry.name) !== entry.digest) {
        throw new Error(`Refusing prepared cleanup with changed restored skill: ${skillPath}`);
      }
      continue;
    }
    quarantined.push(validateQuarantine(targetDir, entry));
  }
  return quarantined;
}

function validateCommittedRecovery(
  targetDir: string,
  receipt: GlobalCoreCleanupReceipt,
): QuarantinedSkill[] {
  validateRemainingLedger(targetDir, receipt);
  const quarantined: QuarantinedSkill[] = [];
  for (const entry of receipt.entries) {
    const skillPath = path.join(targetDir, entry.name);
    const quarantinePath = path.resolve(targetDir, entry.quarantineName);
    if (!pathPresent(quarantinePath)) {
      if (pathPresent(skillPath)) {
        throw new Error(`Refusing committed cleanup with reappeared skill: ${skillPath}`);
      }
      continue;
    }
    quarantined.push(validateQuarantine(targetDir, entry));
  }
  return quarantined;
}

function receiptPhase(targetDir: string, receipt: GlobalCoreCleanupReceipt): CleanupReceiptState {
  const ledgerPath = ownershipPath(targetDir);
  if (!pathPresent(ledgerPath)) {
    throw new Error(`Pending global core cleanup ledger is missing: ${ledgerPath}`);
  }
  const currentLedger = fs.readFileSync(ledgerPath, "utf8");
  const currentOwnership = readCoreOwnership(targetDir, receipt.app);
  if (
    receipt.state === "prepared" &&
    currentLedger === receipt.originalLedger &&
    currentOwnership &&
    managedSkillsEqual(currentOwnership.skills, receipt.originalSkills)
  ) {
    return "prepared";
  }
  if (currentOwnership && managedSkillsEqual(currentOwnership.skills, receipt.remainingSkills)) {
    return "ledger-committed";
  }
  throw new Error(`Refusing pending global core cleanup because the ownership ledger is stale: ${ledgerPath}`);
}

function recoverPendingCleanup(
  targetDir: string,
  receipt: GlobalCoreCleanupReceipt,
  cleanup: (quarantinePath: string) => void,
  clearReceipt: (targetDir: string) => void,
): void {
  const phase = receiptPhase(targetDir, receipt);
  if (phase === "prepared") {
    const quarantined = validatePreparedRecovery(targetDir, receipt);
    try {
      restoreQuarantinedSkills(quarantined);
      for (const entry of receipt.entries) {
        if (!isSkillDir(targetDir, entry.name) || managedSkillDigest(targetDir, entry.name) !== entry.digest) {
          throw new Error(`Prepared recovery did not restore the original skill: ${path.join(targetDir, entry.name)}`);
        }
      }
    } catch (error) {
      throw new Error(
        `Pending prepared global core cleanup recovery failed (${error instanceof Error ? error.message : String(error)}); receipt retained: ${cleanupReceiptPath(targetDir)}`
      );
    }
    try {
      clearReceipt(targetDir);
    } catch (error) {
      throw new Error(
        `Pending prepared global core cleanup restored skills but could not clear its receipt (${error instanceof Error ? error.message : String(error)}); receipt retained: ${cleanupReceiptPath(targetDir)}`
      );
    }
    return;
  }

  const quarantined = validateCommittedRecovery(targetDir, receipt);
  for (const item of quarantined) {
    try {
      cleanup(item.quarantinePath);
      if (pathPresent(item.quarantinePath)) {
        throw new Error(`Cleanup left quarantine residue: ${item.quarantinePath}`);
      }
    } catch (error) {
      throw new Error(
        `Pending global core cleanup failed (${error instanceof Error ? error.message : String(error)}); receipt retained: ${cleanupReceiptPath(targetDir)}`
      );
    }
  }
  try {
    clearReceipt(targetDir);
  } catch (error) {
    throw new Error(
      `Pending global core cleanup removed quarantine but could not clear its receipt (${error instanceof Error ? error.message : String(error)}); receipt retained: ${cleanupReceiptPath(targetDir)}`
    );
  }
}

function restoreOriginalLedger(targetDir: string, originalLedger: string): void {
  writeFileAtomicSafe(ownershipPath(targetDir), originalLedger);
}

function rollbackTargetedRemoval(
  targetDir: string,
  quarantined: QuarantinedSkill[],
  originalLedger: string,
  cause: unknown,
  clearReceipt: (targetDir: string) => void,
): never {
  const rollbackErrors: string[] = [];
  try {
    restoreQuarantinedSkills(quarantined);
  } catch (error) {
    rollbackErrors.push(`skill restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    restoreOriginalLedger(targetDir, originalLedger);
  } catch (error) {
    rollbackErrors.push(`ledger restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    clearReceipt(targetDir);
  } catch (error) {
    rollbackErrors.push(`cleanup receipt clear failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const message = cause instanceof Error ? cause.message : String(cause);
  if (rollbackErrors.length) {
    throw new Error(
      `Targeted global core removal ledger write failed (${message}); compensation failed: ${rollbackErrors.join("; ")}; recoverable quarantine residue may remain`
    );
  }
  throw new Error(`Targeted global core removal ledger write failed (${message}); original ledger and skills restored`);
}

function removeManagedSkillsTransaction(
  targetDir: string,
  appName: string,
  plan: TargetedRemovalPlan,
  dryRun: boolean,
  writeOwnership: (targetDir: string, appName: string, skills: ManagedSkill[]) => void,
  cleanup: (quarantinePath: string) => void,
  writeReceipt: (targetDir: string, receipt: GlobalCoreCleanupReceipt, replace?: boolean) => void,
  clearReceipt: (targetDir: string) => void,
  rename: (skillPath: string, quarantinePath: string) => void,
): void {
  for (const skill of plan.planned) {
    console.log(`remove-managed: ${skill.name} (${path.join(targetDir, skill.name)})`);
  }
  if (dryRun) {
    return;
  }

  const reducedSkills = plan.ownership.skills.filter(
    (skill) => !plan.planned.some((removed) => removed.name === skill.name),
  );
  const quarantined = planQuarantines(targetDir, plan.planned);
  const preparedReceipt = createCleanupReceipt(
    targetDir,
    appName,
    plan.ownership.skills,
    plan.originalLedger,
    reducedSkills,
    quarantined,
  );
  try {
    writeReceipt(targetDir, preparedReceipt);
    for (const item of quarantined) {
      quarantineManagedSkill(item, rename);
    }
  } catch (error) {
    rollbackTargetedRemoval(targetDir, quarantined, plan.originalLedger, error, clearReceipt);
  }

  try {
    writeOwnership(targetDir, appName, reducedSkills);
    const committed = readCoreOwnership(targetDir, appName);
    if (!committed || !managedSkillsEqual(committed.skills, reducedSkills)) {
      throw new Error(`Reduced global core ownership ledger was not committed: ${ownershipPath(targetDir)}`);
    }
  } catch (error) {
    rollbackTargetedRemoval(targetDir, quarantined, plan.originalLedger, error, clearReceipt);
  }

  try {
    writeReceipt(targetDir, { ...preparedReceipt, state: "ledger-committed" }, true);
  } catch (error) {
    throw new Error(
      `Targeted global core removal committed with reduced ledger, but receipt state could not be advanced (${error instanceof Error ? error.message : String(error)}); retry with receipt retained: ${cleanupReceiptPath(targetDir)}`
    );
  }

  for (const item of quarantined) {
    try {
      cleanup(item.quarantinePath);
      if (pathPresent(item.quarantinePath)) {
        throw new Error(`Cleanup left quarantine residue: ${item.quarantinePath}`);
      }
    } catch (error) {
      const residue = quarantined
        .map(({ quarantinePath }) => quarantinePath)
        .filter(pathPresent);
      throw new Error(
        `Targeted global core removal committed with reduced ledger, but quarantine cleanup failed (${error instanceof Error ? error.message : String(error)}); recoverable residue: ${residue.join(", ") || item.quarantinePath}`
      );
    }
  }
  try {
    clearReceipt(targetDir);
  } catch (error) {
    throw new Error(
      `Targeted global core removal committed with reduced ledger, but cleanup receipt could not be cleared (${error instanceof Error ? error.message : String(error)}); receipt retained: ${cleanupReceiptPath(targetDir)}`
    );
  }
}

function refreshCoreOwnership(targetDir: string, appName: string, skillNames: string[]): void {
  const existing = readCoreOwnership(targetDir, appName)?.skills || [];
  const existingByName = new Map(existing.map((skill) => [skill.name, skill]));
  const refreshed = skillNames
    .filter((skillName) => isSkillDir(targetDir, skillName))
    .map((skillName) => ({ name: skillName, digest: managedSkillDigest(targetDir, skillName) }));
  if (!refreshed.length && !existing.length) {
    return;
  }
  for (const skill of refreshed) {
    existingByName.set(skill.name, skill);
  }
  writeCoreOwnership(targetDir, appName, [...existingByName.values()]);
}

function receiptMatchesRequestedSkills(receipt: GlobalCoreCleanupReceipt, skillNames: string[]): boolean {
  const recorded = receipt.entries.map(({ name }) => name).sort();
  const requested = [...new Set(skillNames)].sort();
  return recorded.length === requested.length && recorded.every((name, index) => name === requested[index]);
}

function main(argv: string[] = process.argv, deps: SyncGlobalCoreDeps = {}): void {
  const args = parseArgs(argv);
  const runFn = deps.run || run;
  const resolveGlobalCoreAppFn = deps.resolveGlobalCoreApp || resolveGlobalCoreApp;
  if (args.help) {
    help();
    return;
  }

  const sourceSkillsDir = path.join(args.source, "skills");
  if (!fileExists(sourceSkillsDir)) {
    throw new Error(`Source skills directory not found: ${sourceSkillsDir}`);
  }

  if (!args.noContractCheck) {
    console.log("-> Validating universal contract on source");
    run(["bun", CONTRACT, "--skills-root", sourceSkillsDir]);
  } else {
    console.log("-> Skipping universal contract check (--no-contract-check)");
  }

  const manifestPath =
    args.manifest === DEFAULT_GLOBAL_CORE_MANIFEST
      ? path.join(args.source, "globals", "core.json")
      : args.manifest;
  const { manifest } = readGlobalCoreManifest(manifestPath);
  const selectedApps = args.apps.length ? args.apps : listGlobalCoreApps(manifest);
  const declaredSkills = new Set(resolveGlobalCoreSkills(manifest));
  const invalidNames = args.deleteSkills.filter((skillName) => !isSafeSkillName(skillName));
  if (invalidNames.length) {
    throw new Error(`Invalid --delete-skill name(s): ${invalidNames.join(", ")}`);
  }
  const undeclared = args.deleteSkills.filter((skillName) => declaredSkills.has(skillName));
  if (undeclared.length) {
    throw new Error(
      `Cannot delete global core skill(s) still declared in manifest: ${undeclared.join(", ")}`
    );
  }

  const targetedPlans = new Map<string, TargetedRemovalPlan>();
  const pendingCleanups = new Map<string, GlobalCoreCleanupReceipt>();
  const resolveOptions = deps.allowedTargetRoots
    ? { allowedTargetRoots: deps.allowedTargetRoots }
    : undefined;
  const resolvedApps = selectedApps.map((appName) => resolveGlobalCoreAppFn(manifest, appName, resolveOptions));
  const writeOwnership = deps.writeCoreOwnership || writeCoreOwnership;
  const cleanup = deps.cleanupQuarantine || cleanupQuarantine;
  const writeReceipt = deps.writeCleanupReceipt || writeCleanupReceipt;
  const clearReceipt = deps.clearCleanupReceipt || clearCleanupReceipt;
  const rename = deps.renameQuarantine || ((skillPath: string, quarantinePath: string) => {
    fs.renameSync(skillPath, quarantinePath);
  });
  if (args.deleteSkills.length) {
    for (const app of resolvedApps) {
      const receipt = readCleanupReceipt(app.targetPath, app.app);
      if (receipt) {
        if (!receiptMatchesRequestedSkills(receipt, args.deleteSkills)) {
          throw new Error(
            `Pending global core cleanup does not match --delete-skill for ${app.app}; use the recorded skill names: ${receipt.entries.map(({ name }) => name).join(",")}`
          );
        }
        if (args.dryRun) {
          throw new Error(`Pending global core cleanup requires a non-dry-run retry: ${cleanupReceiptPath(app.targetPath)}`);
        }
        pendingCleanups.set(app.app, receipt);
      } else {
        targetedPlans.set(
          app.app,
          validateTargetedDeletions(app.targetPath, app.app, args.deleteSkills)
        );
      }
    }
  } else {
    for (const app of resolvedApps) {
      const receipt = readCleanupReceipt(app.targetPath, app.app);
      if (receipt) {
        throw new Error(
          `Pending global core cleanup requires --delete-skill ${receipt.entries.map(({ name }) => name).join(",")}: ${cleanupReceiptPath(app.targetPath)}`
        );
      }
    }
  }

  for (const app of resolvedApps) {
    ensureRealTargetDir(app.targetPath, args.dryRun);

    const cmd = [
      "bun",
      SYNC_SKILLS,
      "--from",
      sourceSkillsDir,
      "--to",
      app.targetPath,
      "--skills",
      app.skills.join(","),
      "--no-contract-check",
    ];
    if (args.deleteExtra) {
      cmd.push("--delete");
    }
    if (args.dryRun) {
      cmd.push("--dry-run");
    }

    console.log(`-> Sync global core for ${app.app}`);
    console.log(`   target: ${app.targetPath}`);
    console.log(`   skills: ${app.skills.join(", ")}`);
    if (args.deleteExtra) {
      console.log("   delete-extra: enabled");
    }
    if (args.deleteSkills.length) {
      console.log(`   delete-skill: ${args.deleteSkills.join(", ")}`);
    }
    runFn(cmd);

    if (args.deleteSkills.length) {
      const pending = pendingCleanups.get(app.app);
      if (pending) {
        recoverPendingCleanup(app.targetPath, pending, cleanup, clearReceipt);
      } else {
        const plan = targetedPlans.get(app.app)!;
        removeManagedSkillsTransaction(
          app.targetPath,
          app.app,
          plan,
          args.dryRun,
          writeOwnership,
          cleanup,
          writeReceipt,
          clearReceipt,
          rename,
        );
      }
    } else if (!args.dryRun) {
      refreshCoreOwnership(app.targetPath, app.app, app.skills);
    }
  }

  console.log("\nSTATUS: PASS");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exit(1);
  }
}

export {
  assertNoSymlinkParents,
  ensureRealTargetDir,
  GLOBAL_CORE_CLEANUP_RECEIPT_FILE,
  GLOBAL_CORE_OWNER,
  GLOBAL_CORE_OWNERSHIP_FILE,
  main,
  managedSkillDigest,
  parseArgs,
  readCoreOwnership,
};
