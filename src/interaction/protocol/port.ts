import type {
  AgentActivity,
  AgentTurnActivity,
} from "../../agent/activity/activity-event.js";
import type { AgentTaskState } from "../../agent/task/types.js";
import type { AgentStepState } from "../../agent/step/types.js";
import type { ScoutEvent } from "../../core/events/index.js";
import type { RunLifecycleSnapshot } from "../../run/lifecycle/run-stage.js";

/** Severity used when an operation discloses a runtime status or failure. */
export type RuntimeDisclosureLevel = "debug" | "info" | "warn" | "error";

/** Structured disclosure supplied by an operation; the interaction adapter chooses presentation. */
export interface RuntimeDisclosureEvent {
  level: RuntimeDisclosureLevel;
  source: string;
  message: string;
  data?: unknown;
}

/** User-facing message entering the runtime through an interaction adapter. */
export interface AgentMessageSend {
  id: string;
  text: string;
  data?: unknown;
}

/** Agent/coordinator message delivered back to the interaction surface. */
export interface AgentMessageReply {
  id: string;
  text: string;
  data?: unknown;
}

/** Historical user message restored into the interaction view. */
export interface RestoredUserMessage {
  id: string;
  text: string;
  createdAt: string;
}

/** Lifecycle states exposed by a long-running subprocess operation. */
export type SubprocessProgressPhase = "running" | "done" | "failed";
/** Rendering tone requested by the operation for a subprocess status. */
export type SubprocessProgressTone = "active" | "success" | "failed" | "neutral";

/** Text and marker supplied by the operation; the TUI only renders it. */
export interface SubprocessProgressText {
  marker?: string;
  label: string;
  detail?: string;
  units?: string;
  tone?: SubprocessProgressTone;
}

/** Presentation descriptor for the status line and optional progress track. */
export interface SubprocessProgressDescriptor {
  status: SubprocessProgressText;
  progress?: SubprocessProgressText;
}

/** Snapshot consumed by interaction adapters while one subprocess operation advances. */
export interface SubprocessProgressSnapshot {
  id: string;
  phase: SubprocessProgressPhase;
  completedUnits: number;
  totalUnits: number;
  descriptor: SubprocessProgressDescriptor;
}

/** Detaches an interaction callback registered with the runtime port. */
export type RuntimeInteractionUnsubscribe = () => void;

/** Runtime-to-interaction boundary; implementations may render, persist, or intentionally ignore facts. */
export interface RuntimeInteractionPort {
  publishRunLifecycleSnapshot(snapshot: RunLifecycleSnapshot): Promise<void>;
  publishSubprocessProgress(progress: SubprocessProgressSnapshot): Promise<void>;
  disclose(event: RuntimeDisclosureEvent): Promise<void>;
  publishAgentActivity(activity: AgentActivity): Promise<void>;
  publishAgentTurnActivity(activity: AgentTurnActivity): Promise<void>;
  publishTaskEvent(event: ScoutEvent): Promise<void>;
  publishStepEvent?(event: ScoutEvent): Promise<void>;
  restoreTaskSnapshot(task: AgentTaskState): Promise<void>;
  restoreStepSnapshot?(step: AgentStepState): Promise<void>;
  receiveAgentMessage(message: AgentMessageReply): Promise<void>;
  restoreUserMessage(message: RestoredUserMessage): Promise<void>;
  sendAgentMessage?(handler: (message: AgentMessageSend) => void | Promise<void>): RuntimeInteractionUnsubscribe;
  onExitRequested?(handler: () => void | Promise<void>): RuntimeInteractionUnsubscribe;
}

/** No-op port used by non-interactive runs while preserving the runtime contract. */
export class NoopRuntimeInteractionPort implements RuntimeInteractionPort {
  async publishRunLifecycleSnapshot(): Promise<void> {
    // no-op
  }

  async publishSubprocessProgress(_progress: SubprocessProgressSnapshot): Promise<void> {
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

  async publishStepEvent(): Promise<void> {
    // no-op
  }

  async restoreTaskSnapshot(): Promise<void> {
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
