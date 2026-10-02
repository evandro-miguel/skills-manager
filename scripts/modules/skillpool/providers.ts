#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { fileExists, readJson } from "../../lib/files.ts";
import { PROVIDER_IDS, type ProviderId } from "../skill-metadata-lib.ts";

type ConcreteProviderId = Exclude<ProviderId, "universal">;

interface ProviderCapability {
  $schema?: string;
  provider: ConcreteProviderId;
  displayName?: string;
  detectionPaths?: Record<string, string>;
  skillPaths: Record<string, string>;
  supports: Record<string, boolean>;
  dangerNotes: string[];
}

function concreteProviderIds(): ConcreteProviderId[] {
  return PROVIDER_IDS.filter((provider): provider is ConcreteProviderId => provider !== "universal");
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeProviderId(value: unknown, label: string): ConcreteProviderId {
  if (typeof value !== "string" || !concreteProviderIds().includes(value as ConcreteProviderId)) {
    throw new Error(`${label} must be one of ${concreteProviderIds().join(", ")}`);
  }
  return value as ConcreteProviderId;
}

function normalizeStringMap(value: unknown, label: string): Record<string, string> {
  const record = assertRecord(value, label);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${label}.${key} must be a non-empty string`);
    }
    output[key] = item;
  }
  return output;
}

function normalizeBooleanMap(value: unknown, label: string): Record<string, boolean> {
  const record = assertRecord(value, label);
  const output: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "boolean") {
      throw new Error(`${label}.${key} must be boolean`);
    }
    output[key] = item;
  }
  return output;
}

function normalizeDisplayName(value: unknown, label: string): string {
  if (value === undefined || value === null) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeOptionalStringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return normalizeStringMap(value, label);
}

function normalizeProviderCapability(value: unknown, label: string): ProviderCapability {
  const record = assertRecord(value, label);
  const notes = record.dangerNotes;
  if (!Array.isArray(notes) || notes.some((note) => typeof note !== "string")) {
    throw new Error(`${label}.dangerNotes must be an array of strings`);
  }
  const capability: ProviderCapability = {
    ...(typeof record.$schema === "string" ? { $schema: record.$schema } : {}),
    provider: normalizeProviderId(record.provider, `${label}.provider`),
    skillPaths: normalizeStringMap(record.skillPaths, `${label}.skillPaths`),
    supports: normalizeBooleanMap(record.supports, `${label}.supports`),
    dangerNotes: notes,
  };
  // displayName/detectionPaths are v2 enrichment. Engine providers under
  // providers/ must declare them (enforced by the provider-matrix docs test),
  // but embedded/example skillpack providers may omit them, so preserve them
  // only when present rather than requiring them here.
  if (record.displayName !== undefined && record.displayName !== null) {
    capability.displayName = normalizeDisplayName(record.displayName, `${label}.displayName`);
  }
  const detectionPaths = normalizeOptionalStringMap(record.detectionPaths, `${label}.detectionPaths`);
  if (detectionPaths) {
    capability.detectionPaths = detectionPaths;
  }
  return capability;
}

function readProviderCapability(providersRoot: string, provider: string): ProviderCapability {
  const providerId = normalizeProviderId(provider, "provider");
  const filePath = path.join(providersRoot, `${providerId}.json`);
  if (!fileExists(filePath)) {
    throw new Error(`Provider capability file not found: ${filePath}`);
  }
  if (fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to read symlinked provider capability: ${filePath}`);
  }
  const capability = normalizeProviderCapability(readJson(filePath), filePath);
  if (capability.provider !== providerId) {
    throw new Error(`Provider file ${filePath} declares ${capability.provider}, expected ${providerId}`);
  }
  return capability;
}

function readProviderCapabilities(sourceRoot: string, providers: string[] = concreteProviderIds()): ProviderCapability[] {
  const providersRoot = path.join(sourceRoot, "providers");
  return providers.map((provider) => readProviderCapability(providersRoot, provider));
}

function parseProviderList(value: string | string[] | null | undefined): ConcreteProviderId[] {
  const rawItems = Array.isArray(value) ? value : String(value || "all").split(",");
  const requested = rawItems.map((item) => item.trim()).filter(Boolean);
  const expanded = requested.includes("all") ? concreteProviderIds() : requested;
  return expanded.map((provider) => normalizeProviderId(provider, "provider"));
}

function readDeclaredSkillpackProviders(sourceRoot: string): ConcreteProviderId[] | null {
  const skillpackPath = path.join(sourceRoot, "skillpack.json");
  if (!fileExists(skillpackPath)) {
    return null;
  }
  const skillpack = assertRecord(readJson(skillpackPath), skillpackPath);
  if (!Array.isArray(skillpack.providers) || skillpack.providers.length === 0) {
    return null;
  }
  return skillpack.providers.map((provider, index) => normalizeProviderId(provider, `${skillpackPath}.providers[${index}]`));
}

function parseProviderListForSource(
  value: string | string[] | null | undefined,
  sourceRoot: string
): ConcreteProviderId[] {
  const rawItems = Array.isArray(value) ? value : String(value || "all").split(",");
  const requested = rawItems.map((item) => item.trim()).filter(Boolean);
  if (requested.includes("all")) {
    const declared = readDeclaredSkillpackProviders(path.resolve(sourceRoot));
    if (declared && declared.length > 0) {
      return declared;
    }
  }
  return parseProviderList(value);
}

export {
  concreteProviderIds,
  normalizeProviderCapability,
  parseProviderList,
  parseProviderListForSource,
  readProviderCapabilities,
  readProviderCapability,
};
export type {
  ConcreteProviderId,
  ProviderCapability,
};
