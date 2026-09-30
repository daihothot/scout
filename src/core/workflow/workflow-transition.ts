import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { WorkerAgent } from "../../agent/roles/worker-agent.js";
import { currentRunScope } from "../../run/run-scope.js";
import { SystemEvents } from "../../system/events/index.js";
import type { ScoutBenchmarks } from "../benchmarks/scout-benchmarks.js";
import { workflowAgentPaths } from "../path.js";
import type { ScoutRecordObject } from "../record/scout-record-object.js";
import type { Graph } from "./graph.js";
import { WorkflowEvents, type WorkflowBoundaryEvent } from "./workflow-events.js";

/** Awaited entry/exit transactions. Graph conclusions and resource ownership stay with their owners. */
export class WorkflowTransition {
  private pending?: Promise<void>;
  private resourceFailure?: Error;

  constructor(
    private readonly graph: Graph,
    private readonly recordObject: ScoutRecordObject,
    private readonly benchmarks: ScoutBenchmarks,
  ) {}

  assertAvailable(): void {
    if (this.resourceFailure) throw this.resourceFailure;
    if (this.pending) throw new Error("Workflow is transitioning.");
  }

  /** Waits for the entered transaction without cancelling committed work. */
  async drain(): Promise<void> { await this.pending; }

  async in(): Promise<void> {
    this.assertAvailable();
    const pending = Promise.resolve().then(async () => {
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
        if (committed) {
          this.resourceFailure = new Error("Workflow was committed but its entry transaction failed; stop this runtime before continuing.", { cause: error });
        } else if (prepared) {
          try {
            await scope.eventBus.publishAndWait(WorkflowEvents.workflow.aborting, { workflowId: prepared.workflowId, journalRoot: prepared.journalRoot });
          } catch (failure) { failures.push(failure); }
          if (this.recordObject.hasPreparedRecords || failures.length > 1) {
            this.resourceFailure = new AggregateError(failures, "Failed to release prepared Workflow resources; its directory is retained.");
          } else {
            try { this.benchmarks.discard(prepared); }
            catch (failure) {
              failures.push(failure);
              this.resourceFailure = new AggregateError(failures, "Failed to discard uncommitted Workflow resources.");
            }
          }
        }
        const failure = this.resourceFailure ?? error;
        await this.reportError("in", failure);
        throw failure;
      }
    }).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }

  /** Finalizes an already terminal execution; errors cannot undo the Graph's conclusion. */
  async out(boundary: WorkflowBoundaryEvent): Promise<void> {
    this.assertAvailable();
    const outcome = this.graph.completedOutcome;
    if (outcome === undefined) throw new Error("Workflow exit requires a terminal Graph conclusion.");
    const pending = Promise.resolve().then(async () => {
      const scope = currentRunScope();
      const failures: unknown[] = [];
      const releaseFailures: unknown[] = [];
      // Failure in one participant must not skip independent exit work.
      for (const agent of scope.agentRegistry.listAgents()) {
        const task = agent.snapshot().activeTask;
        try { if (agent instanceof WorkerAgent && task) await agent.releaseTask(task.taskId); }
        catch (error) { releaseFailures.push(error); }
      }
      const completedAt = new Date().toISOString();
      const completion = { id: randomUUID(), key: WorkflowEvents.workflow.completed, payload: { completedAt }, occurredAt: completedAt };
      try { this.recordObject.write(completion); }
      catch (error) { failures.push(error); }
      try { await scope.eventBus.publishAndWait(completion.key, completion.payload, completion); }
      catch (error) { failures.push(error); }
      if (outcome === "completed") {
        try { this.benchmarks.recordSuccess(boundary.workflowId); }
        catch (error) { failures.push(error); }
      }
      for (const domain of scope.domainRegistry.list()) {
        try { await domain.finishWorkflow?.(); }
        catch (error) { releaseFailures.push(error); }
      }
      try { await scope.eventBus.publishAndWait(WorkflowEvents.workflow.releasing, boundary); }
      catch (error) { releaseFailures.push(error); }
      if (releaseFailures.length > 0) {
        this.resourceFailure = new AggregateError(releaseFailures, "Workflow completed but resource release failed; stop this runtime before continuing.");
        failures.push(...releaseFailures);
      }
      if (failures.length > 0) await this.reportError("out", new AggregateError(failures, "Workflow exit transaction failed."));
    }).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }

  private async reportError(direction: "in" | "out", error: unknown): Promise<void> {
    const scope = currentRunScope();
    const errors = error instanceof AggregateError ? error.errors : [error];
    const data = { direction, errors: errors.map((failure) => failure instanceof Error
      ? failure.stack ?? failure.message : String(failure)) };
    try {
      scope.logger.error({ module: "workflow.transition", event: "workflow_transition_failed", message: `Workflow transition ${direction} failed.`, data });
    } catch { /* Error disclosure must remain available if runtime logging fails. */ }
    try {
      await scope.eventBus.publishAndWait(SystemEvents.interaction.disclosureRequested, {
        level: "error", source: "workflow.transition", message: `Workflow transition ${direction} failed.`, data,
      });
    } catch { /* A diagnostic observer cannot change the committed execution facts. */ }
  }
}
