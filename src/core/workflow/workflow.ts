import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AgentEvents } from "../../agent/events/index.js";
import { AgentStepStatuses } from "../../agent/step/types.js";
import { CoordinatorAgent } from "../../agent/roles/coordinator-agent.js";
import { WorkerAgent } from "../../agent/roles/worker-agent.js";
import type { ScoutDomain, ScoutDomainFlowChange } from "../../domain/types.js";
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
import { WorkflowBenchmarks, type PreparedWorkflowFlow } from "./workflow-benchmarks.js";
import { WorkflowEvents } from "./workflow-events.js";
import { projectWorkflowFlowState, type WorkflowFlowState } from "./workflow-flow-state.js";

export interface WorkflowResumeInput {
  flow: WorkflowFlowState;
  journalRoot: string;
}

/** Orchestrates the Workflow-owned Graph, Scheduler, Scout Journal, and Benchmarks. */
export class Workflow {
  readonly graph: Graph;
  readonly scheduler: Scheduler;
  readonly scoutJournal: ScoutJournal;
  private benchmarks?: WorkflowBenchmarks;
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];
  private activeFlow?: WorkflowFlowState;
  private eventBus?: EventBus;
  private transition?: Promise<void>;
  private transitionFailure?: Error;
  private stopping = false;
  private started = false;

  constructor(private readonly input: {
    graphState: GraphState;
    resume?: WorkflowResumeInput;
    startBaseline?: readonly ScoutEvent[];
    expectedMissingFlow?: PreparedWorkflowFlow;
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
    const openInitialFlow = (): void => {
      if (this.input.resume) {
        const selected = benchmarks.resolve("currentFlow");
        if (selected?.flowId !== this.input.resume.flow.flowId || selected.journalRoot !== this.input.resume.journalRoot) {
          throw new Error("Workflow benchmark selection changed before its runtime lock was acquired; retry resume.");
        }
        this.scoutJournal.open(this.input.resume.journalRoot);
        // The boot projection was read before acquiring the journal lock. Never
        // attach its Graph to a newer (or replaced) persisted Flow.
        const events = this.scoutJournal.readAll();
        const created = events.find((event) => RunEvents.run.created.is(event));
        const flow = projectWorkflowFlowState(this.input.resume.flow.flowId, events);
        if (!created || !RunEvents.run.created.is(created)
          || created.payload.runId !== scope.runId
          || !isDeepStrictEqual(flow, this.input.resume.flow)
          || !isDeepStrictEqual(projectGraphState(events), this.graph.snapshot())) {
          throw new Error("Workflow recovery snapshot changed before its journal lock was acquired; retry resume.");
        }
        this.activeFlow = flow;
      } else {
        const expectedMissingFlow = this.input.expectedMissingFlow;
        if (expectedMissingFlow) {
          const selected = benchmarks.resolve("currentFlow");
          if (selected?.flowId !== expectedMissingFlow.flowId
            || selected.journalRoot !== expectedMissingFlow.journalRoot) {
            throw new Error("Workflow benchmark selection changed before its runtime lock was acquired; retry resume.");
          }
          let stillMissing = false;
          try {
            statSync(join(expectedMissingFlow.journalRoot, "scout.journal"));
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
            stillMissing = true;
          }
          if (!stillMissing) {
            throw new Error("Workflow missing journal reappeared before its runtime lock was acquired; retry resume.");
          }
        }
        const manifest = scope.manifestStore.read();
        if (manifest.runId !== scope.runId) throw new Error("Workflow baseline does not belong to the installed Run.");
        const baseline: ScoutEvent[] = this.input.startBaseline ? [...this.input.startBaseline] : [{
          id: `run-created-${manifest.runId}`,
          key: RunEvents.run.created,
          payload: { runId: manifest.runId, scoutRoot: scope.scoutRoot, createdAt: manifest.createdAt },
          occurredAt: manifest.createdAt,
        }];
        const created = baseline.find((event) => RunEvents.run.created.is(event));
        if (!created || !RunEvents.run.created.is(created) || created.payload.runId !== manifest.runId
          || created.payload.createdAt !== manifest.createdAt) {
          throw new Error("Workflow baseline must contain the persisted Run creation identity.");
        }
        const initializedAt = new Date().toISOString();
        if (baseline.some((event) => WorkflowEvents.workflow.initialized.is(event))) {
          throw new Error("Workflow owns its initial Graph fact; a supplied baseline cannot initialize it.");
        }
        baseline.push({
          id: randomUUID(), key: WorkflowEvents.workflow.initialized,
          payload: { state: this.graph.snapshot(), initializedAt }, occurredAt: initializedAt,
        });
        const prepared = benchmarks.prepareNext();
        this.scoutJournal.create(prepared.journalRoot, baseline);
        this.activeFlow = {
          flowId: prepared.flowId,
          status: "active",
          checkpointSeq: this.scoutJournal.lastSeq,
        };
        benchmarks.recordStarted(prepared.flowId);
      }
    };

    try {
      benchmarks.acquire();
      this.scheduler.start();
      openInitialFlow();
      this.scoutJournal.start();
      this.unsubscribers.push(
        scope.eventBus.subscribe(
          SystemEvents.interaction.userMessageSubmitted,
          () => this.assertAcceptingInput(),
          { priority: EventSubscriptionPriorities.Critical },
        ),
      );
      this.stopping = false;
      this.started = true;
      if (this.input.resume && this.requireFlow().status === "completed") {
        // Recovery supplies historical identities before runtime services are installed.
        const buildRecoveryBaseline = (): ScoutEvent[] => {
          const previousEvents = this.readEvents();
          const runCreated = previousEvents.find((event) => RunEvents.run.created.is(event));
          if (!runCreated) {
            throw new Error("Cannot begin the next Workflow execution without its Run baseline.");
          }
          const baselineAt = new Date().toISOString();
          const projection = projectRun(previousEvents, resolveSynthesisRole(this.graph.snapshot()).name);
          this.assertFlowSettled(projection, new Set(projection.userMessages.map((message) => message.messageId)));
          const pendingInputIds = new Set(projection.pendingMessages.map((message) => message.messageId));
          return [
            toScoutEvent(runCreated),
            {
              id: randomUUID(),
              key: WorkflowEvents.workflow.initialized,
              payload: { state: { ...this.graph.snapshot(), currentPhase: this.graph.snapshot().phases[0]!.name }, initializedAt: baselineAt },
              occurredAt: baselineAt,
            },
            ...previousEvents.filter((event) => AgentEvents.thread.started.is(event)
              || AgentEvents.thread.restarted.is(event)).map(toScoutEvent),
            ...previousEvents.filter((event) =>
              (SystemEvents.interaction.userMessageSubmitted.is(event)
                || AgentEvents.message.queued.is(event))
              && pendingInputIds.has(event.payload.messageId)
            ).map(toScoutEvent),
          ];
        };
        const transition = Promise.resolve().then(async () => {
          await this.eventBus!.drain(SystemEvents.interaction.userMessageSubmitted);
          const baseline = buildRecoveryBaseline();
          const terminal = [...this.readEvents()].reverse().find((event) => WorkflowEvents.workflow.advanced.is(event));
          if (terminal && WorkflowEvents.workflow.advanced.is(terminal) && terminal.payload.outcome === "completed") {
            benchmarks.recordSuccess(this.requireFlow().flowId);
          }
          await this.beginNextFlow(baseline, []);
        }).finally(() => {
          if (this.transition === transition) this.transition = undefined;
        });
        this.transition = transition;
        await transition;
      } else if (this.input.resume) {
        benchmarks.recordRun(this.requireFlow().flowId);
      }
    } catch (error) {
      const failures: unknown[] = [error];
      while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
      try {
        this.scoutJournal.stop();
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

  /** Input admission depends on Flow readiness, never on Journal write success. */
  assertAcceptingInput(): void {
    if (!this.started || this.stopping) throw new Error("Workflow is stopping or not started; input is unavailable.");
    if (this.transitionFailure) throw this.transitionFailure;
    if (this.transition || this.requireFlow().status !== "active") {
      throw new Error("Workflow Flow is not ready to accept input.");
    }
  }

  /** Called after Coordinator work settles, independently of the next user input. */
  async prepareNextFlow(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (!this.started) return Promise.reject(new Error("Workflow is not started."));
    if (this.transitionFailure) throw this.transitionFailure;
    if (this.transition) return this.transition;
    if (this.requireFlow().status === "active") return;
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
        this.assertFlowSettled(projection, new Set([
          ...projection.userMessages.map((message) => message.messageId),
          ...(coordinator instanceof CoordinatorAgent ? coordinator.pendingFlowInputs().map(({ delivery }) => delivery.messageId) : []),
        ]));
        const blockingReasons = scope.agentRegistry.listAgents().flatMap((agent) => {
            const snapshot = agent.snapshot();
            if (snapshot.activeTask && (snapshot.activeTask.status === "queued" || snapshot.activeTask.status === "running")) {
              return [`Agent ${agent.agentId} still has unfinished Task ${snapshot.activeTask.taskId}`];
            }
            const deferredInputs = agent instanceof CoordinatorAgent ? agent.pendingFlowInputs().length : 0;
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
      const buildRuntimeBaseline = (): ScoutEvent[] => {
        const runCreated = currentEvents.find((event) => RunEvents.run.created.is(event));
        const runtimeAttached = [...currentEvents].reverse().find((event) =>
          RunEvents.runtime.attached.is(event)
        );
        if (!runCreated || !runtimeAttached) {
          throw new Error("Cannot begin the next Workflow execution without its Run baseline.");
        }
        const baselineAt = new Date().toISOString();
        const threadEvents = scope.agentRegistry.listAgents().map((agent, index) => {
          const thread = agent.threadSnapshot;
          if (!thread || thread.status !== "active") {
            throw new Error(
              `Cannot begin the next Workflow execution without active Agent ${agent.agentId}.`,
            );
          }
          return {
            id: `workflow-baseline-thread-${index + 1}-${baselineAt}`,
            key: AgentEvents.thread.started,
            payload: structuredClone(thread),
            occurredAt: baselineAt,
          };
        });
        return [
          toScoutEvent(runCreated),
          {
            id: randomUUID(),
            key: WorkflowEvents.workflow.initialized,
              payload: { state: { ...this.graph.snapshot(), currentPhase: this.graph.snapshot().phases[0]!.name }, initializedAt: baselineAt },
            occurredAt: baselineAt,
          },
          toScoutEvent(runtimeAttached),
          ...threadEvents,
          ...(coordinator instanceof CoordinatorAgent
            ? coordinator.pendingFlowInputs().flatMap(({ event, delivery }) => [
              event,
              { id: randomUUID(), key: AgentEvents.message.queued, payload: delivery, occurredAt: delivery.queuedAt },
            ])
            : currentEvents.filter((event) => {
              if (!SystemEvents.interaction.userMessageSubmitted.is(event)
                && !AgentEvents.message.queued.is(event)) return false;
              return projection.userMessages.some((message) => message.messageId === event.payload.messageId)
                && projection.pendingMessages.some((message) => message.messageId === event.payload.messageId);
            }).map(toScoutEvent)),
        ];
      };

      assertRuntimeSettled();
      for (const agent of scope.agentRegistry.listAgents()) {
        const task = agent.snapshot().activeTask;
        if (agent instanceof WorkerAgent && task) await agent.releaseTask(task.taskId);
      }
      // Releases belong to the old Flow and must be persisted before completion.
      currentEvents = this.readEvents();
      projection = projectRun(currentEvents, resolveSynthesisRole(this.scheduler.snapshot()).name,
        readDomainJournalProjections(domains));
      assertRuntimeSettled();
      if (projection.tasks.length > 0 || scope.taskStore.listTasks().length > 0) {
        throw new Error("Cannot begin the next Workflow execution: Task bindings remain after Worker release.");
      }
      if (this.requireFlow().status === "settling") {
        const completedAt = new Date().toISOString();
        const completion = { id: randomUUID(), key: WorkflowEvents.workflow.completed, payload: { completedAt }, occurredAt: completedAt };
        const persisted = this.scoutJournal.write(completion);
        this.activeFlow = { ...this.requireFlow(), status: "completed", completedAt, checkpointSeq: persisted.seq };
        this.eventBus!.publish(completion.key, completion.payload, completion);
      }
      const terminal = [...currentEvents].reverse().find((event) => WorkflowEvents.workflow.advanced.is(event));
      if (terminal && WorkflowEvents.workflow.advanced.is(terminal) && terminal.payload.outcome === "completed") {
        this.requireBenchmarks().recordSuccess(this.requireFlow().flowId);
      }
      await this.beginNextFlow(buildRuntimeBaseline(), domains);
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
    const flow = this.requireActiveFlow();
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
    this.activeFlow = { ...flow, checkpointSeq: persisted.seq };
    this.eventBus!.publish(event.key, event.payload, event);
    return state;
  }

  /** Coordinates durable Graph, Flow, and benchmark changes requested by Scheduler. */
  advanceGraph(outcome: WorkflowPhaseOutcome): SchedulerAdvanceResult {
    const flow = this.requireActiveFlow();
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
    this.activeFlow = advanced.cycleCompleted
      ? { flowId: flow.flowId, status: "settling", checkpointSeq: persisted.seq }
      : { ...flow, checkpointSeq: persisted.seq };
    this.eventBus!.publish(event.key, event.payload, event);
    return { state: advanced.state, cycleCompleted: advanced.cycleCompleted };
  }

  flowSnapshot(): WorkflowFlowState {
    return { ...structuredClone(this.requireFlow()), checkpointSeq: this.lastSeq };
  }

  readEvents(): JournalEvent[] {
    return this.scoutJournal.readAll();
  }

  get lastSeq(): number {
    return this.scoutJournal.lastSeq;
  }

  get journalRoot(): string {
    return this.scoutJournal.journalRoot;
  }

  get journalPath(): string {
    return this.scoutJournal.path;
  }

  get journalFailed(): boolean {
    return this.scoutJournal.failed;
  }

  private async beginNextFlow(
    baseline: readonly ScoutEvent[],
    domains: readonly ScoutDomain[],
  ): Promise<void> {
    const previousEvents = this.readEvents();
    const latestWorkflowEvent = [...previousEvents].reverse().find((event) =>
      WorkflowEvents.workflow.initialized.is(event)
      || WorkflowEvents.workflow.advanced.is(event)
    );
    if (
      !latestWorkflowEvent
      || !WorkflowEvents.workflow.advanced.is(latestWorkflowEvent)
      || !latestWorkflowEvent.payload.cycleCompleted
    ) throw new Error("Completed Workflow Flow has no persisted terminal Graph fact.");

    const scope = currentRunScope();
    const prepared = this.requireBenchmarks().prepareNext();
    let nextJournal: ReturnType<ScoutJournal["prepare"]> | undefined;
    const domainChanges: ScoutDomainFlowChange[] = [];
    let committed = false;
    const releasePreviousResources = (): void => {
      const failures: unknown[] = [];
      for (const change of domainChanges) {
        try { change.releasePrevious(); } catch (error) { failures.push(error); }
      }
      try { this.scoutJournal.releasePrevious(); } catch (error) { failures.push(error); }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to release previous Flow resources.");
      }
    };
    const abortPreparedFlow = (error: unknown): never => {
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
          "Failed to release prepared Flow resources; its directory is retained and further transitions are blocked.",
        );
        throw this.transitionFailure;
      }
      this.requireBenchmarks().discard(prepared);
      throw error;
    };

    try {
      nextJournal = this.scoutJournal.prepare(prepared.journalRoot, baseline);
      const flow = {
        flowId: prepared.flowId,
        status: "active" as const,
        checkpointSeq: nextJournal.checkpointSeq,
      };
      for (const domain of domains) {
        if (domain.prepareFlow) {
          domainChanges.push(await domain.prepareFlow(flow, prepared.journalRoot));
        }
      }
      this.requireBenchmarks().recordStarted(prepared.flowId);
      committed = true;
      // All remaining switches are synchronous, in-memory commits; no close IO here.
      this.scoutJournal.activate(nextJournal);
      this.activeFlow = flow;
      this.graph.beginFlow();
      for (const change of domainChanges) change.commit();
      nextJournal = undefined;
      scope.stepStore.restore([]);
      scope.toolCallStore.restore([]);
      scope.humanInputStore.restore([]);
      releasePreviousResources();
    } catch (error) {
      if (committed) {
        this.transitionFailure = new Error(
          "Workflow Flow was committed but finalization failed; stop this runtime before continuing.",
          { cause: error },
        );
        throw this.transitionFailure;
      }
      abortPreparedFlow(error);
    }
  }

  private requireActiveFlow(): WorkflowFlowState {
    if (!this.started || this.stopping) throw new Error("Workflow is not accepting Graph changes.");
    if (this.transitionFailure) throw this.transitionFailure;
    if (this.transition) throw new Error("Cannot advance Workflow while its Flow is transitioning.");
    const flow = this.requireFlow();
    if (flow.status !== "active") throw new Error("Cannot advance a completed Workflow Flow.");
    return flow;
  }

  /** User input is handed to the next Flow; existing runtime work must finish here. */
  private assertFlowSettled(projection: ReturnType<typeof projectRun>, userInputs: ReadonlySet<string>): void {
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

  private requireFlow(): WorkflowFlowState {
    if (!this.activeFlow) throw new Error("Workflow Flow is unavailable.");
    return this.activeFlow;
  }

  private requireBenchmarks(): WorkflowBenchmarks {
    if (!this.benchmarks) throw new Error("Workflow Benchmarks are unavailable.");
    return this.benchmarks;
  }
}

function toScoutEvent(event: JournalEvent): ScoutEvent {
  return {
    id: event.id,
    key: event.key,
    payload: structuredClone(event.payload),
    occurredAt: event.occurredAt,
  };
}
