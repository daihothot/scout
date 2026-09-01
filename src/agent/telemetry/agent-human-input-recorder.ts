import type { UnsubscribeEventHandler } from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";

/** Records Human Input request, response, and message-consumption facts. */
export class AgentHumanInputRecorder {
  private readonly loggers = new Map<string, Logger>();
  private readonly unsubscribers: UnsubscribeEventHandler[] = [];

  start(): void {
    if (this.unsubscribers.length > 0) return;
    const eventBus = currentRunScope().eventBus;
    this.unsubscribers.push(
      eventBus.subscribe(AgentEvents.humanInput.requested, (event) => {
        if (!AgentEvents.humanInput.requested.is(event)) return;
        const { message, ...request } = event.payload;
        this.write(event.payload.agentId, AgentEvents.humanInput.requested.routeKey, {
          ...request,
          messageId: message.messageId,
          queuedAt: message.queuedAt,
        });
      }),
      eventBus.subscribe(AgentEvents.humanInput.responded, (event) => {
        if (!AgentEvents.humanInput.responded.is(event)) return;
        const { message, ...response } = event.payload;
        this.write(event.payload.agentId, AgentEvents.humanInput.responded.routeKey, {
          ...response,
          messageId: message.messageId,
          queuedAt: message.queuedAt,
        });
      }),
      eventBus.subscribe(AgentEvents.message.consumed, (event) => {
        if (!AgentEvents.message.consumed.is(event)) return;
        const input = currentRunScope().humanInputStore.findByMessageId(event.payload.messageId);
        if (!input) return;
        this.write(event.payload.agentId, AgentEvents.message.consumed.routeKey, {
          ...event.payload,
          requestId: input.requestId,
          kind: input.kind,
        });
      }),
    );
  }

  stop(): void {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    this.loggers.clear();
  }

  private write(agentId: string, event: string, data: object): void {
    const scope = currentRunScope();
    const agent = scope.agentRegistry.resolveAgent(agentId);
    let logger = this.loggers.get(agentId);
    if (!logger) {
      logger = new Logger({
        runId: scope.runId,
        logsRoot: agent.mount.logsRoot,
        fileName: "human-input.log",
      });
      this.loggers.set(agentId, logger);
    }
    logger.info({ module: "agent.human_input", event, agentId, data });
  }
}
