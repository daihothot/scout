import type {
  AppServerPlanState,
  AppServerThreadGoalState,
} from "../../agent-server/codex/app-server-event-store.js";
import type { AgentThreadRecord, ScoutAgentRole } from "../types.js";

export type AgentTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_input"
  | "complete"
  | "prompt_required"
  | "confirmation_required"
  | "blocked"
  | "insufficient_evidence"
  | "failed"
  | "stopped";
export const AgentTaskStateEvents = {
  Assigned: "task_assigned",
  MessageQueued: "task_message_queued",
  Stopped: "task_stopped",
  OutcomeRecorded: "task_outcome_recorded",
  WaitingForInput: "task_waiting_for_input",
  ThreadAttached: "task_thread_attached",
  PendingMessagesDrained: "task_pending_messages_drained",
  StepStarted: "task_step_started",
  StepCompletedWaitingForInput: "task_step_completed_waiting_for_input",
  StepCompletedAfterTerminalUpdate: "task_step_completed_after_terminal_update",
  StepOutput: "task_step_output",
  StepCompletedWithPendingMessages: "task_step_completed_with_pending_messages",
  MissingTaskResult: "task_missing_task_result",
  Failed: "task_failed",
  NotificationEnqueued: "task_notification_enqueued",
  UserInputRequestEnqueued: "user_input_request_enqueued",
  GoalUpdated: "task_goal_updated",
  PlanUpdated: "task_plan_updated",
} as const;
export type AgentTaskStateEvent = typeof AgentTaskStateEvents[keyof typeof AgentTaskStateEvents];
export type AgentTaskOutcomeStatus =
  | "complete"
  | "prompt_required"
  | "confirmation_required"
  | "blocked"
  | "insufficient_evidence"
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
  kind: "prompt_required" | "confirmation_required";
  question: string;
  context?: string;
  options?: string[];
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
