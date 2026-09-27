import { defineEventCatalog, event } from "../events/index.js";
import type {
  GraphState,
  WorkflowPhaseOutcome,
} from "./graph-state.js";

/** Initial Graph fact persisted before a new Flow becomes active. */
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

/** Durable Workflow Graph and completion facts owned by scout.journal. */
export const WorkflowEvents = defineEventCatalog("system", {
  workflow: {
    initialized: event<WorkflowGraphInitializedEvent>(),
    advanced: event<WorkflowGraphAdvancedEvent>(),
    completed: event<{ completedAt: string }>(),
  },
} as const);
