import type { EventBus } from "../../core/events/index.js";
import { AgentInbox } from "../core/agent-inbox.js";
import { AgentEvents } from "../events/index.js";
import { coordinator } from "../runner/coordinator/coordinator-attachments.js";
import type { AgentOrchestrationDispatchRequestedPayload } from "./orchestrator-events.js";

export interface AgentOrchestratorOptions {
  eventBus: EventBus;
}

export interface AgentOrchestratorSnapshot {
  started: boolean;
  stopped: boolean;
  pendingEventCount: number;
}

export class AgentOrchestrator {
  private readonly inbox: AgentInbox;
  private started = false;
  private stopped = false;

  constructor(options: AgentOrchestratorOptions) {
    this.inbox = new AgentInbox({
      eventBus: options.eventBus,
      isStopped: () => this.stopped,
      onEvents: async (events) => {
        for (const event of events) {
          if (!AgentEvents.task.is(event)) {
            throw new Error(`AgentOrchestrator received unsupported event: ${event.key.routeKey}`);
          }
        }
      },
      onError: (error) => {
        const dispatch = {
          dispatchId: `orchestrator-error-${Date.now()}`,
          reason: "agent_error" as const,
          message: "Agent orchestrator failed while handling agent events.",
          createdAt: new Date().toISOString(),
          data: {
            error: error instanceof Error ? error.stack ?? error.message : String(error),
          },
        };
        options.eventBus.publish(AgentEvents.orchestration.dispatchRequested, {
          ...dispatch,
          attachment: coordinator.observation({
            type: "dispatch",
            ...dispatch,
          }),
        } satisfies AgentOrchestrationDispatchRequestedPayload);
      },
    });
  }

  start(): void {
    if (this.stopped) {
      throw new Error("Cannot restart a stopped AgentOrchestrator.");
    }
    if (this.started) return;
    this.started = true;
    this.inbox.subscribe(AgentEvents.task);
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
}
