import type { MachineState } from "../../state/statemachine/index.js";
import type { Workflow, WorkflowStateRequest } from "../workflow.js";
import { WorkflowState } from "./workflow-state.js";

/** A terminal Graph is already a fact; cleanup failures cannot reverse it. */
export class WorkflowClosing implements MachineState<WorkflowState, WorkflowStateRequest> {
  private failure?: AggregateError;

  constructor(private readonly workflow: Workflow) {}

  /** Observed by the exit transaction only after every participant had a chance to close. */
  get closeFailure(): AggregateError | undefined { return this.failure; }

  async enter(): Promise<WorkflowState> {
    this.failure = undefined;
    const failures: unknown[] = [];
    for (const participant of this.workflow.participants) {
      try { await participant.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) this.failure = new AggregateError(failures, "Workflow completed but participant cleanup failed.");
    // Exit finalization must still run when business cleanup fails. The
    // registered transition propagates this failure before entering Idle.
    return WorkflowState.Idle;
  }
  exit(): void {}
}
