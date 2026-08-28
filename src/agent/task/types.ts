import type { ScoutAgentRole } from "../thread/types.js";
import type { AgentMessageDeliveryMode } from "../message/types.js";

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

/** Worker Task lifecycle decisions produced during one execution Step. */
export const AgentTaskDispositionKinds = {
  HandoffSubmitted: "handoff_submitted",
  WaitingForHuman: "waiting_for_human",
  ProtocolViolation: "protocol_violation",
} as const;

export type AgentTaskDispositionKind =
  typeof AgentTaskDispositionKinds[keyof typeof AgentTaskDispositionKinds];

export interface AgentTaskDispositionBase {
  stepId: string;
  turnId: string;
  callId: string | null;
  timestamp: string;
}

export interface AgentTaskHandoffDisposition extends AgentTaskDispositionBase {
  kind: typeof AgentTaskDispositionKinds.HandoffSubmitted;
  callId: string;
  outcome: string;
}

export interface AgentTaskHumanInputDisposition extends AgentTaskDispositionBase {
  kind: typeof AgentTaskDispositionKinds.WaitingForHuman;
  callId: string;
  requestId: string;
  request: string;
}

export interface AgentTaskProtocolViolationDisposition extends AgentTaskDispositionBase {
  kind: typeof AgentTaskDispositionKinds.ProtocolViolation;
  callId: null;
  reason: string;
}

export type AgentTaskDisposition =
  | AgentTaskHandoffDisposition
  | AgentTaskHumanInputDisposition
  | AgentTaskProtocolViolationDisposition;

/** Usage counters accumulated by task execution. */
export interface AgentTaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/** Complete durable task state used by runners, backends, and resume. */
export interface AgentTaskState {
  type: "local_agent";
  taskId: string;
  taskSequence: number;
  agentId: string;
  role: ScoutAgentRole;
  phase: string;
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
  protocolRepairAttempts?: number;
  stepIds: string[];
  dispositions: AgentTaskDisposition[];
}

/** Request to create or assign a Worker task. */
export interface AssignAgentTaskInput {
  taskId?: string;
  phase: string;
  description: string;
  prompt: string;
  isBackgrounded?: boolean;
}

/** Message delivery request, optionally carrying an existing message identity. */
export interface SendAgentMessageInput {
  taskId?: string;
  message: string;
  /** Messages steer an active turn by default; queued waits for a new turn. */
  deliveryMode?: AgentMessageDeliveryMode;
  delivery?: {
    messageId: string;
    queuedAt: string;
  };
}
