import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { workflowAgentPaths, workflowRootFromJournalRoot, scoutJournalPaths } from "../path.js";
import { isDeepStrictEqual } from "node:util";
import { AgentEvents } from "../../agent/events/index.js";
import { AgentStepStatuses } from "../../agent/step/types.js";
import { CoordinatorAgent } from "../../agent/roles/coordinator-agent.js";
import { WorkerAgent } from "../../agent/roles/worker-agent.js";
import type { ScoutDomain, ScoutDomainWorkflowChange } from "../../domain/types.js";
import { RunEvents } from "../../run/events/index.js";
import {
  projectRun,
  readDomainJournalProjections,
} from "../../run/resume/projection/run-projector.js";
import { projectGraphState } from "../../run/resume/projection/workflow-projector.js";
import { currentRunScope } from "../../run/run-scope.js";
import { SystemEvents } from "../../system/events/index.js";
import type { EventBus, ScoutEvent, UnsubscribeEventHandler } from "../events/index.js";
import { EventSubscriptionPriorities } from "../events/index.js";
import type { JournalEvent } from "../journal/index.js";
import { type GraphState, type WorkflowPhaseOutcome, resolveSynthesisRole } from "./graph-state.js";
import { Graph } from "./graph.js";
import { Scheduler, type SchedulerAdvanceResult } from "./scheduler.js";
import { ScoutJournal } from "./scout-journal.js";
import { WorkflowBenchmarks } from "./workflow-benchmarks.js";
import { WorkflowEvents } from "./workflow-events.js";
import { projectWorkflowState, type WorkflowState } from "./workflow-state.js";

export interface WorkflowResumeInput {
  workflowState: WorkflowState;
  journalRoot: string;
}

/** Orchestrates the Workflow-owned Graph, Scheduler, Scout Journal, and Benchmarks. */
export class Workflow {
  readonly graph: Graph;
  readonly scheduler: Scheduler;
  readonly scoutJournal: ScoutJournal;
  private benchmarks?: WorkflowBenchmarks;
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];
  private activeWorkflowState?: WorkflowState;
  private eventBus?: EventBus;
  private transition?: Promise<void>;
  private transitionFailure?: Error;
  private stopping = false;
  private started = false;

  constructor(private readonly input: {
    graphState: GraphState;
    resume?: WorkflowResumeInput;
    missingWorkflowId?: string;
  }) {
    this.graph = new Graph(input.graphState);
    this.scheduler = new Scheduler(this.graph);
    this.scoutJournal = new ScoutJournal();
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.benchmarks) throw new Error("Workflow still owns resources from a failed cleanup; stop it before restarting.");
    const scope = currentRunScope();
    this.eventBus = scope.eventBus;
    const benchmarks = new WorkflowBenchmarks(scope.runRoot);
    this.benchmarks = benchmarks;
    const openInitialWorkflow = (): void => {
      if (this.input.missingWorkflowId) {
        if (benchmarks.read()?.currentWorkflow !== this.input.missingWorkflowId) {
          throw new Error("Workflow benchmark selection changed before its runtime lock was acquired; retry resume.");
        }
        const selected = benchmarks.resolve("currentWorkflow");
        if (selected) {
          try {
            statSync(scoutJournalPaths(selected.journalRoot).path);
            throw new Error("Workflow missing journal reappeared before its runtime lock was acquired; retry resume.");
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
          }
        }
      }
      if (!this.input.resume) return;
      const selected = benchmarks.resolve("currentWorkflow");
      if (selected?.workflowId !== this.input.resume.workflowState.workflowId || selected.journalRoot !== this.input.resume.journalRoot) {
        throw new Error("Workflow benchmark selection changed before its runtime lock was acquired; retry resume.");
      }
      this.scoutJournal.open(selected.journalRoot);
      const events = this.scoutJournal.readAll();
      const created = events.find((event) => RunEvents.run.created.is(event));
      const workflowState = projectWorkflowState(selected.workflowId, events);
      if (!created || !RunEvents.run.created.is(created) || created.payload.runId !== scope.runId
        || !isDeepStrictEqual(workflowState, this.input.resume.workflowState)
        || !isDeepStrictEqual(projectGraphState(events), this.graph.snapshot())) {
        throw new Error("Workflow recovery snapshot changed before its journal lock was acquired; retry resume.");
      }
      if (workflowState.status === "completed") {
        const projection = projectRun(events, resolveSynthesisRole(this.graph.snapshot()).name);
        this.assertWorkflowSettled(projection, new Set(projection.userMessages.map((message) => message.messageId)));
        this.scoutJournal.stop();
        return;
      }
      this.activeWorkflowState = workflowState;
    };

    try {
      benchmarks.acquire();
      this.scheduler.start();
      openInitialWorkflow();
      if (this.activeWorkflowState) this.scoutJournal.start();
      this.unsubscribers.push(
        scope.eventBus.subscribe(
          SystemEvents.interaction.userMessageSubmitted,
          () => this.assertAcceptingInput(),
          { priority: EventSubscriptionPriorities.Critical },
        ),
      );
      this.stopping = false;
      this.started = true;
      if (this.activeWorkflowState) benchmarks.recordRun(this.activeWorkflowState.workflowId);
    } catch (error) {
      const failures: unknown[] = [error];
      while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
      try {
        this.scoutJournal.stop();
        this.activeWorkflowState = undefined;
        benchmarks.release();
        this.benchmarks = undefined;
      } catch (closeError) {
        failures.push(closeError);
      } finally {
        this.scheduler.stop();
        this.eventBus = undefined;
        this.stopping = true;
        this.started = false;
      }
      if (failures.length > 1) throw new AggregateError(failures, "Workflow startup and journal cleanup failed.");
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started && !this.benchmarks) return;
    const failures: unknown[] = [];
    try {
      await this.quiesce();
    } catch (error) {
      failures.push(error);
    }
    this.started = false;
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    try {
      this.scoutJournal.stop();
      this.activeWorkflowState = undefined;
      this.benchmarks?.release();
      this.benchmarks = undefined;
    } catch (error) {
      failures.push(error);
    } finally {
      this.scheduler.stop();
      this.eventBus = undefined;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Workflow shutdown failed.");
  }

  /** Closes input admission and drains dispatch/transition work before services stop. */
  async quiesce(): Promise<void> {
    this.stopping = true;
    const settled = await Promise.allSettled([
      this.eventBus?.drain(SystemEvents.interaction.userMessageSubmitted),
      this.transition,
    ]);
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  /** Input admission depends on Workflow readiness, never on Journal write success. */
  assertAcceptingInput(): void {
    if (!this.started || this.stopping) throw new Error("Workflow is stopping or not started; input is unavailable.");
    if (this.transitionFailure) throw this.transitionFailure;
    if (this.transition || (this.activeWorkflowState && this.activeWorkflowState.status !== "active")) {
      throw new Error("Workflow is not ready to accept input.");
    }
  }

  /** Called after Coordinator work settles, independently of the next user input. */
  async settleWorkflow(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (!this.started) return Promise.reject(new Error("Workflow is not started."));
    if (this.transitionFailure) throw this.transitionFailure;
    if (this.transition) return this.transition;
    if (!this.activeWorkflowState || this.activeWorkflowState.status === "active") return;
    // Install the shared promise before preparation can yield or invoke a Domain.
    const transition = Promise.resolve().then(async () => {
      await this.eventBus!.drain(SystemEvents.interaction.userMessageSubmitted);
      const scope = currentRunScope();
      const domains = scope.domainRegistry.list();
      const coordinator = scope.agentRegistry.listAgents().find((agent) => agent instanceof CoordinatorAgent);
      if (coordinator instanceof CoordinatorAgent) await coordinator.drainInput();
      let currentEvents = this.readEvents();
      let projection = projectRun(currentEvents, resolveSynthesisRole(this.scheduler.snapshot()).name,
        readDomainJournalProjections(domains));
      const assertRuntimeSettled = (): void => {
        this.assertWorkflowSettled(projection, new Set([
          ...projection.userMessages.map((message) => message.messageId),
          ...(coordinator instanceof CoordinatorAgent ? coordinator.pendingWorkflowInputs().map(({ delivery }) => delivery.messageId) : []),
        ]));
        const blockingReasons = scope.agentRegistry.listAgents().flatMap((agent) => {
            const snapshot = agent.snapshot();
            if (snapshot.activeTask && (snapshot.activeTask.status === "queued" || snapshot.activeTask.status === "running")) {
              return [`Agent ${agent.agentId} still has unfinished Task ${snapshot.activeTask.taskId}`];
            }
            const deferredInputs = agent instanceof CoordinatorAgent ? agent.pendingWorkflowInputs().length : 0;
            if (snapshot.pendingMessageCount > deferredInputs) {
              return [`Agent ${agent.agentId} still has pending messages`];
            }
            return [];
          });
        if (blockingReasons.length > 0) {
          throw new Error(
            `Cannot begin the next Workflow execution: ${blockingReasons.join(", ")}.`,
          );
        }
      };

      assertRuntimeSettled();
      for (const agent of scope.agentRegistry.listAgents()) {
        const task = agent.snapshot().activeTask;
        if (agent instanceof WorkerAgent && task) await agent.releaseTask(task.taskId);
      }
      // Releases belong to the old Workflow and must be persisted before completion.
      currentEvents = this.readEvents();
      projection = projectRun(currentEvents, resolveSynthesisRole(this.scheduler.snapshot()).name,
        readDomainJournalProjections(domains));
      assertRuntimeSettled();
      if (projection.tasks.length > 0 || scope.taskStore.listTasks().length > 0) {
        throw new Error("Cannot begin the next Workflow execution: Task bindings remain after Worker release.");
      }
      if (this.requireWorkflowState().status === "settling") {
        const completedAt = new Date().toISOString();
        const completion = { id: randomUUID(), key: WorkflowEvents.workflow.completed, payload: { completedAt }, occurredAt: completedAt };
        const persisted = this.scoutJournal.write(completion);
        this.activeWorkflowState = { ...this.requireWorkflowState(), status: "completed", completedAt, checkpointSeq: persisted.seq };
        this.eventBus!.publish(completion.key, completion.payload, completion);
      }
      const terminal = [...currentEvents].reverse().find((event) => WorkflowEvents.workflow.advanced.is(event));
      if (terminal && WorkflowEvents.workflow.advanced.is(terminal) && terminal.payload.outcome === "completed") {
        this.requireBenchmarks().recordSuccess(this.requireWorkflowState().workflowId);
      }
      try {
        for (const domain of domains) await domain.finishWorkflow?.();
        this.scoutJournal.stop();
      } catch (error) {
        this.transitionFailure = new Error("Workflow completed but resource release failed; stop this runtime before continuing.", { cause: error });
        throw this.transitionFailure;
      }
      this.activeWorkflowState = undefined;
    }).finally(() => {
      if (this.transition === transition) this.transition = undefined;
    });
    this.transition = transition;
    return transition;
  }

  initialize(): void {
    this.scheduler.initialize();
  }

  /** Commits the initial Graph fact before notifying runtime observers. */
  initializeGraph(): GraphState {
    const workflowState = this.requireActiveWorkflow();
    if (!this.readEvents().some((event) => RunEvents.run.created.is(event))) {
      throw new Error("Cannot initialize Workflow without its persisted Run creation fact.");
    }
    const state = this.graph.snapshot();
    const initializedAt = new Date().toISOString();
    const event = {
      id: randomUUID(),
      key: WorkflowEvents.workflow.initialized,
      payload: { state, initializedAt },
      occurredAt: initializedAt,
    };
    const persisted = this.scoutJournal.write(event);
    this.activeWorkflowState = { ...workflowState, checkpointSeq: persisted.seq };
    this.eventBus!.publish(event.key, event.payload, event);
    return state;
  }

  /** Coordinates durable Graph, Workflow, and benchmark changes requested by Scheduler. */
  advanceGraph(outcome: WorkflowPhaseOutcome): SchedulerAdvanceResult {
    const workflowState = this.requireActiveWorkflow();
    const advanced = this.graph.previewAdvance(outcome);
    const advancedAt = new Date().toISOString();
    const event = {
      id: randomUUID(),
      key: WorkflowEvents.workflow.advanced,
      payload: { ...advanced, outcome, advancedAt },
      occurredAt: advancedAt,
    };
    const persisted = this.scoutJournal.write(event);
    this.graph.advance(outcome);
    this.activeWorkflowState = advanced.cycleCompleted
      ? { workflowId: workflowState.workflowId, status: "settling", checkpointSeq: persisted.seq }
      : { ...workflowState, checkpointSeq: persisted.seq };
    this.eventBus!.publish(event.key, event.payload, event);
    return { state: advanced.state, cycleCompleted: advanced.cycleCompleted };
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
    const transition = Promise.resolve().then(async () => {
      const manifest = scope.manifestStore.read();
      const at = new Date().toISOString();
      const graph = this.graph.snapshot();
      const baseline: ScoutEvent[] = [
        { id: randomUUID(), key: RunEvents.run.created,
          payload: { runId: manifest.runId, scoutRoot: scope.scoutRoot, createdAt: manifest.createdAt }, occurredAt: manifest.createdAt },
        { id: randomUUID(), key: WorkflowEvents.workflow.initialized,
          payload: { state: { ...graph, currentPhase: graph.phases[0]!.name }, initializedAt: at }, occurredAt: at },
        ...scope.agentRegistry.listAgents().map((agent) => {
          const thread = agent.threadSnapshot;
          if (!thread || thread.status !== "active") throw new Error("Agent " + agent.agentId + " has no active Thread.");
          return { id: randomUUID(), key: AgentEvents.thread.started, payload: thread, occurredAt: at };
        }),
        ...scope.agentRegistry.listAgents().flatMap((agent) => agent instanceof CoordinatorAgent
          ? agent.pendingWorkflowInputs().flatMap(({ event, delivery }) => [
            event,
            { id: randomUUID(), key: AgentEvents.message.queued, payload: delivery, occurredAt: delivery.queuedAt },
          ]) : []),
      ];
      await this.beginNextWorkflow(baseline, scope.domainRegistry.list());
    }).finally(() => { if (this.transition === transition) this.transition = undefined; });
    this.transition = transition;
    await transition;
  }

  readEvents(): JournalEvent[] {
    return this.activeWorkflowState ? this.scoutJournal.readAll() : [];
  }

  get lastSeq(): number {
    return this.activeWorkflowState ? this.scoutJournal.lastSeq : 0;
  }

  get journalRoot(): string {
    return this.scoutJournal.journalRoot;
  }

  get journalPath(): string {
    return this.scoutJournal.path;
  }

  get journalFailed(): boolean {
    return this.activeWorkflowState ? this.scoutJournal.failed : false;
  }

  private async beginNextWorkflow(
    baseline: readonly ScoutEvent[],
    domains: readonly ScoutDomain[],
  ): Promise<void> {

    const scope = currentRunScope();
    const prepared = this.requireBenchmarks().prepareNext();
    let nextJournal: ReturnType<ScoutJournal["prepare"]> | undefined;
    const domainChanges: ScoutDomainWorkflowChange[] = [];
    let committed = false;
    const releasePreviousResources = (): void => {
      const failures: unknown[] = [];
      for (const change of domainChanges) {
        try { change.releasePrevious(); } catch (error) { failures.push(error); }
      }
      try { this.scoutJournal.releasePrevious(); } catch (error) { failures.push(error); }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to release previous Workflow resources.");
      }
    };
    const abortPreparedWorkflow = (error: unknown): never => {
      const failures: unknown[] = [];
      for (const change of [...domainChanges].reverse()) {
        try { change.abort(); } catch (failure) { failures.push(failure); }
      }
      if (nextJournal) {
        try { this.scoutJournal.discard(nextJournal); } catch (failure) { failures.push(failure); }
      }
      if (this.scoutJournal.hasPreparedJournals || failures.length > 0) {
        this.transitionFailure = new AggregateError(
          [error, ...failures],
          "Failed to release prepared Workflow resources; its directory is retained and further transitions are blocked.",
        );
        throw this.transitionFailure;
      }
      this.requireBenchmarks().discard(prepared);
      throw error;
    };

    try {
      for (const role of this.graph.snapshot().roles) {
        const { artifactRoot, logsRoot } = workflowAgentPaths(prepared.workflowRoot, role.name);
        mkdirSync(artifactRoot, { recursive: true });
        mkdirSync(logsRoot, { recursive: true });
      }
      nextJournal = this.scoutJournal.prepare(prepared.journalRoot, baseline);
      const workflowState = {
        workflowId: prepared.workflowId,
        status: "active" as const,
        checkpointSeq: nextJournal.checkpointSeq,
      };
      for (const domain of domains) {
        if (domain.prepareWorkflow) {
          domainChanges.push(await domain.prepareWorkflow(workflowState, prepared.journalRoot));
        }
      }
      this.requireBenchmarks().recordStarted(prepared.workflowId);
      committed = true;
      // All remaining switches are synchronous, in-memory commits; no close IO here.
      this.scoutJournal.activate(nextJournal);
      this.activeWorkflowState = workflowState;
      this.scoutJournal.start();
      this.graph.beginWorkflow();
      for (const change of domainChanges) change.commit();
      nextJournal = undefined;
      scope.stepStore.restore([]);
      scope.toolCallStore.restore([]);
      scope.humanInputStore.restore([]);
      releasePreviousResources();
    } catch (error) {
      if (committed) {
        this.transitionFailure = new Error(
          "Workflow was committed but finalization failed; stop this runtime before continuing.",
          { cause: error },
        );
        throw this.transitionFailure;
      }
      abortPreparedWorkflow(error);
    }
  }

  private requireActiveWorkflow(): WorkflowState {
    if (!this.started || this.stopping) throw new Error("Workflow is not accepting Graph changes.");
    if (this.transitionFailure) throw this.transitionFailure;
    if (this.transition) throw new Error("Cannot advance Workflow while its Workflow is transitioning.");
    const workflowState = this.requireWorkflowState();
    if (workflowState.status !== "active") throw new Error("Cannot advance a completed Workflow.");
    return workflowState;
  }

  /** User input is handed to the next Workflow; existing runtime work must finish here. */
  private assertWorkflowSettled(projection: ReturnType<typeof projectRun>, userInputs: ReadonlySet<string>): void {
    const pendingWork = projection.pendingMessages.filter((message) => !userInputs.has(message.messageId));
    const coordinatorRole = resolveSynthesisRole(this.graph.snapshot()).name;
    const coordinator = projection.threads.find((thread) => thread.role === coordinatorRole)?.agentId ?? coordinatorRole;
    const latestCoordinatorStep = projection.steps.filter((step) => step.agentId === coordinator && !step.taskId).at(-1);
    const reasons = [
      ...projection.tasks.filter((task) => task.status === "queued" || task.status === "running")
        .map((task) => `unfinished Task ${task.taskId} (${task.status})`),
      ...(pendingWork.length ? [`${pendingWork.length} pending Agent message(s)`] : []),
      ...(projection.turns.some((turn) => turn.completedAt === undefined) ? ["an unfinished Agent turn"] : []),
      ...(projection.steps.some((step) => step.status === AgentStepStatuses.Running) ? ["a running Agent step"] : []),
      ...(latestCoordinatorStep?.status === AgentStepStatuses.Interrupted ? ["an interrupted Coordinator step"] : []),
    ];
    if (reasons.length) throw new Error(`Cannot begin the next Workflow execution: ${reasons.join(", ")}.`);
  }

  private requireWorkflowState(): WorkflowState {
    if (!this.activeWorkflowState) throw new Error("Workflow is unavailable.");
    return this.activeWorkflowState;
  }

  private requireBenchmarks(): WorkflowBenchmarks {
    if (!this.benchmarks) throw new Error("Workflow Benchmarks are unavailable.");
    return this.benchmarks;
  }
}
