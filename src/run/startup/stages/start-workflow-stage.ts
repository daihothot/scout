import { WorkflowState } from "../../../core/workflow/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../../lifecycle/run-stage.js";

/** Startup enters the blank period only after all owners have been installed. */
export class StartWorkflowStage implements RunStage {
  readonly id = "start_workflow";
  async start(): Promise<void> {
    await currentRunScope().workflow.enterState({ state: WorkflowState.Idle });
  }
}
