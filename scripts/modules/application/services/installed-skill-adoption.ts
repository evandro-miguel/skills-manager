/**
 * Read-only adoption audit for skills installed by external managers
 * (currently the `skills` CLI).
 *
 * This service is pure data-in/data-out: callers materialize lock entries and
 * scanned installs (see `integrations/skills-cli/`) and receive findings.
 * Nothing here writes, deletes, adopts, or mutates any target. Ownership
 * transfer is out of scope by design (see docs/specs/external-install-
 * ownership.md): SAFE_TO_ADOPT requires an upstream verification result that
 * proves the installed tree matches the pinned source.
 *
 * Foreign locks are hints, never proof; upstream verification is what turns a
 * structurally sound install into an adoption candidate.
 */

export type AdoptionLockEntry = Readonly<{
  name: string;
  sourceUrl?: string;
  skillPath?: string;
  sourceType?: string;
  installedAt?: string;
  /** Mutable branch/tag hint from the foreign lock (never trusted alone). */
  ref?: string;
  /** Pinned commit hint from the foreign lock (verified before adoption). */
  commit?: string;
}>;

export type AdoptionInstallEntry = Readonly<{
  /** Caller-chosen target label, e.g. "project" or "global". */
  targetId: string;
  name: string;
  dirPath: string;
  isSymlink: boolean;
  /**
   * Symlink resolves outside its target directory. Strictly-inside
   * semantics: only links resolving under `${targetDir}${path.sep}` count as
   * internal; a link pointing at the target directory itself escapes.
   */
  linkEscapesTarget?: boolean;
  /** Installed-tree digest computed by the caller when safe to do so. */
  contentDigest?: string;
}>;

export type AdoptionUpstreamStatus =
  | "UPSTREAM_MATCH"
  | "UPSTREAM_DRIFT"
  | "SOURCE_MISSING"
  | "SOURCE_AMBIGUOUS";

export type AdoptionUpstreamCheck = Readonly<{
  name: string;
  status: AdoptionUpstreamStatus;
  upstreamDigest?: string;
  /** Context for SOURCE_MISSING / SOURCE_AMBIGUOUS outcomes. */
  detail?: string;
}>;

export type AdoptionFindingState =
  | "FOREIGN_SYMLINK"
  | "NAME_COLLISION"
  | "LOCK_ENTRY_MISSING"
  | "LOCK_ENTRY_DUPLICATE"
  | "LOCK_ENTRY_STALE"
  | "SOURCE_MISSING"
  | "SOURCE_AMBIGUOUS"
  | "DRIFTED"
  | "STRUCTURAL_MATCH";

export type AdoptionVerdict =
  | "SAFE_TO_ADOPT"
  | "NEEDS_UPSTREAM_VERIFICATION"
  | "BLOCKED";

export type AdoptionFinding = Readonly<{
  name: string;
  targetId: string;
  states: readonly AdoptionFindingState[];
  verdict: AdoptionVerdict;
  detail?: string;
}>;

export type AdoptionAuditInput = Readonly<{
  locks: readonly AdoptionLockEntry[];
  installs: readonly AdoptionInstallEntry[];
  /** Names already owned by Universall or reserved elsewhere. */
  managedNames?: readonly string[];
  upstreamChecks?: readonly AdoptionUpstreamCheck[];
}>;

export type AdoptionAuditResult = Readonly<{
  findings: readonly AdoptionFinding[];
  summary: Readonly<{
    installs: number;
    staleLockEntries: number;
    safeToAdopt: number;
    blocked: number;
    needsUpstreamVerification: number;
  }>;
}>;

const BLOCKING_STATES: readonly AdoptionFindingState[] = [
  "FOREIGN_SYMLINK",
  "NAME_COLLISION",
  "LOCK_ENTRY_MISSING",
  "LOCK_ENTRY_DUPLICATE",
  "SOURCE_MISSING",
  "SOURCE_AMBIGUOUS",
  "DRIFTED",
];

function indexLockEntries(
  locks: readonly AdoptionLockEntry[],
): Map<string, { count: number; entry: AdoptionLockEntry }> {
  const index = new Map<string, { count: number; entry: AdoptionLockEntry }>();
  for (const lock of locks) {
    const current = index.get(lock.name);
    if (current) {
      current.count += 1;
    } else {
      index.set(lock.name, { count: 1, entry: lock });
    }
  }
  return index;
}

export function classifyInstalledSkills(
  input: AdoptionAuditInput,
): AdoptionAuditResult {
  const lockIndex = indexLockEntries(input.locks);
  const managed = new Set(input.managedNames ?? []);
  const upstream = new Map(
    (input.upstreamChecks ?? []).map((check) => [check.name, check]),
  );

  // Name collisions: same install name across different targets, or against
  // Universall-managed names.
  const targetCountByName = new Map<string, Set<string>>();
  for (const install of input.installs) {
    const targets = targetCountByName.get(install.name) ?? new Set<string>();
    targets.add(install.targetId);
    targetCountByName.set(install.name, targets);
  }
  const crossTargetNames = new Set(
    [...targetCountByName.entries()]
      .filter(([, targets]) => targets.size > 1)
      .map(([name]) => name),
  );

  const findings: AdoptionFinding[] = [];
  let safeToAdopt = 0;
  let blocked = 0;
  let needsUpstreamVerification = 0;

  for (const install of input.installs) {
    const states: AdoptionFindingState[] = [];
    const details: string[] = [];
    let verdict: AdoptionVerdict = "NEEDS_UPSTREAM_VERIFICATION";

    if (install.isSymlink) {
      states.push("FOREIGN_SYMLINK");
      details.push(
        install.linkEscapesTarget
          ? "Installed directory is a symlink escaping its target boundary."
          : "Installed directory is a symlink.",
      );
    }

    if (managed.has(install.name)) {
      states.push("NAME_COLLISION");
      details.push(`Name '${install.name}' is already Universall-managed.`);
    } else if (crossTargetNames.has(install.name)) {
      states.push("NAME_COLLISION");
      details.push(`Name '${install.name}' is installed in multiple targets.`);
    }

    const lockEntry = lockIndex.get(install.name);
    if (!lockEntry) {
      states.push("LOCK_ENTRY_MISSING");
      details.push("No foreign lock entry references this install.");
    } else if (lockEntry.count > 1) {
      states.push("LOCK_ENTRY_DUPLICATE");
      details.push(
        `Foreign lock declares ${lockEntry.count} conflicting entries for this name.`,
      );
    }

    const check = upstream.get(install.name);
    if (check) {
      if (check.status === "SOURCE_MISSING") {
        states.push("SOURCE_MISSING");
        details.push("Declared source no longer resolves upstream.");
      } else if (check.status === "SOURCE_AMBIGUOUS") {
        states.push("SOURCE_AMBIGUOUS");
        details.push("Multiple plausible upstream sources resolved.");
      } else if (
        check.upstreamDigest !== undefined &&
        install.contentDigest !== undefined
      ) {
        if (check.upstreamDigest === install.contentDigest) {
          states.push("STRUCTURAL_MATCH");
        } else {
          states.push("DRIFTED");
          details.push("Installed tree digest differs from upstream.");
        }
      }
    }

    if (states.some((state) => BLOCKING_STATES.includes(state))) {
      verdict = "BLOCKED";
      blocked += 1;
    } else if (states.includes("STRUCTURAL_MATCH")) {
      verdict = "SAFE_TO_ADOPT";
      safeToAdopt += 1;
    } else {
      needsUpstreamVerification += 1;
    }

    findings.push({
      name: install.name,
      targetId: install.targetId,
      states,
      verdict,
      ...(details.length > 0 ? { detail: details.join("; ") } : {}),
    });
  }

  // Stale lock entries: declared in a foreign lock but not installed anywhere.
  let staleLockEntries = 0;
  const installedNames = new Set(input.installs.map((install) => install.name));
  for (const [name, meta] of lockIndex) {
    if (installedNames.has(name)) continue;
    staleLockEntries += 1;
    blocked += 1;
    findings.push({
      name,
      targetId: "lock-only",
      states: ["LOCK_ENTRY_STALE"],
      verdict: "BLOCKED",
      detail:
        meta.count > 1
          ? `Foreign lock declares ${meta.count} conflicting entries for this name.`
          : "Foreign lock entry has no matching installation.",
    });
  }

  return {
    findings,
    summary: {
      installs: input.installs.length,
      staleLockEntries,
      safeToAdopt,
      blocked,
      needsUpstreamVerification,
    },
  };
}
