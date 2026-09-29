import type { ScoutEvent } from "../events/index.js";
import { WorkflowEvents } from "./workflow-events.js";

export type WorkflowStatus = "active" | "settling" | "completed";

/** Concrete state of one numbered Workflow reconstructed from its Scout Journal. */
export interface WorkflowState {
  workflowId: string;
  status: WorkflowStatus;
  checkpointSeq: number;
  completedAt?: string;
}

interface WorkflowJournalEvent extends ScoutEvent {
  seq: number;
}

/** Derives whether a persisted Workflow still requires restoration. */
export function projectWorkflowState(
  workflowId: string,
  events: readonly WorkflowJournalEvent[],
): WorkflowState {
  const initialized = events.find((event) => WorkflowEvents.workflow.initialized.is(event));
  if (!initialized) {
    throw new Error(`Workflow ${workflowId} is missing system.workflow.initialized.`);
  }
  const latest = [...events].reverse().find((event) =>
    WorkflowEvents.workflow.initialized.is(event)
    || WorkflowEvents.workflow.advanced.is(event)
  );
  const terminal = Boolean(
    latest
    && WorkflowEvents.workflow.advanced.is(latest)
    && latest.payload.cycleCompleted,
  );
  const completion = events.find((event) => WorkflowEvents.workflow.completed.is(event));
  if (completion && !terminal) {
    throw new Error(`Workflow ${workflowId} completed without a terminal Graph.`);
  }
  return {
    workflowId,
    status: completion ? "completed" : terminal ? "settling" : "active",
    checkpointSeq: events.at(-1)?.seq ?? 0,
    ...(completion ? { completedAt: completion.occurredAt } : {}),
  };
}
