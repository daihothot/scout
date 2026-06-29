import type { RuntimeQueuedCommand } from "../core/queue/message-queue.js";

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

export interface HumanInputRequest {
  id: string;
  prompt: string;
  reason?: string;
  defaultValue?: string;
}

export interface HumanInputResponse {
  requestId: string;
  text: string;
}

export interface RuntimeInteractionPort {
  disclose(event: RuntimeDisclosureEvent): Promise<void>;
  publishProgress(event: RuntimeProgressEvent): Promise<void>;
  notify(command: RuntimeQueuedCommand): Promise<void>;
  requestInput(request: HumanInputRequest): Promise<HumanInputResponse>;
}

export class NoopRuntimeInteractionPort implements RuntimeInteractionPort {
  async disclose(): Promise<void> {
    // no-op
  }

  async publishProgress(): Promise<void> {
    // no-op
  }

  async notify(): Promise<void> {
    // no-op
  }

  async requestInput(request: HumanInputRequest): Promise<HumanInputResponse> {
    return {
      requestId: request.id,
      text: request.defaultValue ?? "",
    };
  }
}
