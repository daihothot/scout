import type {
  AgentDynamicToolSpec,
  AgentJsonValue,
} from "../tools/types.js";
import type { CodexModelConfig } from "../../agent-server/codex/model-config.js";
import type { ScoutAgentThreadPreflightSnapshot } from "./thread-preflight.js";

export const ScoutAgentRoles = {
  Coordinator: "coordinator",
  Researcher: "researcher",
  Verifier: "verifier",
  Validator: "validator",
} as const;

export type ScoutAgentRole = typeof ScoutAgentRoles[keyof typeof ScoutAgentRoles];

export const ScoutAgentPhases = {
  Coordinate: "coordinate",
  Research: "research",
  Verify: "verify",
  Validate: "validate",
} as const;

export type ScoutAgentPhase = typeof ScoutAgentPhases[keyof typeof ScoutAgentPhases];

export interface AgentThreadSpec {
  role: ScoutAgentRole;
  phases: ScoutAgentPhase[];
  cwd: string;
  approvalPolicy: "never";
  sandbox: "read-only" | "workspace-write";
  contextBundleId: string;
  model: CodexModelConfig;
  config?: Record<string, AgentJsonValue>;
  baseInstructions?: string;
  developerInstructions?: string;
  dynamicTools?: AgentDynamicToolSpec[];
}

export interface AgentThreadSnapshot {
  threadId: string;
  spec: AgentThreadSpec;
  response: unknown;
  threadPreflight?: ScoutAgentThreadPreflightSnapshot;
}
