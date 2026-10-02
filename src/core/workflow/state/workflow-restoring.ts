import type { MachineState } from "../../state/statemachine/index.js";
import type { Workflow, WorkflowStateRequest } from "../workflow.js";
import { WorkflowState } from "./workflow-state.js";

/** Restores owners serially; activation is a separate Running-state operation. */
export class WorkflowRestoring implements MachineState<WorkflowState, WorkflowStateRequest> {
  constructor(private readonly workflow: Workflow) {}
  async enter(request: WorkflowStateRequest): Promise<WorkflowState> {
    if (request.state !== WorkflowState.Restoring) throw new Error("Restoring requires a Workflow recovery input.");
    this.workflow.selectRecovery(request.input);
    for (const participant of this.workflow.participants) await participant.restore(request.input.workflowData);
    return request.input.workflowData.status === "completed" ? WorkflowState.Idle : WorkflowState.Running;
  }
  exit(): void {}
}
