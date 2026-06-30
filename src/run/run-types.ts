import type { ScoutAgentRole } from "../agent/model/types.js";
import type { RuntimeInteractionPort } from "../interaction/index.js";
import type {
  PreparedRunAgent,
  RunRootAccess,
} from "./run-preparation.js";

export type McpServerBindingSet = Record<string, Record<string, string>>;

export interface ScoutRunOptions {
  cwd: string;
  mcpServerBindings?: McpServerBindingSet;
  interactionPort?: RuntimeInteractionPort;
}

export interface ScoutRunResult {
  status: "passed" | "failed";
  runId: string;
  coordinatorMountRoot: string;
  mcpServerBindings: McpServerBindingSet;
  rootAccess: RunRootAccess;
  agents: Record<ScoutAgentRole, {
    mountId: string;
    mountRoot: string;
    artifactRoot: string;
    assetCommitId: string;
    assetCommitPath: string;
    preflightStatus: "passed" | "failed";
    preflightPath: string;
  }>;
  orchestrationStatus?: "completed" | "blocked" | "failed" | "idle" | "max_steps";
  agentLedgerPath?: string;
}

export type ScoutRunPreparedAgents = Record<ScoutAgentRole, PreparedRunAgent>;
