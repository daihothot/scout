import { AgentEvents } from "../../agent/events/index.js";
import type { AgentTaskState } from "../../agent/task/types.js";
import type { AgentActivity } from "../../agent/activity/activity-event.js";
import type { ScoutEvent } from "../../core/events/index.js";
import type { BootSnapshot } from "../../run/boot/boot-stage.js";
import type {
  AgentMessageReply,
  AgentMessageSend,
  RuntimeDisclosureEvent,
} from "../protocol/port.js";

export type TuiLogKind = "disclosure" | "agent" | "input";

export interface TuiLogEntry {
  id: string;
  kind: TuiLogKind;
  text: string;
  level?: string;
  agentId?: string;
  createdAt: string;
}

export interface TuiTaskSummary {
  taskId: string;
  taskSequence: number;
  agentId?: string;
  role?: string;
  status?: string;
  description?: string;
  updatedAt: string;
  planSteps: TuiTaskPlanStep[];
}

export interface TuiTaskPlanStep {
  step: string;
  status: string;
}

export type TuiRunStatus = "preparing" | "ready" | "failed" | "stopping";

export interface TuiRuntimeInfo {
  cwd: string;
  version: string;
  model: string;
  reasoningEffort: string;
  runId?: string;
  status: TuiRunStatus;
}

export interface TuiState {
  runtime: TuiRuntimeInfo;
  boot?: BootSnapshot;
  logs: TuiLogEntry[];
  tasks: TuiTaskSummary[];
  activities: AgentActivity[];
}

export interface TuiStoreOptions {
  cwd: string;
  version: string;
  model: string;
  reasoningEffort: string;
}

type TuiStoreListener = (state: TuiState) => void;
type TuiExitListener = () => void | Promise<void>;
type TuiAgentMessageListener = (message: AgentMessageSend) => void | Promise<void>;

export class TuiStore {
  private readonly listeners = new Set<TuiStoreListener>();
  private readonly exitListeners = new Set<TuiExitListener>();
  private readonly agentMessageListeners = new Set<TuiAgentMessageListener>();
  private readonly taskMap = new Map<string, TuiTaskSummary>();
  private readonly activityMap = new Map<string, AgentActivity>();
  private readonly logs: TuiLogEntry[] = [];
  private boot?: BootSnapshot;
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
      boot: this.boot ? cloneBootSnapshot(this.boot) : undefined,
      logs: [...this.logs],
      tasks: [...this.taskMap.values()],
      activities: [...this.activityMap.values()],
    };
  }

  setRun(input: {
    runId?: string;
    status: TuiRunStatus;
  }): void {
    this.runtime = {
      ...this.runtime,
      runId: input.runId ?? this.runtime.runId,
      status: input.status,
    };
    this.emit();
  }

  setBootSnapshot(snapshot: BootSnapshot): void {
    this.boot = cloneBootSnapshot(snapshot);
    this.runtime = {
      ...this.runtime,
      runId: snapshot.runId,
      status: tuiStatusForBoot(snapshot),
    };
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

  addTaskEvent(event: ScoutEvent): void {
    if (AgentEvents.task.notAssigned.is(event)) return;
    const task = event.payload as AgentTaskState;
    if (AgentEvents.task.archived.is(event)) {
      this.taskMap.delete(task.taskId);
      this.emit();
      return;
    }
    if (!this.taskMap.has(task.taskId) && !AgentEvents.task.assigned.is(event)) return;
    this.taskMap.set(task.taskId, {
      taskId: task.taskId,
      taskSequence: task.taskSequence,
      agentId: task.agentId,
      role: task.role,
      status: task.status,
      description: task.description,
      updatedAt: task.updatedAt,
      planSteps: (task.plan?.steps ?? []).map((step) => ({
        step: step.step,
        status: step.status,
      })),
    });
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

  submitInput(text: string): void {
    if (this.runtime.status !== "ready") return;
    const message = text.trim();
    if (message.length === 0) {
      this.appendLog({
        kind: "input",
        text: "User input ignored: empty message.",
      });
      return;
    }
    this.appendLog({
      kind: "input",
      text: `User: ${message}`,
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

function activityKey(activity: AgentActivity): string {
  return `${activity.agentId}:${activity.taskId ?? "no-task"}:${activity.itemId}`;
}

function tuiStatusForBoot(snapshot: BootSnapshot): TuiRunStatus {
  if (snapshot.status === "ready") return "ready";
  if (snapshot.status === "failed") return "failed";
  if (snapshot.status === "terminating" || snapshot.status === "terminated") return "stopping";
  return "preparing";
}

function cloneBootSnapshot(snapshot: BootSnapshot): BootSnapshot {
  return {
    ...snapshot,
    stages: snapshot.stages.map((stage) => ({ ...stage })),
  };
}
