import type { AgentTaskEvent } from "../../agent/task/task-events.js";
import type {
  AgentMessageReply,
  AgentMessageSend,
  RuntimeDisclosureEvent,
  RuntimeProgressEvent,
} from "../port.js";

export type TuiLogKind = "disclosure" | "task" | "agent" | "input";

export interface TuiLogEntry {
  id: string;
  kind: TuiLogKind;
  text: string;
  level?: string;
  agentId?: string;
  taskId?: string;
  createdAt: string;
}

export interface TuiTaskSummary {
  taskId: string;
  agentId?: string;
  role?: string;
  status?: string;
  description?: string;
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
  logs: TuiLogEntry[];
  tasks: TuiTaskSummary[];
  progress: RuntimeProgressEvent[];
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
  private readonly progressMap = new Map<string, RuntimeProgressEvent>();
  private readonly logs: TuiLogEntry[] = [];
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
      logs: [...this.logs],
      tasks: [...this.taskMap.values()],
      progress: [...this.progressMap.values()],
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

  addProgress(event: RuntimeProgressEvent): void {
    this.progressMap.set(progressKey(event), event);
    this.emit();
  }

  addTaskEvent(event: AgentTaskEvent): void {
    const task = "task" in event.payload ? event.payload.task : undefined;
    if (task?.taskId) {
      this.taskMap.set(task.taskId, {
        taskId: task.taskId,
        agentId: task.agentId,
        role: task.role,
        status: task.status,
        description: task.description,
      });
    }
    this.appendLog({
      kind: "task",
      agentId: task?.agentId,
      taskId: task?.taskId,
      text: `${event.key.routeKey}${task?.taskId ? ` ${task.taskId}` : ""}${task?.status ? ` ${task.status}` : ""}`,
    });
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

function progressKey(event: RuntimeProgressEvent): string {
  return `${event.agentId ?? "runtime"}:${event.itemId}`;
}
