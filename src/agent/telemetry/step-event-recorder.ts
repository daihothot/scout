import type {
  ScoutEvent,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";
import type { AgentStepState } from "../step/types.js";

/** Writes step lifecycle events to the owning agent's step log. */
export class StepEventRecorder {
  private readonly loggers = new Map<string, Logger>();
  private unsubscribe?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe(AgentEvents.step, (event) => {
      this.record(event);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.loggers.clear();
  }

  private record(event: ScoutEvent): void {
    const step = event.payload as AgentStepState;
    this.loggerFor(step.agentId).info({
      module: "agent.step",
      event: event.key.routeKey,
      agentId: step.agentId,
      taskId: step.taskId,
      data: {
        stepId: step.stepId,
        status: step.status,
        turnId: step.turnId,
        prompt: step.prompt,
        finalResponse: step.finalResponse,
        toolCalls: step.toolCalls,
        plan: step.plan,
        humanInputResponse: step.humanInputResponse,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        durationMs: step.durationMs,
        error: step.error,
      },
    });
  }

  private loggerFor(agentId: string): Logger {
    const existing = this.loggers.get(agentId);
    if (existing) return existing;
    const scope = currentRunScope();
    const agent = scope.agentRegistry.resolveAgent(agentId);
    const logger = new Logger({
      runId: scope.runId,
      logsRoot: agent.mount.logsRoot,
      fileName: "steps.log",
    });
    this.loggers.set(agentId, logger);
    return logger;
  }
}
