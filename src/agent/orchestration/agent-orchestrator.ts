import {
  type EventBus,
  EventMailbox,
  type ScoutEvent,
} from "../../core/events/index.js";
import { SystemEvents } from "../../system/events/index.js";
import { AgenticLoop } from "../core/agentic-loop.js";
import type {
  AgentHumanInputRequestedEventPayload,
  AgentHumanInputRespondedEventPayload,
  AgentTaskSystemEvent,
  AgentTaskSystemEventPayload,
} from "../task/task-events.js";
import type { SystemInterruptEventPayload } from "./orchestrator-events.js";

export interface AgentOrchestratorOptions {
  eventBus: EventBus;
}

export interface AgentOrchestratorSnapshot {
  started: boolean;
  stopped: boolean;
  pendingEventCount: number;
}

export class AgentOrchestrator {
  private readonly eventBus: EventBus;
  private readonly mailbox: EventMailbox;
  private readonly loop: AgenticLoop<ScoutEvent[]>;
  private started = false;
  private stopped = false;

  constructor(options: AgentOrchestratorOptions) {
    this.eventBus = options.eventBus;
    this.mailbox = new EventMailbox({
      eventBus: this.eventBus,
      onEvent: () => this.loop.schedule(),
    });
    this.loop = new AgenticLoop<ScoutEvent[]>({
      agentId: "agent-orchestrator",
      handlers: {
        loopKind: "mailbox",
        takeMailboxStep: () => this.mailbox.takeAll(),
        runMailboxStep: (events) => this.runMailboxStep(events),
        isStopped: () => this.stopped,
        onError: (error) => this.handleLoopError(error),
      },
    });
  }

  start(): void {
    if (this.started) return;
    if (this.stopped) {
      throw new Error("Cannot restart a stopped AgentOrchestrator.");
    }
    this.started = true;
    this.mailbox.subscribe<AgentTaskSystemEventPayload>(SystemEvents.task);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.mailbox.stop();
  }

  snapshot(): AgentOrchestratorSnapshot {
    return {
      started: this.started,
      stopped: this.stopped,
      pendingEventCount: this.mailbox.size,
    };
  }

  private async runMailboxStep(events: ScoutEvent[]): Promise<void> {
    for (const event of events) {
      this.handleSystemObservation(event);
    }
  }

  private handleSystemObservation(event: ScoutEvent): void {
    if (!isAgentTaskSystemEvent(event)) {
      return;
    }

    if (SystemEvents.task.humanInputRequested.is(event)) {
      this.handleHumanInputRequested(event as ScoutEvent<AgentHumanInputRequestedEventPayload>);
      return;
    }
    if (SystemEvents.task.humanInputResponded.is(event)) {
      this.handleHumanInputResponded(event as ScoutEvent<AgentHumanInputRespondedEventPayload>);
    }
  }

  private handleHumanInputRequested(
    event: ScoutEvent<AgentHumanInputRequestedEventPayload>,
  ): void {
    const payload = event.payload;
    this.eventBus.publish(SystemEvents.interrupt.raised, {
      interruptKind: "human_input",
      taskId: payload.task.taskId,
      agentId: payload.task.agentId,
      turnId: payload.request.turnId,
      requestId: payload.request.requestId,
    } satisfies SystemInterruptEventPayload);
  }

  private handleHumanInputResponded(
    event: ScoutEvent<AgentHumanInputRespondedEventPayload>,
  ): void {
    const payload = event.payload;
    this.eventBus.publish(SystemEvents.interrupt.resolved, {
      interruptKind: "human_input",
      taskId: payload.task.taskId,
      agentId: payload.task.agentId,
      requestId: payload.response.requestId,
    } satisfies SystemInterruptEventPayload);
  }

  private handleLoopError(error: unknown): void {
    this.eventBus.publish(SystemEvents.system.dispatchRequested, {
      dispatchId: `orchestrator-error-${Date.now()}`,
      reason: "system_error",
      systemMessage: "Agent orchestrator failed while handling system events.",
      createdAt: new Date().toISOString(),
      data: {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
    });
  }
}

function isAgentTaskSystemEvent(event: ScoutEvent): event is AgentTaskSystemEvent {
  return SystemEvents.task.is(event);
}
