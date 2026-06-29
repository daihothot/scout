import type { Logger } from "../core/logging/index.js";
import {
  getAgentPendingMessageAttachments,
  renderAttachmentsForPrompt,
} from "./attachments.js";
import { AgenticLoop } from "./orchestration/agentic-loop.js";
import { AgentTaskStateEvents } from "./task/types.js";
import type {
  AgentTaskOutcome,
  AgentTaskState,
  AgentTaskStateEvent,
  AgentUserInputRequest,
  AssignAgentTaskInput,
} from "./task/types.js";
import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "./scout-agent.js";
import type { ScoutAgentThreadPreflightRecord } from "./backend/thread-preflight.js";
import type { AgentThreadRecord, AgentThreadSpec } from "./types.js";

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
  emitTaskState(event: AgentTaskStateEvent, task: AgentTaskState, data?: unknown): void;
  emitTaskTerminal(task: AgentTaskState): void;
  emitUserInputRequested(task: AgentTaskState): void;
}

export interface ScoutAgentTaskRuntimeOptions {
  host: ScoutAgentTaskHost;
}

export class ScoutAgentTaskRuntime {
  private readonly host: ScoutAgentTaskHost;
  private readonly loop: AgenticLoop;
  private readonly tasks = new Map<string, AgentTaskState>();
  private readonly taskQueue: string[] = [];
  private readonly pendingMessages = new Map<string, string[]>();
  private activeTaskId?: string;
  private stopped = false;

  constructor(options: ScoutAgentTaskRuntimeOptions) {
    this.host = options.host;
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
    if (this.tasks.has(input.taskId)) {
      throw new Error(`Duplicate agent task id: ${input.taskId}`);
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
    this.tasks.set(task.taskId, task);
    this.taskQueue.push(task.taskId);
    this.emitTaskState(AgentTaskStateEvents.Assigned, task, { prompt: input.prompt });
    this.loop.schedule();
    return cloneAgentTaskState(task);
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
      status: currentTask.status === "waiting_for_input" ? "running" : currentTask.status,
      userInputRequest: undefined,
      outcome: undefined,
      updatedAt: new Date().toISOString(),
    }));
    this.emitTaskState(AgentTaskStateEvents.MessageQueued, updated, {
      message: input.message,
      pendingMessageCount: this.countPendingMessages(task.taskId),
    });
    this.loop.schedule();
    return cloneAgentTaskState(updated);
  }

  stopTask(taskId: string, reason = "任务已被 Coordinator 停止。"): AgentTaskState {
    const task = this.getTask(taskId);
    if (isTerminalTaskStatus(task.status)) return cloneAgentTaskState(task);
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
    this.emitTaskState(AgentTaskStateEvents.Stopped, stopped, { reason });
    this.host.emitTaskTerminal(stopped);
    return cloneAgentTaskState(stopped);
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
    return [...this.tasks.values()].map(cloneAgentTaskState);
  }

  getTaskSnapshot(taskId: string): AgentTaskState | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneAgentTaskState(task) : undefined;
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
    this.emitTaskState(AgentTaskStateEvents.OutcomeRecorded, completed, {
      outcome: completed.outcome,
    });
    this.host.emitTaskTerminal(completed);
    return cloneAgentTaskState(completed);
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
    const waiting = this.updateTask(task.taskId, (current) => ({
      ...current,
      status: "waiting_for_input",
      userInputRequest: { ...input.request },
      outcome: {
        status: input.request.kind,
        summary: input.request.question,
        artifactRefs: [],
        evidenceRefs: [],
        blocker: input.request.context,
        nextStep: "等待 Coordinator 获取人工输入后继续投递。",
        emittedAt: updatedAt,
      },
      updatedAt,
    }));
    this.emitTaskState(AgentTaskStateEvents.WaitingForInput, waiting, { userInputRequest: waiting.userInputRequest });
    this.host.emitUserInputRequested(waiting);
    return cloneAgentTaskState(waiting);
  }

  hasRunningTasks(): boolean {
    return [...this.tasks.values()].some((task) => task.status === "queued" || task.status === "running");
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
      this.emitTaskState(AgentTaskStateEvents.ThreadAttached, task, { threadId: thread.threadId });
      if (goal) {
        this.emitTaskState(AgentTaskStateEvents.GoalUpdated, task, { goal });
      }
    }

    const pendingMessages = this.drainPendingMessages(taskId);
    if (pendingMessages.length > 0) {
      this.emitTaskState(AgentTaskStateEvents.PendingMessagesDrained, this.getTask(taskId), {
        messages: pendingMessages,
      });
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
    this.emitTaskState(AgentTaskStateEvents.StepStarted, running, { prompt });

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
    if (latest.status === "waiting_for_input") {
      const waiting = this.updateTask(taskId, (current) => ({
        ...current,
        result: outcome.finalResponse ?? current.result,
        updatedAt: new Date().toISOString(),
        usage: {
          ...current.usage,
          durationMs: (current.usage?.durationMs ?? 0) + durationMs,
        },
      }));
      this.emitTaskState(AgentTaskStateEvents.StepCompletedWaitingForInput, waiting);
      return;
    }
    if (isTerminalTaskStatus(latest.status)) {
      this.activeTaskId = undefined;
      this.emitTaskState(AgentTaskStateEvents.StepCompletedAfterTerminalUpdate, latest);
      return;
    }

    if (outcome.turn.status === "completed") {
      this.emitTaskState(AgentTaskStateEvents.StepOutput, latest, { output: outcome.finalResponse ?? "" });
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
        this.emitTaskState(AgentTaskStateEvents.StepCompletedWithPendingMessages, stillRunning);
        return;
      }
      const failed = this.updateTask(taskId, (current) => ({
        ...current,
        status: "failed",
        result: outcome.finalResponse,
        error: "Agent turn completed without TaskResult.",
        outcome: {
          status: "failed",
          summary: "Agent turn completed without TaskResult.",
          artifactRefs: [],
          evidenceRefs: [],
          blocker: "Agent must call TaskResult to finish a task.",
          nextStep: "Coordinator should send a follow-up message requiring TaskResult, or stop and reassign the task.",
          emittedAt: new Date().toISOString(),
        },
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        usage: {
          ...current.usage,
          durationMs: (current.usage?.durationMs ?? 0) + durationMs,
        },
      }));
      this.activeTaskId = undefined;
      this.emitTaskState(AgentTaskStateEvents.MissingTaskResult, failed, {
        output: outcome.finalResponse ?? "",
      });
      this.host.emitTaskTerminal(failed);
      return;
    }

    const failed = this.updateTask(taskId, (current) => ({
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
      updatedAt: new Date().toISOString(),
      usage: {
        ...current.usage,
        durationMs: (current.usage?.durationMs ?? 0) + durationMs,
      },
    }));
    this.activeTaskId = undefined;
    this.emitTaskState(AgentTaskStateEvents.Failed, failed);
    this.host.emitTaskTerminal(failed);
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
    this.emitTaskState(AgentTaskStateEvents.Failed, failed);
    this.host.emitTaskTerminal(failed);
  }

  private hasPendingWork(): boolean {
    if (this.taskQueue.some((taskId) => this.tasks.get(taskId)?.status === "queued")) {
      return true;
    }
    if (!this.activeTaskId) return false;
    return this.countPendingMessages(this.activeTaskId) > 0;
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
    const queued = this.listTasks().find((task) => task.status === "queued" || task.status === "running" || task.status === "waiting_for_input");
    if (queued) return queued;
    throw new Error(`Agent ${this.host.agentId} has no active task for SendMessage.`);
  }

  private dequeueNextTaskId(): string | undefined {
    while (this.taskQueue.length > 0) {
      const taskId = this.taskQueue.shift();
      if (taskId && this.tasks.get(taskId)?.status === "queued") return taskId;
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
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId} on agent ${this.host.agentId}.`);
    return task;
  }

  private updateTask(taskId: string, update: (task: AgentTaskState) => AgentTaskState): AgentTaskState {
    const next = update(this.getTask(taskId));
    this.tasks.set(taskId, next);
    return next;
  }

  private emitTaskState(event: AgentTaskStateEvent, task: AgentTaskState, data?: unknown): void {
    this.host.emitTaskState(event, task, data);
  }
}

export function cloneAgentTaskState(task: AgentTaskState): AgentTaskState {
  return {
    ...task,
    usage: task.usage ? { ...task.usage } : undefined,
    thread: task.thread ? { ...task.thread } : undefined,
    userInputRequest: task.userInputRequest ? {
      ...task.userInputRequest,
      options: task.userInputRequest.options ? [...task.userInputRequest.options] : undefined,
    } : undefined,
    outcome: task.outcome ? {
      ...task.outcome,
      artifactRefs: [...task.outcome.artifactRefs],
      evidenceRefs: [...task.outcome.evidenceRefs],
    } : undefined,
  };
}

export function isTerminalTaskStatus(status: AgentTaskState["status"]): boolean {
  return status === "complete"
    || status === "prompt_required"
    || status === "confirmation_required"
    || status === "blocked"
    || status === "insufficient_evidence"
    || status === "failed"
    || status === "stopped";
}
