import { event } from "../../core/events/index.js";
import { AgentEvents } from "../events/catalog.js";
import type {
  AgentTaskDisposition,
  AgentTaskState,
} from "./types.js";
import type { ScoutAgentRole } from "../thread/types.js";

/** Fact emitted when a Worker submits a completed task outcome. */
export interface AgentTaskOutcomeSubmission {
  task: AgentTaskState;
  stepId: string;
  turnId?: string;
  callId?: string;
  outcome: string;
  submittedAt: string;
}

/** Fact emitted when Runtime records a step lifecycle disposition. */
export interface AgentTaskDispositionRecorded {
  task: AgentTaskState;
  disposition: AgentTaskDisposition;
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
    dispositionRecorded: event<AgentTaskDispositionRecorded>(),
    outcomeSubmitted: event<AgentTaskOutcomeSubmission>(),
    failed: event<AgentTaskState>(),
    planUpdated: event<AgentTaskState>(),
    terminal: event<AgentTaskState>(),
  },
} as const;

AgentEvents.add(taskEventCatalog);

/** Event routes for task lifecycle, plan, and disposition facts. */
export type AgentTaskEventCatalog = typeof taskEventCatalog;

/** Rejection fact emitted when a Worker cannot accept a new task. */
export interface AgentTaskNotAssignedEventPayload {
  agentId: string;
  role: ScoutAgentRole;
  activeTaskId: string;
  requestedDescription: string;
  reason: string;
}
