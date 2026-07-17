import {
  attachments,
} from "../../context/attachments.js";
import {
  AgentContextTags,
  agent,
} from "../../context/agent-attachments.js";
import { AgenticLoop } from "../../core/agentic-loop.js";
import {
  AgentTaskStore,
  cloneAgentTaskState as cloneTaskState,
} from "../../task/agent-task-store.js";
import type { EventBus } from "../../../core/events/index.js";
import { AgentEvents } from "../../events/index.js";
import {
  AgentTaskStatuses,
  AgentTaskStepStatuses,
  type AgentTaskStep,
  type AgentTaskState,
  type AssignAgentTaskInput,
  type SendAgentMessageInput,
} from "../../task/types.js";
import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../../core/scout-agent.js";
import type { AgentThreadSpec } from "../../thread/types.js";
import { readSendMessageAttachment } from "../../tools/agent-tools.js";
import { AgentRunner } from "../types.js";

export interface WorkerRunnerSnapshot {
  activeTask?: AgentTaskState;
  pendingMessageCount: number;
}

export interface WorkerRunnerHost {
  readonly agentId: string;
  readonly role: AgentThreadSpec["role"];
  readonly spec: AgentThreadSpec;
  runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome>;
  deliverTaskOutcome(outcome: string): void;
}

export interface WorkerRunnerOptions {
  host: WorkerRunnerHost;
  store: AgentTaskStore;
  eventBus: EventBus;
  taskSequence: number;
  taskInput?: AssignAgentTaskInput;
}

export class WorkerRunner extends AgentRunner {
  readonly runnerKind = "worker";
  private readonly host: WorkerRunnerHost;
  private readonly store: AgentTaskStore;
  private readonly eventBus: EventBus;
  private readonly taskSequence: number;
  private readonly loop: AgenticLoop<AgentTaskState>;
  private pendingMessages: string[] = [];
  private pendingSubmission?: {
    stepId: string;
    outcome: string;
  };
  private activeTask?: AgentTaskState;
  private stopped = false;

  constructor(options: WorkerRunnerOptions) {
    super();
    this.host = options.host;
    this.store = options.store;
    this.eventBus = options.eventBus;
    this.taskSequence = options.taskSequence;
    this.loop = new AgenticLoop<AgentTaskState>({
      agentId: this.host.agentId,
      takeTick: () => this.takeTaskTurn(),
      runTick: (task) => this.runTaskTurn(task),
      isStopped: () => this.stopped,
      onError: (error) => this.failActiveTask(error),
    });
    if (options.taskInput) {
      this.initializeTask(options.taskInput);
    }
  }

  get agentId(): string {
    return this.host.agentId;
  }

  private initializeTask(input: AssignAgentTaskInput): AgentTaskState {
    if (this.stopped) {
      throw new Error(`Agent ${this.host.agentId} is stopped.`);
    }
    if (this.activeTask) {
      throw new Error(`Worker runner ${this.host.agentId} already has task ${this.activeTask.taskId}.`);
    }
    const now = new Date().toISOString();
    const taskSequence = this.taskSequence;
    const taskId = input.taskId ?? this.buildTaskId(taskSequence);
    const task: AgentTaskState = {
      type: "local_agent",
      taskId,
      taskSequence,
      agentId: this.host.agentId,
      role: this.host.role,
      description: input.description,
      initialPrompt: input.prompt,
      status: AgentTaskStatuses.Queued,
      isBackgrounded: input.isBackgrounded ?? true,
      createdAt: now,
      updatedAt: now,
    };
    const stored = this.store.addTask(task);
    this.activeTask = stored;
    this.eventBus.publish(AgentEvents.task.assigned, stored);
    queueMicrotask(() => this.loop.schedule());
    return stored;
  }

  private buildTaskId(taskSequence: number): string {
    return `${this.host.agentId}-task-${String(taskSequence).padStart(4, "0")}`;
  }

  queueMessage(input: SendAgentMessageInput): void {
    const task = this.resolveMessageTarget(input.taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Cannot queue message for terminal task ${task.taskId}. Status: ${task.status}`);
    }
    const message = attachments.compose(input.message);
    this.pendingMessages = [...this.pendingMessages, message];
    const updated = this.updateTask(task.taskId, (currentTask) => ({
      ...currentTask,
      updatedAt: new Date().toISOString(),
    }));
    this.activeTask = updated;
    this.eventBus.publish(AgentEvents.task.messageQueued, updated);
    this.loop.schedule();
  }

  submitTask(outcome: string): AgentTaskState {
    const task = this.activeTask;
    if (!task || task.status !== AgentTaskStatuses.Running) {
      throw new Error(`Worker runner ${this.host.agentId} cannot submit without a running task.`);
    }
    const steps = task.steps ?? [];
    const currentStep = steps[steps.length - 1];
    if (!currentStep || currentStep.status !== AgentTaskStepStatuses.Running) {
      throw new Error(`Worker task ${task.taskId} has no running step to submit.`);
    }
    if (this.pendingSubmission) {
      throw new Error(`Worker task step ${this.pendingSubmission.stepId} has already submitted an outcome.`);
    }
    this.pendingSubmission = {
      stepId: currentStep.stepId,
      outcome,
    };
    return cloneTaskState(task);
  }

  stopTask(taskId: string, reason = "任务已被 Coordinator 停止。"): AgentTaskState {
    const task = this.getTask(taskId);
    if (isTerminalTaskStatus(task.status)) return cloneTaskState(task);
    this.pendingMessages = [];
    this.pendingSubmission = undefined;
    const stopped = this.updateTask(taskId, (current) => ({
      ...current,
      status: AgentTaskStatuses.Stopped,
      error: reason,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.activeTask = stopped;
    this.eventBus.publish(AgentEvents.task.stopped, stopped);
    this.eventBus.publish(AgentEvents.task.terminal, stopped);
    return cloneTaskState(stopped);
  }

  stopAgent(reason = "Agent stopped."): void {
    this.stopped = true;
    const task = this.activeTask;
    if (task && !isTerminalTaskStatus(task.status)) {
      this.stopTask(task.taskId, reason);
    }
    this.loop.stop();
  }

  stop(reason?: string): void {
    this.stopAgent(reason);
  }

  getTaskSnapshot(taskId: string): AgentTaskState | undefined {
    if (this.activeTask?.taskId !== taskId) return undefined;
    return this.store.getTask(taskId);
  }

  async archiveTask(taskId: string): Promise<AgentTaskState> {
    this.ensureOwnedTask(taskId);
    this.stopped = true;
    this.loop.stop();
    await this.loop.runToIdle();
    this.pendingMessages = [];
    this.pendingSubmission = undefined;
    const archived = this.store.removeTask(taskId);
    this.activeTask = undefined;
    this.eventBus.publish(AgentEvents.task.archived, archived);
    return cloneTaskState(archived);
  }

  private applyPendingMessageState(
    task: AgentTaskState,
    messages: string[],
  ): AgentTaskState {
    const shouldResume = messages.length > 0
      && task.status === AgentTaskStatuses.Done;
    if (!shouldResume) {
      return task;
    }
    const updated = this.updateTask(task.taskId, (current) => ({
      ...current,
      status: AgentTaskStatuses.Running,
      updatedAt: new Date().toISOString(),
    }));
    this.activeTask = updated;
    return updated;
  }

  async runTasksToIdle(): Promise<void> {
    await this.loop.runToIdle();
  }

  snapshot(): WorkerRunnerSnapshot {
    return {
      activeTask: this.activeTask ? cloneTaskState(this.activeTask) : undefined,
      pendingMessageCount: this.pendingMessages.length,
    };
  }

  private takeTaskTurn(): AgentTaskState | undefined {
    const task = this.activeTask;
    if (!task) return undefined;
    return task.status === AgentTaskStatuses.Queued
        || this.countPendingMessages(task.taskId) > 0
      ? task
      : undefined;
  }

  private async runTaskTurn(activeTask: AgentTaskState): Promise<void> {
    const taskId = activeTask.taskId;
    this.ensureOwnedTask(taskId);
    let task = this.getTask(taskId);
    if (
      task.status !== AgentTaskStatuses.Queued
      && task.status !== AgentTaskStatuses.Running
      && task.status !== AgentTaskStatuses.Done
    ) {
      return;
    }
    const hadStarted = Boolean(task.startedAt);
    const initialPrompt = hadStarted ? undefined : task.initialPrompt;
    if (!hadStarted) {
      if (!initialPrompt) {
        throw new Error(`Task ${taskId} has no initial prompt.`);
      }
      task = this.updateTask(taskId, (current) => ({
        ...current,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      task = this.getTask(taskId);
      if (isTerminalTaskStatus(task.status)) {
        this.activeTask = task;
        return;
      }
    }

    const pendingMessages = this.drainPendingMessages(taskId);
    task = this.applyPendingMessageState(task, pendingMessages);
    if (pendingMessages.length > 0) {
      this.eventBus.publish(AgentEvents.task.pendingMessagesDrained, task);
    }
    task = this.getTask(taskId);
    if (isTerminalTaskStatus(task.status)) {
      this.activeTask = task;
      return;
    }
    const prompt = attachments.compose(
      agent.turn.use_update_tools(),
      ...(initialPrompt === undefined ? [] : [initialPrompt]),
      ...pendingMessages,
    );

    const running = this.updateTask(taskId, (current) => this.appendTaskStep({
      task: {
        ...current,
        status: AgentTaskStatuses.Running,
      },
      prompt,
      startedAt: new Date().toISOString(),
    }));
    this.activeTask = running;
    this.eventBus.publish(AgentEvents.task.stepStarted, running);

    const startedAt = Date.now();
    const outcome = await this.host.runTurn({
      prompt,
      sandbox: this.host.spec.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly",
    });
    const durationMs = Date.now() - startedAt;
    const latest = this.getTask(taskId);
    if (latest.status === AgentTaskStatuses.Stopped) {
      this.pendingSubmission = undefined;
      this.activeTask = latest;
      return;
    }
    if (isTerminalTaskStatus(latest.status)) {
      this.pendingSubmission = undefined;
      const updated = this.updateTask(taskId, (current) => this.completeLatestTaskStep({
        task: current,
        outcome,
        durationMs,
        status: outcome.turn.status === "failed" ? AgentTaskStepStatuses.Failed : AgentTaskStepStatuses.Completed,
      }));
      this.activeTask = updated;
      this.eventBus.publish(AgentEvents.task.stepCompleted, updated);
      return;
    }

    if (outcome.turn.status === "completed") {
      const stillRunning = this.updateTask(taskId, (current) => this.completeLatestTaskStep({
        task: current,
        outcome,
        durationMs,
        status: AgentTaskStepStatuses.Completed,
      }));
      this.activeTask = stillRunning;
      this.eventBus.publish(AgentEvents.task.stepCompleted, stillRunning);
      const submission = this.pendingSubmission;
      this.pendingSubmission = undefined;
      if (submission) {
        const completedStep = stillRunning.steps?.[stillRunning.steps.length - 1];
        if (submission.stepId !== completedStep?.stepId) {
          throw new Error(
            `Worker task ${taskId} submitted outcome for ${submission.stepId}, not ${completedStep?.stepId ?? "<none>"}.`,
          );
        }
        this.host.deliverTaskOutcome(submission.outcome);
        const done = this.updateTask(taskId, (current) => ({
          ...current,
          status: AgentTaskStatuses.Done,
          updatedAt: new Date().toISOString(),
        }));
        this.activeTask = done;
        this.eventBus.publish(AgentEvents.task.done, done);
      }
      return;
    }

    this.pendingSubmission = undefined;
    const failed = this.updateTask(taskId, (current) => this.completeLatestTaskStep({
      task: {
        ...current,
        status: AgentTaskStatuses.Failed,
        error: outcome.turn.error,
        finishedAt: new Date().toISOString(),
      },
      outcome,
      durationMs,
      status: AgentTaskStepStatuses.Failed,
    }));
    this.activeTask = failed;
    this.eventBus.publish(AgentEvents.task.failed, failed);
    this.eventBus.publish(AgentEvents.task.terminal, failed);
  }

  private failActiveTask(error: unknown): void {
    this.pendingSubmission = undefined;
    if (!this.activeTask) {
      return;
    }
    const taskId = this.activeTask.taskId;
    const failed = this.updateTask(taskId, (current) => ({
      ...current,
      status: AgentTaskStatuses.Failed,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.activeTask = failed;
    this.eventBus.publish(AgentEvents.task.failed, failed);
    this.eventBus.publish(AgentEvents.task.terminal, failed);
  }

  private appendTaskStep(input: {
    task: AgentTaskState;
    prompt: string;
    startedAt: string;
  }): AgentTaskState {
    const step: AgentTaskStep = {
      stepId: `${input.task.taskId}-step-${String((input.task.steps?.length ?? 0) + 1).padStart(4, "0")}`,
      taskId: input.task.taskId,
      status: AgentTaskStepStatuses.Running,
      prompt: input.prompt,
      toolCalls: [],
      startedAt: input.startedAt,
      humanInputResponse: attachments.readTagBlock(
        input.prompt,
        AgentContextTags.HumanResponse,
      ).map(({ body }) => ({ body }))[0],
    };
    return {
      ...input.task,
      steps: [...(input.task.steps ?? []), step],
      updatedAt: new Date().toISOString(),
    };
  }

  private completeLatestTaskStep(input: {
    task: AgentTaskState;
    outcome: ScoutAgentTurnOutcome;
    durationMs: number;
    status: AgentTaskStep["status"];
    protocolWarnings?: string[];
    error?: string;
  }): AgentTaskState {
    return this.updateLatestTaskStep({
      task: {
        ...input.task,
        status: input.status === AgentTaskStepStatuses.Completed ? input.task.status : input.status,
      },
      update: (step) => ({
        ...step,
        turnId: input.outcome.turn.turnId,
        status: input.status,
        finalResponse: input.outcome.finalResponse,
        toolCalls: input.outcome.toolCalls ?? [],
        humanInputRequest: readSendMessageAttachment(
          input.outcome.toolCalls,
          AgentContextTags.WaitForHumanRequest,
        ),
        finishedAt: input.outcome.turn.finishedAt,
        durationMs: input.durationMs,
        protocolWarnings: input.protocolWarnings,
        error: input.error ?? input.outcome.turn.error,
      }),
      usage: {
        ...input.task.usage,
        durationMs: (input.task.usage?.durationMs ?? 0) + input.durationMs,
        toolUses: (input.task.usage?.toolUses ?? 0) + (input.outcome.toolCalls?.length ?? 0),
      },
      updatedAt: new Date().toISOString(),
    });
  }

  private updateLatestTaskStep(input: {
    task: AgentTaskState;
    update: (step: AgentTaskStep) => AgentTaskStep;
    usage?: AgentTaskState["usage"];
    updatedAt: string;
  }): AgentTaskState {
    const steps = input.task.steps ?? [];
    const latest = steps[steps.length - 1];
    if (!latest) throw new Error(`Task ${input.task.taskId} has no current step.`);
    return {
      ...input.task,
      steps: [...steps.slice(0, -1), input.update(latest)],
      usage: input.usage ?? input.task.usage,
      updatedAt: input.updatedAt,
    };
  }

  private resolveMessageTarget(taskId: string | undefined): AgentTaskState {
    if (!this.activeTask) {
      throw new Error(`Agent ${this.host.agentId} has no active task for SendMessage.`);
    }
    if (taskId && taskId !== this.activeTask.taskId) {
      throw new Error(`Worker runner ${this.host.agentId} owns task ${this.activeTask.taskId}, not ${taskId}.`);
    }
    if (taskId) return this.getTask(taskId);
    return this.activeTask;
  }

  private drainPendingMessages(taskId: string): string[] {
    this.ensureOwnedTask(taskId);
    const messages = this.pendingMessages;
    this.pendingMessages = [];
    return messages;
  }

  private countPendingMessages(taskId: string): number {
    this.ensureOwnedTask(taskId);
    return this.pendingMessages.length;
  }

  private getTask(taskId: string): AgentTaskState {
    this.ensureOwnedTask(taskId);
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Unknown agent task: ${taskId}`);
    if (task.agentId !== this.host.agentId) {
      throw new Error(`Task ${taskId} does not belong to agent ${this.host.agentId}.`);
    }
    return task;
  }

  private updateTask(taskId: string, update: (task: AgentTaskState) => AgentTaskState): AgentTaskState {
    this.ensureOwnedTask(taskId);
    const current = this.getTask(taskId);
    if (current.agentId !== this.host.agentId) {
      throw new Error(`Task ${taskId} does not belong to agent ${this.host.agentId}.`);
    }
    return this.store.updateTask(taskId, update);
  }

  private ensureOwnedTask(taskId: string): void {
    if (this.activeTask?.taskId !== taskId) {
      throw new Error(`Worker runner ${this.host.agentId} owns task ${this.activeTask?.taskId ?? "<none>"}, not ${taskId}.`);
    }
  }

}

export function cloneAgentTaskState(task: AgentTaskState): AgentTaskState {
  return cloneTaskState(task);
}

export function isTerminalTaskStatus(status: AgentTaskState["status"]): boolean {
  return status === AgentTaskStatuses.Failed
    || status === AgentTaskStatuses.Stopped;
}
