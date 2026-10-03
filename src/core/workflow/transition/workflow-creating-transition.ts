import { currentRunScope } from "../../../run/run-scope.js";
import type { ScoutBenchmarks } from "../../benchmarks/scout-benchmarks.js";
import { createWorkflowAgentDirectories, createWorkflowDirectory, discardWorkflowDirectory,
  inspectWorkflowDirectory, type WorkflowLocation, type WorkflowStorageLock } from "../../io/index.js";
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
    private readonly storage: WorkflowStorageLock,
  ) {}

  /** Allocates the execution identity and approves replacement before any directory mutation. */
  prepareNext(): WorkflowLocation {
    const links = this.benchmarks.read();
    const last = links?.lastWorkflow;
    let workflowId = "workflow-001";
    if (last !== undefined) {
      const digits = last.slice("workflow-".length);
      const next = Number.parseInt(digits, 10) + 1;
      if (!Number.isSafeInteger(next)) throw new Error(`Workflow sequence overflow: ${last}`);
      workflowId = `workflow-${String(next).padStart(Math.max(3, digits.length), "0")}`;
    }
    const { location, replacedWorkflowId } = inspectWorkflowDirectory(this.storage, workflowId);
    if (replacedWorkflowId !== undefined) {
      const pinnedBy = links
        ? (["currentWorkflow", "lastWorkflow", "lastRun", "lastSuccess"] as const)
          .filter((name) => links[name] === workflowId || links[name] === replacedWorkflowId)
        : [];
      if (pinnedBy.length > 0) throw new Error(`Cannot overwrite Workflow ${workflowId}; it is referenced by ${pinnedBy.join(", ")}.`);
      if (this.benchmarks.benchmarks.referencesTo(replacedWorkflowId).length > 0) {
        throw new Error(`Cannot overwrite referenced Workflow ${replacedWorkflowId}.`);
      }
    }
    return createWorkflowDirectory(this.storage, location);
  }

  /** Approves cleanup only after the preparation was released and before its pointer was committed. */
  discard(prepared: WorkflowLocation): void {
    this.storage.assertOwned();
    const links = this.benchmarks.read();
    const pinnedBy = links
      ? (["currentWorkflow", "lastWorkflow", "lastRun", "lastSuccess"] as const)
        .filter((name) => links[name] === prepared.workflowId)
      : [];
    if (pinnedBy.length > 0) throw new Error(`Cannot discard Workflow ${prepared.workflowId}; it is referenced by ${pinnedBy.join(", ")}.`);
    if (this.benchmarks.benchmarks.referencesTo(prepared.workflowId).length > 0) {
      throw new Error(`Cannot discard referenced Workflow ${prepared.workflowId}.`);
    }
    discardWorkflowDirectory(this.storage, prepared);
  }

  async in(_payload: WorkflowStateRequest): Promise<void> {
    this.retryableFailure = undefined;
    const scope = currentRunScope();
    let prepared: WorkflowLocation | undefined;
    let committed = false;
    try {
      prepared = this.prepareNext();
      const boundary = { workflowId: prepared.workflowId, journalRoot: prepared.journalRoot };
      createWorkflowAgentDirectories(this.storage, prepared.workflowRoot, this.graph.snapshot().roles.map((role) => role.name));
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
          try { this.discard(prepared); }
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
