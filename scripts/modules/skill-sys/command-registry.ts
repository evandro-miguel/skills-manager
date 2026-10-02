#!/usr/bin/env bun

import {
  MEMORY_ADAPTER_COMMAND_SPEC,
  PROJECT_LEARNINGS_COMMAND_SPEC,
  REGISTRY_TRUST_COMMAND_SPEC,
  projectCommandSpecToLegacyObservation,
  TEAM_MODE_COMMAND_SPEC,
  TELEMETRY_POLICY_COMMAND_SPEC,
  validateCommandSpecRegistry,
} from "./command-spec.ts";

export type SkillSysCommandAudience = "public" | "compatibility" | "planned";

export type SkillSysCommandDefinition = {
  name: string;
  aliases: string[];
  audience: SkillSysCommandAudience;
  summary: string;
};

export const SKILL_SYS_COMMANDS: SkillSysCommandDefinition[] = [
  {
    name: "add",
    aliases: ["get"],
    audience: "public",
    summary: "Install skills from a local directory or Git source.",
  },
  {
    name: "list",
    aliases: ["ls"],
    audience: "public",
    summary: "List skills from the local catalog, stack packs, or project-only profiles.",
  },
  {
    name: "find",
    aliases: ["search"],
    audience: "public",
    summary: "Search skills by name, description, tag, category, stack, or profile.",
  },
  {
    name: "update",
    aliases: ["up"],
    audience: "public",
    summary: "Update a project lockfile ref, or refresh one declared skill from the current lock.",
  },
  {
    name: "update-check",
    aliases: [],
    audience: "public",
    summary: "Report available updates for declared third-party skill sources (read-only).",
  },
  {
    name: "generate-lock",
    aliases: ["lock"],
    audience: "public",
    summary: "Resolve and pin declared third-party skill sources into a source lockfile.",
  },
  {
    name: "doctor",
    aliases: ["check"],
    audience: "public",
    summary: "Check installed skills for drift and missing files.",
  },
  {
    name: "validate",
    aliases: [],
    audience: "public",
    summary: "Validate a skill source layout and lockfile references.",
  },
  {
    name: "scan-sensitive",
    aliases: ["sensitive-scan"],
    audience: "public",
    summary: "Scan skill payloads for sensitive files and secret-shaped content.",
  },
  {
    name: "scan-privacy",
    aliases: ["privacy-scan"],
    audience: "public",
    summary: "Scan source or artifact surfaces for privacy leakage and private workflow markers.",
  },
  {
    name: "scan-security",
    aliases: ["security-scan", "security-scan-v2"],
    audience: "public",
    summary:
      "Static offline security scan for network, credential, setup-script, injection, and metadata risks.",
  },
  {
    name: "public-audit",
    aliases: ["audit-public"],
    audience: "public",
    summary: "Run public-release privacy and sensitive-data checks for an artifact surface.",
  },
  {
    name: "packlist",
    aliases: ["pack-list"],
    audience: "public",
    summary: "List files included by a public artifact surface with a deterministic digest.",
  },
  {
    name: "npm-pack-audit",
    aliases: ["pack-audit"],
    audience: "public",
    summary: "Compare npm pack output with the selected public artifact surface.",
  },
  {
    name: "validate-registry-surface",
    aliases: ["registry-check"],
    audience: "public",
    summary: "Validate static registry, channel, tap, and advisory publication fixtures.",
  },
  {
    name: "registry-export",
    aliases: ["export-registry"],
    audience: "public",
    summary: "Export the validated public registry surface as a deterministic interop bundle.",
  },
  projectCommandSpecToLegacyObservation(REGISTRY_TRUST_COMMAND_SPEC),
  projectCommandSpecToLegacyObservation(TELEMETRY_POLICY_COMMAND_SPEC),
  {
    name: "validate-skillpack",
    aliases: ["skillpack-validate"],
    audience: "public",
    summary: "Validate a skillpack manifest, skills, profiles, and risk metadata.",
  },
  {
    name: "create-skillpack",
    aliases: ["skillpack-create"],
    audience: "public",
    summary: "Create a sanitized skillpack scaffold.",
  },
  {
    name: "verify-origin",
    aliases: ["origin"],
    audience: "public",
    summary: "Verify git ref/commit and local release artifact policy for a source checkout.",
  },
  {
    name: "build-projections",
    aliases: ["project"],
    audience: "public",
    summary: "Render provider-specific projection output into dist/.",
  },
  {
    name: "validate-projections",
    aliases: ["check-projections"],
    audience: "public",
    summary: "Validate generated provider projection output.",
  },
  {
    name: "workflow-chain",
    aliases: ["chain"],
    audience: "public",
    summary: "Validate and dry-run declarative workflow chains without executing steps.",
  },
  {
    name: "route",
    aliases: [],
    audience: "public",
    summary: "Route a query to matching skills using declarative, offline routing rules.",
  },
  projectCommandSpecToLegacyObservation(TEAM_MODE_COMMAND_SPEC),
  {
    name: "dev-mode",
    aliases: ["dev"],
    audience: "public",
    summary: "Validate local-only symlink development plans without applying filesystem changes.",
  },
  projectCommandSpecToLegacyObservation(PROJECT_LEARNINGS_COMMAND_SPEC),
  projectCommandSpecToLegacyObservation(MEMORY_ADAPTER_COMMAND_SPEC),
  {
    name: "eval",
    aliases: [],
    audience: "public",
    summary: "Evaluate trigger and collision fixtures for skill descriptions.",
  },
  {
    name: "semantic-audit",
    aliases: [],
    audience: "public",
    summary: "Scan skill descriptions for semantic supply-chain risks.",
  },
  {
    name: "docs-check",
    aliases: [],
    audience: "public",
    summary: "Validate docs links and local command examples.",
  },
  {
    name: "provider-matrix",
    aliases: ["generate-provider-matrix"],
    audience: "public",
    summary: "Generate or check the provider capability matrix docs section.",
  },
  {
    name: "catalog",
    aliases: ["generate-catalog"],
    audience: "public",
    summary: "Generate deterministic skill cards/catalog from a skillpack into --out-dir.",
  },
  {
    name: "guard-repo-visibility",
    aliases: [],
    audience: "public",
    summary: "Fail closed unless the protected GitHub repo remains private or publication is explicitly approved.",
  },
  {
    name: "context",
    aliases: ["pack"],
    audience: "public",
    summary: "Emit a token-aware context bundle for one skill.",
  },
  {
    name: "sync",
    aliases: [],
    audience: "public",
    summary: "Plan or apply digest-based project skill sync; legacy sync flags remain supported.",
  },
  {
    name: "rollback",
    aliases: [],
    audience: "public",
    summary: "Restore skills from a completed .skill-sys-backup entry.",
  },
  {
    name: "install",
    aliases: [],
    audience: "compatibility",
    summary: "Compatibility alias for skillpool install.",
  },
  {
    name: "upgrade",
    aliases: [],
    audience: "compatibility",
    summary: "Compatibility alias for skillpool upgrade.",
  },
  {
    name: "setup",
    aliases: ["quick-install"],
    audience: "compatibility",
    summary: "Compatibility alias for quick-install.",
  },
  {
    name: "init",
    aliases: ["init-project"],
    audience: "compatibility",
    summary: "Compatibility alias for bootstrap-skills.",
  },
  {
    name: "use",
    aliases: [],
    audience: "public",
    summary:
      "Render a skill from a local or remote source without installing; ephemeral read-only preview.",
  },
  {
    name: "remove",
    aliases: ["rm"],
    audience: "public",
    summary:
      "Plan or apply a safe removal of skill-sys-managed skills with rollback-compatible backups.",
  },
  {
    name: "verify-sandbox",
    aliases: ["sandbox-verify"],
    audience: "public",
    summary:
      "Plan-only sandbox runtime verification: emit the isolation command vector and required controls (no execution).",
  },
  {
    name: "registry-import",
    aliases: ["import-registry"],
    audience: "public",
    summary: "Import a local registry export bundle with deterministic digest validation.",
  },
  {
    name: "audit-installed",
    aliases: [],
    audience: "public",
    summary: "Audit skills installed by external managers like the skills CLI (read-only).",
  },
  {
    name: "inspect-skill",
    aliases: [],
    audience: "public",
    summary: "Resolve a skills.sh catalog reference offline into a canonical source hint.",
  },
  {
    name: "adopt-installed",
    aliases: [],
    audience: "planned",
    summary:
      "Plan-only adoption of foreign-managed skills (incomplete; no default upstream verifier).",
  },
];

validateCommandSpecRegistry(
  [
    TELEMETRY_POLICY_COMMAND_SPEC,
    TEAM_MODE_COMMAND_SPEC,
    MEMORY_ADAPTER_COMMAND_SPEC,
    PROJECT_LEARNINGS_COMMAND_SPEC,
    REGISTRY_TRUST_COMMAND_SPEC,
  ],
  SKILL_SYS_COMMANDS.filter(
    (command) =>
      command.name !== TELEMETRY_POLICY_COMMAND_SPEC.name &&
      command.name !== TEAM_MODE_COMMAND_SPEC.name &&
      command.name !== MEMORY_ADAPTER_COMMAND_SPEC.name &&
      command.name !== PROJECT_LEARNINGS_COMMAND_SPEC.name &&
      command.name !== REGISTRY_TRUST_COMMAND_SPEC.name,
  ),
);

export function resolveSkillSysCommandName(name: string): string | null {
  const normalized = name.trim();
  for (const command of SKILL_SYS_COMMANDS) {
    if (command.name === normalized || command.aliases.includes(normalized)) {
      return command.name;
    }
  }
  return null;
}

export function publicSkillSysCommands(): SkillSysCommandDefinition[] {
  return SKILL_SYS_COMMANDS.filter((command) => command.audience === "public");
}
