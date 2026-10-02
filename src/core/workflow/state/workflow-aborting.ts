import type { MachineState } from "../../state/statemachine/index.js";
import type { Workflow, WorkflowStateRequest } from "../workflow.js";
import { WorkflowState } from "./workflow-state.js";

/** Interrupts runtime work without inventing a terminal Graph conclusion. */
export class WorkflowAborting implements MachineState<WorkflowState, WorkflowStateRequest> {
  constructor(private readonly workflow: Workflow) {}
  async enter(): Promise<void> {
    const failures: unknown[] = [];
    for (const participant of this.workflow.participants) {
      try { await participant.abort(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Workflow abort failed.");
  }
  exit(): void {}
}
