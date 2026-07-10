import { join, resolve } from "node:path";
import type {
  CodexModelConfig,
  CodexReasoningEffort,
  CodexReasoningSummary,
} from "../agent-server/codex/model-config.js";
import { readJsonFile } from "../core/fs.js";
import { CodexAssetLayout } from "./asset-layout.js";
import type {
  AgentProfile,
  AgentProfileDefinition,
  AgentProfilesFile,
} from "./types.js";

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

export function readAgentProfilesForRepo(repoRoot: string): AgentProfilesFile {
  const assetsRoot = join(resolve(repoRoot), "assets", "codex");
  return readJsonFile<AgentProfilesFile>(join(assetsRoot, CodexAssetLayout.agentProfiles));
}

export function resolveDefaultAgentModel(profiles: AgentProfilesFile): CodexModelConfig {
  return normalizeModelConfig(profiles.defaults?.model, "agent profile default model");
}

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
  return {
    config: profile.config,
    model,
    skills: [...profile.skills],
    shellTools: [...(profile.shellTools ?? [])],
    mcpServers: [...profile.mcpServers],
    plugins: [...profile.plugins],
    trustedRoots: [...(profile.trustedRoots ?? [])],
    writableRoots: [...(profile.writableRoots ?? [])],
  };
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
