import type { Logger } from "../../core/logging/index.js";
import {
  getAgentPendingMessageAttachments,
  renderAttachmentsForPrompt,
} from "./attachments.js";
import {
  AgenticLoop,
  type AgenticTickContinuation,
} from "../core/agentic-loop.js";
import {
  AgentTaskStore,
  cloneAgentTaskState as cloneTaskState,
} from "../task/agent-task-store.js";
import type { EventBus } from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/index.js";
import type {
  AgentTaskEventPayload,
  AgentHumanInputRequestedEventPayload,
  AgentTaskStepEventPayload,
  AgentTaskTerminalEventPayload,
} from "../task/task-events.js";
import type {
  AgentTaskOutcome,
  AgentTaskStep,
  AgentTaskState,
  AgentHumanInputRequest,
  AgentHumanInputResponse,
  AssignAgentTaskInput,
} from "../task/types.js";
import type {
  ScoutAgentTurnInput,
  ScoutAgentTurnOutcome,
} from "../core/scout-agent.js";
import type { AgentThreadSnapshot, AgentThreadSpec } from "../thread/types.js";
import { AgentRunner } from "./types.js";

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
  startThread(): Promise<AgentThreadSnapshot>;
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
  tickIntervalMs?: number;
}

export class WorkerRunner extends AgentRunner {
  readonly runnerKind = "worker";
  private readonly host: WorkerRunnerHost;
  private readonly store: AgentTaskStore;
  private readonly eventBus: EventBus;
  private readonly loop: AgenticLoop<AgentTaskState>;
  private readonly tickIntervalMs: number;
  private pendingMessages: string[] = [];
  private activeTask?: AgentTaskState;
  private stopped = false;

  constructor(options: WorkerRunnerOptions) {
    super();
    this.host = options.host;
    this.store = options.store;
    this.eventBus = options.eventBus;
    this.tickIntervalMs = options.tickIntervalMs ?? 1000;
    this.loop = new AgenticLoop<AgentTaskState>({
      agentId: this.host.agentId,
      handlers: {
        loopKind: "tick",
        takeTick: () => this.takeTaskTick(),
        runTick: (task) => this.runTaskTick(task),
        isStopped: () => this.stopped,
        onError: (error) => this.failActiveTask(error),
      },
    });
  }

  get agentId(): string {
    return this.host.agentId;
  }

  assignTask(input: AssignAgentTaskInput): AgentTaskState {
    if (this.stopped) {
      throw new Error(`Agent ${this.host.agentId} is stopped.`);
    }
    if (input.subagentType !== this.host.role) {
      throw new Error(`Cannot assign ${input.subagentType} task to ${this.host.role} agent ${this.host.agentId}.`);
    }
    if (this.activeTask) {
      throw new Error(`Worker runner ${this.host.agentId} already owns task ${this.activeTask.taskId}.`);
    }
    const now = new Date().toISOString();
    const task: AgentTaskState = {
      type: "local_agent",
      taskId: input.taskId,
      agentId: this.host.agentId,
      role: this.host.role,
      description: input.description,
      initialPrompt: input.prompt,
      status: "queued",
      isBackgrounded: input.isBackgrounded ?? true,
      createdAt: now,
      updatedAt: now,
      thread: this.host.threadSnapshot,
    };
    const stored = this.store.addTask(task);
    this.activeTask = stored;
    this.eventBus.publish(SystemEvents.task.assigned, {
      task: stored,
    } satisfies AgentTaskEventPayload);
    this.loop.schedule();
    return stored;
  }

  queueMessage(input: { taskId?: string; message: string }): AgentTaskState {
    const task = this.resolveMessageTarget(input.taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Cannot queue message for terminal task ${task.taskId}. Status: ${task.status}`);
    }
    this.pendingMessages = [...this.pendingMessages, input.message];
    const updated = this.updateTask(task.taskId, (currentTask) => ({
      ...currentTask,
      status: currentTask.status === "waiting_for_human_input" ? "running" : currentTask.status,
      humanInputRequest: undefined,
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
    this.pendingMessages = [];
    const stopped = this.updateTask(taskId, (current) => ({
      ...current,
      status: "stopped",
      error: reason,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    this.activeTask = stopped;
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
      humanInputRequest: undefined,
      finishedAt: emittedAt,
      updatedAt: emittedAt,
    }));
    this.pendingMessages = [];
    this.activeTask = completed;
    this.eventBus.publish(SystemEvents.task.outcomeAccepted, {
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
    const waiting = this.updateTask(task.taskId, (current) => ({
      ...current,
      status: "waiting_for_human_input",
      humanInputRequest: { ...request },
      humanInputRequests: [...(current.humanInputRequests ?? []), request],
      updatedAt,
    }));
    this.eventBus.publish(SystemEvents.task.humanInputRequested, {
      task: waiting,
      request,
      data: { requestId: request.requestId },
    } satisfies AgentHumanInputRequestedEventPayload);
    return cloneTaskState(waiting);
  }

  applyHumanInputResponse(input: AgentHumanInputResponse): AgentTaskState {
    const task = this.getTask(input.taskId);
    const updated = this.updateTask(task.taskId, (current) => ({
      ...current,
      humanInputRequest: current.humanInputRequest?.requestId === input.requestId
        ? {
          ...current.humanInputRequest,
          status: "answered",
        }
        : current.humanInputRequest,
      humanInputRequests: (current.humanInputRequests ?? []).map((request) =>
        request.requestId === input.requestId ? { ...request, status: "answered" } : request
      ),
      humanInputResponses: [...(current.humanInputResponses ?? []), { ...input }],
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

  snapshot(): WorkerRunnerSnapshot {
    return {
      tasks: this.listTasks(),
      activeTask: this.activeTask ? cloneTaskState(this.activeTask) : undefined,
      pendingMessageCount: this.pendingMessages.length,
    };
  }

  private takeTaskTick(): AgentTaskState | undefined {
    if (this.activeTask) {
      if (this.activeTask.status === "queued") {
        return this.activeTask;
      }
      if (this.activeTask.status !== "running") {
        return undefined;
      }
      if (this.countPendingMessages(this.activeTask.taskId) > 0) {
        return this.activeTask;
      }
      return undefined;
    }
    return undefined;
  }

  private async runTaskTick(activeTask: AgentTaskState): Promise<void | AgenticTickContinuation<AgentTaskState>> {
    const taskId = activeTask.taskId;
    this.ensureOwnedTask(taskId);
    let task = activeTask;
    this.activeTask = task;
    if (task.status === "stopped") {
      return;
    }
    const hadStarted = Boolean(task.startedAt);
    const initialPrompt = hadStarted ? undefined : task.initialPrompt;
    const thread = await this.host.startThread();
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
      this.activeTask = task;
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
        task,
        data: {
          messages: pendingMessages,
        },
      } satisfies AgentTaskEventPayload);
    }
    const prompt = this.renderTaskPrompt({
      task,
      includeInitialPrompt: !hadStarted,
      initialPrompt,
      pendingMessages,
    });

    const running = this.updateTask(taskId, (current) => ({
      ...current,
      status: "running",
      updatedAt: new Date().toISOString(),
    }));
    this.activeTask = running;
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
      this.activeTask = latest;
      return;
    }
    if (latest.status === "waiting_for_human_input") {
      const waiting = this.updateTask(taskId, (current) => this.appendTaskStep({
        task: current,
        outcome,
        prompt,
        durationMs,
        status: "waiting_for_human_input",
      }));
      this.activeTask = waiting;
      this.eventBus.publish(SystemEvents.task.stepCompleted, {
        task: waiting,
        step: latestTaskStep(waiting),
        data: { reason: "waiting_for_human_input" },
      } satisfies AgentTaskStepEventPayload);
      return;
    }
    if (isTerminalTaskStatus(latest.status)) {
      const updated = this.updateTask(taskId, (current) => this.appendTaskStep({
        task: current,
        outcome,
        prompt,
        durationMs,
        status: outcome.turn.status === "failed" ? "failed" : "completed",
      }));
      this.activeTask = updated;
      this.eventBus.publish(SystemEvents.task.stepCompleted, {
        task: updated,
        step: latestTaskStep(updated),
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
        const stillRunning = this.updateTask(taskId, (current) => this.appendTaskStep({
          task: current,
          outcome,
          prompt,
          durationMs,
          status: "completed",
        }));
        this.activeTask = stillRunning;
        this.eventBus.publish(SystemEvents.task.stepCompleted, {
          task: stillRunning,
          step: latestTaskStep(stillRunning),
          output: outcome.finalResponse ?? "",
          data: { reason: "pending_messages" },
        } satisfies AgentTaskStepEventPayload);
        return;
      }
      const stillRunning = this.updateTask(taskId, (current) => this.appendTaskStep({
        task: current,
        outcome,
        prompt,
        durationMs,
        status: "completed",
      }));
      this.activeTask = stillRunning;
      this.eventBus.publish(SystemEvents.task.stepCompleted, {
        task: stillRunning,
        step: latestTaskStep(stillRunning),
        output: outcome.finalResponse ?? "",
        data: { reason: "tick_scheduled" },
      } satisfies AgentTaskStepEventPayload);
      return { continueAfterMs: this.tickIntervalMs, continueWith: stillRunning };
    }

    const failed = this.updateTask(taskId, (current) => this.appendTaskStep({
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
    this.activeTask = failed;
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
    this.activeTask = failed;
    this.eventBus.publish(SystemEvents.task.failed, {
      task: failed,
    } satisfies AgentTaskEventPayload);
    this.eventBus.publish(SystemEvents.task.terminal, {
      task: failed,
      result: failed.result,
      error: failed.error,
    } satisfies AgentTaskTerminalEventPayload);
  }

  private appendTaskStep(input: {
    task: AgentTaskState;
    outcome: ScoutAgentTurnOutcome;
    prompt: string;
    durationMs: number;
    status: AgentTaskStep["status"];
    protocolWarnings?: string[];
    error?: string;
  }): AgentTaskState {
    const step: AgentTaskStep = {
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
      error: input.error ?? input.outcome.turn.error,
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
    initialPrompt?: string;
    pendingMessages: string[];
  }): string {
    const attachments = getAgentPendingMessageAttachments({ messages: input.pendingMessages });
    const renderedAttachments = attachments.length > 0 ? renderAttachmentsForPrompt(attachments) : "";
    if (input.includeInitialPrompt && renderedAttachments) {
      return [input.initialPrompt, renderedAttachments].filter(Boolean).join("\n\n");
    }
    if (input.includeInitialPrompt) {
      if (!input.initialPrompt) throw new Error(`Task ${input.task.taskId} has no initial prompt.`);
      return input.initialPrompt;
    }
    return renderedAttachments || renderTaskTickPrompt(input.task);
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
  return status === "complete"
    || status === "blocked"
    || status === "failed"
    || status === "stopped";
}

function latestTaskStep(task: AgentTaskState): AgentTaskStep | undefined {
  return task.steps?.[task.steps.length - 1];
}

function renderTaskTickPrompt(task: AgentTaskState): string {
  return JSON.stringify({
    type: "task_tick",
    task: {
      taskId: task.taskId,
      status: task.status,
      description: task.description,
      latestStepId: latestTaskStep(task)?.stepId,
    },
    instruction: "continue_current_task",
  });
}
