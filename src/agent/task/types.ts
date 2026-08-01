import type { AppServerPlanState } from "../../agent-server/codex/app-server-event-store.js";
import type { ScoutAgentRole } from "../thread/types.js";

export const AgentTaskStatuses = {
  Queued: "queued",
  Running: "running",
  Done: "done",
  Failed: "failed",
  Stopped: "stopped",
} as const;
export type AgentTaskStatus = typeof AgentTaskStatuses[keyof typeof AgentTaskStatuses];
export const AgentTaskStepStatuses = {
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Interrupted: "interrupted",
} as const;
export type AgentTaskStepStatus = typeof AgentTaskStepStatuses[keyof typeof AgentTaskStepStatuses];
export interface AgentTaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface AgentHumanInputRequest {
  body: string;
}

export interface AgentHumanInputResponse {
  body: string;
}

export const AgentTaskDispositionKinds = {
  HandoffSubmitted: "handoff_submitted",
  WaitingForHuman: "waiting_for_human",
  ProtocolViolation: "protocol_violation",
} as const;
export type AgentTaskDispositionKind =
  typeof AgentTaskDispositionKinds[keyof typeof AgentTaskDispositionKinds];

interface AgentTaskDispositionBase {
  stepId: string;
  turnId: string;
  callId: string | null;
  timestamp: string;
}

export interface AgentTaskHandoffSubmittedDisposition extends AgentTaskDispositionBase {
  kind: typeof AgentTaskDispositionKinds.HandoffSubmitted;
  callId: string;
  outcome: string;
}

export interface AgentTaskWaitingForHumanDisposition extends AgentTaskDispositionBase {
  kind: typeof AgentTaskDispositionKinds.WaitingForHuman;
  callId: string;
  requestId: string;
  request: string;
}

export interface AgentTaskProtocolViolationDisposition extends AgentTaskDispositionBase {
  kind: typeof AgentTaskDispositionKinds.ProtocolViolation;
  callId: string | null;
  reason: string;
}

export type AgentTaskDisposition =
  | AgentTaskHandoffSubmittedDisposition
  | AgentTaskWaitingForHumanDisposition
  | AgentTaskProtocolViolationDisposition;

export interface AgentTaskStep {
  stepId: string;
  taskId: string;
  turnId?: string;
  status: AgentTaskStepStatus;
  prompt: string;
  finalResponse?: string;
  toolCalls: AgentTaskStepToolCall[];
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  humanInputRequest?: AgentHumanInputRequest;
  humanInputResponse?: AgentHumanInputResponse;
  requiresDisposition?: boolean;
  disposition?: AgentTaskDisposition;
  protocolWarnings?: string[];
  error?: string;
}

export interface AgentTaskStepToolCall {
  namespace: string | null;
  tool: string;
  callId?: string;
  arguments?: unknown;
  success?: boolean | null;
}

export interface AgentTaskState {
  type: "local_agent";
  taskId: string;
  taskSequence: number;
  agentId: string;
  role: ScoutAgentRole;
  description: string;
  initialPrompt: string;
  status: AgentTaskStatus;
  isBackgrounded: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  usage?: AgentTaskUsage;
  plan?: AppServerPlanState;
  planRecords?: AppServerPlanState[];
  protocolRepairAttempts?: number;
  steps?: AgentTaskStep[];
}

export interface AssignAgentTaskInput {
  taskId?: string;
  agentId?: string;
  description: string;
  subagentType: ScoutAgentRole;
  prompt: string;
  isBackgrounded?: boolean;
}

export interface SendAgentMessageInput {
  taskId?: string;
  message: string;
  delivery?: {
    messageId: string;
    queuedAt: string;
  };
}
