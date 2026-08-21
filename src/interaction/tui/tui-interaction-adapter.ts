import type { ScoutEvent } from "../../core/events/index.js";
import type {
  AgentMessageReply,
  AgentMessageSend,
  RuntimeDisclosureEvent,
  RestoredUserMessage,
  RuntimeInteractionPort,
  RuntimeInteractionUnsubscribe,
} from "../protocol/port.js";
import type {
  AgentActivity,
  AgentTurnActivity,
} from "../../agent/activity/activity-event.js";
import type { AgentTaskState } from "../../agent/task/types.js";
import type { AgentStepState } from "../../agent/step/types.js";
import type { RunLifecycleSnapshot } from "../../run/lifecycle/run-stage.js";
import type { SubprocessProgressSnapshot } from "../protocol/port.js";
import type { TuiStore } from "./tui-store.js";

/** Bridges runtime interaction events and commands into the TUI store. */
export class TuiInteractionAdapter implements RuntimeInteractionPort {
  constructor(private readonly store: TuiStore) {}

  async publishRunLifecycleSnapshot(snapshot: RunLifecycleSnapshot): Promise<void> {
    this.store.setRunLifecycleSnapshot(snapshot);
  }

  async publishSubprocessProgress(progress: SubprocessProgressSnapshot): Promise<void> {
    this.store.setSubprocessProgress(progress);
  }

  async disclose(event: RuntimeDisclosureEvent): Promise<void> {
    this.store.addDisclosure(event);
  }

  async publishAgentActivity(activity: AgentActivity): Promise<void> {
    this.store.addAgentActivity(activity);
  }

  async publishAgentTurnActivity(activity: AgentTurnActivity): Promise<void> {
    this.store.addAgentTurnActivity(activity);
  }

  async publishTaskEvent(event: ScoutEvent): Promise<void> {
    this.store.addTaskEvent(event);
  }

  async publishStepEvent(event: ScoutEvent): Promise<void> {
    this.store.addStepEvent(event);
  }

  async restoreTaskSnapshot(task: AgentTaskState): Promise<void> {
    this.store.restoreTaskSnapshot(task);
  }

  async restoreStepSnapshot(step: AgentStepState): Promise<void> {
    this.store.restoreStepSnapshot(step);
  }

  async receiveAgentMessage(message: AgentMessageReply): Promise<void> {
    this.store.receiveAgentMessage(message);
  }

  async restoreUserMessage(message: RestoredUserMessage): Promise<void> {
    this.store.restoreUserMessage(message);
  }

  sendAgentMessage(handler: (message: AgentMessageSend) => void | Promise<void>): RuntimeInteractionUnsubscribe {
    return this.store.sendAgentMessage(handler);
  }

  onExitRequested(handler: () => void | Promise<void>): RuntimeInteractionUnsubscribe {
    return this.store.onExit(handler);
  }
}
