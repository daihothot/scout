import type {
  ScoutEvent,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";
import type { AgentThreadSnapshot } from "../thread/types.js";

export class AgentThreadRecorder {
  private readonly threadLoggers = new Map<string, Logger>();
  private unsubscribe?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe<AgentThreadSnapshot>(
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
    const scope = currentRunScope();
    const agent = scope.agentRegistry.resolveAgent(agentId);
    const logger = new Logger({
      runId: scope.runId,
      logsRoot: agent.mount.logsRoot,
      fileName: "thread.log",
      summarizer: (event) => event,
    });
    this.threadLoggers.set(agentId, logger);
    return logger;
  }
}
