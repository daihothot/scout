import type {
  ScoutEvent,
  UnsubscribeEventHandler,
} from "../../core/events/index.js";
import { Logger } from "../../core/logging/index.js";
import { currentRunScope } from "../../run/run-scope.js";
import { AgentEvents } from "../events/index.js";
import type { AgentSkillEventContext } from "../skill/skill-events.js";

export class AgentSkillRecorder {
  private readonly skillLoggers = new Map<string, Logger>();
  private unsubscribe?: UnsubscribeEventHandler;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = currentRunScope().eventBus.subscribe(
      AgentEvents.skill,
      (event) => this.record(event),
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.skillLoggers.clear();
  }

  private record(event: ScoutEvent): void {
    const payload = event.payload as AgentSkillEventContext;
    const input = {
      module: "agent.skill",
      event: event.key.routeKey,
      agentId: payload.agentId,
      taskId: payload.taskId,
      data: payload,
    };
    const logger = this.loggerFor(payload.agentId);
    if (AgentEvents.skill.findFailed.is(event) || AgentEvents.skill.readFailed.is(event)) {
      logger.warn(input);
      return;
    }
    logger.info(input);
  }

  private loggerFor(agentId: string): Logger {
    const existing = this.skillLoggers.get(agentId);
    if (existing) return existing;
    const scope = currentRunScope();
    const agent = scope.agentRegistry.resolveAgent(agentId);
    const logger = new Logger({
      runId: scope.runId,
      logsRoot: agent.mount.logsRoot,
      fileName: "skill.log",
    });
    this.skillLoggers.set(agentId, logger);
    return logger;
  }
}
