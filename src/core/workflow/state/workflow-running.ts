import type { MachineState } from "../../state/statemachine/index.js";
import type { Workflow, WorkflowStateRequest } from "../workflow.js";
import { WorkflowState } from "./workflow-state.js";

/** Activates participants after creation or recovery, or closes a terminal Graph. */
export class WorkflowRunning implements MachineState<WorkflowState, WorkflowStateRequest> {
  constructor(private readonly workflow: Workflow) {}
  async enter(): Promise<WorkflowState | void> {
    if (this.workflow.graph.completedOutcome !== undefined) return WorkflowState.Closing;
    for (const participant of this.workflow.participants) await participant.run();
  }
  exit(): void {}
}
