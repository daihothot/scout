import type { UnsubscribeEventHandler } from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";
import type { AgentNativeSubagentEvent } from "../subagent/subagent-events.js";
import { agentTelemetryLogsRoot } from "../../core/io/index.js";

/** Persists native multi-agent collaboration facts in the owning agent log. */
export class AgentSubagentRecorder {
  private readonly loggers = new Map<string, Logger>();
  private unsubscribe?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe(
      AgentEvents.subagent.observed,
      (event) => {
        if (!AgentEvents.subagent.observed.is(event)) return;
        this.record(event.payload);
      },
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.loggers.clear();
  }

  private record(subagent: AgentNativeSubagentEvent): void {
    const scope = currentRunScope();
    const logsRoot = agentTelemetryLogsRoot(subagent.agentId);
    let logger = this.loggers.get(logsRoot);
    if (!logger) {
      logger = new Logger({
        runId: scope.runId,
        logsRoot,
        fileName: "subagent.log",
      });
      this.loggers.set(logsRoot, logger);
    }
    logger.info({
      module: "agent.subagent",
      event: AgentEvents.subagent.observed.routeKey,
      agentId: subagent.agentId,
      taskId: subagent.taskId,
      data: subagent,
    });
  }
}
