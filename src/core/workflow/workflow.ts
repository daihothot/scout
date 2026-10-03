import type { WorkflowProfileAsset } from "../../asset-store/contracts/workflow-profile.js";
import { isDeepStrictEqual } from "node:util";
import { AgentStepStatuses } from "../../agent/step/types.js";
import { RunEvents } from "../../run/events/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { SystemEvents } from "../../system/events/index.js";
import type { EventBus, UnsubscribeEventHandler } from "../events/index.js";
import { EventSubscriptionPriorities } from "../events/index.js";
import { resolveWorkflowLocation, WorkflowStorageLock, workflowAgentPaths, workflowRootFromJournalRoot } from "../io/index.js";
import type { ScoutRecord } from "../record/scout-record.js";
import { ScoutRecordObject } from "../record/scout-record-object.js";
import { Benchmarks, ScoutBenchmarks } from "../benchmarks/index.js";
import { StateMachine } from "../state/statemachine/index.js";
import type { GraphData, WorkflowPhaseOutcome } from "./graph-data.js";
import { Graph, type GraphAdvanceResult } from "./graph.js";
import { projectGraphData } from "./projector/graph-projector.js";
import { WorkflowCreatingTransition, WorkflowClosingTransition, reportWorkflowTransitionError } from "./transition/index.js";
import { WorkflowEvents, type WorkflowBoundaryEvent } from "./workflow-events.js";
import { projectWorkflowData, type WorkflowData } from "./workflow-data.js";
import type { ScoutWorkflowParticipant } from "./workflow-participant.js";
import { WorkflowState } from "./state/workflow-state.js";
import { WorkflowCreating } from "./state/workflow-creating.js";
import { WorkflowRestoring } from "./state/workflow-restoring.js";
import { WorkflowRunning } from "./state/workflow-running.js";
import { WorkflowClosing } from "./state/workflow-closing.js";
import { WorkflowAborting } from "./state/workflow-aborting.js";
import { WorkflowIdle } from "./state/workflow-idle.js";

export interface WorkflowResumeInput {
  workflowData: WorkflowData;
  journalRoot: string;
  graphData: GraphData;
}

export type WorkflowStateRequest =
  | { state: WorkflowState.Restoring; input: WorkflowResumeInput }
  | { state: Exclude<WorkflowState, WorkflowState.Restoring> };

export type WorkflowAdvanceResult =
  | { status: "advanced"; result: GraphAdvanceResult }
  | { status: "not_advanced"; reason: "pending_user_input" };

/** Provides Workflow services; states orchestrate its registered domain owners. */
export class Workflow implements ScoutWorkflowParticipant {
  readonly graph: Graph;
  readonly scoutRecordObject = new ScoutRecordObject();
  private machine = new StateMachine<WorkflowState, WorkflowStateRequest>();
  private readonly owners = new Set<ScoutWorkflowParticipant>([this]);
  private readonly running: WorkflowRunning;
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];
  private scoutBenchmarks?: ScoutBenchmarks;
  private storageLock?: WorkflowStorageLock;
  private activeWorkflowData?: WorkflowData;
  private eventBus?: EventBus;
  private pendingAdvance?: Promise<WorkflowAdvanceResult>;
  private stopRequested = false;
  private lifecycleFailure?: unknown;
  private creatingTransition?: WorkflowCreatingTransition;
  private started = false;

  constructor(asset: WorkflowProfileAsset) {
    this.graph = new Graph(asset);
    this.running = new WorkflowRunning(this);
  }

  get state(): WorkflowState | undefined { return this.machine.currentState; }
  get participants(): readonly ScoutWorkflowParticipant[] { return [...this.owners]; }

  registerParticipant(participant: ScoutWorkflowParticipant): void {
    if (this.machine.transitioning) throw new Error("Cannot install a Workflow participant during transition.");
    if (this.owners.has(participant)) throw new Error("Workflow participant is already registered.");
    this.owners.add(participant);
  }

  unregisterParticipant(participant: ScoutWorkflowParticipant): void {
    if (this.machine.transitioning) throw new Error("Cannot uninstall a Workflow participant during transition.");
    if (participant === this || !this.owners.delete(participant)) throw new Error("Workflow participant is not registered.");
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.scoutBenchmarks || this.storageLock) throw new Error("Workflow still owns resources from a failed cleanup; stop it before restarting.");
    const scope = currentRunScope();
    this.eventBus = scope.eventBus;
    const storage = new WorkflowStorageLock(scope.runRoot);
    this.storageLock = storage;
    const benchmarks = new ScoutBenchmarks(new Benchmarks(scope.runRoot, storage));
    this.scoutBenchmarks = benchmarks;
    try {
      storage.acquire();
      const machine = new StateMachine<WorkflowState, WorkflowStateRequest>();
      const closing = new WorkflowClosing(this);
      this.creatingTransition = new WorkflowCreatingTransition(this.graph, this.scoutRecordObject, benchmarks, storage);
      machine.register(WorkflowState.Creating, new WorkflowCreating(this), this.creatingTransition);
      machine.register(WorkflowState.Restoring, new WorkflowRestoring(this));
      machine.register(WorkflowState.Running, this.running);
      machine.register(WorkflowState.Closing, closing,
        new WorkflowClosingTransition(this, closing, benchmarks));
      machine.register(WorkflowState.Aborting, new WorkflowAborting(this));
      machine.register(WorkflowState.Idle, new WorkflowIdle(this));
      this.machine = machine;
      this.scoutRecordObject.start();
      this.unsubscribers.push(
        scope.eventBus.subscribe<WorkflowBoundaryEvent>(WorkflowEvents.workflow.committing, ({ payload }) => {
          this.activeWorkflowData = { workflowId: payload.workflowId, status: "active", checkpointSeq: this.scoutRecordObject.lastSeq };
        }, { priority: EventSubscriptionPriorities.High }),
        scope.eventBus.subscribe<{ completedAt: string }>(WorkflowEvents.workflow.completed, ({ payload }) => {
          if (this.activeWorkflowData) this.activeWorkflowData = { ...this.activeWorkflowData,
            status: "completed", completedAt: payload.completedAt, checkpointSeq: this.scoutRecordObject.lastSeq };
        }, { priority: EventSubscriptionPriorities.High }),
        scope.eventBus.subscribe(SystemEvents.interaction.userMessageSubmitted,
          () => this.assertAcceptingInput(), { priority: EventSubscriptionPriorities.Critical }),
      );
      this.stopRequested = false;
      this.lifecycleFailure = undefined;
      this.started = true;
      await this.enterState({ state: WorkflowState.Idle });
    } catch (error) {
      const failures: unknown[] = [error];
      while (this.unsubscribers.length) this.unsubscribers.pop()?.();
      try {
        this.scoutRecordObject.stop();
        this.activeWorkflowData = undefined;
        storage.release();
        this.storageLock = undefined;
        this.scoutBenchmarks = undefined;
      } catch (closeError) { failures.push(closeError); }
      finally {
        this.eventBus = undefined;
        this.stopRequested = true;
        this.started = false;
      }
      if (failures.length > 1) throw new AggregateError(failures, "Workflow startup and journal cleanup failed.");
      throw error;
    }
  }

  async enterState(request: WorkflowStateRequest): Promise<void> {
    if (!this.started) throw new Error("Workflow service is not started.");
    if (this.machine.transitioning) throw new Error("Workflow is transitioning.");
    try { await this.machine.enterState(request.state, request); }
    catch (error) {
      let failure = error;
      const retryable = this.creatingTransition?.retryableFailure;
      if (request.state === WorkflowState.Creating
        && retryable && retryable.error === error) {
        try { await this.machine.enterState(WorkflowState.Idle, { state: WorkflowState.Idle }); }
        catch (cleanupError) {
          failure = new AggregateError([error, cleanupError], "Workflow preparation rolled back but blank-state cleanup failed.");
          this.lifecycleFailure = failure;
        }
      } else this.lifecycleFailure = failure;
      await reportWorkflowTransitionError(request.state, failure);
      throw failure;
    }
  }

  /** Locks and rechecks the externally selected snapshot before any owner restores. */
  selectRecovery(input: WorkflowResumeInput): void {
    if (this.activeWorkflowData) throw new Error("Cannot restore over an active Workflow.");
    const scope = currentRunScope();
    const selectedId = this.requireScoutBenchmarks().read()?.currentWorkflow;
    const selected = selectedId ? resolveWorkflowLocation(scope.runRoot, selectedId) : undefined;
    if (selected?.workflowId !== input.workflowData.workflowId || selected.journalRoot !== input.journalRoot) {
      throw new Error("Workflow benchmark selection changed before its runtime lock was acquired; retry resume.");
    }
    this.scoutRecordObject.open(selected.journalRoot);
    const records = this.scoutRecordObject.read();
    const created = records.find((event) => RunEvents.run.created.is(event));
    if (!created || !RunEvents.run.created.is(created) || created.payload.runId !== scope.runId
      || !isDeepStrictEqual(projectWorkflowData(selected.workflowId, records), input.workflowData)
      || !isDeepStrictEqual(projectGraphData(records), input.graphData)) {
      throw new Error("Workflow recovery snapshot changed before its journal lock was acquired; retry resume.");
    }
  }

  create(): void { this.initialize(); }

  /** Local owner recovery: record decoding, projection, then runtime aggregation. */
  restore(data: WorkflowData): void {
    const records = this.scoutRecordObject.read();
    const graphData = projectGraphData(records);
    const latest = [...records].reverse().find((event) =>
      WorkflowEvents.workflow.initialized.is(event) || WorkflowEvents.workflow.advanced.is(event));
    const outcome = latest && WorkflowEvents.workflow.advanced.is(latest) && latest.payload.cycleCompleted
      ? latest.payload.outcome : undefined;
    this.graph.restore(graphData, outcome);
    this.activeWorkflowData = { ...data };
    if (data.status !== "completed") this.requireScoutBenchmarks().recordRun(data.workflowId);
  }

  run(): void {}
  close(): void {
    const data = this.requireWorkflowData();
    this.activeWorkflowData = { ...data, status: "completed", completedAt: new Date().toISOString() };
  }
  abort(): void {}
  clearWorkflow(): void {
    this.scoutRecordObject.release();
    this.activeWorkflowData = undefined;
  }

  async stop(): Promise<void> {
    if (!this.started && !this.scoutBenchmarks) return;
    const failures: unknown[] = [];
    try { await this.quiesce(); } catch (error) { failures.push(error); }
    this.started = false;
    while (this.unsubscribers.length) this.unsubscribers.pop()?.();
    try {
      this.scoutRecordObject.stop();
      this.activeWorkflowData = undefined;
      this.storageLock?.release();
      this.storageLock = undefined;
      this.scoutBenchmarks = undefined;
    } catch (error) { failures.push(error); }
    finally {
      this.eventBus = undefined;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Workflow shutdown failed.");
  }

  /** External shutdown drains accepted work without declaring the Graph completed. */
  async quiesce(): Promise<void> {
    this.stopRequested = true;
    const results = await Promise.allSettled([
      this.eventBus?.drain(SystemEvents.interaction.userMessageSubmitted),
      this.pendingAdvance?.then(() => undefined, () => undefined),
      this.machine.drain(),
    ]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Workflow quiescence failed.");
  }

  assertAcceptingInput(): void {
    if (!this.started || this.stopRequested) throw new Error("Workflow is stopping or not started; input is unavailable.");
    if (this.lifecycleFailure) throw this.lifecycleFailure;
    if (this.machine.transitioning) throw new Error("Workflow is transitioning.");
    if (this.activeWorkflowData && this.activeWorkflowData.status !== "active") {
      throw new Error("Workflow is not ready to accept input.");
    }
  }

  initialize(): GraphData { return this.graph.initializeGraph(); }

  async advance(outcome: WorkflowPhaseOutcome): Promise<WorkflowAdvanceResult> {
    this.requireActiveWorkflow();
    if (this.pendingAdvance) throw new Error("Workflow is already advancing.");
    const pending = Promise.resolve().then(() => this.running.advance(outcome))
      .finally(() => { if (this.pendingAdvance === pending) this.pendingAdvance = undefined; });
    this.pendingAdvance = pending;
    return pending;
  }

  updateData(data: WorkflowData): void { this.activeWorkflowData = { ...data }; }
  snapshot(): WorkflowData | undefined {
    return this.activeWorkflowData ? { ...structuredClone(this.activeWorkflowData), checkpointSeq: this.lastSeq } : undefined;
  }

  agentPaths(agentId: string): { artifactRoot: string; logsRoot: string } {
    this.requireWorkflowData();
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error("Invalid Workflow Agent identity " + agentId);
    return workflowAgentPaths(workflowRootFromJournalRoot(this.journalRoot), agentId);
  }

  async startWorkflow(): Promise<void> {
    this.assertAcceptingInput();
    if (this.activeWorkflowData) throw new Error("A Workflow is already active.");
    if (currentRunScope().agentOrchestrator.stepStore.list().some((step) => step.status === AgentStepStatuses.Running)) {
      throw new Error("Cannot open a Workflow during an active Agent Step.");
    }
    await this.enterState({ state: WorkflowState.Creating });
  }

  readEvents(): ScoutRecord[] { return this.activeWorkflowData ? this.scoutRecordObject.read() : []; }
  get lastSeq(): number {
    return this.activeWorkflowData ? (this.scoutRecordObject.hasActiveRecord
      ? this.scoutRecordObject.lastSeq : this.activeWorkflowData.checkpointSeq) : 0;
  }
  get journalRoot(): string { return this.scoutRecordObject.journalRoot; }
  get journalPath(): string { return this.scoutRecordObject.path; }
  get journalFailed(): boolean { return this.activeWorkflowData ? this.scoutRecordObject.failed : false; }
  get benchmarks(): Benchmarks { return this.requireScoutBenchmarks().benchmarks; }

  requireActiveWorkflow(): WorkflowData {
    this.assertAcceptingInput();
    const data = this.requireWorkflowData();
    if (data.status !== "active") throw new Error("Cannot advance a completed Workflow.");
    return data;
  }

  private requireWorkflowData(): WorkflowData {
    if (!this.activeWorkflowData) throw new Error("Workflow is unavailable.");
    return this.activeWorkflowData;
  }
  private requireScoutBenchmarks(): ScoutBenchmarks {
    if (!this.scoutBenchmarks) throw new Error("Workflow Benchmarks are unavailable.");
    return this.scoutBenchmarks;
  }
}
