import type { AgentTaskEvent } from "../../agent/task/task-events.js";
import type {
  AgentMessageReply,
  AgentMessageSend,
  RuntimeDisclosureEvent,
  RuntimeInteractionPort,
  RuntimeInteractionUnsubscribe,
  RuntimeProgressEvent,
} from "../port.js";
import type { TuiStore } from "./tui-store.js";

export class TuiInteractionAdapter implements RuntimeInteractionPort {
  constructor(private readonly store: TuiStore) {}

  async disclose(event: RuntimeDisclosureEvent): Promise<void> {
    this.store.addDisclosure(event);
  }

  async publishProgress(event: RuntimeProgressEvent): Promise<void> {
    this.store.addProgress(event);
  }

  async publishTaskEvent(event: AgentTaskEvent): Promise<void> {
    this.store.addTaskEvent(event);
  }

  async notify(): Promise<void> {
    // Task notifications are already represented by the lifecycle projection.
  }

  async receiveAgentMessage(message: AgentMessageReply): Promise<void> {
    this.store.receiveAgentMessage(message);
  }

  sendAgentMessage(handler: (message: AgentMessageSend) => void | Promise<void>): RuntimeInteractionUnsubscribe {
    return this.store.sendAgentMessage(handler);
  }

  onExitRequested(handler: () => void | Promise<void>): RuntimeInteractionUnsubscribe {
    return this.store.onExit(handler);
  }
}
