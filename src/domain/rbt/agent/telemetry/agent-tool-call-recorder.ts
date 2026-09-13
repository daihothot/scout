import type { UnsubscribeEventHandler } from "../../../../core/events/index.js";
import { Logger } from "../../../../core/logging/index.js";
import { DomainEvents } from "../../../domain-events.js";
import { currentRunScope } from "../../../../run/run-scope.js";

/** Writes RBT domain dynamic-tool facts to the calling Agent's telemetry log. */
export class RbtAgentToolCallRecorder {
  private readonly loggers = new Map<string, Logger>();
  private unsubscribe?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe(
      DomainEvents.agentToolCall.observed,
      (event) => {
        if (!DomainEvents.agentToolCall.observed.is(event) || event.payload.domainId !== "rbt") {
          return;
        }
        const scope = currentRunScope();
        let logger = this.loggers.get(event.payload.agentId);
        if (!logger) {
          const environment = scope.environment.agents[event.payload.role];
          if (!environment) {
            throw new Error(`RBT Agent environment is unavailable: ${event.payload.role}.`);
          }
          logger = new Logger({
            runId: scope.runId,
            logsRoot: environment.mount.logsRoot,
            fileName: "rbt-agent-tool-call.log",
          });
          this.loggers.set(event.payload.agentId, logger);
        }
        const contentItems = event.payload.response.contentItems;
        let output: unknown = contentItems;
        if (contentItems.length === 1 && contentItems[0]?.type === "inputText") {
          try {
            output = JSON.parse(contentItems[0].text);
          } catch {
            output = contentItems[0].text;
          }
        }
        logger.info({
          module: "domain.rbt.agent.tool_call",
          event: DomainEvents.agentToolCall.observed.routeKey,
          agentId: event.payload.agentId,
          data: {
            domainId: event.payload.domainId,
            callId: event.payload.callId,
            ...(event.payload.threadId ? { threadId: event.payload.threadId } : {}),
            role: event.payload.role,
            phase: event.payload.phase,
            namespace: event.payload.namespace,
            tool: event.payload.tool,
            arguments: event.payload.arguments,
            success: event.payload.response.success,
            output,
            startedAt: event.payload.startedAt,
            completedAt: event.payload.completedAt,
          },
        });
      },
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.loggers.clear();
  }
}
