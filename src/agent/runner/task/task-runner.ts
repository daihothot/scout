import {
  attachments,
} from "../../context/attachments.js";
import {
  agent,
} from "../../context/agent-attachments.js";
import {
  cloneAgentTaskState,
} from "../../task/agent-task-store.js";
import { currentRunScope } from "../../../run/run-scope.js";
import { AgentEvents } from "../../events/index.js";
import {
  AgentTaskDispositionKinds,
  AgentTaskStatuses,
  type AgentTaskDisposition,
  type AgentTaskState,
  type AssignAgentTaskInput,
} from "../../task/types.js";
import type { AgentStepState } from "../../step/types.js";
import type { ScoutAgentTurnOutcome } from "../../core/scout-agent.js";
import type { AgentThreadSpec } from "../../thread/types.js";
import type { AgentMessage } from "../../message/types.js";

/** Snapshot of the single Task owned by a Task runner. */
export interface TaskRunnerSnapshot {
  activeTask?: AgentTaskState;
}

/** Task-level effects delivered outside the owning Worker Agent. */
export interface TaskRunnerHost {
  readonly agentId: string;
  readonly role: AgentThreadSpec["role"];
  deliverTaskOutcome(outcome: string): Promise<void>;
  deliverTaskProtocolFailure(message: string): Promise<void>;
}

/** Construction and optional restored Task state for a Task runner. */
export interface TaskRunnerOptions {
  host: TaskRunnerHost;
  taskSequence: number;
  restoredTask?: AgentTaskState;
}

/** One Task decision that is ready for its owning Agent to execute as a Step. */
export interface TaskStepPreparation {
  taskId: string;
  stepId: string;
  prompt: string;
  messagesToConsume: AgentMessage[];
  isProtocolCorrection: boolean;
  taskStartedAt: string;
}

/** Step facts consumed by Task lifecycle policy after Agent execution. */
export interface TaskStepResult {
  step: AgentStepState;
  outcome: ScoutAgentTurnOutcome;
}

const WORKER_DISPOSITION_PROTOCOL_ERROR = "WORKER_DISPOSITION_REQUIRED";

/**
 * Owns one Worker Task lifecycle. Its owning Worker Agent drives Steps and
 * reports their facts back through this boundary.
 */
export class TaskRunner {
  private readonly host: TaskRunnerHost;
  private readonly taskSequence: number;
  private resumeContext?: string;
  private resumeImmediately = false;
  private runningProtocolCorrectionSourceTurnId?: string;
  private activeTask?: AgentTaskState;

  constructor(options: TaskRunnerOptions) {
    this.host = options.host;
    this.taskSequence = options.taskSequence;
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
    if (this.activeTask) {
      throw new Error(`Task runner ${this.host.agentId} already has task ${this.activeTask.taskId}.`);
    }
    const now = new Date().toISOString();
    const taskId = input.taskId ?? this.buildTaskId(this.taskSequence);
    const task: AgentTaskState = {
      type: "local_agent",
      taskId,
      taskSequence: this.taskSequence,
      agentId: this.host.agentId,
      role: this.host.role,
      description: input.description,
      initialPrompt: input.prompt,
      status: AgentTaskStatuses.Queued,
      isBackgrounded: input.isBackgrounded ?? true,
      stepIds: [],
      dispositions: [],
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
    return stored;
  }

  assertCanReceiveMessage(taskId: string | undefined): AgentTaskState {
    const task = this.resolveMessageTarget(taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Cannot queue message for terminal task ${task.taskId}. Status: ${task.status}`);
    }
    return cloneAgentTaskState(task);
  }

  recordMessageQueued(taskId: string): void {
    const updated = this.updateTask(taskId, (currentTask) => ({
      ...currentTask,
      updatedAt: new Date().toISOString(),
    }));
    this.activeTask = updated;
    this.eventBus.publish(AgentEvents.task.messageQueued, updated);
  }

  async stopTask(
    taskId: string,
    reason = "任务已被 Coordinator 停止。",
  ): Promise<AgentTaskState> {
    const task = this.getTask(taskId);
    if (isTerminalTaskStatus(task.status)) return cloneAgentTaskState(task);
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
    return cloneAgentTaskState(stopped);
  }

  getTaskSnapshot(taskId: string): AgentTaskState | undefined {
    if (this.activeTask?.taskId !== taskId) return undefined;
    return this.store.getTask(taskId);
  }

  async archiveTask(taskId: string): Promise<AgentTaskState> {
    this.ensureOwnedTask(taskId);
    const task = this.getTask(taskId);
    const archivedAt = new Date().toISOString();
    this.eventBus.publish(
      AgentEvents.task.archived,
      task,
      { occurredAt: archivedAt },
    );
    const archived = this.store.removeTask(taskId);
    this.activeTask = undefined;
    return cloneAgentTaskState(archived);
  }

  shouldActivateRestoredTask(pendingMessageCount: number): boolean {
    const task = this.activeTask;
    if (!task) throw new Error(`Task runner ${this.host.agentId} has no restored task.`);
    const shouldActivate =
      task.status === AgentTaskStatuses.Queued
      || pendingMessageCount > 0
      || this.resumeImmediately
      || this.pendingProtocolCorrection(task) !== undefined;
    this.resumeImmediately = false;
    return shouldActivate;
  }

  restoreExecutionState(input: {
    resumeContext: string;
    resumeImmediately: boolean;
  }): void {
    if (!this.activeTask) {
      throw new Error(`Task runner ${this.host.agentId} has no restored task.`);
    }
    if (this.resumeContext) {
      throw new Error(`Task runner ${this.host.agentId} runtime state is already restored.`);
    }
    this.resumeContext = input.resumeContext;
    this.resumeImmediately = input.resumeImmediately;
  }

  snapshot(): TaskRunnerSnapshot {
    return {
      activeTask: this.activeTask ? cloneAgentTaskState(this.activeTask) : undefined,
    };
  }

  /** Source turn associated with the currently prepared protocol-correction Step. */
  currentProtocolCorrectionSourceTurnId(): string | undefined {
    return this.runningProtocolCorrectionSourceTurnId;
  }

  cancelPreparedStep(): void {
    this.runningProtocolCorrectionSourceTurnId = undefined;
  }

  private buildTaskId(taskSequence: number): string {
    return `${this.host.agentId}-task-${String(taskSequence).padStart(4, "0")}`;
  }

  prepareStep(pendingMessages: AgentMessage[]): TaskStepPreparation | undefined {
    const task = this.activeTask;
    if (!task) return undefined;
    const pendingProtocolCorrection = this.pendingProtocolCorrection(task);
    if (
      task.status !== AgentTaskStatuses.Queued
      && pendingMessages.length === 0
      && this.resumeContext === undefined
      && pendingProtocolCorrection === undefined
    ) {
      return undefined;
    }
    const taskId = task.taskId;
    this.ensureOwnedTask(taskId);
    const current = this.getTask(taskId);
    if (
      current.status !== AgentTaskStatuses.Queued
      && current.status !== AgentTaskStatuses.Running
      && current.status !== AgentTaskStatuses.Done
    ) {
      return undefined;
    }
    const initialPrompt = current.startedAt ? undefined : current.initialPrompt;
    if (!current.startedAt && !initialPrompt) {
      throw new Error(`Task ${taskId} has no initial prompt.`);
    }

    const protocolViolation = this.pendingProtocolCorrection(current);
    const isProtocolCorrection = protocolViolation !== undefined;
    const resumeContext = isProtocolCorrection ? undefined : this.resumeContext;
    const messagesToConsume = isProtocolCorrection
      ? []
      : structuredClone(pendingMessages);
    const prompt = attachments.compose(
      agent.turn.use_update_tools(),
      ...(protocolViolation ? [agent.turn.message([
        "运行时协议修正（最后一次机会）。",
        `上一步 ${protocolViolation.stepId} 结束时没有提交生命周期处置。`,
        "不要重复领域工作。请根据本线程已经完成的工作，现在只调用一个生命周期工具：",
        "- 可以提交结果时调用 SubmitTask。",
        "- 必须等待人工确认才能继续时调用 RequestHumanInput。",
        "工具调用成功后结束本 turn。",
      ].join("\n"))] : []),
      ...(resumeContext ? [resumeContext] : []),
      ...(initialPrompt === undefined || isProtocolCorrection ? [] : [
        agent.turn.message([
          "当前任务信息：",
          `- 任务 ID：${current.taskId}`,
          `- Agent 角色：${this.host.role}`,
        ].join("\n")),
        initialPrompt,
      ]),
      ...messagesToConsume.map((message) => message.body),
    );

    const stepId = `${current.taskId}-step-${String(current.stepIds.length + 1).padStart(4, "0")}`;
    this.runningProtocolCorrectionSourceTurnId = protocolViolation?.turnId;
    return {
      taskId,
      stepId,
      prompt,
      messagesToConsume,
      isProtocolCorrection,
      taskStartedAt: current.startedAt ?? new Date().toISOString(),
    };
  }

  recordStepStarted(
    preparation: TaskStepPreparation,
    runningStep: AgentStepState,
  ): AgentTaskState {
    if (runningStep.stepId !== preparation.stepId || runningStep.taskId !== preparation.taskId) {
      throw new Error(`Task preparation ${preparation.stepId} does not match running Step ${runningStep.stepId}.`);
    }
    const task = this.getTask(preparation.taskId);
    const runningState = {
      ...task,
      status: AgentTaskStatuses.Running,
      startedAt: task.startedAt ?? preparation.taskStartedAt,
      protocolRepairAttempts: preparation.isProtocolCorrection
        ? task.protocolRepairAttempts
        : 0,
      stepIds: [...task.stepIds, runningStep.stepId],
      updatedAt: runningStep.startedAt,
    } satisfies AgentTaskState;
    this.eventBus.publish(
      AgentEvents.task.stepStarted,
      runningState,
      { occurredAt: runningState.updatedAt },
    );
    const running = this.updateTask(preparation.taskId, () => runningState);
    this.resumeContext = undefined;
    this.activeTask = running;
    return cloneAgentTaskState(running);
  }

  recordPendingMessagesDrained(taskId: string): void {
    this.eventBus.publish(AgentEvents.task.pendingMessagesDrained, this.getTask(taskId));
  }

  async recordStepFinished(
    preparation: TaskStepPreparation,
    result: TaskStepResult,
  ): Promise<void> {
    this.runningProtocolCorrectionSourceTurnId = undefined;
    const { step, outcome } = result;
    const taskId = preparation.taskId;
    if (step.stepId !== preparation.stepId || step.taskId !== taskId) {
      throw new Error(`Task preparation ${preparation.stepId} does not match finished Step ${step.stepId}.`);
    }

    const latest = this.getTask(taskId);
    if (latest.status === AgentTaskStatuses.Stopped) {
      const stoppedWithUsage = this.updateTask(
        taskId,
        () => this.withStepUsage(latest, outcome, step.durationMs ?? 0),
      );
      this.activeTask = stoppedWithUsage;
      this.publishTaskStepFinished(stoppedWithUsage, step);
      return;
    }
    if (isTerminalTaskStatus(latest.status)) {
      const terminalWithUsage = this.updateTask(
        taskId,
        () => this.withStepUsage(latest, outcome, step.durationMs ?? 0),
      );
      this.activeTask = terminalWithUsage;
      this.publishTaskStepFinished(terminalWithUsage, step);
      return;
    }

    if (outcome.turn.status === "completed") {
      const currentDisposition = this.dispositionForStep(latest, step.stepId);
      const lifecycleDisposition = currentDisposition?.kind === AgentTaskDispositionKinds.ProtocolViolation
        ? undefined
        : currentDisposition;
      if (
        lifecycleDisposition
        && lifecycleDisposition.turnId !== outcome.turn.turnId
      ) {
        throw new Error(
          `Worker task ${taskId} received lifecycle disposition for turn ${lifecycleDisposition.turnId}, not completed turn ${outcome.turn.turnId ?? "<none>"}.`,
        );
      }
      if (!currentDisposition) {
        const unresolvedHumanRequest = currentRunScope().humanInputStore
          .listForTask(taskId)
          .find((request) => !request.response);
        if (unresolvedHumanRequest) {
          const completedState = this.updateTask(taskId, () => this.withStepUsage(
            {
              ...latest,
              protocolRepairAttempts: 0,
            },
            outcome,
            step.durationMs ?? 0,
          ));
          this.activeTask = completedState;
          this.eventBus.publish(
            AgentEvents.task.stepCompleted,
            completedState,
            { occurredAt: completedState.updatedAt },
          );
          return;
        }
        const reason = `${WORKER_DISPOSITION_PROTOCOL_ERROR}: Worker task ${taskId} 的 step ${step.stepId} 结束时未调用 SubmitTask 或 RequestHumanInput。`;
        const violation = {
          kind: AgentTaskDispositionKinds.ProtocolViolation,
          stepId: step.stepId,
          turnId: outcome.turn.turnId ?? outcome.turn.invocationId,
          callId: null,
          timestamp: new Date().toISOString(),
          reason,
        } satisfies AgentTaskDisposition;
        const violationTask = await this.recordProtocolViolation(latest, violation);
        const attempts = (violationTask.protocolRepairAttempts ?? 0) + 1;
        const shouldFail = preparation.isProtocolCorrection || attempts > 1;
        const completedState = this.updateTask(taskId, () => this.withStepUsage(
          {
            ...violationTask,
            protocolRepairAttempts: attempts,
            ...(shouldFail ? {
              status: AgentTaskStatuses.Failed,
              error: reason,
              finishedAt: new Date().toISOString(),
            } : {}),
          },
          outcome,
          step.durationMs ?? 0,
        ));
        this.activeTask = completedState;
        this.eventBus.publish(
          AgentEvents.task.stepCompleted,
          completedState,
          { occurredAt: completedState.updatedAt },
        );
        if (!shouldFail) return;
        this.eventBus.publish(
          AgentEvents.task.failed,
          completedState,
          { occurredAt: completedState.updatedAt },
        );
        this.eventBus.publish(AgentEvents.task.terminal, completedState);
        await this.host.deliverTaskProtocolFailure([
          `Worker task ${taskId} 未通过 Runtime 协议强制检查。`,
          reason,
          "有界修正 turn 结束时仍未提交生命周期处置。",
        ].join("\n"));
        return;
      }

      const completedState = this.updateTask(taskId, () => this.withStepUsage(
        {
          ...latest,
          protocolRepairAttempts: 0,
        },
        outcome,
        step.durationMs ?? 0,
      ));
      this.activeTask = completedState;
      this.eventBus.publish(
        AgentEvents.task.stepCompleted,
        completedState,
        { occurredAt: completedState.updatedAt },
      );
      if (currentDisposition.kind === AgentTaskDispositionKinds.HandoffSubmitted) {
        const doneState = {
          ...completedState,
          status: AgentTaskStatuses.Done,
          updatedAt: new Date().toISOString(),
        } satisfies AgentTaskState;
        const submittedAt = new Date().toISOString();
        this.eventBus.publish(AgentEvents.task.outcomeSubmitted, {
          task: doneState,
          stepId: currentDisposition.stepId,
          turnId: currentDisposition.turnId,
          callId: currentDisposition.callId,
          outcome: currentDisposition.outcome,
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
        await this.host.deliverTaskOutcome(currentDisposition.outcome);
      }
      return;
    }

    if (outcome.turn.status === "interrupted") {
      const interruptedState = this.updateTask(
        taskId,
        () => this.withStepUsage(latest, outcome, step.durationMs ?? 0),
      );
      this.activeTask = interruptedState;
      this.eventBus.publish(
        AgentEvents.task.stepInterrupted,
        interruptedState,
        { occurredAt: interruptedState.updatedAt },
      );
      return;
    }

    const failedState = this.updateTask(taskId, () => this.withStepUsage(
      {
        ...latest,
        status: AgentTaskStatuses.Failed,
        error: outcome.turn.error,
        finishedAt: new Date().toISOString(),
      },
      outcome,
      step.durationMs ?? 0,
    ));
    this.activeTask = failedState;
    this.eventBus.publish(
      AgentEvents.task.failed,
      failedState,
      { occurredAt: failedState.updatedAt },
    );
    this.eventBus.publish(AgentEvents.task.terminal, failedState);
  }

  private publishTaskStepFinished(task: AgentTaskState, step: AgentStepState): void {
    const event = step.status === "interrupted"
      ? AgentEvents.task.stepInterrupted
      : AgentEvents.task.stepCompleted;
    this.eventBus.publish(event, task, { occurredAt: task.updatedAt });
  }

  failActiveTask(error: unknown): void {
    this.runningProtocolCorrectionSourceTurnId = undefined;
    if (
      !this.activeTask
      || this.activeTask.status === AgentTaskStatuses.Done
      || isTerminalTaskStatus(this.activeTask.status)
    ) return;
    const taskId = this.activeTask.taskId;
    const current = this.getTask(taskId);
    const failedAt = new Date().toISOString();
    const failedState = {
      ...current,
      status: AgentTaskStatuses.Failed,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      finishedAt: failedAt,
      updatedAt: failedAt,
    } satisfies AgentTaskState;
    const failed = this.updateTask(taskId, () => failedState);
    this.activeTask = failed;
    this.eventBus.publish(
      AgentEvents.task.failed,
      failed,
      { occurredAt: failed.updatedAt },
    );
    this.eventBus.publish(AgentEvents.task.terminal, failed);
  }

  private withStepUsage(
    task: AgentTaskState,
    outcome: ScoutAgentTurnOutcome,
    durationMs: number,
  ): AgentTaskState {
    return {
      ...task,
      usage: {
        ...task.usage,
        durationMs: (task.usage?.durationMs ?? 0) + durationMs,
        toolUses: (task.usage?.toolUses ?? 0) + (outcome.toolCalls?.length ?? 0),
      },
      updatedAt: outcome.turn.finishedAt,
    };
  }

  private dispositionForStep(
    task: AgentTaskState,
    stepId: string,
  ): AgentTaskDisposition | undefined {
    return task.dispositions.find((disposition) => disposition.stepId === stepId);
  }

  private pendingProtocolCorrection(
    task: AgentTaskState,
  ): Extract<AgentTaskDisposition, { kind: "protocol_violation" }> | undefined {
    if (
      task.status !== AgentTaskStatuses.Running
      || task.protocolRepairAttempts !== 1
    ) return undefined;
    const disposition = task.dispositions.at(-1);
    if (disposition?.kind !== AgentTaskDispositionKinds.ProtocolViolation) return undefined;
    if (!task.stepIds.includes(disposition.stepId)) {
      throw new Error(
        `Worker task ${task.taskId} protocol violation references unknown step ${disposition.stepId}.`,
      );
    }
    return disposition;
  }

  private async recordProtocolViolation(
    task: AgentTaskState,
    disposition: Extract<AgentTaskDisposition, { kind: "protocol_violation" }>,
  ): Promise<AgentTaskState> {
    const recorded = this.store.recordDisposition(task.taskId, disposition);
    this.activeTask = recorded;
    await this.eventBus.publishAndWait(AgentEvents.task.dispositionRecorded, {
      task: recorded,
      disposition,
    }, {
      occurredAt: disposition.timestamp,
    });
    return cloneAgentTaskState(recorded);
  }

  private resolveMessageTarget(taskId: string | undefined): AgentTaskState {
    if (!this.activeTask) {
      throw new Error(`Agent ${this.host.agentId} has no active task for SendMessage.`);
    }
    if (taskId && taskId !== this.activeTask.taskId) {
      throw new Error(`Task runner ${this.host.agentId} owns task ${this.activeTask.taskId}, not ${taskId}.`);
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
      throw new Error(`Task runner ${this.host.agentId} owns task ${this.activeTask?.taskId ?? "<none>"}, not ${taskId}.`);
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

/** Whether a Task status prevents another Worker Step from being scheduled. */
export function isTerminalTaskStatus(status: AgentTaskState["status"]): boolean {
  return status === AgentTaskStatuses.Failed
    || status === AgentTaskStatuses.Stopped;
}
