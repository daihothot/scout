/**
 * Loads profile assets and enforces the runtime schema before mount assembly.
 * Profile files provide declarations; this module does not grant permissions
 * or choose which lifecycle stage consumes them.
 */
import { join, resolve } from "node:path";
import type {
  CodexModelConfig,
  CodexReasoningEffort,
  CodexReasoningSummary,
} from "../../agent-server/codex/model-config.js";
import {
  ScoutAgentPhases,
  type ScoutAgentPhase,
} from "../../agent/thread/types.js";
import { readJsonFile } from "../../core/fs.js";
import { CodexAssetLayout } from "./asset-layout.js";
import type {
  AgentProfile,
  AgentProfileDefinition,
  AgentProfilesFile,
} from "../contracts/profile.js";

/** Provider reasoning-effort values accepted by profile validation. */
const reasoningEfforts = new Set<CodexReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const reasoningSummaries = new Set<CodexReasoningSummary>([
  "auto",
  "concise",
  "detailed",
  "none",
]);
const agentPhases = new Set<ScoutAgentPhase>(Object.values(ScoutAgentPhases));

/** Loads the agent profile document rooted at `scoutRoot/assets/codex`. */
export function readAgentProfilesForScoutRoot(scoutRoot: string): AgentProfilesFile {
  const assetsRoot = join(resolve(scoutRoot), "assets", "codex");
  return readJsonFile<AgentProfilesFile>(join(assetsRoot, CodexAssetLayout.agentProfiles));
}

/** Validates and returns the model selected by the profile defaults section. */
export function resolveDefaultAgentModel(profiles: AgentProfilesFile): CodexModelConfig {
  return normalizeModelConfig(profiles.defaults?.model, "agent profile default model");
}

/** Resolves one named agent profile, applying and validating its model override. */
export function resolveAgentProfile(
  profiles: AgentProfilesFile,
  agentId: string,
): AgentProfile {
  const definition = profiles.profiles[agentId];
  if (!definition) {
    throw new Error(`No agent profile configured for agent: ${agentId}`);
  }
  const model = definition.model
    ? normalizeModelConfig(definition.model, `model for agent ${agentId}`)
    : resolveDefaultAgentModel(profiles);
  return cloneAgentProfile(definition, model);
}

function cloneAgentProfile(
  profile: AgentProfileDefinition,
  model: CodexModelConfig,
): AgentProfile {
  if (
    !Array.isArray(profile.customAgents)
    || profile.customAgents.some((name) => typeof name !== "string" || name.trim().length === 0)
  ) {
    throw new Error("Missing or invalid agent profile customAgents.");
  }
  return {
    config: profile.config,
    multiAgent: requireBoolean(profile.multiAgent, "agent profile multiAgent"),
    maxThreads: requireInteger(profile.maxThreads, "agent profile maxThreads", 1),
    maxDepth: requireInteger(profile.maxDepth, "agent profile maxDepth", 0),
    customAgents: profile.customAgents.map((name) => name.trim()),
    model,
    phase: requireAgentPhase(profile.phase),
    shellTools: [...(profile.shellTools ?? [])],
    mcpServers: [...profile.mcpServers],
    plugins: [...profile.plugins],
    readableRoots: [...(profile.readableRoots ?? [])],
    writableRoots: [...(profile.writableRoots ?? [])],
  };
}

function requireAgentPhase(value: unknown): ScoutAgentPhase {
  if (typeof value !== "string" || !agentPhases.has(value as ScoutAgentPhase)) {
    throw new Error("Missing or invalid agent profile phase.");
  }
  return value as ScoutAgentPhase;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Missing or invalid ${label}.`);
  }
  return value;
}

function requireInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new Error(`Missing or invalid ${label}.`);
  }
  return value;
}

function normalizeModelConfig(value: unknown, label: string): CodexModelConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Missing or invalid ${label}.`);
  }
  const id = requireNonEmptyString(value.id, `${label}.id`);
  const provider = requireNonEmptyString(value.provider, `${label}.provider`);
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) {
    throw new Error(`Invalid ${label}.provider: ${provider}`);
  }
  const reasoningEffort = requireNonEmptyString(
    value.reasoningEffort,
    `${label}.reasoningEffort`,
  ) as CodexReasoningEffort;
  const reasoningSummary = requireNonEmptyString(
    value.reasoningSummary,
    `${label}.reasoningSummary`,
  ) as CodexReasoningSummary;
  if (!reasoningEfforts.has(reasoningEffort)) {
    throw new Error(`Unsupported ${label}.reasoningEffort: ${reasoningEffort}`);
  }
  if (!reasoningSummaries.has(reasoningSummary)) {
    throw new Error(`Unsupported ${label}.reasoningSummary: ${reasoningSummary}`);
  }
  return {
    id,
    provider,
    reasoningEffort,
    reasoningSummary,
  };
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing or invalid ${label}.`);
  }
  return value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
