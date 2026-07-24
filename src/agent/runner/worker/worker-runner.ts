import {
  attachments,
} from "../../context/attachments.js";
import {
  AgentContextTags,
  agent,
} from "../../context/agent-attachments.js";
import { AgenticLoop } from "../../core/agentic-loop.js";
import {
  cloneAgentTaskState as cloneTaskState,
} from "../../task/agent-task-store.js";
import { currentRunScope } from "../../../run/run-scope.js";
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
import {
  AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE,
  parseAgentDynamicToolCall,
} from "../../tools/agent-tools.js";
import { AgentRunner } from "../types.js";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../../message/types.js";

export interface WorkerRunnerSnapshot {
  activeTask?: AgentTaskState;
  pendingMessageCount: number;
}

export interface WorkerRunnerHost {
  readonly agentId: string;
  readonly role: AgentThreadSpec["role"];
  readonly spec: AgentThreadSpec;
  runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome>;
  deliverTaskOutcome(outcome: string): Promise<void>;
}

export interface WorkerRunnerOptions {
  host: WorkerRunnerHost;
  taskSequence: number;
  restoredTask?: AgentTaskState;
}

export class WorkerRunner extends AgentRunner {
  readonly runnerKind = "worker";
  private readonly host: WorkerRunnerHost;
  private readonly taskSequence: number;
  private readonly loop: AgenticLoop<AgentTaskState>;
  private readonly acceptedMessages = new Map<string, AgentMessage>();
  private pendingMessages: AgentMessage[] = [];
  private resumeContext?: string;
  private resumeImmediately = false;
  private pendingSubmission?: {
    stepId: string;
    outcome: string;
  };
  private activeTask?: AgentTaskState;
  private stopped = false;

  constructor(options: WorkerRunnerOptions) {
    super();
    this.host = options.host;
    this.taskSequence = options.taskSequence;
    this.loop = new AgenticLoop<AgentTaskState>({
      agentId: this.host.agentId,
      takeTick: () => this.takeTaskTurn(),
      runTick: (task) => this.runTaskTurn(task),
      isStopped: () => this.stopped,
      onError: (error) => this.failActiveTask(error),
    });
    if (options.restoredTask) {
      this.restoreTask(options.restoredTask);
    }
  }

  get agentId(): string {
    return this.host.agentId;
  }

  private get store() {
    return currentRunScope().taskStore;
  }

  private get eventBus() {
    return currentRunScope().eventBus;
  }

  async assignTask(input: AssignAgentTaskInput): Promise<AgentTaskState> {
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
    this.eventBus.publish(
      AgentEvents.task.assigned,
      task,
      { occurredAt: now },
    );
    const stored = this.store.addTask(task);
    this.activeTask = stored;
    queueMicrotask(() => this.loop.schedule());
    return stored;
  }

  private buildTaskId(taskSequence: number): string {
    return `${this.host.agentId}-task-${String(taskSequence).padStart(4, "0")}`;
  }

  async queueMessage(input: SendAgentMessageInput): Promise<void> {
    const task = this.resolveMessageTarget(input.taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Cannot queue message for terminal task ${task.taskId}. Status: ${task.status}`);
    }
    const message: AgentMessage = {
      messageId: input.delivery?.messageId ?? `${task.taskId}-message-${randomUUID()}`,
      agentId: this.host.agentId,
      taskId: task.taskId,
      body: attachments.compose(input.message),
      queuedAt: input.delivery?.queuedAt ?? new Date().toISOString(),
    };
    const accepted = this.acceptedMessages.get(message.messageId);
    if (accepted && (
      accepted.agentId !== message.agentId
      || accepted.taskId !== message.taskId
      || accepted.body !== message.body
      || accepted.queuedAt !== message.queuedAt
    )) {
      throw new Error(`Message ${message.messageId} does not match its Worker delivery.`);
    }
    if (accepted) return;
    this.eventBus.publish(
      AgentEvents.message.queued,
      message,
      { occurredAt: message.queuedAt },
    );
    this.acceptedMessages.set(message.messageId, structuredClone(message));
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

  async stopTask(
    taskId: string,
    reason = "任务已被 Coordinator 停止。",
  ): Promise<AgentTaskState> {
    const task = this.getTask(taskId);
    if (isTerminalTaskStatus(task.status)) return cloneTaskState(task);
    this.pendingMessages = [];
    this.pendingSubmission = undefined;
    const stoppedState = {
      ...task,
      status: AgentTaskStatuses.Stopped,
      error: reason,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies AgentTaskState;
    this.eventBus.publish(
      AgentEvents.task.stopped,
      stoppedState,
      { occurredAt: stoppedState.updatedAt },
    );
    const stopped = this.updateTask(taskId, () => stoppedState);
    this.activeTask = stopped;
    this.eventBus.publish(AgentEvents.task.terminal, stopped);
    return cloneTaskState(stopped);
  }

  async stopAgent(reason = "Agent stopped."): Promise<void> {
    this.stopped = true;
    this.loop.stop();
    await this.loop.runToIdle();
  }

  stop(reason?: string): Promise<void> {
    return this.stopAgent(reason);
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
    const task = this.getTask(taskId);
    const archivedAt = new Date().toISOString();
    this.eventBus.publish(
      AgentEvents.task.archived,
      task,
      { occurredAt: archivedAt },
    );
    const archived = this.store.removeTask(taskId);
    this.activeTask = undefined;
    return cloneTaskState(archived);
  }

  async runTasksToIdle(): Promise<void> {
    await this.loop.runToIdle();
  }

  activateRestoredTask(): void {
    const task = this.activeTask;
    if (!task) throw new Error(`Worker runner ${this.host.agentId} has no restored task.`);
    if (
      task.status === AgentTaskStatuses.Queued
      || this.pendingMessages.length > 0
      || this.resumeImmediately
    ) {
      this.loop.schedule();
    }
    this.resumeImmediately = false;
  }

  restoreState(input: {
    acceptedMessages: AgentMessage[];
    pendingMessages: AgentMessage[];
    resumeContext: string;
    resumeImmediately: boolean;
  }): void {
    if (!this.activeTask) {
      throw new Error(`Worker runner ${this.host.agentId} has no restored task.`);
    }
    if (this.pendingMessages.length > 0 || this.resumeContext) {
      throw new Error(`Worker runner ${this.host.agentId} runtime state is already restored.`);
    }
    this.pendingMessages = structuredClone(input.pendingMessages);
    this.acceptedMessages.clear();
    for (const message of [...input.acceptedMessages, ...this.pendingMessages]) {
      const accepted = this.acceptedMessages.get(message.messageId);
      if (accepted && (
        accepted.agentId !== message.agentId
        || accepted.taskId !== message.taskId
        || accepted.body !== message.body
        || accepted.queuedAt !== message.queuedAt
      )) {
        throw new Error(`Message ${message.messageId} does not match its Worker delivery.`);
      }
      this.acceptedMessages.set(message.messageId, structuredClone(message));
    }
    this.resumeContext = input.resumeContext;
    this.resumeImmediately = input.resumeImmediately;
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
        || this.pendingMessages.length > 0
        || this.resumeContext !== undefined
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
      task = {
        ...task,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    const pendingMessages = structuredClone(this.pendingMessages);
    const resumeContext = this.resumeContext;
    const prompt = attachments.compose(
      agent.turn.use_update_tools(),
      ...(resumeContext ? [resumeContext] : []),
      ...(initialPrompt === undefined ? [] : [
        agent.turn.message([
          "当前任务信息：",
          `- 任务 ID：${task.taskId}`,
          `- Agent 角色：${this.host.role}`,
        ].join("\n")),
        initialPrompt,
      ]),
      ...pendingMessages.map((message) => message.body),
    );

    const runningState = this.appendTaskStep({
      task: {
        ...task,
        status: AgentTaskStatuses.Running,
      },
      prompt,
      startedAt: new Date().toISOString(),
    });
    this.eventBus.publish(
      AgentEvents.task.stepStarted,
      runningState,
      { occurredAt: runningState.updatedAt },
    );
    for (const message of pendingMessages) {
      const consumedAt = new Date().toISOString();
      this.eventBus.publish(AgentEvents.message.consumed, {
        messageId: message.messageId,
        agentId: message.agentId,
        taskId: message.taskId,
        consumedAt,
      }, {
        occurredAt: consumedAt,
      });
    }
    const running = this.updateTask(taskId, () => runningState);
    const consumed = new Set(pendingMessages.map((message) => message.messageId));
    this.pendingMessages = this.pendingMessages.filter((message) =>
      !consumed.has(message.messageId)
    );
    this.resumeContext = undefined;
    this.activeTask = running;
    if (pendingMessages.length > 0) {
      this.eventBus.publish(AgentEvents.task.pendingMessagesDrained, running);
    }

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
      const completedState = this.completeLatestTaskStep({
        task: latest,
        outcome,
        durationMs,
        status: outcome.turn.status === "failed" ? AgentTaskStepStatuses.Failed : AgentTaskStepStatuses.Completed,
      });
      this.eventBus.publish(
        AgentEvents.task.stepCompleted,
        completedState,
        { occurredAt: completedState.updatedAt },
      );
      const updated = this.updateTask(taskId, () => completedState);
      this.activeTask = updated;
      return;
    }

    if (outcome.turn.status === "completed") {
      const completedState = this.completeLatestTaskStep({
        task: latest,
        outcome,
        durationMs,
        status: AgentTaskStepStatuses.Completed,
      });
      this.eventBus.publish(
        AgentEvents.task.stepCompleted,
        completedState,
        { occurredAt: completedState.updatedAt },
      );
      const stillRunning = this.updateTask(taskId, () => completedState);
      this.activeTask = stillRunning;
      const submission = this.pendingSubmission;
      this.pendingSubmission = undefined;
      if (submission) {
        const completedStep = stillRunning.steps?.[stillRunning.steps.length - 1];
        if (submission.stepId !== completedStep?.stepId) {
          throw new Error(
            `Worker task ${taskId} submitted outcome for ${submission.stepId}, not ${completedStep?.stepId ?? "<none>"}.`,
          );
        }
        const doneState = {
          ...stillRunning,
          status: AgentTaskStatuses.Done,
          updatedAt: new Date().toISOString(),
        } satisfies AgentTaskState;
        const submittedAt = new Date().toISOString();
        this.eventBus.publish(AgentEvents.task.outcomeSubmitted, {
          task: doneState,
          stepId: submission.stepId,
          outcome: submission.outcome,
          submittedAt,
        }, {
          occurredAt: submittedAt,
        });
        const done = this.updateTask(taskId, () => doneState);
        this.activeTask = done;
        this.eventBus.publish(
          AgentEvents.task.done,
          done,
          { occurredAt: done.updatedAt },
        );
        await this.host.deliverTaskOutcome(submission.outcome);
      }
      return;
    }

    this.pendingSubmission = undefined;
    const failedState = this.completeLatestTaskStep({
      task: {
        ...latest,
        status: AgentTaskStatuses.Failed,
        error: outcome.turn.error,
        finishedAt: new Date().toISOString(),
      },
      outcome,
      durationMs,
      status: AgentTaskStepStatuses.Failed,
    });
    this.eventBus.publish(
      AgentEvents.task.failed,
      failedState,
      { occurredAt: failedState.updatedAt },
    );
    const failed = this.updateTask(taskId, () => failedState);
    this.activeTask = failed;
    this.eventBus.publish(AgentEvents.task.terminal, failed);
  }

  private failActiveTask(error: unknown): void {
    this.pendingSubmission = undefined;
    if (!this.activeTask) {
      return;
    }
    if (
      this.activeTask.status === AgentTaskStatuses.Done
      || this.activeTask.status === AgentTaskStatuses.Failed
      || this.activeTask.status === AgentTaskStatuses.Stopped
    ) {
      return;
    }
    const taskId = this.activeTask.taskId;
    const current = this.getTask(taskId);
    const failedState = {
      ...current,
      status: AgentTaskStatuses.Failed,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies AgentTaskState;
    this.eventBus.publish(
      AgentEvents.task.failed,
      failedState,
      { occurredAt: failedState.updatedAt },
    );
    const failed = this.updateTask(taskId, () => failedState);
    this.activeTask = failed;
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
        status: input.status === AgentTaskStepStatuses.Failed
          ? AgentTaskStatuses.Failed
          : input.task.status,
      },
      update: (step) => ({
        ...step,
        turnId: input.outcome.turn.turnId,
        status: input.status,
        finalResponse: input.outcome.finalResponse,
        toolCalls: input.outcome.toolCalls ?? [],
        humanInputRequest: (input.outcome.toolCalls ?? []).flatMap((toolCall) => {
          if (
            toolCall.namespace !== AGENT_REQUEST_HUMAN_INPUT_TOOL_NAMESPACE
            || toolCall.tool !== "RequestHumanInput"
            || toolCall.success !== true
          ) {
            return [];
          }
          const call = parseAgentDynamicToolCall(toolCall.tool, toolCall.arguments);
          return call.tool === "RequestHumanInput" ? [{ body: call.request }] : [];
        })[0],
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

  private restoreTask(task: AgentTaskState): void {
    if (task.agentId !== this.host.agentId) {
      throw new Error(`Cannot restore task ${task.taskId} to agent ${this.host.agentId}.`);
    }
    const stored = this.store.getTask(task.taskId) ?? this.store.addTask(task);
    this.activeTask = stored;
  }

}

export function cloneAgentTaskState(task: AgentTaskState): AgentTaskState {
  return cloneTaskState(task);
}

export function isTerminalTaskStatus(status: AgentTaskState["status"]): boolean {
  return status === AgentTaskStatuses.Failed
    || status === AgentTaskStatuses.Stopped;
}
