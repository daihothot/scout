import type {
  EventBus,
  ScoutEvent,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import type { AgentRegistry } from "../core/agent-registry.js";
import { AgentEvents } from "../events/index.js";
import type { AgentThreadSnapshot } from "../thread/types.js";

export interface AgentThreadRecorderOptions {
  runId: string;
  eventBus: EventBus;
  registry: AgentRegistry;
}

export class AgentThreadRecorder {
  private readonly runId: string;
  private readonly eventBus: EventBus;
  private readonly registry: AgentRegistry;
  private readonly threadLoggers = new Map<string, Logger>();
  private unsubscribe?: UnsubscribeEventHandler;

  constructor(options: AgentThreadRecorderOptions) {
    this.runId = options.runId;
    this.eventBus = options.eventBus;
    this.registry = options.registry;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.eventBus.subscribe<AgentThreadSnapshot>(
      AgentEvents.thread,
      (event) => this.record(event),
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.threadLoggers.clear();
  }

  private record(event: ScoutEvent<AgentThreadSnapshot>): void {
    const thread = event.payload;
    if (AgentEvents.thread.started.is(event)) {
      this.write(event, thread.agentId, thread);
      return;
    }
    if (AgentEvents.thread.closed.is(event)) {
      this.write(event, thread.agentId, {
        threadId: thread.threadId,
        status: thread.status,
        closedAt: thread.closedAt,
        closeReason: thread.closeReason,
      });
    }
  }

  private write(
    event: ScoutEvent<AgentThreadSnapshot>,
    agentId: string,
    data: object,
  ): void {
    this.loggerFor(agentId).info({
      module: "agent.thread",
      event: event.key.routeKey,
      agentId,
      data,
    });
  }

  private loggerFor(agentId: string): Logger {
    const existing = this.threadLoggers.get(agentId);
    if (existing) return existing;
    const agent = this.registry.resolveAgent(agentId);
    const logger = new Logger({
      runId: this.runId,
      logsRoot: agent.mount.logsRoot,
      fileName: "thread.log",
      summarizer: (event) => event,
    });
    this.threadLoggers.set(agentId, logger);
    return logger;
  }
}
