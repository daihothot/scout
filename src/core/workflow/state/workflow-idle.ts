import type { MachineState } from "../../state/statemachine/index.js";
import type { Workflow, WorkflowStateRequest } from "../workflow.js";
import { WorkflowState } from "./workflow-state.js";

/** Clears Workflow-scoped runtime bindings, never historical evidence or Agent entities. */
export class WorkflowIdle implements MachineState<WorkflowState, WorkflowStateRequest> {
  constructor(private readonly workflow: Workflow) {}
  async enter(): Promise<void> {
    const failures: unknown[] = [];
    // Clear the Workflow binding last so owners can still locate their current resources.
    for (const participant of [...this.workflow.participants].reverse()) {
      try { await participant.clearWorkflow(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Workflow blank-state cleanup failed.");
  }
  exit(): void {}
}
