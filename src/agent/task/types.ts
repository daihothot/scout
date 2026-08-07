import type { AppServerPlanState } from "../../agent-server/codex/app-server-event-store.js";
import type { ScoutAgentRole } from "../thread/types.js";

/** Lifecycle states for a persisted agent task. */
export const AgentTaskStatuses = {
  Queued: "queued",
  Running: "running",
  Done: "done",
  Failed: "failed",
  Stopped: "stopped",
} as const;
/** String union corresponding to {@link AgentTaskStatuses}. */
export type AgentTaskStatus = typeof AgentTaskStatuses[keyof typeof AgentTaskStatuses];
/** Lifecycle states for one task step/turn. */
export const AgentTaskStepStatuses = {
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Interrupted: "interrupted",
} as const;
/** String union corresponding to {@link AgentTaskStepStatuses}. */
export type AgentTaskStepStatus = typeof AgentTaskStepStatuses[keyof typeof AgentTaskStepStatuses];
/** Usage counters accumulated by task execution. */
export interface AgentTaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/** Worker-provided human-input request captured on a task step. */
export interface AgentHumanInputRequest {
  body: string;
}

/** Human response captured when a waiting task resumes. */
export interface AgentHumanInputResponse {
  body: string;
}

/** Disposition kinds that close or pause a running task step. */
export const AgentTaskDispositionKinds = {
  HandoffSubmitted: "handoff_submitted",
  WaitingForHuman: "waiting_for_human",
  ProtocolViolation: "protocol_violation",
} as const;
/** String union corresponding to {@link AgentTaskDispositionKinds}. */
export type AgentTaskDispositionKind =
  typeof AgentTaskDispositionKinds[keyof typeof AgentTaskDispositionKinds];

interface AgentTaskDispositionBase {
  stepId: string;
  turnId: string;
  callId: string | null;
  timestamp: string;
}

/** A completed Worker handoff delivered to the Coordinator. */
export interface AgentTaskHandoffSubmittedDisposition extends AgentTaskDispositionBase {
  kind: typeof AgentTaskDispositionKinds.HandoffSubmitted;
  callId: string;
  outcome: string;
}

/** A step paused while the Coordinator obtains human input. */
export interface AgentTaskWaitingForHumanDisposition extends AgentTaskDispositionBase {
  kind: typeof AgentTaskDispositionKinds.WaitingForHuman;
  callId: string;
  requestId: string;
  request: string;
}

/** Runtime-recorded failure of the Worker lifecycle protocol. */
export interface AgentTaskProtocolViolationDisposition extends AgentTaskDispositionBase {
  kind: typeof AgentTaskDispositionKinds.ProtocolViolation;
  callId: string | null;
  reason: string;
}

/** Discriminated lifecycle outcome recorded for a task step. */
export type AgentTaskDisposition =
  | AgentTaskHandoffSubmittedDisposition
  | AgentTaskWaitingForHumanDisposition
  | AgentTaskProtocolViolationDisposition;

/** Persisted state and execution history for one agent task. */
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

/** App-server tool-call projection stored on a task step. */
export interface AgentTaskStepToolCall {
  namespace: string | null;
  tool: string;
  callId?: string;
  arguments?: unknown;
  success?: boolean | null;
}

/** Complete durable task state used by runners, backends, and resume. */
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

/** Request to create or assign a Worker task. */
export interface AssignAgentTaskInput {
  taskId?: string;
  agentId?: string;
  description: string;
  subagentType: ScoutAgentRole;
  prompt: string;
  isBackgrounded?: boolean;
}

/** Message delivery request, optionally carrying an existing message identity. */
export interface SendAgentMessageInput {
  taskId?: string;
  message: string;
  delivery?: {
    messageId: string;
    queuedAt: string;
  };
}
