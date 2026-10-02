import { mkdirSync } from "node:fs";
import { currentRunScope } from "../../../run/run-scope.js";
import type { ScoutBenchmarks } from "../../benchmarks/scout-benchmarks.js";
import { workflowAgentPaths } from "../../path.js";
import type { ScoutRecordObject } from "../../record/scout-record-object.js";
import type { StateTransition } from "../../state/statemachine/index.js";
import type { Graph } from "../graph.js";
import type { WorkflowStateRequest } from "../workflow.js";
import { WorkflowEvents } from "../workflow-events.js";

/** Registered pre-entry transaction for Creating; the state machine owns its awaited lifetime. */
export class WorkflowCreatingTransition implements StateTransition<WorkflowStateRequest> {
  retryableFailure?: { readonly error: unknown };
  constructor(
    private readonly graph: Graph,
    private readonly recordObject: ScoutRecordObject,
    private readonly benchmarks: ScoutBenchmarks,
  ) {}

  async in(_payload: WorkflowStateRequest): Promise<void> {
    this.retryableFailure = undefined;
    const scope = currentRunScope();
    let prepared: ReturnType<ScoutBenchmarks["prepareNext"]> | undefined;
    let committed = false;
    try {
      prepared = this.benchmarks.prepareNext();
      const boundary = { workflowId: prepared.workflowId, journalRoot: prepared.journalRoot };
      for (const role of this.graph.snapshot().roles) {
        const { artifactRoot, logsRoot } = workflowAgentPaths(prepared.workflowRoot, role.name);
        mkdirSync(artifactRoot, { recursive: true });
        mkdirSync(logsRoot, { recursive: true });
      }
      await scope.eventBus.publishAndWait(WorkflowEvents.workflow.preparing, boundary);
      this.benchmarks.recordStarted(prepared.workflowId);
      committed = true;
      await scope.eventBus.publishAndWait(WorkflowEvents.workflow.committing, boundary);
      await scope.eventBus.publishAndWait(WorkflowEvents.workflow.releasingPrevious, boundary);
    } catch (error) {
      const failures: unknown[] = [error];
      let resourceFailure: Error | undefined;
      if (committed) {
        resourceFailure = new Error("Workflow was committed but its entry transaction failed; stop this runtime before continuing.", { cause: error });
      } else if (prepared) {
        try {
          await scope.eventBus.publishAndWait(WorkflowEvents.workflow.aborting, { workflowId: prepared.workflowId, journalRoot: prepared.journalRoot });
        } catch (failure) { failures.push(failure); }
        if (this.recordObject.hasPreparedRecords || failures.length > 1) {
          resourceFailure = new AggregateError(failures, "Failed to release prepared Workflow resources; its directory is retained.");
        } else {
          try { this.benchmarks.discard(prepared); }
          catch (failure) {
            failures.push(failure);
            resourceFailure = new AggregateError(failures, "Failed to discard uncommitted Workflow resources.");
          }
        }
      }
      if (!resourceFailure) this.retryableFailure = { error };
      throw resourceFailure ?? error;
    }
  }

  out(_payload: WorkflowStateRequest): void {}
}
