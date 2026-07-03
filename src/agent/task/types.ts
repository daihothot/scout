import type {
  AppServerPlanState,
  AppServerThreadGoalState,
} from "../../agent-server/codex/app-server-event-store.js";
import type { ScoutAgentRole } from "../thread/types.js";
import type { AgentThreadSnapshot } from "../thread/types.js";

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_human_input"
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
  status: "completed" | "waiting_for_human_input" | "failed";
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
  humanInputRequest?: AgentHumanInputRequest;
  humanInputRequests?: AgentHumanInputRequest[];
  humanInputResponses?: AgentHumanInputResponse[];
  steps?: AgentTaskStep[];
  outcome?: AgentTaskOutcome;
}

export interface AssignAgentTaskInput {
  taskId: string;
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
