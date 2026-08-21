import type {
  ScoutEvent,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { attachments } from "../context/attachments.js";
import { AgentEvents } from "../events/index.js";

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
    if (AgentEvents.step.started.is(event)) {
      const step = event.payload;
      let promptForLog = step.prompt;
      for (const block of attachments.readTagBlock(promptForLog, "resume")) {
        let packet: unknown;
        try {
          packet = JSON.parse(block.body) as unknown;
        } catch {
          continue;
        }
        if (typeof packet !== "object" || packet === null || Array.isArray(packet)) continue;
        const sanitized = { ...(packet as Record<string, unknown>) };
        const isRecord = (value: unknown): value is Record<string, unknown> =>
          typeof value === "object" && value !== null && !Array.isArray(value);
        if (isRecord(sanitized.task)) {
          const task = { ...sanitized.task };
          delete task.initial_prompt;
          sanitized.task = task;
        }
        if (Array.isArray(sanitized.tasks)) {
          sanitized.tasks = sanitized.tasks.map((value: unknown) => {
            if (!isRecord(value)) return value;
            const task = { ...value };
            delete task.initial_prompt;
            return task;
          });
        }
        if (Array.isArray(sanitized.open)) {
          sanitized.open = sanitized.open.map((value: unknown) => {
            if (!isRecord(value) || value.type !== "interrupted_turn") return value;
            const turn = { ...value };
            delete turn.prompt;
            return turn;
          });
        }
        promptForLog = attachments.replaceTagBlock(
          promptForLog,
          "resume",
          JSON.stringify(sanitized, null, 2),
        );
      }
      this.loggerFor(step.agentId).info({
        module: "agent.step",
        event: event.key.routeKey,
        agentId: step.agentId,
        taskId: step.taskId,
        data: {
          stepId: step.stepId,
          status: step.status,
          turnId: step.turnId,
          prompt: promptForLog,
          finalResponse: step.finalResponse,
          toolCallIds: step.toolCallIds,
          plan: step.plan,
          humanInputReferences: step.humanInputReferences,
          startedAt: step.startedAt,
          finishedAt: step.finishedAt,
          durationMs: step.durationMs,
          error: step.error,
          updatedAt: step.updatedAt,
        },
      });
      return;
    }
    if (AgentEvents.step.planUpdated.is(event)) {
      const update = event.payload;
      this.loggerFor(update.agentId).info({
        module: "agent.step",
        event: event.key.routeKey,
        agentId: update.agentId,
        taskId: update.taskId,
        data: {
          stepId: update.stepId,
          turnId: update.turnId,
          plan: update.plan,
          updatedAt: update.updatedAt,
        },
      });
      return;
    }
    if (
      AgentEvents.step.completed.is(event)
      || AgentEvents.step.interrupted.is(event)
      || AgentEvents.step.failed.is(event)
    ) {
      const step = event.payload;
      this.loggerFor(step.agentId).info({
        module: "agent.step",
        event: event.key.routeKey,
        agentId: step.agentId,
        taskId: step.taskId,
        data: {
          stepId: step.stepId,
          status: step.status,
          turnId: step.turnId,
          finalResponse: step.finalResponse,
          finishedAt: step.finishedAt,
          durationMs: step.durationMs,
          error: step.error,
          updatedAt: step.updatedAt,
        },
      });
      return;
    }
    if (AgentEvents.step.toolCallReferenced.is(event)) {
      const step = event.payload;
      this.loggerFor(step.agentId).info({
        module: "agent.step",
        event: event.key.routeKey,
        agentId: step.agentId,
        taskId: step.taskId,
        data: {
          stepId: step.stepId,
          turnId: step.turnId,
          toolCallId: step.toolCallIds.at(-1),
          updatedAt: step.updatedAt,
        },
      });
      return;
    }
    if (AgentEvents.step.humanInputReferenced.is(event)) {
      const step = event.payload;
      const reference = step.humanInputReferences.at(-1);
      this.loggerFor(step.agentId).info({
        module: "agent.step",
        event: event.key.routeKey,
        agentId: step.agentId,
        taskId: step.taskId,
        data: {
          stepId: step.stepId,
          requestId: reference?.requestId,
          kind: reference?.kind,
          updatedAt: step.updatedAt,
        },
      });
    }
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
