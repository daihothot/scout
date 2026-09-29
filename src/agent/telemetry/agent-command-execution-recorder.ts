import type { UnsubscribeEventHandler } from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";
import type { AgentCommandExecutionObservedEvent } from "../command-execution/command-execution-events.js";
import { agentTelemetryLogsRoot } from "../../core/path.js";

/** Persists generic shell command facts without command return values. */
export class AgentCommandExecutionRecorder {
  private readonly loggers = new Map<string, Logger>();
  private unsubscribe?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe(
      AgentEvents.commandExecution.observed,
      (event) => {
        if (!AgentEvents.commandExecution.observed.is(event)) return;
        this.record(event.payload);
      },
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.loggers.clear();
  }

  private record(command: AgentCommandExecutionObservedEvent): void {
    const scope = currentRunScope();
    const logsRoot = agentTelemetryLogsRoot(command.agentId);
    let logger = this.loggers.get(logsRoot);
    if (!logger) {
      logger = new Logger({
        runId: scope.runId,
        logsRoot,
        fileName: "command-execution.log",
      });
      this.loggers.set(logsRoot, logger);
    }
    logger.info({
      module: "agent.command_execution",
      event: AgentEvents.commandExecution.observed.routeKey,
      agentId: command.agentId,
      taskId: command.taskId,
      data: command,
    });
  }
}
