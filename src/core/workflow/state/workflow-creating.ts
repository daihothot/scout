import type { MachineState } from "../../state/statemachine/index.js";
import type { Workflow, WorkflowStateRequest } from "../workflow.js";
import { WorkflowState } from "./workflow-state.js";

/** Initializes each owner only after the entry resource transaction commits. */
export class WorkflowCreating implements MachineState<WorkflowState, WorkflowStateRequest> {
  constructor(private readonly workflow: Workflow) {}
  async enter(): Promise<WorkflowState> {
    for (const participant of this.workflow.participants) await participant.create();
    return WorkflowState.Running;
  }
  exit(): void {}
}
