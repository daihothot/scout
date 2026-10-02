import type { ScoutRecord } from "../record/scout-record.js";
import { WorkflowEvents } from "./workflow-events.js";

export type WorkflowExecutionStatus = "active" | "settling" | "completed";

/** Concrete state of one numbered Workflow reconstructed from its Scout Journal. */
export interface WorkflowData {
  workflowId: string;
  status: WorkflowExecutionStatus;
  checkpointSeq: number;
  completedAt?: string;
}

/** Derives whether a persisted Workflow still requires restoration. */
export function projectWorkflowData(
  workflowId: string,
  events: readonly ScoutRecord[],
): WorkflowData {
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
