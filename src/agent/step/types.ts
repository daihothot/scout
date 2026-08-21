/** Runtime lifecycle for one agent execution step. */
export const AgentStepStatuses = {
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Interrupted: "interrupted",
} as const;

export type AgentStepStatus = typeof AgentStepStatuses[keyof typeof AgentStepStatuses];

/** App-server tool call recorded as part of one Agent step. */
export interface AgentStepToolCall {
  namespace: string | null;
  tool: string;
  callId?: string;
  arguments?: unknown;
  success?: boolean | null;
}

/** Human response consumed as input by one Agent step. */
export interface AgentStepHumanInputResponse {
  body: string;
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
  toolCalls: AgentStepToolCall[];
  plan?: AppServerPlanState;
  humanInputResponse?: AgentStepHumanInputResponse;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
}
import type { AppServerPlanState } from "../../agent-server/codex/app-server-event-store.js";
