import type { ScoutEvent } from "../events/index.js";
import { WorkflowEvents } from "./workflow-events.js";

export type WorkflowFlowStatus = "active" | "settling" | "completed";

/** Concrete state of one numbered Workflow Flow reconstructed from its Scout Journal. */
export interface WorkflowFlowState {
  flowId: string;
  status: WorkflowFlowStatus;
  checkpointSeq: number;
  completedAt?: string;
}

interface WorkflowFlowJournalEvent extends ScoutEvent {
  seq: number;
}

/** Derives whether a persisted Flow still requires restoration. */
export function projectWorkflowFlowState(
  flowId: string,
  events: readonly WorkflowFlowJournalEvent[],
): WorkflowFlowState {
  const initialized = events.find((event) => WorkflowEvents.workflow.initialized.is(event));
  if (!initialized) {
    throw new Error(`Workflow Flow ${flowId} is missing system.workflow.initialized.`);
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
    throw new Error(`Workflow Flow ${flowId} completed without a terminal Graph.`);
  }
  return {
    flowId,
    status: completion ? "completed" : terminal ? "settling" : "active",
    checkpointSeq: events.at(-1)?.seq ?? 0,
    ...(completion ? { completedAt: completion.occurredAt } : {}),
  };
}
