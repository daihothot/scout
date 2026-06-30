import type { Logger } from "../../core/logging/index.js";
import {
  getAgentPendingMessageAttachments,
  renderAttachmentsForPrompt,
} from "./attachments.js";
import { AgenticLoop } from "../core/agentic-loop.js";
import {
  AgentTaskStore,
  cloneAgentTaskState as cloneTaskState,
  isActiveAgentTaskStatus,
} from "./agent-task-store.js";
import { type EventBus, SystemEvents } from "../../core/events/index.js";
import type {
  AgentTaskEventPayload,
  AgentTaskStepEventPayload,
  AgentTaskTerminalEventPayload,
  SystemInterruptEventPayload,
} from "./task-events.js";
import type {
  AgentTaskOutcome,
  AgentTaskStepRecord,
  AgentTaskState,
  AgentUserInputRequest,
  AgentUserInputResponse,
  AssignAgentTaskInput,
} from "./types.js";
import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../core/scout-agent.js";
import type { ScoutAgentThreadPreflightRecord } from "../lifecycle/thread-preflight.js";
import type { AgentThreadRecord, AgentThreadSpec } from "../model/types.js";

export interface ScoutAgentTaskSnapshot {
  tasks: AgentTaskState[];
  activeTaskId?: string;
  pendingMessageCount: number;
}

export interface ScoutAgentTaskHost {
  readonly agentId: string;
  readonly role: AgentThreadSpec["role"];
  readonly spec: AgentThreadSpec;
  readonly threadRecord?: AgentThreadRecord;
  readonly logger: Logger;
  startWithPreflight(): Promise<{
    thread: AgentThreadRecord;
    preflight: ScoutAgentThreadPreflightRecord;
  }>;
  runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome>;
  setGoal(input: {
    objective: string;
    tokenBudget?: number;
  }): Promise<AgentTaskState["goal"] | undefined>;
}

export interface ScoutAgentTaskRuntimeOptions {
  host: ScoutAgentTaskHost;
  store: AgentTaskStore;
  eventBus: EventBus;
}

export class ScoutAgentTaskRuntime {
  private readonly host: ScoutAgentTaskHost;
  private readonly store: AgentTaskStore;
  private readonly eventBus: EventBus;
  private readonly loop: AgenticLoop;
  private readonly taskQueue: string[] = [];
  private readonly pendingMessages = new Map<string, string[]>();
  private activeTaskId?: string;
  private stopped = false;

  constructor(options: ScoutAgentTaskRuntimeOptions) {
    this.host = options.host;
    this.store = options.store;
    this.eventBus = options.eventBus;
    this.loop = new AgenticLoop({
      agentId: this.host.agentId,
      handlers: {
        runStep: () => this.runTaskStep(),
        hasPendingWork: () => this.hasPendingWork(),
        isStopped: () => this.stopped,
        onError: (error) => this.failActiveTask(error),
      },
    });
  }

  assignTask(input: AssignAgentTaskInput): AgentTaskState {
    if (this.stopped) {
      throw new Error(`Agent ${this.host.agentId} is stopped.`);
    }
    if (input.subagentType !== this.host.role) {
      throw new Error(`Cannot assign ${input.subagentType} task to ${this.host.role} agent ${this.host.agentId}.`);
    }
    const now = new Date().toISOString();
    const task: AgentTaskState = {
      type: "local_agent",
      taskId: input.taskId,
      agentId: this.host.agentId,
      role: this.host.role,
      description: input.description,
      prompt: input.prompt,
      selectedAgent: this.host.role,
      status: "queued",
      isBackgrounded: input.isBackgrounded ?? true,
      createdAt: now,
      updatedAt: now,
      parentTaskId: input.parentTaskId,
      thread: this.host.threadRecord,
    };
    const stored = this.store.addTask(task);
    this.taskQueue.push(task.taskId);
    this.eventBus.publish(SystemEvents.task.assigned, {
      task: stored,
      data: { prompt: input.prompt },
    } satisfies AgentTaskEventPayload);
    this.loop.schedule();
    return stored;
  }

  queueMessage(input: { taskId?: string; message: string }): AgentTaskState {
    const task = this.resolveMessageTarget(input.taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Cannot queue message for terminal task ${task.taskId}. Status: ${task.status}`);
    }
    const current = this.pendingMessages.get(task.taskId) ?? [];
    this.pendingMessages.set(task.taskId, [...current, input.message]);
    const updated = this.updateTask(task.taskId, (currentTask) => ({
      ...currentTask,
      status: currentTask.status === "waiting_for_human_input" || currentTask.status === "waiting_for_coordinator"
        ? "running"
        : currentTask.status,
      userInputRequest: undefined,
      updatedAt: new Date().toISOString(),
    }));
    this.eventBus.publish(SystemEvents.task.messageQueued, {
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
    this.removeFromTaskQueue(taskId);
    this.pendingMessages.delete(taskId);
    const stopped = this.updateTask(taskId, (current) => ({
      ...current,
      status: "stopped",
      error: reason,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    if (this.activeTaskId === taskId) {
      this.activeTaskId = undefined;
    }
    this.eventBus.publish(SystemEvents.task.stopped, {
      task: stopped,
      data: { reason },
    } satisfies AgentTaskEventPayload);
    this.eventBus.publish(SystemEvents.task.terminal, {
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
  }

  listTasks(): AgentTaskState[] {
    return this.store.listTasks({ agentId: this.host.agentId });
  }

  getTaskSnapshot(taskId: string): AgentTaskState | undefined {
    return this.store.getAgentTask(this.host.agentId, taskId);
  }

  completeTaskWithOutcome(input: {
    taskId: string;
    outcome: Omit<AgentTaskOutcome, "emittedAt">;
  }): AgentTaskState {
    const task = this.getTask(input.taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Cannot complete terminal task ${task.taskId}. Status: ${task.status}`);
    }
    const emittedAt = new Date().toISOString();
    const taskStatus = input.outcome.status;
    const completed = this.updateTask(task.taskId, (current) => ({
      ...current,
      status: taskStatus,
      result: input.outcome.summary,
      error: input.outcome.status === "failed" ? input.outcome.blocker ?? input.outcome.summary : current.error,
      outcome: {
        ...input.outcome,
        artifactRefs: [...input.outcome.artifactRefs],
        evidenceRefs: [...input.outcome.evidenceRefs],
        emittedAt,
      },
      userInputRequest: undefined,
      finishedAt: emittedAt,
      updatedAt: emittedAt,
    }));
    this.removeFromTaskQueue(task.taskId);
    this.pendingMessages.delete(task.taskId);
    if (this.activeTaskId === task.taskId) {
      this.activeTaskId = undefined;
    }
    this.eventBus.publish(SystemEvents.task.outcomeRecorded, {
      task: completed,
      data: {
        outcome: completed.outcome,
      },
    } satisfies AgentTaskEventPayload);
    this.eventBus.publish(SystemEvents.task.terminal, {
      task: completed,
      result: completed.result,
      error: completed.error,
      data: {
        outcome: completed.outcome,
      },
    } satisfies AgentTaskTerminalEventPayload);
    return cloneTaskState(completed);
  }

  requestUserInput(input: {
    taskId: string;
    request: AgentUserInputRequest;
  }): AgentTaskState {
    const task = this.getTask(input.taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Cannot request user input for terminal task ${task.taskId}. Status: ${task.status}`);
    }
    const updatedAt = new Date().toISOString();
    const request = {
      ...input.request,
      status: input.request.status ?? "pending",
    } satisfies AgentUserInputRequest;
    const waiting = this.updateTask(task.taskId, (current) => ({
      ...current,
      status: "waiting_for_human_input",
      userInputRequest: { ...request },
      humanInputRequests: [...(current.humanInputRequests ?? []), request],
      updatedAt,
    }));
    this.eventBus.publish(SystemEvents.task.humanInputRequested, {
      task: waiting,
      data: { userInputRequest: waiting.userInputRequest },
    } satisfies AgentTaskEventPayload);
    if (waiting.userInputRequest) {
      this.eventBus.publish(SystemEvents.interrupt.raised, {
        interruptKind: "human_input",
        taskId: waiting.taskId,
        agentId: waiting.agentId,
        turnId: waiting.userInputRequest.turnId,
        requestId: waiting.userInputRequest.requestId,
        status: waiting.userInputRequest.status,
        request: waiting.userInputRequest,
        task: waiting,
      } satisfies SystemInterruptEventPayload);
    }
    return cloneTaskState(waiting);
  }

  applyUserInputResponse(input: AgentUserInputResponse): AgentTaskState {
    const task = this.getTask(input.taskId);
    const updated = this.updateTask(task.taskId, (current) => ({
      ...current,
      userInputRequest: current.userInputRequest?.requestId === input.requestId
        ? {
          ...current.userInputRequest,
          status: "answered",
        }
        : current.userInputRequest,
      humanInputRequests: (current.humanInputRequests ?? []).map((request) =>
        request.requestId === input.requestId ? { ...request, status: "answered" } : request
      ),
      humanInputResponses: [...(current.humanInputResponses ?? []), { ...input }],
      status: current.status === "waiting_for_human_input" ? "waiting_for_coordinator" : current.status,
      updatedAt: new Date().toISOString(),
    }));
    return cloneTaskState(updated);
  }

  hasRunningTasks(): boolean {
    return this.listTasks().some((task) => task.status === "queued" || task.status === "running");
  }

  async runTasksToIdle(): Promise<void> {
    await this.loop.runToIdle();
  }

  snapshot(): ScoutAgentTaskSnapshot {
    return {
      tasks: this.listTasks(),
      activeTaskId: this.activeTaskId,
      pendingMessageCount: [...this.pendingMessages.values()].reduce((sum, messages) => sum + messages.length, 0),
    };
  }

  private async runTaskStep(): Promise<void> {
    const taskId = this.activeTaskId ?? this.dequeueNextTaskId();
    if (!taskId) return;
    this.activeTaskId = taskId;

    let task = this.getTask(taskId);
    if (task.status === "stopped") {
      this.activeTaskId = undefined;
      return;
    }
    const hadStarted = Boolean(task.startedAt);
    const { thread } = await this.host.startWithPreflight();
    if (!hadStarted) {
      const goal = await this.host.setGoal({ objective: task.prompt });
      task = this.updateTask(taskId, (current) => ({
        ...current,
        thread,
        goal,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      this.eventBus.publish(SystemEvents.task.threadAttached, {
        task,
        data: { threadId: thread.threadId },
      } satisfies AgentTaskEventPayload);
      if (goal) {
        this.eventBus.publish(SystemEvents.task.goalUpdated, {
          task,
          data: { goal },
        } satisfies AgentTaskEventPayload);
      }
    }

    const pendingMessages = this.drainPendingMessages(taskId);
    if (pendingMessages.length > 0) {
      this.eventBus.publish(SystemEvents.task.pendingMessagesDrained, {
        task: this.getTask(taskId),
        data: {
          messages: pendingMessages,
        },
      } satisfies AgentTaskEventPayload);
    }
    const prompt = this.renderTaskPrompt({
      task,
      includeInitialPrompt: !hadStarted,
      pendingMessages,
    });

    const running = this.updateTask(taskId, (current) => ({
      ...current,
      status: "running",
      updatedAt: new Date().toISOString(),
    }));
    this.eventBus.publish(SystemEvents.task.stepStarted, {
      task: running,
      prompt,
    } satisfies AgentTaskStepEventPayload);

    const startedAt = Date.now();
    const outcome = await this.host.runTurn({
      prompt,
      collaborationModeId: "plan",
      sandbox: this.host.spec.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly",
    });
    const durationMs = Date.now() - startedAt;
    const latest = this.getTask(taskId);
    if (latest.status === "stopped") {
      this.activeTaskId = undefined;
      return;
    }
    if (latest.status === "waiting_for_human_input") {
      const waiting = this.updateTask(taskId, (current) => this.recordTurnCompletion({
        task: current,
        outcome,
        prompt,
        durationMs,
        status: "waiting_for_human_input",
      }));
      this.eventBus.publish(SystemEvents.task.stepCompleted, {
        task: waiting,
        step: latestTaskStep(waiting),
        data: { reason: "waiting_for_human_input" },
      } satisfies AgentTaskStepEventPayload);
      return;
    }
    if (isTerminalTaskStatus(latest.status)) {
      const recorded = this.updateTask(taskId, (current) => this.recordTurnCompletion({
        task: current,
        outcome,
        prompt,
        durationMs,
        status: outcome.turn.status === "failed" ? "failed" : "completed",
      }));
      this.activeTaskId = undefined;
      this.eventBus.publish(SystemEvents.task.stepCompleted, {
        task: recorded,
        step: latestTaskStep(recorded),
        data: { reason: "terminal_update" },
      } satisfies AgentTaskStepEventPayload);
      return;
    }

    if (outcome.turn.status === "completed") {
      this.eventBus.publish(SystemEvents.task.stepOutput, {
        task: latest,
        data: { output: outcome.finalResponse ?? "" },
      } satisfies AgentTaskEventPayload);
      if (this.countPendingMessages(taskId) > 0) {
        const stillRunning = this.updateTask(taskId, (current) => ({
          ...current,
          status: "running",
          result: outcome.finalResponse,
          updatedAt: new Date().toISOString(),
          usage: {
            ...current.usage,
            durationMs: (current.usage?.durationMs ?? 0) + durationMs,
          },
        }));
        this.eventBus.publish(SystemEvents.task.stepCompleted, {
          task: stillRunning,
          step: latestTaskStep(stillRunning),
          output: outcome.finalResponse ?? "",
          data: { reason: "pending_messages" },
        } satisfies AgentTaskStepEventPayload);
        return;
      }
      const waiting = this.updateTask(taskId, (current) => this.recordTurnCompletion({
        task: current,
        outcome,
        prompt,
        durationMs,
        status: "waiting_for_coordinator",
        protocolWarnings: ["Agent turn completed without a terminal domain state or RequestHumanInput."],
      }));
      this.eventBus.publish(SystemEvents.task.stepCompleted, {
        task: waiting,
        step: latestTaskStep(waiting),
        output: outcome.finalResponse ?? "",
        data: { reason: "waiting_for_coordinator" },
      } satisfies AgentTaskStepEventPayload);
      return;
    }

    const failed = this.updateTask(taskId, (current) => this.recordTurnCompletion({
      task: {
        ...current,
        status: "failed",
        error: outcome.turn.error,
        outcome: current.outcome ?? {
          status: "failed",
          summary: outcome.turn.error ?? "Agent turn failed.",
          artifactRefs: [],
          evidenceRefs: [],
          blocker: outcome.turn.error,
          emittedAt: new Date().toISOString(),
        },
        finishedAt: new Date().toISOString(),
      },
      outcome,
      prompt,
      durationMs,
      status: "failed",
    }));
    this.activeTaskId = undefined;
    this.eventBus.publish(SystemEvents.task.failed, {
      task: failed,
    } satisfies AgentTaskEventPayload);
    this.eventBus.publish(SystemEvents.task.terminal, {
      task: failed,
      result: failed.result,
      error: failed.error,
    } satisfies AgentTaskTerminalEventPayload);
  }

  private failActiveTask(error: unknown): void {
    const taskId = this.activeTaskId ?? this.dequeueNextTaskId();
    if (!taskId) {
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
    const failed = this.updateTask(taskId, (current) => ({
      ...current,
      status: "failed",
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      outcome: current.outcome ?? {
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
        artifactRefs: [],
        evidenceRefs: [],
        blocker: error instanceof Error ? error.stack ?? error.message : String(error),
        emittedAt: new Date().toISOString(),
      },
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.activeTaskId = undefined;
    this.eventBus.publish(SystemEvents.task.failed, {
      task: failed,
    } satisfies AgentTaskEventPayload);
    this.eventBus.publish(SystemEvents.task.terminal, {
      task: failed,
      result: failed.result,
      error: failed.error,
    } satisfies AgentTaskTerminalEventPayload);
  }

  private hasPendingWork(): boolean {
    if (this.taskQueue.some((taskId) => this.store.getAgentTask(this.host.agentId, taskId)?.status === "queued")) {
      return true;
    }
    if (!this.activeTaskId) return false;
    return this.countPendingMessages(this.activeTaskId) > 0;
  }

  private recordTurnCompletion(input: {
    task: AgentTaskState;
    outcome: ScoutAgentTurnOutcome;
    prompt: string;
    durationMs: number;
    status: AgentTaskStepRecord["status"];
    protocolWarnings?: string[];
  }): AgentTaskState {
    const step: AgentTaskStepRecord = {
      stepId: `${input.task.taskId}-step-${String((input.task.steps?.length ?? 0) + 1).padStart(4, "0")}`,
      taskId: input.task.taskId,
      turnId: input.outcome.turn.turnId,
      status: input.status,
      prompt: input.prompt,
      finalResponse: input.outcome.finalResponse,
      toolCalls: input.outcome.toolCalls ?? [],
      startedAt: input.outcome.turn.startedAt,
      finishedAt: input.outcome.turn.finishedAt,
      durationMs: input.durationMs,
      protocolWarnings: input.protocolWarnings,
      error: input.outcome.turn.error,
    };
    return {
      ...input.task,
      status: input.status === "completed" ? input.task.status : input.status,
      result: input.outcome.finalResponse ?? input.task.result,
      steps: [...(input.task.steps ?? []), step],
      updatedAt: new Date().toISOString(),
      usage: {
        ...input.task.usage,
        durationMs: (input.task.usage?.durationMs ?? 0) + input.durationMs,
        toolUses: (input.task.usage?.toolUses ?? 0) + step.toolCalls.length,
      },
    };
  }

  private renderTaskPrompt(input: {
    task: AgentTaskState;
    includeInitialPrompt: boolean;
    pendingMessages: string[];
  }): string {
    const attachments = getAgentPendingMessageAttachments({ messages: input.pendingMessages });
    const renderedAttachments = attachments.length > 0 ? renderAttachmentsForPrompt(attachments) : "";
    if (input.includeInitialPrompt && renderedAttachments) {
      return [input.task.prompt, renderedAttachments].join("\n\n");
    }
    if (input.includeInitialPrompt) return input.task.prompt;
    return renderedAttachments || input.task.prompt;
  }

  private resolveMessageTarget(taskId: string | undefined): AgentTaskState {
    if (taskId) return this.getTask(taskId);
    if (this.activeTaskId) return this.getTask(this.activeTaskId);
    const queued = this.listTasks().find((task) => isActiveAgentTaskStatus(task.status));
    if (queued) return queued;
    throw new Error(`Agent ${this.host.agentId} has no active task for SendMessage.`);
  }

  private dequeueNextTaskId(): string | undefined {
    while (this.taskQueue.length > 0) {
      const taskId = this.taskQueue.shift();
      if (taskId && this.store.getAgentTask(this.host.agentId, taskId)?.status === "queued") return taskId;
    }
    return undefined;
  }

  private removeFromTaskQueue(taskId: string): void {
    const index = this.taskQueue.indexOf(taskId);
    if (index >= 0) this.taskQueue.splice(index, 1);
  }

  private drainPendingMessages(taskId: string): string[] {
    const messages = this.pendingMessages.get(taskId) ?? [];
    this.pendingMessages.delete(taskId);
    return messages;
  }

  private countPendingMessages(taskId: string): number {
    return this.pendingMessages.get(taskId)?.length ?? 0;
  }

  private getTask(taskId: string): AgentTaskState {
    return this.store.requireAgentTask(this.host.agentId, taskId);
  }

  private updateTask(taskId: string, update: (task: AgentTaskState) => AgentTaskState): AgentTaskState {
    const current = this.getTask(taskId);
    if (current.agentId !== this.host.agentId) {
      throw new Error(`Task ${taskId} does not belong to agent ${this.host.agentId}.`);
    }
    return this.store.updateTask(taskId, update);
  }
}

export function cloneAgentTaskState(task: AgentTaskState): AgentTaskState {
  return cloneTaskState(task);
}

export function isTerminalTaskStatus(status: AgentTaskState["status"]): boolean {
  return status === "complete"
    || status === "blocked"
    || status === "failed"
    || status === "stopped";
}

function latestTaskStep(task: AgentTaskState): AgentTaskStepRecord | undefined {
  return task.steps?.[task.steps.length - 1];
}
