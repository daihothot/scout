import type { ScoutEvent } from "../../core/events/index.js";
import type {
  AgentMessageReply,
  AgentMessageSend,
  RuntimeDisclosureEvent,
  RuntimeInteractionPort,
  RuntimeInteractionUnsubscribe,
} from "../protocol/port.js";
import type { AgentActivity } from "../../agent/activity/activity-event.js";
import type { BootSnapshot } from "../../run/boot/boot-stage.js";
import type { TuiStore } from "./tui-store.js";

export class TuiInteractionAdapter implements RuntimeInteractionPort {
  constructor(private readonly store: TuiStore) {}

  async publishBootSnapshot(snapshot: BootSnapshot): Promise<void> {
    this.store.setBootSnapshot(snapshot);
  }

  async disclose(event: RuntimeDisclosureEvent): Promise<void> {
    this.store.addDisclosure(event);
  }

  async publishAgentActivity(activity: AgentActivity): Promise<void> {
    this.store.addAgentActivity(activity);
  }

  async publishTaskEvent(event: ScoutEvent): Promise<void> {
    this.store.addTaskEvent(event);
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
