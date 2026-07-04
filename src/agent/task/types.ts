import type {
  AppServerPlanState,
  AppServerThreadGoalState,
} from "../../agent-server/codex/app-server-event-store.js";
import type { ScoutAgentRole } from "../thread/types.js";
import type { AgentThreadSnapshot } from "../thread/types.js";

export const AgentTaskStatuses = {
  Queued: "queued",
  Running: "running",
  WaitingForHumanInput: "waiting_for_human_input",
  Complete: "complete",
  Blocked: "blocked",
  Failed: "failed",
  Stopped: "stopped",
} as const;
export type AgentTaskStatus = typeof AgentTaskStatuses[keyof typeof AgentTaskStatuses];
export const AgentTaskStepStatuses = {
  Running: "running",
  Completed: "completed",
  WaitingForHumanInput: "waiting_for_human_input",
  Failed: "failed",
} as const;
export type AgentTaskStepStatus = typeof AgentTaskStepStatuses[keyof typeof AgentTaskStepStatuses];
export const AgentTaskOutcomeStatuses = {
  Complete: "complete",
  Blocked: "blocked",
  Failed: "failed",
} as const;
export type AgentTaskOutcomeStatus = typeof AgentTaskOutcomeStatuses[keyof typeof AgentTaskOutcomeStatuses];
export interface AgentTaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface AgentHumanInputRequest {
  requestId: string;
  agentId: string;
  taskId: string;
  turnId?: string;
  kind: "prompt_required" | "confirmation_required";
  question: string;
  context?: string;
  options?: string[];
  createdAt: string;
  status: "pending" | "answered" | "cancelled";
}

export interface AgentHumanInputResponse {
  requestId: string;
  agentId: string;
  taskId: string;
  response: string;
  createdAt: string;
}

export interface AgentTaskOutcome {
  status: AgentTaskOutcomeStatus;
  summary: string;
  artifactRefs: string[];
  evidenceRefs: string[];
  blocker?: string;
  nextStep?: string;
  emittedAt: string;
}

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
  thread?: AgentThreadSnapshot;
  result?: string;
  error?: string;
  usage?: AgentTaskUsage;
  goal?: AppServerThreadGoalState;
  plan?: AppServerPlanState;
  planRecords?: AppServerPlanState[];
  steps?: AgentTaskStep[];
  outcome?: AgentTaskOutcome;
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
  target: string;
  message: string;
}
