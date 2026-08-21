import { event } from "../../core/events/index.js";
import type { AppServerPlanState } from "../../agent-server/codex/app-server-event-store.js";
import { AgentEvents } from "../events/catalog.js";
import type { AgentStepState } from "./types.js";

/** Plan observation merged into an existing running Step. */
export interface AgentStepPlanUpdatedEvent {
  stepId: string;
  agentId: string;
  taskId?: string;
  turnId: string;
  plan: AppServerPlanState;
  updatedAt: string;
}

const stepEventCatalog = {
  step: {
    started: event<AgentStepState>(),
    completed: event<AgentStepState>(),
    interrupted: event<AgentStepState>(),
    failed: event<AgentStepState>(),
    planUpdated: event<AgentStepPlanUpdatedEvent>(),
    toolCallReferenced: event<AgentStepState>(),
    humanInputReferenced: event<AgentStepState>(),
  },
} as const;

AgentEvents.add(stepEventCatalog);

export type AgentStepEventCatalog = typeof stepEventCatalog;
