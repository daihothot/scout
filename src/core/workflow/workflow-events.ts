import { defineEventCatalog, event } from "../events/index.js";
import type {
  GraphData,
  WorkflowPhaseOutcome,
} from "./graph-data.js";

/** Initial Graph fact persisted before a new Workflow becomes active. */
export interface WorkflowGraphInitializedEvent {
  state: GraphData;
  initializedAt: string;
}

/** Cursor transition fact persisted after Coordinator submits a Phase outcome. */
export interface WorkflowGraphAdvancedEvent {
  state: GraphData;
  previousPhase: string;
  outcome: WorkflowPhaseOutcome;
  cycleCompleted: boolean;
  advancedAt: string;
}

/** An awaited runtime boundary, not a durable or replayable Workflow fact. */
export interface WorkflowBoundaryEvent {
  workflowId: string;
  journalRoot: string;
}

/** Awaited runtime boundaries and durable Graph/completion facts owned by Scout. */
export const WorkflowEvents = defineEventCatalog("system", {
  workflow: {
    preparing: event<WorkflowBoundaryEvent>(),
    committing: event<WorkflowBoundaryEvent>(),
    aborting: event<WorkflowBoundaryEvent>(),
    releasingPrevious: event<WorkflowBoundaryEvent>(),
    releasing: event<WorkflowBoundaryEvent>(),
    initialized: event<WorkflowGraphInitializedEvent>(),
    advanced: event<WorkflowGraphAdvancedEvent>(),
    completed: event<{ completedAt: string }>(),
  },
} as const);
