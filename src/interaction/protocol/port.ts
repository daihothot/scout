import type {
  AgentActivity,
  AgentTurnActivity,
} from "../../agent/activity/activity-event.js";
import type { ScoutEvent } from "../../core/events/index.js";
import type { RunLifecycleSnapshot } from "../../run/lifecycle/run-stage.js";
import type { ScoutAgentRole } from "../../agent/thread/types.js";

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

export interface RestoredUserMessage {
  id: string;
  text: string;
  createdAt: string;
}

export type MountRestoreRoleDecision = "pending" | "reused" | "rebuild" | "failed";
export type MountRestoreStep =
  | "verify"
  | "wipe"
  | "layout"
  | "config"
  | "skills"
  | "plugins"
  | "shell"
  | "preflight";

export interface MountRestoreProgress {
  phase: "verify" | "rebuild" | "done" | "failed";
  activeRole?: ScoutAgentRole;
  activeStep?: MountRestoreStep;
  roles: Array<{
    role: ScoutAgentRole;
    decision: MountRestoreRoleDecision;
    step?: MountRestoreStep;
    reason?: string;
  }>;
  completedUnits: number;
  totalUnits: number;
}

export type RuntimeInteractionUnsubscribe = () => void;

export interface RuntimeInteractionPort {
  publishRunLifecycleSnapshot(snapshot: RunLifecycleSnapshot): Promise<void>;
  publishMountRestoreProgress(progress: MountRestoreProgress): Promise<void>;
  disclose(event: RuntimeDisclosureEvent): Promise<void>;
  publishAgentActivity(activity: AgentActivity): Promise<void>;
  publishAgentTurnActivity(activity: AgentTurnActivity): Promise<void>;
  publishTaskEvent(event: ScoutEvent): Promise<void>;
  receiveAgentMessage(message: AgentMessageReply): Promise<void>;
  restoreUserMessage(message: RestoredUserMessage): Promise<void>;
  sendAgentMessage?(handler: (message: AgentMessageSend) => void | Promise<void>): RuntimeInteractionUnsubscribe;
  onExitRequested?(handler: () => void | Promise<void>): RuntimeInteractionUnsubscribe;
}

export class NoopRuntimeInteractionPort implements RuntimeInteractionPort {
  async publishRunLifecycleSnapshot(): Promise<void> {
    // no-op
  }

  async publishMountRestoreProgress(_progress: MountRestoreProgress): Promise<void> {
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

  async restoreUserMessage(): Promise<void> {
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
