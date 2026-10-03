import { statSync } from "node:fs";
import { WorkflowState, type WorkflowResumeInput } from "../../../core/workflow/index.js";
import { ScoutBenchmarks } from "../../../core/benchmarks/scout-benchmarks.js";
import { resolveWorkflowLocation, scoutJournalPaths } from "../../../core/io/index.js";
import { currentRunScope } from "../../run-scope.js";
import type { RunStage } from "../../lifecycle/run-stage.js";

/** Drives owner recovery after service installation; owns no business data or projector. */
export class RestoreWorkflowStage implements RunStage {
  readonly id = "restore_workflow";
  constructor(private readonly recovery?: WorkflowResumeInput, private readonly missingWorkflowId?: string) {}
  async start(): Promise<void> {
    const scope = currentRunScope();
    if (this.recovery) {
      await scope.workflow.enterState({ state: WorkflowState.Restoring, input: this.recovery });
      return;
    }
    if (this.missingWorkflowId) {
      const benchmarks = new ScoutBenchmarks(scope.workflow.benchmarks);
      if (benchmarks.read()?.currentWorkflow !== this.missingWorkflowId) {
        throw new Error("Workflow benchmark selection changed before its runtime lock was acquired; retry resume.");
      }
      const selected = resolveWorkflowLocation(scope.runRoot, this.missingWorkflowId);
      if (selected) {
        try {
          statSync(scoutJournalPaths(selected.journalRoot).path);
          throw new Error("Workflow missing journal reappeared before its runtime lock was acquired; retry resume.");
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        }
      }
    }
    await scope.workflow.enterState({ state: WorkflowState.Idle });
    await scope.agentOrchestrator.restoreEntities();
  }
  async stop(reason: string): Promise<void> {
    await currentRunScope().agentOrchestrator.stopEntities(reason);
  }
}
