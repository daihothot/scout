import { randomUUID } from "node:crypto";
import type { WorkflowProfileAsset } from "../../asset-store/contracts/workflow-profile.js";
import { workflowAgentPaths, workflowRootFromJournalRoot } from "../path.js";
import { isDeepStrictEqual } from "node:util";
import { AgentStepStatuses } from "../../agent/step/types.js";
import { AgentTaskStatuses } from "../../agent/task/types.js";
import { AgentEvents } from "../../agent/events/index.js";
import { CoordinatorAgent } from "../../agent/roles/coordinator-agent.js";
import { RunEvents } from "../../run/events/index.js";
import { projectRun } from "../../run/resume/projection/run-projector.js";
import { projectGraphState } from "../../run/resume/projection/workflow-projector.js";
import { currentRunScope } from "../../run/run-scope.js";
import { SystemEvents } from "../../system/events/index.js";
import type { EventBus, UnsubscribeEventHandler } from "../events/index.js";
import { EventSubscriptionPriorities } from "../events/index.js";
import type { RecordEvent } from "../record/index.js";
import { type GraphState, type WorkflowPhaseOutcome, resolveSynthesisRole } from "./graph-state.js";
import { Graph, type GraphAdvanceResult } from "./graph.js";
import { WorkflowTransition } from "./workflow-transition.js";
import { ScoutRecordObject } from "../record/scout-record-object.js";
import { Benchmarks, ScoutBenchmarks } from "../benchmarks/index.js";
import { WorkflowEvents, type WorkflowBoundaryEvent } from "./workflow-events.js";
import { projectWorkflowState, type WorkflowState } from "./workflow-state.js";

export interface WorkflowResumeInput {
  workflowState: WorkflowState;
  journalRoot: string;
  graphState: GraphState;
}

/** Distinguishes a committed Graph decision from deferral for unread human input. */
export type WorkflowAdvanceResult =
  | { status: "advanced"; result: GraphAdvanceResult }
  | { status: "not_advanced"; reason: "pending_user_input" };

/** Owns Graph progression and orchestrates execution entry/exit, recording, and Benchmarks. */
export class Workflow {
  readonly graph: Graph;
  readonly scoutRecordObject: ScoutRecordObject;
  private scoutBenchmarks?: ScoutBenchmarks;
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];
  private activeWorkflowState?: WorkflowState;
  private eventBus?: EventBus;
  private transition?: WorkflowTransition;
  private pendingAdvance?: Promise<WorkflowAdvanceResult>;
  private stopRequested = false;
  private started = false;

  constructor(asset: WorkflowProfileAsset) {
    this.graph = new Graph(asset);
    this.scoutRecordObject = new ScoutRecordObject();
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.scoutBenchmarks) throw new Error("Workflow still owns resources from a failed cleanup; stop it before restarting.");
    const scope = currentRunScope();
    this.eventBus = scope.eventBus;
    const benchmarks = new ScoutBenchmarks(new Benchmarks(scope.runRoot));
    this.scoutBenchmarks = benchmarks;
    try {
      benchmarks.benchmarks.acquire();
      this.transition = new WorkflowTransition(this.graph, this.scoutRecordObject, benchmarks);
      this.scoutRecordObject.start();
      this.unsubscribers.push(
        scope.eventBus.subscribe(RunEvents.runtime.ready, async () => {
          await this.continueExecution();
        }, { priority: EventSubscriptionPriorities.Critical }),
        scope.eventBus.subscribe<WorkflowBoundaryEvent>(WorkflowEvents.workflow.committing, ({ payload }) => {
          this.activeWorkflowState = { workflowId: payload.workflowId, status: "active", checkpointSeq: this.scoutRecordObject.lastSeq };
          this.initialize();
          scope.stepStore.restore([]);
          scope.toolCallStore.restore([]);
          scope.humanInputStore.restore([]);
        }, { priority: EventSubscriptionPriorities.High }),
        scope.eventBus.subscribe<{ completedAt: string }>(WorkflowEvents.workflow.completed, ({ payload }) => {
          if (!this.activeWorkflowState) return;
          this.activeWorkflowState = { ...this.activeWorkflowState, status: "completed", completedAt: payload.completedAt,
            checkpointSeq: this.scoutRecordObject.lastSeq };
        }, { priority: EventSubscriptionPriorities.High }),
        scope.eventBus.subscribe(
          SystemEvents.interaction.userMessageSubmitted,
          () => this.assertAcceptingInput(),
          { priority: EventSubscriptionPriorities.Critical },
        ),
      );
      this.stopRequested = false;
      this.started = true;
    } catch (error) {
      const failures: unknown[] = [error];
      while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
      try {
        this.scoutRecordObject.stop();
        this.activeWorkflowState = undefined;
        benchmarks.benchmarks.release();
        this.scoutBenchmarks = undefined;
      } catch (closeError) {
        failures.push(closeError);
      } finally {
        if (!this.scoutBenchmarks) this.transition = undefined;
        this.eventBus = undefined;
        this.stopRequested = true;
        this.started = false;
      }
      if (failures.length > 1) throw new AggregateError(failures, "Workflow startup and journal cleanup failed.");
      throw error;
    }
  }

  /** One-time recovery under the already acquired Run and journal locks. */
  restore(input: WorkflowResumeInput): void {
    this.assertAcceptingInput();
    if (this.activeWorkflowState) throw new Error("Cannot restore over an active Workflow.");
    const scope = currentRunScope();
    const benchmarks = this.requireScoutBenchmarks();
    const selected = benchmarks.resolve("currentWorkflow");
    if (selected?.workflowId !== input.workflowState.workflowId || selected.journalRoot !== input.journalRoot) {
      throw new Error("Workflow benchmark selection changed before its runtime lock was acquired; retry resume.");
    }
    this.scoutRecordObject.stop();
    this.scoutRecordObject.open(selected.journalRoot);
    const events = this.scoutRecordObject.readAll();
    const created = events.find((event) => RunEvents.run.created.is(event));
    const workflowState = projectWorkflowState(selected.workflowId, events);
    const graphState = projectGraphState(events);
    if (!created || !RunEvents.run.created.is(created) || created.payload.runId !== scope.runId
      || !isDeepStrictEqual(workflowState, input.workflowState)
      || !isDeepStrictEqual(graphState, input.graphState)) {
      throw new Error("Workflow recovery snapshot changed before its journal lock was acquired; retry resume.");
    }
    const latestGraphFact = [...events].reverse().find((event) => WorkflowEvents.workflow.initialized.is(event) || WorkflowEvents.workflow.advanced.is(event));
    const completedOutcome = latestGraphFact && WorkflowEvents.workflow.advanced.is(latestGraphFact) && latestGraphFact.payload.cycleCompleted
      ? latestGraphFact.payload.outcome : undefined;
    this.graph.restore(graphState, completedOutcome);
    if (workflowState.status === "completed") {
      const projection = projectRun(events, resolveSynthesisRole(graphState).name);
      this.assertWorkflowSettled(projection, new Set(projection.userMessages.map((message) => message.messageId)));
      this.scoutRecordObject.releaseWorkflow();
      this.scoutRecordObject.start();
      return;
    }
    this.activeWorkflowState = workflowState;
    this.scoutRecordObject.start();
    benchmarks.recordRun(workflowState.workflowId);
  }

  async stop(): Promise<void> {
    if (!this.started && !this.scoutBenchmarks) return;
    const failures: unknown[] = [];
    try {
      await this.quiesce();
    } catch (error) {
      failures.push(error);
    }
    this.started = false;
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    try {
      this.scoutRecordObject.stop();
      this.activeWorkflowState = undefined;
      this.scoutBenchmarks?.benchmarks.release();
      this.scoutBenchmarks = undefined;
    } catch (error) {
      failures.push(error);
    } finally {
      if (!this.scoutBenchmarks) this.transition = undefined;
      this.eventBus = undefined;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Workflow shutdown failed.");
  }

  /** Closes input admission and drains dispatch/transition work before services stop. */
  async quiesce(): Promise<void> {
    this.stopRequested = true;
    const settled = await Promise.allSettled([
      this.eventBus?.drain(SystemEvents.interaction.userMessageSubmitted),
      // The caller owns an advance rejection; shutdown only waits for its lifetime.
      this.pendingAdvance?.then(() => undefined, () => undefined),
      this.transition?.drain(),
    ]);
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  /** Input admission depends on Workflow readiness, never on Journal write success. */
  assertAcceptingInput(): void {
    if (!this.started || this.stopRequested) throw new Error("Workflow is stopping or not started; input is unavailable.");
    this.transition?.assertAvailable();
    if (this.activeWorkflowState && this.activeWorkflowState.status !== "active") {
      throw new Error("Workflow is not ready to accept input.");
    }
  }

  /** Initializes the Graph directly; the entry transaction records its baseline once. */
  initialize(): GraphState {
    return this.graph.initializeGraph();
  }

  /** Both normal progression and restored activation consume this same Graph conclusion. */
  private async continueExecution(): Promise<void> {
    if (!this.activeWorkflowState || this.graph.completedOutcome === undefined) return;
    const transition = this.requireTransition();
    transition.assertAvailable();
    const workflowState = this.activeWorkflowState;
    this.activeWorkflowState = {
      ...workflowState, status: "completed", completedAt: new Date().toISOString(), checkpointSeq: this.lastSeq,
    };
    await transition.out({ workflowId: workflowState.workflowId, journalRoot: this.journalRoot });
    this.activeWorkflowState = undefined;
  }

  /** Checks admission, commits the Graph decision, then coordinates its runtime effects. */
  async advance(outcome: WorkflowPhaseOutcome): Promise<WorkflowAdvanceResult> {
    this.requireActiveWorkflow();
    if (this.pendingAdvance) throw new Error("Workflow is already advancing.");
    const pending = Promise.resolve().then(async (): Promise<WorkflowAdvanceResult> => {
      const scope = currentRunScope();
      const coordinator = scope.agentRegistry.listAgents().find((agent) => agent instanceof CoordinatorAgent);
      let inputArrived = false;
      const unsubscribeInput = scope.eventBus.subscribe(SystemEvents.interaction.userMessageSubmitted, () => {
        inputArrived = true;
      }, { priority: EventSubscriptionPriorities.Critical });
      try {
        await scope.eventBus.drain(AgentEvents.task.outcomeSubmitted);
        // drain snapshots current dispatches. Repeat if input arrives while either
        // wait is yielding, so accepted input cannot slip past the commit check.
        do {
          inputArrived = false;
          await scope.eventBus.drain(SystemEvents.interaction.userMessageSubmitted);
          if (coordinator instanceof CoordinatorAgent) await coordinator.drainInput();
        } while (inputArrived);
      } finally {
        unsubscribeInput();
      }
      // Recheck after yielding: stop may have been requested while consumers ran.
      const workflowState = this.requireActiveWorkflow();
      if (coordinator instanceof CoordinatorAgent && coordinator.pendingWorkflowInputs().length > 0) {
        return { status: "not_advanced", reason: "pending_user_input" };
      }
      const tasks = scope.taskStore.listTasks();
      const blockers = [
        ...tasks.filter((task) => task.status === AgentTaskStatuses.Queued || task.status === AgentTaskStatuses.Running)
          .map((task) => `Task ${task.taskId} (${task.status})`),
        ...scope.stepStore.list().filter((step) => step.taskId !== undefined && step.status === AgentStepStatuses.Running)
          .map((step) => `Worker Step ${step.stepId} for Task ${step.taskId} is still running`),
        ...scope.agentRegistry.listAgents().flatMap((agent) => {
          const snapshot = agent.snapshot();
          const task = tasks.find((task) => task.taskId === snapshot.activeTask?.taskId);
          return task?.status === AgentTaskStatuses.Done && snapshot.pendingMessageCount > 0
            ? [`Task ${task.taskId} has ${snapshot.pendingMessageCount} pending Worker message(s)`] : [];
        }),
      ];
      if (blockers.length) throw new Error(`Cannot advance Workflow Phase ${this.graph.snapshot().currentPhase}: ${blockers.join(", ")}. Finish or stop the outstanding Worker execution first.`);
      const advanced = this.graph.previewAdvance(outcome);
      const advancedAt = new Date().toISOString();
      const event = {
        id: randomUUID(),
        key: WorkflowEvents.workflow.advanced,
        payload: { ...advanced, outcome, advancedAt },
        occurredAt: advancedAt,
      };
      const persisted = this.scoutRecordObject.write(event);
      this.graph.advance(outcome);
      this.activeWorkflowState = advanced.cycleCompleted
        ? { workflowId: workflowState.workflowId, status: "settling", checkpointSeq: persisted.seq }
        : { ...workflowState, checkpointSeq: persisted.seq };
      this.eventBus!.publish(event.key, event.payload, event);
      await scope.eventBus.drain(WorkflowEvents.workflow.advanced);
      await this.continueExecution();
      return { status: "advanced", result: advanced };
    }).finally(() => { if (this.pendingAdvance === pending) this.pendingAdvance = undefined; });
    this.pendingAdvance = pending;
    return pending;
  }

  snapshot(): WorkflowState | undefined {
    return this.activeWorkflowState ? { ...structuredClone(this.activeWorkflowState), checkpointSeq: this.lastSeq } : undefined;
  }

  /** The orchestrator selects the active execution; core/path owns its evidence directory layout. */
  agentPaths(agentId: string): { artifactRoot: string; logsRoot: string } {
    this.requireWorkflowState();
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error("Invalid Workflow Agent identity " + agentId);
    return workflowAgentPaths(workflowRootFromJournalRoot(this.journalRoot), agentId);
  }

  /** Explicitly opens a Workflow after the requesting Coordinator Turn and Step have ended. */
  async startWorkflow(): Promise<void> {
    this.assertAcceptingInput();
    if (this.activeWorkflowState) throw new Error("A Workflow is already active.");
    const scope = currentRunScope();
    if (scope.stepStore.list().some((step) => step.status === AgentStepStatuses.Running)) {
      throw new Error("Cannot open a Workflow during an active Agent Step.");
    }
    await this.requireTransition().in();
  }

  readEvents(): RecordEvent[] {
    return this.activeWorkflowState ? this.scoutRecordObject.readAll() : [];
  }

  get lastSeq(): number {
    if (!this.activeWorkflowState) return 0;
    return this.scoutRecordObject.lastSeq;
  }

  get journalRoot(): string {
    return this.scoutRecordObject.journalRoot;
  }

  get journalPath(): string {
    return this.scoutRecordObject.path;
  }

  get journalFailed(): boolean {
    return this.activeWorkflowState ? this.scoutRecordObject.failed : false;
  }

  /** Shared Run-local storage, available even when no Workflow execution is active. */
  get benchmarks(): Benchmarks {
    return this.requireScoutBenchmarks().benchmarks;
  }

  private requireTransition(): WorkflowTransition {
    if (!this.transition) throw new Error("Workflow transition service is not available.");
    return this.transition;
  }

  private requireActiveWorkflow(): WorkflowState {
    if (!this.started || this.stopRequested) throw new Error("Workflow is not accepting Graph changes.");
    this.requireTransition().assertAvailable();
    const workflowState = this.requireWorkflowState();
    if (workflowState.status !== "active") throw new Error("Cannot advance a completed Workflow.");
    return workflowState;
  }

  /** User input is handed to the next Workflow; existing runtime work must finish here. */
  private assertWorkflowSettled(projection: ReturnType<typeof projectRun>, userInputs: ReadonlySet<string>): void {
    const pendingWork = projection.pendingMessages.filter((message) => !userInputs.has(message.messageId));
    const coordinatorRole = resolveSynthesisRole(this.graph.snapshot()).name;
    const coordinator = projection.threads.find((thread) => thread.role === coordinatorRole)?.agentId ?? coordinatorRole;
    const reasons = [
      ...projection.tasks.filter((task) => task.status === "queued" || task.status === "running")
        .map((task) => `unfinished Task ${task.taskId} (${task.status})`),
      ...(pendingWork.length ? [`${pendingWork.length} pending Agent message(s)`] : []),
      ...(projection.turns.some((turn) => turn.agentId !== coordinator && turn.completedAt === undefined) ? ["an unfinished Worker turn"] : []),
      ...(projection.steps.some((step) => step.agentId !== coordinator && step.status === AgentStepStatuses.Running) ? ["a running Worker step"] : []),
    ];
    if (reasons.length) throw new Error(`Cannot begin the next Workflow execution: ${reasons.join(", ")}.`);
  }

  private requireWorkflowState(): WorkflowState {
    if (!this.activeWorkflowState) throw new Error("Workflow is unavailable.");
    return this.activeWorkflowState;
  }

  private requireScoutBenchmarks(): ScoutBenchmarks {
    if (!this.scoutBenchmarks) throw new Error("Workflow Benchmarks are unavailable.");
    return this.scoutBenchmarks;
  }
}
