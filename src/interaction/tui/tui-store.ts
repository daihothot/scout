import type { AgentTaskEvent } from "../../agent/task/task-events.js";
import type {
  AgentMessageReply,
  AgentMessageSend,
  RuntimeDisclosureEvent,
  RuntimeProgressEvent,
} from "../port.js";

export type TuiLogKind = "disclosure" | "progress" | "task" | "agent" | "input";

export interface TuiLogEntry {
  id: string;
  kind: TuiLogKind;
  text: string;
  level?: string;
  createdAt: string;
}

export interface TuiTaskSummary {
  taskId: string;
  agentId?: string;
  status?: string;
  description?: string;
}

export interface TuiState {
  logs: TuiLogEntry[];
  tasks: TuiTaskSummary[];
  progress: RuntimeProgressEvent[];
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
  private sequence = 0;

  snapshot(): TuiState {
    return {
      logs: [...this.logs],
      tasks: [...this.taskMap.values()],
      progress: [...this.progressMap.values()],
    };
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
    this.progressMap.set(event.itemId, event);
    this.appendLog({
      kind: "progress",
      text: `[${event.status}] ${event.label}${event.detail ? ` - ${event.detail}` : ""}`,
    });
  }

  addTaskEvent(event: AgentTaskEvent): void {
    const task = "task" in event.payload ? event.payload.task : undefined;
    if (task?.taskId) {
      this.taskMap.set(task.taskId, {
        taskId: task.taskId,
        agentId: task.agentId,
        status: task.status,
        description: task.description,
      });
    }
    this.appendLog({
      kind: "task",
      text: `${event.key.routeKey}${task?.taskId ? ` ${task.taskId}` : ""}${task?.status ? ` ${task.status}` : ""}`,
    });
  }

  addAgentMessage(message: string): void {
    this.appendLog({
      kind: "agent",
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
