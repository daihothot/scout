import { AgentInbox } from "../core/agent-inbox.js";
import { AgentHumanInputStore } from "../human-input/agent-human-input-store.js";
import { AgentStepStore } from "../step/agent-step-store.js";
import { AgentTaskStore } from "../task/agent-task-store.js";
import { AgentToolCallStore } from "../tool-call/agent-tool-call-store.js";
import { AgentEvents } from "../events/index.js";
import { WorkerAgent } from "../roles/worker-agent.js";
import { resolveSynthesisRole, type WorkflowData, type ScoutWorkflowParticipant } from "../../core/workflow/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { projectAgentWorkflow, type AgentWorkflowData } from "./projector/agent-workflow-projector.js";
import { AgentEntityRecovery } from "./recovery/agent-entity-recovery.js";
import { AgentTaskRecovery } from "./recovery/agent-task-recovery.js";
import { AgentContextRecovery } from "./recovery/agent-context-recovery.js";
import { AgentInterruptionRecovery } from "./recovery/agent-interruption-recovery.js";

/** Observable lifecycle state for the task-event orchestrator. */
export interface AgentOrchestratorSnapshot {
  started: boolean;
  stopped: boolean;
  pendingEventCount: number;
}

/** Owns Agent runtime stores, recovery, and Workflow participation. */
export class AgentOrchestrator implements ScoutWorkflowParticipant {
  readonly humanInputStore = new AgentHumanInputStore();
  readonly stepStore = new AgentStepStore();
  readonly taskStore = new AgentTaskStore();
  readonly toolCallStore = new AgentToolCallStore();
  private readonly inbox: AgentInbox;
  private started = false;
  private stopped = false;
  private readonly entityRecovery = new AgentEntityRecovery();
  private readonly contextRecovery = new AgentContextRecovery();
  private entitiesRestored = false;
  private runtimeReady = false;
  private activationPending = false;

  constructor() {
    this.inbox = new AgentInbox({
      isStopped: () => this.stopped,
      onEvents: async (events) => {
        for (const event of events) {
          if (!AgentEvents.task.is(event)) {
            throw new Error(`AgentOrchestrator received unsupported event: ${event.key.routeKey}`);
          }
        }
      },
      onError: () => undefined,
    });
  }

  start(): void {
    if (this.stopped) {
      throw new Error("Cannot restart a stopped AgentOrchestrator.");
    }
    if (this.started) return;
    try {
      this.humanInputStore.start();
      this.stepStore.start(this.humanInputStore);
      this.inbox.subscribe(AgentEvents.task);
      this.started = true;
    } catch (error) {
      try { this.stop(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "AgentOrchestrator startup and cleanup failed."); }
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    const failures: unknown[] = [];
    try { this.inbox.stop(); } catch (error) { failures.push(error); }
    try { this.stepStore.dispose(); } catch (error) { failures.push(error); }
    try { this.humanInputStore.dispose(); } catch (error) { failures.push(error); }
    try { this.toolCallStore.dispose(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "AgentOrchestrator cleanup failed.");
  }

  create(): void { this.clearWorkflow(); }

  async restore(data: WorkflowData): Promise<void> {
    const scope = currentRunScope();
    const synthesisRole = resolveSynthesisRole(scope.workflow.graph.snapshot()).name;
    let projection = projectAgentWorkflow(scope.workflow.readEvents(), synthesisRole);
    if (data.status === "completed") {
      const userInputs = new Set(projection.userMessages.map((message) => message.messageId));
      const coordinator = projection.threads.find((thread) => thread.role === synthesisRole)?.agentId ?? synthesisRole;
      const reasons = [
        ...projection.tasks.filter((task) => task.status === "queued" || task.status === "running")
          .map((task) => `unfinished Task ${task.taskId} (${task.status})`),
        ...(projection.pendingMessages.some((message) => !userInputs.has(message.messageId)) ? ["pending Agent messages"] : []),
        ...(projection.turns.some((turn) => turn.agentId !== coordinator && !turn.completedAt) ? ["an unfinished Worker turn"] : []),
        ...(projection.steps.some((step) => step.agentId !== coordinator && step.status === "running") ? ["a running Worker step"] : []),
      ];
      if (reasons.length) throw new Error(`Cannot restore completed Workflow: ${reasons.join(", ")}.`);
      await this.restoreEntities(projection);
      return;
    }
    await new AgentInterruptionRecovery().restore();
    projection = projectAgentWorkflow(scope.workflow.readEvents(), synthesisRole);
    await this.restoreEntities(projection);
    // Restoring native Threads can append replacement identities to the Scout record.
    projection = projectAgentWorkflow(scope.workflow.readEvents(), synthesisRole);
    await new AgentTaskRecovery().restore(projection);
    await this.contextRecovery.restore(projection);
    this.activationPending = true;
  }

  /** Agent entities also exist in the blank period, independently of Workflow task data. */
  async restoreEntities(projection?: AgentWorkflowData): Promise<void> {
    if (this.entitiesRestored) return;
    await this.entityRecovery.restore(projection);
    this.entitiesRestored = true;
  }

  run(): void { if (this.runtimeReady && this.activationPending) this.activate(); }

  /** Called by the Run entry point only after all ready consumers have succeeded. */
  ready(): void {
    this.runtimeReady = true;
    if (this.activationPending) this.activate();
  }

  async close(): Promise<void> {
    this.activationPending = false;
    const failures: unknown[] = [];
    for (const agent of currentRunScope().agentRegistry.listAgents()) {
      const task = agent.snapshot().activeTask;
      try { if (agent instanceof WorkerAgent && task) await agent.releaseTask(task.taskId); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Agent Workflow task release failed.");
  }

  abort(): void { this.activationPending = false; }

  clearWorkflow(): void {
    this.activationPending = false;
    this.contextRecovery.clearWorkflow();
    // A terminal tool call can finish the Workflow inside an ongoing Agent Turn.
    // Its Step and references belong to that Agent execution until it finishes.
    const runningSteps = this.stepStore.list().filter((step) => step.status === "running");
    const stepIds = new Set(runningSteps.map((step) => step.stepId));
    const requestIds = new Set(runningSteps.flatMap((step) => step.humanInputReferences.map((reference) => reference.requestId)));
    this.toolCallStore.restore(this.toolCallStore.list().filter((call) => stepIds.has(call.stepId)));
    this.humanInputStore.restore(this.taskStore.listTasks().flatMap((task) =>
      this.humanInputStore.listForTask(task.taskId)).filter((input) => requestIds.has(input.requestId)));
    this.stepStore.restore(runningSteps);
    for (const task of this.taskStore.listTasks()) this.taskStore.removeTask(task.taskId);
  }

  async stopEntities(reason: string): Promise<void> { await this.entityRecovery.stop(reason); }

  private activate(): void {
    this.activationPending = false;
    this.contextRecovery.activate();
  }

  snapshot(): AgentOrchestratorSnapshot {
    return {
      started: this.started,
      stopped: this.stopped,
      pendingEventCount: this.inbox.size,
    };
  }
}
