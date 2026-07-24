import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type { AgentTaskState } from "./types.js";
import type { ScoutAgentRole } from "../thread/types.js";

export interface AgentTaskOutcomeSubmission {
  task: AgentTaskState;
  stepId: string;
  outcome: string;
  submittedAt: string;
}

const taskEventCatalog = {
  task: {
    assigned: event<AgentTaskState>(),
    notAssigned: event<AgentTaskNotAssignedEventPayload>(),
    messageQueued: event<AgentTaskState>(),
    done: event<AgentTaskState>(),
    archived: event<AgentTaskState>(),
    stopped: event<AgentTaskState>(),
    pendingMessagesDrained: event<AgentTaskState>(),
    stepStarted: event<AgentTaskState>(),
    stepCompleted: event<AgentTaskState>(),
    stepInterrupted: event<AgentTaskState>(),
    outcomeSubmitted: event<AgentTaskOutcomeSubmission>(),
    failed: event<AgentTaskState>(),
    planUpdated: event<AgentTaskState>(),
    terminal: event<AgentTaskState>(),
  },
} as const;

AgentEvents.add(taskEventCatalog);

export type AgentTaskEventCatalog = typeof taskEventCatalog;

export interface AgentTaskNotAssignedEventPayload {
  agentId: string;
  role: ScoutAgentRole;
  activeTaskId: string;
  requestedDescription: string;
  reason: string;
}
