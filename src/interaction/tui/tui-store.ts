import { AgentEvents } from "../../agent/events/index.js";
import type { AgentTaskNotAssignedEventPayload } from "../../agent/task/task-events.js";
import type { AgentTaskState } from "../../agent/task/types.js";
import type { AgentStepState } from "../../agent/step/types.js";
import type {
  AgentActivity,
  AgentTurnActivity,
} from "../../agent/activity/activity-event.js";
import type { ScoutEvent } from "../../core/events/index.js";
import type { RunLifecycleSnapshot } from "../../run/lifecycle/run-stage.js";
import type {
  AgentMessageReply,
  AgentMessageSend,
  RuntimeDisclosureEvent,
  SubprocessProgressSnapshot,
} from "../protocol/port.js";
export type {
  SubprocessProgressDescriptor,
  SubprocessProgressPhase,
  SubprocessProgressSnapshot,
  SubprocessProgressText,
  SubprocessProgressTone,
} from "../protocol/port.js";

/** Categories used when a runtime disclosure is rendered in the activity log. */
export type TuiLogKind = "disclosure" | "agent" | "input" | "system";

/** Immutable display record for one disclosure or activity log entry. */
export interface TuiLogEntry {
  id: string;
  kind: TuiLogKind;
  text: string;
  level?: string;
  agentId?: string;
  createdAt: string;
}

/** Reduced task state consumed by the drawer and task selectors. */
export interface TuiTaskSummary {
  taskId: string;
  taskSequence: number;
  agentId?: string;
  role?: string;
  status?: string;
  description?: string;
  updatedAt: string;
  turns: TuiTaskTurn[];
}

/** Display-level plan step retained inside a task summary. */
export interface TuiTaskPlanStep {
  step: string;
  status: string;
}

/** Display-level plan and lifecycle state for one task turn. */
export interface TuiTaskTurn {
  turnId?: string;
  status?: string;
  planSteps: TuiTaskPlanStep[];
}

/** Terminal-facing status of the current run. */
export type TuiRunStatus = "preparing" | "ready" | "failed" | "stopping";

/** Static runtime identity shown in the top chrome. */
export interface TuiRuntimeInfo {
  cwd: string;
  version: string;
  model: string;
  reasoningEffort: string;
  runId?: string;
  status: TuiRunStatus;
}

/** Snapshot consumed by the TUI render tree. */
export interface TuiState {
  runtime: TuiRuntimeInfo;
  lifecycle?: RunLifecycleSnapshot;
  subprocessProgress?: SubprocessProgressSnapshot;
  logs: TuiLogEntry[];
  tasks: TuiTaskSummary[];
  steps?: AgentStepState[];
  activities: AgentActivity[];
  turnActivities: AgentTurnActivity[];
}

/** Construction inputs for the store's stable runtime identity. */
export interface TuiStoreOptions {
  cwd: string;
  version: string;
  model: string;
  reasoningEffort: string;
}

type TuiStoreListener = (state: TuiState) => void;
type TuiExitListener = () => void | Promise<void>;
type TuiAgentMessageListener = (message: AgentMessageSend) => void | Promise<void>;

/** Owns the mutable TUI projection and notifies subscribers after each update. */
export class TuiStore {
  private readonly listeners = new Set<TuiStoreListener>();
  private readonly exitListeners = new Set<TuiExitListener>();
  private readonly agentMessageListeners = new Set<TuiAgentMessageListener>();
  private readonly taskMap = new Map<string, TuiTaskSummary>();
  private readonly stepMap = new Map<string, AgentStepState>();
  private readonly activityMap = new Map<string, AgentActivity>();
  private readonly turnActivityMap = new Map<string, AgentTurnActivity>();
  private readonly logs: TuiLogEntry[] = [];
  private lifecycle?: RunLifecycleSnapshot;
  private subprocessProgress?: SubprocessProgressSnapshot;
  private runtime: TuiRuntimeInfo;
  private sequence = 0;

  constructor(options: TuiStoreOptions) {
    this.runtime = {
      cwd: options.cwd,
      version: options.version,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      status: "preparing",
    };
  }

  snapshot(): TuiState {
    return {
      runtime: { ...this.runtime },
      lifecycle: this.lifecycle
        ? cloneRunLifecycleSnapshot(this.lifecycle)
        : undefined,
      subprocessProgress: this.subprocessProgress
        ? cloneSubprocessProgress(this.subprocessProgress)
        : undefined,
      logs: [...this.logs],
      tasks: [...this.taskMap.values()],
      steps: [...this.stepMap.values()].map((step) => structuredClone(step)),
      activities: [...this.activityMap.values()],
      turnActivities: [...this.turnActivityMap.values()],
    };
  }

  setRun(input: {
    runId?: string;
    status: TuiRunStatus;
  }): void {
    const runChanged = input.runId !== undefined
      && input.runId !== this.runtime.runId;
    const preserveSubprocessFailure = !runChanged && this.subprocessProgress?.phase === "failed";
    if (
      runChanged
      || input.status === "ready"
      || input.status === "stopping"
      || (input.status === "failed" && !preserveSubprocessFailure)
    ) {
      this.subprocessProgress = undefined;
    }
    this.runtime = {
      ...this.runtime,
      runId: input.runId ?? this.runtime.runId,
      status: input.status,
    };
    this.emit();
  }

  setRunLifecycleSnapshot(snapshot: RunLifecycleSnapshot): void {
    const preserveSubprocessFailure = this.subprocessProgress?.phase === "failed";
    const discardNonFailureSubprocessState = snapshot.status === "ready"
      || snapshot.status === "terminating"
      || snapshot.status === "terminated"
      || (snapshot.status === "failed" && !preserveSubprocessFailure);
    if (
      (this.runtime.runId && this.runtime.runId !== snapshot.runId)
      || discardNonFailureSubprocessState
    ) {
      this.subprocessProgress = undefined;
    }
    this.lifecycle = cloneRunLifecycleSnapshot(snapshot);
    this.runtime = {
      ...this.runtime,
      runId: snapshot.runId,
      status: tuiStatusForRunLifecycle(snapshot),
    };
    this.emit();
  }

  setSubprocessProgress(progress: SubprocessProgressSnapshot): void {
    this.subprocessProgress = cloneSubprocessProgress(progress);
    this.emit();
  }

  clearSubprocessProgress(): void {
    if (!this.subprocessProgress) return;
    this.subprocessProgress = undefined;
    this.emit();
  }

  subscribe(listener: TuiStoreListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  onExit(listener: TuiExitListener): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  async requestExit(): Promise<void> {
    this.setRun({ status: "stopping" });
    for (const listener of this.exitListeners) {
      await listener();
    }
  }

  sendAgentMessage(listener: TuiAgentMessageListener): () => void {
    this.agentMessageListeners.add(listener);
    return () => {
      this.agentMessageListeners.delete(listener);
    };
  }

  addDisclosure(event: RuntimeDisclosureEvent): void {
    this.appendLog({
      kind: "disclosure",
      level: event.level,
      text: `[${event.source}] ${event.message}`,
    });
  }

  addAgentActivity(activity: AgentActivity): void {
    if (activity.type === "dynamicToolCall") return;
    this.activityMap.set(activityKey(activity), activity);
    this.emit();
  }

  addAgentTurnActivity(activity: AgentTurnActivity): void {
    this.turnActivityMap.set(turnActivityKey(activity), activity);
    this.emit();
  }

  addTaskEvent(event: ScoutEvent): void {
    if (AgentEvents.task.notAssigned.is(event)) {
      const rejection = event.payload as AgentTaskNotAssignedEventPayload;
      this.appendLog({
        kind: "system",
        text: `任务未指派：${rejection.requestedDescription}。当前任务：${rejection.activeTaskId}。原因：${rejection.reason}`,
      });
      return;
    }
    const task = AgentEvents.task.dispositionRecorded.is(event)
      ? event.payload.task
      : event.payload as AgentTaskState;
    let systemText: string | undefined;
    const archived = AgentEvents.task.archived.is(event);
    const existing = this.taskMap.get(task.taskId);
    if (
      !existing
      && !AgentEvents.task.assigned.is(event)
      && !archived
    ) return;
    this.taskMap.set(task.taskId, projectTaskSummary(
      task,
      existing,
      archived ? "archived" : task.status,
      archived ? event.occurredAt : task.updatedAt,
      task.stepIds.flatMap((stepId) => {
        const step = this.stepMap.get(stepId);
        return step ? [step] : [];
      }),
    ));
    if (archived) {
      systemText = `任务 ${task.taskId} 已归档。`;
    } else if (AgentEvents.task.assigned.is(event)) {
      systemText = `任务 ${task.taskId} 已指派给 ${task.role}。`;
    } else if (AgentEvents.task.done.is(event)) {
      systemText = `任务 ${task.taskId} 已交回本轮结果，等待 Coordinator 后续处理。`;
    } else if (AgentEvents.task.failed.is(event)) {
      systemText = `任务 ${task.taskId} 执行失败。`;
    } else if (AgentEvents.task.stopped.is(event)) {
      systemText = `任务 ${task.taskId} 已停止。`;
    } else if (
      AgentEvents.task.dispositionRecorded.is(event)
      && event.payload.disposition.kind === "waiting_for_human"
    ) {
      systemText = `任务 ${task.taskId} 已请求人工确认。`;
    }
    if (systemText) {
      this.appendLog({ kind: "system", text: systemText });
      return;
    }
    this.emit();
  }

  addStepEvent(event: ScoutEvent): void {
    if (!(
      AgentEvents.step.started.is(event)
      || AgentEvents.step.completed.is(event)
      || AgentEvents.step.interrupted.is(event)
      || AgentEvents.step.failed.is(event)
      || AgentEvents.step.planUpdated.is(event)
    )) return;
    const step = event.payload as AgentStepState;
    this.stepMap.set(step.stepId, structuredClone(step));
    if (step.taskId) {
      const task = this.taskMap.get(step.taskId);
      if (task) this.taskMap.set(step.taskId, mergeStepIntoTaskSummary(task, step));
    }
    this.emit();
  }

  restoreStepSnapshot(step: AgentStepState): void {
    this.stepMap.set(step.stepId, structuredClone(step));
    this.emit();
  }

  /** Rebuilds a task projection from the complete durable snapshot during resume. */
  restoreTaskSnapshot(task: AgentTaskState): void {
    this.taskMap.set(task.taskId, projectTaskSummary(
      task,
      this.taskMap.get(task.taskId),
      task.status,
      task.updatedAt,
      task.stepIds.flatMap((stepId) => {
        const step = this.stepMap.get(stepId);
        return step ? [step] : [];
      }),
    ));
    this.emit();
  }

  addAgentMessage(message: string): void {
    this.appendLog({
      kind: "agent",
      agentId: "coordinator",
      text: message,
    });
  }

  receiveAgentMessage(message: AgentMessageReply): void {
    this.addAgentMessage(message.text);
  }

  restoreUserMessage(message: { id: string; text: string; createdAt: string }): void {
    this.sequence += 1;
    this.logs.push({
      id: `log-${this.sequence}`,
      kind: "input",
      text: message.text,
      createdAt: message.createdAt,
    });
    this.emit();
  }

  submitInput(text: string): void {
    if (this.runtime.status !== "ready") return;
    const message = text.trim();
    if (message.length === 0) {
      this.appendLog({
        kind: "system",
        text: "已忽略空消息。",
      });
      return;
    }
    this.appendLog({
      kind: "input",
      text: message,
    });
    const response = {
      id: `user-message-${Date.now()}`,
      text: message,
    } satisfies AgentMessageSend;
    for (const listener of this.agentMessageListeners) {
      void listener(response);
    }
  }

  private appendLog(input: Omit<TuiLogEntry, "id" | "createdAt">): void {
    this.sequence += 1;
    this.logs.push({
      id: `log-${this.sequence}`,
      createdAt: new Date().toISOString(),
      ...input,
    });
    if (this.logs.length > 80) {
      this.logs.splice(0, this.logs.length - 80);
    }
    this.emit();
  }

  private emit(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function projectTaskSummary(
  task: AgentTaskState,
  existing: TuiTaskSummary | undefined,
  status: string,
  updatedAt: string,
  taskSteps: AgentStepState[],
): TuiTaskSummary {
  const turns = mergeTaskTurns(existing?.turns ?? [], taskSteps);
  return {
    taskId: task.taskId,
    taskSequence: task.taskSequence,
    agentId: task.agentId,
    role: task.role,
    status,
    description: task.description,
    updatedAt,
    turns,
  };
}

function mergeTaskTurns(
  existing: TuiTaskTurn[],
  taskSteps: AgentStepState[],
): TuiTaskTurn[] {
  const lifecycleByTurn = new Map<string | undefined, AgentStepState>();
  for (const step of taskSteps) lifecycleByTurn.set(step.turnId, step);
  const turns = existing.map((turn) => {
    const lifecycle = lifecycleByTurn.get(turn.turnId);
    const planSteps = lifecycle?.plan?.steps.map((planStep) => ({
      step: planStep.step,
      status: planStep.status,
    }));
    return {
      ...turn,
      ...(lifecycle ? { status: lifecycle.status } : {}),
      planSteps: planSteps ?? turn.planSteps.map((step) => ({ ...step })),
    };
  });
  const knownTurnIds = new Set(turns.map((turn) => turn.turnId));
  for (const step of taskSteps) {
    if (knownTurnIds.has(step.turnId)) continue;
    turns.push({
      turnId: step.turnId,
      status: step.status,
      planSteps: step.plan?.steps.map((planStep) => ({
        step: planStep.step,
        status: planStep.status,
      })) ?? [],
    });
    knownTurnIds.add(step.turnId);
  }
  return turns;
}

function mergeStepIntoTaskSummary(task: TuiTaskSummary, step: AgentStepState): TuiTaskSummary {
  const turns = task.turns.map((turn) => ({
    ...turn,
    planSteps: turn.planSteps.map((planStep) => ({ ...planStep })),
  }));
  const turnIndex = turns.findIndex((turn) => turn.turnId === step.turnId);
  const planSteps = step.plan?.steps.map((planStep) => ({
    step: planStep.step,
    status: planStep.status,
  })) ?? [];
  const turn = {
    turnId: step.turnId,
    status: step.status,
    planSteps,
  } satisfies TuiTaskTurn;
  if (turnIndex < 0) turns.push(turn);
  else turns[turnIndex] = {
    ...turns[turnIndex],
    ...turn,
    planSteps: planSteps.length > 0 ? planSteps : turns[turnIndex]?.planSteps ?? [],
  };
  return {
    ...task,
    updatedAt: step.updatedAt,
    turns,
  };
}

function activityKey(activity: AgentActivity): string {
  return `${activity.agentId}:${activity.taskId ?? "no-task"}:${activity.itemId}`;
}

function turnActivityKey(activity: AgentTurnActivity): string {
  return `${activity.agentId}:${activity.threadId}:${activity.turnId}`;
}

function tuiStatusForRunLifecycle(snapshot: RunLifecycleSnapshot): TuiRunStatus {
  if (snapshot.status === "ready") return "ready";
  if (snapshot.status === "failed") return "failed";
  if (snapshot.status === "terminating" || snapshot.status === "terminated") return "stopping";
  return "preparing";
}

function cloneRunLifecycleSnapshot(
  snapshot: RunLifecycleSnapshot,
): RunLifecycleSnapshot {
  return {
    ...snapshot,
    stages: snapshot.stages.map((stage) => ({ ...stage })),
  };
}

function cloneSubprocessProgress(
  progress: SubprocessProgressSnapshot,
): SubprocessProgressSnapshot {
  return {
    ...progress,
    descriptor: {
      status: { ...progress.descriptor.status },
      progress: progress.descriptor.progress
        ? { ...progress.descriptor.progress }
        : undefined,
    },
  };
}
