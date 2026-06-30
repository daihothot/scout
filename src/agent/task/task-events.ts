import type { ScoutEvent } from "../../core/events/index.js";
import type {
  AgentTaskState,
  AgentTaskStepRecord,
  AgentUserInputRequest,
  AgentUserInputResponse,
} from "./types.js";

export type SystemInterruptKind =
  | "human_input"
  | "tool_call"
  | "approval"
  | "exception"
  | "policy_block";

export interface AgentTaskEventPayload {
  runId?: string;
  task: AgentTaskState;
  data?: unknown;
}

export interface AgentTaskStepEventPayload extends AgentTaskEventPayload {
  prompt?: string;
  step?: AgentTaskStepRecord;
  output?: string;
}

export interface AgentTaskTerminalEventPayload extends AgentTaskEventPayload {
  result?: string;
  error?: string;
}

export interface SystemInterruptEventPayload {
  runId?: string;
  interruptKind: SystemInterruptKind;
  taskId?: string;
  agentId?: string;
  turnId?: string;
  requestId?: string;
  status?: string;
  request?: AgentUserInputRequest;
  response?: AgentUserInputResponse;
  task?: AgentTaskState;
}

export type AgentTaskSystemEventPayload =
  | AgentTaskEventPayload
  | AgentTaskStepEventPayload
  | AgentTaskTerminalEventPayload
  | SystemInterruptEventPayload;

export type AgentTaskSystemEvent = ScoutEvent<AgentTaskSystemEventPayload>;
