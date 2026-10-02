#!/usr/bin/env bun

import path from "node:path";
import { fileExists, readJson } from "../../lib/files.ts";

interface SkillRiskProfile {
  readsFiles: boolean;
  writesProject: boolean;
  writesGlobal: boolean;
  executesShell: boolean;
  networkAccess: boolean;
  externalDirectory: boolean;
  credentialSensitive: boolean;
  destructive: boolean;
  browserAuthState: boolean;
  repoMutation: boolean;
}

interface SkillInvocationPolicy {
  implicitAllowed: boolean;
  manualOnly: boolean;
  requiresConfirmation: boolean;
}

interface SkillMeta {
  $schema?: string;
  name: string;
  version: string;
  contractVersion: string;
  lifecycle: "active" | "deprecated" | "experimental";
  risk: SkillRiskProfile;
  invocation: SkillInvocationPolicy;
}

const RISK_KEYS = [
  "readsFiles",
  "writesProject",
  "writesGlobal",
  "executesShell",
  "networkAccess",
  "externalDirectory",
  "credentialSensitive",
  "destructive",
  "browserAuthState",
  "repoMutation",
] as const;

function defaultRiskProfile(): SkillRiskProfile {
  return {
    readsFiles: false,
    writesProject: false,
    writesGlobal: false,
    executesShell: false,
    networkAccess: false,
    externalDirectory: false,
    credentialSensitive: false,
    destructive: false,
    browserAuthState: false,
    repoMutation: false,
  };
}

function defaultSkillMeta(skillName: string): SkillMeta {
  return {
    name: skillName,
    version: "0.0.0",
    contractVersion: "1.0",
    lifecycle: "active",
    risk: defaultRiskProfile(),
    invocation: {
      implicitAllowed: true,
      manualOnly: false,
      requiresConfirmation: false,
    },
  };
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeRisk(value: unknown, label: string): SkillRiskProfile {
  const record = assertRecord(value, label);
  const risk = defaultRiskProfile();
  for (const key of RISK_KEYS) {
    if (typeof record[key] !== "boolean") {
      throw new Error(`${label}.${key} must be boolean`);
    }
    risk[key] = record[key];
  }
  return risk;
}

function normalizeInvocation(value: unknown, label: string): SkillInvocationPolicy {
  const record = assertRecord(value, label);
  if (typeof record.implicitAllowed !== "boolean") {
    throw new Error(`${label}.implicitAllowed must be boolean`);
  }
  if (typeof record.manualOnly !== "boolean") {
    throw new Error(`${label}.manualOnly must be boolean`);
  }
  if (typeof record.requiresConfirmation !== "boolean") {
    throw new Error(`${label}.requiresConfirmation must be boolean`);
  }
  return {
    implicitAllowed: record.implicitAllowed,
    manualOnly: record.manualOnly,
    requiresConfirmation: record.requiresConfirmation,
  };
}

function normalizeSkillMeta(value: unknown, expectedSkillName: string, label: string): SkillMeta {
  const record = assertRecord(value, label);
  if (record.name !== expectedSkillName) {
    throw new Error(`${label}.name must match skill directory '${expectedSkillName}'`);
  }
  if (typeof record.version !== "string" || !/^\d+\.\d+\.\d+$/.test(record.version)) {
    throw new Error(`${label}.version must be semver string x.y.z`);
  }
  if (typeof record.contractVersion !== "string" || !record.contractVersion.trim()) {
    throw new Error(`${label}.contractVersion must be a non-empty string`);
  }
  const lifecycle = record.lifecycle || "active";
  if (lifecycle !== "active" && lifecycle !== "deprecated" && lifecycle !== "experimental") {
    throw new Error(`${label}.lifecycle must be active, deprecated, or experimental`);
  }
  return {
    ...(typeof record.$schema === "string" ? { $schema: record.$schema } : {}),
    name: expectedSkillName,
    version: record.version,
    contractVersion: record.contractVersion,
    lifecycle,
    risk: normalizeRisk(record.risk, `${label}.risk`),
    invocation: normalizeInvocation(record.invocation, `${label}.invocation`),
  };
}

function readSkillMetaResult(
  skillDir: string,
  skillName = path.basename(skillDir),
): { meta: SkillMeta; source: "file" | "default" } {
  const metaPath = path.join(skillDir, "skill.meta.json");
  if (!fileExists(metaPath)) {
    return { meta: defaultSkillMeta(skillName), source: "default" };
  }
  return { meta: normalizeSkillMeta(readJson(metaPath), skillName, metaPath), source: "file" };
}

function readSkillMeta(skillDir: string, skillName = path.basename(skillDir)): SkillMeta {
  return readSkillMetaResult(skillDir, skillName).meta;
}

function hasDangerousRisk(meta: SkillMeta): boolean {
  return Boolean(
    meta.risk.writesProject ||
      meta.risk.writesGlobal ||
      meta.risk.executesShell ||
      meta.risk.networkAccess ||
      meta.risk.externalDirectory ||
      meta.risk.credentialSensitive ||
      meta.risk.destructive ||
      meta.risk.browserAuthState ||
      meta.risk.repoMutation ||
      meta.invocation.requiresConfirmation
  );
}

export {
  defaultRiskProfile,
  defaultSkillMeta,
  hasDangerousRisk,
  normalizeSkillMeta,
  readSkillMeta,
  readSkillMetaResult,
};
export type {
  SkillInvocationPolicy,
  SkillMeta,
  SkillRiskProfile,
};
