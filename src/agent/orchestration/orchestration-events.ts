import type { ScoutEvent } from "../../core/events/index.js";
import type { AgentTaskSystemEvent } from "../task/task-events.js";

export interface CoordinatorPromptReadyPayload {
  sourceEvents: AgentTaskSystemEvent[];
}

export type SystemOrchestrationEventPayload = CoordinatorPromptReadyPayload;

export type SystemOrchestrationEvent = ScoutEvent<SystemOrchestrationEventPayload>;
