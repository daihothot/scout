import {
  type EventBus,
  type ScoutEvent,
} from "../../core/events/index.js";
import { AgentEvents } from "../events/index.js";
import { AgentInbox } from "../core/agent-inbox.js";
import type {
  AgentHumanInputRequestedEventPayload,
  AgentHumanInputRespondedEventPayload,
  AgentTaskEvent,
  AgentTaskEventPayloadVariant,
} from "../task/task-events.js";
import type { AgentInterruptEventPayload } from "./orchestrator-events.js";
import { coordinator } from "../runner/coordinator/coordinator-attachments.js";

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
  private readonly inbox: AgentInbox;
  private started = false;
  private stopped = false;

  constructor(options: AgentOrchestratorOptions) {
    this.eventBus = options.eventBus;
    this.inbox = new AgentInbox({
      eventBus: this.eventBus,
      isStopped: () => this.stopped,
      onEvents: (events) => this.handleInboxEvents(events),
      onError: (error) => this.handleLoopError(error),
    });
  }

  start(): void {
    if (this.started) return;
    if (this.stopped) {
      throw new Error("Cannot restart a stopped AgentOrchestrator.");
    }
    this.started = true;
    this.inbox.subscribe<AgentTaskEventPayloadVariant>(AgentEvents.task);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.inbox.stop();
  }

  snapshot(): AgentOrchestratorSnapshot {
    return {
      started: this.started,
      stopped: this.stopped,
      pendingEventCount: this.inbox.size,
    };
  }

  private async handleInboxEvents(events: ScoutEvent[]): Promise<void> {
    for (const event of events) {
      this.handleSystemObservation(event);
    }
  }

  private handleSystemObservation(event: ScoutEvent): void {
    if (!isAgentTaskEvent(event)) {
      return;
    }

    if (AgentEvents.task.humanInputRequested.is(event)) {
      this.handleHumanInputRequested(event as ScoutEvent<AgentHumanInputRequestedEventPayload>);
      return;
    }
    if (AgentEvents.task.humanInputResponded.is(event)) {
      this.handleHumanInputResponded(event as ScoutEvent<AgentHumanInputRespondedEventPayload>);
    }
  }

  private handleHumanInputRequested(
    event: ScoutEvent<AgentHumanInputRequestedEventPayload>,
  ): void {
    const payload = event.payload;
    const interrupt = {
      eventKey: AgentEvents.interrupt.raised.routeKey,
      occurredAt: event.occurredAt,
      interruptKind: "human_input",
      taskId: payload.task.taskId,
      agentId: payload.task.agentId,
      turnId: payload.request.turnId,
      requestId: payload.request.requestId,
    } as const;
    this.eventBus.publish(AgentEvents.interrupt.raised, {
      ...interrupt,
      attachment: coordinator.observation({
        type: "interrupt",
        ...interrupt,
      }),
    } satisfies AgentInterruptEventPayload);
  }

  private handleHumanInputResponded(
    event: ScoutEvent<AgentHumanInputRespondedEventPayload>,
  ): void {
    const payload = event.payload;
    const interrupt = {
      eventKey: AgentEvents.interrupt.resolved.routeKey,
      occurredAt: event.occurredAt,
      interruptKind: "human_input",
      taskId: payload.task.taskId,
      agentId: payload.task.agentId,
      requestId: payload.response.requestId,
    } as const;
    this.eventBus.publish(AgentEvents.interrupt.resolved, {
      ...interrupt,
      attachment: coordinator.observation({
        type: "interrupt",
        ...interrupt,
      }),
    } satisfies AgentInterruptEventPayload);
  }

  private handleLoopError(error: unknown): void {
    const dispatch = {
      dispatchId: `orchestrator-error-${Date.now()}`,
      reason: "agent_error" as const,
      message: "Agent orchestrator failed while handling agent events.",
      createdAt: new Date().toISOString(),
      data: {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
    };
    this.eventBus.publish(AgentEvents.orchestration.dispatchRequested, {
      ...dispatch,
      attachment: coordinator.observation({
        type: "dispatch",
        ...dispatch,
      }),
    });
  }
}

function isAgentTaskEvent(event: ScoutEvent): event is AgentTaskEvent {
  return AgentEvents.task.is(event);
}
