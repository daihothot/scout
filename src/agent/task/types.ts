import type {
  AppServerPlanState,
  AppServerThreadGoalState,
} from "../../agent-server/codex/app-server-event-store.js";
import type { AgentThreadRecord, ScoutAgentRole } from "../model/types.js";

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_human_input"
  | "waiting_for_coordinator"
  | "complete"
  | "blocked"
  | "failed"
  | "stopped";
export type AgentTaskOutcomeStatus =
  | "complete"
  | "blocked"
  | "failed";
export interface AgentTaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface AgentUserInputRequest {
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

export interface AgentUserInputResponse {
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

export interface AgentTaskStepRecord {
  stepId: string;
  taskId: string;
  turnId?: string;
  status: "completed" | "waiting_for_human_input" | "waiting_for_coordinator" | "failed";
  prompt: string;
  finalResponse?: string;
  toolCalls: AgentTaskStepToolCall[];
  startedAt: string;
  finishedAt: string;
  durationMs?: number;
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
  agentId: string;
  role: ScoutAgentRole;
  description: string;
  prompt: string;
  selectedAgent: ScoutAgentRole;
  status: AgentTaskStatus;
  isBackgrounded: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  parentTaskId?: string;
  thread?: AgentThreadRecord;
  result?: string;
  error?: string;
  usage?: AgentTaskUsage;
  goal?: AppServerThreadGoalState;
  plan?: AppServerPlanState;
  userInputRequest?: AgentUserInputRequest;
  humanInputRequests?: AgentUserInputRequest[];
  humanInputResponses?: AgentUserInputResponse[];
  steps?: AgentTaskStepRecord[];
  outcome?: AgentTaskOutcome;
}

export interface AssignAgentTaskInput {
  taskId: string;
  agentId?: string;
  description: string;
  subagentType: ScoutAgentRole;
  prompt: string;
  parentTaskId?: string;
  isBackgrounded?: boolean;
}

export interface SendAgentMessageInput {
  target: string;
  message: string;
}
