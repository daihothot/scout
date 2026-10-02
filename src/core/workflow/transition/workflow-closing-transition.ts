import { randomUUID } from "node:crypto";
import { currentRunScope } from "../../../run/run-scope.js";
import type { ScoutBenchmarks } from "../../benchmarks/scout-benchmarks.js";
import type { StateTransition } from "../../state/statemachine/index.js";
import type { Workflow, WorkflowStateRequest } from "../workflow.js";
import type { WorkflowClosing } from "../state/workflow-closing.js";
import { WorkflowEvents } from "../workflow-events.js";
import { reportWorkflowTransitionError } from "./workflow-transition-error.js";

/** Registered post-exit transaction for Closing; participant results belong to the Closing state. */
export class WorkflowClosingTransition implements StateTransition<WorkflowStateRequest> {
  constructor(
    private readonly workflow: Workflow,
    private readonly closing: WorkflowClosing,
    private readonly benchmarks: ScoutBenchmarks,
  ) {}

  in(_payload: WorkflowStateRequest): void {}

  /** Finalizes an already terminal execution; errors cannot undo the Graph's conclusion. */
  async out(_payload: WorkflowStateRequest): Promise<void> {
    const outcome = this.workflow.graph.completedOutcome;
    if (outcome === undefined) throw new Error("Workflow exit requires a terminal Graph conclusion.");
    const scope = currentRunScope();
    // Closing already bound this runtime and marked its terminal conclusion.
    const boundary = { workflowId: this.workflow.snapshot()!.workflowId, journalRoot: this.workflow.journalRoot };
    const failures: unknown[] = [];
    const releaseFailures: unknown[] = [];
    const completedAt = new Date().toISOString();
    const completion = { id: randomUUID(), key: WorkflowEvents.workflow.completed, payload: { completedAt }, occurredAt: completedAt };
    try { this.workflow.scoutRecordObject.write(completion); }
    catch (error) { failures.push(error); }
    try { await scope.eventBus.publishAndWait(completion.key, completion.payload, completion); }
    catch (error) { failures.push(error); }
    if (outcome === "completed") {
      try { this.benchmarks.recordSuccess(boundary.workflowId); }
      catch (error) { failures.push(error); }
    }
    try { await scope.eventBus.publishAndWait(WorkflowEvents.workflow.releasing, boundary); }
    catch (error) { releaseFailures.push(error); }
    const closeFailure = this.closing.closeFailure;
    if (releaseFailures.length > 0 || closeFailure) {
      failures.push(...releaseFailures, ...(closeFailure?.errors ?? []));
      throw new AggregateError(failures,
        "Workflow completed but participant cleanup or resource release failed; stop this runtime before continuing.");
    }
    if (failures.length > 0) await reportWorkflowTransitionError("out", new AggregateError(failures, "Workflow exit transaction failed."));
  }
}
