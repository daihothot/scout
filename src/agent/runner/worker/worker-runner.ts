import type { Logger } from "../../../core/logging/index.js";
import {
  attachments,
} from "../../context/attachments.js";
import {
  AgentContextTags,
  agent,
} from "../../context/agent-attachments.js";
import {
  worker,
  type WorkerTaskTickInput,
} from "./worker-attachments.js";
import {
  AgenticLoop,
  type AgenticTickContinuation,
} from "../../core/agentic-loop.js";
import {
  AgentTaskStore,
  cloneAgentTaskState as cloneTaskState,
} from "../../task/agent-task-store.js";
import type { EventBus } from "../../../core/events/index.js";
import { AgentEvents } from "../../events/index.js";
import type {
  AgentTaskEventPayload,
  AgentHumanInputRespondedEventPayload,
  AgentHumanInputRequestedEventPayload,
  AgentTaskStepEventPayload,
  AgentTaskTerminalEventPayload,
} from "../../task/task-events.js";
import {
  AgentTaskStatuses,
  AgentTaskStepStatuses,
  AgentTaskOutcomeStatuses,
  type AgentHumanInputRequest,
  type AgentHumanInputResponse,
  type AgentTaskOutcome,
  type AgentTaskStep,
  type AgentTaskState,
  type AssignAgentTaskInput,
  type SendAgentMessageInput,
} from "../../task/types.js";
import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../../core/scout-agent.js";
import type { AgentThreadSnapshot, AgentThreadSpec } from "../../thread/types.js";
import { AgentRunner } from "../types.js";

export interface WorkerRunnerSnapshot {
  tasks: AgentTaskState[];
  activeTask?: AgentTaskState;
  pendingMessageCount: number;
}

export interface WorkerRunnerHost {
  readonly agentId: string;
  readonly role: AgentThreadSpec["role"];
  readonly spec: AgentThreadSpec;
  readonly threadSnapshot?: AgentThreadSnapshot;
  readonly logger: Logger;
  runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome>;
  setGoal(input: {
    objective: string;
    tokenBudget?: number;
  }): Promise<AgentTaskState["goal"] | undefined>;
}

export interface WorkerRunnerOptions {
  host: WorkerRunnerHost;
  store: AgentTaskStore;
  eventBus: EventBus;
  taskInput?: AssignAgentTaskInput;
}

export class WorkerRunner extends AgentRunner {
  readonly runnerKind = "worker";
  private readonly host: WorkerRunnerHost;
  private readonly store: AgentTaskStore;
  private readonly eventBus: EventBus;
  private readonly loop: AgenticLoop<AgentTaskState>;
  private pendingMessages: string[] = [];
  private activeTask?: AgentTaskState;
  private stopped = false;

  constructor(options: WorkerRunnerOptions) {
    super();
    this.host = options.host;
    this.store = options.store;
    this.eventBus = options.eventBus;
    this.loop = new AgenticLoop<AgentTaskState>({
      agentId: this.host.agentId,
      takeTick: () => this.takeTaskTick(),
      runTick: (task) => this.runTaskTick(task),
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
    const taskSequence = this.nextTaskSequence();
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
      thread: this.host.threadSnapshot,
    };
    const stored = this.store.addTask(task);
    this.activeTask = stored;
    this.eventBus.publish(AgentEvents.task.assigned, {
      task: stored,
    } satisfies AgentTaskEventPayload);
    this.loop.schedule();
    return stored;
  }

  private nextTaskSequence(): number {
    return this.store.listTasks({ agentId: this.host.agentId }).length + 1;
  }

  private buildTaskId(taskSequence: number): string {
    return `${this.host.agentId}-task-${String(taskSequence).padStart(4, "0")}`;
  }

  queueMessage(input: Omit<SendAgentMessageInput, "target"> & { taskId?: string }): AgentTaskState {
    const task = this.resolveMessageTarget(input.taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Cannot queue message for terminal task ${task.taskId}. Status: ${task.status}`);
    }
    this.pendingMessages = [...this.pendingMessages, input.message];
    const updated = this.updateTask(task.taskId, (currentTask) => ({
      ...currentTask,
      updatedAt: new Date().toISOString(),
    }));
    this.activeTask = updated;
    this.eventBus.publish(AgentEvents.task.messageQueued, {
      task: updated,
      data: {
        message: input.message,
        pendingMessageCount: this.countPendingMessages(task.taskId),
      },
    } satisfies AgentTaskEventPayload);
    this.loop.schedule();
    return cloneTaskState(updated);
  }

  stopTask(taskId: string, reason = "任务已被 Coordinator 停止。"): AgentTaskState {
    const task = this.getTask(taskId);
    if (isTerminalTaskStatus(task.status)) return cloneTaskState(task);
    this.pendingMessages = [];
    const stopped = this.updateTask(taskId, (current) => ({
      ...current,
      status: AgentTaskStatuses.Stopped,
      error: reason,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.activeTask = stopped;
    this.eventBus.publish(AgentEvents.task.stopped, {
      task: stopped,
      data: { reason },
    } satisfies AgentTaskEventPayload);
    this.eventBus.publish(AgentEvents.task.terminal, {
      task: stopped,
      result: stopped.result,
      error: stopped.error,
      data: { reason },
    } satisfies AgentTaskTerminalEventPayload);
    return cloneTaskState(stopped);
  }

  stopAgent(reason = "Agent stopped."): void {
    this.stopped = true;
    for (const task of this.listTasks()) {
      if (!isTerminalTaskStatus(task.status)) {
        this.stopTask(task.taskId, reason);
      }
    }
    this.loop.stop();
  }

  stop(reason?: string): void {
    this.stopAgent(reason);
  }

  listTasks(): AgentTaskState[] {
    return this.store.listTasks({ agentId: this.host.agentId });
  }

  getTaskSnapshot(taskId: string): AgentTaskState | undefined {
    if (this.activeTask?.taskId !== taskId) return undefined;
    return this.store.getTask(taskId);
  }

  completeTaskWithOutcome(input: {
    outcome: AgentTaskOutcome;
  }): AgentTaskState {
    const task = this.getTask(input.outcome.taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Cannot complete terminal task ${task.taskId}. Status: ${task.status}`);
    }
    const taskStatus = input.outcome.status;
    const finishedAt = new Date().toISOString();
    const completed = this.updateTask(task.taskId, (current) => ({
      ...current,
      status: taskStatus,
      result: input.outcome.summary,
      error: input.outcome.status === "failed" ? input.outcome.summary : current.error,
      outcome: input.outcome,
      finishedAt,
      updatedAt: finishedAt,
    }));
    this.pendingMessages = [];
    this.activeTask = completed;
    this.eventBus.publish(AgentEvents.task.outcomeAccepted, {
      task: completed,
      data: {
        outcome: completed.outcome,
      },
    } satisfies AgentTaskEventPayload);
    this.eventBus.publish(AgentEvents.task.terminal, {
      task: completed,
      result: completed.result,
      error: completed.error,
      data: {
        outcome: completed.outcome,
      },
    } satisfies AgentTaskTerminalEventPayload);
    return cloneTaskState(completed);
  }

  requestHumanInput(input: {
    taskId: string;
    request: AgentHumanInputRequest;
  }): AgentTaskState {
    const task = this.getTask(input.taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Cannot request human input for terminal task ${task.taskId}. Status: ${task.status}`);
    }
    const updatedAt = new Date().toISOString();
    const request = {
      ...input.request,
      status: input.request.status ?? "pending",
    } satisfies AgentHumanInputRequest;
    const waiting = this.updateTask(task.taskId, (current) => this.updateLatestTaskStep({
      task: {
        ...current,
        status: AgentTaskStatuses.WaitingForHumanInput,
      },
      update: (step) => ({
        ...step,
        status: AgentTaskStepStatuses.WaitingForHumanInput,
        humanInputRequest: { ...request },
      }),
      updatedAt,
    }));
    this.activeTask = waiting;
    this.eventBus.publish(AgentEvents.task.humanInputRequested, {
      task: waiting,
      request,
      data: { requestId: request.requestId },
    } satisfies AgentHumanInputRequestedEventPayload);
    return cloneTaskState(waiting);
  }

  applyHumanInputResponse(input: AgentHumanInputResponse): AgentTaskState {
    const task = this.getTask(input.taskId);
    const updated = this.updateTask(task.taskId, (current) => this.updateLatestTaskStep({
      task: {
        ...current,
        status: current.status === AgentTaskStatuses.WaitingForHumanInput ? AgentTaskStatuses.Running : current.status,
      },
      update: (step) => ({
        ...step,
        humanInputRequest: step.humanInputRequest?.requestId === input.requestId
          ? {
            ...step.humanInputRequest,
            status: "answered",
          }
          : step.humanInputRequest,
        humanInputResponse: { ...input },
      }),
      updatedAt: new Date().toISOString(),
    }));
    this.activeTask = updated;
    return cloneTaskState(updated);
  }

  private handlePendingMessages(
    task: AgentTaskState,
    messages: string[],
  ): { task: AgentTaskState; remainingMessages: string[] } | undefined {
    if (messages.length === 0) return undefined;
    const request = latestTaskStep(task)?.humanInputRequest;
    if (!request || request.status !== "pending") return undefined;
    const responseMessageIndex = messages.findIndex((message) =>
      attachments.haveTagBlock(message, AgentContextTags.HumanResponse)
    );
    if (responseMessageIndex < 0) return undefined;
    const responseMessage = messages[responseMessageIndex];
    if (!responseMessage) return undefined;
    const humanResponse = attachments.readTagBlock(responseMessage, AgentContextTags.HumanResponse)[0];
    if (!humanResponse) return undefined;
    const remainingMessages = [
      ...messages.slice(0, responseMessageIndex),
      ...messages.slice(responseMessageIndex + 1),
    ];
    const response: AgentHumanInputResponse = {
      requestId: request.requestId,
      agentId: task.agentId,
      taskId: task.taskId,
      response: humanResponse.body,
      createdAt: new Date().toISOString(),
    };
    const updated = this.applyHumanInputResponse(response);
    this.eventBus.publish(AgentEvents.task.humanInputResponded, {
      task: updated,
      response,
      data: {
        requestId: response.requestId,
      },
    } satisfies AgentHumanInputRespondedEventPayload);
    return {
      task: updated,
      remainingMessages,
    };
  }

  hasRunningTasks(): boolean {
    return this.listTasks().some((task) =>
      task.status === AgentTaskStatuses.Queued || task.status === AgentTaskStatuses.Running
    );
  }

  async runTasksToIdle(): Promise<void> {
    await this.loop.runToIdle();
  }

  snapshot(): WorkerRunnerSnapshot {
    return {
      tasks: this.listTasks(),
      activeTask: this.activeTask ? cloneTaskState(this.activeTask) : undefined,
      pendingMessageCount: this.pendingMessages.length,
    };
  }

  private takeTaskTick(): AgentTaskState | undefined {
    if (this.activeTask) {
      if (this.activeTask.status === AgentTaskStatuses.Queued) {
        return this.activeTask;
      }
      if (this.countPendingMessages(this.activeTask.taskId) > 0) {
        return this.activeTask;
      }
      if (this.activeTask.status !== AgentTaskStatuses.Running) {
        return undefined;
      }
      return undefined;
    }
    return undefined;
  }

  private async runTaskTick(activeTask: AgentTaskState): Promise<void | AgenticTickContinuation<AgentTaskState>> {
    const taskId = activeTask.taskId;
    this.ensureOwnedTask(taskId);
    let task = this.getTask(taskId);
    if (
      task.status !== AgentTaskStatuses.Queued
      && task.status !== AgentTaskStatuses.Running
      && task.status !== AgentTaskStatuses.WaitingForHumanInput
    ) {
      return;
    }
    const hadStarted = Boolean(task.startedAt);
    const initialPrompt = hadStarted ? undefined : task.initialPrompt;
    const thread = this.host.threadSnapshot;
    if (!thread) {
      throw new Error(`Worker runner ${this.host.agentId} has no prepared thread.`);
    }
    if (!hadStarted) {
      if (!initialPrompt) {
        throw new Error(`Task ${taskId} has no initial prompt.`);
      }
      const goal = await this.host.setGoal({ objective: initialPrompt });
      task = this.updateTask(taskId, (current) => ({
        ...current,
        thread,
        goal,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      this.eventBus.publish(AgentEvents.task.threadAttached, {
        task,
        data: { threadId: thread.threadId },
      } satisfies AgentTaskEventPayload);
      if (goal) {
        this.eventBus.publish(AgentEvents.task.goalUpdated, {
          task,
          data: { goal },
        } satisfies AgentTaskEventPayload);
      }
      task = this.getTask(taskId);
      if (isTerminalTaskStatus(task.status)) {
        this.activeTask = task;
        return;
      }
    }

    let pendingMessages = this.drainPendingMessages(taskId);
    if (pendingMessages.length > 0) {
      this.eventBus.publish(AgentEvents.task.pendingMessagesDrained, {
        task,
        data: {
          messages: pendingMessages,
        },
      } satisfies AgentTaskEventPayload);
    }
    const pendingMessageResult = this.handlePendingMessages(task, pendingMessages);
    if (pendingMessageResult) {
      task = pendingMessageResult.task;
      pendingMessages = pendingMessageResult.remainingMessages;
    }
    task = this.getTask(taskId);
    if (isTerminalTaskStatus(task.status)) {
      this.activeTask = task;
      return;
    }
    const promptSections = this.buildTaskTurnSections({
      task,
      initialPrompt,
    });
    const prompt = attachments.compose(
      this.host.logger,
      ...promptSections,
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
    this.eventBus.publish(AgentEvents.task.stepStarted, {
      task: running,
      prompt,
      step: latestTaskStep(running),
    } satisfies AgentTaskStepEventPayload);

    const startedAt = Date.now();
    const outcome = await this.host.runTurn({
      prompt,
      sandbox: this.host.spec.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly",
    });
    const durationMs = Date.now() - startedAt;
    const latest = this.getTask(taskId);
    if (latest.status === AgentTaskStatuses.Stopped) {
      this.activeTask = latest;
      return;
    }
    if (latest.status === AgentTaskStatuses.WaitingForHumanInput) {
      const waiting = this.updateTask(taskId, (current) => this.completeLatestTaskStep({
        task: current,
        outcome,
        durationMs,
        status: AgentTaskStepStatuses.WaitingForHumanInput,
      }));
      this.activeTask = waiting;
      this.eventBus.publish(AgentEvents.task.stepCompleted, {
        task: waiting,
        step: latestTaskStep(waiting),
        data: { reason: AgentTaskStatuses.WaitingForHumanInput },
      } satisfies AgentTaskStepEventPayload);
      return;
    }
    if (isTerminalTaskStatus(latest.status)) {
      const updated = this.updateTask(taskId, (current) => this.completeLatestTaskStep({
        task: current,
        outcome,
        durationMs,
        status: outcome.turn.status === "failed" ? AgentTaskStepStatuses.Failed : AgentTaskStepStatuses.Completed,
      }));
      this.activeTask = updated;
      this.eventBus.publish(AgentEvents.task.stepCompleted, {
        task: updated,
        step: latestTaskStep(updated),
        data: { reason: "terminal_update" },
      } satisfies AgentTaskStepEventPayload);
      return;
    }

    if (outcome.turn.status === "completed") {
      this.eventBus.publish(AgentEvents.task.stepOutput, {
        task: latest,
        data: { output: outcome.finalResponse ?? "" },
      } satisfies AgentTaskEventPayload);
      if (this.countPendingMessages(taskId) > 0) {
        const stillRunning = this.updateTask(taskId, (current) => this.completeLatestTaskStep({
          task: current,
          outcome,
          durationMs,
          status: AgentTaskStepStatuses.Completed,
        }));
        this.activeTask = stillRunning;
        this.eventBus.publish(AgentEvents.task.stepCompleted, {
          task: stillRunning,
          step: latestTaskStep(stillRunning),
          output: outcome.finalResponse ?? "",
          data: { reason: "pending_messages" },
        } satisfies AgentTaskStepEventPayload);
        return;
      }
      const stillRunning = this.updateTask(taskId, (current) => this.completeLatestTaskStep({
        task: current,
        outcome,
        durationMs,
        status: AgentTaskStepStatuses.Completed,
      }));
      this.activeTask = stillRunning;
      this.eventBus.publish(AgentEvents.task.stepCompleted, {
        task: stillRunning,
        step: latestTaskStep(stillRunning),
        output: outcome.finalResponse ?? "",
        data: { reason: "tick_scheduled" },
      } satisfies AgentTaskStepEventPayload);
      return { continueAfterMs: 0, continueWith: stillRunning };
    }

    const failed = this.updateTask(taskId, (current) => this.completeLatestTaskStep({
      task: {
        ...current,
        status: AgentTaskStatuses.Failed,
        error: outcome.turn.error,
        outcome: current.outcome ?? {
          taskId,
          status: AgentTaskOutcomeStatuses.Failed,
          summary: outcome.turn.error ?? "Agent turn failed.",
        },
        finishedAt: new Date().toISOString(),
      },
      outcome,
      durationMs,
      status: AgentTaskStepStatuses.Failed,
    }));
    this.activeTask = failed;
    this.eventBus.publish(AgentEvents.task.failed, {
      task: failed,
    } satisfies AgentTaskEventPayload);
    this.eventBus.publish(AgentEvents.task.terminal, {
      task: failed,
      result: failed.result,
      error: failed.error,
    } satisfies AgentTaskTerminalEventPayload);
  }

  private failActiveTask(error: unknown): void {
    if (!this.activeTask) {
      this.host.logger.error({
        module: "agent",
        event: "agent_loop_failed_without_task",
        agentId: this.host.agentId,
        data: {
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
      });
      return;
    }
    const taskId = this.activeTask.taskId;
    const failed = this.updateTask(taskId, (current) => ({
      ...current,
      status: AgentTaskStatuses.Failed,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      outcome: current.outcome ?? {
        taskId,
        status: AgentTaskOutcomeStatuses.Failed,
        summary: error instanceof Error ? error.message : String(error),
      },
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.activeTask = failed;
    this.eventBus.publish(AgentEvents.task.failed, {
      task: failed,
    } satisfies AgentTaskEventPayload);
    this.eventBus.publish(AgentEvents.task.terminal, {
      task: failed,
      result: failed.result,
      error: failed.error,
    } satisfies AgentTaskTerminalEventPayload);
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
        result: input.outcome.finalResponse ?? input.task.result,
      },
      update: (step) => ({
        ...step,
        turnId: input.outcome.turn.turnId,
        status: input.status,
        finalResponse: input.outcome.finalResponse,
        toolCalls: input.outcome.toolCalls ?? [],
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

  private buildTaskTurnSections(input: {
    task: AgentTaskState;
    initialPrompt?: string;
  }): string[] {
    const updateToolInstruction = agent.turn.use_update_tools();
    if (input.initialPrompt !== undefined) {
      if (!input.initialPrompt) throw new Error(`Task ${input.task.taskId} has no initial prompt.`);
      return [updateToolInstruction, input.initialPrompt];
    }
    return [
      updateToolInstruction,
      worker.turn.task_tick(toWorkerTaskTickInput(input.task)),
    ];
  }
}

export function cloneAgentTaskState(task: AgentTaskState): AgentTaskState {
  return cloneTaskState(task);
}

export function isTerminalTaskStatus(status: AgentTaskState["status"]): boolean {
  return status === AgentTaskStatuses.Complete
    || status === AgentTaskStatuses.Blocked
    || status === AgentTaskStatuses.Failed
    || status === AgentTaskStatuses.Stopped;
}

function latestTaskStep(task: AgentTaskState): AgentTaskStep | undefined {
  return task.steps?.[task.steps.length - 1];
}

function toWorkerTaskTickInput(task: AgentTaskState): WorkerTaskTickInput {
  return {
    taskId: task.taskId,
    status: task.status,
    description: task.description,
    latestStepId: latestTaskStep(task)?.stepId,
  };
}
