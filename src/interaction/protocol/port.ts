import type {
  AgentActivity,
  AgentTurnActivity,
} from "../../agent/activity/activity-event.js";
import type { ScoutEvent } from "../../core/events/index.js";
import type { BootSnapshot } from "../../run/boot/boot-stage.js";

export type RuntimeDisclosureLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeDisclosureEvent {
  level: RuntimeDisclosureLevel;
  source: string;
  message: string;
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
  publishBootSnapshot(snapshot: BootSnapshot): Promise<void>;
  disclose(event: RuntimeDisclosureEvent): Promise<void>;
  publishAgentActivity(activity: AgentActivity): Promise<void>;
  publishAgentTurnActivity(activity: AgentTurnActivity): Promise<void>;
  publishTaskEvent(event: ScoutEvent): Promise<void>;
  receiveAgentMessage(message: AgentMessageReply): Promise<void>;
  sendAgentMessage?(handler: (message: AgentMessageSend) => void | Promise<void>): RuntimeInteractionUnsubscribe;
  onExitRequested?(handler: () => void | Promise<void>): RuntimeInteractionUnsubscribe;
}

export class NoopRuntimeInteractionPort implements RuntimeInteractionPort {
  async publishBootSnapshot(): Promise<void> {
    // no-op
  }

  async disclose(): Promise<void> {
    // no-op
  }

  async publishAgentActivity(): Promise<void> {
    // no-op
  }

  async publishAgentTurnActivity(): Promise<void> {
    // no-op
  }

  async publishTaskEvent(): Promise<void> {
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
