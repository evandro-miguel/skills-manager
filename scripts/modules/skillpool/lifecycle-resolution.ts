#!/usr/bin/env bun

const LIFECYCLE_RESOLUTION_SCHEMA = "skill-lifecycle-resolution/v1" as const;

type LifecycleResolutionTerminal = "active" | "removed" | "archived";

interface LifecycleEntryLike {
  skill?: unknown;
  event?: unknown;
  date?: unknown;
  replacements?: unknown;
  reason?: unknown;
  agent_action?: unknown;
  agentAction?: unknown;
  archive_path?: unknown;
  archivePath?: unknown;
  references?: unknown;
}

interface LifecycleEntryContainer {
  entries?: readonly LifecycleEntryLike[];
}

interface LifecycleEntry {
  skill?: string;
  event?: string;
  date?: string;
  replacements?: string[];
  reason?: string;
  agent_action?: string;
}

interface LifecycleResolution {
  schema_version: typeof LIFECYCLE_RESOLUTION_SCHEMA;
  skill: string;
  terminal: string;
  terminal_event: LifecycleResolutionTerminal;
  path: string[];
}

type LifecycleResolutionErrorCode =
  | "LIFECYCLE_SKILL_MISSING"
  | "LIFECYCLE_NODE_AMBIGUOUS"
  | "LIFECYCLE_REPLACEMENT_MISSING"
  | "LIFECYCLE_REPLACEMENT_AMBIGUOUS"
  | "LIFECYCLE_REPLACEMENT_SELF"
  | "LIFECYCLE_REPLACEMENT_CYCLE";

class LifecycleResolutionError extends Error {
  readonly code: LifecycleResolutionErrorCode;
  readonly path: string[];

  constructor(code: LifecycleResolutionErrorCode, message: string, resolutionPath: string[] = []) {
    super(`[${code}] ${message}`);
    this.name = "LifecycleResolutionError";
    this.code = code;
    this.path = resolutionPath;
  }
}

function normalizeLifecycleEntry(rawEntry: LifecycleEntryLike, skill?: string): LifecycleEntry {
  const replacements = Array.isArray(rawEntry.replacements)
    ? rawEntry.replacements
    : rawEntry.replacements === undefined || rawEntry.replacements === null
      ? []
      : String(rawEntry.replacements).split(",");
  return {
    skill: String(rawEntry.skill || skill || "").trim(),
    event: String(rawEntry.event || "").trim(),
    date: String(rawEntry.date || "").trim(),
    replacements: [...new Set(replacements.map((item) => String(item).trim()).filter(Boolean))],
    reason: String(rawEntry.reason || "").trim(),
    agent_action: String(rawEntry.agent_action || rawEntry.agentAction || "").trim(),
  };
}

function lifecycleEntriesBySkill(
  data: LifecycleEntryContainer | ReadonlyMap<string, readonly LifecycleEntryLike[]>,
): Map<string, LifecycleEntry[]> {
  const entriesBySkill = new Map<string, LifecycleEntry[]>();
  const add = (skill: string | undefined, rawEntry: LifecycleEntryLike): void => {
    const entry = normalizeLifecycleEntry(rawEntry, skill);
    if (!entry.skill) {
      return;
    }
    const entries = entriesBySkill.get(entry.skill) || [];
    entries.push(entry);
    entriesBySkill.set(entry.skill, entries);
  };

  if (data instanceof Map) {
    for (const [skill, entries] of data.entries()) {
      for (const entry of entries) {
        add(skill, entry);
      }
    }
  } else {
    for (const entry of (data as LifecycleEntryContainer).entries || []) {
      add(undefined, entry);
    }
  }

  for (const [skill, entries] of entriesBySkill.entries()) {
    entriesBySkill.set(
      skill,
      [...entries].sort((left, right) => {
        const dateCompare = String(right.date || "").localeCompare(String(left.date || ""));
        return dateCompare || String(left.skill || "").localeCompare(String(right.skill || ""));
      }),
    );
  }
  return entriesBySkill;
}

function currentLifecycleEntries(
  entriesBySkill: ReadonlyMap<string, readonly LifecycleEntry[]>,
): Map<string, LifecycleEntry[]> {
  const current = new Map<string, LifecycleEntry[]>();
  for (const [skill, entries] of entriesBySkill.entries()) {
    if (!entries.length) {
      continue;
    }
    const latestDate = String(entries[0]!.date || "");
    current.set(skill, entries.filter((entry) => String(entry.date || "") === latestDate));
  }
  return current;
}

interface LifecycleResolutionOptions {
  activeSkills?: Iterable<string>;
}

function resolveLifecycle(
  data: LifecycleEntryContainer | ReadonlyMap<string, readonly LifecycleEntryLike[]>,
  skill: string,
  options: LifecycleResolutionOptions = {},
): LifecycleResolution {
  const requestedSkill = String(skill || "").trim();
  const activeSkills = new Set(options.activeSkills || []);
  const currentEntriesBySkill = currentLifecycleEntries(lifecycleEntriesBySkill(data));
  const visiting = new Set<string>();

  const walk = (currentSkill: string, chain: string[]): LifecycleResolution => {
    if (activeSkills.has(currentSkill)) {
      return {
        schema_version: LIFECYCLE_RESOLUTION_SCHEMA,
        skill: requestedSkill,
        terminal: currentSkill,
        terminal_event: "active",
        path: [...chain, currentSkill],
      };
    }
    if (visiting.has(currentSkill)) {
      const cyclePath = [...chain, currentSkill];
      throw new LifecycleResolutionError(
        "LIFECYCLE_REPLACEMENT_CYCLE",
        `lifecycle replacement cycle: ${cyclePath.join(" -> ")}`,
        cyclePath,
      );
    }

    const entries = currentEntriesBySkill.get(currentSkill) || [];
    if (!entries.length) {
      throw new LifecycleResolutionError(
        chain.length ? "LIFECYCLE_REPLACEMENT_MISSING" : "LIFECYCLE_SKILL_MISSING",
        `lifecycle node '${currentSkill}' is missing`,
        [...chain, currentSkill],
      );
    }
    if (entries.length > 1) {
      throw new LifecycleResolutionError(
        "LIFECYCLE_NODE_AMBIGUOUS",
        `lifecycle node '${currentSkill}' has multiple current entries`,
        [...chain, currentSkill],
      );
    }

    const entry = entries[0]!;
    const nextChain = [...chain, currentSkill];
    if (entry.event === "removed" || entry.event === "archived") {
      return {
        schema_version: LIFECYCLE_RESOLUTION_SCHEMA,
        skill: requestedSkill,
        terminal: currentSkill,
        terminal_event: entry.event,
        path: nextChain,
      };
    }
    if (!entry.replacements?.length) {
      throw new LifecycleResolutionError(
        "LIFECYCLE_REPLACEMENT_MISSING",
        `lifecycle node '${currentSkill}' has no replacement`,
        nextChain,
      );
    }
    if (entry.replacements.length > 1) {
      throw new LifecycleResolutionError(
        "LIFECYCLE_REPLACEMENT_AMBIGUOUS",
        `lifecycle node '${currentSkill}' has multiple replacements: ${entry.replacements.join(", ")}`,
        nextChain,
      );
    }

    const replacement = entry.replacements[0]!;
    if (replacement === currentSkill) {
      throw new LifecycleResolutionError(
        "LIFECYCLE_REPLACEMENT_SELF",
        `lifecycle node '${currentSkill}' replaces itself`,
        [...nextChain, replacement],
      );
    }
    visiting.add(currentSkill);
    try {
      return walk(replacement, nextChain);
    } finally {
      visiting.delete(currentSkill);
    }
  };

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestedSkill)) {
    throw new LifecycleResolutionError(
      "LIFECYCLE_SKILL_MISSING",
      `skill '${requestedSkill}' is not a valid lifecycle name`,
    );
  }
  return walk(requestedSkill, []);
}

export {
  LIFECYCLE_RESOLUTION_SCHEMA,
  LifecycleResolutionError,
  normalizeLifecycleEntry,
  resolveLifecycle,
};

export type {
  LifecycleEntry,
  LifecycleEntryContainer,
  LifecycleEntryLike,
  LifecycleResolution,
  LifecycleResolutionErrorCode,
  LifecycleResolutionOptions,
  LifecycleResolutionTerminal,
};
