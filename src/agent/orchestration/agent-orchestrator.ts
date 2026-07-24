import { AgentInbox } from "../core/agent-inbox.js";
import { AgentEvents } from "../events/index.js";

export interface AgentOrchestratorSnapshot {
  started: boolean;
  stopped: boolean;
  pendingEventCount: number;
}

export class AgentOrchestrator {
  private readonly inbox: AgentInbox;
  private started = false;
  private stopped = false;

  constructor() {
    this.inbox = new AgentInbox({
      isStopped: () => this.stopped,
      onEvents: async (events) => {
        for (const event of events) {
          if (!AgentEvents.task.is(event)) {
            throw new Error(`AgentOrchestrator received unsupported event: ${event.key.routeKey}`);
          }
        }
      },
      onError: () => undefined,
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
