import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CommandSpecValidationError,
  MEMORY_ADAPTER_COMMAND_SPEC,
  MEMORY_ADAPTER_READ_COMMAND_SPEC,
  MEMORY_ADAPTER_WRITE_COMMAND_SPEC,
  PROJECT_LEARNINGS_COMMAND_SPEC,
  PROJECT_LEARNINGS_WRITE_COMMAND_SPEC,
  REGISTRY_TRUST_COMMAND_SPEC,
  TEAM_MODE_COMMAND_SPEC,
  TELEMETRY_POLICY_COMMAND_SPEC,
  createMemoryAdapterCommandSpec,
  createMemoryAdapterReadCommandSpec,
  createMemoryAdapterWriteCommandSpec,
  createProjectLearningsCommandSpec,
  createProjectLearningsWriteCommandSpec,
  createRegistryTrustCommandSpec,
  createTeamModeCommandSpec,
  createTelemetryPolicyCommandSpec,
  projectCommandSpecToLegacyObservation,
  resolveCommandSpec,
  serializeCommandSpecV1,
  validateCommandSpecRegistry,
  validateCommandSpecV1,
} from "../scripts/modules/skill-sys/command-spec.ts";
import { SKILL_SYS_COMMANDS } from "../scripts/modules/skill-sys/command-registry.ts";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function mutableTelemetrySpec(): Record<string, unknown> {
  return clone(TELEMETRY_POLICY_COMMAND_SPEC) as Record<string, unknown>;
}

function mutableTeamModeSpec(): Record<string, unknown> {
  return clone(TEAM_MODE_COMMAND_SPEC) as Record<string, unknown>;
}

function mutableMemoryAdapterSpec(): Record<string, unknown> {
  return clone(MEMORY_ADAPTER_COMMAND_SPEC) as Record<string, unknown>;
}

function mutableMemoryAdapterReadSpec(): Record<string, unknown> {
  return clone(MEMORY_ADAPTER_READ_COMMAND_SPEC) as Record<string, unknown>;
}

function mutableMemoryAdapterWriteSpec(): Record<string, unknown> {
  return clone(MEMORY_ADAPTER_WRITE_COMMAND_SPEC) as Record<string, unknown>;
}

function mutableProjectLearningsSpec(): Record<string, unknown> {
  return clone(PROJECT_LEARNINGS_COMMAND_SPEC) as Record<string, unknown>;
}

function mutableProjectLearningsWriteSpec(): Record<string, unknown> {
  return clone(PROJECT_LEARNINGS_WRITE_COMMAND_SPEC) as Record<string, unknown>;
}

function mutableRegistryTrustSpec(): Record<string, unknown> {
  return clone(REGISTRY_TRUST_COMMAND_SPEC) as Record<string, unknown>;
}

describe("CommandSpec V1 registry", () => {
  test("publishes the exact telemetry-policy contract in deterministic input order", () => {
    expect(TELEMETRY_POLICY_COMMAND_SPEC).toEqual({
      schemaVersion: 1,
      id: "policy.telemetry.validate",
      name: "telemetry-policy",
      aliases: ["telemetry"],
      audience: "public",
      stability: "experimental",
      summary: "Validate local telemetry policy opt-in gates without collecting telemetry.",
      sideEffect: "read",
      inputs: [
        {
          id: "source",
          token: "--source",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "config",
          token: "--config",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "json",
          token: "--json",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "strict",
          token: "--strict",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help",
          token: "--help",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: false,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help-short",
          token: "-h",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: { facade: "unsupported", standalone: "idempotent" },
          applicationInput: false,
          cliSurfaces: ["standalone"],
        },
      ],
      permissions: ["policy.local.read"],
      effects: ["filesystem-read"],
      applicationHandler: "telemetry-policy.validate",
      result: {
        schemaVersion: 1,
        type: "telemetry-policy-result",
        schema: "schema/telemetry-policy-result.schema.json",
      },
      surfaces: {
        cli: "active",
        mcp: "unsupported",
      },
      observedExit: {
        resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 0 },
        thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
      },
      observedErrors: {
        kind: "legacy-prose",
        facadeAndStandaloneMayDiffer: true,
      },
    });
    expect(serializeCommandSpecV1(TELEMETRY_POLICY_COMMAND_SPEC)).toBe(
      `${JSON.stringify(TELEMETRY_POLICY_COMMAND_SPEC, null, 2)}\n`,
    );
  });

  test("publishes the exact team-mode contract with its distinct exit mapping", () => {
    expect(TEAM_MODE_COMMAND_SPEC).toEqual({
      schemaVersion: 1,
      id: "policy.team-mode.validate",
      name: "team-mode",
      aliases: ["team"],
      audience: "public",
      stability: "experimental",
      summary:
        "Validate deterministic team-mode config without packaging catalogs or enabling symlink installs.",
      sideEffect: "read",
      inputs: [
        {
          id: "source",
          token: "--source",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "config",
          token: "--config",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "json",
          token: "--json",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "strict",
          token: "--strict",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help",
          token: "--help",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: false,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help-short",
          token: "-h",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: { facade: "unsupported", standalone: "idempotent" },
          applicationInput: false,
          cliSurfaces: ["standalone"],
        },
      ],
      permissions: ["policy.local.read"],
      effects: ["filesystem-read"],
      applicationHandler: "team-mode.validate",
      result: {
        schemaVersion: 1,
        type: "team-mode-result",
        schema: "schema/team-mode-result.schema.json",
      },
      surfaces: {
        cli: "active",
        mcp: "unsupported",
      },
      observedExit: {
        resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
        thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
      },
      observedErrors: {
        kind: "legacy-prose",
        facadeAndStandaloneMayDiffer: true,
      },
    });
    expect(serializeCommandSpecV1(TEAM_MODE_COMMAND_SPEC)).toBe(
      `${JSON.stringify(TEAM_MODE_COMMAND_SPEC, null, 2)}\n`,
    );
  });

  test("publishes the exact memory-adapter contract without claiming an MCP transport", () => {
    expect(MEMORY_ADAPTER_COMMAND_SPEC).toEqual({
      schemaVersion: 1,
      id: "memory.adapter.validate",
      name: "memory-adapter",
      aliases: ["memory"],
      audience: "public",
      stability: "experimental",
      summary:
        "Validate local/private memory adapter interfaces without invoking them.",
      sideEffect: "read",
      inputs: [
        {
          id: "source",
          token: "--source",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "config",
          token: "--config",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "json",
          token: "--json",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "strict",
          token: "--strict",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help",
          token: "--help",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: false,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help-short",
          token: "-h",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: { facade: "unsupported", standalone: "idempotent" },
          applicationInput: false,
          cliSurfaces: ["standalone"],
        },
      ],
      permissions: ["policy.local.read"],
      effects: ["filesystem-read"],
      applicationHandler: "memory-adapter.validate",
      result: {
        schemaVersion: 1,
        type: "memory-adapter-result",
        schema: "schema/memory-adapter-result.schema.json",
      },
      surfaces: {
        cli: "active",
        mcp: "unsupported",
      },
      observedExit: {
        resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
        thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
      },
      observedErrors: {
        kind: "legacy-prose",
        facadeAndStandaloneMayDiffer: true,
      },
    });
    expect(serializeCommandSpecV1(MEMORY_ADAPTER_COMMAND_SPEC)).toBe(
      `${JSON.stringify(MEMORY_ADAPTER_COMMAND_SPEC, null, 2)}\n`,
    );
  });

  test("publishes the exact memory-adapter read contract as read-only", () => {
    expect(MEMORY_ADAPTER_READ_COMMAND_SPEC).toEqual({
      schemaVersion: 1,
      id: "memory.adapter.read",
      name: "memory-adapter-read",
      aliases: [],
      audience: "public",
      stability: "experimental",
      summary:
        "Read memory records from a local/private JSONL memory adapter under explicit trust policy.",
      sideEffect: "read",
      inputs: [
        {
          id: "source",
          token: "--source",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "config",
          token: "--config",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "json",
          token: "--json",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "strict",
          token: "--strict",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help",
          token: "--help",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: false,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help-short",
          token: "-h",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: { facade: "unsupported", standalone: "idempotent" },
          applicationInput: false,
          cliSurfaces: ["standalone"],
        },
      ],
      permissions: ["policy.local.read"],
      effects: ["filesystem-read"],
      applicationHandler: "memory-adapter.read",
      result: {
        schemaVersion: 1,
        type: "memory-adapter-read-result",
        schema: "schema/memory-adapter-read-result.schema.json",
      },
      surfaces: {
        cli: "active",
        mcp: "unsupported",
      },
      observedExit: {
        resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
        thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
      },
      observedErrors: {
        kind: "legacy-prose",
        facadeAndStandaloneMayDiffer: true,
      },
    });
    expect(serializeCommandSpecV1(MEMORY_ADAPTER_READ_COMMAND_SPEC)).toBe(
      `${JSON.stringify(MEMORY_ADAPTER_READ_COMMAND_SPEC, null, 2)}\n`,
    );
  });

  test("publishes the exact memory-adapter write contract with free-text record inputs", () => {
    expect(MEMORY_ADAPTER_WRITE_COMMAND_SPEC).toEqual({
      schemaVersion: 1,
      id: "memory.adapter.write",
      name: "memory-adapter-write",
      aliases: [],
      audience: "public",
      stability: "experimental",
      summary:
        "Append a memory record to a local/private JSONL memory adapter under explicit trust policy.",
      sideEffect: "write",
      inputs: [
        {
          id: "source",
          token: "--source",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "config",
          token: "--config",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "id",
          token: "--id",
          valueType: "text",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "memory",
          token: "--memory",
          valueType: "text",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "source-entry",
          token: "--source-entry",
          valueType: "text",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "dry-run",
          token: "--dry-run",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "json",
          token: "--json",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "strict",
          token: "--strict",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help",
          token: "--help",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: false,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help-short",
          token: "-h",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: { facade: "unsupported", standalone: "idempotent" },
          applicationInput: false,
          cliSurfaces: ["standalone"],
        },
      ],
      permissions: ["policy.local.read", "policy.local.write"],
      effects: ["filesystem-read", "filesystem-write"],
      applicationHandler: "memory-adapter.write",
      result: {
        schemaVersion: 1,
        type: "memory-adapter-write-result",
        schema: "schema/memory-adapter-write-result.schema.json",
      },
      surfaces: {
        cli: "active",
        mcp: "unsupported",
      },
      observedExit: {
        resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
        thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
      },
      observedErrors: {
        kind: "legacy-prose",
        facadeAndStandaloneMayDiffer: true,
      },
    });
    expect(serializeCommandSpecV1(MEMORY_ADAPTER_WRITE_COMMAND_SPEC)).toBe(
      `${JSON.stringify(MEMORY_ADAPTER_WRITE_COMMAND_SPEC, null, 2)}\n`,
    );
  });

  test("declares free-text record inputs without forcing path or boolean policy", () => {
    for (const input of MEMORY_ADAPTER_WRITE_COMMAND_SPEC.inputs) {
      if (input.id === "id" || input.id === "memory" || input.id === "source-entry") {
        expect(input.valueType).toBe("text");
        expect(input.default).toBeNull();
        expect(input.required).toBe(true);
        expect(input.applicationInput).toBe(true);
      }
    }

    const optionalText = mutableMemoryAdapterWriteSpec();
    (optionalText.inputs as Record<string, unknown>[])[2]!.required = false;
    expect(validateCommandSpecV1(optionalText)).toBeTruthy();

    const textWithBooleanDefault = mutableMemoryAdapterWriteSpec();
    (textWithBooleanDefault.inputs as Record<string, unknown>[])[2]!.default = false;
    expect(() => validateCommandSpecV1(textWithBooleanDefault)).toThrow(
      CommandSpecValidationError,
    );

    const textWithShortToken = mutableMemoryAdapterWriteSpec();
    (textWithShortToken.inputs as Record<string, unknown>[])[2]!.token = "-i";
    expect(() => validateCommandSpecV1(textWithShortToken)).toThrow(
      CommandSpecValidationError,
    );
  });

  test("publishes the exact project-learnings validate contract as read-only", () => {
    expect(PROJECT_LEARNINGS_COMMAND_SPEC).toEqual({
      schemaVersion: 1,
      id: "project.learnings.validate",
      name: "project-learnings",
      aliases: ["learnings"],
      audience: "public",
      stability: "experimental",
      summary: "Validate local/private project learnings without publishing them.",
      sideEffect: "read",
      inputs: [
        {
          id: "source",
          token: "--source",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "learnings",
          token: "--learnings",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "json",
          token: "--json",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "strict",
          token: "--strict",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help",
          token: "--help",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: false,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help-short",
          token: "-h",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: { facade: "unsupported", standalone: "idempotent" },
          applicationInput: false,
          cliSurfaces: ["standalone"],
        },
      ],
      permissions: ["policy.local.read"],
      effects: ["filesystem-read"],
      applicationHandler: "project-learnings.validate",
      result: {
        schemaVersion: 1,
        type: "project-learnings-result",
        schema: "schema/project-learnings-result.schema.json",
      },
      surfaces: {
        cli: "active",
        mcp: "unsupported",
      },
      observedExit: {
        resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
        thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
      },
      observedErrors: {
        kind: "legacy-prose",
        facadeAndStandaloneMayDiffer: true,
      },
    });
    expect(serializeCommandSpecV1(PROJECT_LEARNINGS_COMMAND_SPEC)).toBe(
      `${JSON.stringify(PROJECT_LEARNINGS_COMMAND_SPEC, null, 2)}\n`,
    );
  });

  test("publishes the exact project-learnings write contract with append/update flags", () => {
    expect(PROJECT_LEARNINGS_WRITE_COMMAND_SPEC).toEqual({
      schemaVersion: 1,
      id: "project.learnings.write",
      name: "project-learnings-write",
      aliases: [],
      audience: "public",
      stability: "experimental",
      summary: "Append or update a local/private project learning entry.",
      sideEffect: "write",
      inputs: [
        {
          id: "source",
          token: "--source",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "learnings",
          token: "--learnings",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "id",
          token: "--id",
          valueType: "text",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "summary",
          token: "--summary",
          valueType: "text",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "source-entry",
          token: "--source-entry",
          valueType: "text",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "dry-run",
          token: "--dry-run",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "json",
          token: "--json",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "strict",
          token: "--strict",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help",
          token: "--help",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: false,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help-short",
          token: "-h",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: { facade: "unsupported", standalone: "idempotent" },
          applicationInput: false,
          cliSurfaces: ["standalone"],
        },
      ],
      permissions: ["policy.local.read", "policy.local.write"],
      effects: ["filesystem-read", "filesystem-write"],
      applicationHandler: "project-learnings.write",
      result: {
        schemaVersion: 1,
        type: "project-learnings-write-result",
        schema: "schema/project-learnings-write-result.schema.json",
      },
      surfaces: {
        cli: "active",
        mcp: "unsupported",
      },
      observedExit: {
        resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 1 },
        thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
      },
      observedErrors: {
        kind: "legacy-prose",
        facadeAndStandaloneMayDiffer: true,
      },
    });
    expect(serializeCommandSpecV1(PROJECT_LEARNINGS_WRITE_COMMAND_SPEC)).toBe(
      `${JSON.stringify(PROJECT_LEARNINGS_WRITE_COMMAND_SPEC, null, 2)}\n`,
    );
  });

  test("publishes the exact registry-trust evaluation contract", () => {
    expect(REGISTRY_TRUST_COMMAND_SPEC).toEqual({
      schemaVersion: 1,
      id: "trust.registry.evaluate",
      name: "registry-trust",
      aliases: ["registry-trust-score", "trust-score"],
      audience: "public",
      stability: "experimental",
      summary:
        "Score registry trust from a local scorecard and validated registry surface.",
      sideEffect: "read",
      inputs: [
        {
          id: "source",
          token: "--source",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "scorecard",
          token: "--scorecard",
          valueType: "path",
          required: true,
          default: null,
          repeat: { facade: "last", standalone: "last" },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "json",
          token: "--json",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "strict",
          token: "--strict",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: true,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help",
          token: "--help",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: {
            facade: "drop-to-default-on-repeat",
            standalone: "idempotent",
          },
          applicationInput: false,
          cliSurfaces: ["facade", "standalone"],
        },
        {
          id: "help-short",
          token: "-h",
          valueType: "boolean",
          required: false,
          default: false,
          repeat: { facade: "unsupported", standalone: "idempotent" },
          applicationInput: false,
          cliSurfaces: ["standalone"],
        },
      ],
      permissions: ["policy.local.read"],
      effects: ["filesystem-read"],
      applicationHandler: "registry-trust.evaluate",
      result: {
        schemaVersion: 1,
        type: "registry-trust-result",
        schema: "schema/registry-trust-result.schema.json",
      },
      surfaces: {
        cli: "active",
        mcp: "unsupported",
      },
      observedExit: {
        resultStatuses: { PASS: 0, CONCERNS: 0, BLOCKED: 0 },
        thrownError: { exitCode: 1, stderrPrefix: "ERROR: " },
      },
      observedErrors: {
        kind: "legacy-prose",
        facadeAndStandaloneMayDiffer: true,
      },
    });
    expect(serializeCommandSpecV1(REGISTRY_TRUST_COMMAND_SPEC)).toBe(
      `${JSON.stringify(REGISTRY_TRUST_COMMAND_SPEC, null, 2)}\n`,
    );
  });

  test("declares free-text inputs without forcing path or boolean policy", () => {
    for (const input of PROJECT_LEARNINGS_WRITE_COMMAND_SPEC.inputs) {
      if (input.id === "id" || input.id === "summary" || input.id === "source-entry") {
        expect(input.valueType).toBe("text");
        expect(input.default).toBeNull();
        expect(input.required).toBe(true);
        expect(input.applicationInput).toBe(true);
      }
    }

    const optionalText = mutableProjectLearningsWriteSpec();
    (optionalText.inputs as Record<string, unknown>[])[2]!.required = false;
    expect(validateCommandSpecV1(optionalText)).toBeTruthy();

    const textWithBooleanDefault = mutableProjectLearningsWriteSpec();
    (textWithBooleanDefault.inputs as Record<string, unknown>[])[2]!.default = false;
    expect(() => validateCommandSpecV1(textWithBooleanDefault)).toThrow(
      CommandSpecValidationError,
    );

    const textWithShortToken = mutableProjectLearningsWriteSpec();
    (textWithShortToken.inputs as Record<string, unknown>[])[2]!.token = "-i";
    expect(() => validateCommandSpecV1(textWithShortToken)).toThrow(
      CommandSpecValidationError,
    );
  });

  test("returns detached deeply frozen values", () => {
    const raw = mutableTelemetrySpec();
    const validated = validateCommandSpecV1(raw);
    const second = createTelemetryPolicyCommandSpec();

    expect(validated).toEqual(TELEMETRY_POLICY_COMMAND_SPEC);
    expect(validated).not.toBe(raw);
    expect(second).not.toBe(TELEMETRY_POLICY_COMMAND_SPEC);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.inputs)).toBe(true);
    expect(Object.isFrozen(validated.inputs[0])).toBe(true);
    expect(Object.isFrozen(validated.inputs[0]!.repeat)).toBe(true);
    expect(Object.isFrozen(validated.observedExit.resultStatuses)).toBe(true);

    (raw.aliases as string[])[0] = "changed";
    ((raw.inputs as Record<string, unknown>[])[0]!.cliSurfaces as string[])[0] =
      "changed";
    expect(validated.aliases).toEqual(["telemetry"]);
    expect(validated.inputs[0]!.cliSurfaces).toEqual(["facade", "standalone"]);

    const team = createTeamModeCommandSpec();
    expect(team).toEqual(TEAM_MODE_COMMAND_SPEC);
    expect(team).not.toBe(TEAM_MODE_COMMAND_SPEC);
    expect(Object.isFrozen(team.inputs[0]!.repeat)).toBe(true);

    const memory = createMemoryAdapterCommandSpec();
    expect(memory).toEqual(MEMORY_ADAPTER_COMMAND_SPEC);
    expect(memory).not.toBe(MEMORY_ADAPTER_COMMAND_SPEC);
    expect(Object.isFrozen(memory.aliases)).toBe(true);
    expect(Object.isFrozen(memory.inputs)).toBe(true);
    expect(Object.isFrozen(memory.inputs[0])).toBe(true);
    expect(Object.isFrozen(memory.inputs[0]!.repeat)).toBe(true);
    expect(Object.isFrozen(memory.result)).toBe(true);
    expect(Object.isFrozen(memory.observedExit.resultStatuses)).toBe(true);

    const memoryRead = createMemoryAdapterReadCommandSpec();
    expect(memoryRead).toEqual(MEMORY_ADAPTER_READ_COMMAND_SPEC);
    expect(memoryRead).not.toBe(MEMORY_ADAPTER_READ_COMMAND_SPEC);
    expect(Object.isFrozen(memoryRead.aliases)).toBe(true);
    expect(Object.isFrozen(memoryRead.inputs)).toBe(true);
    expect(Object.isFrozen(memoryRead.inputs[0])).toBe(true);
    expect(Object.isFrozen(memoryRead.inputs[0]!.repeat)).toBe(true);
    expect(Object.isFrozen(memoryRead.result)).toBe(true);
    expect(Object.isFrozen(memoryRead.observedExit.resultStatuses)).toBe(true);

    const memoryWrite = createMemoryAdapterWriteCommandSpec();
    expect(memoryWrite).toEqual(MEMORY_ADAPTER_WRITE_COMMAND_SPEC);
    expect(memoryWrite).not.toBe(MEMORY_ADAPTER_WRITE_COMMAND_SPEC);
    expect(Object.isFrozen(memoryWrite.aliases)).toBe(true);
    expect(Object.isFrozen(memoryWrite.inputs)).toBe(true);
    expect(Object.isFrozen(memoryWrite.inputs[0])).toBe(true);
    expect(Object.isFrozen(memoryWrite.inputs[0]!.repeat)).toBe(true);
    expect(Object.isFrozen(memoryWrite.result)).toBe(true);
    expect(Object.isFrozen(memoryWrite.observedExit.resultStatuses)).toBe(true);

    const learnings = createProjectLearningsCommandSpec();
    expect(learnings).toEqual(PROJECT_LEARNINGS_COMMAND_SPEC);
    expect(learnings).not.toBe(PROJECT_LEARNINGS_COMMAND_SPEC);
    expect(Object.isFrozen(learnings.aliases)).toBe(true);
    expect(Object.isFrozen(learnings.inputs)).toBe(true);
    expect(Object.isFrozen(learnings.inputs[0])).toBe(true);
    expect(Object.isFrozen(learnings.inputs[0]!.repeat)).toBe(true);
    expect(Object.isFrozen(learnings.result)).toBe(true);
    expect(Object.isFrozen(learnings.observedExit.resultStatuses)).toBe(true);

    const learningsWrite = createProjectLearningsWriteCommandSpec();
    expect(learningsWrite).toEqual(PROJECT_LEARNINGS_WRITE_COMMAND_SPEC);
    expect(learningsWrite).not.toBe(PROJECT_LEARNINGS_WRITE_COMMAND_SPEC);
    expect(Object.isFrozen(learningsWrite.aliases)).toBe(true);
    expect(Object.isFrozen(learningsWrite.inputs)).toBe(true);
    expect(Object.isFrozen(learningsWrite.inputs[0])).toBe(true);
    expect(Object.isFrozen(learningsWrite.inputs[0]!.repeat)).toBe(true);
    expect(Object.isFrozen(learningsWrite.result)).toBe(true);
    expect(Object.isFrozen(learningsWrite.observedExit.resultStatuses)).toBe(true);

    const registryTrust = createRegistryTrustCommandSpec();
    expect(registryTrust).toEqual(REGISTRY_TRUST_COMMAND_SPEC);
    expect(registryTrust).not.toBe(REGISTRY_TRUST_COMMAND_SPEC);
    expect(Object.isFrozen(registryTrust.aliases)).toBe(true);
    expect(Object.isFrozen(registryTrust.inputs)).toBe(true);
    expect(Object.isFrozen(registryTrust.inputs[0])).toBe(true);
    expect(Object.isFrozen(registryTrust.inputs[0]!.repeat)).toBe(true);
    expect(Object.isFrozen(registryTrust.result)).toBe(true);
    expect(Object.isFrozen(registryTrust.observedExit.resultStatuses)).toBe(
      true,
    );
  });

  test("resolves the canonical name and alias to the same semantic spec", () => {
    const registry = validateCommandSpecRegistry([
      TELEMETRY_POLICY_COMMAND_SPEC,
      TEAM_MODE_COMMAND_SPEC,
      MEMORY_ADAPTER_COMMAND_SPEC,
      MEMORY_ADAPTER_READ_COMMAND_SPEC,
      MEMORY_ADAPTER_WRITE_COMMAND_SPEC,
      PROJECT_LEARNINGS_COMMAND_SPEC,
      PROJECT_LEARNINGS_WRITE_COMMAND_SPEC,
      REGISTRY_TRUST_COMMAND_SPEC,
    ]);

    expect(resolveCommandSpec(registry, "telemetry-policy")?.id).toBe(
      "policy.telemetry.validate",
    );
    expect(resolveCommandSpec(registry, "telemetry")?.id).toBe(
      "policy.telemetry.validate",
    );
    expect(resolveCommandSpec(registry, "team-mode")?.id).toBe(
      "policy.team-mode.validate",
    );
    expect(resolveCommandSpec(registry, "team")?.id).toBe(
      "policy.team-mode.validate",
    );
    expect(resolveCommandSpec(registry, "memory-adapter")?.id).toBe(
      "memory.adapter.validate",
    );
    expect(resolveCommandSpec(registry, "memory")?.id).toBe(
      "memory.adapter.validate",
    );
    expect(resolveCommandSpec(registry, "memory-adapter-read")?.id).toBe(
      "memory.adapter.read",
    );
    expect(resolveCommandSpec(registry, "memory-adapter-write")?.id).toBe(
      "memory.adapter.write",
    );
    expect(resolveCommandSpec(registry, "project-learnings")?.id).toBe(
      "project.learnings.validate",
    );
    expect(resolveCommandSpec(registry, "learnings")?.id).toBe(
      "project.learnings.validate",
    );
    expect(resolveCommandSpec(registry, "project-learnings-write")?.id).toBe(
      "project.learnings.write",
    );
    expect(resolveCommandSpec(registry, "registry-trust")?.id).toBe(
      "trust.registry.evaluate",
    );
    expect(resolveCommandSpec(registry, "registry-trust-score")?.id).toBe(
      "trust.registry.evaluate",
    );
    expect(resolveCommandSpec(registry, "trust-score")?.id).toBe(
      "trust.registry.evaluate",
    );
    expect(resolveCommandSpec(registry, "missing")).toBeNull();
  });

  test("projects a detached frozen legacy registry observation", () => {
    const projection = projectCommandSpecToLegacyObservation(
      TELEMETRY_POLICY_COMMAND_SPEC,
    );

    expect(projection).toEqual({
      name: "telemetry-policy",
      aliases: ["telemetry"],
      audience: "public",
      summary:
        "Validate local telemetry policy opt-in gates without collecting telemetry.",
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.aliases)).toBe(true);
    expect(projection.aliases).not.toBe(
      TELEMETRY_POLICY_COMMAND_SPEC.aliases,
    );

    expect(
      projectCommandSpecToLegacyObservation(TEAM_MODE_COMMAND_SPEC),
    ).toEqual({
      name: "team-mode",
      aliases: ["team"],
      audience: "public",
      summary:
        "Validate deterministic team-mode config without packaging catalogs or enabling symlink installs.",
    });
    expect(
      projectCommandSpecToLegacyObservation(MEMORY_ADAPTER_COMMAND_SPEC),
    ).toEqual({
      name: "memory-adapter",
      aliases: ["memory"],
      audience: "public",
      summary:
        "Validate local/private memory adapter interfaces without invoking them.",
    });
    expect(
      projectCommandSpecToLegacyObservation(MEMORY_ADAPTER_READ_COMMAND_SPEC),
    ).toEqual({
      name: "memory-adapter-read",
      aliases: [],
      audience: "public",
      summary:
        "Read memory records from a local/private JSONL memory adapter under explicit trust policy.",
    });
    expect(
      projectCommandSpecToLegacyObservation(MEMORY_ADAPTER_WRITE_COMMAND_SPEC),
    ).toEqual({
      name: "memory-adapter-write",
      aliases: [],
      audience: "public",
      summary:
        "Append a memory record to a local/private JSONL memory adapter under explicit trust policy.",
    });
    expect(
      projectCommandSpecToLegacyObservation(PROJECT_LEARNINGS_COMMAND_SPEC),
    ).toEqual({
      name: "project-learnings",
      aliases: ["learnings"],
      audience: "public",
      summary: "Validate local/private project learnings without publishing them.",
    });
    expect(
      projectCommandSpecToLegacyObservation(PROJECT_LEARNINGS_WRITE_COMMAND_SPEC),
    ).toEqual({
      name: "project-learnings-write",
      aliases: [],
      audience: "public",
      summary: "Append or update a local/private project learning entry.",
    });
    expect(
      projectCommandSpecToLegacyObservation(REGISTRY_TRUST_COMMAND_SPEC),
    ).toEqual({
      name: "registry-trust",
      aliases: ["registry-trust-score", "trust-score"],
      audience: "public",
      summary:
        "Score registry trust from a local scorecard and validated registry surface.",
    });
  });

  test("drives the existing telemetry registry record without changing its position", () => {
    const telemetryIndex = SKILL_SYS_COMMANDS.findIndex(
      (command) => command.name === "telemetry-policy",
    );

    expect(telemetryIndex).toBe(17);
    expect(SKILL_SYS_COMMANDS[telemetryIndex]).toEqual({
      name: "telemetry-policy",
      aliases: ["telemetry"],
      audience: "public",
      summary:
        "Validate local telemetry policy opt-in gates without collecting telemetry.",
    });
    expect(
      SKILL_SYS_COMMANDS.filter(
        (command) =>
          command.name === "telemetry-policy" ||
          command.aliases.includes("telemetry"),
      ),
    ).toHaveLength(1);
  });

  test("drives the team-mode registry record without changing its position", () => {
    const teamModeIndex = SKILL_SYS_COMMANDS.findIndex(
      (command) => command.name === "team-mode",
    );

    expect(teamModeIndex).toBe(25);
    expect(SKILL_SYS_COMMANDS[teamModeIndex]).toEqual({
      name: "team-mode",
      aliases: ["team"],
      audience: "public",
      summary:
        "Validate deterministic team-mode config without packaging catalogs or enabling symlink installs.",
    });
    expect(
      SKILL_SYS_COMMANDS.filter(
        (command) =>
          command.name === "team-mode" || command.aliases.includes("team"),
      ),
    ).toHaveLength(1);
  });

  test("drives the memory-adapter registry record without changing its position", () => {
    const memoryAdapterIndex = SKILL_SYS_COMMANDS.findIndex(
      (command) => command.name === "memory-adapter",
    );

    expect(memoryAdapterIndex).toBe(28);
    expect(SKILL_SYS_COMMANDS[memoryAdapterIndex]).toEqual({
      name: "memory-adapter",
      aliases: ["memory"],
      audience: "public",
      summary:
        "Validate local/private memory adapter interfaces without invoking them.",
    });
    expect(
      SKILL_SYS_COMMANDS.filter(
        (command) =>
          command.name === "memory-adapter" ||
          command.aliases.includes("memory"),
      ),
    ).toHaveLength(1);
  });

  test("drives the project-learnings registry record without changing its position", () => {
    const projectLearningsIndex = SKILL_SYS_COMMANDS.findIndex(
      (command) => command.name === "project-learnings",
    );

    expect(projectLearningsIndex).toBe(27);
    expect(SKILL_SYS_COMMANDS[projectLearningsIndex]).toEqual({
      name: "project-learnings",
      aliases: ["learnings"],
      audience: "public",
      summary: "Validate local/private project learnings without publishing them.",
    });
    expect(
      SKILL_SYS_COMMANDS.filter(
        (command) =>
          command.name === "project-learnings" ||
          command.aliases.includes("learnings"),
      ),
    ).toHaveLength(1);
  });

  test("drives the registry-trust record without changing index 16", () => {
    const registryTrustIndex = SKILL_SYS_COMMANDS.findIndex(
      (command) => command.name === "registry-trust",
    );

    expect(registryTrustIndex).toBe(16);
    expect(SKILL_SYS_COMMANDS[registryTrustIndex]).toEqual({
      name: "registry-trust",
      aliases: ["registry-trust-score", "trust-score"],
      audience: "public",
      summary:
        "Score registry trust from a local scorecard and validated registry surface.",
    });
    expect(
      SKILL_SYS_COMMANDS.filter(
        (command) =>
          command.name === "registry-trust" ||
          command.aliases.includes("registry-trust-score") ||
          command.aliases.includes("trust-score"),
      ),
    ).toHaveLength(1);
  });

  test("preserves every unmigrated legacy registry observation exactly", () => {
    expect(SKILL_SYS_COMMANDS).toHaveLength(49);
    const unmigrated = SKILL_SYS_COMMANDS.filter(
      (command) =>
        command.name !== "telemetry-policy" &&
        command.name !== "team-mode" &&
        command.name !== "memory-adapter" &&
        command.name !== "project-learnings" &&
        command.name !== "registry-trust",
    );

    expect(unmigrated).toHaveLength(44);
    expect(
      createHash("sha256")
        .update(JSON.stringify(unmigrated))
        .digest("hex"),
    ).toBe("129512c72a5c40adc2db0226586d39511f91f174fe18568f3039e1517067a40b");
  });

  test("fails closed for malformed, unknown, exotic, and unsupported data", () => {
    const unknown = mutableTelemetrySpec();
    unknown.extra = true;

    const unsupported = mutableTelemetrySpec();
    unsupported.schemaVersion = 2;

    const unsafeId = mutableTelemetrySpec();
    unsafeId.id = "../../private";

    const nonFinite = mutableTelemetrySpec();
    (nonFinite.observedExit as Record<string, unknown>).thrownError = {
      exitCode: Number.POSITIVE_INFINITY,
      stderrPrefix: "ERROR: ",
    };

    const sparse = mutableTelemetrySpec();
    const sparseAliases = new Array<string>(2);
    sparseAliases[1] = "telemetry";
    sparse.aliases = sparseAliases;

    const symbol = mutableTelemetrySpec();
    Object.defineProperty(symbol, Symbol("hidden"), {
      enumerable: true,
      value: "secret",
    });

    const accessor = mutableTelemetrySpec();
    Object.defineProperty(accessor, "summary", {
      enumerable: true,
      get: () => "secret",
    });

    const deeplyNested = mutableTelemetrySpec();
    let nested: Record<string, unknown> = {};
    deeplyNested.extra = nested;
    for (let index = 0; index < 20_000; index += 1) {
      const child: Record<string, unknown> = {};
      nested.next = child;
      nested = child;
    }
    let proxyTrapCalls = 0;
    const trappedProxy = new Proxy(mutableTelemetrySpec(), {
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error("must not execute");
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("must not execute");
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("must not execute");
      },
    });

    const values: unknown[] = [
      null,
      () => undefined,
      unknown,
      unsupported,
      unsafeId,
      nonFinite,
      sparse,
      symbol,
      accessor,
      deeplyNested,
      trappedProxy,
    ];
    for (const value of values) {
      expect(() => validateCommandSpecV1(value)).toThrow(
        CommandSpecValidationError,
      );
    }
    expect(proxyTrapCalls).toBe(0);
  });

  test("rejects invalid input defaults, repeat policies, duplicates, and capabilities", () => {
    const duplicateId = mutableTelemetrySpec();
    (duplicateId.inputs as Record<string, unknown>[])[1]!.id = "source";

    const duplicateToken = mutableTelemetrySpec();
    (duplicateToken.inputs as Record<string, unknown>[])[1]!.token = "--source";

    const invalidPathDefault = mutableTelemetrySpec();
    (invalidPathDefault.inputs as Record<string, unknown>[])[0]!.default = false;

    const invalidBooleanRepeat = mutableTelemetrySpec();
    (invalidBooleanRepeat.inputs as Record<string, unknown>[])[2]!.repeat = {
      facade: "drop-to-default-on-repeat",
      standalone: "last",
    };

    const mutation = mutableTelemetrySpec();
    mutation.effects = ["filesystem-write"];

    const processExecution = mutableTelemetrySpec();
    processExecution.effects = ["process-execution"];

    const missingPermission = mutableTelemetrySpec();
    missingPermission.permissions = [];

    const extraPermission = mutableTelemetrySpec();
    extraPermission.permissions = ["policy.local.read", "policy.local.write"];

    const missingEffect = mutableTelemetrySpec();
    missingEffect.effects = [];

    const unknownHandler = mutableTelemetrySpec();
    unknownHandler.applicationHandler = "private.execute";

    const externalSchema = mutableTelemetrySpec();
    (externalSchema.result as Record<string, unknown>).schema =
      "../../private.schema.json";

    const unsupportedTransport = mutableTelemetrySpec();
    unsupportedTransport.surfaces = { cli: "active", mcp: "active" };

    const wrongTeamPermission = mutableTeamModeSpec();
    wrongTeamPermission.permissions = ["policy.team.read"];

    const swappedTeamResult = mutableTeamModeSpec();
    swappedTeamResult.result = clone(TELEMETRY_POLICY_COMMAND_SPEC.result);

    const swappedTelemetryResult = mutableTelemetrySpec();
    swappedTelemetryResult.result = clone(TEAM_MODE_COMMAND_SPEC.result);

    const wrongMemoryPermission = mutableMemoryAdapterSpec();
    wrongMemoryPermission.permissions = ["memory.local.read"];

    const swappedMemoryResult = mutableMemoryAdapterSpec();
    swappedMemoryResult.result = clone(TEAM_MODE_COMMAND_SPEC.result);

    const memoryHandlerWithTelemetryResult = mutableMemoryAdapterSpec();
    memoryHandlerWithTelemetryResult.result = clone(
      TELEMETRY_POLICY_COMMAND_SPEC.result,
    );

    const memoryWithTeamHandler = mutableMemoryAdapterSpec();
    memoryWithTeamHandler.applicationHandler = "team-mode.validate";

    const wrongMemoryReadPermission = mutableMemoryAdapterReadSpec();
    wrongMemoryReadPermission.permissions = ["memory.local.read"];

    const swappedMemoryReadResult = mutableMemoryAdapterReadSpec();
    swappedMemoryReadResult.result = clone(TEAM_MODE_COMMAND_SPEC.result);

    const memoryReadWithValidateHandler = mutableMemoryAdapterReadSpec();
    memoryReadWithValidateHandler.applicationHandler = "memory-adapter.validate";

    const wrongMemoryWritePermission = mutableMemoryAdapterWriteSpec();
    wrongMemoryWritePermission.permissions = [
      "policy.local.write",
      "policy.local.read",
    ];

    const missingMemoryWriteEffect = mutableMemoryAdapterWriteSpec();
    missingMemoryWriteEffect.effects = ["filesystem-read"];

    const swappedMemoryWriteResult = mutableMemoryAdapterWriteSpec();
    swappedMemoryWriteResult.result = clone(PROJECT_LEARNINGS_COMMAND_SPEC.result);

    const memoryWriteWithReadHandler = mutableMemoryAdapterWriteSpec();
    memoryWriteWithReadHandler.applicationHandler = "memory-adapter.validate";

    const wrongLearningsPermission = mutableProjectLearningsSpec();
    wrongLearningsPermission.permissions = [
      "policy.local.write",
      "policy.local.write",
    ];

    const swappedLearningsResult = mutableProjectLearningsSpec();
    swappedLearningsResult.result = clone(MEMORY_ADAPTER_COMMAND_SPEC.result);

    const learningsWithMemoryHandler = mutableProjectLearningsSpec();
    learningsWithMemoryHandler.applicationHandler = "memory-adapter.validate";

    const wrongWritePermission = mutableProjectLearningsWriteSpec();
    wrongWritePermission.permissions = [
      "policy.local.write",
      "policy.local.read",
    ];

    const missingWriteEffect = mutableProjectLearningsWriteSpec();
    missingWriteEffect.effects = ["filesystem-read"];

    const swappedWriteResult = mutableProjectLearningsWriteSpec();
    swappedWriteResult.result = clone(PROJECT_LEARNINGS_COMMAND_SPEC.result);

    const writeWithReadHandler = mutableProjectLearningsWriteSpec();
    writeWithReadHandler.applicationHandler = "project-learnings.validate";

    const wrongRegistryTrustPermission = mutableRegistryTrustSpec();
    wrongRegistryTrustPermission.permissions = ["trust.local.read"];

    const swappedRegistryTrustResult = mutableRegistryTrustSpec();
    swappedRegistryTrustResult.result = clone(
      PROJECT_LEARNINGS_COMMAND_SPEC.result,
    );

    const registryTrustWithLearningsHandler = mutableRegistryTrustSpec();
    registryTrustWithLearningsHandler.applicationHandler =
      "project-learnings.validate";

    for (const value of [
      duplicateId,
      duplicateToken,
      invalidPathDefault,
      invalidBooleanRepeat,
      mutation,
      processExecution,
      missingPermission,
      extraPermission,
      missingEffect,
      unknownHandler,
      externalSchema,
      unsupportedTransport,
      wrongTeamPermission,
      swappedTeamResult,
      swappedTelemetryResult,
      wrongMemoryPermission,
      swappedMemoryResult,
      memoryHandlerWithTelemetryResult,
      memoryWithTeamHandler,
      wrongMemoryReadPermission,
      swappedMemoryReadResult,
      memoryReadWithValidateHandler,
      wrongMemoryWritePermission,
      missingMemoryWriteEffect,
      swappedMemoryWriteResult,
      memoryWriteWithReadHandler,
      wrongLearningsPermission,
      swappedLearningsResult,
      learningsWithMemoryHandler,
      wrongWritePermission,
      missingWriteEffect,
      swappedWriteResult,
      writeWithReadHandler,
      wrongRegistryTrustPermission,
      swappedRegistryTrustResult,
      registryTrustWithLearningsHandler,
    ]) {
      expect(() => validateCommandSpecV1(value)).toThrow(
        CommandSpecValidationError,
      );
    }
  });

  test("rejects migrated and legacy token/identity collisions", () => {
    const duplicateId = mutableTelemetrySpec();
    duplicateId.name = "other";
    duplicateId.aliases = [];

    const duplicateHandler = mutableTelemetrySpec();
    duplicateHandler.id = "policy.other.validate";
    duplicateHandler.name = "other";
    duplicateHandler.aliases = [];

    const aliasCollision = mutableTelemetrySpec();
    aliasCollision.id = "policy.other.validate";
    aliasCollision.name = "other";
    aliasCollision.aliases = ["telemetry"];
    aliasCollision.applicationHandler = "telemetry-policy.validate";

    expect(() =>
      validateCommandSpecRegistry([
        TELEMETRY_POLICY_COMMAND_SPEC,
        duplicateId,
      ]),
    ).toThrow(CommandSpecValidationError);
    expect(() =>
      validateCommandSpecRegistry([
        TELEMETRY_POLICY_COMMAND_SPEC,
        duplicateHandler,
      ]),
    ).toThrow(CommandSpecValidationError);
    expect(() =>
      validateCommandSpecRegistry([
        TELEMETRY_POLICY_COMMAND_SPEC,
        aliasCollision,
      ]),
    ).toThrow(CommandSpecValidationError);
    expect(() =>
      validateCommandSpecRegistry([
        TELEMETRY_POLICY_COMMAND_SPEC,
        TEAM_MODE_COMMAND_SPEC,
        MEMORY_ADAPTER_COMMAND_SPEC,
        PROJECT_LEARNINGS_COMMAND_SPEC,
        REGISTRY_TRUST_COMMAND_SPEC,
        mutableTeamModeSpec(),
      ]),
    ).toThrow(CommandSpecValidationError);
    expect(() =>
      validateCommandSpecRegistry([TELEMETRY_POLICY_COMMAND_SPEC], [
        {
          name: "add",
          aliases: ["get", "telemetry"],
          audience: "public",
          summary: "Observed legacy command.",
        },
      ]),
    ).toThrow(CommandSpecValidationError);
    expect(() =>
      validateCommandSpecRegistry([MEMORY_ADAPTER_COMMAND_SPEC], [
        {
          name: "other",
          aliases: ["memory"],
          audience: "public",
          summary: "Must not take the migrated memory alias.",
        },
      ]),
    ).toThrow(CommandSpecValidationError);
    expect(() =>
      validateCommandSpecRegistry([PROJECT_LEARNINGS_COMMAND_SPEC], [
        {
          name: "other",
          aliases: ["learnings"],
          audience: "public",
          summary: "Must not take the migrated learnings alias.",
        },
      ]),
    ).toThrow(CommandSpecValidationError);
    expect(() =>
      validateCommandSpecRegistry([REGISTRY_TRUST_COMMAND_SPEC], [
        {
          name: "other",
          aliases: ["trust-score"],
          audience: "public",
          summary: "Must not take a migrated registry trust alias.",
        },
      ]),
    ).toThrow(CommandSpecValidationError);
    expect(() =>
      validateCommandSpecRegistry([REGISTRY_TRUST_COMMAND_SPEC], [
        {
          name: "other",
          aliases: ["registry-trust-score"],
          audience: "public",
          summary: "Must not take the other migrated registry trust alias.",
        },
      ]),
    ).toThrow(CommandSpecValidationError);
    const legacy = {
      name: "add",
      aliases: ["get"],
      audience: "public" as const,
      summary: "Observed legacy command.",
    };
    expect(() =>
      validateCommandSpecRegistry(
        [TELEMETRY_POLICY_COMMAND_SPEC],
        [legacy, structuredClone(legacy)],
      ),
    ).toThrow(CommandSpecValidationError);
    expect(() =>
      validateCommandSpecRegistry([TELEMETRY_POLICY_COMMAND_SPEC], [
        legacy,
        {
          name: "other",
          aliases: ["get"],
          audience: "compatibility",
          summary: "Must not reassign the existing get alias.",
        },
      ]),
    ).toThrow(CommandSpecValidationError);
  });

  test("does not reflect sensitive values in validation errors", () => {
    const secretValue = ["top", "secret"].join("-");
    const secret = ["", "home", "fixture-user", `password=${secretValue}`].join("/");
    const invalid = mutableTelemetrySpec();
    invalid.id = secret;

    try {
      validateCommandSpecV1(invalid);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandSpecValidationError);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(secretValue);
    }
  });
});
