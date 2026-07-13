import type { AgentTaskEvent } from "../agent/task/task-events.js";

export type RuntimeDisclosureLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeDisclosureEvent {
  level: RuntimeDisclosureLevel;
  source: string;
  message: string;
  data?: unknown;
}

export interface RuntimeProgressEvent {
  source: string;
  seq?: number;
  agentId?: string;
  taskId?: string;
  threadId?: string;
  turnId?: string;
  itemId: string;
  type: string;
  status: string;
  label: string;
  detail?: string;
  updatedAt: string;
  data?: unknown;
}

export interface AgentMessageSend {
  id: string;
  text: string;
  data?: unknown;
}

export interface AgentMessageReply {
  id: string;
  text: string;
  data?: unknown;
}

export type RuntimeInteractionUnsubscribe = () => void;

export interface RuntimeInteractionPort {
  disclose(event: RuntimeDisclosureEvent): Promise<void>;
  publishProgress(event: RuntimeProgressEvent): Promise<void>;
  publishTaskEvent(event: AgentTaskEvent): Promise<void>;
  notify(event: AgentTaskEvent): Promise<void>;
  receiveAgentMessage(message: AgentMessageReply): Promise<void>;
  sendAgentMessage?(handler: (message: AgentMessageSend) => void | Promise<void>): RuntimeInteractionUnsubscribe;
  onExitRequested?(handler: () => void | Promise<void>): RuntimeInteractionUnsubscribe;
}

export class NoopRuntimeInteractionPort implements RuntimeInteractionPort {
  async disclose(): Promise<void> {
    // no-op
  }

  async publishProgress(): Promise<void> {
    // no-op
  }

  async publishTaskEvent(): Promise<void> {
    // no-op
  }

  async notify(): Promise<void> {
    // no-op
  }

  async receiveAgentMessage(): Promise<void> {
    // no-op
  }

  sendAgentMessage(): RuntimeInteractionUnsubscribe {
    return () => {
      // no-op
    };
  }

  onExitRequested(): RuntimeInteractionUnsubscribe {
    return () => {
      // no-op
    };
  }
}
