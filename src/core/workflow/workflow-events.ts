import { defineEventCatalog, event } from "../events/index.js";
import type {
  GraphState,
  WorkflowPhaseOutcome,
} from "./graph-state.js";

/** Initial graph fact persisted before a new Run becomes active. */
export interface WorkflowGraphInitializedEvent {
  state: GraphState;
  initializedAt: string;
}

/** Cursor transition fact persisted after Coordinator submits a Phase outcome. */
export interface WorkflowGraphAdvancedEvent {
  state: GraphState;
  previousPhase: string;
  outcome: WorkflowPhaseOutcome;
  cycleCompleted: boolean;
  advancedAt: string;
}

/** Durable Workflow graph facts consumed by the Run Journal and recovery. */
export const WorkflowEvents = defineEventCatalog("system", {
  workflow: {
    initialized: event<WorkflowGraphInitializedEvent>(),
    advanced: event<WorkflowGraphAdvancedEvent>(),
  },
} as const);
