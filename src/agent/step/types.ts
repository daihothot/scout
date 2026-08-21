/** Runtime lifecycle for one agent execution step. */
export const AgentStepStatuses = {
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Interrupted: "interrupted",
} as const;

export type AgentStepStatus = typeof AgentStepStatuses[keyof typeof AgentStepStatuses];

/** Causal relation between one Step and a Human Input request aggregate. */
export interface AgentStepHumanInputReference {
  requestId: string;
  kind:
    | "request_produced"
    | "request_consumed"
    | "response_produced"
    | "response_consumed";
}

/** Durable execution state shared by Coordinator and Worker runners. */
export interface AgentStepState {
  stepId: string;
  agentId: string;
  taskId?: string;
  turnId?: string;
  status: AgentStepStatus;
  prompt: string;
  finalResponse?: string;
  /** References to Tool Call facts owned by AgentToolCallStore. */
  toolCallIds: string[];
  plan?: AppServerPlanState;
  humanInputReferences: AgentStepHumanInputReference[];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
}
import type { AppServerPlanState } from "../../agent-server/codex/app-server-event-store.js";
