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
  sameAgentTaskDisposition,
} from "../../task/agent-task-store.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { AgentEvents } from "../../events/index.js";
import {
  AgentTaskStatuses,
  AgentTaskStepStatuses,
  AgentTaskDispositionKinds,
  type AgentTaskDisposition,
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

/** Snapshot of a Worker runner's active task and queued messages. */
export interface WorkerRunnerSnapshot {
  activeTask?: AgentTaskState;
  pendingMessageCount: number;
}

/** Host boundary used by a Worker runner to execute turns and deliver outcomes. */
export interface WorkerRunnerHost {
  readonly agentId: string;
  readonly role: AgentThreadSpec["role"];
  readonly spec: AgentThreadSpec;
  runTurn(input: ScoutAgentTurnInput): Promise<ScoutAgentTurnOutcome>;
  deliverTaskOutcome(outcome: string): Promise<void>;
  deliverTaskProtocolFailure(message: string): Promise<void>;
}

/** Identity of a lifecycle tool call bound to the current turn. */
export interface WorkerLifecycleToolCall {
  turnId: string;
  callId: string;
}

/** Lifecycle call that submits a completed task outcome. */
export interface WorkerTaskSubmission extends WorkerLifecycleToolCall {
  outcome: string;
}

/** Lifecycle call that records a request waiting for human response. */
export interface WorkerHumanInputDisposition extends WorkerLifecycleToolCall {
  requestId: string;
  request: string;
}

const WORKER_DISPOSITION_PROTOCOL_ERROR = "WORKER_DISPOSITION_REQUIRED";

/** Construction and optional restored task state for a Worker runner. */
export interface WorkerRunnerOptions {
  host: WorkerRunnerHost;
  taskSequence: number;
  restoredTask?: AgentTaskState;
}

/**
 * Executes one Worker task at a time and enforces its lifecycle disposition
 * protocol before publishing completion or failure facts.
 */
export class WorkerRunner extends AgentRunner {
  readonly runnerKind = "worker";
  private readonly host: WorkerRunnerHost;
  private readonly taskSequence: number;
  private readonly loop: AgenticLoop<AgentTaskState>;
  private readonly acceptedMessages = new Map<string, AgentMessage>();
  private pendingMessages: AgentMessage[] = [];
  private resumeContext?: string;
  private resumeImmediately = false;
  private pendingHumanInput?: {
    stepId: string;
    turnId: string;
    callId: string;
    request: string;
  };
  private protocolCorrectionContext?: string;
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

  async submitTask(input: WorkerTaskSubmission): Promise<AgentTaskState> {
    const { task, step, existing } = this.resolveDispositionTarget({
      kind: AgentTaskDispositionKinds.HandoffSubmitted,
      turnId: input.turnId,
      callId: input.callId,
      outcome: input.outcome,
    });
    if (existing) return cloneTaskState(task);
    if (this.pendingHumanInput) {
      throw new Error(
        `Worker task step ${step.stepId} already has a pending RequestHumanInput call.`,
      );
    }
    return this.recordDisposition(task.taskId, {
      kind: AgentTaskDispositionKinds.HandoffSubmitted,
      stepId: step.stepId,
      turnId: input.turnId,
      callId: input.callId,
      timestamp: new Date().toISOString(),
      outcome: input.outcome,
    });
  }

  beginHumanInput(input: Omit<WorkerHumanInputDisposition, "requestId">): AgentTaskState {
    const { task, step, existing } = this.resolveDispositionTarget({
      kind: AgentTaskDispositionKinds.WaitingForHuman,
      turnId: input.turnId,
      callId: input.callId,
      requestId: "<pending>",
      request: input.request,
    }, true);
    if (existing) return cloneTaskState(task);
    if (this.pendingHumanInput) {
      throw new Error(`Worker task step ${step.stepId} already has a lifecycle call in progress.`);
    }
    this.pendingHumanInput = {
      stepId: step.stepId,
      turnId: input.turnId,
      callId: input.callId,
      request: input.request,
    };
    return cloneTaskState(task);
  }

  async completeHumanInput(input: WorkerHumanInputDisposition): Promise<AgentTaskState> {
    const pending = this.pendingHumanInput;
    const task = this.getActiveTask();
    const step = task.steps?.at(-1);
    const existing = step?.disposition;
    if (
      existing?.kind === AgentTaskDispositionKinds.WaitingForHuman
      && existing.turnId === input.turnId
      && existing.callId === input.callId
      && existing.request === input.request
    ) {
      return cloneTaskState(task);
    }
    if (
      !pending
      || pending.stepId !== step?.stepId
      || pending.turnId !== input.turnId
      || pending.callId !== input.callId
      || pending.request !== input.request
    ) {
      throw new Error(`Worker task ${task.taskId} has no matching RequestHumanInput call in progress.`);
    }
    try {
      return await this.recordDisposition(task.taskId, {
        kind: AgentTaskDispositionKinds.WaitingForHuman,
        stepId: pending.stepId,
        turnId: input.turnId,
        callId: input.callId,
        timestamp: new Date().toISOString(),
        requestId: input.requestId,
        request: input.request,
      });
    } finally {
      this.pendingHumanInput = undefined;
    }
  }

  abortHumanInput(input: Omit<WorkerHumanInputDisposition, "requestId">): void {
    const pending = this.pendingHumanInput;
    if (
      pending
      && pending.turnId === input.turnId
      && pending.callId === input.callId
      && pending.request === input.request
    ) {
      this.pendingHumanInput = undefined;
    }
  }

  async stopTask(
    taskId: string,
    reason = "任务已被 Coordinator 停止。",
  ): Promise<AgentTaskState> {
    const task = this.getTask(taskId);
    if (isTerminalTaskStatus(task.status)) return cloneTaskState(task);
    this.pendingMessages = [];
    this.pendingHumanInput = undefined;
    this.protocolCorrectionContext = undefined;
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
    this.pendingHumanInput = undefined;
    this.protocolCorrectionContext = undefined;
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
        || this.protocolCorrectionContext !== undefined
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

    const protocolCorrectionContext = this.protocolCorrectionContext;
    const isProtocolCorrection = protocolCorrectionContext !== undefined;
    const pendingMessages = isProtocolCorrection
      ? []
      : structuredClone(this.pendingMessages);
    const resumeContext = isProtocolCorrection ? undefined : this.resumeContext;
    const prompt = attachments.compose(
      agent.turn.use_update_tools(),
      ...(protocolCorrectionContext ? [protocolCorrectionContext] : []),
      ...(resumeContext ? [resumeContext] : []),
      ...(initialPrompt === undefined || isProtocolCorrection ? [] : [
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
        protocolRepairAttempts: isProtocolCorrection
          ? task.protocolRepairAttempts
          : 0,
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
    this.protocolCorrectionContext = undefined;
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
      this.pendingHumanInput = undefined;
      this.activeTask = latest;
      return;
    }
    if (isTerminalTaskStatus(latest.status)) {
      this.pendingHumanInput = undefined;
      const completedState = this.completeLatestTaskStep({
        task: latest,
        outcome,
        durationMs,
        status: outcome.turn.status === "interrupted"
          ? AgentTaskStepStatuses.Interrupted
          : outcome.turn.status === "failed"
          ? AgentTaskStepStatuses.Failed
          : AgentTaskStepStatuses.Completed,
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
      const currentStep = latest.steps?.at(-1);
      if (!currentStep) throw new Error(`Task ${taskId} has no current step.`);
      const lifecycleDisposition = currentStep.disposition?.kind === AgentTaskDispositionKinds.ProtocolViolation
        ? undefined
        : currentStep.disposition;
      if (
        lifecycleDisposition
        && lifecycleDisposition.turnId !== outcome.turn.turnId
      ) {
        throw new Error(
          `Worker task ${taskId} received lifecycle disposition for turn ${lifecycleDisposition.turnId}, not completed turn ${outcome.turn.turnId ?? "<none>"}.`,
        );
      }
      if (currentStep.requiresDisposition !== false && !currentStep.disposition) {
        const reason = `${WORKER_DISPOSITION_PROTOCOL_ERROR}: Worker task ${taskId} 的 step ${currentStep.stepId} 结束时未调用 SubmitTask 或 RequestHumanInput。`;
        const violationTask = await this.recordDisposition(taskId, {
          kind: AgentTaskDispositionKinds.ProtocolViolation,
          stepId: currentStep.stepId,
          turnId: outcome.turn.turnId ?? outcome.turn.invocationId,
          callId: null,
          timestamp: new Date().toISOString(),
          reason,
        });
        const attempts = (violationTask.protocolRepairAttempts ?? 0) + 1;
        const shouldFail = isProtocolCorrection || attempts > 1;
        const completedState = this.completeLatestTaskStep({
          task: {
            ...violationTask,
            protocolRepairAttempts: attempts,
            ...(shouldFail ? {
              status: AgentTaskStatuses.Failed,
              error: reason,
              finishedAt: new Date().toISOString(),
            } : {}),
          },
          outcome,
          durationMs,
          status: shouldFail
            ? AgentTaskStepStatuses.Failed
            : AgentTaskStepStatuses.Completed,
          protocolWarnings: [reason],
          error: reason,
        });
        this.eventBus.publish(
          AgentEvents.task.stepCompleted,
          completedState,
          { occurredAt: completedState.updatedAt },
        );
        const updated = this.updateTask(taskId, () => completedState);
        this.activeTask = updated;
        if (!shouldFail) {
          this.protocolCorrectionContext = agent.turn.message([
            "运行时协议修正（最后一次机会）。",
            `上一步 ${currentStep.stepId} 结束时没有提交生命周期处置。`,
            "不要重复领域工作。请根据本线程已经完成的工作，现在只调用一个生命周期工具：",
            "- 可以提交结果时调用 SubmitTask。",
            "- 必须等待人工确认才能继续时调用 RequestHumanInput。",
            "工具调用成功后结束本 turn。",
          ].join("\n"));
          return;
        }
        this.eventBus.publish(
          AgentEvents.task.failed,
          updated,
          { occurredAt: updated.updatedAt },
        );
        this.eventBus.publish(AgentEvents.task.terminal, updated);
        await this.host.deliverTaskProtocolFailure([
          `Worker task ${taskId} 未通过 Runtime 协议强制检查。`,
          reason,
          "有界修正 turn 结束时仍未提交生命周期处置。",
        ].join("\n"));
        return;
      }

      const completedState = this.completeLatestTaskStep({
        task: {
          ...latest,
          protocolRepairAttempts: 0,
        },
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
      const disposition = stillRunning.steps?.at(-1)?.disposition;
      if (disposition?.kind === AgentTaskDispositionKinds.HandoffSubmitted) {
        const completedStep = stillRunning.steps?.[stillRunning.steps.length - 1];
        if (disposition.stepId !== completedStep?.stepId) {
          throw new Error(
            `Worker task ${taskId} submitted outcome for ${disposition.stepId}, not ${completedStep?.stepId ?? "<none>"}.`,
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
          stepId: disposition.stepId,
          turnId: disposition.turnId,
          callId: disposition.callId,
          outcome: disposition.outcome,
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
        await this.host.deliverTaskOutcome(disposition.outcome);
      }
      return;
    }

    this.pendingHumanInput = undefined;
    if (outcome.turn.status === "interrupted") {
      const interruptedState = this.completeLatestTaskStep({
        task: latest,
        outcome,
        durationMs,
        status: AgentTaskStepStatuses.Interrupted,
      });
      this.eventBus.publish(
        AgentEvents.task.stepInterrupted,
        interruptedState,
        { occurredAt: interruptedState.updatedAt },
      );
      const interrupted = this.updateTask(taskId, () => interruptedState);
      this.activeTask = interrupted;
      return;
    }

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
    this.pendingHumanInput = undefined;
    this.protocolCorrectionContext = undefined;
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
      requiresDisposition: true,
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

  private getActiveTask(): AgentTaskState {
    const task = this.activeTask;
    if (!task) {
      throw new Error(`Worker runner ${this.host.agentId} has no active task.`);
    }
    return this.getTask(task.taskId);
  }

  private resolveDispositionTarget(input: {
    kind: AgentTaskDisposition["kind"];
    turnId: string;
    callId: string | null;
    outcome?: string;
    requestId?: string;
    request?: string;
    reason?: string;
  }, ignoreWaitingRequestId = false): {
    task: AgentTaskState;
    step: AgentTaskStep;
    existing: boolean;
  } {
    const task = this.getActiveTask();
    const step = task.steps?.at(-1);
    if (!step) {
      throw new Error(`Worker task ${task.taskId} has no current step for lifecycle disposition.`);
    }
    const existing = step.disposition;
    if (existing) {
      const matches = existing.kind === input.kind
        && existing.turnId === input.turnId
        && existing.callId === input.callId
        && (
          existing.kind !== AgentTaskDispositionKinds.HandoffSubmitted
          || existing.outcome === input.outcome
        )
        && (
          existing.kind !== AgentTaskDispositionKinds.WaitingForHuman
          || (
            existing.request === input.request
            && (ignoreWaitingRequestId || existing.requestId === input.requestId)
          )
        )
        && (
          existing.kind !== AgentTaskDispositionKinds.ProtocolViolation
          || existing.reason === input.reason
        );
      if (matches) return { task, step, existing: true };
      throw new Error(
        `Worker task step ${step.stepId} already recorded lifecycle disposition ${existing.kind}.`,
      );
    }
    if (
      task.status !== AgentTaskStatuses.Running
      || step.status !== AgentTaskStepStatuses.Running
    ) {
      throw new Error(
        `Worker task ${task.taskId} has no running step for lifecycle disposition.`,
      );
    }
    return { task, step, existing: false };
  }

  private async recordDisposition(
    taskId: string,
    disposition: AgentTaskDisposition,
  ): Promise<AgentTaskState> {
    const current = this.getTask(taskId);
    const currentDisposition = current.steps
      ?.find((step) => step.stepId === disposition.stepId)
      ?.disposition;
    if (currentDisposition) {
      if (sameAgentTaskDisposition(currentDisposition, disposition)) {
        return current;
      }
      throw new Error(
        `Worker task step ${disposition.stepId} already recorded lifecycle disposition ${currentDisposition.kind}.`,
      );
    }
    const recorded = this.store.recordTaskDisposition(taskId, disposition);
    const persistedDisposition = recorded.steps
      ?.find((step) => step.stepId === disposition.stepId)
      ?.disposition;
    if (!persistedDisposition) {
      throw new Error(`Worker task ${taskId} did not persist disposition for ${disposition.stepId}.`);
    }
    this.activeTask = recorded;
    await this.eventBus.publishAndWait(AgentEvents.task.dispositionRecorded, {
      task: recorded,
      disposition: persistedDisposition,
    }, {
      occurredAt: persistedDisposition.timestamp,
    });
    return cloneTaskState(recorded);
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

/** Returns a detached task state for callers outside the Worker runner. */
export function cloneAgentTaskState(task: AgentTaskState): AgentTaskState {
  return cloneTaskState(task);
}

/** Whether a task status prevents another Worker turn from being scheduled. */
export function isTerminalTaskStatus(status: AgentTaskState["status"]): boolean {
  return status === AgentTaskStatuses.Failed
    || status === AgentTaskStatuses.Stopped;
}
